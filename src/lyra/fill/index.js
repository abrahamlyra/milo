// src/lyra/fill/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { normalizeRFC, normalizeRazonSocial } from '../../core/utils/normalize.js';
import { resolveEnum } from '../catalogs/resolve.js';

// 🛡️ MAPA DE REGLAS DE RELLENO (PADDING)
// Si llega un número o un string corto, lo forzamos a su longitud correcta con ceros a la izquierda.
const PADDING_RULES = {
  // ClaveProdServ del SAT siempre son 8 dígitos
  'product_key': 8,     'clave_producto': 8,
  // CP siempre son 5 dígitos
  'zip': 5,             'cp': 5,            'codigo_postal': 5,
  // Forma de pago siempre 2 dígitos
  'payment_form': 2,    'forma_pago': 2,
  // Regímenes fiscales suelen ser 3 dígitos
  'tax_system': 3,      'regimen_fiscal': 3,
  // Unidades (E48, H87) no llevan padding numérico, pero las protegemos del cast
  'unit_key': 0,        'clave_unidad': 0
};

function getCtxState(ctx) {
  const s = ctx.session || {};
  const tid = s.selectedTemplateId;
  if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

  // Tolera ambos layouts
  const contract = s.contracts?.[tid] ?? s.contract ?? null;
  if (!contract) throw new Error('Contract no cargado para esta plantilla.');

  const provided =
    (s.provided && s.provided[tid]) ? s.provided[tid]
    : (s.provided && !Array.isArray(s.provided) && typeof s.provided === 'object' && !s.provided[tid]) ? s.provided
    : {};

  return { tid, s, contract, provided };
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
        items.length > 0 && items.some((row) => row && row[k] !== undefined && row[k] !== '');
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
  // OJO: Si normalizeRazonSocial es muy agresivo, podría estar quitando apellidos.
  // Por seguridad, si el valor ya viene con espacios, confiamos en él.
  if (key === 'receptor_razon') {
    if (value && value.includes(' ')) return value.toUpperCase(); 
    return normalizeRazonSocial(value);
  }
  return value;
}

// ===== Helpers de entrega =====
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
 * Aplica reglas de padding para recuperar ceros perdidos.
 * Ej: entrada 1010101 (number) -> salida "01010101" (string)
 */
function enforcePadding(key, val) {
  // Limpia la llave de items[]. para buscar en las reglas
  const cleanKey = key.replace(/^items\[\d*\]\./, '').replace(/^items\[\]\./, '');
  
  // Si no hay regla para esta llave, devuelve el valor tal cual (casteado si es necesario)
  if (!Object.prototype.hasOwnProperty.call(PADDING_RULES, cleanKey)) {
    return val;
  }

  const targetLen = PADDING_RULES[cleanKey];
  let strVal = String(val ?? '');

  // Caso especial: Si es unit_key (E48) no rellenamos con ceros, solo aseguramos string
  if (targetLen === 0) return strVal;

  // Relleno mágico
  return strVal.trim().padStart(targetLen, '0');
}

function parseRawKV(raw) {
  const out = {};
  // MEJORA DE REGEX: Intenta capturar valores sin comillas hasta encontrar el siguiente "key="
  // Grupo 1: key
  // Grupo 2: valor comillas dobles
  // Grupo 3: valor comillas simples
  // Grupo 4: valor sin comillas (consume hasta ver un espacio seguido de algo= o el final)
  const re = /([\w.\[\]]+)=(?:"([^"]*)"|'([^']*)'|((?:(?!\s+[\w.\[\]]+=).)*))/g;
  
  let r;
  while ((r = re.exec(raw)) !== null) {
    const key = r[1];
    // Prioridad: comillas dobles > simples > sin comillas
    const rawVal = r[2] ?? r[3] ?? r[4]; 

    if (rawVal === undefined) continue;

    // Limpiamos espacios extra si venía sin comillas
    const valTrimmed = rawVal.trim();

    // 1. Aplicar Padding si es clave SAT
    const padded = enforcePadding(key, valTrimmed);

    // 2. Si fue modificado por padding, úsalo. Si no, intenta cast numérico/booleano
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
          
          // Sugerencia inteligente para claves SAT
          if (Object.prototype.hasOwnProperty.call(PADDING_RULES, k)) {
            // Ejemplo genérico con ceros correctos
            if (k.includes('product')) payload.items[0][k] = '01010101';
            else if (k.includes('unit')) payload.items[0][k] = 'E48';
            else payload.items[0][k] = '00';
            return;
          }

          const kind = (f?.type || (/price|importe|monto|cantidad|qty|quantity/i.test(k) ? 'number' : 'string')).toLowerCase();
          payload.items[0][k] =
            (kind === 'number' || kind === 'money') ? 1
            : /description|concepto|desc/i.test(k) ? 'Servicio'
            : 'Valor';
          return;
        }

        // ... resto de lógica suggest ...
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
        if (t === 'rfc')   { payload[key] = 'XAXX010101000'; return; }
        if (t === 'date')  { payload[key] = new Date().toISOString().slice(0,10); return; }
        if (t === 'number'){ payload[key] = 1; return; }
        
        const k = key.toLowerCase();
        if (/razon|nombre/.test(k)) { payload[key] = 'ACME S.A. DE C.V.'; return; }
        payload[key] = 'Valor';
      };

      const take = (mode === 'full') ? fields : fields.filter(f => f?.required);
      for (const f of take) propose(f);
      if (Object.keys(payload).length === 0) {
        for (const f of fields.filter(x => x?.required)) propose(f);
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
    SET (Corregido para Names con espacios y Ceros perdidos)
  ========================= */
  registerTool('fill.set', async () => {
    const ctx = contextFactory();
    return async (input = {}) => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const kv = {};

      for (const [k, v] of Object.entries(input || {})) {
        if (k !== '__raw') {
          // APLICAR RELLENO INCLUSO SI VIENE DIRECTO DEL NLU (JSON)
          // Esto recupera el "01010101" si el NLU mandó el número 1010101
          kv[k] = enforcePadding(k, v);
          continue;
        }
        
        if (typeof v === 'string') {
          // Usamos la nueva regex más inteligente dentro de parseRawKV
          const parsed = parseRawKV(v);
          Object.assign(kv, parsed);
        }
      }

      const target = { ...provided };

      for (const [key, val] of Object.entries(kv)) {
        // Normaliza (Nombre, RFC)
        const cleanKey = key.replace(/^items\[(\d+)\]\./, '').replace(/^items\[\]\./, '');
        const normalized = applyNormalizers(cleanKey, val);

        // Caso A: items[<idx>].campo
        const mIndexed = key.match(/^items\[(\d+)\]\.(.+)$/);
        if (mIndexed) {
          const idx = Number(mIndexed[1]);
          const k   = mIndexed[2];
          target.items = Array.isArray(target.items) ? target.items : [];
          while (target.items.length <= idx) target.items.push({});
          target.items[idx] = { ...(target.items[idx] || {}), [k]: normalized };
          continue;
        }

        // Caso B: items[].campo
        if (key.startsWith('items[].')) {
          const k = key.replace('items[].', '');
          target.items = Array.isArray(target.items) ? target.items : [];
          target.items[0] = target.items[0] || {};
          target.items[0][k] = normalized;
          continue;
        }

        // Caso C: planos
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