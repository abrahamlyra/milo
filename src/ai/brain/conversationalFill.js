// src/ai/brain/conversationalFill.js

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function groupFields(fields, conditionalKeys) {
  const required = fields.filter(f =>
    f?.required && !String(f?.key || '').startsWith('color_')
  );

  // Campos condicionales vienen de contract.conditional_fields — son los booleanos de BD
  // También detectamos por MODAL_HINTS como fallback
  const MODAL_HINTS = ['instrumento', 'tipo', 'modalidad', 'clase', 'forma'];
  const modalFields = required.filter(f =>
    conditionalKeys.includes(f.key) ||
    MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );
  const regularFields = required.filter(f =>
    !conditionalKeys.includes(f.key) &&
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

async function resolveImpliedFields({ openai, fields, collected, conditionalFields }) {
  const allRequired = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);
  const missing = allRequired.filter(k => {
    const v = collected[k];
    return v === undefined || v === null || v === '';
  });
  if (missing.length === 0) return {};

  // Construir contexto de campos condicionales para que el LLM entienda las dependencias
  const conditionalContext = conditionalFields.length > 0
    ? `Campos condicionales del documento (booleanos que controlan secciones): ${conditionalFields.join(', ')}.`
    : '';

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
          'determina cuáles quedan automáticamente resueltos o no aplican basándote en los valores dados.',
          '',
          conditionalContext,
          '',
          'LÓGICA:',
          '- Si el valor de un campo indica que algo NO aplica ("simple", "ninguno", "no", false, "N/A") →',
          '  rellena con "N/A" los campos que semánticamente dependen de esa condición.',
          '- Si el valor indica que SÍ aplica ("sí", true, cualquier valor afirmativo específico) →',
          '  NO resuelvas automáticamente los campos relacionados — el usuario los debe dar.',
          '- Usa el nombre semántico de los campos para inferir dependencias.',
          '- Si no estás seguro, NO resuelvas — devuelve {} para ese campo.',
          '- NUNCA resuelvas campos de datos principales (nombres, fechas, montos, identificaciones).',
          '',
          'Responde SOLO con JSON de campos resueltos automáticamente.',
          'Solo incluye campos de la lista de faltantes. No inventes campos nuevos.',
          'Si no puedes resolver ninguno: {}',
        ].filter(Boolean).join('\n'),
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

async function extractFieldsFromMessage({ openai, message, history, allowedKeys, fieldsContext, collectedSoFar, conditionalFields }) {
  const alreadyCollected = Object.keys(collectedSoFar).join(', ') || 'ninguno';
  const conditionalContext = conditionalFields.length > 0
    ? `Campos condicionales (booleanos): ${conditionalFields.join(', ')}. Para estos campos, "sí/notariada/con X" → true, "no/simple/sin X" → false.`
    : '';

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'Eres un extractor de datos para formularios de documentos legales.',
          'Extrae los valores que el usuario proporcionó y mapéalos a los campos correctos.',
          '',
          'REGLAS:',
          '- Solo usa los campos de la lista permitida. NUNCA inventes campos nuevos.',
          '- Extrae TODOS los valores que el usuario dio aunque los haya mezclado.',
          '- Fechas → formato YYYY-MM-DD.',
          '- "N/A", "ninguno", "no aplica", "no hay" → "N/A".',
          '- "sin limitaciones" → "ninguna".',
          '- Sé agresivo — si el usuario dio info que claramente corresponde a un campo, mapeála.',
          '- Analiza el historial completo para entender qué pregunta respondía el usuario.',
          conditionalContext,
          '',
          `Campos ya recopilados (NO los repitas): ${alreadyCollected}`,
          `Campos permitidos (EXACTAMENTE estos nombres): ${fieldsContext}`,
          '',
          'Responde SOLO con JSON de campos NUEVOS: { "campo_exacto": "valor", ... }',
          'Si no hay nada nuevo: {}',
        ].filter(Boolean).join('\n'),
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

async function buildNextQuestion({ openai, history, message, pendingGroups, collectedSoFar, documentName, isFirstQuestion, conditionalFields }) {
  const groupLines = pendingGroups.map(([prefix, fields]) => {
    const labels = fields.map(f => f.label || f.key).join(', ');
    return `  Grupo "${prefix}": ${labels}`;
  }).join('\n');

  const collectedCount = Object.keys(collectedSoFar).length;
  const confirmLine = !isFirstQuestion && collectedCount > 0
    ? `Ya tengo ${collectedCount} dato${collectedCount > 1 ? 's' : ''}.`
    : '';

  const conditionalContext = conditionalFields.length > 0
    ? `Campos condicionales del documento: ${conditionalFields.join(', ')}. Si alguno está en los grupos pendientes, pregúntalo PRIMERO explicando brevemente qué implica cada opción.`
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
          conditionalContext,
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

  // conditional_fields vienen del contrato (ya los expone el backend desde BD)
  const conditionalFields = Array.isArray(contract?.conditional_fields)
    ? contract.conditional_fields
    : [];

  const allowedKeys = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);

  const fieldsContext = buildFieldsContext(fields);
  const { modalFields, groups } = groupFields(fields, conditionalFields);
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
      msgLower.includes('no importa') ||
      msgLower.includes('los mismos') ||
      msgLower.includes('igual');

    const withColors = { ...collectedSoFar };

    if (!isDefault) {
      const colorKeys = colorFields.map(f => f.key);
      const colorContext = colorFields.map(f => `${f.key} (text)`).join(', ');
      const extracted = await extractFieldsFromMessage({
        openai, message, history,
        allowedKeys: colorKeys,
        fieldsContext: colorContext,
        collectedSoFar,
        conditionalFields: [],
      });
      Object.assign(withColors, extracted);
    }

    // Los que no se dieron — no pasar nada, el HTML tiene sus defaults en :root
    // Solo pasamos los que el usuario personalizó explícitamente

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
      conditionalFields,
    });
    newCollected = { ...newCollected, ...extracted };

    // Resolver implícitos solo cuando hay suficiente contexto
    if (Object.keys(newCollected).length >= 3) {
      const implied = await resolveImpliedFields({
        openai, fields,
        collected: newCollected,
        conditionalFields,
      });
      newCollected = { ...newCollected, ...implied };
    }
  }

  const missingRequired = allowedKeys.filter(k => {
    const v = newCollected[k];
    return v === undefined || v === null || v === '';
  });

  console.log('[ConvFill] round:', round, 'missing:', missingRequired.length, missingRequired);

  if (missingRequired.length === 0) {
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
    conditionalFields,
  });

  return { done: false, stage: 'filling', reply, collected: newCollected };
}