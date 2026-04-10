// src/ai/brain/conversationalFill.js
//
// Flujo conversacional inteligente para llenado de documentos.
// - Recibe el contrato con sus fields exactos
// - Agrupa campos y conversa en máximo 5 rondas
// - Resuelve campos implícitos (ej: si es simple → notaría N/A automático)
// - Pregunta colores al final (default o personalizados)
// - Siempre pide correo antes de generar
// - Cuando tiene todo devuelve { done: true, payload, email } con keys exactos del contrato

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const COLOR_DEFAULTS = {
  color_fondo:           '#FFFFFF',
  color_fondo_oscuro:    '#F5F5F5',
  color_fondo_cards:     '#FAFAFA',
  color_texto_hero:      '#111111',
  color_titulo_h1:       '#1a1a2e',
  color_titulo_seccion:  '#16213e',
  color_subtitulo:       '#444444',
  color_parrafo:         '#555555',
  color_acento:          '#0066CC',
  color_bordes:          '#DDDDDD',
};

function groupFields(fields) {
  const required = fields.filter(f =>
    f?.required && !String(f?.key || '').startsWith('color_')
  );
  const MODAL_HINTS = ['instrumento', 'tipo', 'modalidad', 'clase', 'forma'];
  const modalFields = required.filter(f =>
    MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );
  const regularFields = required.filter(f =>
    !MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );
  const groups = new Map();
  for (const f of regularFields) {
    const prefix = f.key.includes('_') ? f.key.split('_')[0] : 'general';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(f);
  }
  return { modalFields, groups };
}

function buildFieldsContext(fields) {
  return fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => `${f.key} (${f.type || 'text'})`)
    .join(', ');
}

async function resolveImpliedFields({ openai, fields, collected }) {
  const allRequired = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);
  const missing = allRequired.filter(k => {
    const v = collected[k];
    return v === undefined || v === null || v === '';
  });
  if (missing.length === 0) return {};

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'Eres un asistente que resuelve campos implícitos en formularios de documentos legales.',
          'Dado un conjunto de valores ya recopilados y una lista de campos faltantes,',
          'determina cuáles de los campos faltantes quedan automáticamente resueltos o no aplican',
          'basándote en los valores ya dados.',
          '',
          'LÓGICA GENERAL (aplica para cualquier template):',
          '- Analiza semánticamente los valores ya recopilados y los campos faltantes.',
          '- Si el valor de un campo condicional indica que algo NO aplica (ej: "simple", "ninguno", "no", "sin X", false) → rellena con "N/A" los campos que claramente dependen de esa condición.',
          '- Si el valor indica que SÍ aplica (ej: "sí", "con X", true, o cualquier valor afirmativo) → NO resuelvas automáticamente los campos relacionados, el usuario debe proporcionarlos.',
          '- Usa el nombre y contexto semántico de cada campo para inferir dependencias.',
          '- Si no estás seguro de la relación entre campos, NO los resuelvas — devuelve {} para ese campo.',
          '',
          'Responde SOLO con JSON de campos que puedes resolver automáticamente.',
          'Solo incluye campos de la lista de faltantes. No inventes campos nuevos.',
          'Si no puedes resolver ninguno, responde: {}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ collected, missing }),
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (missing.includes(k) && v !== null && v !== undefined) {
        clean[k] = v;
      }
    }
    console.log('[ConvFill] impliedFields:', JSON.stringify(clean));
    return clean;
  } catch {
    return {};
  }
}

async function extractFieldsFromMessage({ openai, message, history, allowedKeys, fieldsContext, collectedSoFar }) {
  const alreadyCollected = Object.keys(collectedSoFar).join(', ') || 'ninguno';

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'Eres un extractor de datos para formularios de documentos legales.',
          'Tu tarea es extraer los valores que el usuario proporcionó y mapearlos a los campos correctos.',
          '',
          'REGLAS:',
          '- Solo usa los campos de la lista permitida. NUNCA inventes campos nuevos.',
          '- Extrae TODOS los valores que el usuario dio aunque los haya mezclado.',
          '- Fechas → formato YYYY-MM-DD.',
          '- "sí/si/yes" → true, "no" → false para booleanos.',
          '- "N/A", "ninguno", "no aplica", "no hay" → "N/A".',
          '- "sin limitaciones" → "ninguna".',
          '- "simple" para instrumento → "simple".',
          '- Sé agresivo — si el usuario dio info que claramente corresponde a un campo, mapeála.',
          '- Analiza el historial completo para entender qué pregunta respondía el usuario.',
          '',
          `Campos ya recopilados (NO los repitas): ${alreadyCollected}`,
          `Campos permitidos (EXACTAMENTE estos nombres): ${fieldsContext}`,
          '',
          'Responde SOLO con JSON de campos NUEVOS: { "campo_exacto": "valor", ... }',
          'Si no hay nada nuevo: {}',
        ].join('\n'),
      },
      ...history,
      { role: 'user', content: String(message ?? '') },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (allowedKeys.includes(k) && v !== null && v !== undefined) {
        clean[k] = v;
      }
    }
    console.log('[ConvFill] extracted:', JSON.stringify(clean));
    return clean;
  } catch {
    return {};
  }
}

async function buildNextQuestion({ openai, history, message, pendingGroups, collectedSoFar, documentName, isFirstQuestion }) {
  const groupLines = pendingGroups.map(([prefix, fields]) => {
    const labels = fields.map(f => f.label || f.key).join(', ');
    return `  Grupo "${prefix}": ${labels}`;
  }).join('\n');

  const collectedCount = Object.keys(collectedSoFar).length;
  const confirmLine = !isFirstQuestion && collectedCount > 0
    ? `Ya tengo ${collectedCount} dato${collectedCount > 1 ? 's' : ''}.`
    : '';

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: [
          'Eres Milo, asistente de Lyra Suite.',
          `Estás ayudando al usuario a llenar el documento "${documentName}".`,
          'Haz UNA SOLA PREGUNTA conversacional y natural que cubra el mayor número posible de campos relacionados.',
          '',
          'REGLAS:',
          '- Una pregunta por turno cubriendo todos los campos de un grupo.',
          '- Sin listas, bullets ni headers.',
          '- Fluido y conversacional.',
          '- Si es la primera pregunta y hay campos de modalidad, pregunta eso PRIMERO.',
          confirmLine ? `- Empieza con: "${confirmLine}"` : '',
          '',
          `Grupos de campos pendientes:\n${groupLines}`,
        ].filter(Boolean).join('\n'),
      },
      ...history,
      { role: 'user', content: String(message ?? '') },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() ||
    `¿Puedes darme los datos del grupo "${pendingGroups[0]?.[0]}"?`;
}

export async function runConversationalFill({
  openai,
  contract,
  history,
  message,
  collectedSoFar = {},
  round = 0,
  stage = 'filling',
}) {
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];
  const documentName = contract?.name || 'el documento';

  const allowedKeys = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);

  const fieldsContext = buildFieldsContext(fields);
  const { modalFields, groups } = groupFields(fields);
  const colorFields = fields.filter(f => f?.required && String(f?.key || '').startsWith('color_'));

  // ── Etapa: email ──────────────────────────────────────────────────────────
  if (stage === 'email') {
    const emailMatch = String(message ?? '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const noEmail = /sin\s*correo|no\s*correo|solo\s*pdf|no\s*quiero/i.test(String(message ?? ''));

    if (emailMatch) {
      return { done: true, payload: collectedSoFar, email: emailMatch[0] };
    }
    if (noEmail) {
      return { done: true, payload: collectedSoFar, email: null };
    }
    return {
      done: false,
      stage: 'email',
      collected: collectedSoFar,
      reply: '¿A qué correo te enviamos el documento? (O escribe `sin correo` para solo generar el PDF.)',
    };
  }

  // ── Etapa: colors ─────────────────────────────────────────────────────────
  if (stage === 'colors') {
    const msgLower = String(message ?? '').toLowerCase();
    const isDefault =
      msgLower.includes('default') ||
      msgLower.includes('predeterminado') ||
      msgLower.includes('estandar') ||
      msgLower.includes('estándar') ||
      msgLower.includes('así está bien') ||
      msgLower.includes('asi esta bien') ||
      msgLower.includes('los de default') ||
      msgLower.includes('no importa');

    const withColors = { ...collectedSoFar };

    if (!isDefault) {
      // Intentar extraer colores del mensaje
      const colorKeys = colorFields.map(f => f.key);
      const colorContext = colorFields.map(f => `${f.key} (text)`).join(', ');
      const extracted = await extractFieldsFromMessage({
        openai, message, history,
        allowedKeys: colorKeys,
        fieldsContext: colorContext,
        collectedSoFar,
      });
      Object.assign(withColors, extracted);
    }

    // Rellenar los que falten con default
    for (const f of colorFields) {
      if (!withColors[f.key]) withColors[f.key] = COLOR_DEFAULTS[f.key] || '#000000';
    }

    return {
      done: false,
      stage: 'email',
      collected: withColors,
      reply: '¿A qué correo te enviamos el documento? (O escribe `sin correo` para solo generar el PDF.)',
    };
  }

  // ── Etapa: filling ────────────────────────────────────────────────────────
  let newCollected = { ...collectedSoFar };

  if (round > 0) {
    const extracted = await extractFieldsFromMessage({
      openai, message, history,
      allowedKeys, fieldsContext,
      collectedSoFar: newCollected,
    });
    newCollected = { ...newCollected, ...extracted };

    const implied = await resolveImpliedFields({ openai, fields, collected: newCollected });
    newCollected = { ...newCollected, ...implied };
  }

  const missingRequired = allowedKeys.filter(k => {
    const v = newCollected[k];
    return v === undefined || v === null || v === '';
  });

  console.log('[ConvFill] round:', round, 'missing:', missingRequired.length, missingRequired);

  if (missingRequired.length === 0) {
    const hasColors = colorFields.every(f => !!newCollected[f.key]);
    if (hasColors) {
      return {
        done: false,
        stage: 'email',
        collected: newCollected,
        reply: '¿A qué correo te enviamos el documento? (O escribe `sin correo` para solo generar el PDF.)',
      };
    }
    return {
      done: false,
      stage: 'colors',
      collected: newCollected,
      reply: '¡Ya tengo todos los datos! ¿Quieres usar los colores predeterminados o personalizarlos? Escribe `default` para el diseño estándar.',
    };
  }

  // Construir grupos pendientes
  const pendingGroups = [];
  const pendingModal = modalFields.filter(f => missingRequired.includes(f.key));
  if (pendingModal.length > 0) pendingGroups.push(['tipo', pendingModal]);

  for (const [prefix, gFields] of groups.entries()) {
    const pending = gFields.filter(f => missingRequired.includes(f.key));
    if (pending.length > 0) pendingGroups.push([prefix, pending]);
  }

  if (pendingGroups.length === 0) {
    return {
      done: false,
      stage: 'email',
      collected: newCollected,
      reply: '¿A qué correo te enviamos el documento? (O escribe `sin correo` para solo generar el PDF.)',
    };
  }

  const reply = await buildNextQuestion({
    openai, history, message,
    pendingGroups,
    collectedSoFar: newCollected,
    documentName,
    isFirstQuestion: round === 0,
  });

  return { done: false, stage: 'filling', reply, collected: newCollected };
}