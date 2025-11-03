// src/webhook/routes/billingUploads.js
import express from 'express';
import multer from 'multer';
import { getSession } from '../../core/state/session.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Subida efímera de archivos CSD al bot, guardados en sesión (memoria),
 * para que fill.missing deje de pedirlos y billing.register pueda enviarlos.
 *
 * Uso:
 *   POST /milo/user/billing/upload?kind=cer&sid=<sessionId>
 *   POST /milo/user/billing/upload?kind=key&sid=<sessionId>
 * form-data: file: (binary)
 */
router.post('/user/billing/upload', upload.single('file'), async (req, res) => {
  try {
    const { kind } = req.query;
    const sid = String(req.query.sid || '').trim();

    if (!sid) {
      return res.status(400).json({ ok: false, message: 'Falta sid en query.' });
    }
    if (!['cer', 'key'].includes(kind)) {
      return res.status(400).json({ ok: false, message: 'kind debe ser "cer" o "key".' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'No llegó archivo (form-data "file").' });
    }

    // Accedemos a la sesión igual que en contextFactory (fuente real del proyecto).
    const session = getSession(sid); // *** Usa la API real de session.js en tu repo ***
    if (!session) {
      return res.status(404).json({ ok: false, message: 'Sesión no encontrada.' });
    }

    session.meta = session.meta || {};
    session.meta.billing = session.meta.billing || {};
    session.meta.billing.files = session.meta.billing.files || {};
    session.meta.billing.files[kind] = {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: Date.now(),
    };

    return res.json({
      ok: true,
      saved: kind,
      size: req.file.size,
      filename: req.file.originalname,
      message: `Archivo ${kind.toUpperCase()} recibido y guardado en sesión.`,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error subiendo archivo', error: String(err) });
  }
});

export default router;
