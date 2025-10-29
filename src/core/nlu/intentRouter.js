// src/lyra/templates/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import templatesCreate from './create.js';
import templatesList from './list.js';
import templatesContract from './contract.js'; // 👈 NUEVO (asegúrate de tener ./contract.js)

/**
 * Registramos EN ESTE ORDEN (como pactamos):
 * - create
 * - list
 * - contract (nuevo)
 * Si luego agregamos más (getOne, getRaw, getPreview, listByAudience), se registran aquí mismo.
 */
export function registerTemplateTools(contextFactory) {
  registerTool('templates.create',   () => templatesCreate(contextFactory()));
  registerTool('templates.list',     () => templatesList(contextFactory()));
  registerTool('templates.contract', () => templatesContract(contextFactory())); // 👈 NUEVO

  // Próximas (cuando toque):
  // registerTool('templates.listByAudience', () => templatesListByAudience(contextFactory()));
  // registerTool('templates.getRaw',         () => templatesGetRaw(contextFactory()));
  // registerTool('templates.getPreview',     () => templatesGetPreview(contextFactory()));
  // registerTool('templates.getOne',         () => templatesGetOne(contextFactory()));
}
