// src/lyra/templates/list.js
import { z } from 'zod';

const Input = z.object({
  page: z.number().int().positive().optional(),
  q: z.string().optional(),
  audience: z.string().min(1).optional(),
});

export default function templatesList({ http, req }) {
  return async (raw) => {
    const { page, q, audience } = Input.parse(raw || {});

    // En modo público usar la lista hardcodeada del contexto
    const isPublic = !!req?.body?.context?.isPublic;
    const publicTemplates = req?.body?.context?.publicTemplates;

    if (isPublic && Array.isArray(publicTemplates) && publicTemplates.length) {
      return {
        ok: true,
        count: publicTemplates.length,
        items: publicTemplates,
        meta: null,
      };
    }

    const params = {};
    if (page) params.page = page;
    if (q) params.q = q;

    const path = audience ? `/templates/audience/${encodeURIComponent(audience)}` : '/templates';

    const { data } = await http.get(path, { params });

    // El backend puede devolver un arreglo plano o un objeto con { items, count, ... }
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    const count = typeof data?.count === 'number' ? data.count : items.length;

    return {
      ok: true,
      count,
      items,
      meta: data, // dejamos el payload original por si aguas arriba lo necesitan
    };
  };
}