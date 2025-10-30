// src/lyra/templates/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import templatesCreate from './create.js';
import templatesList from './list.js';
// ⬇️ importa también el registrador del contrato
import { registerTemplateTools as registerContractTool } from './contract.js';

// ¡OJO! Invocar contextFactory() (o inyectada) en cada tool
export function registerTemplateTools(contextFactory) {
  // Estas dos siguen igual
  registerTool('templates.create', (inj) => templatesCreate((inj || contextFactory)()));
  registerTool('templates.list',   (inj) => templatesList((inj || contextFactory)()));

  // ⬇️ Delegamos el registro de 'templates.contract' al módulo contract.js
  // para que ese registro sea el que PERSISTE selectedTemplateId / contracts / provided.
  registerContractTool(contextFactory);
}

  // Próximas:
  // registerTool('templates.listByAudience', ...);
  // registerTool('templates.getRaw', ...);
  // registerTool('templates.getPreview', ...);
  // registerTool('templates.getOne', ...);

