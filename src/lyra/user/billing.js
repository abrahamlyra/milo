import FormData from 'form-data';
import { registerTool } from '../../core/nlu/intentRouter.js';

/**
 * ID lógico para este "contrato virtual" dentro del wizard (no es plantilla real).
 * Lo usamos igual que selectedTemplateId en templates, para que fill.* funcione igual.
 */
const BILLING_TID = 'billing.registerRFC';

/**
 * Campos requeridos derivados 100% de tu controlador registerRFC.js
 * (fuente de la verdad). Incluye los 2 archivos (cer/key).
 */
const REQUIRED_FIELDS = [
  'name',
  'razon_social',
  'regimen_fiscal',
  'codigo_postal',
  'calle',
  'exterior',
  'colonia',
  'ciudad',
  'municipio',
  'estado',
  'csd_password',
];

const REQUIRED_FILES = ['cer', 'key'];

/**
 * Construye el "contrato" virtual con tipos/hints básicos.
 * IMPORTANTE: fields como ARRAY (para que fill.missing/formatters lo lean bien).
 */
function buildBillingContract() {
  return {
    id: BILLING_TID,
    type: 'billing.registerRFC',
    title: 'Activar facturación (Registro RFC + CSD)',
    required: [...REQUIRED_FIELDS, ...REQUIRED_FILES],
    fields: [
      { key: 'name',            type: 'string', required: true, label: 'Nombre de organización (Facturapi)' },
      { key: 'razon_social',    type: 'string', required: true, label: 'Razón social' },
      { key: 'regimen_fiscal',  type: 'string', required: true, label: 'Régimen fiscal' },
      { key: 'codigo_postal',   type: 'string', required: true, label: 'Código postal' },
      { key: 'calle',           type: 'string', required: true, label: 'Calle' },
      { key: 'exterior',        type: 'string', required: true, label: 'Número exterior' },
      { key: 'colonia',         type: 'string', required: true, label: 'Colonia' },
      { key: 'ciudad',          type: 'string', required: true, label: 'Ciudad' },
      { key: 'municipio',       type: 'string', required: true, label: 'Municipio' },
      { key: 'estado',          type: 'string', required: true, label: 'Estado' },
      { key: 'csd_password',    type: 'string', required: true, label: 'Contraseña del CSD' },
      { key: 'cer',             type: 'file',   required: true, label: 'Archivo .cer' },
      { key: 'key',             type: 'file',   required: true, label: 'Archivo .key' },
    ],
  };
}

function computeMissing(_contract, provided, metaFiles) {
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    const v = provided?.[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(f);
    }
  }
  for (const k of REQUIRED_FILES) {
    if (!metaFiles?.[k]?.buffer || !metaFiles?.[k]?.filename) {
      missing.push(k);
    }
  }
  return missing;
}

export function registerBillingTools(contextFactory) {
  // 0) billing.missing → faltantes **reales** (incluye cer/key desde sesión)
  registerTool('billing.missing', () => {
    const ctx = contextFactory();
    return async () => {
      const s = ctx.session || {};
      const tid = s.selectedTemplateId;
      if (tid !== BILLING_TID) {
        return { ok: false, reason: 'wrong_context', missing: [], message: 'No estás en el flujo de activación de facturación.' };
      }
      const contract =
        s.contracts?.[tid] ?? s.contract ?? buildBillingContract();

      const provided = (s.provided && s.provided[tid]) || {};
      const files = s.meta?.billing?.files || {};
      const missing = computeMissing(contract, provided, files);
      return { ok: true, missing };
    };
  });

  // 1) billing.contract → setea contrato virtual y TID en sesión
  registerTool('billing.contract', () => {
    const ctx = contextFactory();
    return async () => {
      const s = ctx.session || {};
      const contract = buildBillingContract();

      // Persistimos estilo templates.contract
      s.selectedTemplateId = BILLING_TID;
      s.contract = contract;
      s.contracts = { ...(s.contracts || {}), [BILLING_TID]: contract };
      s.provided = s.provided || {};
      s.provided[BILLING_TID] = s.provided[BILLING_TID] || {};
      s.meta = s.meta || {};
      s.meta.billing = s.meta.billing || { files: {} };

      return {
        ok: true,
        kind: 'billing.contract',
        contract: {
          id: contract.id,
          title: contract.title,
          required: contract.required,
        },
        message:
          'Listo. Ya tengo el contrato de Activación de Facturación.\n' +
          'Puedes escribir: "faltantes facturación", "sugerir", "aplicar", "registrar rfc".\n' +
          'Para subir archivos usa el panel del chat (.cer/.key) y luego pide "faltantes facturación".',
      };
    };
  });

  // 2) billing.register → valida faltantes y POST multipart a tu backend (registerRFC.js)
  registerTool('billing.register', () => {
    const ctx = contextFactory();
    return async () => {
      const s = ctx.session || {};
      const tid = s.selectedTemplateId;
      const contract =
        s.contracts?.[tid] ?? s.contract ?? (tid === BILLING_TID ? buildBillingContract() : null);

      if (tid !== BILLING_TID) {
        return {
          ok: false,
          reason: 'wrong_context',
          message:
            'No estás en el wizard de Activación de Facturación. Escribe "activar facturación" para iniciar.',
        };
      }
      if (!contract) {
        return {
          ok: false,
          reason: 'no_contract',
          message:
            'Contrato de facturación no cargado. Escribe "activar facturación" para cargarlo.',
        };
      }

      const provided = (s.provided && s.provided[tid]) || {};
      const files = s.meta?.billing?.files || {};
      const missing = computeMissing(contract, provided, files);

      if (missing.length > 0) {
        return {
          ok: false,
          reason: 'missing',
          missing,
          message:
            'Aún faltan campos/archivos para continuar. Escribe "faltantes facturación" para verlos y complétalos.',
        };
      }

      // Construir multipart
      const form = new FormData();
      for (const f of REQUIRED_FIELDS) {
        form.append(f, String(provided[f] ?? ''));
      }
      // Adjuntar .cer y .key desde sesión (buffers en memoria)
      form.append('cer', files.cer.buffer, {
        filename: files.cer.filename || 'csd.cer',
        contentType: files.cer.mimetype || 'application/x-x509-ca-cert',
      });
      form.append('key', files.key.buffer, {
        filename: files.key.filename || 'csd.key',
        contentType: files.key.mimetype || 'application/octet-stream',
      });

      // Endpoint real: tu backend que envuelve registerRFC.js
      const url = `${ctx.config.lyraApiUrl}/user/billing/registerRFC`;

      try {
        const { data } = await ctx.http.post(url, form, {
          headers: form.getHeaders(),
          timeout: 60_000,
        });

        // limpiar archivos efímeros tras éxito
        if (s.meta?.billing?.files) {
          s.meta.billing.files = {};
        }

        return {
          ok: true,
          kind: 'billing.register',
          data,
          message:
            '✅ Facturación activada y RFC registrado. Se generaron y guardaron las API keys en backend.',
        };
      } catch (err) {
        const status = err?.response?.status;
        const payload = err?.response?.data;
        return {
          ok: false,
          reason: 'backend_error',
          status,
          error: payload || String(err),
          message:
            '❌ Falló el registro de RFC/CSD en backend. Revisa logs del servicio y los datos enviados.',
        };
      }
    };
  });
}
