// src/lyra/fill/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import { buildSuggestedPayload } from '../../core/utils/suggest.js';
import { normalizeByFieldKey } from '../../core/utils/normalize.js';
import { resolveCatalog } from '../catalogs/resolve.js';

// Helpers locales para no crecer session.js
function setValueDeep(state, key, value) {
  const parts = String(key).split('.');
  let ref = state;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isArr = p.endsWith('[]');
    const name = isArr ? p.slice(0, -2) : p;
    if (i === parts.length - 1) {
      ref[name] = value;
    } else {
      if (isArr) {
        ref[name] = ref[name] || [{}];
        ref = ref[name][0];
      } else {
        ref[name] = ref[name] || {};
        ref = ref[name];
      }
    }
  }
}

function listProvidedKeys(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out.push(`${path}[]`);
      if (v[0] && typeof v[0] === 'object') {
        out.push(...listProvidedKeys(v[0], `${path}[]`));
      }
    } else if (v && typeof v === 'object') {
      out.push(...listProvidedKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function computeMissing(contract, provided) {
  const required = new Set((contract?.fields || []).filter(f => f.required).map(f => f.key));
  const got = new Set(listProvidedKeys(provided));
  return [...required].filter(k => !got.has(k));
}

function findField(contract, key) {
  return (contract?.fields || []).find(f => f.key === key);
}

export function registerFillTools(contextFactory) {
  /* fill.missing */
  registerTool('fill.missing', async () => async (_input = {}) => {
    const { session } = contextFactory();
    const contract = session.contract || {};
    session.provided = session.provided || {};
    const missing = computeMissing(contract, session.provided);
    return { missing };
  });

  /* fill.suggest (mode=min|full) */
  registerTool('fill.suggest', async () => async (input = {}) => {
    const { session } = contextFactory();
    const mode = (input.mode || 'min').toLowerCase();
    const payload = buildSuggestedPayload(session.contract || {}, { mode });
    session.suggestion = payload;
    return { mode, payload };
  });

  /* fill.apply (aplica última sugerencia) */
  registerTool('fill.apply', async () => async (_input = {}) => {
    const { session } = contextFactory();
    if (!session.suggestion) return { applied: false };
    session.provided = session.provided || {};

    // Merge profundo sugerencia -> provided
    const merged = structuredClone(session.provided);
    const deepMerge = (a, b) => {
      if (Array.isArray(a) && Array.isArray(b)) return b.length ? b : a;
      if (Array.isArray(b)) return b;
      if (typeof a === 'object' && typeof b === 'object') {
        const out = { ...a };
        for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k]);
        return out;
      }
      return b ?? a;
    };
    session.provided = deepMerge(session.provided, session.suggestion);
    session.suggestion = null;
    return { applied: true, merged: session.provided };
  });

  /* fill.set (key=value ...) */
  registerTool('fill.set', async () => async (kvInput = {}) => {
    const { session } = contextFactory();
    session.provided = session.provided || {};
    const contract = session.contract || {};
    const fieldsByKey = new Map((contract.fields || []).map(f => [f.key, f]));

    // Para cada key=value recibido
    for (const [rawKey, rawValue] of Object.entries(kvInput)) {
      const key = String(rawKey).trim();
      const field = fieldsByKey.get(key) || findField(contract, key);
      let value = rawValue;

      // Si el field es enum con optionsRef, resolvemos catálogo (texto → code)
      if (field?.type === 'enum' && field?.optionsRef) {
        const match = await resolveCatalog(field.optionsRef, String(rawValue));
        if (match) value = match.code; // guardamos code oficial
      }

      // Normalización (SAT strict para razón social/RFC/etc., email solo trim)
      value = normalizeByFieldKey(key, value);

      // Asignar
      setValueDeep(session.provided, key, value);
    }

    // Regresa faltantes tras el set
    const missing = computeMissing(contract, session.provided);
    return { ok: true, provided: session.provided, missing };
  });
}
