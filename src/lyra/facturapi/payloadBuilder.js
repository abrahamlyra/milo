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

// ✅ NUEVO (quirúrgico): campos NO permitidos por Facturapi en items/product
const BLOCKED_ITEM_KEYS = new Set([
  // errores que ya viste
  'unit_name',
  'tax_object',
]);

// ✅ NUEVO (quirúrgico): keys “raras” que llegan como literales (ej. "taxes[0].rate")
const isBracketKey = (k) => /^\w+\[\d+\]\./.test(String(k || ''));

// ✅ NUEVO (quirúrgico): borra unit_name/tax_object + cualquier "taxes[0].x" literal
function sanitizeItemForFacturapi(destRow) {
  if (!isObj(destRow)) return destRow;

  // 1) root-level
  for (const k of Object.keys(destRow)) {
    if (BLOCKED_ITEM_KEYS.has(k)) delete destRow[k];
    if (isBracketKey(k)) delete destRow[k]; // taxes[0].type, etc (llegan mal del "set")
  }

  // 2) product-level
  if (isObj(destRow.product)) {
    for (const k of Object.keys(destRow.product)) {
      if (BLOCKED_ITEM_KEYS.has(k)) delete destRow.product[k];
      if (isBracketKey(k)) delete destRow.product[k];
    }
  }

  return destRow;
}

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
    for (const row of fields.items) {
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
      // ✅ CAMBIO (quirúrgico): filtrar hard-block + no copiar keys bracket-style (taxes[0].x)
      for (const [k, v] of Object.entries(row || {})) {
        // si existe un destino mapeado (incluye product.*), NO lo dupliques al nivel raíz
        if (hasDestFor(effectiveItemMap, k)) continue;

        // hard-block a nivel root
        if (BLOCKED_ITEM_KEYS.has(k)) continue;

        // evita que se cuelen llaves literales tipo taxes[0].rate
        if (isBracketKey(k)) continue;

        if (getByPath(destRow, k) === undefined) destRow[k] = v;
      }

      // 4.3 limpieza de seguridad: jamás mandar estos campos planos
      delete destRow.description;
      delete destRow.price;
      delete destRow.product_key;
      delete destRow.unit_key;

      // ✅ NUEVO (quirúrgico): limpieza final de item/product para Facturapi
      sanitizeItemForFacturapi(destRow);

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

  // payment_method → upper (consistencia)
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
      // ✅ por seguridad, vuelve a sanitizar (por si contract.defaults metió cosas raras)
      sanitizeItemForFacturapi(item);

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

      // price
      const price = getByPath(item, 'product.price');
      if (price != null) setByPath(item, 'product.price', normalizeNumber(price));

      return item;
    });
  }

  // 3) Campos CFDI altos
  const pf = getByPath(out, 'payment_form');
  if (pf) setByPath(out, 'payment_form', padPaymentForm(pf));

  const pm2 = getByPath(out, 'payment_method');
  if (pm2) setByPath(out, 'payment_method', normalizeUpper(pm2));

  const uso = getByPath(out, 'use');
  if (uso) setByPath(out, 'use', normalizeUpper(uso));

  const cur2 = getByPath(out, 'currency');
  if (cur2) setByPath(out, 'currency', normalizeUpper(cur2));

  // tipo
  const tipo = getByPath(out, 'type');
  if (tipo) setByPath(out, 'type', normalizeUpper(tipo));

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
  return Object.values(map || {}).some(
    (dest) =>
      isStr(dest) &&
      dest.startsWith('items[].') &&
      (dest === `items[].${key}` || dest.endsWith(`.${key}`))
  );
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
  const s = String(x ?? '').trim();
  return /^\d$/.test(s) ? `0${s}` : s;
}

function coalesce(...xs) {
  for (const x of xs) if (x !== undefined && x !== null && x !== '') return x;
  return undefined;
}
