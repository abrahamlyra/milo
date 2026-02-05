// src/lyra/facturapi/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { buildFacturaPayloadData } from './payloadBuilder.js';

function isInvoiceType(rawType) {
  const t = String(rawType || '').trim().toLowerCase();
  if (!t) return false;
  return t.includes('invoice') || t.includes('factura') || t === 'cfdi';
}

export function registerFacturapiTools(contextFactory) {
  registerTool('invoices.create', async (injectedFactory) => {
    // Prefer injected factory (per-request) to ensure correct token/org/session
    const cf = injectedFactory || contextFactory;

    return async (_input = {}) => {
      const ctx = cf();
      const s = ctx.session || {};

      const tid = s.selectedTemplateId;
      if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

      const contract = s.contracts?.[tid] ?? s.contract ?? null;
      if (!contract) throw new Error('Contract no cargado para esta plantilla.');

      const type = String(contract.type || '').toLowerCase();
      if (!isInvoiceType(type)) {
        return {
          ok: false,
          reason: 'wrong_type',
          message: `La plantilla seleccionada no es de tipo factura. Usa "generar" para documentos normales.`,
        };
      }

      // ✅ Multi-RFC: require selected emitter in session
      s.meta = s.meta || {};
      const selectedEmitterId = String(s.meta.selectedEmitterId || '').trim();

      if (!selectedEmitterId) {
        // deterministic wizard step: ask for emitter selection
        s.meta.awaitingEmitter = true;

        let emitters = [];
        let organization_id = null;

        try {
          const r = await ctx.http.get('/emitters');
          organization_id = r?.data?.organization_id ?? null;
          emitters = Array.isArray(r?.data?.emitters) ? r.data.emitters : [];
        } catch (e) {
          // If emitters list fails, still return needsEmitter with a helpful message
          const detail = e?.response?.data || e?.message || String(e);
          console.error('❌ Error listando emitters (needs_emitter):', detail);
        }

        return {
          ok: false,
          reason: 'needs_emitter',
          needsEmitter: true,
          organization_id,
          emitters,
          message: 'Necesitas escoger un emisor (RFC) antes de timbrar la factura.',
        };
      }

      // Clear awaiting flag once we have a selection
      s.meta.awaitingEmitter = false;

      const provided = s.provided && s.provided[tid] ? s.provided[tid] : {};

      // 1. Requeridos
      const requiredKeys =
        Array.isArray(contract.required) && contract.required.length
          ? contract.required
          : Array.isArray(contract.fields)
            ? contract.fields
                .filter((f) => f?.required)
                .map((f) => f.key)
                .filter(Boolean)
            : [];

      const missing = computeMissing(requiredKeys, provided);
      if (missing.length) {
        return {
          ok: false,
          reason: 'missing',
          missing,
          message: `Faltan campos requeridos: ${missing.join(', ')}`,
        };
      }

      // 2. Normalización y RECONSTRUCCIÓN DE CEROS
      const normalized = normalizeByContract(contract, provided);

      // 3. Payload
      const datos_factura = buildFacturaPayloadData({
        contract,
        fields: normalized,
        fields_filled: normalized,
      });

      // Parche extra para payment_form global (por si acaso)
      if (!datos_factura.payment_form || String(datos_factura.payment_form).trim() === '') {
        const fallback =
          s.provided?.[tid]?.payment_form ??
          contract?.defaults?.payment_form ??
          s.provided?.[tid]?.forma_pago;
        if (fallback) {
          datos_factura.payment_form = String(fallback).padStart(2, '0');
        }
      }

      // 4. Notificaciones
      const delivery = s.delivery?.[tid] || { mode: 'none' };
      const deliveryMode = String(delivery.mode || 'none').toLowerCase();
      const wantsEmail = deliveryMode === 'email' || deliveryMode === 'both';
      const wantsSms = deliveryMode === 'sms' || deliveryMode === 'both';

      const emailTo =
        delivery?.email?.to ??
        (typeof delivery?.email === 'string' ? delivery.email : undefined) ??
        _input?.email ??
        s.user?.email ??
        undefined;

      const phoneTo =
        delivery?.sms?.toE164 ??
        delivery?.sms?.to ??
        _input?.phone ??
        undefined;

      const modeInput = _input.mode ?? _input.modo ?? s.meta?.mode ?? s.meta?.modo ?? 'test';

      const body = {
        template_id: tid,
        emitter_id: selectedEmitterId, // ✅ required by Lyra API (multi-RFC)
        datos_factura,
        modo: modeInput,
        skipSend: _input.skipSend ?? false,
      };

      if (wantsEmail && emailTo) body.email = emailTo;
      if (wantsSms && phoneTo) body.phone = phoneTo;

      // Log FINAL
      console.log('🧾 FACTURA → payload final:', {
        tid,
        emitter_id: selectedEmitterId,
        product_key_sample: datos_factura.items?.[0]?.product_key, // <-- CHECAR ESTO EN LOG
        payment_form: datos_factura.payment_form,
        notif: { wantsEmail, emailTo },
      });

      try {
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
        console.error('❌ Error Facturapi:', detail);
        return { ok: false, reason: 'api_error', status: st, detail };
      }
    };
  });
}

/* ===== Helpers ===== */

function computeMissing(requiredKeys = [], provided = {}) {
  const miss = [];
  for (const key of requiredKeys) {
    if (/^items\[\]\./.test(key)) {
      const prop = key.replace(/^items\[\]\./, '');
      const arr = provided?.items;
      if (!Array.isArray(arr) || arr.length === 0) {
        miss.push(key);
        continue;
      }
      const anyFilled = arr.some((row) => {
        const v = row?.[prop];
        return !(v === undefined || v === null || String(v).trim?.() === '');
      });
      if (!anyFilled) miss.push(key);
      continue;
    }
    if (key === 'items[]') {
      const arr = provided?.items;
      if (!Array.isArray(arr) || arr.length === 0) {
        miss.push(key);
        continue;
      }
      const first = arr[0] || {};
      const empty = Object.values(first).every((v) => v === undefined || v === null || String(v).trim?.() === '');
      if (empty) miss.push(key);
      continue;
    }
    const v = provided?.[key];
    if (v === undefined || v === null || `${v}`.trim?.() === '' || `${v}` === '') {
      miss.push(key);
    }
  }
  return miss;
}

// REGLAS DE RELLENO (Igual que en fill.js para doble seguridad)
const PADDING_RULES = {
  product_key: 8,
  clave_producto: 8,
  zip: 5,
  cp: 5,
  codigo_postal: 5,
  payment_form: 2,
  forma_pago: 2,
  tax_system: 3,
  regimen_fiscal: 3,
  unit_key: 0,
  clave_unidad: 0,
};

/**
 * Normaliza y REPARA ceros perdidos.
 */
function normalizeByContract(contract, provided) {
  const out = { ...(provided || {}) };

  // Helper interno para aplicar padding si la regla existe
  const applyPad = (k, val) => {
    const rule = PADDING_RULES[k];
    if (rule !== undefined) {
      let s = String(val ?? '');
      if (rule > 0) s = s.trim().padStart(rule, '0');
      return s;
    }
    return val; // si no hay regla, devuelve tal cual (se coerceará abajo)
  };

  // Planos
  const plainSpecs = getFieldSpecs(contract, false);
  for (const spec of plainSpecs) {
    if (!spec?.key) continue;
    const k = spec.key;

    // 1. Primero intentamos reparar ceros si es clave SAT
    const val = out[k];
    if (PADDING_RULES[k] !== undefined) {
      out[k] = applyPad(k, val);
    } else if (Object.prototype.hasOwnProperty.call(out, k)) {
      // 2. Si no es SAT, cast normal
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

        // 1. Reparar ceros en items (ej. product_key)
        const val = r[rel];
        if (PADDING_RULES[rel] !== undefined) {
          r[rel] = applyPad(rel, val);
        } else if (Object.prototype.hasOwnProperty.call(r, rel)) {
          // 2. Cast normal
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
    .filter((f) => {
      const k = String(f?.key || '');
      const isItem = k.startsWith('items[].');
      return onlyItems ? isItem : !isItem;
    })
    .map((f) => ({ key: f.key, type: (f.type || 'text').toLowerCase() }));
}

function coerceValue(type, val) {
  const t = String(type || 'text').toLowerCase();

  if (t === 'number' || t === 'int' || t === 'float') {
    if (typeof val === 'number') return val;
    if (val == null || val === '') return 0;
    const s = String(val).replace(/,/g, '').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  if (t === 'date') {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val.valueOf())) {
      return val.toISOString().slice(0, 10);
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

  if (val === undefined || val === null) return '';
  return String(val);
}
