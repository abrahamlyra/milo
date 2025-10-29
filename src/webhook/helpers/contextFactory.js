// src/webhook/helpers/contextFactory.js
import { config } from '../../config/index.js';
import { makeClient } from '../../core/http/client.js';
import { getSession, extractTokenFromPayload } from '../../core/state/session.js';

/** Crea un context factory ligado al request actual (sin variables globales externas) */
export function createContextFactory(getCurrentReq) {
  return function contextFactory() {
    const req = getCurrentReq?.() || { body: {} };
    let tokenCache = null;
    const body = req.body || {};
    const token = extractTokenFromPayload(body);
    const sessionId = body?.sessionId || body?.context?.sessionId || 'default';

    const http = makeClient({
      baseURL: config.lyraApiUrl,        // ya incluye /api
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      getToken: () => tokenCache ?? token,
    });

    return {
      http,
      setToken: (t) => (tokenCache = t),
      getToken: () => tokenCache || token,
      session: getSession(sessionId),
      req, // opcional por si un tool requiere headers/origin/etc.
    };
  };
}
