// src/webhook/server.js
import express from 'express';
import cors from 'cors';
import { config } from '../config/index.js';
import { makeClient } from '../core/http/client.js';
import { getSession, setUserInfo, extractTokenFromPayload } from '../core/state/session.js';
import { registerTemplateTools } from '../lyra/templates/index.js';
import { getTool, listTools } from '../core/nlu/intentRouter.js';
import { okReply, errorReply, needsAuth } from '../core/dialog/replies.js';

const app = express();

// CORS
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin no permitido: ${origin}`));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// Context factory por request (inyecta http con token dinámico)
function makeContext(req) {
  let tokenCache = null;
  const body = req.body || {};
  const token = extractTokenFromPayload(body);
  const sessionId = body?.sessionId || body?.context?.sessionId || 'default';
  const http = makeClient({
    baseURL: config.lyraApiUrl,
    timeoutMs: config.httpTimeoutMs,
    retries: config.httpRetries,
    getToken: () => tokenCache ?? token,
  });
  return {
    http,
    setToken: (t) => (tokenCache = t),
    getToken: () => tokenCache || token,
    session: getSession(sessionId),
  };
}

// Registrar tools (solo templates por ahora)
const contextFactory = (req) => makeContext(req);
registerTemplateTools(() => contextFactory(currentReq));

// 👆 pequeño truco para pasar req al factory:
let currentReq = null;

// Health
app.get('/health', (_req, res) => res.json({ ok: true, tools: listTools() }));

// Mensajería del bot (Milochat pega aquí)
app.post('/milo/message', async (req, res) => {
  currentReq = req;
  try {
    const { message, action, input, context } = req.body || {};
    const token = extractTokenFromPayload(req.body);
    if (!token) return res.status(401).json(needsAuth());

    // Guardamos info básica del user (para autofill posterior)
    const userInfo = {
      id: context?.user?.id || null,
      email: context?.user?.email || null,
    };
    setUserInfo(context?.sessionId || 'default', userInfo);

    // Por ahora: invocación explícita por 'action'
    if (!action) {
      return res.json(
        okReply(
          'Estoy listo. Indica la acción y los parámetros. Ej: action="templates.list" o action="templates.create".',
          { actions: listTools() }
        )
      );
    }

    const toolFactory = getTool(action);
    const ctx = contextFactory(req); // http con token
    const tool = toolFactory;
    const result = await tool({ http: ctx.http })(input);

    return res.json(okReply(`✔️ ${action} OK`, { result }));
  } catch (err) {
    const status = err?.response?.status || err?.status || 500;
    const detail = err?.response?.data || err?.message || String(err);
    return res.status(status).json(errorReply(`❌ Error en acción: ${detail}`, status));
  } finally {
    currentReq = null;
  }
});

// Inicio
app.listen(config.port, () => {
  console.log(`🤖 Milo bot escuchando en :${config.port}`);
  console.log(`→ LYRA_API_URL: ${config.lyraApiUrl || '(no set)'}`);
});
