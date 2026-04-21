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
    let selectedTemplateId = norm(body?.context?.selectedTemplateId || body?.context?.templateId);

    // ✅ Rehidratación desde session_data top-level (snapshot post-respuesta del cliente).
    // Resuelve el caso Cloud Run stateless: si esta instancia no tiene memoria caliente
    // (por distribución de requests entre instancias), reconstruimos el contexto
    // conversacional desde lo que el frontend nos reenvía cada turno.
    const sessionData =
      body?.session_data && typeof body.session_data === 'object'
        ? body.session_data
        : null;

    // Si el cliente trae templateId en session_data, tiene prioridad sobre context.*
    // porque representa el snapshot conversacional más reciente que el cliente conoce.
    if (sessionData?.templateId) {
      const hydratedTpl = norm(sessionData.templateId);
      if (hydratedTpl) selectedTemplateId = hydratedTpl;
    }

    const session = getSession(sessionId);

    // ✅ Hydrate session cada request (stateless across Cloud Run instances).
    // Espejamos selectedTemplateId / selectedEmitterId tanto en raíz como en meta
    // para que funcione el brain (lee de raíz en runConversationalFill fast-path)
    // y cualquier consumidor legacy que lea de meta.
    if (selectedEmitterId) {
      session.selectedEmitterId = selectedEmitterId;
      session.meta.selectedEmitterId = selectedEmitterId;
    }
    if (selectedTemplateId) {
      session.selectedTemplateId = selectedTemplateId;
      session.meta.selectedTemplateId = selectedTemplateId;
    }

    // ✅ Rehidratar _convFill desde el cliente SOLO UNA VEZ POR REQUEST y de forma
    // NO DESTRUCTIVA: si esta instancia está caliente y ya tiene el estado del template
    // en memoria, no lo pisamos (el server siempre tiene el estado más reciente tras
    // procesar el turno anterior). Si está fría, absorbemos el snapshot del cliente.
    // El flag vive en `req` porque la closure de createContextFactory es global
    // (una sola instancia compartida vía currentReq en server.js).
    if (sessionData?._convFill && typeof sessionData._convFill === 'object' && !req.__miloHydrated) {
      req.__miloHydrated = true;
      session._convFill = session._convFill || {};
      for (const [tid, state] of Object.entries(sessionData._convFill)) {
        if (!tid || !state || typeof state !== 'object') continue;
        if (!session._convFill[tid]) {
          session._convFill[tid] = state;
        }
      }
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
