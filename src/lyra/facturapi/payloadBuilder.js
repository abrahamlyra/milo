// src/lyra/facturapi/payloadBuilder.js

/**
 * buildFacturaPayloadData
 * Toma fields (plano + items[]) y los acomoda al JSON que consume Facturapi.
 * Usa las pistas del contract:
 *  - defaults: objeto con valores por defecto.
 *  - mappings: { srcKey: "dest.path" } (no-items, dot-path).
 *  - itemMappings: { srcKeyEnItem: "items[].dest.path" } para mapear cada renglón.
 *
 * Si no defines mappings, pasa campos tal cual (passthrough),
 * y copia items[] directo.
 */
export function buildFacturaPayloadData({ contract, fields }) {
  const out = {};

  // 1) defaults
  if (contract?.defaults && typeof contract.defaults === 'object') {
    deepMerge(out, contract.defaults);
  }

  // 2) passthrough plano (excepto items, que se trata abajo)
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'items') out[k] = v;
    }
  }

  // 3) mappings (no items)
  const mappings = isObj(contract?.mappings) ? contract.mappings : {};
  for (const [src, destPath] of Object.entries(mappings)) {
    if (!isStr(destPath) || destPath.startsWith('items[]')) continue;
    if (fields?.[src] !== undefined) setByPath(out, destPath, fields[src]);
  }

  // 4) items[]
  const hasItems = Array.isArray(fields?.items);
  const itemMappings = isObj(contract?.itemMappings) ? contract.itemMappings : null;

  if (hasItems) {
    if (itemMappings) {
      const arr = [];
      for (const row of fields.items) {
        const destRow = {};
        // 4.1 map explícito
        for (const [from, toFull] of Object.entries(itemMappings)) {
          if (!/^items\[\]\./.test(toFull)) continue;
          const to = toFull.replace(/^items\[\]\./, '');
          if (row?.[from] !== undefined) setByPath(destRow, to, row[from]);
        }
        // 4.2 copia cualquier campo del row que no haya sido mapeado
        for (const [k, v] of Object.entries(row || {})) {
          if (!hasDestFor(itemMappings, k) && destRow[k] === undefined) destRow[k] = v;
        }
        arr.push(destRow);
      }
      out.items = arr;
    } else {
      // sin mapeo, copia directa
      out.items = fields.items.map(r => ({ ...(r || {}) }));
    }
  }

  // 5) mappings que apunten a "items[]...." a nivel top (poco común, pero soportado)
  for (const [src, destPath] of Object.entries(mappings)) {
    if (!/^items\[\]\./.test(destPath)) continue;
    if (!hasItems) continue;
    const prop = destPath.replace(/^items\[\]\./, '');
    out.items = out.items.map((r, idx) => {
      const val = fields.items?.[idx]?.[src];
      return val === undefined ? r : setByPath({ ...r }, prop, val);
    });
  }

  return out;
}

/* ============ helpers ============ */

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function isStr(x) { return typeof x === 'string'; }

function hasDestFor(map = {}, key) {
  return Object.values(map || {}).some(dest => {
    if (!isStr(dest)) return false;
    return dest === `items[].${key}` || dest.startsWith(`items[].${key}.`);
  });
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
