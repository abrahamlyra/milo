// src/ai/brain/convFillStore.js
//
// Persiste el estado de _convFill en Lyra (tabla user_contexts) via HTTP.
// Se usa como fallback cuando el frontend no reenvía session_data._convFill
// (pod reciclado, usuario que tardó, refresh de página, etc.)
//
// Endpoints de Lyra usados:
//   GET  /api/user/context
//   PATCH /api/user/context

/**
 * Carga el estado _convFill desde Lyra para este usuario.
 * Devuelve el objeto _convFill o null si no hay nada o hubo error.
 *
 * @param {object} http   — cliente axios del contextFactory
 * @returns {object|null}
 */
export async function loadConvFillFromDB(http) {
  try {
    const { data: res } = await http.get('/user/context');
    if (!res?.ok || !res?.data?._convFill) return null;
    return res.data._convFill;
  } catch (err) {
    console.warn('[convFillStore] loadConvFillFromDB falló:', err?.message);
    return null;
  }
}

/**
 * Persiste el estado _convFill completo en Lyra.
 * No lanza — errores se loggean y se ignoran para no romper el flujo.
 *
 * @param {object} http         — cliente axios del contextFactory
 * @param {object} convFill     — objeto { [templateId]: { contract, collected, round, stage } }
 */
export async function saveConvFillToDB(http, convFill) {
  try {
    await http.patch('/user/context', { data: { _convFill: convFill } });
  } catch (err) {
    console.warn('[convFillStore] saveConvFillToDB falló:', err?.message);
  }
}

/**
 * Borra el estado _convFill en Lyra (cuando el flujo termina).
 * No lanza.
 *
 * @param {object} http — cliente axios del contextFactory
 */
export async function clearConvFillFromDB(http) {
  try {
    await http.patch('/user/context', { data: { _convFill: null } });
  } catch (err) {
    console.warn('[convFillStore] clearConvFillFromDB falló:', err?.message);
  }
}