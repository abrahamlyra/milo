// src/lyra/templates/contract.js
import { z } from 'zod';
import { registerTool } from '../../core/nlu/intentRouter.js';

const Input = z.object({
  templateId: z.string().min(1, 'templateId requerido'),
});

function isInvoiceType(rawType) {
  const t = String(rawType || '').trim().toLowerCase();
  if (!t) return false;
  // Accept both spanish/english markers that may exist in contract.type
  return t.includes('factura') || t.includes('invoice') || t === 'cfdi';
}

function normalizeContractView(templateId, raw) {
  const fields = Array.isArray(raw?.fields) ? raw.fields : [];

  const required = Array.isArray(raw?.required)
    ? raw.required
    : fields.filter((f) => f?.required).map((f) => f?.key || f?.name || f?.id);

  const optional = Array.isArray(raw?.optional)
    ? raw.optional
    : fields.filter((f) => !f?.required).map((f) => f?.key || f?.name || f?.id);

  const normalizedFields = fields.map((f) => ({
    key: f?.key || f?.name || f?.id,
    label: f?.label || f?.title || f?.name || f?.key,
    type: f?.type || 'string',
    required: !!f?.required,
    hint: f?.hint || f?.placeholder || null,
    enum: f?.enum || f?.options || null,
    optionsRef: f?.optionsRef || null,
    pattern: f?.pattern || null,
    min: f?.min ?? null,
    max: f?.max ?? null,
    default: f?.default,
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
    catalogs: raw?.catalogs || {},
    normalizers: raw?.normalizers || {},
    defaults: raw?.defaults || {},
    payloadShape: raw?.payloadShape || null,
    mappings: raw?.mappings || null,
    flowExtras: raw?.flowExtras || {},
  };
}

export default function templatesContract({ http }) {
  return async (rawInput) => {
    const { templateId } = Input.parse(rawInput || {});
    const { data } = await http.get(`/templates/${templateId}/contract`);
    return normalizeContractView(templateId, data);
  };
}

export function registerTemplateTools(contextFactory) {
  registerTool('templates.contract', async (injectedFactory) => {
    // ⬇️ preferir la factory inyectada por el controller
    const cf = injectedFactory || contextFactory;

    return async (rawInput) => {
      const { templateId } = Input.parse(rawInput || {});
      const ctx = cf(); // ← contexto del request correcto

      const { data } = await ctx.http.get(`/templates/${templateId}/contract`);

      const s = ctx.session;
      s.meta = s.meta || {};

      s.selectedTemplateId = templateId;
      s.contracts = s.contracts || {};
      s.contracts[templateId] = data;
      s.contract = data; // fallback plano
      s.provided = s.provided || {};
      s.provided[templateId] = s.provided[templateId] || {};

      // sembrar defaults sin pisar existentes
      const fields = Array.isArray(data?.fields) ? data.fields : [];
      for (const f of fields) {
        const k = f?.key || f?.name || f?.id;
        if (!k) continue;
        const has =
          s.provided[templateId][k] !== undefined &&
          s.provided[templateId][k] !== null &&
          s.provided[templateId][k] !== '';
        if (!has && f?.default !== undefined) s.provided[templateId][k] = f.default;
      }
      if (data?.defaults && typeof data.defaults === 'object') {
        for (const [k, v] of Object.entries(data.defaults)) {
          const has =
            s.provided[templateId][k] !== undefined &&
            s.provided[templateId][k] !== null &&
            s.provided[templateId][k] !== '';
          if (!has) s.provided[templateId][k] = v;
        }
      }

      // ✅ GATE: si es factura y no hay emisor seleccionado, pedir lista de emitters (tenant-scoped)
      const contractView = normalizeContractView(templateId, data);

      const isInvoice = isInvoiceType(contractView.type);
      const selectedEmitterId = String(s.meta?.selectedEmitterId || '').trim();

      if (isInvoice && !selectedEmitterId) {
        // Mark wizard state (deterministic)
        s.meta.awaitingEmitter = true;

        const r = await ctx.http.get('/emitters');
        const orgIdFromApi = r?.data?.organization_id ?? null;
        const emitters = Array.isArray(r?.data?.emitters) ? r.data.emitters : [];

        return {
          ...contractView,
          needsEmitter: true,
          reason: 'needs_emitter',
          organization_id: orgIdFromApi,
          emitters,
        };
      }

      // If emitter already selected, clear awaiting state
      if (isInvoice && selectedEmitterId) {
        s.meta.awaitingEmitter = false;
      }

      return contractView;
    };
  });
}
