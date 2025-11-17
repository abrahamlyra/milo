// src/ai/brain/index.js
import { getOpenAIClient } from '../openaiClient.js';
import { loadHistory, saveTurn } from '../memory/conversation.js';
import { buildMessages } from './prompts.js';
import { callMiloAction } from './toolsBridge.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 🔒 Lista de acciones que el LLM puede disparar en esta primera fase
const ALLOWED_ACTIONS = ['templates.list'];

/**
 * Planner: decide si Milo debe solo chatear o llamar una acción interna.
 * Devuelve siempre un JSON tipo:
 * {
 *   "mode": "chat" | "tool",
 *   "reply": "texto opcional si mode=chat",
 *   "action": "templates.list" (si mode=tool),
 *   "input": { ... } // opcional
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
        'Acciones internas permitidas en esta fase:',
        '- "templates.list": listar todas las plantillas disponibles del usuario actual.',
        '',
        'Responde SIEMPRE con un JSON válido, sin texto adicional, usando esta forma:',
        '{',
        '  "mode": "chat" | "tool",',
        '  "reply": "texto de respuesta si mode=chat",',
        '  "action": "templates.list" | null,',
        '  "input": { ... objeto con parámetros si los hubiera }',
        '}',
        '',
        'Usa mode="tool" con action="templates.list" solo cuando el usuario pida ver, listar o conocer las plantillas disponibles.',
        'En cualquier otro caso usa mode="chat" y pon en "reply" la respuesta que debería ver el usuario.',
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
 * Construye la respuesta final al usuario usando el resultado de un tool.
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
      role: 'assistant',
      content: `He ejecutado la acción interna "${action}" con input: ${JSON.stringify(
        input || {},
      )}. Este es el resultado en JSON:\n\n${JSON.stringify(
        toolResult,
        null,
        2,
      )}\n\nAhora voy a explicártelo al usuario de forma amigable.`,
    },
  ];

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.2,
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Ejecuté la acción interna correctamente, pero no pude generar una explicación clara. Intenta preguntarme de nuevo.';
  return reply;
}

/**
 * Fase 2 (primer paso): Milo puede decidir si:
 *  - Solo chatea (modo "chat"), o
 *  - Ejecuta una acción interna simple (por ahora: templates.list) y luego explica el resultado.
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

    // 3) Ejecutar acción interna (por ahora templates.list)
    const action = plan.action;
    const input = plan.input || {};

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
