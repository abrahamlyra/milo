export function toSatStrict(value, { allowDot = true } = {}) {
  if (value == null) return '';
  let s = String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toUpperCase();
  const allowed = allowDot ? /[A-Z0-9 .]/ : /[A-Z0-9 ]/;
  s = Array.from(s).filter(ch => allowed.test(ch)).join('');
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeByFieldKey(key, raw) {
  const k = key.toLowerCase();
  if (k.includes('email')) return String(raw || '').trim(); // no mayúsculas
  if (/\brfc\b/.test(k)) return toSatStrict(raw, { allowDot: false });
  if (/razon|nombre|calle|colonia|municipio|estado|pais/.test(k)) return toSatStrict(raw, { allowDot: true });
  return typeof raw === 'string' ? raw.trim() : raw;
}
