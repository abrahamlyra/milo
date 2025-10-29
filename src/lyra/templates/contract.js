// src/lyra/templates/contract.js
import { z } from 'zod';
import { registerTool } from '../../core/nlu/intentRouter.js';

const Input = z.object({
  templateId: z.string().min(1, 'templateId requerido'),
});

/**
 * Normaliza el contrato crudo del backend a la forma que el server espera
 * (required[], optional[], fields[]), conservando metadatos útiles.
 */
function normalizeContractView(templateId, raw) {
  const fields = Array.isArray(raw?.fields) ? raw.fields : [];

  const required = Array.isArray(raw?.required)
    ? raw.required
    : fields.filter(f => f?.required).map(f => f?.key || f?.name || f?.id);

  const optional = Array.isArray(raw?.optional)
    ? raw.optional
    : fields.filter(f => !f?.required).map(f => f?.key || f?.name || f?.id);

  const normalizedFields = fields.map(f => ({
    key: f?.key || f?.name || f?.id,
    label: f?.label || f?.title || f?.name || f?.key,
    type: f?.type || 'string',
    required: !!f?.required,
    hint: f?.hint || f?.placeholder || null,
    enum: f?.enum || f?.options || null,
    optionsRef: f?.optionsRef || null, // importante para enums ligados a catálogos
    pattern: f?.pattern || null,
    min: f?.min ?? null,
    max: f?.max ?? null,
    default: f?.default, // lo usamos para sembrar
    group: f?.group ?? null,
  }));

  return {
    ok: true,
    templateId,
    type: raw?.type || null,
    name: raw?.name || null,
    required,
    optional,
    fields: normalizedFields,
    // Metadatos que usan los fill tools:
    catalogs: raw?.catalogs || {},
    normalizers: raw?.normalizers || {},
    defaults: raw?.defaults || {},
    payloadShape: raw?.payloadShape || null,
    mappings: raw?.mappings || null,
    flowExtras: raw?.flowExtras || {},
  };
}

/**
 * (Opcional) export default “callable” si en algún momento lo quieres invocar directo.
 * No es usado por el registry, pero lo dejamos disponible.
 */
export default function templatesContract({ http }) {
  return async (rawInput) => {
    const { templateId } = Input.parse(rawInput || {});
    const { data } = await http.get(`/templates/${templateId}/contract`);
    return normalizeContractView(templateId, data);
  };
}

export function registerTemplateTools(contextFactory) {
  registerTool('templates.contract', async () => {
    const ctx = contextFactory();
    return async (rawInput) => {
      const { templateId } = Input.parse(rawInput || {});

      // 1) Trae contract crudo del backend
      const { data } = await ctx.http.get(`/templates/${templateId}/contract`);

      // 2) Persiste en sesión el crudo (para fill.* que usan catalogs/fields originales)
      const s = ctx.session;
      s.selectedTemplateId = templateId;
      s.contracts = s.contracts || {};
      s.contracts[templateId] = data; // mantener "raw" aquí
      s.provided = s.provided || {};
      s.provided[templateId] = s.provided[templateId] || {};

      // 3) Siembra defaults (de fields[].default y/o raw.defaults) SIN pisar valores existentes
      const fields = Array.isArray(data?.fields) ? data.fields : [];
      for (const f of fields) {
        const k = f?.key || f?.name || f?.id;
        if (!k) continue;
        const hasValue = s.provided[templateId][k] !== undefined && s.provided[templateId][k] !== null && s.provided[templateId][k] !== '';
        if (!hasValue && f?.default !== undefined) {
          s.provided[templateId][k] = f.default;
        }
      }
      if (data?.defaults && typeof data.defaults === 'object') {
        for (const [k, v] of Object.entries(data.defaults)) {
          const hasValue = s.provided[templateId][k] !== undefined && s.provided[templateId][k] !== null && s.provided[templateId][k] !== '';
          if (!hasValue) s.provided[templateId][k] = v;
        }
      }

      // 4) Devuelve vista normalizada para que el server la pinte bonito
      return normalizeContractView(templateId, data);
    };
  });
}
