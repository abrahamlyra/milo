// src/lyra/fill/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { normalizeRFC, normalizeRazonSocial } from '../../core/utils/normalize.js';
import { resolveEnum } from '../catalogs/resolve.js';

function getCtxState(ctx) {
  const s = ctx.session || {};
  const tid = s.selectedTemplateId;
  if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');
  const contract = s.contracts?.[tid];
  if (!contract) throw new Error('Contract no cargado para esta plantilla.');
  const provided = (s.provided ?? {})[tid] ?? {};
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
     sugerir  (UNA SOLA DEFINICIÓN)
  ========================= */
  registerTool('fill.suggest', async () => {
    const ctx = contextFactory();
    return async ({ mode = 'min' } = {}) => {
      const { tid, s, contract, provided } = getCtxState(ctx);
      const fields = Array.isArray(contract?.fields) ? contract.fields : [];
      const catalogs = contract?.catalogs || {};

      const suggestion = {};

      for (const f of fields) {
        // Sólo proponemos para requeridos si mode=min; para full, también opcionales
        if (mode !== 'full' && !f.required) continue;

        // Si ya trae valor el usuario, no lo pisamos
        const current = provided[f.key];
        if (current !== undefined && current !== null && current !== '') continue;

        // items
        if (f.key?.startsWith?.('items[].')) {
          const k = f.key.replace('items[].', '');
          suggestion.items = suggestion.items || [{}];   // al menos un renglón
          suggestion.items[0][k] =
            (f.type === 'number' || f.type === 'money') ? 1
            : (k.toLowerCase().includes('description') ? 'Servicio' : 'Valor');
          continue;
        }

        // enums
        if (f.type === 'enum' && f.optionsRef) {
          const val = resolveEnum(catalogs, f.optionsRef, null); // default válido si existe
          if (val != null) {
            suggestion[f.key] = val;
            continue;
          }
        }

        // defaults (del contract)
        if (f.default !== undefined) {
          suggestion[f.key] = f.default;
          continue;
        }

        // heurística por tipo
        switch (f.type) {
          case 'email': suggestion[f.key] = 'cliente@dominio.com'; break;
          case 'rfc':   suggestion[f.key] = 'XAXX010101000'; break;
          case 'date':  suggestion[f.key] = new Date().toISOString().slice(0,10); break;
          case 'number': suggestion[f.key] = 1; break;
          case 'money': suggestion[f.key] = 100; break;
          default:
            suggestion[f.key] = f.key.toLowerCase().includes('razon')
              ? 'ACME S.A. DE C.V.'
              : 'Valor';
        }
      }

      // cachear para fill.apply
      s.lastSuggestion = s.lastSuggestion || {};
      s.lastSuggestion[tid] = { mode, suggestion };

      return { templateId: tid, mode, suggestion };
    };
  });

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
