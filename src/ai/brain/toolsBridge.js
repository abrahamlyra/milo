// src/ai/brain/toolsBridge.js
import { getTool } from '../../core/nlu/intentRouter.js';

function makePerReqFactory(contextFactory, rawReq) {
  if (!contextFactory) return null;

  // Si el contextFactory acepta 1 argumento, asumimos que es (req) => () => ctx
  if (contextFactory.length >= 1) {
    return contextFactory(rawReq);
  }

  // Si no, asumimos que es () => ctx
  return () => contextFactory();
}

/**
 * Ejecuta una acción de Milo (templates.list, etc.) usando el mismo
 * contrato que en messageController, pero desde el cerebro LLM.
 */
export async function callMiloAction({ action, input = {}, contextFactory, rawReq }) {
  if (!action || typeof action !== 'string') {
    throw new Error(`[Milo][toolsBridge] Acción inválida: ${action}`);
  }

  const toolFactory = getTool(action);
  if (!toolFactory) {
    throw new Error(`[Milo][toolsBridge] No encontré tool para la acción "${action}"`);
  }

  const perReqCtxFactory = makePerReqFactory(contextFactory, rawReq);

  const toolOrRunner = await toolFactory(perReqCtxFactory);
  const runner =
    typeof toolOrRunner === 'function'
      ? toolOrRunner
      : await toolFactory(perReqCtxFactory);

  const result = await runner(input || {});
  return result;
}
