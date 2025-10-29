// src/lyra/catalogs/resolve.js
function norm(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toCode(item) {
  // Soporta ambos esquemas: { clave, descripcion } o { value, text }
  return item?.clave ?? item?.value ?? null;
}

function toLabel(item) {
  return item?.descripcion ?? item?.text ?? item?.label ?? String(toCode(item) ?? '');
}

function jaccard(a, b) {
  const A = new Set(norm(a).split(/\W+/).filter(Boolean));
  const B = new Set(norm(b).split(/\W+/).filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}

/**
 * Busca un valor de catálogo a partir de texto libre del usuario.
 * Orden de matching:
 *  1) Key exacta (clave/value) insensitive/diacrítico.
 *  2) Label exacto (descripcion/text) insensitive/diacrítico.
 *  3) Coincidencia por "startsWith" en label.
 *  4) Fuzzy Jaccard (tokens) con umbral configurable (0.55 default).
 * Retorna: { code, label } | null
 */
export function resolveEnum(
  catalogs = {},
  optionsRef,
  userTextNullable,
  { threshold = 0.55 } = {}
) {
  const cat = catalogs?.[optionsRef];
  if (!Array.isArray(cat) || cat.length === 0) return null;

  // Si el usuario no dijo nada, no asumimos selección (lo decide el flujo con defaults)
  if (userTextNullable == null || String(userTextNullable).trim() === '') {
    return null;
  }

  const q = norm(userTextNullable);

  // 1) Coincidencia por clave/value exacta
  let hit = cat.find(x => norm(x?.clave ?? x?.value ?? '') === q);
  if (hit) return { code: toCode(hit), label: toLabel(hit) };

  // 2) Coincidencia por label exacta
  hit = cat.find(x => norm(x?.descripcion ?? x?.text ?? '') === q);
  if (hit) return { code: toCode(hit), label: toLabel(hit) };

  // 3) startsWith por label (p.ej. "personas fisicas" → "Personas Físicas...")
  hit = cat.find(x => norm(x?.descripcion ?? x?.text ?? '').startsWith(q));
  if (hit) return { code: toCode(hit), label: toLabel(hit) };

  // 4) Fuzzy por Jaccard en label
  let best = null;
  let score = 0;
  for (const it of cat) {
    const s = jaccard(q, toLabel(it));
    if (s > score) { score = s; best = it; }
  }
  if (best && score >= threshold) {
    return { code: toCode(best), label: toLabel(best) };
  }

  return null;
}

/**
 * Verifica/elige default válido para un campo enum.
 * - Si `field.default` existe en el catálogo, lo retorna.
 * - Si no, retorna null (para que el flujo lo trate como faltante).
 */
export function pickEnumDefault(catalogs = {}, field) {
  if (!field?.optionsRef) return null;
  const cat = catalogs?.[field.optionsRef];
  if (!Array.isArray(cat) || cat.length === 0) return null;

  const def = field?.default ?? null;
  if (def == null) return null;

  // Acepta tanto clave/value como label exacto
  const q = norm(def);
  const hit =
    cat.find(x => norm(toCode(x)) === q) ||
    cat.find(x => norm(toLabel(x)) === q);

  return hit ? { code: toCode(hit), label: toLabel(hit) } : null;
}
