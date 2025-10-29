// src/lyra/templates/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import templatesCreate from './create.js';
import templatesList from './list.js';
// cuando lo agregues:
import templatesContract from './contract.js';

// Registramos EN ESTE ORDEN (como pactamos):
export function registerTemplateTools(contextFactory) {
  registerTool('templates.create',   () => templatesCreate(contextFactory()));
  registerTool('templates.list',     () => templatesList(contextFactory()));
  registerTool('templates.contract', () => templatesContract(contextFactory()));
  // Próximas (cuando toque):
  // registerTool('templates.listByAudience', ...);
  // registerTool('templates.getRaw', ...);
  // registerTool('templates.getPreview', ...);
  // registerTool('templates.getOne', ...);
  // registerTool('templates.getContract', ...);
}
