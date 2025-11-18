// src/lyra/knowledge/index.js
//
// Cliente de Knowledge / catálogos para Milo.
// Envuelve el endpoint: POST /api/knowledge/search
// y expone helpers específicos para catálogos SAT.
//
// Se registra como tools:
// - knowledge.search
// - catalog.regimen_fiscal.search
// - catalog.uso_cfdi.search
// - catalog.forma_pago.search
// - catalog.metodo_pago.search
// - catalog.clave_producto_servicio.search

import { z } from 'zod';
import { registerTool } from '../core/nlu/intentRouter.js';

// 🔹 Schema genérico para knowledge.search
const KnowledgeSearchInput = z.object({
  query: z.string().min(1, 'query es obligatorio'),
  sourceTypes: z.array(z.string()).optional(),
  sourceNames: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

// 🔹 Normalización suave para las tools de catálogo (aceptan { query } o { text })
const CatalogSearchInput = z.object({
  query: z.string().min(1).or(z.undefined()),
  text: z.string().min(1).or(z.undefined()),
  limit: z.number().int().positive().max(20).optional(),
});

/**
 * Construye un cliente de knowledge usando el http del contexto
 */
function makeKnowledgeClient({ http }) {
  return {
    async search({ query, sourceTypes, sourceNames, limit }) {
      const payload = { query };

      if (Array.isArray(sourceTypes) && sourceTypes.length) {
        payload.sourceTypes = sourceTypes;
      }
      if (Array.isArray(sourceNames) && sourceNames.length) {
        payload.sourceNames = sourceNames;
      }
      if (typeof limit === 'number') {
        payload.limit = limit;
      }

      const { data } = await http.post('/knowledge/search', payload);

      const items = Array.isArray(data?.items) ? data.items : [];
      const ok = data?.ok !== false;

      return {
        ok,
        items,
        raw: data,
      };
    },

    async searchCatalog({ query, sourceName, limit }) {
      const res = await this.search({
        query,
        sourceTypes: ['catalog'],
        sourceNames: [sourceName],
        limit: limit ?? 5,
      });

      // Mapeamos a un formato cómodo para Milo / brain
      const suggestions = res.items.map((it) => ({
        code: it.code || it.metadata?.code || null,
        label: it.title || it.content || '',
        sourceType: it.sourceType,
        sourceName: it.sourceName,
        distance: it.distance,
        metadata: it.metadata,
      }));

      return {
        ok: res.ok,
        suggestions,
        raw: res.raw,
      };
    },

    // Helpers específicos para SAT
    async searchRegimenFiscal(query, { limit } = {}) {
      return this.searchCatalog({
        query,
        sourceName: 'regimen_fiscal',
        limit,
      });
    },

    async searchUsoCFDI(query, { limit } = {}) {
      return this.searchCatalog({
        query,
        sourceName: 'uso_cfdi',
        limit,
      });
    },

    async searchFormaPago(query, { limit } = {}) {
      return this.searchCatalog({
        query,
        sourceName: 'forma_pago',
        limit,
      });
    },

    async searchMetodoPago(query, { limit } = {}) {
      return this.searchCatalog({
        query,
        sourceName: 'metodo_pago',
        limit,
      });
    },

    async searchClaveProductoServicio(query, { limit } = {}) {
      return this.searchCatalog({
        query,
        sourceName: 'clave_producto_servicio',
        limit,
      });
    },
  };
}

/**
 * Registro de tools de Knowledge para Milo.
 * Se llama desde webhook/server.js con el contextFactory.
 */
export function registerKnowledgeTools(contextFactory) {
  // Tool genérica: knowledge.search
  registerTool('knowledge.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const { query, sourceTypes, sourceNames, limit } =
        KnowledgeSearchInput.parse(raw || {});
      const res = await knowledge.search({
        query,
        sourceTypes,
        sourceNames,
        limit,
      });
      return res;
    };
  });

  // Tool específica: catalog.regimen_fiscal.search
  registerTool('catalog.regimen_fiscal.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const parsed = CatalogSearchInput.parse(raw || {});
      const query = parsed.query || parsed.text;
      const res = await knowledge.searchRegimenFiscal(query, {
        limit: parsed.limit,
      });
      return res;
    };
  });

  // Tool específica: catalog.uso_cfdi.search
  registerTool('catalog.uso_cfdi.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const parsed = CatalogSearchInput.parse(raw || {});
      const query = parsed.query || parsed.text;
      const res = await knowledge.searchUsoCFDI(query, {
        limit: parsed.limit,
      });
      return res;
    };
  });

  // Tool específica: catalog.forma_pago.search
  registerTool('catalog.forma_pago.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const parsed = CatalogSearchInput.parse(raw || {});
      const query = parsed.query || parsed.text;
      const res = await knowledge.searchFormaPago(query, {
        limit: parsed.limit,
      });
      return res;
    };
  });

  // Tool específica: catalog.metodo_pago.search
  registerTool('catalog.metodo_pago.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const parsed = CatalogSearchInput.parse(raw || {});
      const query = parsed.query || parsed.text;
      const res = await knowledge.searchMetodoPago(query, {
        limit: parsed.limit,
      });
      return res;
    };
  });

  // Tool específica: catalog.clave_producto_servicio.search
  registerTool('catalog.clave_producto_servicio.search', (inj) => {
    const ctx = (inj || contextFactory)();
    const knowledge = makeKnowledgeClient(ctx);

    return async (raw) => {
      const parsed = CatalogSearchInput.parse(raw || {});
      const query = parsed.query || parsed.text;
      const res = await knowledge.searchClaveProductoServicio(query, {
        limit: parsed.limit,
      });
      return res;
    };
  });
}
