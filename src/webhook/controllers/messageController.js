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
  // AÑADIDO: Importar los nuevos formateadores
  formatDocumentsCreate,
  formatInvoicesCreate,
  // NUEVOS: billing
  formatBillingContract,
  formatBillingRegister,
} from '../helpers/formatters.js';

export function makeMessageController(contextFactory) {
  // NOTE: `contextFactory` puede ser:
  //  - una función sin argumentos: () => ctx
  //  - o una función que recibe req y devuelve otra función: (req) => () => ctx
  const makePerReqFactory = (req) => {
    // si la factory acepta 1+ args, asumimos que quiere el req
    if (contextFactory && contextFactory.length >= 1) {
      return contextFactory(req);
    }
    // si no, intentamos usarla tal cual
    return () => contextFactory();
  };

  return async function handleMessage(req, res) {
    try {
      const { message, action, input, context } = req.body || {};
      const token = extractTokenFromPayload(req.body);
      if (!token) return res.status(401).json(needsAuth());

      // guarda info básica para autofill
      const userInfo = { id: context?.user?.id || null, email: context?.user?.email || null };
      const sid = req.body?.sessionId ?? req.body?.context?.sessionId ?? 'default';
      setUserInfo(sid, userInfo);

      // Resolver acción
      let resolvedAction = action ?? null;
      let resolvedInput = input ?? {};
      if (!resolvedAction && typeof message === 'string') {
        const fromMsg = resolveActionAndInputFromMessage(message);
        resolvedAction = fromMsg.action;
        resolvedInput = Object.keys(fromMsg.input || {}).length ? fromMsg.input : resolvedInput;

        if (resolvedAction === 'fill.set' && resolvedInput?.__raw) {
          const m = String(resolvedInput.__raw).match(/^set\s+(.+)$/i);
          if (m) resolvedInput = parseKV(m[1]);
        }
      }

      if (!resolvedAction) {
        return res.json(okReply(initialHelpMessage(), { actions: listTools() }));
      }

      // ⬇️ Factory por request
      const perReqCtxFactory = makePerReqFactory(req);

      // 👀 Peek de sesión para redirecciones contextuales
      try {
        const peekCtx = perReqCtxFactory ? perReqCtxFactory() : null;
        const s = peekCtx?.session || {};
        // Redirigir faltantes genéricos al checker de billing si estamos en el wizard
        if (resolvedAction === 'fill.missing' && s?.selectedTemplateId === 'billing.registerRFC') {
          resolvedAction = 'billing.missing';
        }
      } catch (_) {
        // si fallara el peek, no bloqueamos el flujo
      }

      // Ejecutar tool pasando la factory por request
      const toolFactory = getTool(resolvedAction);
      const toolOrRunner = await toolFactory(perReqCtxFactory);
      const runner = (typeof toolOrRunner === 'function') ? toolOrRunner : await toolFactory(perReqCtxFactory);
      const result = await runner(resolvedInput || {});

      if (resolvedAction === 'templates.list') {
        return res.json(okReply(formatTemplatesList(result), { result }));
      }
      if (resolvedAction === 'templates.contract') {
        return res.json(okReply(formatTemplatesContract(result), { result }));
      }
      if (resolvedAction === 'fill.missing') {
        return res.json(okReply(formatFillMissing(result), { result }));
      }
      // ✅ NUEVO: billing.missing usa el mismo formateador que fill.missing
      if (resolvedAction === 'billing.missing') {
        return res.json(okReply(formatFillMissing(result), { result }));
      }
      if (resolvedAction === 'fill.suggest') {
        return res.json(okReply(formatFillSuggest(result), { result }));
      }
      if (resolvedAction === 'fill.apply') {
        return res.json(okReply(formatFillApply(result), { result }));
      }
      
      // AÑADIDO: Formateador para documents.create
      if (resolvedAction === 'documents.create') { 
        return res.json(okReply(formatDocumentsCreate(result), { result }));
      }
      
      // Manejar invoices.create con su formateador
      if (resolvedAction === 'invoices.create') { 
        return res.json(okReply(formatInvoicesCreate(result), { result }));
      }

      // billing (wizard Activar facturación)
      if (resolvedAction === 'billing.contract') {
        return res.json(okReply(formatBillingContract(result), { result }));
      }
      if (resolvedAction === 'billing.register') {
        const ok = !!result?.ok;
        return res.json(okReply(formatBillingRegister(result), { result, ok }));
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
