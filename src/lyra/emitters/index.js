// src/lyra/emitters/index.js
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
  registerTool('emitters.list', (inj) => {
    const ctx = (inj || contextFactory)();
    return async () => {
      const { data } = await ctx.http.get('/emitters');
      const emitters = Array.isArray(data?.emitters) ? data.emitters : [];
      return {
        ok: true,
        organization_id: data?.organization_id ?? null,
        emitters,
      };
    };
  });

  registerTool('emitters.select', (inj) => {
    const ctx = (inj || contextFactory)();
    return async (rawInput = {}) => {
      const parsed = SelectInput.parse(rawInput || {});
      const emitter_id = String(parsed.emitter_id || parsed.emitterId || '').trim();

      const s = ctx.session || {};
      s.meta = s.meta || {};

      // ✅ CANÓNICO (lo que ya lee facturapi/index.js y templates/contract.js)
      s.meta.selectedEmitterId = emitter_id;

      // ✅ COMPAT (por si algo viejo lo usa)
      s.meta.emitter_id = emitter_id;

      // ya no estás esperando emisor
      if (s.meta.awaitingEmitter) delete s.meta.awaitingEmitter;

      return {
        ok: true,
        emitter_id,
        selectedEmitterId: emitter_id,
        message: 'Emisor seleccionado',
      };
    };
  });

  registerTool('emitters.getSelected', (inj) => {
    const ctx = (inj || contextFactory)();
    return async () => {
      const s = ctx.session || {};
      const selectedEmitterId =
        s.meta?.selectedEmitterId ?? s.meta?.emitter_id ?? null;

      return {
        ok: true,
        emitter_id: selectedEmitterId,
        selectedEmitterId,
      };
    };
  });

  registerTool('emitters.reset', (inj) => {
    const ctx = (inj || contextFactory)();
    return async () => {
      const s = ctx.session || {};
      if (!s.meta) s.meta = {};
      delete s.meta.selectedEmitterId;
      delete s.meta.emitter_id;
      delete s.meta.awaitingEmitter;
      return { ok: true };
    };
  });
}
