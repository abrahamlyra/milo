// src/lyra/templates/create.js
import { z } from 'zod';

const Input = z.object({
  name: z.string().min(1, 'name requerido'),
  audience: z.string().min(1, 'audience requerido'),
  html: z.string().min(1, 'html requerido'),
  meta: z.record(z.any()).optional(),
});

export default function templatesCreate({ http }) {
  return async (raw) => {
    const { name, audience, html, meta } = Input.parse(raw || {});
    const payload = { name, audience, html, meta };
    const { data } = await http.post('/api/templates', payload);
    return {
      ok: true,
      templateId: data?.id ?? data?.templateId ?? null,
      meta: data,
    };
  };
}
