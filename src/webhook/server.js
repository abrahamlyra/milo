// src/webhook/server.js
import express from 'express';
import cors from 'cors';

import { config } from '../config/index.js';
import { listTools } from '../core/nlu/intentRouter.js';

import { createContextFactory } from './helpers/contextFactory.js';
import { makeMessagesRouter } from './routes/messages.js';

import { registerTemplateTools } from '../lyra/templates/index.js';
import { registerFillTools } from '../lyra/fill/index.js';
import { registerDocumentTools } from '../lyra/documents/index.js';
import { registerFacturapiTools } from '../lyra/facturapi/index.js';

// NUEVO: registrar herramientas de user (incluye billing)
import { registerUserTools } from '../lyra/user/index.js';

// NUEVO: router para uploads efímeros de CSD (cer/key) en sesión
import billingUploads from './routes/billingUploads.js';

const app = express();

/* =========================
   CORS + JSON
========================= */
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`Origin no permitido: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

/* =========================
   Context Factory + Router
========================= */
let _currentReq = null;
const getCurrentReq = () => _currentReq;
const setCurrentReq = (r) => { _currentReq = r; };

const contextFactory = createContextFactory(getCurrentReq);

/* =========================
   Registro de tools (una sola vez)
========================= */
registerTemplateTools(contextFactory);
registerFillTools(contextFactory);
registerDocumentTools(contextFactory);
registerFacturapiTools(contextFactory);
registerUserTools(contextFactory); // ⬅️ NUEVO: habilita billing.*

/* =========================
   Routes
========================= */
app.get('/health', (_req, res) => {
  res.json({ ok: true, tools: listTools() });
});

// Monta uploads bajo /milo (antes del router de mensajes)
app.use('/milo', billingUploads);

// Monta router de Milo bajo /milo
app.use('/milo', makeMessagesRouter(contextFactory, setCurrentReq));

/* =========================
   Inicio
========================= */
app.listen(config.port, () => {
  console.log(`🤖 Milo bot escuchando en :${config.port}`);
  console.log(`→ LYRA_API_URL: ${config.lyraApiUrl || '(no set)'}`);
  if (config.allowedOrigins.length) {
    console.log(`→ Allowed origins: ${config.allowedOrigins.join(', ')}`);
  } else {
    console.log('→ Allowed origins: (sin restricción; acepta cualquier origin)');
  }
});
