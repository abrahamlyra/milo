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

      // Validación de tipo de plantilla
      const type = String(contract.type || '').toLowerCase();
      if (!(type.includes('invoice') || type.includes('factura'))) {
        return {
          ok: false,
          reason: 'wrong_type',
          message: `La plantilla seleccionada no es de tipo factura (${contract.type || 'sin tipo'}). Usa "generar" para documentos normales.`,
        };
      }

      const provided = (s.provided && s.provided[tid]) ? s.provided[tid] : {};

      // 1. Validación de campos Requeridos
      const requiredKeys = Array.isArray(contract.required) && contract.required.length
        ? contract.required
        : (Array.isArray(contract.fields)
            ? contract.fields.filter(f => f?.required).map(f => f.key).filter(Boolean)
            : []);
      
      const missing = computeMissing(requiredKeys, provided);
      if (missing.length) {
        return { ok: false, reason: 'missing', missing, message: `Faltan campos requeridos: ${missing.join(', ')}` };
      }

      // 2. Normalización (Aquí se arregla el problema del "0" en product_key)
      const normalized = normalizeByContract(contract, provided);

      // 3. Construcción del Payload para Facturapi
      const datos_factura = buildFacturaPayloadData({
        contract,
        fields: normalized,
        fields_filled: normalized,
      });

      // 🔒 Parche de seguridad: payment_form con padding (ej: '1' -> '01')
      if (!datos_factura.payment_form || String(datos_factura.payment_form).trim() === '') {
        const fallback =
          s.provided?.[tid]?.payment_form ??
          contract?.defaults?.payment_form ??
          s.provided?.[tid]?.forma_pago;
    
        if (fallback) {
          datos_factura.payment_form = String(fallback).padStart(2, '0');
        }
      }

      // 4. Lógica de Notificaciones (Integrada desde Documents)
      // s.delivery[tid] = { mode: 'none'|'email'|'sms'|'both', email: {...}, sms: {...} }
      const delivery = s.delivery?.[tid] || { mode: 'none' };
      const deliveryMode = String(delivery.mode || 'none').toLowerCase();
      const wantsEmail = deliveryMode === 'email' || deliveryMode === 'both';
      const wantsSms   = deliveryMode === 'sms'   || deliveryMode === 'both';

      // Extraer destinatarios con fallback tolerante
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

      // 5. Preparar el Body final
      const modeInput = _input.mode ?? _input.modo ?? s.meta?.mode ?? s.meta?.modo ?? 'test';

      const body = {
        template_id: tid,
        datos_factura,
        modo: modeInput,
        skipSend: _input.skipSend ?? false, // Si es false, Facturapi intentará enviar si hay email
      };

      // Inyectar email/phone SOLO si el usuario lo pidió y existen los datos
      if (wantsEmail && emailTo) body.email = emailTo;
      if (wantsSms && phoneTo)   body.phone = phoneTo;

      // Log de verificación antes del envío
      console.log('🧾 FACTURA → payload:', {
        tid,
        payment_form: datos_factura.payment_form,
        items_sample: datos_factura.items?.[0], // Verificar aquí si sale el product_key correcto
        notifications: { wantsEmail, wantsSms, emailTo, phoneTo }
      });

      try {
        console.log('🧾 invoices.create → POST /facturapi/factura-completa');
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
      if (!Array.isArray(arr) || arr.length === 0) { miss.push(key); continue; }
      const anyFilled = arr.some(row => {
        const v = row?.[prop];
        return !(v === undefined || v === null || String(v).trim?.() === '');
      });
      if (!anyFilled) miss.push(key);
      continue;
    }
    if (key === 'items[]') {
      const arr = provided?.items;
      if (!Array.isArray(arr) || arr.length === 0) { miss.push(key); continue; }
      const first = arr[0] || {};
      const empty = Object.values(first).every(v => v === undefined || v === null || String(v).trim?.() === '');
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

/**
 * 🚨 AQUÍ ESTÁ LA MAGIA DEL CERO 🚨
 * Normaliza tipos, pero PROTEGE claves del SAT para que sean siempre STRING.
 */
function normalizeByContract(contract, provided) {
  const out = { ...(provided || {}) };

  // Lista de claves que JAMÁS deben ser number, siempre string para conservar ceros (01, 06250, etc)
  const SAT_STRING_KEYS = ['product_key', 'unit_key', 'zip', 'cp', 'codigo_postal', 'payment_form', 'tax_system'];

  // Planos
  const plainSpecs = getFieldSpecs(contract, false);
  for (const spec of plainSpecs) {
    if (!spec?.key) continue;
    const k = spec.key;
    
    // Si la clave es protegida, forzamos 'text', si no, usamos el tipo del contrato
    const safeType = SAT_STRING_KEYS.includes(k) ? 'text' : spec.type;

    if (Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = coerceValue(safeType, out[k]);
    }
  }

  // Items
  const itemSpecs = getFieldSpecs(contract, true);
  if (itemSpecs.length && Array.isArray(out.items)) {
    out.items = out.items.map((row) => {
      const r = { ...(row || {}) };
      for (const spec of itemSpecs) {
        const rel = spec.key.replace(/^items\[\]\./, '');
        
        // Misma protección para items (ej: product_key dentro de items)
        const safeType = SAT_STRING_KEYS.includes(rel) ? 'text' : spec.type;

        if (Object.prototype.hasOwnProperty.call(r, rel)) {
          r[rel] = coerceValue(safeType, r[rel]);
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
    // dd/mm/yyyy -> yyyy-mm-dd
    const m = String(val).trim().match(/^([0-3]?\d)[/\-]([01]?\d)[/\-](\d{4})$/);
    if (m) {
      const [_, d, mo, y] = m;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const iso = String(val).match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return String(val).slice(0, 10);
    return String(val);
  }
  
  // default text/string: NO TRIM para no romper formatos, solo String()
  if (val === undefined || val === null) return '';
  return String(val);
}