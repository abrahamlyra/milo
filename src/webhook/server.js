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

/* =========================
   CORS
========================= */
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin no permitido: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

/* =========================
   Context factory por request
   (inyecta http con token dinámico del payload)
========================= */
function makeContext(req) {
  let tokenCache = null;
  const body = req.body || {};
  const token = extractTokenFromPayload(body);
  const sessionId = body?.sessionId || body?.context?.sessionId || 'default';

  const http = makeClient({
    baseURL: config.lyraApiUrl,
    timeoutMs: config.httpTimeoutMs,
    retries: config.httpRetries,
    getToken: () => tokenCache ?? token, // token para Authorization cuando aplique
  });

  return {
    http,
    setToken: (t) => (tokenCache = t),
    getToken: () => tokenCache || token,
    session: getSession(sessionId),
  };
}

/* =========================
   Registro de tools
   - Usamos un "bridge" para suministrar req actual al contextFactory
========================= */
let currentReq = null; // 👈 truco para pasar req al factory cuando se ejecute el tool

const contextFactory = () => {
  if (!currentReq) {
    // fallback defensivo, debería estar seteado en cada request real
    return makeContext({ body: {} });
  }
  return makeContext(currentReq);
};

// Registra los tools de templates (create, list, contract, etc.)
registerTemplateTools(contextFactory);

/* =========================
   Health
========================= */
app.get('/health', (_req, res) => {
  res.json({ ok: true, tools: listTools() });
});

/* =========================
   Mensajería del bot (Milochat pega aquí)
========================= */
app.post('/milo/message', async (req, res) => {
  currentReq = req; // 👈 habilita contextFactory() con este request
  try {
    const { message, action, input, context } = req.body || {};
    const token = extractTokenFromPayload(req.body);
    if (!token) return res.status(401).json(needsAuth());

    // Guarda info básica del usuario para autofill (opcional)
    const userInfo = {
      id: context?.user?.id || null,
      email: context?.user?.email || null,
    };
    const sid = context?.sessionId || 'default';
    setUserInfo(sid, userInfo);

    // Por ahora: invocación explícita por 'action'
    if (!action) {
      return res.json(
        okReply(
          'Estoy listo. Indica la acción y los parámetros. Ej: action="templates.list" o action="templates.create".',
          { actions: listTools() }
        )
      );
    }

    // 1) Obtenemos el factory del tool
    const toolFactory = getTool(action);

    // 2) Instanciamos el tool con el contexto del request actual
    const tool = await toolFactory(); // 👈 IMPORTANTE: ejecutar el factory

    // 3) Ejecutamos el tool con input (si no hay, objeto vacío)
    const result = await tool(input || {});

    return res.json(okReply(`✔️ ${action} OK`, { result }));
  } catch (err) {
    const status = err?.response?.status || err?.status || 500;
    const detail = err?.response?.data || err?.message || String(err);
    return res.status(status).json(errorReply(`❌ Error en acción: ${detail}`, status));
  } finally {
    currentReq = null; // limpia referencia
  }
});

/* =========================
   Inicio
========================= */
app.listen(config.port, () => {
  console.log(`🤖 Milo bot escuchando en :${config.port}`);
  console.log(`→ LYRA_API_URL: ${config.lyraApiUrl || '(no set)'}`);
});
