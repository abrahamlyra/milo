// src/ai/brain/index.js
import { getOpenAIClient } from '../openaiClient.js';
import { loadHistory, saveTurn } from '../memory/conversation.js';
import { buildMessages } from './prompts.js';
import { callMiloAction } from './toolsBridge.js';
import { formatTemplatesList } from '../../webhook/helpers/formatters.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 🔒 Lista de acciones que el LLM puede disparar en esta fase
const ALLOWED_ACTIONS = [
  'templates.list',
  'templates.contract',
  'fill.missing',
  'fill.suggest',
  'fill.set',
  'fill.apply',
  'documents.create',
  'invoices.create',
  'billing.contract',
  'billing.missing',
  'billing.register',
  'assets.upload',
  'assets.view',
  'knowledge.search',
  'catalog.regimen_fiscal.search',
  'catalog.uso_cfdi.search',
  'catalog.forma_pago.search',
  'catalog.metodo_pago.search',
  'catalog.clave_producto_servicio.search',
  // 👇 delivery
  'fill.delivery',
  'fill.delivery.get',
  'fill.delivery.reset',

  // 👇 emitters (multi-RFC)
  'emitters.list',
  'emitters.select',
  'emitters.getSelected',
  'emitters.reset',
];

// Acciones de catálogo/knowledge que requieren forzosamente un query
const CATALOG_ACTIONS = [
  'knowledge.search',
  'catalog.regimen_fiscal.search',
  'catalog.uso_cfdi.search',
  'catalog.forma_pago.search',
  'catalog.metodo_pago.search',
  'catalog.clave_producto_servicio.search',
];

// Acciones críticas que requieren un templateId válido
const REQUIRES_TEMPLATE_ID = ['templates.contract'];

// Helper para validar UUID (no dejes pasar nombres comerciales como id)
function isUUID(x) {
  return (
    typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      x.trim()
    )
  );
}

function isInvoiceTypeFromContract(contractResult) {
  const t = String(contractResult?.type || '').trim().toLowerCase();
  if (!t) return false;
  return t.includes('invoice') || t.includes('factura');
}

function extractEmitterListToolResult(toolResult) {
  const emitters = Array.isArray(toolResult?.emitters) ? toolResult.emitters : [];
  return { emitters };
}

function formatEmittersListForUser(toolResult) {
  const { emitters } = extractEmitterListToolResult(toolResult);

  if (!emitters.length) {
    return [
      'No encontré emisores (RFCs) en esta organización.',
      'Primero crea/activa un emisor en Lyra Suite (Facturación → Emisores) y luego vuelve aquí.',
    ].join('\n');
  }

  const maxShow = 10;
  const lines = emitters.slice(0, maxShow).map((e, i) => {
    const alias = e.alias || '(sin alias)';
    const rfc = e.rfc ? ` — ${e.rfc}` : '';
    const id = e.id || '(sin-id)';
    return `  ${i + 1}. ${alias}${rfc} — ${id}`;
  });

  const extra =
    emitters.length > maxShow ? `\n… y ${emitters.length - maxShow} más.` : '';

  return [
    'Necesitas elegir un emisor (RFC) para esta factura.',
    `Encontré ${emitters.length} emisores:`,
    lines.join('\n') + extra,
    '',
    'Escribe por ejemplo:',
    '  emisor <id>',
    'o:',
    '  elegir emisor <id>',
  ].join('\n');
}

/**
 * Planner: decide si Milo debe solo chatear o llamar una acción interna.
 * Devuelve siempre un JSON tipo:
 * {
 * "mode": "chat" | "tool",
 * "reply": "texto opcional si mode=chat",
 * "action": "<nombre del tool>" (si mode=tool),
 * "input": { ... } // opcional
 * }
 */
async function planNextStep({ openai, history, message }) {
  const planningMessages = [
    {
      role: 'system',
      content: [
        'Eres el planner de Milo (no el que responde al usuario).',
        'Tu tarea es decidir una de dos opciones:',
        '1) Responder tú mismo en modo chat (mode = "chat"), o',
        '2) Indicar que se debe ejecutar una acción interna de Milo (mode = "tool").',
        '',
        'Acciones internas permitidas (una sola por turno):',
        '- "templates.list": listar las plantillas disponibles del usuario actual.',
        '- "templates.contract": seleccionar una plantilla concreta y cargar su contrato/campos.',
        '- "fill.missing": revisar qué campos faltan por rellenar en la plantilla seleccionada.',
        '- "fill.suggest": proponer valores de ejemplo o por defecto para campos faltantes.',
        '- "fill.set": registrar valores que el usuario proporcione. REGLA CRÍTICA: si el usuario da múltiples datos en un mensaje (nombres, montos, fechas, cualquier campo), extrae TODOS y ponlos en UN SOLO fill.set con todos los campos en el input JSON. Ejemplo: si dice "nombre acreedor Abraham, deudor Belinda, monto 300", el input debe ser { "nombre_acreedor": "Abraham", "nombre_deudor": "Belinda", "monto_numero": 300 }. NUNCA hagas fill.set de un solo campo si el usuario dio más de uno en el mismo mensaje.',
        '- "fill.apply": combinar lo ya proporcionado y las sugerencias para dejar listo el payload final.',
        '- "documents.create": generar un documento con la plantilla seleccionada y los datos capturados.',
        '- "invoices.create": generar una factura (CFDI) usando la plantilla seleccionada y los datos capturados.',
        '- "billing.contract": iniciar o continuar el flujo de activación de facturación (registro de RFC/CSD en la PLATAFORMA, no una factura individual).',
        '- "billing.missing": revisar qué datos o archivos faltan para completar el registro de facturación.',
        '- "billing.register": enviar al backend los datos de facturación y archivos (.cer, .key) para activar la facturación.',
        '- "assets.upload": registrar en Lyra un asset (logo, header, footer, background, image) previamente subido al bot.',
        '- "assets.view": consultar el asset actual (por ejemplo el logo) configurado en Lyra.',
        '- "knowledge.search": buscar información general en la base de conocimiento de Lyra.',
        '- "catalog.regimen_fiscal.search": sugerir regímenes fiscales del SAT en base a una descripción.',
        '- "catalog.uso_cfdi.search": sugerir usos de CFDI del SAT en base a una descripción.',
        '- "catalog.forma_pago.search": sugerir formas de pago del SAT en base a una descripción.',
        '- "catalog.metodo_pago.search": sugerir métodos de pago del SAT en base a una descripción.',
        '- "catalog.clave_producto_servicio.search": sugerir claves de producto/servicio del SAT en base a una descripción.',
        '- "fill.delivery": configurar cómo se entregará el documento/factura (correo, SMS, ambos, ninguno).',
        '- "fill.delivery.get": consultar la configuración de entrega actual.',
        '- "fill.delivery.reset": limpiar la configuración de entrega.',
        '- "emitters.list": listar emisores (RFCs) disponibles para la organización actual.',
        '- "emitters.select": seleccionar un emisor para usarlo en el flujo de factura.',
        '',
        'Reglas generales:',
        '- Usa mode="tool" cuando el usuario pida explícitamente hacer algo con plantillas, documentos, facturas, emisores, facturación, assets, catálogos o entregas (correo/SMS), o cuando sea OBVIO que esa acción es el siguiente paso lógico.',
        '- Si el usuario solo tiene dudas, quiere explicaciones generales o la intención no es clara, usa mode="chat".',
        '- Si decides usar una acción interna, elige exactamente UNA acción por turno.',
        '- El campo "input" debe ser siempre un objeto JSON. Si no necesitas parámetros, usa un objeto vacío: {}.',
        '',
        'Reglas para plantillas y selección de contrato:',
        '- Si el usuario pregunta cosas como "qué plantillas tienes", "qué plantillas hay", "qué templates tengo", "lista de plantillas", debes usar SIEMPRE:',
        '  { "mode": "tool", "action": "templates.list", "input": {} }.',
        '',
        '- Cuando haya en el historial una respuesta que enumera plantillas, y el usuario diga "usar X" donde X es el nombre de una plantilla:',
        '  - Localiza en ese historial el template cuyo nombre coincida mejor con X.',
        '  - Toma su identificador (UUID) tal como aparece después del guion largo "—".',
        '  - Genera un plan con mode="tool", action="templates.contract" y:',
        '    "input": { "templateId": "<id_del_template_encontrado>" }',
        '',
        '- Si el usuario escribe explícitamente un ID después de "usar", puedes usar directamente ese valor como "input.templateId".',
        '- Si no encuentras ningún id razonable, usa mode="chat" y explica que necesitas listar plantillas con su ID.',
        '',
        'Reglas para emisores (facturas multi-RFC):',
        '- Si el usuario dice "emisores", "ver emisores", "lista de emisores", debes usar:',
        '  { "mode": "tool", "action": "emitters.list", "input": {} }',
        '- Si el usuario dice "emisor <id>" o "elegir emisor <id>", debes usar:',
        '  { "mode": "tool", "action": "emitters.select", "input": { "emitter_id": "<id>" } }',
        '',
        'Reglas para facturación CFDI (llenado de factura, NO activación de facturación):',
        '- Si el usuario habla de HACER UNA FACTURA o FACTURAR A ALGUIEN y menciona datos de receptor/conceptos, usa "fill.set" (no billing.*).',
        '- No inventes valores. Solo incluye en el input lo que el usuario haya dicho claramente.',
        '- Si el usuario responde algo como "pues ya te los di", "ya los tienes", "que no los tienes?", "ya te lo dije", revisa el historial de la conversación y usa fill.set con los datos que SÍ mencionó antes. No repitas preguntas de campos ya dados.',
        '- Si el bot preguntó por un campo específico y el usuario responde con un valor concreto (un número, nombre, fecha, ciudad, etc.), ese valor ES la respuesta a ese campo — úsalo en fill.set aunque el mensaje sea muy corto.',
        '',
        'Reglas para activación de facturación (billing.*):',
        '- billing.* es para registrar datos del EMISOR y CSD en la plataforma, no para una factura individual.',
        '',
        'Reglas para uso de catálogos SAT:',
        '- Si el usuario describe pero no da el código, usa catalog.* con input.query.',
        '',
        'Reglas para entrega (correo / SMS / ambos / ninguno):',
        '- Si el usuario pide envío por correo/SMS, usa fill.delivery.',
        '- Si el usuario escribe directamente un correo electrónico (formato xxx@xxx.xxx) como respuesta, asume que quiere envío por correo y usa fill.delivery con input: { mode: "email", email: { to: "<correo>" } }.',
        '- Si el usuario escribe "sin correo", "no enviar", "solo pdf", "no quiero correo" o similar, usa fill.delivery con input: { mode: "none" }.',
        '',
        'Responde SIEMPRE con un JSON válido, sin texto adicional, usando esta forma:',
        '{',
        '  "mode": "chat" | "tool",',
        '  "reply": "texto de respuesta si mode=chat",',
        '  "action": "<nombre de la acción o null>",',
        '  "input": { ... objeto con parámetros si los hubiera }',
        '}',
      ].join('\n'),
    },
    ...history,
    { role: 'user', content: String(message ?? '') },
  ];

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: planningMessages,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    plan = { mode: 'chat', reply: null };
  }

  if (plan.mode !== 'tool') {
    plan.mode = 'chat';
    return plan;
  }

  // Sanitizar acción
  if (!ALLOWED_ACTIONS.includes(plan.action)) {
    return { mode: 'chat', reply: null };
  }

  // documents.create → invoices.create si el mensaje sugiere factura
  if (plan.action === 'documents.create') {
    const msg = String(message ?? '').toLowerCase();
    const facturaHints = [
      'factura',
      'facturar',
      'cfdi',
      'timbrar',
      'timbrado',
      'comprobante fiscal',
    ];

    const wantsInvoice = facturaHints.some((h) => msg.includes(h));
    if (wantsInvoice && ALLOWED_ACTIONS.includes('invoices.create')) {
      plan.action = 'invoices.create';
    }
  }

  if (plan.input && typeof plan.input !== 'object') {
    plan.input = {};
  }

  return plan;
}

/**
 * Chat "pelón" (sin tools), como en la Fase 1.
 */
async function runChatOnly({ openai, history, message }) {
  const messages = buildMessages({
    history,
    userMessage: message,
  });

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.3,
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    'No pude generar una respuesta útil. Intenta reformular la pregunta.';
  return reply;
}

/**
 * Construye la respuesta final al usuario usando el resultado de un tool.
 */
async function buildReplyFromTool({ openai, history, message, action, input, toolResult }) {
  // templates.list → texto + lista estructurada
  if (action === 'templates.list') {
    const text =
      formatTemplatesList(toolResult || {}) ||
      'No encontré templates disponibles en tu cuenta. Puedes cargar una plantilla desde Lyra Suite y volver a intentarlo.';

    const items = Array.isArray(toolResult?.items) ? toolResult.items : [];

    const templates = items
      .map((t) => ({
        id: t.id || t.templateId || t._id || '',
        name: t.name || t.title || t.templateName || '(sin nombre)',
        type: t.type || t.kind || undefined,
        description: t.description || t.summary || undefined,
        preview_url: t.preview_url || t.previewUrl || undefined,
      }))
      .filter((t) => t.id);

    return { reply: text, templates };
  }

  // emitters.list → respuesta directa (sin LLM)
  if (action === 'emitters.list') {
    return formatEmittersListForUser(toolResult || {});
  }

  // emitters.select → confirmar directo (sin LLM)
  if (action === 'emitters.select') {
    const ok = !!toolResult?.ok;
    if (!ok) {
      return (
        toolResult?.message ||
        'No pude seleccionar ese emisor. Verifica el id e inténtalo de nuevo.'
      );
    }
    const id = toolResult?.emitter_id || '(emisor)';
    return `✅ Emisor seleccionado: ${id}\nAhora ya puedes seguir llenando la factura (set ...), revisar faltantes, y facturar.`;
  }

  // emitters.getSelected → respuesta directa
  if (action === 'emitters.getSelected') {
    const id = toolResult?.emitter_id || null;
    return id ? `📌 Emisor actual: ${id}` : '📌 No hay emisor seleccionado todavía.';
  }

  // emitters.reset → respuesta directa
  if (action === 'emitters.reset') {
    return '🧹 Emisor limpiado. Ahora puedes elegir otro con: emisor <id>';
  }

  const messages = [
    {
      role: 'system',
      content: [
        'Eres Milo, asistente de Lyra Suite.',
        'Acabas de ejecutar una acción interna de Lyra y recibiste un resultado en JSON.',
        'Tu tarea es explicar al usuario de forma clara y útil qué hiciste y qué significan los datos.',
        'Siempre responde en español, con tono cercano pero profesional.',
      ].join('\n'),
    },
    ...history,
    { role: 'user', content: String(message ?? '') },
    {
      role: 'user',
      name: 'milo_tool_result',
      content: JSON.stringify({
        action,
        input: input || {},
        result: toolResult,
      }),
    },
  ];

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.3,
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    'No pude generar una respuesta útil a partir del resultado de la acción.';
  return reply;
}

/**
 * Fase 2: Milo puede decidir si:
 * - Solo chatea, o
 * - Ejecuta una acción interna simple y explica el resultado.
 */
export async function runMiloBrain({
  sessionId = 'default',
  message,
  rawPayload, // req completo desde el controller
  contextFactory,
}) {
  const openai = getOpenAIClient();
  const history = loadHistory(sessionId);

  try {
    // 🔥 FAST-PATH: "usar template <UUID>" disparado desde el front
    const m = String(message ?? '').trim();
    const match = m.match(
      /^usar\s+template\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );

    if (match && isUUID(match[1])) {
      const templateId = match[1];
      const action = 'templates.contract';
      const input = { templateId };

      const toolResult = await callMiloAction({
        action,
        input,
        contextFactory,
        rawReq: rawPayload,
      });

      // ✅ Si la plantilla es factura, inmediatamente listamos emisores
      if (isInvoiceTypeFromContract(toolResult)) {
        let emitResult = null;
        try {
          emitResult = await callMiloAction({
            action: 'emitters.list',
            input: {},
            contextFactory,
            rawReq: rawPayload,
          });
        } catch (emitErr) {
          console.warn('[Milo][Brain] emitters.list falló en fast-path:', emitErr?.message);
        }

        const contractReply = await buildReplyFromTool({
          openai,
          history,
          message,
          action,
          input,
          toolResult,
        });

        const emitReply = emitResult
          ? formatEmittersListForUser(emitResult)
          : 'No pude cargar los emisores. Usa el comando "emisores" para verlos.';

        const replyText = [
          typeof contractReply === 'string'
            ? contractReply
            : contractReply?.reply || '',
          '',
          emitReply,
        ]
          .filter(Boolean)
          .join('\n');

        saveTurn({
          sessionId,
          userMessage: message,
          assistantMessage: replyText,
        });

        return {
          ok: true,
          reply: replyText,
          usedTools: [action, 'emitters.list'],
          rawToolResult: toolResult,
        };
      }

      const built = await buildReplyFromTool({
        openai,
        history,
        message,
        action,
        input,
        toolResult,
      });

      let reply = built;
      if (built && typeof built === 'object' && built.reply) {
        reply = built.reply;
      }

      saveTurn({
        sessionId,
        userMessage: message,
        assistantMessage: reply,
      });

      return {
        ok: true,
        reply,
        usedTools: [action],
        rawToolResult: toolResult,
      };
    }

    // 1) Planner decide
    const plan = await planNextStep({
      openai,
      history,
      message,
    });

    console.log("[MILO_PLAN]", JSON.stringify(plan));
    // 2) Modo chat
    if (plan.mode !== 'tool') {
      const reply =
        plan.reply ||
        (await runChatOnly({
          openai,
          history,
          message,
        }));

      saveTurn({
        sessionId,
        userMessage: message,
        assistantMessage: reply,
      });

      return {
        ok: true,
        reply,
        usedTools: [],
      };
    }

    // 3) Ejecutar acción
    const action = plan.action;
    let input = plan.input || {};

    // 3.1 Catálogos / knowledge: garantizar input.query
    if (CATALOG_ACTIONS.includes(action)) {
      if (!input || typeof input !== 'object') input = {};
      if (!input.query || typeof input.query !== 'string' || !input.query.trim()) {
        input.query = String(message ?? '');
      }
    }

    // 3.2 Si la acción requiere templateId y no viene o no es UUID → chat
    if (REQUIRES_TEMPLATE_ID.includes(action)) {
      const hasTemplateId =
        input && typeof input.templateId === 'string' && isUUID(input.templateId);

      if (!hasTemplateId) {
        const reply =
          'Necesito el ID de la plantilla (UUID) para continuar. ' +
          'Primero pide "qué plantillas tienes" y luego dime "usa la plantilla X" para que pueda tomar el ID correcto.';

        saveTurn({
          sessionId,
          userMessage: message,
          assistantMessage: reply,
        });

        return {
          ok: true,
          reply,
          usedTools: [],
        };
      }
    }

    // 3.3 Ejecutar tool con fallback a chat si falla
    let toolResult;
    try {
      toolResult = await callMiloAction({
        action,
        input,
        contextFactory,
        rawReq: rawPayload,
      });
    } catch (toolErr) {
      console.warn('[Milo][Brain] Tool falló, cayendo a chat:', action, toolErr?.message);
      const reply = await runChatOnly({ openai, history, message });
      saveTurn({ sessionId, userMessage: message, assistantMessage: reply });
      return { ok: true, reply, usedTools: [] };
    }

    // ─── fill.set → auto-progresión conversacional ────────────────────────────
    // Después de guardar un campo, pregunta por el siguiente (o indica que ya está listo).
    if (action === 'fill.set') {
      let missingResult = null;
      try {
        missingResult = await callMiloAction({
          action: 'fill.missing',
          input: {},
          contextFactory,
          rawReq: rawPayload,
        });
      } catch (_) { /* ignorar — si falla fill.missing seguimos igual */ }

      const missing = Array.isArray(missingResult?.missing) ? missingResult.missing : [];

      // Helper para obtener label amigable de un campo
      const getLabel = (key) => {
        try {
          const sessionData = contextFactory()?.session;
          const tid = sessionData?.selectedTemplateId;
          const contractFields = Array.isArray(sessionData?.contracts?.[tid]?.fields)
            ? sessionData.contracts[tid].fields : [];
          const fieldSpec = contractFields.find((f) => f.key === key);
          return fieldSpec?.label || key;
        } catch (_) { return key; }
      };

      let reply;
      if (missing.length === 0) {
        // Verificar si ya hay delivery configurado para no preguntar dos veces
        let deliveryAlreadySet = false;
        try {
          const sessionData = contextFactory()?.session;
          const tid = sessionData?.selectedTemplateId;
          const deliveryMode = String(sessionData?.delivery?.[tid]?.mode || 'none').toLowerCase();
          deliveryAlreadySet = deliveryMode !== 'none';
        } catch (_) {}

        if (deliveryAlreadySet) {
          reply = '✔️ ¡Listo! Ya tengo todos los datos.\n\nEscribe `generar` para crear y enviar el documento.';
        } else {
          reply = '✔️ ¡Listo! Ya tengo todos los datos.\n\n¿A qué correo quieres que te envíe el documento? (Escribe el correo o escribe `sin correo` para solo generar el PDF.)';
        }
      } else {
        const nextKey = missing[0];
        const label = getLabel(nextKey);
        const savedCount = Object.keys(toolResult?.provided || {}).length;

        // Si guardó varios campos de un jalón, confirmarlo
        const savedKeys = Object.keys(input || {}).filter(k => k !== '__raw');
        const multiSaved = savedKeys.length > 1;

        const confirmLine = multiSaved
          ? `✔️ Guardados ${savedKeys.length} campos.\n\n`
          : '✔️ Guardado.\n\n';

        const remainingLine = missing.length > 1
          ? `Faltan **${missing.length}** datos. `
          : '';

        reply = `${confirmLine}${remainingLine}¿Cuál es el **${label}**?`;
      }

      saveTurn({ sessionId, userMessage: message, assistantMessage: reply });
      return { ok: true, reply, usedTools: [action], rawToolResult: toolResult };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ─── fill.delivery → auto-generar documento si ya hay datos completos ────
    if (action === 'fill.delivery') {
      const deliveryMode = String(toolResult?.delivery?.mode || 'none').toLowerCase();
      const emailTo = toolResult?.delivery?.email?.to ?? null;

      // Verificar si hay datos completos para generar
      let canGenerate = false;
      let missingAfterDelivery = [];
      try {
        const missingCheck = await callMiloAction({
          action: 'fill.missing',
          input: {},
          contextFactory,
          rawReq: rawPayload,
        });
        missingAfterDelivery = Array.isArray(missingCheck?.missing) ? missingCheck.missing : [];
        canGenerate = missingAfterDelivery.length === 0;
      } catch (_) {}

      let reply;
      if (deliveryMode === 'none') {
        reply = canGenerate
          ? '✔️ Sin envío. Escribe `generar` para crear el PDF.'
          : `✔️ Sin envío configurado. Aún faltan datos: ${missingAfterDelivery.join(', ')}.`;
      } else if (canGenerate) {
        // Tenemos delivery + datos completos → generar automáticamente
        let docResult = null;
        try {
          docResult = await callMiloAction({
            action: 'documents.create',
            input: {},
            contextFactory,
            rawReq: rawPayload,
          });
        } catch (docErr) {
          console.warn('[Milo][Brain] documents.create falló tras fill.delivery:', docErr?.message);
        }

        if (docResult?.ok) {
          const url = docResult.url || docResult.pdfUrl || null;
          const emailLine = emailTo ? `\n📧 Enviado a **${emailTo}**.` : '';
          reply = `✅ ¡Documento generado!${emailLine}${url ? `\n\n[Ver PDF](${url})` : ''}`;
        } else {
          const errDetail = docResult?.detail || docResult?.message || 'Error desconocido';
          reply = emailTo
            ? `📧 Listo, se enviará a **${emailTo}**.\n\nEscribe \`generar\` para crear y enviar el documento.`
            : `✔️ Entrega configurada.\n\nEscribe \`generar\` para crear el documento.`;
          console.warn('[Milo][Brain] documents.create tras delivery falló:', errDetail);
        }
      } else {
        // Delivery configurado pero faltan datos
        reply = emailTo
          ? `📧 Listo, se enviará a **${emailTo}** cuando generes el documento.\n\nAún faltan datos: ${missingAfterDelivery.join(', ')}.`
          : `✔️ Entrega configurada. Aún faltan datos: ${missingAfterDelivery.join(', ')}.`;
      }

      saveTurn({ sessionId, userMessage: message, assistantMessage: reply });
      return { ok: true, reply, usedTools: [action, ...(canGenerate ? ['documents.create'] : [])], rawToolResult: toolResult };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ✅ Si acaban de seleccionar contrato de factura, inmediatamente listamos emisores
    if (action === 'templates.contract' && isInvoiceTypeFromContract(toolResult)) {
      let emitResult = null;
      try {
        emitResult = await callMiloAction({
          action: 'emitters.list',
          input: {},
          contextFactory,
          rawReq: rawPayload,
        });
      } catch (emitErr) {
        console.warn('[Milo][Brain] emitters.list falló tras contract:', emitErr?.message);
      }

      const builtContract = await buildReplyFromTool({
        openai,
        history,
        message,
        action,
        input,
        toolResult,
      });

      const emitReply = emitResult
        ? formatEmittersListForUser(emitResult)
        : 'No pude cargar los emisores. Usa el comando "emisores" para verlos.';

      const replyText = [
        typeof builtContract === 'string' ? builtContract : builtContract?.reply || '',
        '',
        emitReply,
      ]
        .filter(Boolean)
        .join('\n');

      saveTurn({
        sessionId,
        userMessage: message,
        assistantMessage: replyText,
      });

      return {
        ok: true,
        reply: replyText,
        usedTools: [action, 'emitters.list'],
        rawToolResult: toolResult,
      };
    }

    // 4) Explicar resultado
    const built = await buildReplyFromTool({
      openai,
      history,
      message,
      action,
      input,
      toolResult,
    });

    let reply = built;
    let templates;
    if (built && typeof built === 'object' && built.reply) {
      reply = built.reply;
      templates = built.templates;
    }

    // 5) Guardar turno
    saveTurn({
      sessionId,
      userMessage: message,
      assistantMessage: reply,
    });

    return {
      ok: true,
      reply,
      usedTools: [action],
      rawToolResult: toolResult,
      templates,
    };
  } catch (err) {
    console.error('[Milo][Brain] Error en runMiloBrain:', {
      message: err?.message,
      status: err?.status || err?.response?.status,
      data: err?.response?.data,
    });

    const status = err?.status || err?.response?.status || 500;
    const msg =
      'Hubo un error al procesar tu mensaje con el cerebro de Milo. ' +
      'Intenta de nuevo más tarde o usa los comandos manuales.';

    return {
      ok: false,
      status,
      message: msg,
    };
  }
}