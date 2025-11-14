// src/webhook/routes/assetsUploads.js
import express from 'express';
import multer from 'multer';
import { getSession } from '../../core/state/session.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Subida efímera de assets (imágenes) al bot, guardados en sesión (memoria),
 * para que luego Milo pueda mandarlos al backend /assets/upload cuando el
 * usuario confirme ("subir logo", "subir header", etc.).
 *
 * Uso desde el front:
 *   POST /milo/assets/upload?tipo=logo&sid=<sessionId>
 * form-data:
 *   file: (binary)
 */
router.post('/assets/upload', upload.single('file'), async (req, res) => {
  try {
    const rawTipo = req.query.tipo;
    const tipo = typeof rawTipo === 'string' ? rawTipo.trim() : '';
    const sid = String(req.query.sid || '').trim();

    if (!sid) {
      return res.status(400).json({ ok: false, message: 'Falta sid en query.' });
    }
    if (!tipo) {
      return res.status(400).json({ ok: false, message: 'Falta tipo en query.' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'No llegó archivo (form-data "file").' });
    }

    const session = getSession(sid);
    if (!session) {
      return res.status(404).json({ ok: false, message: 'Sesión no encontrada.' });
    }

    session.meta = session.meta || {};
    session.meta.assets = session.meta.assets || {};
    session.meta.assets[tipo] = {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: Date.now(),
    };

    // Log ligero de depuración (igual estilo que billingUploads)
    try {
      const keys = Object.keys(session.meta.assets || {});
      // eslint-disable-next-line no-console
      console.log('[UPLOAD_ASSET]', { sid, tipo, keys, size: req.file.size });
    } catch (_) {}

    return res.json({
      ok: true,
      saved: tipo,
      size: req.file.size,
      filename: req.file.originalname,
      message: `Asset "${tipo}" recibido y guardado en sesión.`,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: 'Error subiendo asset',
      error: String(err),
    });
  }
});

export default router;
