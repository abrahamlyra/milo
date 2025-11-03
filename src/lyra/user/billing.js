// src/lyra/user/billing.js
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
 * No invadimos templates.*, mantenemos todo encapsulado en billing.*
 */
function buildBillingContract() {
  return {
    id: BILLING_TID,
    type: 'billing.registerRFC',
    title: 'Activar facturación (Registro RFC + CSD)',
    required: [...REQUIRED_FIELDS, ...REQUIRED_FILES],
    fields: {
      name: { type: 'string', label: 'Nombre de organización (Facturapi)' },
      razon_social: { type: 'string', label: 'Razón social' },
      regimen_fiscal: { type: 'string', label: 'Régimen fiscal' },
      codigo_postal: { type: 'string', label: 'Código postal' },
      calle: { type: 'string', label: 'Calle' },
      exterior: { type: 'string', label: 'Número exterior' },
      colonia: { type: 'string', label: 'Colonia' },
      ciudad: { type: 'string', label: 'Ciudad' },
      municipio: { type: 'string', label: 'Municipio' },
      estado: { type: 'string', label: 'Estado' },
      csd_password: { type: 'string', label: 'Contraseña del CSD' },
      cer: { type: 'file', label: 'Archivo .cer' },
      key: { type: 'file', label: 'Archivo .key' },
    },
  };
}

function computeMissing(contract, provided, metaFiles) {
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
          'Puedes escribir: "faltantes", "sugerir", "aplicar", "registrar rfc".\n' +
          'Para subir archivos usa el endpoint de upload del bot (cer/key) y luego vuelve a pedir "faltantes".',
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
            'Aún faltan campos/archivos para continuar. Escribe "faltantes" para verlos y complétalos.',
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
      // Ajusta SOLO el path si fuera distinto. La baseURL viene de config.lyraApiUrl.
      const url = `${ctx.config.lyraApiUrl}/user/billing/registerRFC`;

      try {
        const { data } = await ctx.http.post(url, form, {
          headers: form.getHeaders(),
          timeout: 60_000,
        });

        // Opcional: limpiar archivos efímeros tras éxito
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
