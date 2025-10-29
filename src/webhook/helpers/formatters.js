// src/webhook/helpers/formatters.js

export function formatTemplatesList(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const maxShow = 10;
  const lines = items.slice(0, maxShow).map((t, i) => {
    const name = t.name || t.title || t.templateName || `(sin nombre)`;
    const id   = t.id || t.templateId || t._id || '(sin-id)';
    return `  ${i + 1}. ${name} — ${id}`;
  });
  const extra = items.length > maxShow ? `\n… y ${items.length - maxShow} más.` : '';
  const header = items.length
    ? `Encontré ${items.length} templates:\n${lines.join('\n')}${extra}`
    : `No encontré templates con esos filtros.`;
  return `✔️ templates.list OK\n${header}`;
}

export function formatTemplatesContract(result) {
  const reqs = Array.isArray(result?.required) ? result.required : [];
  const fields = Array.isArray(result?.fields) ? result.fields : [];
  const opts = fields.filter(f => !f.required).map(f => f.key);

  const maxShow = 12;
  const reqLines = reqs.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
  const optLines = opts.slice(0, maxShow).map((k, i) => `  ${i + 1}. ${k}`);
  const reqExtra = reqs.length > maxShow ? `\n… y ${reqs.length - maxShow} más.` : '';
  const optExtra = opts.length > maxShow ? `\n… y ${opts.length - maxShow} más.` : '';

  const fieldLines = fields.slice(0, maxShow).map((f, i) => {
    const key = f.key || '(sin-key)';
    const ty  = f.type || 'string';
    const tag = f.required ? 'req' : 'opt';
    const hint = f.hint ? ` — ${f.hint}` : '';
    return `  ${i + 1}. [${tag}] ${key} <${ty}>${hint}`;
  });
  const fieldExtra = fields.length > maxShow ? `\n… y ${fields.length - maxShow} más.` : '';

  return [
    `✔️ templates.contract OK`,
    `Contract para template ${result?.templateId || '(?)'}`,
    reqs.length ? `\nRequeridos (${reqs.length}):\n${reqLines.join('\n')}${reqExtra}` : `\nRequeridos: (ninguno)`,
    opts.length ? `\nOpcionales (${opts.length}):\n${optLines.join('\n')}${optExtra}` : `\nOpcionales: (ninguno)`,
    fields.length ? `\nCampos (${fields.length}):\n${fieldLines.join('\n')}${fieldExtra}` : `\nCampos: (ninguno)`,
    `\nEscribe valores con "key=value" para empezar a llenar, p. ej.:`,
    `  set receptor_rfc=XXX010101XXX`,
    `  set receptor_email=correo@dominio.com`,
  ].join('\n');
}

export function formatFillMissing(result) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  if (!missing.length) return `✔️ Sin faltantes. Ya estás listo para generar.`;
  const lines = missing.map((k, i) => `  ${i + 1}. ${k}`);
  return `✔️ Faltantes (${missing.length}):\n${lines.join('\n')}\n\nTip: usa \`set key=valor\` o \`sugerir\`.`;
}

export function formatFillSuggest(result) {
  const mode = result?.mode || 'min';
  const payload = result?.payload || {};
  const pretty = JSON.stringify(payload, null, 2);
  return `✔️ Sugerencia (${mode})\n\n${pretty}\n\nEscribe **aplicar** para usarla tal cual, o edítala con \`set key=valor\`.`;
}

export function formatFillApply(result) {
  const applied = !!result?.applied;
  const merged  = result?.merged || {};
  const pretty = JSON.stringify(merged, null, 2);
  return applied
    ? `✔️ Sugerencia aplicada.\n\nEstado actual:\n${pretty}\n\nEscribe **faltantes** para verificar si ya quedó listo.`
    : `⚠️ No había sugerencia pendiente. Usa \`sugerir\` primero.`;
}
