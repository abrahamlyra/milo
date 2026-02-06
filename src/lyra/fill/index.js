// src/lyra/fill/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { normalizeRFC, normalizeRazonSocial } from '../../core/utils/normalize.js';
import { resolveEnum } from '../catalogs/resolve.js';

// 🛡️ PADDING RULES
// If an input arrives as number or short string, enforce left-zero padding to expected length.
const PADDING_RULES = {
  // SAT product key is always 8 digits
  product_key: 8,
  clave_producto: 8,

  // ZIP/CP always 5 digits
  zip: 5,
  cp: 5,
  codigo_postal: 5,

  // Payment form always 2 digits
  payment_form: 2,
  forma_pago: 2,

  // Tax system usually 3 digits
  tax_system: 3,
  regimen_fiscal: 3,

  // ObjetoImp / taxability is typically 2 digits (01/02/03...)
  taxability: 2,
  tax_object: 2,
  objeto_imp: 2,

  // Unit keys (E48, H87) must stay as string (no numeric padding)
  unit_key: 0,
  clave_unidad: 0,
};

function getCtxState(ctx) {
  const s = ctx.session || {};
  const tid = s.selectedTemplateId;
  if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

  // tolerate both layouts
  const contract = s.contracts?.[tid] ?? s.contract ?? null;
  if (!contract) throw new Error('Contract no cargado para esta plantilla.');

  const provided =
    s.provided && s.provided[tid]
      ? s.provided[tid]
      : s.provided && !Array.isArray(s.provided) && typeof s.provided === 'object' && !s.provided[tid]
        ? s.provided
        : {};

  return { tid, s, contract, provided };
}

/**
 * Mixed getter:
 * supports:
 *  - "product.description"
 *  - "product.taxes[0].withholding"
 */
function getByPathWithBrackets(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (!path || typeof path !== 'string') return undefined;

  const tokens = tokenizePath(path);
  if (!tokens.length) return undefined;

  let ref = obj;
  for (const t of tokens) {
    if (t.type === 'prop') {
      if (!ref || typeof ref !== 'object') return undefined;
      ref = ref[t.key];
    } else if (t.type === 'index') {
      if (!Array.isArray(ref)) return undefined;
      ref = ref[t.idx];
    }
  }
  return ref;
}

/**
 * Mixed setter:
 * supports:
 *  - "product.description"
 *  - "product.taxes[0].withholding"
 */
function setByPathWithBrackets(obj, path, value) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!path || typeof path !== 'string') return obj;

  const tokens = tokenizePath(path);
  if (!tokens.length) return obj;

  let ref = obj;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const last = i === tokens.length - 1;

    if (t.type === 'prop') {
      if (last) {
        ref[t.key] = value;
        return obj;
      }

      const next = tokens[i + 1];
      if (next && next.type === 'index') {
        if (!Array.isArray(ref[t.key])) ref[t.key] = [];
      } else {
        if (!ref[t.key] || typeof ref[t.key] !== 'object' || Array.isArray(ref[t.key])) ref[t.key] = {};
      }
      ref = ref[t.key];
    } else if (t.type === 'index') {
      if (!Array.isArray(ref)) {
        // cannot index into a non-array, abort safely
        return obj;
      }
      while (ref.length <= t.idx) ref.push(undefined);

      if (last) {
        ref[t.idx] = value;
        return obj;
      }

      if (!ref[t.idx] || typeof ref[t.idx] !== 'object' || Array.isArray(ref[t.idx])) ref[t.idx] = {};
      ref = ref[t.idx];
    }
  }

  return obj;
}

function tokenizePath(path) {
  // "product.taxes[1].withholding" =>
  // [{prop:'product'},{prop:'taxes'},{index:1},{prop:'withholding'}]
  const out = [];
  const re = /([^. \[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path))) {
    if (m[1]) out.push({ type: 'prop', key: m[1] });
    else out.push({ type: 'index', idx: parseInt(m[2], 10) });
  }
  return out.filter((t) => (t.type === 'prop' ? !!t.key : Number.isFinite(t.idx)));
}

function computeMissing(contract, provided) {
  const missing = [];
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];

  for (const f of fields) {
    if (!f.required) continue;

    if (f.key?.startsWith?.('items[].')) {
      const k = f.key.replace('items[].', '');
      const items = Array.isArray(provided.items) ? provided.items : [];

      const hasAtLeastOne =
        items.length > 0 &&
        items.some((row) => {
          if (!row || typeof row !== 'object') return false;
          const v = (k.includes('.') || k.includes('[')) ? getByPathWithBrackets(row, k) : row[k];
          return v !== undefined && v !== null && v !== '';
        });

      if (!hasAtLeastOne) missing.push(f.key);
      continue;
    }

    const v = provided[f.key];
    if (v === undefined || v === null || v === '') {
      missing.push(f.key);
    }
  }

  return missing;
}

function applyNormalizers(key, value) {
  if (key === 'receptor_rfc') return normalizeRFC(value);

  // If normalizeRazonSocial is too aggressive, keep spacing name as-is and only uppercase
  if (key === 'receptor_razon') {
    if (value && value.includes(' ')) return String(value).toUpperCase();
    return normalizeRazonSocial(value);
  }

  return value;
}

// ===== Delivery helpers =====
const DELIVERY_MODES = new Set(['none', 'email', 'sms', 'both']);

function coerceMode(val) {
  if (!val) return 'none';
  const t = String(val).trim().toLowerCase();
  if (DELIVERY_MODES.has(t)) return t;
  if (t === 'correo') return 'email';
  if (t === 'ambos') return 'both';
  return 'none';
}

function setDeep(target, dottedKey, value) {
  if (!dottedKey || typeof dottedKey !== 'string') return;
  const parts = dottedKey.split('.');
  let ref = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (ref[p] == null || typeof ref[p] !== 'object') ref[p] = {};
    ref = ref[p];
  }
  ref[parts[parts.length - 1]] = value;
}

/**
 * Apply padding rules to recover lost zeros.
 * Example: 1010101 -> "01010101"
 */
function enforcePadding(key, val) {
  const rawKey = String(key || '');

  // remove items[] / items[idx] prefix
  let cleanKey = rawKey.replace(/^items\[\d*\]\./, '').replace(/^items\[\]\./, '');

  // if key is nested like "product.product_key", rule targets last segment
  if (cleanKey.includes('.')) cleanKey = cleanKey.split('.').pop();

  if (!Object.prototype.hasOwnProperty.call(PADDING_RULES, cleanKey)) return val;

  const targetLen = PADDING_RULES[cleanKey];
  const strVal = String(val ?? '');

  // "unit_key" etc: keep string only
  if (targetLen === 0) return strVal;

  return strVal.trim().padStart(targetLen, '0');
}

function parseRawKV(raw) {
  const out = {};
  // Capture: key="value" | key='value' | key=value (until next key=)
  const re = /([\w.\[\]]+)=(?:"([^"]*)"|'([^']*)'|((?:(?!\s+[\w.\[\]]+=).)*))/g;

  let r;
  while ((r = re.exec(raw)) !== null) {
    const key = r[1];
    const rawVal = r[2] ?? r[3] ?? r[4];
    if (rawVal === undefined) continue;

    const valTrimmed = rawVal.trim();

    // 1) Padding first
    const padded = enforcePadding(key, valTrimmed);

    // 2) If padding changed, keep as string; else attempt cast
    if (padded !== valTrimmed) {
      out[key] = padded;
    } else {
      const cast =
        /^[0-9]+(\.[0-9]+)?$/.test(padded) ? Number(padded)
          : /^(true|false)$/i.test(padded) ? /^true$/i.test(padded)
            : padded;
      out[key] = cast;
    }
  }

  return out;
}

export function registerFillTools(contextFactory) {
  registerTool('fill.missing', async () => {
    const ctx = contextFactory();
    return async () => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const missing = computeMissing(contract, provided);
      s.missing = s.missing || {};
      s.missing[tid] = missing;
      return { templateId: tid, missing };
    };
  });

  registerTool('fill.suggest', async (injectedFactory) => {
    const cf = injectedFactory || contextFactory;
    return async ({ mode = 'min' } = {}) => {
      const ctx = cf();
      const { tid, s, contract, provided } = getCtxState(ctx);
      const fields = Array.isArray(contract?.fields) ? contract.fields : [];
      const catalogs = contract?.catalogs || {};
      const payload = {};

      const propose = (f) => {
        const key = f?.key || f?.name || f?.id;
        if (!key) return;
        const current = provided[key];
        if (current !== undefined && current !== null && current !== '') return;

        if (key.startsWith('items[].')) {
          const k = key.replace('items[].', '');
          payload.items = payload.items || [{}];

          // Smart suggestion for SAT keys
          const leaf = k.includes('.') ? k.split('.').pop() : k;
          if (Object.prototype.hasOwnProperty.call(PADDING_RULES, leaf)) {
            if (leaf.includes('product')) payload.items[0][leaf] = '01010101';
            else if (leaf.includes('unit')) payload.items[0][leaf] = 'E48';
            else if (leaf.includes('taxability') || leaf.includes('objeto')) payload.items[0][leaf] = '02';
            else payload.items[0][leaf] = '00';
            return;
          }

          const kind = String(
            f?.type || (/price|importe|monto|cantidad|qty|quantity/i.test(k) ? 'number' : 'string')
          ).toLowerCase();

          payload.items[0][k] =
            (kind === 'number' || kind === 'money') ? 1
              : /description|concepto|desc/i.test(k) ? 'Servicio'
                : 'Valor';
          return;
        }

        if ((f?.type === 'enum' || f?.optionsRef) && f?.optionsRef) {
          const enumHit = resolveEnum(catalogs, f.optionsRef, null);
          if (enumHit != null) {
            payload[key] = typeof enumHit === 'object' ? (enumHit.code ?? enumHit.value) : enumHit;
            return;
          }
        }

        if (f?.default !== undefined) { payload[key] = f.default; return; }

        const t = String(f?.type || '').toLowerCase();
        if (t === 'email') { payload[key] = 'cliente@dominio.com'; return; }
        if (t === 'rfc') { payload[key] = 'XAXX010101000'; return; }
        if (t === 'date') { payload[key] = new Date().toISOString().slice(0, 10); return; }
        if (t === 'number') { payload[key] = 1; return; }

        const k = key.toLowerCase();
        if (/razon|nombre/.test(k)) { payload[key] = 'ACME S.A. DE C.V.'; return; }
        payload[key] = 'Valor';
      };

      const take = (mode === 'full') ? fields : fields.filter((f) => f?.required);
      for (const f of take) propose(f);
      if (Object.keys(payload).length === 0) {
        for (const f of fields.filter((x) => x?.required)) propose(f);
      }

      s.lastSuggestion = s.lastSuggestion || {};
      s.lastSuggestion[tid] = { mode, suggestion: payload };
      return { templateId: tid, mode, payload };
    };
  });

  registerTool('fill.apply', async () => {
    const ctx = contextFactory();
    return async () => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const incoming = s.lastSuggestion?.[tid]?.suggestion || {};
      const target = { ...provided };

      for (const [k, v] of Object.entries(incoming)) {
        if (k === 'items' && Array.isArray(v)) {
          const cur = Array.isArray(target.items) ? target.items : [];
          target.items = cur.length ? cur : [];
          if (target.items.length === 0 && v.length > 0) {
            target.items.push({ ...v[0] });
          }
        } else {
          target[k] = v;
        }
      }

      for (const [k, v] of Object.entries(target)) {
        if (k === 'items') continue;
        target[k] = applyNormalizers(k, v);
      }

      if (Array.isArray(target.items)) {
        target.items = target.items.map((row) => {
          const out = { ...(row || {}) };
          for (const [k, v] of Object.entries(out)) out[k] = applyNormalizers(k, v);
          return out;
        });
      }

      s.provided = s.provided || {};
      s.provided[tid] = target;
      const missing = computeMissing(contract, target);
      return { templateId: tid, applied: true, merged: target, missing };
    };
  });

  /* =========================
    SET (fixed to support:
      - values with spaces in __raw
      - recovered zeros
      - nested item paths (dots/brackets)
  ========================= */
  registerTool('fill.set', async () => {
    const ctx = contextFactory();
    return async (input = {}) => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const kv = {};

      for (const [k, v] of Object.entries(input || {})) {
        if (k !== '__raw') {
          kv[k] = enforcePadding(k, v);
          continue;
        }

        if (typeof v === 'string') {
          const parsed = parseRawKV(v);
          Object.assign(kv, parsed);
        }
      }

      const target = { ...provided };

      for (const [key, val] of Object.entries(kv)) {
        // normalizers are only for top-level known keys (RFC/razon)
        // for nested item keys we keep it as-is unless it's a known top-level field.
        const cleanKey = key.replace(/^items\[(\d+)\]\./, '').replace(/^items\[\]\./, '');
        const normalized = applyNormalizers(cleanKey, val);

        // Case A: items[<idx>].<path>
        const mIndexed = key.match(/^items\[(\d+)\]\.(.+)$/);
        if (mIndexed) {
          const idx = Number(mIndexed[1]);
          const path = mIndexed[2];

          target.items = Array.isArray(target.items) ? target.items : [];
          while (target.items.length <= idx) target.items.push({});
          target.items[idx] = target.items[idx] || {};

          if (path.includes('.') || path.includes('[')) {
            setByPathWithBrackets(target.items[idx], path, normalized);
          } else {
            target.items[idx][path] = normalized;
          }
          continue;
        }

        // Case B: items[].<path> (default idx 0)
        if (key.startsWith('items[].')) {
          const path = key.replace('items[].', '');

          target.items = Array.isArray(target.items) ? target.items : [];
          target.items[0] = target.items[0] || {};

          if (path.includes('.') || path.includes('[')) {
            setByPathWithBrackets(target.items[0], path, normalized);
          } else {
            target.items[0][path] = normalized;
          }
          continue;
        }

        // Case C: plain top-level fields
        target[key] = normalized;
      }

      s.provided = s.provided || {};
      s.provided[tid] = target;
      const missing = computeMissing(contract, target);
      return { templateId: tid, provided: target, missing };
    };
  });

  registerTool('fill.delivery', async () => {
    const ctx = contextFactory();
    return async (input = {}) => {
      const { tid, s } = getCtxState(ctx);
      s.delivery = s.delivery || {};
      const current = s.delivery[tid] || { mode: 'none' };
      const { __raw, ...rest } = input || {};
      const flat = { ...rest };
      if (typeof __raw === 'string' && __raw.trim().length) {
        Object.assign(flat, parseRawKV(__raw));
      }
      const next = {
        mode: current.mode || 'none',
        email: { ...(current.email || {}) },
        sms: { ...(current.sms || {}) },
      };
      if (flat.mode !== undefined) next.mode = coerceMode(flat.mode);
      if (flat.email && typeof flat.email === 'object') next.email = { ...next.email, ...flat.email };
      if (flat.sms && typeof flat.sms === 'object') next.sms = { ...next.sms, ...flat.sms };
      for (const [k, v] of Object.entries(flat)) {
        if (k === 'mode' || k === 'email' || k === 'sms') continue;
        if (typeof k === 'string' && k.includes('.')) setDeep(next, k, v);
      }
      s.delivery[tid] = next;
      return { templateId: tid, delivery: next };
    };
  });

  registerTool('fill.delivery.get', async () => {
    const ctx = contextFactory();
    return async () => {
      const { tid, s } = getCtxState(ctx);
      const delivery = s.delivery?.[tid] || { mode: 'none' };
      return { templateId: tid, delivery };
    };
  });

  registerTool('fill.delivery.reset', async () => {
    const ctx = contextFactory();
    return async () => {
      const { tid, s } = getCtxState(ctx);
      if (s.delivery && s.delivery[tid]) delete s.delivery[tid];
      return { templateId: tid, delivery: { mode: 'none' } };
    };
  });
}
