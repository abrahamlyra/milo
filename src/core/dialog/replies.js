// src/core/dialog/replies.js
export function okReply(text, extra = {}) {
  return { ok: true, reply: text, ...extra };
}
export function errorReply(text, status = 500, extra = {}) {
  return { ok: false, status, reply: text, ...extra };
}
export function needsAuth() {
  return errorReply('Necesitas iniciar sesión para usar esta función.', 401);
}
