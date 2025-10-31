// src/webhook/helpers/parsing.js
import { getTool, listTools } from '../../core/nlu/intentRouter.js';

/** KV parser: key=value con comillas, soporta dots/brackets p.ej. items[0].price=123 */
export function parseKV(rest = '') {
  const out = {};
  // acepta letras, números, guion bajo, punto y corchetes en la KEY
  const re = /([\w.\[\]]+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1];
    const raw = m[3] ?? m[4] ?? m[2];
    // si es entero puro, lo casteamos a número (p.ej. quantity=1, price=3500)
    out[key] = /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/** Alias naturales (lenguaje humano → acción + input) */
const NATURAL_ALIASES = [
  { re: /^usar\s+([a-z0-9-]{8,})$/i,            action: 'templates.contract', args: m => ({ templateId: m[1] }) },
  { re: /^faltantes$/i,                          action: 'fill.missing',       args: () => ({}) },
  { re: /^sugerir(?:\s+(min|full))?$/i,          action: 'fill.suggest',       args: m => ({ mode: (m[1] || 'min').toLowerCase() }) },
  { re: /^generar(?:\s+documento)?$/i,           action: 'documents.create',   args: () => ({}) },
  { re: /^(?:facturar|generar\s+factura)$/i,     action: 'invoices.create',    args: () => ({}) }, // ⬅️ Alias ya agregado
  { re: /^aplicar$/i,                            action: 'fill.apply',         args: () => ({}) },
  { re: /^set\s+.+$/i,                           action: 'fill.set',           args: m => ({ __raw: m[0] }) },
];

/** Intenta mapear texto a { action, input } */
export function resolveActionAndInputFromMessage(msg) {
  if (typeof msg !== 'string') return { action: null, input: null };
  const text = msg.trim();
  if (!text) return { action: null, input: null };

  // 1) Aliases naturales
  for (const rule of NATURAL_ALIASES) {
    const m = text.match(rule.re);
    if (m) return { action: rule.action, input: rule.args(m) || {} };
  }

  // 2) Nombre exacto de tool
  try {
    getTool(text); // valida que exista
    return { action: text, input: {} };
  } catch { /* no-op */ }

  // 3) "tool key=value ..."
  const m = text.match(/^([a-z0-9._-]+)\s+(.+)$/i);
  if (m) {
    const candidate = m[1];
    try {
      getTool(candidate);
      const kv = parseKV(m[2]);
      return { action: candidate, input: kv };
    } catch { /* no-op */ }
  }

  return { action: null, input: null };
}

/** Mensaje inicial por defecto */
export function initialHelpMessage() {
  return 'Estoy listo. Puedes escribir: `templates.list`, `usar <templateId>`, `faltantes`, `sugerir`, `sugerir full`, `aplicar`, `generar`, `facturar`, o `set key=valor`.'; // ⬅️ MENSAJE ACTUALIZADO
}

export { listTools };