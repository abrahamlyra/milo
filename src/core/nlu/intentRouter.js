// src/core/nlu/intentRouter.js
// Router minimalista para registrar/obtener tools por nombre.

const registry = new Map();

/**
 * Registra un tool con un factory (sin ejecutar).
 * @param {string} name
 * @param {() => Function|Promise<Function>} factory
 */
export function registerTool(name, factory) {
  if (registry.has(name)) {
    throw new Error(`Tool duplicado: ${name}`);
  }
  registry.set(name, factory);
}

/**
 * Devuelve el factory del tool (no lo ejecuta).
 * @param {string} name
 * @returns {() => any}
 */
export function getTool(name) {
  const f = registry.get(name);
  if (!f) {
    throw new Error(`Tool no encontrado: ${name}`);
  }
  return f;
}

/**
 * Lista los nombres de tools registrados, ordenados.
 */
export function listTools() {
  return Array.from(registry.keys()).sort();
}
