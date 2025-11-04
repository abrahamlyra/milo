// src/lyra/templates/list.js
import { z } from 'zod';

const Input = z.object({
  page: z.number().int().positive().optional(),
  q: z.string().optional(),
  audience: z.string().min(1).optional(),
});

export default function templatesList({ http }) {
  return async (raw) => {
    const { page, q, audience } = Input.parse(raw || {});
    const params = {};
    if (page) params.page = page;
    if (q) params.q = q;

    // Si se filtra por audiencia, usamos el endpoint dedicado del backend.
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
