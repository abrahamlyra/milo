// src/webhook/helpers/parsing.js
import { getTool, listTools } from '../../core/nlu/intentRouter.js';

/** KV parser: key=value con comillas, soporta dots/brackets p.ej. items[0].price=123 */
export function parseKV(rest = '') {
  const out = {};
  const re = /([\w.\[\]]+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1];
    const raw = m[3] ?? m[4] ?? m[2];
    out[key] = /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/**
 * Mapeo de tipos de assets que puede usar el usuario / front
 * hacia los tipos que entiende el backend de assets.
 *
 * raw  → lo que escribe el usuario / front
 * tipo → lo que mandamos al backend (/assets/upload, /assets/:tipo)
 */
const ASSET_TYPE_ALIASES = {
  // tipos que ya coinciden 1:1
  logo: { tipo: 'logo', rawTipo: 'logo' },
  header: { tipo: 'header', rawTipo: 'header' },
  footer: { tipo: 'footer', rawTipo: 'footer' },
  background: { tipo: 'background', rawTipo: 'background' },
  image: { tipo: 'image', rawTipo: 'image' },

  // tipos que viene usando hoy el front
  header_img: { tipo: 'header', rawTipo: 'header_img' },
  footer_img: { tipo: 'footer', rawTipo: 'footer_img' },
  watermark: { tipo: 'background', rawTipo: 'watermark' },
  signature: { tipo: 'image', rawTipo: 'signature' },
};

/** KV parser: natural language → acción + input */
const NATURAL_ALIASES = [
  { re: /^usar\s+([a-z0-9-]{8,})$/i, action: 'templates.contract', args: (m) => ({ templateId: m[1] }) },
  { re: /^faltantes$/i, action: 'fill.missing', args: () => ({}) },
  { re: /^sugerir(?:\s+(min|full))?$/i, action: 'fill.suggest', args: (m) => ({ mode: (m[1] || 'min').toLowerCase() }) },
  { re: /^generar(?:\s+documento)?$/i, action: 'documents.create', args: () => ({}) },
  { re: /^(?:facturar|generar\s+factura|timbrar)$/i, action: 'invoices.create', args: () => ({}) },
  { re: /^aplicar$/i, action: 'fill.apply', args: () => ({}) },
  { re: /^set\s+.+$/i, action: 'fill.set', args: (m) => ({ __raw: m[0] }) },

  // === Delivery (envío por correo)
  // "enviar a correo@...", "mandar a correo@...", "notificar correo@..."
  // → fill.delivery mode=email email.to=<correo>
  {
    re: /^(?:enviar|mandar|notificar)\s+(?:a\s+)?([^\s@]+@[^\s@]+\.[^\s@]+)$/i,
    action: 'fill.delivery',
    args: (m) => ({ mode: 'email', 'email.to': m[1] }),
  },
  // "sin correo", "sin envío", "solo pdf"
  // → fill.delivery mode=none
  {
    re: /^(?:sin\s+correo|sin\s+env[ií]o|solo\s+pdf)$/i,
    action: 'fill.delivery',
    args: () => ({ mode: 'none' }),
  },

  // === Emitters (selección de emisor RFC)
  // list
  { re: /^(?:emisores|listar\s+emisores|ver\s+emisores)$/i, action: 'emitters.list', args: () => ({}) },

  // select
  // soporta: "elegir emisor <id>", "seleccionar emisor <id>", "emisor <id>"
  {
    re: /^(?:elegir|seleccionar)\s+emisor\s+([a-z0-9-]{6,})$/i,
    action: 'emitters.select',
    args: (m) => ({ emitter_id: m[1] }),
  },
  {
    re: /^emisor\s+([a-z0-9-]{6,})$/i,
    action: 'emitters.select',
    args: (m) => ({ emitter_id: m[1] }),
  },

  // (opcionales / útiles)
  { re: /^(?:emisor\s+actual|ver\s+emisor|emisor\?)$/i, action: 'emitters.getSelected', args: () => ({}) },
  { re: /^(?:limpiar\s+emisor|reset\s+emisor|cambiar\s+emisor)$/i, action: 'emitters.reset', args: () => ({}) },

  // === Wizard de Activar facturación (billing)
  {
    re: /^(activar\s+facturaci[oó]n|activar\s+csd|registro\s+rfc|alta\s+csd)$/i,
    action: 'billing.contract',
    args: () => ({}),
  },

  // ⬇️ usa el checker que sí contempla cer/key en sesión
  {
    re: /^(faltantes\s+facturaci[oó]n|faltantes\s+csd|faltantes\s+rfc)$/i,
    action: 'billing.missing',
    args: () => ({}),
  },

  {
    re: /^(sugerir\s+facturaci[oó]n|sugerir\s+csd)$/i,
    action: 'fill.suggest',
    args: () => ({}),
  },

  {
    re: /^(registrar\s+rfc|confirmar\s+facturaci[oó]n|activar\s+facturaci[oó]n\s+ahora)$/i,
    action: 'billing.register',
    args: () => ({}),
  },

  // === Assets (logo / header / footer / watermark / signature)
  // "subir <tipo>"
  {
    re: /^subir\s+(logo|header|footer|background|image|header_img|footer_img|watermark|signature)$/i,
    action: 'assets.upload',
    args: (m) => {
      const raw = m[1].toLowerCase();
      const mapped = ASSET_TYPE_ALIASES[raw] || { tipo: raw, rawTipo: raw };
      return {
        tipo: mapped.tipo,
        rawTipo: mapped.rawTipo,
      };
    },
  },

  // "ver <tipo>"
  {
    re: /^ver\s+(logo|header|footer|background|image|header_img|footer_img|watermark|signature)$/i,
    action: 'assets.view',
    args: (m) => {
      const raw = m[1].toLowerCase();
      const mapped = ASSET_TYPE_ALIASES[raw] || { tipo: raw, rawTipo: raw };
      return {
        tipo: mapped.tipo,
        rawTipo: mapped.rawTipo,
      };
    },
  },
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
    getTool(text);
    return { action: text, input: {} };
  } catch {
    /* no-op */
  }

  // 3) "tool key=value ..."
  const m = text.match(/^([a-z0-9._-]+)\s+(.+)$/i);
  if (m) {
    const candidate = m[1];
    try {
      getTool(candidate);
      const kv = parseKV(m[2]);
      return { action: candidate, input: kv };
    } catch {
      /* no-op */
    }
  }

  return { action: null, input: null };
}

/** Mensaje inicial por defecto */
export function initialHelpMessage() {
  return 'Estoy listo. Puedes escribir: `templates.list`, `usar <templateId>`, `faltantes`, `sugerir`, `sugerir full`, `aplicar`, `generar`, `facturar`, `emisores`, `elegir emisor <id>`, `emisor <id>`, `emisor actual`, `limpiar emisor`, `activar facturación`, `faltantes facturación`, `registrar rfc`, o `set key=valor`.';
}

export { listTools };