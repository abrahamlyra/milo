// src/core/utils/normalize.js
export function stripDiacritics(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function toSatStrict(value, { allowDot = true } = {}) {
  if (value == null) return '';
  let s = stripDiacritics(String(value));
  s = s.toUpperCase();

  // Solo A-Z, 0-9, espacio y (opcional) punto
  const allowed = allowDot ? /[A-Z0-9 .]/ : /[A-Z0-9 ]/;
  s = Array.from(s).filter(ch => allowed.test(ch)).join('');

  // Colapsar espacios y puntos repetidos + recortar puntos al borde
  s = s.replace(/\s+/g, ' ').replace(/\.+/g, '.').trim();
  s = s.replace(/^\./, '').replace(/\.$/, '');
  return s;
}

export function normalizeRFC(s = '') {
  const up = stripDiacritics(String(s).trim().toUpperCase());
  const clean = up.replace(/[^A-Z0-9]/g, '');
  // Mantén hasta 13 por compatibilidad con Físicas; Morales suelen 12
  return clean.slice(0, 13);
}

export function validateRFC(s = '') {
  const rfc = normalizeRFC(s);
  const len = rfc.length;
  return { rfc, isValid: (len === 12 || len === 13) };
}

export function normalizeRazonSocial(s = '') {
  const up = toSatStrict(s, { allowDot: true });
  return up;
}

export function normalizePostalCode(s = '') {
  const onlyDigits = String(s).replace(/\D/g, '');
  return onlyDigits.slice(0, 5);
}

export function normalizeNumber(n) {
  if (n === '' || n == null) return '';
  const num = Number(n);
  return Number.isFinite(num) ? num : '';
}

export function normalizeMoney(n) {
  if (n === '' || n == null) return '';
  // admite "1,000.50" → 1000.5
  const clean = String(n).replace(/,/g, '');
  const num = Number(clean);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : '';
}

// Mapeo por clave
export function normalizeByFieldKey(key, raw) {
  const k = String(key || '').toLowerCase();

  if (k.includes('email')) return String(raw || '').trim();
  if (/\brfc\b/.test(k))   return normalizeRFC(raw);
  if (/\bcp\b|\bcodigo_postal\b/.test(k)) return normalizePostalCode(raw);
  if (/^items\[\]\.quantity$/.test(k) || /cantidad/.test(k)) return normalizeNumber(raw);
  if (/^items\[\]\.price$/.test(k) || /precio/.test(k) || /total|subtotal|importe/.test(k)) return normalizeMoney(raw);
  if (/razon|nombre|calle|colonia|municipio|estado|pais/.test(k)) return toSatStrict(raw, { allowDot: true });

  // por defecto: recorta strings
  return typeof raw === 'string' ? raw.trim() : raw;
}
