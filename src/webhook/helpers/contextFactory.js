// milo/src/webhook/helpers/contextFactory.js
import { config } from '../../config/index.js';
import { makeClient } from '../../core/http/client.js';
import { getSession, extractTokenFromPayload } from '../../core/state/session.js';

const norm = (v) => String(v ?? '').trim();

/** Crea un context factory ligado al request actual (sin variables globales externas) */
export function createContextFactory(getCurrentReq) {
  return function contextFactory() {
    const req = getCurrentReq?.() || { body: {} };
    let tokenCache = null;
    const body = req.body || {};

    const token = extractTokenFromPayload(body);
    const sessionId = body?.sessionId || body?.context?.sessionId || 'default';

    // ✅ Multi-tenant
    const orgId = norm(body?.context?.orgId);

    // ✅ Deterministic state (from FE)
    const selectedEmitterId = norm(body?.context?.selectedEmitterId || body?.context?.emitterId);
    const selectedTemplateId = norm(body?.context?.selectedTemplateId || body?.context?.templateId);

    const session = getSession(sessionId);

    // ✅ Hydrate session meta every request (stateless across Cloud Run instances)
    if (selectedEmitterId) session.meta.selectedEmitterId = selectedEmitterId;
    if (selectedTemplateId) session.meta.selectedTemplateId = selectedTemplateId;

    // ✅ Hidratar contrato desde context si viene — sobrevive entre instancias de Cloud Run
    const incomingContract = body?.context?.contract;
    if (selectedTemplateId && incomingContract && Array.isArray(incomingContract?.fields)) {
      session.selectedTemplateId = selectedTemplateId;
      session.contracts = session.contracts || {};
      session.contracts[selectedTemplateId] = session.contracts[selectedTemplateId] || incomingContract;
      session.contract = session.contract || incomingContract;
      session.provided = session.provided || {};
      session.provided[selectedTemplateId] = session.provided[selectedTemplateId] || {};
    }

    const http = makeClient({
      baseURL: config.lyraApiUrl, // ya incluye /api
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      getToken: () => tokenCache ?? token,

      // ✅ Headers para TODAS las llamadas de Milo a Lyra
      // Importante: Lyra API a veces espera ambos.
      getHeaders: () => {
        if (!orgId) return {};
        return {
          'X-Organization-Id': orgId,
          'X-Org-Id': orgId,
        };
      },
    });

    return {
      http,
      setToken: (t) => (tokenCache = t),
      getToken: () => tokenCache || token,
      session,
      req,
      orgId, // opcional debug
    };
  };
}