// src/ai/memory/conversation.js
import { getSession } from '../../core/state/session.js';

const HISTORY_KEY = 'llmHistory';
const DEFAULT_MAX_TURNS = 10; // número de TURNS (user+assistant) que queremos conservar

/**
 * Carga el historial de conversación LLM para una sesión dada.
 * Devuelve un arreglo de mensajes [{ role, content }, ...]
 */
export function loadHistory(sessionId = 'default') {
  const session = getSession(sessionId);
  session.meta = session.meta || {};

  const raw = session.meta[HISTORY_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      typeof m.role === 'string' &&
      typeof m.content === 'string'
  );
}

/**
 * Guarda el último turno (user + assistant) en el historial,
 * recortando para que solo se conserven los últimos maxTurns.
 */
export function saveTurn({
  sessionId = 'default',
  userMessage,
  assistantMessage,
  maxTurns = DEFAULT_MAX_TURNS,
}) {
  const session = getSession(sessionId);
  session.meta = session.meta || {};

  const history = loadHistory(sessionId);
  const newHistory = [
    ...history,
    userMessage && {
      role: 'user',
      content: String(userMessage ?? ''),
    },
    assistantMessage && {
      role: 'assistant',
      content: String(assistantMessage ?? ''),
    },
  ].filter(Boolean);

  // maxTurns = pares user+assistant, así que 2 * maxTurns mensajes
  const trimmed = newHistory.slice(-maxTurns * 2);
  session.meta[HISTORY_KEY] = trimmed;

  return trimmed;
}
