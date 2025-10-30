// src/lyra/facturapi/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { buildFacturaPayloadData } from './payloadBuilder.js';

export function registerFacturapiTools(contextFactory) {
  registerTool('invoices.create', () => {
    const ctx = contextFactory();
    return async (_input = {}) => {
      const s = ctx.session || {};
      const tid = s.selectedTemplateId;
      if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

      const contract = s.contracts?.[tid] ?? s.contract ?? null;
      if (!contract) throw new Error('Contract no cargado para esta plantilla.');

      const type = String(contract.type || '').toLowerCase();
      if (!(type.includes('invoice') || type.includes('factura'))) {
        return {
          ok: false,
          reason: 'wrong_type',
          message: `La plantilla seleccionada no es de tipo factura (${contract.type || 'sin tipo'}). Usa "generar" para documentos normales.`,
        };
      }

      const provided = (s.provided && s.provided[tid]) ? s.provided[tid] : {};

      // Requeridos
      const requiredKeys = Array.isArray(contract.required) && contract.required.length
        ? contract.required
        : (Array.isArray(contract.fields)
            ? contract.fields.filter(f => f?.required).map(f => f.key).filter(Boolean)
            : []);
      const missing = computeMissing(requiredKeys, provided);
      if (missing.length) {
        return { ok: false, reason: 'missing', missing, message: `Faltan campos requeridos: ${missing.join(', ')}` };
      }

      // Normaliza según type de cada field (planos + items)
      const normalized = normalizeByContract(contract, provided);

      // Arma el payload que consume Facturapi (usando pistas del contract)
      const datos_factura = buildFacturaPayloadData({
        contract,
        fields: normalized,
        fields_filled: normalized,
      });

      // Modo: tolera 'mode' o 'modo', y 'test' por default
      const modeInput = _input.mode ?? _input.modo ?? s.meta?.mode ?? s.meta?.modo ?? 'test';

      const body = {
        template_id: tid,
        datos_factura,
        email: _input.email || s.user?.email || undefined,
        phone: _input.phone || undefined,
        modo: modeInput,           // usa 'mode' (ajústalo a 'modo' si tu backend lo espera así)
        skipSend: _input.skipSend ?? true,
      };

      try {
        console.log('🧾 invoices.create → POST /facturapi/factura-completa', { templateId: tid });
        const res = await ctx.http.post('/facturapi/factura-completa', body, {
          headers: { 'Content-Type': 'application/json' },
        });
        const data = res?.data || {};
        return {
          ok: true,
          id: data?.doc?.id || null,
          uuid: data?.uuid || null,
          pdfUrl: data?.pdfUrl || data?.url || null,
          xmlUrl: data?.xmlUrl || null,
          raw: data,
        };
      } catch (err) {
        const st = err?.response?.status || 500;
        const detail = err?.response?.data || err?.message || String(err);
        return { ok: false, reason: 'api_error', status: st, detail };
      }
    };
  });
}

/* ===== Helpers ===== */

function computeMissing(requiredKeys = [], provided = {}) {
  const miss = [];
  for (const key of requiredKeys) {
    // items[].campo → requiere al menos un renglón con ese campo con valor
    if (/^items\[\]\./.test(key)) {
      const prop = key.replace(/^items\[\]\./, '');
      const arr = provided?.items;
      if (!Array.isArray(arr) || arr.length === 0) { miss.push(key); continue; }
      const anyFilled = arr.some(row => {
        const v = row?.[prop];
        return !(v === undefined || v === null || String(v).trim?.() === '');
      });
      if (!anyFilled) miss.push(key);
      continue;
    }

    // items[] → al menos una fila con algún valor
    if (key === 'items[]') {
      const arr = provided?.items;
      if (!Array.isArray(arr) || arr.length === 0) { miss.push(key); continue; }
      const first = arr[0] || {};
      const empty = Object.values(first).every(v => v === undefined || v === null || String(v).trim?.() === '');
      if (empty) miss.push(key);
      continue;
    }

    // campos planos
    const v = provided?.[key];
    if (v === undefined || v === null || `${v}`.trim?.() === '' || `${v}` === '') {
      miss.push(key);
    }
  }
  return miss;
}

function normalizeByContract(contract, provided) {
  const out = { ...(provided || {}) };

  // Planos
  const plainSpecs = getFieldSpecs(contract, false);
  for (const spec of plainSpecs) {
    if (!spec?.key) continue;
    const k = spec.key;
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = coerceValue(spec.type, out[k]);
    }
  }

  // Items
  const itemSpecs = getFieldSpecs(contract, true);
  if (itemSpecs.length && Array.isArray(out.items)) {
    out.items = out.items.map((row) => {
      const r = { ...(row || {}) };
      for (const spec of itemSpecs) {
        const rel = spec.key.replace(/^items\[\]\./, '');
        if (Object.prototype.hasOwnProperty.call(r, rel)) {
          r[rel] = coerceValue(spec.type, r[rel]);
        }
      }
      return r;
    });
  }
  return out;
}

function getFieldSpecs(contract, onlyItems = false) {
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];
  return fields
    .filter(f => {
      const k = String(f?.key || '');
      const isItem = k.startsWith('items[].');
      return onlyItems ? isItem : !isItem;
    })
    .map(f => ({ key: f.key, type: (f.type || 'text').toLowerCase() }));
}

function coerceValue(type, val) {
  const t = String(type || 'text').toLowerCase();
  if (t === 'number' || t === 'int' || t === 'float') {
    if (typeof val === 'number') return val;
    if (val == null) return 0;
    const s = String(val).replace(/,/g, '').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  if (t === 'date') {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val.valueOf())) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const m = String(val).trim().match(/^([0-3]?\d)[/\-]([01]?\d)[/\-](\d{4})$/);
    if (m) {
      const [_, d, mo, y] = m;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const iso = String(val).match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return String(val).slice(0, 10);
    return String(val);
  }
  // default text/string
  if (val === undefined || val === null) return '';
  return String(val);
}
