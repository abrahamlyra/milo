// src/webhook/server.js
import express from 'express';
import cors from 'cors';

import { config } from '../config/index.js';
import { makeClient } from '../core/http/client.js';

import { getSession, setUserInfo, extractTokenFromPayload } from '../core/state/session.js';

import { registerTemplateTools } from '../lyra/templates/index.js';
import { getTool, listTools, resolveActionName, parseKV, hasTool } from '../core/nlu/intentRouter.js';

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
========================= */
function resolveActionAndInputFromMessage(msg) {
  const r = resolveActionName(msg);
  return { action: r.action, input: r.input };
}

/* =========================
   Context factory por request
========================= */
function makeContext(req) {
  let tokenCache = null;
  const body = req.body || {};
  const token = extractTokenFromPayload(body);
  const sessionId = body?.sessionId || body?.context?.sessionId || 'default';

  const http = makeClient({
    baseURL: config.lyraApiUrl,        // Ya incluye /api
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
   Formateadores de respuestas específicas
========================= */
function formatTemplatesList(result) {
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
  return `✔️ templates.list OK\n${header}`;
}

function formatTemplatesContract(result) {
  const reqs = Array.isArray(result?.required) ? result.required : [];
  const fields = Array.isArray(result?.fields) ? result.fields : [];
  const opts = fields.filter(f => !f.required).map(f => f.key);

  const maxShow = 12;
  const reqLines = reqs.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
  const optLines = opts.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
  const reqExtra = reqs.length > maxShow ? `\n… y ${reqs.length - maxShow} más.` : '';
  const optExtra = opts.length > maxShow ? `\n… y ${opts.length - maxShow} más.` : '';

  const fieldLines = fields.slice(0, maxShow).map((f, i) => {
    const key = f.key || '(sin-key)';
    const ty  = f.type || 'string';
    const tag = f.required ? 'req' : 'opt';
    const hint = f.hint ? ` — ${f.hint}` : '';
    return `  ${i + 1}. [${tag}] ${key} <${ty}>${hint}`;
  });
  const fieldExtra = fields.length > maxShow ? `\n… y ${fields.length - maxShow} más.` : '';

  return [
    `✔️ templates.contract OK`,
    `Contract para template ${result?.templateId || '(?)'}`,
    reqs.length ? `\nRequeridos (${reqs.length}):\n${reqLines.join('\n')}${reqExtra}` : `\nRequeridos: (ninguno)`,
    opts.length ? `\nOpcionales (${opts.length}):\n${optLines.join('\n')}${optExtra}` : `\nOpcionales: (ninguno)`,
    fields.length ? `\nCampos (${fields.length}):\n${fieldLines.join('\n')}${fieldExtra}` : `\nCampos: (ninguno)`,
    `\nEscribe valores con "key=value" para empezar a llenar, p. ej.:`,
    `  set receptor_rfc=XXX010101XXX`,
    `  set receptor_email=correo@dominio.com`,
  ].join('\n');
}

function formatFillMissing(result) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  if (!missing.length) return `✔️ Sin faltantes. Ya estás listo para generar.`;
  const lines = missing.map((k, i) => `  ${i + 1}. ${k}`);
  return `✔️ Faltantes (${missing.length}):\n${lines.join('\n')}\n\nTip: usa \`set key=valor\` o \`sugerir\`.`;
}

function formatFillSuggest(result) {
  const mode = result?.mode || 'min';
  const payload = result?.payload || {};
  const pretty = JSON.stringify(payload, null, 2);
  return `✔️ Sugerencia (${mode})\n\n${pretty}\n\nEscribe **aplicar** para usarla tal cual, o edítala con \`set key=valor\`.`;
}

function formatFillApply(result) {
  const applied = !!result?.applied;
  const merged  = result?.merged || {};
  const pretty = JSON.stringify(merged, null, 2);
  return applied
    ? `✔️ Sugerencia aplicada.\n\nEstado actual:\n${pretty}\n\nEscribe **faltantes** para verificar si ya quedó listo.`
    : `⚠️ No había sugerencia pendiente. Usa \`sugerir\` primero.`;
}

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

    // Resolver acción: prioridad a 'action', si no, intenta a partir de 'message'
    let resolvedAction = action ?? null;
    let resolvedInput = input ?? {};
    if (!resolvedAction && typeof message === 'string') {
      const fromMsg = resolveActionAndInputFromMessage(message);
      resolvedAction = fromMsg.action;
      resolvedInput = Object.keys(fromMsg.input || {}).length ? fromMsg.input : resolvedInput;

      // Caso especial: "set ..." con múltiples KV
      // - resolveActionName produce { action:'fill.set', input:{ __raw: 'set x=1 y=2' } }
      if (resolvedAction === 'fill.set' && resolvedInput?.__raw) {
        const m = String(resolvedInput.__raw).match(/^set\s+(.+)$/i);
        if (m) {
          const kv = parseKV(m[1]);
          resolvedInput = kv;
        }
      }
    }

    if (!resolvedAction) {
      return res.json(
        okReply(
          'Estoy listo. Puedes escribir: `templates.list`, `usar <templateId>`, `faltantes`, `sugerir`, `sugerir full`, `aplicar`, o `set key=valor`.',
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

    // Respuestas con formateo específico
    if (resolvedAction === 'templates.list') {
      return res.json(okReply(formatTemplatesList(result), { result }));
    }
    if (resolvedAction === 'templates.contract') {
      return res.json(okReply(formatTemplatesContract(result), { result }));
    }
    if (resolvedAction === 'fill.missing') {
      return res.json(okReply(formatFillMissing(result), { result }));
    }
    if (resolvedAction === 'fill.suggest') {
      return res.json(okReply(formatFillSuggest(result), { result }));
    }
    if (resolvedAction === 'fill.apply') {
      return res.json(okReply(formatFillApply(result), { result }));
    }

    // Default
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
