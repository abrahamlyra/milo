// src/core/nlu/intentRouter.js
const registry = new Map();

export function registerTool(name, factory) {
  if (registry.has(name)) throw new Error(`Tool duplicado: ${name}`);
  registry.set(name, factory);
}

export function getTool(name) {
  const f = registry.get(name);
  if (!f) throw new Error(`Tool no encontrado: ${name}`);
  return f;
}

export function listTools() {
  return Array.from(registry.keys()).sort();
}
