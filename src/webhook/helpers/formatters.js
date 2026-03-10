// src/webhook/helpers/formatters.js

export function formatTemplatesList(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const maxShow = 10;
  const lines = items.slice(0, maxShow).map((t, i) => {
    const name = t.name || t.title || t.templateName || `(sin nombre)`;
    const id = t.id || t.templateId || t._id || '(sin-id)';
    return `  ${i + 1}. ${name} — ${id}`;
  });
  const extra = items.length > maxShow ? `\n… y ${items.length - maxShow} más.` : '';
  const header = items.length
    ? `Encontré ${items.length} templates:\n${lines.join('\n')}${extra}`
    : `No encontré templates con esos filtros.`;
  return `✔️ templates.list OK\n${header}`;
}

export function formatTemplatesContract(result) {
  // ✅ si el contract/gate viene con needsEmitter, damos UX útil sin depender del front
  const reason = String(result?.reason || '').trim();
  const needsEmitter = result?.needsEmitter === true || reason === 'needs_emitter';
  if (needsEmitter) {
    const emitters = Array.isArray(result?.emitters) ? result.emitters : [];
    const lines = emitters.slice(0, 10).map((e, i) => {
      const alias = e?.alias || '(sin-alias)';
      const rfc = e?.rfc ? ` — ${e.rfc}` : '';
      const id = e?.id || '(sin-id)';
      return `  ${i + 1}. ${alias}${rfc} — ${id}`;
    });
    const extra = emitters.length > 10 ? `\n… y ${emitters.length - 10} más.` : '';
    return [
      `⚠️ Necesitas escoger un emisor (RFC) para continuar.`,
      emitters.length ? `\nEmitters disponibles (${emitters.length}):\n${lines.join('\n')}${extra}` : `\nNo hay emitters disponibles para esta organización.`,
      `\nUsa: "elegir emisor <id>"`,
    ].join('\n');
  }

  const reqs = Array.isArray(result?.required) ? result.required : [];
  const fields = Array.isArray(result?.fields) ? result.fields : [];

  const maxShow = 12;
  // Mostrar label del campo cuando esté disponible (más amigable que la clave técnica)
  const reqLines = reqs.slice(0, maxShow).map((k, i) => {
    const fieldSpec = fields.find((f) => f.key === k);
    const label = fieldSpec?.label || k;
    return `  ${i + 1}. ${label}`;
  });
  const reqExtra = reqs.length > maxShow ? `\n… y ${reqs.length - maxShow} más.` : '';

  // Pregunta conversacional: pide el primer campo usando su label
  const firstReq = reqs[0] || null;
  const firstField = firstReq ? fields.find((f) => f.key === firstReq) : null;
  const firstLabel = firstField?.label || firstReq;
  const ask = firstReq
    ? `\n\n¿Cuál es el **${firstLabel}**?`
    : '\n\nEscribe `generar` cuando tengas todo listo.';

  const parts = [
    `¡Listo! Seleccioné la plantilla. Necesito ${reqs.length} dato${reqs.length !== 1 ? 's' : ''} para generar el documento:`,
    reqs.length ? `\n${reqLines.join('\n')}${reqExtra}` : '',
    ask,
  ];

  return parts.filter(Boolean).join('\n');
}

export function formatFillMissing(result) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  if (!missing.length) return `✔️ Sin faltantes. Escribe \`generar\` para generar el documento.`;
  const lines = missing.map((k, i) => `  ${i + 1}. ${k}`);
  const firstMissing = missing[0];
  const ask = firstMissing ? `\n\n¿Cuál es el **${firstMissing}**?` : '';
  return `Faltan ${missing.length} campo${missing.length !== 1 ? 's' : ''}:\n${lines.join('\n')}${ask}`;
}

export function formatFillSuggest(result) {
  const mode = result?.mode || 'min';
  const payload = result?.payload || {};
  const pretty = JSON.stringify(payload, null, 2);
  return `✔️ Sugerencia (${mode})\n\n${pretty}\n\nEscribe **aplicar** para usarla tal cual, o edítala con \`set key=valor\`.`;
}

export function formatFillApply(result) {
  const applied = !!result?.applied;
  const merged = result?.merged || {};
  const pretty = JSON.stringify(merged, null, 2);
  return applied
    ? `✔️ Sugerencia aplicada.\n\nEstado actual:\n${pretty}\n\nEscribe **faltantes** para verificar si ya quedó listo.`
    : `⚠️ No había sugerencia pendiente. Usa \`sugerir\` primero.`;
}

/**
 * documents.create formatter (nuevo, tolerante a errores)
 * Espera un objeto { ok, id?, url?, reason?, missing?, status?, detail? }
 */
export function formatDocumentsCreate(result) {
  if (!result || result.ok === undefined) {
    return '❓ documents.create: resultado desconocido.';
  }

  if (result.ok) {
    const id = result.id || '(sin-id)';
    const url = result.url ? `\n🔗 Link: ${result.url}` : '';
    return `✔️ Documento generado\nID: ${id}${url}`;
  }

  // errores conocidos
  if (result.reason === 'missing') {
    const m = Array.isArray(result.missing) ? result.missing.join(', ') : '(?)';
    return `❌ No se pudo generar: faltan campos requeridos → ${m}`;
  }

  if (result.reason === 'api_error') {
    const st = result.status || 0;
    const d =
      typeof result.detail === 'string'
        ? result.detail
        : (result.detail?.message || JSON.stringify(result.detail));
    return `❌ La API rechazó la solicitud (HTTP ${st}).\n↳ ${d}`;
  }

  return `❌ No se pudo generar (error desconocido).`;
}

// ➕ Nuevo: formateador para invoices.create
export function formatInvoicesCreate(result) {
  if (!result || result.ok === undefined) return '❓ invoices.create: resultado desconocido.';

  // ✅ needs_emitter / needsEmitter
  const reason = String(result?.reason || '').trim();
  const needsEmitter = result?.needsEmitter === true || reason === 'needs_emitter';
  if (needsEmitter) {
    const emitters = Array.isArray(result?.emitters) ? result.emitters : [];
    const lines = emitters.slice(0, 10).map((e, i) => {
      const alias = e?.alias || '(sin-alias)';
      const rfc = e?.rfc ? ` — ${e.rfc}` : '';
      const id = e?.id || '(sin-id)';
      return `  ${i + 1}. ${alias}${rfc} — ${id}`;
    });
    const extra = emitters.length > 10 ? `\n… y ${emitters.length - 10} más.` : '';
    return [
      '⚠️ Necesitas escoger un emisor (RFC) antes de timbrar la factura.',
      emitters.length ? `\nEmitters disponibles (${emitters.length}):\n${lines.join('\n')}${extra}` : `\nNo hay emitters disponibles para esta organización.`,
      '\nUsa: "elegir emisor <id>"',
    ].join('\n');
  }

  if (result.ok) {
    const id = result.id ? `ID: ${result.id}\n` : '';
    const uuid = result.uuid ? `UUID: ${result.uuid}\n` : '';
    const link = result.pdfUrl ? `🔗 PDF: ${result.pdfUrl}` : '';
    const xml = result.xmlUrl ? `\n🧾 XML: ${result.xmlUrl}` : '';
    return `✅ ¡Factura timbrada y generada!\n${id}${uuid}${link}${xml}`.trim();
  }

  if (result.reason === 'wrong_type') {
    return `⚠️ La plantilla actual no es de factura. ${result.message || ''}`.trim();
  }

  if (result.reason === 'missing') {
    const m = Array.isArray(result.missing) ? result.missing.join(', ') : '(?)';
    return `❌ No se pudo facturar: faltan campos requeridos → ${m}`;
  }

  if (result.reason === 'api_error') {
    const st = result.status || 0;
    const d =
      typeof result.detail === 'string'
        ? result.detail
        : (result.detail?.message || JSON.stringify(result.detail));
    return `❌ La API de facturación rechazó la solicitud (HTTP ${st}).\n↳ ${d}`;
  }

  return `❌ No se pudo facturar (error desconocido).`;
}

/* === NUEVOS: formatters para wizard de Activar facturación (billing) === */
export function formatBillingContract(resp) {
  const r = resp || {};
  const reqs = (r.contract?.required || []).join(', ');
  return [
    '🧩 Activación de facturación lista.',
    `Requeridos: ${reqs || '(desconocidos)'}`,
    'Usa: "faltantes", "sugerir", "aplicar", "registrar rfc".',
  ].join('\n');
}

export function formatBillingRegister(resp) {
  if (resp?.ok) {
    return '✅ Facturación activada: RFC registrado y CSD cargado correctamente.';
  }
  if (resp?.reason === 'missing') {
    return `⚠️ Aún faltan: ${resp.missing.join(', ')}`;
  }
  return `❌ Error activando facturación.\n${resp?.message || ''}`;
}