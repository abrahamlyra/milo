// src/lyra/templates/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';
import templatesCreate from './create.js';
import templatesList from './list.js';
import { registerTemplateTools as registerContractTool } from './contract.js';

// ¡OJO! Invocar contextFactory() (o inyectada) en cada tool
export function registerTemplateTools(contextFactory) {
  // Estas dos siguen igual (inyectamos el contexto en tiempo de ejecución)
  registerTool('templates.create', (inj) => {
    const ctx = (inj || contextFactory)();
    return templatesCreate(ctx);
  });

  registerTool('templates.list', (inj) => {
    const ctx = (inj || contextFactory)();
    return templatesList(ctx);
  });

  // ⬇️ Delegamos el registro de 'templates.contract' al módulo contract.js
  // para que ese registro sea el que PERSISTE selectedTemplateId / contracts / provided.
  registerContractTool(contextFactory);
}

// Próximas (cuando existan los tools correspondientes):
// registerTool('templates.listByAudience', ...);
// registerTool('templates.getRaw', ...);
// registerTool('templates.getPreview', ...);
// registerTool('templates.getOne', ...);
