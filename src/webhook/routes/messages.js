// src/webhook/routes/messages.js
import { Router } from 'express';
import { makeMessageController } from '../controllers/messageController.js';

export function makeMessagesRouter(contextFactory, setCurrentReq) {
  const router = Router();

  // Health local del router (opcional)
  router.get('/health', (_req, res) => res.json({ ok: true }));

  // Mensajes del bot
  const handleMessage = makeMessageController(contextFactory);

  router.post('/message', async (req, res, next) => {
    try {
      setCurrentReq(req);           // expone el req actual al contextFactory
      await handleMessage(req, res);
    } catch (e) {
      next(e);
    } finally {
      setCurrentReq(null);
    }
  });

  return router;
}
