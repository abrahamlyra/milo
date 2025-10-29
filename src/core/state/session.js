// src/core/state/session.js
// Estado en memoria (para stage). Si luego quieres Redis, cambiamos acá.
const sessions = new Map();

export function getSession(sessionId) {
  if (!sessionId) return null;
  if (!sessions.has(sessionId)) sessions.set(sessionId, { provided: {}, meta: {} });
  return sessions.get(sessionId);
}

export function setUserInfo(sessionId, userInfo) {
  const s = getSession(sessionId);
  if (!s) return;
  s.user = { ...(s.user || {}), ...userInfo };
}

export function extractTokenFromPayload(body) {
  // Soporta: body.context.user.token, body.token
  return body?.context?.user?.token || body?.token || null;
}
