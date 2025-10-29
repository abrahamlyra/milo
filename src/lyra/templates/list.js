// src/lyra/templates/list.js
import { z } from 'zod';

const Input = z.object({
  page: z.number().int().positive().optional(),
  q: z.string().optional(),
});

export default function templatesList({ http }) {
  return async (raw) => {
    const { page, q } = Input.parse(raw || {});
    const params = {};
    if (page) params.page = page;
    if (q) params.q = q;

    const { data } = await http.get('/templates', { params });
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return {
      ok: true,
      count: items.length ?? (data?.count ?? 0),
      items,
      meta: data,
    };
  };
}
