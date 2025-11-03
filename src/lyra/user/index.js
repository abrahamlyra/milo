// src/lyra/user/index.js
import { registerBillingTools } from './billing.js';

export { userMe } from "./me.js";

/**
 * Registro de herramientas del módulo user (mínimo necesario).
 * Llama al registrador de billing (wizard de Activar facturación).
 */
export function registerUserTools(contextFactory) {
  registerBillingTools(contextFactory);
}
