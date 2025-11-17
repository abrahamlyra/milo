// src/ai/brain/index.js
import { getOpenAIClient } from '../openaiClient.js';
import { loadHistory, saveTurn } from '../memory/conversation.js';
import { buildMessages } from './prompts.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * runMiloBrain
 *
 * Fase 1:
 *  - Solo conversación "inteligente" con memoria.
 *  - NO invoca tools ni APIs de Lyra todavía.
 *
 * Params:
 *  - sessionId: id de sesión/chat (el mismo que ya usas en session.js)
 *  - message: texto que mandó el usuario
 *  - rawPayload: el payload completo del webhook (reservado p/futuro)
 *  - contextFactory: reservado para Fase 2 (cuando usemos tools de Lyra)
 */
export async function runMiloBrain({
  sessionId = 'default',
  message,
  rawPayload,
  contextFactory,
}) {
  const openai = getOpenAIClient();

  // 1) Historial existente
  const history = loadHistory(sessionId);

  // 2) Construimos mensajes
  const messages = buildMessages({
    history,
    userMessage: message,
  });

  try {
    // 3) Llamada al modelo
    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.3,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      'No pude generar una respuesta útil. Intenta reformular la pregunta.';

    // 4) Guardar nuevo turno en historial
    saveTurn({
      sessionId,
      userMessage: message,
      assistantMessage: reply,
    });

    return {
      ok: true,
      reply,
      usedTools: [], // Fase 2: aquí iremos registrando tools usados
    };
  } catch (err) {
    // Log para debug (sin tirar la app)
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
