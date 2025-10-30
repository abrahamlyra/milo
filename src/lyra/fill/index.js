// src/lyra/fill/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { normalizeRFC, normalizeRazonSocial } from '../../core/utils/normalize.js';
import { resolveEnum } from '../catalogs/resolve.js';

function getCtxState(ctx) {
  const s = ctx.session || {};
  const tid = s.selectedTemplateId;
  if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

  // Tolera ambos layouts (por plantilla o plano)
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

    // items[].campo → requiere al menos un item con ese campo
    if (f.key?.startsWith?.('items[].')) {
      const k = f.key.replace('items[].', '');
      const items = Array.isArray(provided.items) ? provided.items : [];
      const hasAtLeastOne =
        items.length > 0 && items.some((row) => row && row[k] !== undefined && row[k] !== '');
      if (!hasAtLeastOne) missing.push(f.key);
      continue;
    }

    // campo plano (si hay default en provided ya no se marca)
    const v = provided[f.key];
    if (v === undefined || v === null || v === '') {
      missing.push(f.key);
    }
  }

  return missing;
}

function applyNormalizers(key, value) {
  if (key === 'receptor_rfc') return normalizeRFC(value);
  if (key === 'receptor_razon') return normalizeRazonSocial(value);
  return value;
}

export function registerFillTools(contextFactory) {
  /* =========================
  	faltantes
  ========================= */
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

  /* =========================
  	sugerir  (ROBUSTO)
  ========================= */
  // REEMPLAZO COMPLETO DE fill.suggest CON EL PARCHE ROBUSTO
  registerTool('fill.suggest', async (injectedFactory) => {
    const cf = injectedFactory || contextFactory;
    return async ({ mode = 'min' } = {}) => {
      const ctx = cf();
      const { tid, s, contract, provided } = getCtxState(ctx);
      const fields = Array.isArray(contract?.fields) ? contract.fields : [];
      const catalogs = contract?.catalogs || {};
      const suggestion = {};

      // Helper ultra-defensivo para proponer algo según la pista disponible
      const propose = (f) => {
        const key = f?.key || f?.name || f?.id;
        if (!key) return;

        // Si ya hay valor del usuario, no lo pisamos
        const current = provided[key];
        if (current !== undefined && current !== null && current !== '') return;

        // items[].campo
        if (key.startsWith('items[].')) {
          const k = key.replace('items[].', '');
          suggestion.items = suggestion.items || [{}];
          // si el tipo no viene, intenta inferir por nombre
          const kind = (f?.type || (/price|importe|monto|cantidad|qty|quantity/i.test(k) ? 'number' : 'string')).toLowerCase();

          suggestion.items[0][k] =
            (kind === 'number' || kind === 'money') ? 1
            : /description|concepto|desc/i.test(k) ? 'Servicio'
            : 'Valor';
          return;
        }

        // enums con catálogo conocido
        if ((f?.type === 'enum' || f?.optionsRef) && f?.optionsRef) {
          const val = resolveEnum(catalogs, f.optionsRef, null);
          if (val != null) { suggestion[key] = val; return; }
        }

        // default declarado en el contrato
        if (f?.default !== undefined) { suggestion[key] = f.default; return; }

        // heurística por tipo o por nombre de campo
        const t = String(f?.type || '').toLowerCase();
        if (t === 'email') { suggestion[key] = 'cliente@dominio.com'; return; }
        if (t === 'rfc')   { suggestion[key] = 'XAXX010101000'; return; }
        if (t === 'date')  { suggestion[key] = new Date().toISOString().slice(0,10); return; }
        if (t === 'number'){ suggestion[key] = 1; return; }
        if (t === 'money') { suggestion[key] = 100; return; }

        // inferencia por nombre si no hay type
        const k = key.toLowerCase();
        if (/razon|nombre/.test(k)) { suggestion[key] = 'ACME S.A. DE C.V.'; return; }
        if (/rfc/.test(k))          { suggestion[key] = 'XAXX010101000'; return; }
        if (/fecha/.test(k))        { suggestion[key] = new Date().toISOString().slice(0,10); return; }
        if (/correo|email/.test(k)) { suggestion[key] = 'cliente@dominio.com'; return; }
        if (/precio|monto|importe/.test(k)) { suggestion[key] = 100; return; }
        if (/workers|throughput|cantidad|volumen|horas|plazo|dias/.test(k)) { suggestion[key] = 1; return; }

        // fallback genérico
        suggestion[key] = 'Valor';
      };

      for (const f of fields) {
        // min -> solo requeridos; full -> todos
        if (mode !== 'full' && !f?.required) continue;
        propose(f);
      }

      // Si por cualquier cosa quedó vacío, fuerza un mínimo para requeridos
      if (Object.keys(suggestion).length === 0) {
        for (const f of fields.filter(x => x?.required)) propose(f);
      }

      s.lastSuggestion = s.lastSuggestion || {};
      s.lastSuggestion[tid] = { mode, suggestion };

      return { templateId: tid, mode, suggestion };
    };
  });
  // FIN DEL REEMPLAZO DE fill.suggest

  /* =========================
  	aplicar
  ========================= */
  registerTool('fill.apply', async () => {
    const ctx = contextFactory();
    return async () => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const incoming = s.lastSuggestion?.[tid]?.suggestion || {};

      const target = { ...provided };

      // merge plano + items
      for (const [k, v] of Object.entries(incoming)) {
        if (k === 'items' && Array.isArray(v)) {
          const cur = Array.isArray(target.items) ? target.items : [];
          target.items = cur.length ? cur : [];
          // mezcla el primer renglón sugerido si no existía nada
          if (target.items.length === 0 && v.length > 0) {
            target.items.push({ ...v[0] });
          }
        } else {
          target[k] = v;
        }
      }

      // normalizar claves “críticas”
      for (const [k, v] of Object.entries(target)) {
        if (k === 'items') continue; // se normaliza al setear cada campo
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
      return { templateId: tid, provided: target, missing };
    };
  });

  /* =========================
  	set (multi-KV, soporta items[].campo)
  ========================= */
  registerTool('fill.set', async () => {
    const ctx = contextFactory();
    return async ({ __raw, ...kv }) => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const target = { ...provided };

      // 1) Si vino __raw, parsea “set a=1 b=2 …”
      if (__raw && typeof __raw === 'string') {
        const m = __raw.match(/^set\s+(.+)$/i);
        if (m) {
          const part = m[1];
          const regex = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
          let r;
          while ((r = regex.exec(part)) !== null) {
            const key = r[1];
            const raw = r[3] ?? r[4] ?? r[2];
            kv[key] = raw;
          }
        }
      }

      // 2) Aplica a provided (items y planos)
      for (const [key, val] of Object.entries(kv)) {
        if (key.startsWith('items[].')) {
          const k = key.replace('items[].', '');
          target.items = Array.isArray(target.items) ? target.items : [];
          target.items[0] = target.items[0] || {};
          target.items[0][k] = applyNormalizers(k, val);
        } else {
          target[key] = applyNormalizers(key, val);
        }
      }

      s.provided = s.provided || {};
      s.provided[tid] = target;

      const missing = computeMissing(contract, target);
      return { templateId: tid, provided: target, missing };
    };
  });
}