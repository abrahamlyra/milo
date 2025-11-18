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
import { registerUserTools } from '../lyra/user/index.js';
import { registerAssetTools } from '../lyra/assets/index.js';

import billingUploads from './routes/billingUploads.js';
import assetsUploads from './routes/assetsUploads.js';
import { registerKnowledgeTools } from '../knowledge/index.js';

// =========================
// App base
// =========================
const app = express();

// CORS basado en config.allowedOrigins
const corsOptions = {
  origin: (origin, callback) => {
    // requests sin origin (curl, same-origin) → permitir
    if (!origin) return callback(null, true);

    // si no hay lista configurada, permitir todo
    if (!config.allowedOrigins.length) return callback(null, true);

    // si está en la lista, permitir
    if (config.allowedOrigins.includes(origin)) return callback(null, true);

    // si no, bloquear
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// =========================
// Contexto del bot
// =========================
let currentReq = null;
const getCurrentReq = () => currentReq;
const setCurrentReq = (req) => {
  currentReq = req;
};

const contextFactory = createContextFactory(getCurrentReq);

// Registro de tools de Lyra
registerTemplateTools(contextFactory);
registerFillTools(contextFactory);
registerDocumentTools(contextFactory);
registerFacturapiTools(contextFactory);
registerUserTools(contextFactory);
registerAssetTools(contextFactory);
registerKnowledgeTools(contextFactory); 


// =========================
// Rutas
// =========================
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tools: listTools(),
  });
});

// Subidas efímeras al bot
app.use('/milo', billingUploads);
app.use('/milo', assetsUploads);

// Router principal de mensajes
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
