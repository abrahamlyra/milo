// src/core/state/session.js
// Estado en memoria (para stage). Si luego quieres Redis, cambiamos acá.
const sessions = new Map();

export function getSession(sessionId) {
  if (!sessionId) return null;
  if (!sessions.has(sessionId)) sessions.set(sessionId, { provided: {}, meta: {} });
  return sessions.get(sessionId);
}

export function setUserInfo(sessionId, userInfo) {
  const s = getSession(sessionId);
  if (!s) return;
  s.user = { ...(s.user || {}), ...userInfo };
}

export function extractTokenFromPayload(body) {
  // Soporta: body.context.user.token, body.token
  return body?.context?.user?.token || body?.token || null;
}

// añade helpers mínimos
export function initFilling(session, templateId, contract) {
  session.selectedTemplateId = templateId;
  session.contract = contract;
  session.provided = session.provided || {};
  session.suggestion = null;
}

export function setValue(session, key, value) {
  session.provided = session.provided || {};
  // soporta items[].quantity -> crea estructura mínima
  const parts = key.split('.');
  let ref = session.provided;
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

export function computeMissing(session) {
  const req = new Set((session.contract?.fields || []).filter(f => f.required).map(f => f.key));
  const got = new Set(listProvidedKeys(session.provided));
  const missing = [...req].filter(k => !got.has(k));
  session.missing = missing;
  return missing;
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
