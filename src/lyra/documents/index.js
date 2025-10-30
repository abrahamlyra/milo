// src/lyra/documents/index.js
import { registerTool } from '../../core/nlu/intentRouter.js';

/**
 * Registra tools relacionados con documentos.
 * Solo expone 'documents.create' por ahora.
 */
export function registerDocumentTools(contextFactory) {
  registerTool('documents.create', () => {
    const ctx = contextFactory();
    return async (_input = {}) => {
      const s = ctx.session || {};
      const tid = s.selectedTemplateId;
      if (!tid) throw new Error('No hay plantilla seleccionada. Usa: usar <templateId>');

      // contract tolerante (por plantilla o plano)
      const contract = s.contracts?.[tid] ?? s.contract ?? null;
      if (!contract) throw new Error('Contract no cargado para esta plantilla.');

      const provided = (s.provided && s.provided[tid]) ? s.provided[tid] : {};

      // Valida faltantes igual que fill.missing
      const missing = computeMissing(contract, provided);
      if (missing.length > 0) {
        return {
          templateId: tid,
          ready: false,
          missing,
          message: 'Hay campos requeridos sin valor. Usa faltantes / sugerir / set ...',
        };
      }

      // Body mínimo que espera la API de Lyra
      const body = {
        templateId: tid,
        data: provided,
      };

      // AÑADIDO: Log de inicio de la llamada a la API
      console.log('📝 documents.create → POST /documents', { templateId: tid, withData: Object.keys(provided).length > 0 });
      
      const { data } = await ctx.http.post('/documents', body);
      
      // AÑADIDO: Log de fin de la llamada
      const url = data?.pdfUrl || data?.url || data?.signedUrl || null;
      console.log('📝 documents.create ←', { id: data?.id || data?.documentId, url });
      
      // Normaliza nombre del link
      // const url = data?.pdfUrl || data?.url || data?.signedUrl || null; // Esta línea se movió arriba para el log

      return {
        templateId: tid,
        ready: true,
        id: data?.id ?? data?.documentId ?? null,
        url,
        raw: data,
      };
    };
  });
}

/* Copia local del validador de faltantes para no acoplar módulos */
function computeMissing(contract, provided) {
  const missing = [];
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];

  for (const f of fields) {
    if (!f?.required) continue;
    const key = f.key || f.name || f.id;
    if (!key) continue;

    // items[].campo (al menos un renglón con ese campo no vacío)
    if (key.startsWith('items[].')) {
      const k = key.replace('items[].','');
      const arr = Array.isArray(provided?.items) ? provided.items : [];
      const hasAtLeastOne = arr.some(r => r && r[k] !== undefined && r[k] !== null && `${r[k]}` !== '');
      if (!hasAtLeastOne) missing.push(key);
      continue;
    }

    const v = provided?.[key];
    if (v === undefined || v === null || `${v}` === '') missing.push(key);
  }

  return missing;
}