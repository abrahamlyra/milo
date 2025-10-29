// src/core/nlu/intentRouter.js

// Registro de tools y aliases (en memoria del proceso)
const registry = new Map();
const aliases  = new Map();

/* =========================
   Registro y consulta
========================= */
export function registerTool(name, factory) {
  if (registry.has(name)) throw new Error(`Tool duplicado: ${name}`);
  registry.set(name, factory);
}

export function registerAlias(alias, targetName) {
  if (!registry.has(targetName)) throw new Error(`Alias apunta a tool inexistente: ${targetName}`);
  if (aliases.has(alias)) throw new Error(`Alias duplicado: ${alias}`);
  aliases.set(alias, targetName);
}

export function hasTool(name) {
  return registry.has(name) || aliases.has(name);
}

export function tryGetTool(name) {
  if (registry.has(name)) return registry.get(name);
  if (aliases.has(name)) {
    const dst = aliases.get(name);
    return registry.get(dst) || null;
  }
  return null;
}

export function getTool(name) {
  const f = tryGetTool(name);
  if (!f) throw new Error(`Tool no encontrado: ${name}`);
  return f;
}

export function listTools() {
  return Array.from(new Set([
    ...registry.keys(),
    ...aliases.keys(),
  ])).sort();
}

/* =========================
   Aliases "naturales"
   (frases → acción + input)
========================= */
const NATURAL_ALIASES = [
  // usar <templateId>  → templates.contract templateId=...
  { re: /^usar\s+([a-z0-9-]{8,})$/i, action: 'templates.contract', args: (m) => ({ templateId: m[1] }) },

  // faltantes → fill.missing
  { re: /^faltantes$/i, action: 'fill.missing', args: () => ({}) },

  // sugerir / sugerir full → fill.suggest mode=...
  { re: /^sugerir(?:\s+(min|full))?$/i, action: 'fill.suggest', args: (m) => ({ mode: (m[1] || 'min').toLowerCase() }) },

  // aplicar → fill.apply
  { re: /^aplicar$/i, action: 'fill.apply', args: () => ({}) },

  // set key=val ... → fill.set (multi-KV)
  { re: /^set\s+.+$/i, action: 'fill.set', args: (m) => ({ __raw: m[0] }) },
];

/* =========================
   Resolución principal
========================= */
/**
 * resolveActionName:
 *  - Si coincide con alias natural, regresa { action, input }.
 *  - Si coincide exactamente con un tool, regresa { action, {} }.
 *  - Si viene como "tool key=value …", parsea y regresa { action, input }.
 *  - Si nada, { action:null, input:null }.
 */
export function resolveActionName(text) {
  if (typeof text !== 'string') return { action: null, input: null };
  const T = text.trim();
  if (!T) return { action: null, input: null };

  // 1) Aliases naturales
  for (const rule of NATURAL_ALIASES) {
    const m = T.match(rule.re);
    if (m) return { action: rule.action, input: rule.args(m) || {} };
  }

  // 2) Nombre exacto de tool
  if (hasTool(T)) return { action: T, input: {} };

  // 3) "tool key=value ..."
  const m = T.match(/^([a-z0-9._-]+)\s+(.+)$/i);
  if (m && hasTool(m[1])) {
    const kv = parseKV(m[2]);
    return { action: m[1], input: kv };
  }

  return { action: null, input: null };
}

/* =========================
   Util: parseKV
========================= */
/**
 * Soporta key=value con:
 * - comillas dobles/simples: title="Mi título" desc='con espacios'
 * - números: page=2 → 2 (number), 02 → "02" (string)
 * - true/false → boolean
 */
export function parseKV(rest = '') {
  const out = {};
  const re = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1];
    const raw = m[3] ?? m[4] ?? m[2];

    // boolean
    if (/^(true|false)$/i.test(raw)) {
      out[key] = /^true$/i.test(raw);
      continue;
    }
    // number (sin ceros a la izquierda)
    if (/^[1-9][0-9]*$/.test(raw)) {
      out[key] = Number(raw);
      continue;
    }
    // float
    if (/^[0-9]+\.[0-9]+$/.test(raw)) {
      out[key] = Number(raw);
      continue;
    }
    out[key] = raw;
  }
  return out;
}
