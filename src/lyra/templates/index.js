// src/lyra/templates/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import templatesCreate from './create.js';
import templatesList from './list.js';
import templatesContract from './contract.js';

// ¡OJO! Invocar contextFactory() para pasar { http, session, ... }
export function registerTemplateTools(contextFactory) {
  registerTool('templates.create',   () => templatesCreate(contextFactory()));
  registerTool('templates.list',     () => templatesList(contextFactory()));
  registerTool('templates.contract', () => templatesContract(contextFactory()));
  // Próximas:
  // registerTool('templates.listByAudience', ...);
  // registerTool('templates.getRaw', ...);
  // registerTool('templates.getPreview', ...);
  // registerTool('templates.getOne', ...);
}
