// src/lyra/documents/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';

/**
 * documents.create
 * - Lee templateId y provided[tid] desde sesión
 * - Valida faltantes igual que fill.missing (soporta "items[].campo")
 * - Normaliza tipos conforme al contract antes del POST
 * - Hace POST /documents y devuelve { ok, id, url|pdfUrl|signedUrl }
 */
export function registerDocumentTools(contextFactory) {
  registerTool('documents.create', () => {
    const ctx = contextFactory();
    return async (_input = {}) => {
      const s = ctx.session || {};
      const tid = s.selectedTemplateId;
      if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

      // Contract tolerante (por plantilla o plano)
      const contract = s.contracts?.[tid] ?? s.contract ?? null;
      if (!contract) throw new Error('Contract no cargado para esta plantilla.');

      // Datos provistos por el usuario (guardados durante sugerir/aplicar)
      const provided = (s.provided && s.provided[tid]) ? s.provided[tid] : {};

      // Reglas de requeridos; si la versión del contract ya trae "required" úsala,
      // si no, constrúyela a partir de fields[] marcados como required.
      const requiredKeys = Array.isArray(contract.required) && contract.required.length
        ? contract.required
        : (Array.isArray(contract.fields)
            ? contract.fields.filter(f => f?.required).map(f => f.key).filter(Boolean)
            : []);

      // 1) Validar faltantes igual que fill.missing
      const missing = computeMissing(requiredKeys, provided);
      if (missing.length) {
        return {
          ok: false,
          reason: 'missing',
          missing,
          message: `Faltan campos requeridos: ${missing.join(', ')}`
        };
      }

      // 2) Normalizar tipos conforme al contract
      const normalized = normalizeByContract(contract, provided);

      // 3) POST /documents (PARCHE ROBUSTO AQUÍ)
      try {
        // Asegura que data no esté vacía
        const hasData = normalized && typeof normalized === 'object' && Object.keys(normalized).length > 0;
        if (!hasData) {
          return {
            ok: false,
            reason: 'missing',
            missing: ['data'],
            message: 'No hay datos para generar el documento.',
          };
        }
      
        // 🔑 La API espera template_id (snake_case). Mandamos ambos por compat.
        const body = {
          template_id: tid,
          templateId: tid,
          data: normalized,
        };

        // Log de inicio de la llamada a la API
        console.log('📝 documents.create → POST /documents', { templateId: tid, withData: hasData });

        const res = await ctx.http.post('/documents', body, {
          headers: { 'Content-Type': 'application/json' }, // por si acaso
        });

        const data = res?.data || {};
        const url = data.pdfUrl || data.url || data.signedUrl || null;

        // Log de fin de la llamada
        console.log('📝 documents.create ←', { id: data.id || data.documentId, url });

        return {
          ok: true,
          templateId: tid,
          id: data.id || data.documentId || null,
          url,
          raw: data,
        };
      } catch (err) {
        const status = err?.response?.status || 0;
        const detail = err?.response?.data || err?.message || 'Error desconocido';
        return {
          ok: false,
          reason: 'api_error',
          status,
          detail,
        };
      }
    };
  });
}

/* =========================
   Helpers
========================= */

/**
 * Calcula faltantes. Acepta claves "planas" y con prefijo "items[]."
 * Regla para items: al menos un renglón tiene que traer el campo no vacío.
 */
function computeMissing(requiredKeys, provided) {
  const missing = [];
  const keys = Array.isArray(requiredKeys) ? requiredKeys : [];
  for (const key of keys) {
    if (!key) continue;

    // items[].campo  -> requiere que exista items[] y que al menos 1 fila tenga ese campo con valor
    if (key.startsWith('items[].')) {
      const k = key.replace('items[].', '');
      const arr = Array.isArray(provided?.items) ? provided.items : [];
      const hasOne = arr.some(row => row && row[k] !== undefined && row[k] !== null && `${row[k]}` !== '');
      if (!hasOne) missing.push(key);
      continue;
    }

    // campo plano
    const v = provided?.[key];
    if (v === undefined || v === null || `${v}`.trim?.() === '' || `${v}` === '') {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Normaliza todos los valores según contract.fields[].type
 * Tipos soportados: text|string, number, date (YYYY-MM-DD). Cualquier otro se deja igual.
 * También aplica a cada fila de items[] cuando el contract define keys con "items[]."
 */
function normalizeByContract(contract, provided) {
  const out = { ...(provided || {}) };

  // 1) Normalizar campos planos
  const plainSpecs = getFieldSpecs(contract, false);
  for (const spec of plainSpecs) {
    if (!spec?.key) continue;
    const k = spec.key;
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = coerceValue(spec.type, out[k]);
    }
  }

  // 2) Normalizar items[] si existen y hay especificaciones "items[]."
  const itemSpecs = getFieldSpecs(contract, true);
  if (Array.isArray(out.items) && itemSpecs.length) {
    out.items = out.items.map(row => {
      const r = { ...(row || {}) };
      for (const spec of itemSpecs) {
        const k = spec.key.replace('items[].', '');
        if (Object.prototype.hasOwnProperty.call(r, k)) {
          r[k] = coerceValue(spec.type, r[k]);
        }
      }
      return r;
    });
  }

  return out;
}

/**
 * Extrae especificaciones de fields del contract.
 * - whenItems=true: solo devuelve fields con clave que empieza en "items[]."
 * - whenItems=false: solo devuelve fields "planos" (sin prefijo items[].)
 */
function getFieldSpecs(contract, whenItems) {
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];
  return fields.filter(f => {
    const key = f?.key || '';
    const isItem = key.startsWith('items[].');
    return whenItems ? isItem : !isItem;
  }).map(f => ({
    key: f.key,
    type: (f.type || 'text').toLowerCase(),
    required: !!f.required,
  }));
}

/**
 * Forzado de tipos básico y tolerante.
 */
function coerceValue(type, val) {
  const t = (type || 'text').toLowerCase();

  if (t === 'number' || t === 'numeric' || t === 'float' || t === 'int' || t === 'integer') {
    // si ya es número, respétalo
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    // intenta convertir
    const n = Number(String(val).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : (val ?? null);
  }

  if (t === 'date' || t === 'fecha') {
    // Acepta Date, string ISO o dd/mm/yyyy y lo deja en YYYY-MM-DD
    if (val instanceof Date && !isNaN(val)) {
      return val.toISOString().slice(0, 10);
    }
    const s = String(val || '').trim();
    // dd/mm/yyyy
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const [_, d, mo, y] = m;
      const mm = mo.padStart(2, '0');
      const dd = d.padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    // ya viene ISO?
    const iso = s.match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return s.slice(0, 10);
    return s || null;
  }

  // text / string / default
  if (val === undefined || val === null) return '';
  return String(val);
}