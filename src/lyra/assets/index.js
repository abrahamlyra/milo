// src/lyra/assets/index.js
import FormData from 'form-data';
import { registerTool } from '../../core/nlu/intentRouter.js';

const ALLOWED_ASSET_TYPES = ['logo', 'header', 'footer', 'background', 'image'];

/**
 * Normaliza el tipo recibido desde el front / parser
 * a uno de los tipos soportados por el backend.
 *
 * Por ahora exigimos que ya venga en uno de los tipos
 * permitidos; si no, devolvemos null para que el tool
 * responda un mensaje explicando el problema.
 */
function normalizeTipo(rawTipo) {
  if (!rawTipo) return null;
  const t = String(rawTipo).trim().toLowerCase();
  if (!t) return null;

  if (ALLOWED_ASSET_TYPES.includes(t)) {
    return t;
  }

  return null;
}

/**
 * Helpers para leer assets efímeros desde sesión.
 * Estos assets los guarda el router:
 *   src/webhook/routes/assetsUploads.js
 *
 * Estructura esperada:
 *   session.meta.assets[tipo] = {
 *     buffer,
 *     filename,
 *     mimetype,
 *     size,
 *     uploadedAt,
 *   }
 */
function getSessionAssets(session) {
  const s = session || {};
  return s.meta?.assets || {};
}

/**
 * Registro de herramientas para manejo de assets (imágenes, logos, etc.).
 *
 * Tools:
 *   - assets.upload : toma el archivo efímero de sesión y lo manda a /assets/upload
 *   - assets.view   : lee el asset vigente desde /assets/:tipo
 */
export function registerAssetTools(contextFactory) {
  /**
   * assets.upload
   *
   * Espera que el parser / front le pase un input con:
   *   { tipo: 'logo' | 'header' | 'footer' | 'background' | 'image' }
   *
   * Y que el archivo correspondiente se haya subido antes vía:
   *   POST /milo/assets/upload?tipo=<tipo>&sid=<sessionId>
   */
  registerTool('assets.upload', () => {
    const ctx = contextFactory();

    return async (input = {}) => {
      const s = ctx.session || {};
      const rawTipo =
        input.tipo ??
        input.assetType ??
        input.rawTipo ??
        null;

      if (!rawTipo) {
        return {
          ok: false,
          reason: 'missing_tipo',
          message:
            'No se recibió el tipo de asset. Indica algo como: tipo=logo, tipo=header, tipo=footer, tipo=background o tipo=image.',
        };
      }

      const tipo = normalizeTipo(rawTipo);
      if (!tipo) {
        return {
          ok: false,
          reason: 'invalid_tipo',
          message:
            `Tipo de asset no soportado: "${rawTipo}". Tipos permitidos: ${ALLOWED_ASSET_TYPES.join(', ')}.`,
        };
      }

      const assets = getSessionAssets(s);
      const meta = assets[rawTipo] || assets[tipo] || null;

      if (!meta || !meta.buffer) {
        return {
          ok: false,
          reason: 'missing_file',
          message:
            `No tengo ningún archivo cargado en sesión para el tipo "${rawTipo}". ` +
            'Primero sube el archivo usando el panel de assets del chat y luego vuelve a intentar.',
        };
      }

      const form = new FormData();
      form.append('tipo', tipo);
      form.append('file', meta.buffer, {
        filename: meta.filename || `${tipo}.bin`,
        contentType: meta.mimetype || 'application/octet-stream',
      });

      try {
        const res = await ctx.http.post('/assets/upload', form, {
          headers: form.getHeaders(),
        });

        const data = res?.data || {};
        const {
          tipo: respTipo,
          version,
          url,
          assetId,
          msg,
        } = data;

        return {
          ok: true,
          tipo: respTipo || tipo,
          version: typeof version === 'number' ? version : null,
          url: url || null,
          assetId: assetId ?? null,
          backendMessage: msg || null,
          message:
            msg ||
            `Asset "${respTipo || tipo}" subido y versionado correctamente.` +
              (url ? `\nURL: ${url}` : ''),
        };
      } catch (err) {
        const status = err?.response?.status;
        const be = err?.response?.data;

        const beMsg = be?.msg || be?.message || be?.error || be;
        const detail = beMsg ? String(beMsg) : String(err);

        return {
          ok: false,
          reason: 'backend_error',
          status: status || 500,
          error: be || String(err),
          message: `❌ Falló la subida del asset. ${detail}`,
        };
      }
    };
  });

  /**
   * assets.view
   *
   * Lee el asset vigente desde el backend.
   *
   * Input esperado:
   *   { tipo: 'logo' | 'header' | 'footer' | 'background' | 'image' }
   *
   * Para logo, si no hay nada aún, el backend regresará el logo default de Lyra.
   */
  registerTool('assets.view', () => {
    const ctx = contextFactory();

    return async (input = {}) => {
      const rawTipo =
        input.tipo ??
        input.assetType ??
        input.rawTipo ??
        null;

      if (!rawTipo) {
        return {
          ok: false,
          reason: 'missing_tipo',
          message:
            'No se recibió el tipo de asset para consultar. Indica algo como: tipo=logo, tipo=header, tipo=footer, tipo=background o tipo=image.',
        };
      }

      const tipo = normalizeTipo(rawTipo);
      if (!tipo) {
        return {
          ok: false,
          reason: 'invalid_tipo',
          message:
            `Tipo de asset no soportado para consulta: "${rawTipo}". Tipos permitidos: ${ALLOWED_ASSET_TYPES.join(', ')}.`,
        };
      }

      // Para logo usamos el endpoint dedicado /assets/logo
      const path = tipo === 'logo'
        ? '/assets/logo'
        : `/assets/${tipo}`;

      try {
        const res = await ctx.http.get(path);
        const data = res?.data || {};
        const {
          tipo: respTipo,
          url,
          default: isDefault,
        } = data;

        const finalTipo = respTipo || tipo;
        const isLyraDefault = Boolean(isDefault) && finalTipo === 'logo';

        let message;
        if (isLyraDefault) {
          message =
            'Todavía no tienes un logo propio registrado. ' +
            'Se está usando el logo default de Lyra.' +
            (url ? `\nURL: ${url}` : '');
        } else if (!url) {
          message =
            `No se recibió URL para el asset "${finalTipo}". ` +
            'Verifica la configuración en el backend.';
        } else {
          message = `Asset "${finalTipo}" vigente:\n${url}`;
        }

        return {
          ok: true,
          tipo: finalTipo,
          url: url || null,
          default: Boolean(isDefault),
          message,
        };
      } catch (err) {
        const status = err?.response?.status;
        const be = err?.response?.data;

        // Si backend dice 404 para tipos sin default
        if (status === 404) {
          const beMsg = be?.msg || be?.message || be?.error || be;
          return {
            ok: false,
            reason: 'not_found',
            status: 404,
            error: be || String(err),
            message:
              beMsg
                ? `No hay asset registrado para el tipo "${tipo}". Detalle: ${beMsg}`
                : `No hay asset registrado para el tipo "${tipo}".`,
          };
        }

        const beMsg = be?.msg || be?.message || be?.error || be;
        const detail = beMsg ? String(beMsg) : String(err);

        return {
          ok: false,
          reason: 'backend_error',
          status: status || 500,
          error: be || String(err),
          message: `❌ Error consultando asset "${tipo}". ${detail}`,
        };
      }
    };
  });
}
