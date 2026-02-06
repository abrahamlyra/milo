// src/lyra/facturapi/payloadBuilder.js

// Mapeo por defecto (ES → Facturapi). El contract puede sobrescribir.
const DEFAULT_MAP = {
  receptor_razon: 'customer.legal_name',
  receptor_rfc: 'customer.tax_id',
  receptor_regimen: 'customer.tax_system',
  receptor_email: 'customer.email',
  receptor_cp: 'customer.address.zip',
  uso_cfdi: 'use',
  forma_pago: 'payment_form',
  metodo_pago: 'payment_method',
  moneda: 'currency',
  tipo: 'type',
  tipo_comprobante: 'type',
};

const DEFAULT_ITEM_MAP = {
  quantity: 'items[].quantity',
  description: 'items[].product.description',
  price: 'items[].product.price',
  product_key: 'items[].product.product_key',
  unit_key: 'items[].product.unit_key',

  // ✅ NUEVO (quirúrgico): campos que estaban rompiendo por venir al nivel equivocado
  unit_name: 'items[].product.unit_name',
  taxability: 'items[].product.taxability',
  tax_included: 'items[].product.tax_included',

  // aliases comunes desde CLI / UI legacy
  tax_object: 'items[].product.taxability',
  objeto_imp: 'items[].product.taxability',
};

export function buildFacturaPayloadData({ contract, fields }) {
  const out = {};

  // 0) defaults del contrato primero
  if (isObj(contract?.defaults)) deepMerge(out, contract.defaults);

  // 1) Mappings efectivos (DEFAULT + contract.mappings)
  const effectiveMap = { ...DEFAULT_MAP, ...(isObj(contract?.mappings) ? contract.mappings : {}) };

  // 2) Passthrough plano inicial (EXCLUYE items y claves que ya están mapeadas)
  if (isObj(fields)) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'items') continue;
      if (effectiveMap[k]) continue; // si tiene destino mapeado, no lo pases plano
      out[k] = v;
    }
  }

  // 3) Aplica mappings no-items
  for (const [src, destPath] of Object.entries(effectiveMap)) {
    if (!isStr(destPath) || destPath.startsWith('items[]')) continue;
    if (fields?.[src] !== undefined) {
      setByPath(out, destPath, fields[src]);
    }
  }

  // 3.1 Fallbacks críticos (por si no entraron por mapping)
  // payment_form: intenta varias fuentes
  if (getByPath(out, 'payment_form') == null) {
    const fallbackPF =
      fields?.payment_form ??
      getByPath(contract?.defaults, 'payment_form') ??
      fields?.forma_pago ??
      getByPath(out, 'forma_pago'); // por si sobrevivió del passthrough en algún flujo
    if (fallbackPF != null) setByPath(out, 'payment_form', fallbackPF);
  }

  // payment_method (por simetría; opcional)
  if (getByPath(out, 'payment_method') == null) {
    const fallbackPM =
      fields?.payment_method ??
      getByPath(contract?.defaults, 'payment_method') ??
      fields?.metodo_pago ??
      getByPath(out, 'metodo_pago');
    if (fallbackPM != null) setByPath(out, 'payment_method', fallbackPM);
  }

  // currency (por simetría)
  if (getByPath(out, 'currency') == null) {
    const fallbackCUR =
      fields?.currency ??
      getByPath(contract?.defaults, 'currency') ??
      fields?.moneda ??
      getByPath(out, 'moneda');
    if (fallbackCUR != null) setByPath(out, 'currency', fallbackCUR);
  }

  // 4) Items: usa DEFAULT_ITEM_MAP + contract.itemMappings
  const hasItems = Array.isArray(fields?.items);
  const effectiveItemMap = { ...DEFAULT_ITEM_MAP, ...(isObj(contract?.itemMappings) ? contract.itemMappings : {}) };

  if (hasItems) {
    const arr = [];

    for (const rawRow of fields.items) {
      // ✅ NUEVO (quirúrgico): rehidrata keys tipo "taxes[0].rate" a arrays reales
      const row = normalizeRowBracketKeys(rawRow);

      const destRow = {};

      // 4.0 si el usuario ya mandó product completo/anidado, respétalo
      if (isObj(row?.product)) destRow.product = deepClone(row.product);

      // 4.1 map explícito (no pisar si ya venía del usuario en product.*)
      for (const [from, toFull] of Object.entries(effectiveItemMap)) {
        if (!/^items\[\]\./.test(toFull)) continue;
        const to = toFull.replace(/^items\[\]\./, '');
        if (row?.[from] !== undefined && getByPath(destRow, to) === undefined) {
          setByPath(destRow, to, row[from]);
        }
      }

      // 4.2 copia cualquier campo no mapeado, sin pisar lo ya mapeado
      // ✅ CAMBIO: NO dejar pasar campos “problemáticos” al nivel raíz de item
      const ITEM_ROOT_BLOCKLIST = new Set([
        'unit_name',
        'tax_object',
        'taxability',
        'tax_included',
        'objeto_imp',
        'taxes', // taxes debe vivir en product.taxes
      ]);

      for (const [k, v] of Object.entries(row || {})) {
        if (ITEM_ROOT_BLOCKLIST.has(k)) continue;

        // si existe un destino mapeado (incluye product.*), NO lo dupliques al nivel raíz
        if (hasDestFor(effectiveItemMap, k)) continue;
        if (getByPath(destRow, k) === undefined) destRow[k] = v;
      }

      // 4.3 limpieza de seguridad: jamás mandar estos campos planos
      delete destRow.description;
      delete destRow.price;
      delete destRow.product_key;
      delete destRow.unit_key;

      // ✅ NUEVO (quirúrgico): Normaliza impuestos desde row.taxes (si existía) hacia product.taxes
      // - Soporta formatos de CLI legacy:
      //   taxes[i].tax = 002|001|003
      //   taxes[i].type = transferred|withheld
      //   taxes[i].rate = 0.16
      // - Y también formato moderno:
      //   taxes[i] = { type: 'IVA'|'ISR'|'IEPS', rate, withholding? }
      applyLegacyTaxesIntoProduct(destRow, row);

      // ✅ NUEVO (quirúrgico): Normaliza ObjetoImp
      // Acepta tax_object / taxability en row (aunque venga numérico)
      const taxObj = row?.taxability ?? row?.tax_object ?? row?.objeto_imp;
      if (taxObj != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.taxability = padTaxability(taxObj);
      }

      // ✅ NUEVO: unit_name al lugar correcto (product.unit_name)
      if (row?.unit_name != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.unit_name = String(row.unit_name);
      }

      // ✅ NUEVO: tax_included al lugar correcto
      if (row?.tax_included != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.tax_included = normalizeBool(row.tax_included);
      }

      arr.push(destRow);
    }

    out.items = arr;
  }

  // 5) Normalizaciones finas para SAT/Facturapi
  // CP 5 dígitos
  const cp = getByPath(out, 'customer.address.zip');
  if (cp != null) setByPath(out, 'customer.address.zip', padZip(String(cp)));

  // moneda → upper
  const cur = getByPath(out, 'currency');
  if (cur != null) setByPath(out, 'currency', String(cur).toUpperCase());

  // Mayúsculas para payment_method (consistencia)
  const pm = getByPath(out, 'payment_method');
  if (pm != null) setByPath(out, 'payment_method', String(pm).toUpperCase());

  // type por defecto 'I'
  if (!getByPath(out, 'type')) setByPath(out, 'type', 'I');

  // 6) Limpieza final: asegurar que no haya claves ES duplicadas en top-level
  for (const esKey of Object.keys(effectiveMap)) {
    if (!String(effectiveMap[esKey]).startsWith('items[]')) {
      if (esKey in out) delete out[esKey];
    }
  }

  // 6.1) ENFORCER CRÍTICO: payment_form NUNCA debe faltar
  (function enforcePaymentForm() {
    const already = getByPath(out, 'payment_form');
    if (already != null && already !== '') {
      // Normaliza por si llegó '3' → '03'
      setByPath(out, 'payment_form', padPaymentForm(String(already)));
      return;
    }

    // Orígenes válidos en orden de prioridad
    const pf = coalesce(
      fields?.payment_form, // si el usuario lo puso directo
      getByPath(contract?.defaults, 'payment_form'), // defaults del contrato
      fields?.forma_pago, // alias ES
      getByPath(out, 'forma_pago') // si sobrevivió del passthrough
    );

    if (pf != null && pf !== '') {
      setByPath(out, 'payment_form', padPaymentForm(String(pf)));
    }
  })();

  /* ============================================
   * 🔥 NORMALIZACIÓN CRÍTICA PARA FACTURAPI 🔥
   * ============================================ */

  // helper para quitar acentos y mandar a upper
  const normalizeUpper = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // quita acentos
      .toUpperCase()
      .replace(/[^A-Z0-9 .,@#\-]/g, ''); // limpia caracteres invalidos SAT
  };

  // helper número
  const normalizeNumber = (v) => {
    const n = Number(v);
    return isNaN(n) ? v : n;
  };

  // 1) CUSTOMER (receptor)
  const legal = getByPath(out, 'customer.legal_name');
  if (legal) setByPath(out, 'customer.legal_name', normalizeUpper(legal));

  const taxId = getByPath(out, 'customer.tax_id');
  if (taxId) setByPath(out, 'customer.tax_id', normalizeUpper(taxId));

  const email = getByPath(out, 'customer.email');
  if (email) setByPath(out, 'customer.email', String(email).toLowerCase());

  // 2) Items
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => {
      // qty
      if (item.quantity != null) item.quantity = normalizeNumber(item.quantity);

      // description
      const desc = getByPath(item, 'product.description');
      if (desc) setByPath(item, 'product.description', normalizeUpper(desc));

      // product_key
      const key = getByPath(item, 'product.product_key');
      if (key) setByPath(item, 'product.product_key', normalizeUpper(key));

      // unit_key
      const unit = getByPath(item, 'product.unit_key');
      if (unit) setByPath(item, 'product.unit_key', normalizeUpper(unit));

      // unit_name (no upper agresivo; solo string)
      const uname = getByPath(item, 'product.unit_name');
      if (uname != null) setByPath(item, 'product.unit_name', String(uname));

      // taxability debe ser "01".."08" como string (ObjetoImp)
      const taxability = getByPath(item, 'product.taxability');
      if (taxability != null) setByPath(item, 'product.taxability', padTaxability(taxability));

      // tax_included boolean
      const ti = getByPath(item, 'product.tax_included');
      if (ti != null) setByPath(item, 'product.tax_included', normalizeBool(ti));

      // price
      const price = getByPath(item, 'product.price');
      if (price != null) setByPath(item, 'product.price', normalizeNumber(price));

      // taxes: asegurar números
      const taxes = getByPath(item, 'product.taxes');
      if (Array.isArray(taxes)) {
        setByPath(
          item,
          'product.taxes',
          taxes
            .map((t) => {
              const tt = isObj(t) ? { ...t } : null;
              if (!tt) return null;

              if (tt.rate != null) tt.rate = normalizeNumber(tt.rate);
              if (tt.withholding != null) tt.withholding = normalizeBool(tt.withholding);

              // type en upper (IVA/ISR/IEPS)
              if (tt.type != null) tt.type = normalizeUpper(String(tt.type));

              // elimina ruido legacy si quedó
              delete tt.factor;
              delete tt.tax;

              return tt;
            })
            .filter(Boolean)
        );
      }

      return item;
    });
  }

  // 3) Campos CFDI altos
  const pf = getByPath(out, 'payment_form');
  if (pf) setByPath(out, 'payment_form', padPaymentForm(String(pf)));

  const pm2 = getByPath(out, 'payment_method');
  if (pm2) setByPath(out, 'payment_method', normalizeUpper(String(pm2)));

  const uso = getByPath(out, 'use');
  if (uso) setByPath(out, 'use', normalizeUpper(String(uso)));

  const cur2 = getByPath(out, 'currency');
  if (cur2) setByPath(out, 'currency', normalizeUpper(String(cur2)));

  // tipo
  const tipo = getByPath(out, 'type');
  if (tipo) setByPath(out, 'type', normalizeUpper(String(tipo)));

  return out;
}

/* ===== Helpers ===== */
function isObj(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}
function isStr(x) {
  return typeof x === 'string';
}

function hasDestFor(map = {}, key) {
  // detecta tanto items[].key como items[].algo.key (anidado: p.ej. product.description)
  return Object.values(map || {}).some((dest) => isStr(dest) && dest.startsWith('items[].') && (dest === `items[].${key}` || dest.endsWith(`.${key}`)));
}

function getByPath(obj, path) {
  if (!isStr(path) || !path) return undefined;
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

function setByPath(obj, path, value) {
  if (!isStr(path) || !path) return obj;
  const parts = path.split('.');
  let ref = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const last = i === parts.length - 1;
    if (last) {
      ref[p] = value;
    } else {
      if (!isObj(ref[p])) ref[p] = {};
      ref = ref[p];
    }
  }
  return obj;
}

function deepMerge(target, src) {
  if (!isObj(src)) return target;
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v)) {
      if (!isObj(target[k])) target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function deepClone(x) {
  return isObj(x) ? JSON.parse(JSON.stringify(x)) : x;
}

function padZip(zip) {
  const z = zip.replace(/\D/g, '');
  return z.padStart(5, '0').slice(-5);
}

function padPaymentForm(x) {
  const s = String(x).trim();
  return /^\d$/.test(s) ? `0${s}` : s;
}

function coalesce(...xs) {
  for (const x of xs) if (x !== undefined && x !== null && x !== '') return x;
  return undefined;
}

function normalizeBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  return Boolean(v);
}

function padTaxability(v) {
  // Facturapi usa strings "01".."08" (ObjetoImp)
  const s = String(v).trim();
  // si viene "2" -> "02"
  if (/^\d$/.test(s)) return `0${s}`;
  // si viene 02 ya ok
  if (/^\d{2}$/.test(s)) return s;
  // si viene "02" como number 2 -> arriba ya lo hizo
  return s;
}

function normalizeRowBracketKeys(raw) {
  // Convierte keys tipo:
  //  - "taxes[0].rate" -> row.taxes[0].rate
  //  - "taxes[1].tax"  -> row.taxes[1].tax
  // Mantiene lo demás igual.
  const row = isObj(raw) ? { ...raw } : raw;
  if (!isObj(row)) return row;

  const taxes = Array.isArray(row.taxes) ? row.taxes.slice() : null;

  for (const k of Object.keys(row)) {
    const m = /^taxes\[(\d+)\]\.(.+)$/.exec(k);
    if (!m) continue;

    const idx = parseInt(m[1], 10);
    const prop = m[2];

    if (!Number.isFinite(idx) || idx < 0) continue;

    const arr = taxes || [];
    while (arr.length <= idx) arr.push({});
    if (!isObj(arr[idx])) arr[idx] = {};
    arr[idx][prop] = row[k];
    delete row[k];

    // asigna de vuelta
    row.taxes = arr;
  }

  return row;
}

function applyLegacyTaxesIntoProduct(destRow, row) {
  // Si row ya trae product.taxes (bien), no tocamos.
  // Si trae row.taxes (legacy), lo convertimos a product.taxes.
  const prod = isObj(destRow.product) ? destRow.product : {};

  if (Array.isArray(prod.taxes) && prod.taxes.length) {
    destRow.product = prod;
    return;
  }

  const legacy = Array.isArray(row?.taxes) ? row.taxes : null;
  if (!legacy || !legacy.length) {
    destRow.product = prod;
    return;
  }

  const mapTaxCodeToType = (tax) => {
    const s = String(tax ?? '').trim();
    if (s === '002' || s === '2') return 'IVA';
    if (s === '001' || s === '1') return 'ISR';
    if (s === '003' || s === '3') return 'IEPS';
    return s; // por si ya venía 'IVA'
  };

  const out = legacy
    .map((t) => {
      if (!isObj(t)) return null;

      // legacy: t.type = transferred|withheld
      const legacyKind = String(t.type || '').trim().toLowerCase();
      const withholding = t.withholding === true || legacyKind === 'withheld';

      // legacy: t.tax = 002/001/003  OR  t.type ya puede venir IVA/ISR
      const type = mapTaxCodeToType(t.tax != null ? t.tax : t.tax_code != null ? t.tax_code : t.taxType != null ? t.taxType : t.impuesto != null ? t.impuesto : t.type);

      // rate num
      const rate = t.rate != null ? Number(t.rate) : null;
      if (rate == null || Number.isNaN(rate)) return null;

      const obj = { type: String(type).toUpperCase(), rate };
      if (withholding) obj.withholding = true;
      return obj;
    })
    .filter(Boolean);

  if (out.length) {
    prod.taxes = out;
    destRow.product = prod;
  } else {
    destRow.product = prod;
  }

  // nunca mandar taxes al nivel item
  if ('taxes' in destRow) delete destRow.taxes;
}
