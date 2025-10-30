// src/webhook/controllers/messageController.js
import { okReply, errorReply, needsAuth } from '../../core/dialog/replies.js';
import { setUserInfo, extractTokenFromPayload } from '../../core/state/session.js';
import { getTool } from '../../core/nlu/intentRouter.js';

import { resolveActionAndInputFromMessage, initialHelpMessage, listTools, parseKV } from '../helpers/parsing.js';
import {
  formatTemplatesList,
  formatTemplatesContract,
  formatFillMissing,
  formatFillSuggest,
  formatFillApply,
} from '../helpers/formatters.js';

export function makeMessageController(contextFactory) {
  return async function handleMessage(req, res) {
    try {
      const { message, action, input, context } = req.body || {};
      const token = extractTokenFromPayload(req.body);
      if (!token) return res.status(401).json(needsAuth());

      // guarda info básica para autofill
      const userInfo = { id: context?.user?.id || null, email: context?.user?.email || null };
      // MODIFICACIÓN 1 (anteriormente aplicada): Usar sessionId de cualquier lugar del body
      const sid = req.body?.sessionId ?? req.body?.context?.sessionId ?? 'default';
      setUserInfo(sid, userInfo);

      // Resolver acción
      let resolvedAction = action ?? null;
      let resolvedInput = input ?? {};
      if (!resolvedAction && typeof message === 'string') {
        const fromMsg = resolveActionAndInputFromMessage(message);
        resolvedAction = fromMsg.action;
        resolvedInput = Object.keys(fromMsg.input || {}).length ? fromMsg.input : resolvedInput;

        // Caso especial "set ..."
        if (resolvedAction === 'fill.set' && resolvedInput?.__raw) {
          const m = String(resolvedInput.__raw).match(/^set\s+(.+)$/i);
          if (m) resolvedInput = parseKV(m[1]);
        }
      }

      if (!resolvedAction) {
        return res.json(okReply(initialHelpMessage(), { actions: listTools() }));
      }

      // Ejecutar tool
      const toolFactory = getTool(resolvedAction);
      const tool = await toolFactory(contextFactory); // por si el factory quiere el ctx
      const run = typeof tool === 'function' ? tool : await toolFactory();
      const result = await run(resolvedInput || {});

      // Formateo específico por acción
      if (resolvedAction === 'templates.list') {
        return res.json(okReply(formatTemplatesList(result), { result }));
      }
      
      // MODIFICACIÓN FINAL: Solo formatea la respuesta. 
      // La lógica de s.contract (fallback) se movió a la herramienta 'templates.contract'.
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
    }
  };
}