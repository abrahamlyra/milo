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

// 🧠 NUEVO: importamos el cerebro LLM de Milo (Fase 1)
import { runMiloBrain } from '../../ai/brain/index.js';

export function makeMessageController(contextFactory) {
  // NOTE: `contextFactory` puede ser:
  //  - una función sin argumentos: () => ctx
  //  - o una función que recibe req y devuelve otra función: (req) => () => ctx
  const makePerReqFactory = (req) => {
    if (contextFactory && contextFactory.length >= 1) {
      return contextFactory(req);
    }
    return () => contextFactory();
  };

  return async function handleMessage(req, res) {
    try {
      const { message, action, input, context } = req.body || {};
      const token = extractTokenFromPayload(req.body);
      if (!token) return res.status(401).json(needsAuth());

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

      // 🧠 NUEVO BLOQUE:
      // Si NO hay acción explícita, delegamos al cerebro LLM de Milo.
      // Si el LLM falla por cualquier razón, hacemos fallback al mensaje de ayuda clásico.
      if (!resolvedAction) {
        try {
          const brainResult = await runMiloBrain({
            sessionId: sid,
            message: message,
            rawPayload: req,
            contextFactory, 
          });

          if (!brainResult?.ok) {
            // Fallback suave: comportamiento anterior (help + listado de tools)
            return res.json(okReply(initialHelpMessage(), { actions: listTools() }));
          }

          return res.json(
            okReply(brainResult.reply, {
              mode: 'llm',
              usedTools: brainResult.usedTools || [],
            }),
          );
        } catch (err) {
          // Si algo truena MUY feo en el cerebro, también hacemos fallback al help.
          console.error('[Milo][Webhook] Error al ejecutar runMiloBrain:', err);
          return res.json(okReply(initialHelpMessage(), { actions: listTools() }));
        }
      }

      // ⬇️ Factory por request
      const perReqCtxFactory = makePerReqFactory(req);

      // 👀 Redirección contextual a billing.missing si estás en el wizard
      try {
        const peekCtx = perReqCtxFactory ? perReqCtxFactory() : null;
        const s = peekCtx?.session || {};
        if (resolvedAction === 'fill.missing' && s?.selectedTemplateId === 'billing.registerRFC') {
          resolvedAction = 'billing.missing';
        }
      } catch (_) {}

      // Ejecutar tool
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
      if (resolvedAction === 'billing.missing') {
        return res.json(okReply(formatFillMissing(result), { result }));
      }
      if (resolvedAction === 'fill.suggest') {
        return res.json(okReply(formatFillSuggest(result), { result }));
      }
      if (resolvedAction === 'fill.apply') {
        return res.json(okReply(formatFillApply(result), { result }));
      }

      // AÑADIDO: documents.create
      if (resolvedAction === 'documents.create') {
        return res.json(okReply(formatDocumentsCreate(result), { result }));
      }

      // AÑADIDO: invoices.create
      if (resolvedAction === 'invoices.create') {
        return res.json(okReply(formatInvoicesCreate(result), { result }));
      }

      // 🔧 billing (usar mensaje del resultado si existe)
      if (resolvedAction === 'billing.contract') {
        const msg = result?.message || formatBillingContract(result);
        return res.json(okReply(msg, { result }));
      }
      if (resolvedAction === 'billing.register') {
        if (result?.ok) {
          const msg = result?.message || formatBillingRegister(result);
          return res.json(okReply(msg, { result, ok: true }));
        } else {
          const status = result?.status || 400;
          const msg = result?.message || formatBillingRegister(result) || '❌ Error activando facturación.';
          return res.status(status).json(errorReply(msg, status));
        }
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
