import { z } from 'zod';
import { registerTool } from '../../core/nlu/intentRouter.js';

// Acepta emitter_id (snake) o emitterId (camel) y lo normaliza
const SelectInput = z
  .object({
    emitter_id: z.string().min(1).optional(),
    emitterId: z.string().min(1).optional(),
  })
  .refine((v) => !!(v.emitter_id || v.emitterId), {
    message: 'emitter_id requerido',
  });

export function registerEmitterTools(contextFactory) {
  /**
   * Listar emitters del usuario (scope por org via X-Organization-Id en http client)
   * GET /api/emitters  (ojo: baseURL ya incluye /api)
   */
  registerTool('emitters.list', (inj) => {
    const ctx = (inj || contextFactory)();
    return async (_input = {}) => {
      const { data } = await ctx.http.get('/emitters');
      const emitters = Array.isArray(data?.emitters) ? data.emitters : [];
      return {
        ok: true,
        organization_id: data?.organization_id ?? null,
        emitters,
      };
    };
  });

  /**
   * Seleccionar emisor actual para el flujo de factura
   * NO pega al backend, solo persiste en sesión
   */
  registerTool('emitters.select', (inj) => {
    const ctx = (inj || contextFactory)();
    return async (rawInput = {}) => {
      const parsed = SelectInput.parse(rawInput || {});
      const emitter_id = String(parsed.emitter_id || parsed.emitterId || '').trim();

      const s = ctx.session || {};
      s.meta = s.meta || {};
      s.meta.emitter_id = emitter_id;

      return {
        ok: true,
        emitter_id: s.meta.emitter_id,
        message: 'Emisor seleccionado',
      };
    };
  });

  /**
   * Ver emisor seleccionado (debug)
   */
  registerTool('emitters.getSelected', (inj) => {
    const ctx = (inj || contextFactory)();
    return async () => {
      const s = ctx.session || {};
      const emitter_id = s.meta?.emitter_id ?? null;
      return {
        ok: true,
        emitter_id,
      };
    };
  });

  /**
   * Reset emisor seleccionado
   */
  registerTool('emitters.reset', (inj) => {
    const ctx = (inj || contextFactory)();
    return async () => {
      const s = ctx.session || {};
      if (!s.meta) s.meta = {};
      delete s.meta.emitter_id;
      return { ok: true };
    };
  });
}
