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
      if (effectiveMap[k]) continue;
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

  // 3.1 Fallbacks críticos
  if (getByPath(out, 'payment_form') == null) {
    const fallbackPF =
      fields?.payment_form ??
      getByPath(contract?.defaults, 'payment_form') ??
      fields?.forma_pago ??
      getByPath(out, 'forma_pago');
    if (fallbackPF != null) setByPath(out, 'payment_form', fallbackPF);
  }

  if (getByPath(out, 'payment_method') == null) {
    const fallbackPM =
      fields?.payment_method ??
      getByPath(contract?.defaults, 'payment_method') ??
      fields?.metodo_pago ??
      getByPath(out, 'metodo_pago');
    if (fallbackPM != null) setByPath(out, 'payment_method', fallbackPM);
  }

  if (getByPath(out, 'currency') == null) {
    const fallbackCUR =
      fields?.currency ??
      getByPath(contract?.defaults, 'currency') ??
      fields?.moneda ??
      getByPath(out, 'moneda');
    if (fallbackCUR != null) setByPath(out, 'currency', fallbackCUR);
  }

  // 4) Items
  const hasItems = Array.isArray(fields?.items);
  const effectiveItemMap = { ...DEFAULT_ITEM_MAP, ...(isObj(contract?.itemMappings) ? contract.itemMappings : {}) };

  if (hasItems) {
    const arr = [];

    for (const rawRow of fields.items) {
      // ✅ SUPER-ANTI-PENDEJOS:
      // rehidrata keys tipo:
      //  - "product.description"
      //  - "product.taxes[0].rate"
      //  - "taxes[0].rate"
      //  - "taxes[1].withholding"
      const row = normalizeFlatItemKeys(rawRow);

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
      const ITEM_ROOT_BLOCKLIST = new Set([
        'unit_name',
        'tax_object',
        'taxability',
        'tax_included',
        'objeto_imp',
        // ✅ FIX: campos internos de Lyra → se traducen abajo, jamás pasan a Facturapi
        'tax_mode',
        'withhold_isr',
        'withhold_iva',
        'ieps_enabled',
        'ieps_rate',
        'taxes', // taxes debe vivir en product.taxes
        'product', // product lo tratamos arriba
      ]);

      for (const [k, v] of Object.entries(row || {})) {
        if (ITEM_ROOT_BLOCKLIST.has(k)) continue;
        if (hasDestFor(effectiveItemMap, k)) continue;
        if (getByPath(destRow, k) === undefined) destRow[k] = v;
      }

      // 4.3 limpieza de seguridad: jamás mandar estos campos planos
      delete destRow.description;
      delete destRow.price;
      delete destRow.product_key;
      delete destRow.unit_key;

      // ✅ Taxes: soporta legacy y moderno, y asegura withholding correcto
      applyLegacyTaxesIntoProduct(destRow, row);

      // ✅ ObjetoImp
      const taxObj = row?.taxability ?? row?.tax_object ?? row?.objeto_imp ?? getByPath(row, 'product.taxability');
      if (taxObj != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.taxability = padTaxability(taxObj);
      }

      // ✅ unit_name al lugar correcto
      const unitName = row?.unit_name ?? getByPath(row, 'product.unit_name');
      if (unitName != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.unit_name = String(unitName);
      }

      // ✅ tax_included boolean explícito (cuando viene directo sin tax_mode)
      const taxIncludedExplicit = row?.tax_included ?? getByPath(row, 'product.tax_included');
      if (taxIncludedExplicit != null) {
        if (!isObj(destRow.product)) destRow.product = {};
        destRow.product.tax_included = normalizeBool(taxIncludedExplicit);
      }

      // ✅ FIX COMPLETO: campos internos Lyra → product.tax_included + product.taxes
      //
      // Lyra envía:
      //   tax_mode      : "included" | "add" | "exempt"
      //   withhold_isr  : "true" | "false"
      //   withhold_iva  : "true" | "false"
      //   ieps_enabled  : "true" | "false"
      //   ieps_rate     : "0.08"
      //
      // Facturapi espera:
      //   product.tax_included : boolean
      //   product.taxes        : [{ type, rate, withholding? }]
      //
      // NINGUNO de esos campos internos debe llegar a Facturapi — se limpian
      // en ITEM_ROOT_BLOCKLIST y se traducen aquí.
      {
        const taxMode     = row?.tax_mode     ?? getByPath(row, 'product.tax_mode');
        const withholdIsr = row?.withhold_isr ?? getByPath(row, 'product.withhold_isr');
        const withholdIva = row?.withhold_iva ?? getByPath(row, 'product.withhold_iva');
        const iepsEnabled = row?.ieps_enabled ?? getByPath(row, 'product.ieps_enabled');
        const iepsRate    = row?.ieps_rate    ?? getByPath(row, 'product.ieps_rate');

        const hasLyraTaxFields =
          taxMode != null || withholdIsr != null || withholdIva != null ||
          iepsEnabled != null || iepsRate != null;

        if (hasLyraTaxFields) {
          if (!isObj(destRow.product)) destRow.product = {};

          const tm          = taxMode    != null ? String(taxMode).trim().toLowerCase() : null;
          const doRetIsr    = withholdIsr != null ? normalizeBool(withholdIsr) : false;
          const doRetIva    = withholdIva != null ? normalizeBool(withholdIva) : false;
          const doIeps      = iepsEnabled != null ? normalizeBool(iepsEnabled) : false;
          const iepsRateNum = iepsRate    != null ? Number(iepsRate) : NaN;

          // 1) tax_included
          if (destRow.product.tax_included === undefined) {
            if (tm === 'included') destRow.product.tax_included = true;
            else if (tm === 'add' || tm === 'exempt') destRow.product.tax_included = false;
          }

          // 2) taxability para exento
          if (tm === 'exempt' && destRow.product.taxability === undefined) {
            destRow.product.taxability = '02'; // Sí objeto de impuesto, exento
          }

          // 3) Construir product.taxes solo si no vienen ya definidos
          if (!Array.isArray(destRow.product.taxes) || !destRow.product.taxes.length) {
            const taxes = [];

            // IVA traslado
            if (tm === 'add') {
              taxes.push({ type: 'IVA', rate: 0.16 });
            } else if (tm === 'exempt') {
              taxes.push({ type: 'IVA', rate: 0 });
            }
            // (si tm === 'included', tax_included=true y Facturapi no necesita entry de IVA)

            // Retención ISR  10%
            if (doRetIsr) {
              taxes.push({ type: 'ISR', rate: 0.10, withholding: true });
            }

            // Retención IVA  10.666...% (2/3 del 16%)
            if (doRetIva) {
              taxes.push({ type: 'IVA', rate: 0.106666, withholding: true });
            }

            // IEPS traslado
            if (doIeps && Number.isFinite(iepsRateNum) && iepsRateNum >= 0) {
              taxes.push({ type: 'IEPS', rate: iepsRateNum });
            }

            if (taxes.length) destRow.product.taxes = taxes;
          }

          // Nunca dejar campos internos Lyra en product (por si llegaron anidados)
          delete destRow.product.tax_mode;
          delete destRow.product.withhold_isr;
          delete destRow.product.withhold_iva;
          delete destRow.product.ieps_enabled;
          delete destRow.product.ieps_rate;
        }
      }

      arr.push(destRow);
    }

    out.items = arr;
  }

  // 5) Normalizaciones finas
  const cp = getByPath(out, 'customer.address.zip');
  if (cp != null) setByPath(out, 'customer.address.zip', padZip(String(cp)));

  const cur = getByPath(out, 'currency');
  if (cur != null) setByPath(out, 'currency', String(cur).toUpperCase());

  const pm = getByPath(out, 'payment_method');
  if (pm != null) setByPath(out, 'payment_method', String(pm).toUpperCase());

  if (!getByPath(out, 'type')) setByPath(out, 'type', 'I');

  // 6) Limpieza final: quitar claves ES duplicadas
  for (const esKey of Object.keys(effectiveMap)) {
    if (!String(effectiveMap[esKey]).startsWith('items[]')) {
      if (esKey in out) delete out[esKey];
    }
  }

  // 6.1) payment_form NUNCA debe faltar
  (function enforcePaymentForm() {
    const already = getByPath(out, 'payment_form');
    if (already != null && already !== '') {
      setByPath(out, 'payment_form', padPaymentForm(String(already)));
      return;
    }

    const pf = coalesce(
      fields?.payment_form,
      getByPath(contract?.defaults, 'payment_form'),
      fields?.forma_pago,
      getByPath(out, 'forma_pago')
    );

    if (pf != null && pf !== '') {
      setByPath(out, 'payment_form', padPaymentForm(String(pf)));
    }
  })();

  /* ============================================
   * 🔥 NORMALIZACIÓN CRÍTICA PARA FACTURAPI 🔥
   * ============================================ */

  const normalizeUpper = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9 .,@#\-]/g, '');
  };

  const normalizeNumber = (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? v : n;
  };

  // CUSTOMER
  const legal = getByPath(out, 'customer.legal_name');
  if (legal) setByPath(out, 'customer.legal_name', normalizeUpper(legal));

  const taxId = getByPath(out, 'customer.tax_id');
  if (taxId) setByPath(out, 'customer.tax_id', normalizeUpper(taxId));

  const email = getByPath(out, 'customer.email');
  if (email) setByPath(out, 'customer.email', String(email).toLowerCase());

  // Items
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => {
      if (item.quantity != null) item.quantity = normalizeNumber(item.quantity);

      const desc = getByPath(item, 'product.description');
      if (desc) setByPath(item, 'product.description', normalizeUpper(desc));

      const key = getByPath(item, 'product.product_key');
      if (key) setByPath(item, 'product.product_key', normalizeUpper(key));

      const unit = getByPath(item, 'product.unit_key');
      if (unit) setByPath(item, 'product.unit_key', normalizeUpper(unit));

      const uname = getByPath(item, 'product.unit_name');
      if (uname != null) setByPath(item, 'product.unit_name', String(uname));

      const taxability = getByPath(item, 'product.taxability');
      if (taxability != null) setByPath(item, 'product.taxability', padTaxability(taxability));

      const ti = getByPath(item, 'product.tax_included');
      if (ti != null) setByPath(item, 'product.tax_included', normalizeBool(ti));

      const price = getByPath(item, 'product.price');
      if (price != null) setByPath(item, 'product.price', normalizeNumber(price));

      // taxes
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

              if (tt.type != null) tt.type = normalizeUpper(String(tt.type));

              // limpia ruido legacy
              delete tt.factor;
              delete tt.tax;
              delete tt.tax_code;
              delete tt.taxType;
              delete tt.impuesto;

              return tt;
            })
            .filter(Boolean)
        );
      }

      return item;
    });
  }

  // CFDI altos
  const pf = getByPath(out, 'payment_form');
  if (pf) setByPath(out, 'payment_form', padPaymentForm(String(pf)));

  const pm2 = getByPath(out, 'payment_method');
  if (pm2) setByPath(out, 'payment_method', normalizeUpper(String(pm2)));

  const uso = getByPath(out, 'use');
  if (uso) setByPath(out, 'use', normalizeUpper(String(uso)));

  const cur2 = getByPath(out, 'currency');
  if (cur2) setByPath(out, 'currency', normalizeUpper(String(cur2)));

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
  return Object.values(map || {}).some(
    (dest) => isStr(dest) && dest.startsWith('items[].') && (dest === `items[].${key}` || dest.endsWith(`.${key}`))
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
  const s = String(v).trim();
  if (/^\d$/.test(s)) return `0${s}`;
  if (/^\d{2}$/.test(s)) return s;
  return s;
}

/**
 * ✅ SUPER-ANTI-PENDEJOS:
 * Convierte keys planas con dots/brackets a estructura real.
 * Ej:
 *  - "product.description" -> { product: { description } }
 *  - "product.taxes[1].withholding" -> { product: { taxes: [ , { withholding:true } ] } }
 *  - "taxes[0].rate" -> { taxes: [ { rate } ] }
 */
function normalizeFlatItemKeys(raw) {
  if (!isObj(raw)) return raw;
  const row = { ...raw };

  for (const k of Object.keys(row)) {
    if (!k) continue;
    const looksNested = k.includes('.') || k.includes('[');
    if (!looksNested) continue;

    // Solo normalizamos si es patrón razonable (evita llaves raras)
    if (!/^[a-zA-Z0-9_.\[\]]+$/.test(k)) continue;

    const value = row[k];
    setByPathWithBrackets(row, k, value);
    delete row[k];
  }

  return row;
}

/**
 * Set con soporte de arrays tipo taxes[0]
 * path admite dots y brackets.
 */
function setByPathWithBrackets(obj, path, value) {
  if (!isObj(obj) || !isStr(path) || !path) return obj;

  const tokens = tokenizePath(path);
  if (!tokens.length) return obj;

  let ref = obj;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const last = i === tokens.length - 1;

    if (t.type === 'prop') {
      if (last) {
        ref[t.key] = value;
      } else {
        const next = tokens[i + 1];
        if (next && next.type === 'index') {
          if (!Array.isArray(ref[t.key])) ref[t.key] = [];
        } else {
          if (!isObj(ref[t.key])) ref[t.key] = {};
        }
        ref = ref[t.key];
      }
    } else if (t.type === 'index') {
      if (!Array.isArray(ref)) {
        // si ref no es array, no podemos indexar: aborta sin romper todo
        return obj;
      }
      while (ref.length <= t.idx) ref.push(undefined);

      if (last) {
        ref[t.idx] = value;
      } else {
        if (!isObj(ref[t.idx])) ref[t.idx] = {};
        ref = ref[t.idx];
      }
    }
  }

  return obj;
}

function tokenizePath(path) {
  // Convierte "product.taxes[1].withholding" en:
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

function applyLegacyTaxesIntoProduct(destRow, row) {
  const prod = isObj(destRow.product) ? destRow.product : {};

  // Si ya vienen bien definidos en product.taxes, solo normaliza tipos básicos
  if (Array.isArray(prod.taxes) && prod.taxes.length) {
    prod.taxes = normalizeTaxesArray(prod.taxes);
    destRow.product = prod;
    return;
  }

  // legacy: puede venir en row.taxes o en row.product.taxes
  const legacy = Array.isArray(row?.taxes) ? row.taxes : Array.isArray(row?.product?.taxes) ? row.product.taxes : null;

  if (!legacy || !legacy.length) {
    destRow.product = prod;
    return;
  }

  const mapTaxCodeToType = (tax) => {
    const s = String(tax ?? '').trim();
    if (s === '002' || s === '2') return 'IVA';
    if (s === '001' || s === '1') return 'ISR';
    if (s === '003' || s === '3') return 'IEPS';
    return s;
  };

  const outTaxes = legacy
    .map((t) => {
      if (!isObj(t)) return null;

      const legacyKind = String(t.kind ?? t.type ?? '').trim().toLowerCase();
      const withholding = normalizeBool(t.withholding ?? (legacyKind === 'withheld'));

      // si viene tax=002/001/003 úsalo, si no, usa impuesto/taxType/type (si ya es IVA/ISR)
      const rawTax =
        t.tax != null
          ? t.tax
          : t.tax_code != null
            ? t.tax_code
            : t.taxType != null
              ? t.taxType
              : t.impuesto != null
                ? t.impuesto
                : t.tax_name != null
                  ? t.tax_name
                  : t.type;

      const type = mapTaxCodeToType(rawTax);

      const rate = t.rate != null ? Number(t.rate) : null;
      if (rate == null || Number.isNaN(rate)) return null;

      const obj = { type: String(type).toUpperCase(), rate };
      if (withholding) obj.withholding = true;

      return obj;
    })
    .filter(Boolean);

  if (outTaxes.length) {
    prod.taxes = normalizeTaxesArray(outTaxes);
    destRow.product = prod;
  } else {
    destRow.product = prod;
  }

  // nunca mandar taxes al nivel item
  if ('taxes' in destRow) delete destRow.taxes;
}

function normalizeTaxesArray(taxes) {
  if (!Array.isArray(taxes)) return taxes;
  return taxes
    .map((t) => {
      if (!isObj(t)) return null;
      const tt = { ...t };

      if (tt.rate != null) tt.rate = Number(tt.rate);
      if (Number.isNaN(tt.rate)) return null;

      if (tt.withholding != null) tt.withholding = normalizeBool(tt.withholding);

      if (tt.type != null) tt.type = String(tt.type).trim().toUpperCase();

      delete tt.factor;
      delete tt.tax;
      delete tt.tax_code;
      delete tt.taxType;
      delete tt.impuesto;
      delete tt.kind;

      return tt;
    })
    .filter(Boolean);
}