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
};

export function buildFacturaPayloadData({ contract, fields }) {
  const out = {};

  // 0) defaults del contrato primero
  if (isObj(contract?.defaults)) deepMerge(out, contract.defaults);

  // 1) Passthrough plano inicial (excepto items)
  if (isObj(fields)) {
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'items') out[k] = v;
    }
  }

  // 2) Mappings efectivos (DEFAULT + contract.mappings)
  const effectiveMap = { ...DEFAULT_MAP, ...(isObj(contract?.mappings) ? contract.mappings : {}) };

  // Aplica mappings no-items
  for (const [src, destPath] of Object.entries(effectiveMap)) {
    if (!isStr(destPath) || destPath.startsWith('items[]')) continue;
    if (fields?.[src] !== undefined) {
      setByPath(out, destPath, fields[src]);
    }
  }

  // 3) Items: usa DEFAULT_ITEM_MAP + contract.itemMappings
  const hasItems = Array.isArray(fields?.items);
  const effectiveItemMap = { ...DEFAULT_ITEM_MAP, ...(isObj(contract?.itemMappings) ? contract.itemMappings : {}) };

  if (hasItems) {
    const arr = [];
    for (const row of fields.items) {
      const destRow = {};
      // 3.1 map explícito
      for (const [from, toFull] of Object.entries(effectiveItemMap)) {
        if (!/^items\[\]\./.test(toFull)) continue;
        const to = toFull.replace(/^items\[\]\./, '');
        if (row?.[from] !== undefined) setByPath(destRow, to, row[from]);
      }
      // 3.2 copia cualquier campo no mapeado, sin pisar lo ya mapeado
      for (const [k, v] of Object.entries(row || {})) {
        if (!hasDestFor(effectiveItemMap, k) && getByPath(destRow, k) === undefined) {
          // si viene "description"/"price" simples, ya quedaron dentro de product.*
          destRow[k] = v;
        }
      }
      arr.push(destRow);
    }
    out.items = arr;
  }

  // 4) Normalizaciones finas para SAT/Facturapi
  // CP 5 dígitos
  const cp = getByPath(out, 'customer.address.zip');
  if (cp != null) setByPath(out, 'customer.address.zip', padZip(String(cp)));

  // forma_pago → '03'
  const pf = getByPath(out, 'payment_form');
  if (pf != null) setByPath(out, 'payment_form', padPaymentForm(String(pf)));

  // moneda → upper
  const cur = getByPath(out, 'currency');
  if (cur != null) setByPath(out, 'currency', String(cur).toUpperCase());

  // type por defecto 'I'
  if (!getByPath(out, 'type')) setByPath(out, 'type', 'I');

  return out;
}

/* ===== Helpers ===== */
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function isStr(x) { return typeof x === 'string'; }

function hasDestFor(map = {}, key) {
  return Object.values(map || {}).some(dest => isStr(dest) && (dest === `items[].${key}` || dest.startsWith(`items[].${key}.`)));
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

function padZip(zip) {
  const z = zip.replace(/\D/g, '');
  return z.padStart(5, '0').slice(-5);
}

function padPaymentForm(x) {
  const s = x.trim();
  return /^\d$/.test(s) ? `0${s}` : s;
}
