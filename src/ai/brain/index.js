// src/ai/brain/index.js
import { getOpenAIClient } from '../openaiClient.js';
import { loadHistory, saveTurn } from '../memory/conversation.js';
import { buildMessages } from './prompts.js';
import { callMiloAction } from './toolsBridge.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 🔒 Lista de acciones que el LLM puede disparar en esta primera fase
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
const REQUIRES_TEMPLATE_ID = [
  'templates.contract',
  'documents.create',
  'invoices.create',
];

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
        '- "fill.set": registrar valores específicos que el usuario te proporcione para uno o varios campos.',
        '- "fill.apply": combinar lo ya proporcionado y las sugerencias para dejar listo el payload final.',
        '- "documents.create": generar un documento con la plantilla seleccionada y los datos capturados.',
        '- "invoices.create": generar una factura (CFDI) usando la plantilla seleccionada y los datos capturados.',
        '- "billing.contract": iniciar o continuar el flujo de activación de facturación (registro de RFC/CSD).',
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
        '',
        'Reglas:',
        '- Usa mode="tool" cuando el usuario pida explícitamente hacer algo con plantillas, documentos, facturas, facturación, assets o catálogos, o cuando sea OBVIO que esa acción es el siguiente paso lógico.',
        '- Si el usuario solo tiene dudas, quiere explicaciones generales o la intención no es clara, usa mode="chat".',
        '- Si decides usar una acción interna, elige exactamente UNA acción por turno.',
        '- El campo "input" debe ser siempre un objeto JSON. Si no necesitas parámetros, usa un objeto vacío: {}.',
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
    // 1) Planner decide qué hacer
    const plan = await planNextStep({ openai, history, message });

    // 2) Si es solo chat → usamos el flujo de Fase 1
    if (plan.mode !== 'tool') {
      const reply = plan.reply || (await runChatOnly({ openai, history, message }));

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

    // 👇 3.2. Si la acción requiere templateId y no viene, mejor nos vamos a chat
    if (REQUIRES_TEMPLATE_ID.includes(action)) {
      const hasTemplateId =
        input &&
        typeof input.templateId === 'string' &&
        input.templateId.trim().length > 0;

      if (!hasTemplateId) {
        const reply = await runChatOnly({ openai, history, message });

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

    // 4) Pedirle al modelo que explique el resultado al usuario
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