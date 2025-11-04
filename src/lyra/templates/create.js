// src/lyra/templates/create.js
import { z } from 'zod';

const Input = z.object({
  name: z.string().min(1, 'name requerido'),
  type: z.string().min(1, 'type requerido'), // ← OBLIGATORIO
  html: z.string().min(1, 'html requerido'),
  audience: z.string().min(1).optional(),
  required_fields: z.array(z.string().min(1)).optional(),
  is_default_template: z.boolean().optional(),
  // meta puede venir, pero NO lo enviamos al backend
  meta: z.record(z.any()).optional(),
});

export default function templatesCreate({ http }) {
  return async (raw) => {
    const {
      name,
      type,
      html,
      audience,
      required_fields,
      is_default_template,
    } = Input.parse(raw || {});

    // Solo los campos que soporta tu backend
    const payload = { name, type, html };
    if (audience) payload.audience = audience;
    if (Array.isArray(required_fields)) payload.required_fields = required_fields;
    if (typeof is_default_template === 'boolean') {
      payload.is_default_template = is_default_template;
    }

    // OJO: baseURL ya incluye /api → aquí no agregamos /api
    const { data } = await http.post('/templates', payload);

    return {
      ok: true,
      templateId: data?.id ?? data?.templateId ?? null,
      data,
    };
  };
}
