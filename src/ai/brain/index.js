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
  // 👇 NUEVO: tools de delivery para facturas / docs
  'fill.delivery',
  'fill.delivery.get',
  'fill.delivery.reset',
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
// 👉 EDICIÓN: Se eliminaron invoices.create y documents.create para no bloquear el flujo sin ID.
const REQUIRES_TEMPLATE_ID = [
  'templates.contract',
];

// Helper para validar UUID (no dejes pasar nombres comerciales como id)
function isUUID(x) {
  return (
    typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.trim())
  );
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
      // 🧠 PROMPT ACTUALIZADO: reglas de billing, facturación CFDI, fill.set, selección de plantillas y delivery
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
        '- "fill.set": registrar valores específicos que el usuario te proporcione para uno o varios campos.',
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
        '',
        'Reglas generales:',
        '- Usa mode="tool" cuando el usuario pida explícitamente hacer algo con plantillas, documentos, facturas, facturación, assets, catálogos o entregas (correo/SMS), o cuando sea OBVIO que esa acción es el siguiente paso lógico.',
        '- Si el usuario solo tiene dudas, quiere explicaciones generales o la intención no es clara, usa mode="chat".',
        '- Si decides usar una acción interna, elige exactamente UNA acción por turno.',
        '- El campo "input" debe ser siempre un objeto JSON. Si no necesitas parámetros, usa un objeto vacío: {}.',
        '',
        'Reglas para plantillas y selección de contrato:',
        '- Si el usuario pregunta cosas como "qué plantillas tienes", "qué plantillas hay", "qué templates tengo", "lista de plantillas", debes usar SIEMPRE:',
        '  { "mode": "tool", "action": "templates.list", "input": {} }.',
        '',
        '- Cuando haya en el historial una respuesta que enumera plantillas (por ejemplo: "Encontré 5 templates:\\n  1. Mapfre Carta Finiquito — <id> ...  5. Factura Lyra Lite VPRO7 — <id>"), y el usuario diga frases como:',
        '  "usar X", "quiero usar X", "usar la plantilla X", "quiero llenar la factura X", donde X es el nombre de una plantilla:',
        '  - Localiza en ese historial el template cuyo nombre coincida mejor con X.',
        '  - Toma su identificador (UUID) tal como aparece después del guion largo "—".',
        '  - Genera un plan con mode="tool", action="templates.contract" y:',
        '    "input": { "templateId": "<id_del_template_encontrado>" }',
        '',
        '- Si el usuario escribe explícitamente un ID después de "usar" (por ejemplo "usar 8fa93c19-5578-4fca-b9d1-99fce044d524"), puedes usar directamente ese valor como "input.templateId".',
        '- Si no encuentras ningún id razonable en el historial y el usuario solo menciona el nombre, NO uses el nombre comercial como "templateId" porque el backend espera un UUID válido. En ese caso debes usar mode="chat" y explicar al usuario que necesitas volver a listar las plantillas con su ID para continuar.',
        '',
        'Reglas para facturación CFDI (llenado de factura, NO activación de facturación):',
        '- Si el usuario habla de HACER UNA FACTURA o FACTURAR A ALGUIEN y menciona datos de un receptor específico + conceptos, debes tratarlo como llenado de CFDI con "fill.set", NO como activación de facturación.',
        '- Ejemplos de frases que indican llenado de CFDI:',
        '  - "Quiero facturarle a Felipe Sáenz Martínez, su RFC es SAMF..., régimen 612, CP 03103, correo ...".',
        '  - "Genera una factura tipo I a nombre de X con este concepto...".',
        '  - "Haz un CFDI de ingreso para el cliente X con este servicio...".',
        '',
        '- En ese caso, mapea lo que diga el usuario a las claves típicas de la plantilla de factura (ejemplo: Factura Lyra Lite VPRO7):',
        '  - Nombre / razón social del receptor → "receptor_razon".',
        '  - RFC del receptor → "receptor_rfc".',
        '  - Régimen fiscal (código SAT) → "receptor_regimen".',
        '  - Código postal del receptor → "receptor_cp".',
        '  - Correo del receptor → "receptor_email".',
        '  - Uso de CFDI → "uso_cfdi".',
        '  - Forma de pago → "forma_pago".',
        '  - Método de pago → "metodo_pago".',
        '  - Tipo de comprobante (por ejemplo I) → "tipo".',
        '  - Moneda (si la menciona) → "moneda".',
        '  - Para cada concepto (item) indicado por el usuario:',
        '    - Cantidad → "items[0].quantity", "items[1].quantity", etc. según el orden.',
        '    - Descripción → "items[0].description", etc.',
        '    - Clave producto/servicio (SAT) → "items[0].product_key", etc.',
        '    - Precio unitario (sin impuestos) → "items[0].price", etc.',
        '    - Unidad (unit_key) → "items[0].unit_key", etc.',
        '',
        '- En estos casos debes usar:',
        '  {',
        '    "mode": "tool",',
        '    "action": "fill.set",',
        '    "input": {',
        '      "...": "valores que el usuario dio claramente mapeados a las claves anteriores"',
        '    }',
        '  }',
        '- No inventes valores. Solo incluye en el input los campos que el usuario haya mencionado de forma razonablemente clara.',
        '- No uses acciones de "billing.*" cuando el usuario está hablando de una factura concreta para un cliente específico. "billing.*" es para registrar LOS DATOS DEL EMISOR y CSD en la plataforma, no para llenar una factura individual.',
        '',
        'Reglas específicas para activación de facturación (billing.register y fill.set, datos del EMISOR):',
        '- La activación de facturación se da cuando el usuario habla de registrar SU RFC y SU CSD en la plataforma, por ejemplo: "quiero activar la facturación", "registrar mi RFC", "subir mi CSD", "activar timbrado en Lyra".',
        '- Los campos típicos de activación de facturación incluyen: "name", "razon_social", "regimen_fiscal", "codigo_postal", "calle", "exterior", "colonia", "ciudad", "municipio", "estado", "csd_password".',
        '- Si el usuario escribe frases donde claramente proporciona esos datos del EMISOR junto con intención de activar la facturación, debes usar mode="tool" con action="fill.set".',
        '- En esos casos, construye "input" como un objeto JSON donde cada clave es el nombre del campo y el valor es lo que el usuario proporcionó. Ejemplo:',
        '  {',
        '    "mode": "tool",',
        '    "action": "fill.set",',
        '    "input": {',
        '      "name": "HECTOR ABRAHAM DE LA TORRE MALDONADO",',
        '      "razon_social": "HECTOR ABRAHAM DE LA TORRE MALDONADO",',
        '      "codigo_postal": "06250",',
        '      "calle": "Albeniz",',
        '      "exterior": "11",',
        '      "colonia": "Exhipódromo de Peralvillo",',
        '      "ciudad": "Ciudad de México",',
        '      "municipio": "Cuauhtémoc",',
        '      "estado": "Ciudad de México",',
        '      "csd_password": "TORRE1992"',
        '    }',
        '  }',
        '- No inventes valores. Solo incluye en el input los campos que el usuario haya mencionado de forma razonablemente clara.',
        '',
        'Reglas para uso de catálogos SAT con los campos de facturación:',
        '- Si el usuario describe su régimen fiscal sin dar el código (por ejemplo: "soy persona moral que factura servicios", "personas físicas con actividad empresarial"), usa mode="tool" con alguna acción de catálogo:',
        '  - "catalog.regimen_fiscal.search" cuando hable de régimen fiscal.',
        '- En ese caso, el campo "input.query" debe contener la descripción textual que dio el usuario.',
        '- Después de obtener las sugerencias del catálogo, el asistente (no tú como planner) le propondrá una opción al usuario y, cuando el usuario confirme, puedes usar en un siguiente turno la acción "fill.set" para escribir el código correcto en el campo correspondiente (por ejemplo "regimen_fiscal": "601" o "612").',
        '',
        'Reglas para entrega (correo / SMS / ambos / ninguno) de documentos y facturas:',
        '- Si el usuario dice cosas como:',
        '  - "mándala por correo", "envíala al correo X", "mándala al mail del cliente".',
        '  - "mándala por SMS al número X".',
        '  - "mándala por correo y SMS".',
        '  - "no la mandes, solo genera el PDF".',
        '- Entonces debes usar mode="tool" con action="fill.delivery".',
        '',
        '- Ejemplos de input para "fill.delivery":',
        '  - Solo correo:',
        '    { "mode": "tool", "action": "fill.delivery", "input": { "mode": "email", "email": "cliente@dominio.com" } }',
        '  - Solo SMS:',
        '    { "mode": "tool", "action": "fill.delivery", "input": { "mode": "sms", "phone": "+5255..." } }',
        '  - Ambos:',
        '    { "mode": "tool", "action": "fill.delivery", "input": { "mode": "both", "email": "cliente@dominio.com", "phone": "+5255..." } }',
        '  - Ninguno (solo generar documento):',
        '    { "mode": "tool", "action": "fill.delivery", "input": { "mode": "none" } }',
        '',
        '- Si el usuario pregunta cómo está configurada la entrega actual ("cómo la vas a mandar", "a qué correo la vas a enviar"), puedes usar "fill.delivery.get".',
        '- Si el usuario quiere cambiar por completo la entrega ("no, ya no la mandes por correo, solo PDF"), puedes usar primero "fill.delivery.reset" y luego un nuevo "fill.delivery".',
        '',
        'Reglas de preferencia:',
        '- Si el usuario pide explícitamente "faltantes" o "faltantes facturación", prioriza usar "fill.missing" o "billing.missing" (según corresponda) en lugar de "chat".',
        '- Si el usuario habla de subir o cambiar logos u otros assets, prioriza "assets.upload" o "assets.view".',
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
    temperature: 0, // planner determinista
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

  // 👇👇👇 BLOQUE NUEVO AQUÍ 👇👇👇
  // Regla HARD: si el planner escogió documents.create pero
  // el usuario claramente está hablando de una FACTURA/CFDI,
  // cambiamos a invoices.create para usar el flujo de Facturapi.
  if (plan.action === 'documents.create') {
    const msg = String(message ?? '').toLowerCase();
    const facturaHints = [
      'factura',
      'facturar',
      'cfdi',
      'timbrar',
      'timbrado',
      'comprobante fiscal'
    ];

    const wantsInvoice = facturaHints.some(h => msg.includes(h));
    if (wantsInvoice && ALLOWED_ACTIONS.includes('invoices.create')) {
      plan.action = 'invoices.create';
    }
  }
  // 👆👆👆 FIN DEL BLOQUE NUEVO 👆👆👆

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
 * Construye la respuesta final al usuario usando el resultado
 * de un tool.
 * Aquí el LLM ya sabe qué acción se ejecutó y tiene el JSON del resultado.
 */
async function buildReplyFromTool({
  openai,
  history,
  message,
  action,
  input,
  toolResult,
}) {
  // ⚙️ Caso especial: templates.list → usamos el mismo formateador
  // que el flujo de comandos, para garantizar "Nombre — UUID" en el texto.
  if (action === 'templates.list') {
    const text = formatTemplatesList(toolResult || {});
    const reply =
      text ||
      'No encontré templates disponibles en tu cuenta. Puedes cargar una plantilla desde Lyra Suite y volver a intentarlo.';
    return reply;
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
    {
      role: 'user',
      content: String(message ?? ''),
    },
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
 * - Solo chatea (modo "chat"), o
 * - Ejecuta una acción interna simple (cualquiera de las declaradas en ALLOWED_ACTIONS) y luego explica el resultado.
 */
export async function runMiloBrain({
  sessionId = 'default',
  message,
  rawPayload, // aquí vamos a recibir el req completo desde el controller
  contextFactory,
}) {
  const openai = getOpenAIClient();
  const history = loadHistory(sessionId);

  try {
    // 🔥 0) FAST-PATH para "usar template <UUID>" disparado desde el front
    // Ejemplo exacto que manda el MiloChat:
    //   sendSilent(`usar template ${tpl.id}`);
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

      const reply = await buildReplyFromTool({
        openai,
        history,
        message,
        action,
        input,
        toolResult,
      });

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

    // 1) Planner decide qué hacer (si no cayó en el fast-path)
    const plan = await planNextStep({ openai, history, message });

    // 2) Si es solo chat → usamos el flujo de Fase 1
    if (plan.mode !== 'tool') {
      const reply =
        plan.reply ||
        (await runChatOnly({ openai, history, message }));

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

    // 3) Ejecutar acción interna (cualquiera de las permitidas en ALLOWED_ACTIONS)
    const action = plan.action;
    let input = plan.input || {};

    // 👇 3.1. Si es un catálogo / knowledge, garantizamos input.query
    if (CATALOG_ACTIONS.includes(action)) {
      if (!input || typeof input !== 'object') {
        input = {};
      }
      if (!input.query || typeof input.query !== 'string' || !input.query.trim()) {
        input.query = String(message ?? '');
      }
    }

    // 👇 3.2. Si la acción requiere templateId y no viene o no es UUID, mejor nos vamos a chat
    if (REQUIRES_TEMPLATE_ID.includes(action)) {
      const hasTemplateId =
        input &&
        typeof input.templateId === 'string' &&
        isUUID(input.templateId);

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

    const toolResult = await callMiloAction({
      action,
      input,
      contextFactory,
      rawReq: rawPayload,
    });

    // 4) Pedirle al modelo (o al formateador) que explique el resultado al usuario
    const reply = await buildReplyFromTool({
      openai,
      history,
      message,
      action,
      input,
      toolResult,
    });

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
