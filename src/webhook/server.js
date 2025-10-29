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
   Helpers: parsing de comandos en texto
   Formatos aceptados en message:
   - "tool.name"
   - "tool.name key=value other=1"
========================= */
function parseKV(rest = '') {
  const out = {};
  // Soporta key=value con espacios; comillas opcionales
  // Ej: q=hola page=2 title="Mi título"
  const re = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1];
    const raw = m[3] ?? m[4] ?? m[2];
    out[key] = /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

function resolveActionAndInputFromMessage(msg) {
  if (typeof msg !== 'string') return { action: null, input: null };
  const text = msg.trim();
  if (!text) return { action: null, input: null };

  // Caso 1: sólo el nombre del tool
  try {
    getTool(text); // si existe no lanza
    return { action: text, input: {} };
  } catch { /* no-op */ }

  // Caso 2: "tool.name key=value ..."
  const m = text.match(/^([a-z0-9._-]+)\s+(.+)$/i);
  if (m) {
    const candidate = m[1];
    try {
      getTool(candidate); // valida que exista
      const kv = parseKV(m[2]);
      return { action: candidate, input: kv };
    } catch { /* no-op */ }
  }

  return { action: null, input: null };
}

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
    baseURL: config.lyraApiUrl,        // OJO: ya incluye /api
    timeoutMs: config.httpTimeoutMs,
    retries: config.httpRetries,
    getToken: () => tokenCache ?? token, // Bearer dinámico
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
========================= */
let currentReq = null; // truco para pasar req al factory

const contextFactory = () => {
  if (!currentReq) return makeContext({ body: {} });
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
  currentReq = req; // habilita contextFactory() con este request
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

    // Fallback: si no viene "action", intentamos resolverlo desde "message"
    let resolvedAction = action ?? null;
    let resolvedInput = input ?? {};
    if (!resolvedAction) {
      const fromMsg = resolveActionAndInputFromMessage(message);
      resolvedAction = fromMsg.action;
      resolvedInput = Object.keys(fromMsg.input || {}).length ? fromMsg.input : resolvedInput;
    }

    if (!resolvedAction) {
      return res.json(
        okReply(
          'Estoy listo. Puedes escribir el comando directo, p. ej.: `templates.list` o `templates.list q=demo page=1`.',
          { actions: listTools() }
        )
      );
    }

    // 1) Obtenemos el factory del tool
    const toolFactory = getTool(resolvedAction);

    // 2) Instanciamos el tool con el contexto del request actual
    const tool = await toolFactory();

    // 3) Ejecutamos el tool con input (si no hay, objeto vacío)
    const result = await tool(resolvedInput || {});

    // 👉 Formateo especial para templates.list (lo que ya pusimos antes)
    if (resolvedAction === 'templates.list') {
      const items = Array.isArray(result?.items) ? result.items : [];
      const maxShow = 10;
      const lines = items.slice(0, maxShow).map((t, i) => {
        const name = t.name || t.title || t.templateName || `(sin nombre)`;
        const id   = t.id || t.templateId || t._id || '(sin-id)';
        return `  ${i + 1}. ${name} — ${id}`;
      });
      const extra = items.length > maxShow ? `\n… y ${items.length - maxShow} más.` : '';
      const header = items.length
        ? `Encontré ${items.length} templates:\n${lines.join('\n')}${extra}`
        : `No encontré templates con esos filtros.`;
      return res.json(okReply(`✔️ templates.list OK\n${header}`, { result }));
    }

    // 👉 NUEVO: formateo para templates.contract
    if (resolvedAction === 'templates.contract') {
      const reqs = Array.isArray(result?.required) ? result.required : [];
      const opts = Array.isArray(result?.optional) ? result.optional : [];
      const fields = Array.isArray(result?.fields) ? result.fields : [];

      const maxShow = 12;
      const reqLines = reqs.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
      const optLines = opts.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
      const reqExtra = reqs.length > maxShow ? `\n… y ${reqs.length - maxShow} más.` : '';
      const optExtra = opts.length > maxShow ? `\n… y ${opts.length - maxShow} más.` : '';

      // mini ficha por campo (name/type/hint)
      const fieldLines = fields.slice(0, maxShow).map((f, i) => {
        const key = f.key || '(sin-key)';
        const ty  = f.type || 'string';
        const tag = f.required ? 'req' : 'opt';
        const hint = f.hint ? ` — ${f.hint}` : '';
        return `  ${i + 1}. [${tag}] ${key} <${ty}>${hint}`;
      });
      const fieldExtra = fields.length > maxShow ? `\n… y ${fields.length - maxShow} más.` : '';

      const header = [
        `Contract para template ${result?.templateId || '(?)'}`,
        reqs.length ? `\nRequeridos (${reqs.length}):\n${reqLines.join('\n')}${reqExtra}` : `\nRequeridos: (ninguno)`,
        opts.length ? `\nOpcionales (${opts.length}):\n${optLines.join('\n')}${optExtra}` : `\nOpcionales: (ninguno)`,
        fields.length ? `\nCampos (${fields.length}):\n${fieldLines.join('\n')}${fieldExtra}` : `\nCampos: (ninguno)`,
        `\nEscribe valores con "key=value" para empezar a llenar, p. ej.:`,
        `  set receptor_rfc=XXX010101XXX`,
        `  set receptor_email=correo@dominio.com`,
      ].join('\n');

      return res.json(okReply(`✔️ templates.contract OK\n${header}`, { result }));
    }

    // Default: responde normal
    return res.json(okReply(`✔️ ${resolvedAction} OK`, { result }));
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