// src/lyra/templates/contract.js
import { z } from 'zod';

const Input = z.object({
  templateId: z.string().min(1, 'templateId requerido'),
});

export default function templatesContract({ http }) {
  return async (raw) => {
    const { templateId } = Input.parse(raw || {});

    // La baseURL YA trae /api, así que aquí usamos /templates/:id/contract
    const { data } = await http.get(`/templates/${templateId}/contract`);

    // Normalizamos por si el backend devuelve distintas formas
    // Esperamos algo como { fields: [...], required: [...], optional: [...] } o similar
    const fields = Array.isArray(data?.fields) ? data.fields : [];
    const required =
      Array.isArray(data?.required)
        ? data.required
        : fields.filter(f => f?.required).map(f => f?.key || f?.name || f?.id);
    const optional =
      Array.isArray(data?.optional)
        ? data.optional
        : fields.filter(f => !f?.required).map(f => f?.key || f?.name || f?.id);

    // Incluimos “shape” útil por campo
    const normalized = fields.map(f => ({
      key: f?.key || f?.name || f?.id,
      label: f?.label || f?.title || f?.name || f?.key,
      type: f?.type || 'string',
      required: !!f?.required,
      hint: f?.hint || f?.placeholder || null,
      enum: f?.enum || f?.options || null,
      pattern: f?.pattern || null,
      min: f?.min ?? null,
      max: f?.max ?? null,
    }));

    return {
      ok: true,
      templateId,
      required,
      optional,
      fields: normalized,
      raw: data, // por si ocupamos depurar
    };
  };
}
