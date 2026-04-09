// src/webhook/controllers/messageController.js
import { okReply, errorReply, needsAuth } from '../../core/dialog/replies.js';
import { setUserInfo, extractTokenFromPayload } from '../../core/state/session.js';
import { getTool } from '../../core/nlu/intentRouter.js';

import {
  resolveActionAndInputFromMessage,
  initialHelpMessage,
  listTools,
  parseKV,
} from '../helpers/parsing.js';
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

function pickEmitterFlags(result) {
  const r = result || {};
  const reason = String(r.reason || r?.result?.reason || '').trim();
  const needsEmitter =
    r.needsEmitter === true ||
    reason === 'needs_emitter';

  const emitters =
    (Array.isArray(r.emitters) ? r.emitters : null) ||
    (Array.isArray(r?.result?.emitters) ? r.result.emitters : null) ||
    [];

  const organization_id =
    r.organization_id ?? r?.result?.organization_id ?? null;

  return { needsEmitter, reason: needsEmitter ? 'needs_emitter' : reason, emitters, organization_id };
}

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

      const userInfo = {
        id: context?.user?.id || null,
        email: context?.user?.email || null,
      };
      const sid = req.body?.sessionId ?? req.body?.context?.sessionId ?? 'default';
      setUserInfo(sid, userInfo);

      // ✅ Factory por request (MOVIDO ARRIBA)
      // Esto amarra req.body → contextFactory → orgId → X-Organization-Id
      const perReqCtxFactory = makePerReqFactory(req);

      // Resolver acción
      let resolvedAction = action ?? null;
      let resolvedInput = input ?? {};
      if (!resolvedAction && typeof message === 'string') {
        const fromMsg = resolveActionAndInputFromMessage(message);
        resolvedAction = fromMsg.action;
        resolvedInput = Object.keys(fromMsg.input || {}).length ? fromMsg.input : resolvedInput;

        if (resolvedAction === 'fill.set' && resolvedInput?.__raw) {
          const m = String(resolvedInput.__raw).match(/^set\s+(.+)$/i);
          if (m) resolvedInput = { __raw: m[1] };
        }
      }

      // 🧠 NUEVO BLOQUE:
      // Si NO hay acción explícita, delegamos al cerebro LLM de Milo.
      // Si el LLM falla por cualquier razón, respondemos con mensaje amigable en lugar del help genérico.
      if (!resolvedAction) {
        try {
          const brainResult = await runMiloBrain({
            sessionId: sid,
            message: message,
            rawPayload: req,
            // ✅ CRÍTICO: pasar el factory por request, NO el global suelto
            contextFactory: perReqCtxFactory,
          });

          if (!brainResult?.ok) {
            // Fallback amigable: mensaje útil en lugar del menú de comandos
            const fallbackMsg =
              'No pude procesar tu mensaje en este momento. ' +
              'Intenta de nuevo o usa un comando específico como: ' +
              '`templates.list`, `faltantes`, `sugerir`, `generar`, `facturar`.';
            return res.json(okReply(fallbackMsg, { actions: listTools() }));
          }

          return res.json(
            okReply(brainResult.reply, {
              mode: 'llm',
              usedTools: brainResult.usedTools || [],
              // 👇 NUEVO: pasamos también la lista de templates (si aplica)
              templates: brainResult.templates || undefined,
              provided: brainResult.provided || undefined,
            })
          );
        } catch (err) {
          // Si algo truena MUY feo en el cerebro, también respondemos con mensaje amigable.
          console.error('[Milo][Webhook] Error al ejecutar runMiloBrain:', err);
          const fallbackMsg =
            'Ocurrió un error inesperado. ' +
            'Intenta de nuevo o usa un comando específico como: ' +
            '`templates.list`, `faltantes`, `sugerir`, `generar`, `facturar`.';
          return res.json(okReply(fallbackMsg, { actions: listTools() }));
        }
      }

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
      const runner =
        typeof toolOrRunner === 'function' ? toolOrRunner : await toolFactory(perReqCtxFactory);
      const result = await runner(resolvedInput || {});

      // ✅ Si el tool pide emisor, lo propagamos arriba (sin depender del front todavía)
      const ef = pickEmitterFlags(result);

      if (resolvedAction === 'templates.list') {
        return res.json(okReply(formatTemplatesList(result), { result }));
      }

      if (resolvedAction === 'templates.contract') {
        // Si el contract indica que es factura y falta emisor → UX determinístico
        if (ef.needsEmitter) {
          return res.json(
            okReply('Necesitas escoger un emisor (RFC) para continuar con la factura.', {
              result,
              needsEmitter: true,
              reason: 'needs_emitter',
              emitters: ef.emitters,
              organization_id: ef.organization_id,
            })
          );
        }

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

      // Delivery (preferencia de envío por correo / SMS)
      if (
        resolvedAction === 'fill.delivery' ||
        resolvedAction === 'fill.delivery.reset' ||
        resolvedAction === 'fill.delivery.get'
      ) {
        const d = result?.delivery || {};
        const mode = String(d.mode || 'none').toLowerCase();
        const emailTo = d?.email?.to ?? null;

        let msg;
        if (resolvedAction === 'fill.delivery.get') {
          msg = mode === 'none'
            ? 'Sin preferencia de envío configurada.'
            : mode === 'email' && emailTo
              ? `📧 Se enviará a **${emailTo}** por correo.`
              : `Modo de entrega: **${mode}**.`;
        } else if (resolvedAction === 'fill.delivery.reset') {
          msg = '✔️ Preferencia de envío eliminada.';
        } else if (mode === 'email' && emailTo) {
          msg = `📧 Listo. Se enviará el documento a **${emailTo}** cuando lo generes.\nEscribe \`generar\` para generarlo y enviarlo.`;
        } else if (mode === 'none') {
          msg = '✔️ Entrega desactivada. El documento se generará sin envío.';
        } else {
          msg = `✔️ Preferencia de entrega guardada (modo: ${mode}).`;
        }

        return res.json(okReply(msg, { result }));
      }

      // AÑADIDO: documents.create
      if (resolvedAction === 'documents.create') {
        return res.json(okReply(formatDocumentsCreate(result), { result }));
      }

      // AÑADIDO: invoices.create
      if (resolvedAction === 'invoices.create') {
        // Si falta emisor, propagamos flags (para que UI/consumidor sepa)
        if (ef.needsEmitter) {
          return res.json(
            okReply(result?.message || 'Necesitas escoger un emisor (RFC) antes de timbrar la factura.', {
              result,
              needsEmitter: true,
              reason: 'needs_emitter',
              emitters: ef.emitters,
              organization_id: ef.organization_id,
            })
          );
        }

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
          const msg =
            result?.message ||
            formatBillingRegister(result) ||
            '❌ Error activando facturación.';
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