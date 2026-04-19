// src/ai/brain/conversationalFill.js

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Extrae colores del :root del HTML del template.
 * --fondo → color_fondo, --acento → color_acento, etc.
 */
export function extractColorsFromHtml(html) {
  const colors = {};
  if (!html) return colors;
  const rootPattern = /:root\s*{([^}]*)}/g;
  let match;
  while ((match = rootPattern.exec(html)) !== null) {
    const block = match[1];
    const varPattern = /--([a-zA-Z_][a-zA-Z0-9_]*):\s*([^;]+);/g;
    let varMatch;
    while ((varMatch = varPattern.exec(block)) !== null) {
      const key = `color_${varMatch[1].trim()}`;
      const val = varMatch[2].trim();
      if (!colors[key]) colors[key] = val;
    }
  }
  return colors;
}

function groupFields(fields, conditionalKeys) {
  const required = fields.filter(f =>
    f?.required && !String(f?.key || '').startsWith('color_')
  );

  const MODAL_HINTS = ['instrumento', 'tipo', 'modalidad', 'clase'];
  const requiredKeySet = new Set(required.map(f => f.key));

  // Campos modales que SÍ están en required
  const modalFieldsFromRequired = required.filter(f =>
    conditionalKeys.includes(f.key) ||
    MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );

  // Campos virtuales: conditional_fields que NO están en required
  // Ejemplo: incluye_aval, incluye_interes_moratorio en el Pagaré
  const virtualModals = conditionalKeys
    .filter(k => !requiredKeySet.has(k))
    .map(k => ({ key: k, label: k, type: 'boolean', required: true, _virtual: true }));

  const modalFields = [...modalFieldsFromRequired, ...virtualModals];
  const modalKeySet = new Set(modalFields.map(f => f.key));

  const regularFields = required.filter(f => !modalKeySet.has(f.key));

  // Agrupar en bloques de máximo 5 campos RESPETANDO el orden del template.
  // No agrupamos por prefijo — el orden del array fields ya viene del HTML.
  const GROUP_SIZE = 5;
  const groups = new Map();
  for (let i = 0; i < regularFields.length; i += GROUP_SIZE) {
    const chunk = regularFields.slice(i, i + GROUP_SIZE);
    // La clave del grupo es el índice para preservar orden en el Map
    const groupKey = `grupo_${Math.floor(i / GROUP_SIZE)}`;
    groups.set(groupKey, chunk);
  }

  return { modalFields, groups };
}

function buildFieldsContext(fields) {
  return fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => `${f.key} (${f.type || 'text'})`)
    .join(', ');
}

async function resolveImpliedFields({ openai, fields, collected, conditionalFields, missingOverride }) {
  const allRequired = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);
  const missing = missingOverride || allRequired.filter(k => {
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
          '- Solo resuelves un campo automáticamente si hay evidencia EXPLÍCITA Y DIRECTA en los valores recopilados.',
          '- Si el valor de un campo indica que algo NO aplica ("simple", "ninguno", "no", false, "N/A") →',
          '  rellena con "N/A" ÚNICAMENTE los campos que semánticamente dependen de ESA condición específica.',
          '- Si el valor indica que SÍ aplica ("sí", true, cualquier valor afirmativo específico) →',
          '  NO resuelvas automáticamente los campos relacionados — el usuario los debe dar.',
          '- Si el mensaje del usuario es una frase vaga o negación general ("lo demás no", "eso no aplica", "nada más") →',
          '  devuelve {} — NO resuelvas nada.',
          '- Usa el nombre semántico de los campos para inferir dependencias SOLO cuando la relación es obvia.',
          '- Si no estás completamente seguro, NO resuelvas — devuelve {} para ese campo.',
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

  // Fecha real con UTC para evitar el bug de Cloud Run
  const _d = new Date();
  const fechaHoy = `${_d.getUTCFullYear()}-${String(_d.getUTCMonth()+1).padStart(2,'0')}-${String(_d.getUTCDate()).padStart(2,'0')}`;

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
          `La fecha de hoy es ${fechaHoy}.`,
          '',
          'REGLAS:',
          '- Solo usa los campos de la lista permitida. NUNCA inventes campos nuevos.',
          '- Extrae TODOS los valores que el usuario dio aunque los haya mezclado.',
          `- Fechas → formato YYYY-MM-DD. "hoy" = ${fechaHoy}. Calcula fechas relativas ("en 10 días", "en un mes") desde hoy. NUNCA uses 2023-10-05 ni ninguna fecha de ejemplo.`,
          '- Corrige errores ortográficos en nombres de personas y lugares (ej: "ciduad de mexico" → "Ciudad de México", "abrahan" → "Abraham").',
          '- Capitaliza correctamente nombres propios de personas y lugares.',
          '- "N/A", "ninguno", "no aplica", "no hay" → "N/A".',
          '- "sin limitaciones" → "ninguna".',
          '- Si el usuario responde con el nombre de una opción condicional (como "simple", "notariada", o cualquier valor de los campos condicionales), mapearlo al campo modal correspondiente (ej: instrumento_notarial = "simple").',
          `- Campos condicionales del documento: ${conditionalFields.length ? conditionalFields.join(', ') : 'ninguno'}.`,
          '- Analiza el historial completo para entender qué pregunta respondía el usuario.',
          conditionalContext,
          '',
          `Campos ya recopilados (puedes sobreescribir si el usuario corrige uno): ${alreadyCollected}`,
          `Campos permitidos (EXACTAMENTE estos nombres): ${fieldsContext}`,
          '',
          'Responde SOLO con JSON de campos NUEVOS o CORREGIDOS: { "campo_exacto": "valor", ... }',
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
  const collectedCount = Object.keys(collectedSoFar).length;
  const confirmLine = !isFirstQuestion && collectedCount > 0
    ? `Ya tengo ${collectedCount} dato${collectedCount > 1 ? 's' : ''}.`
    : '';

  // Si hay grupos modales pendientes — solo preguntar esos, presentando las opciones
  const hasPendingModal = pendingGroups[0]?.[0] === 'tipo';
  if (hasPendingModal && conditionalFields.length > 0) {
    const modalFields = pendingGroups[0][1];
    const modalKeys = modalFields.map(f => f.label || f.key).join(', ');

    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: [
            'Eres Milo, asistente de Lyra Suite.',
            `Estás ayudando al usuario a llenar el documento "${documentName}".`,
            'Tu tarea es hacer UNA SOLA PREGUNTA que determine la modalidad del documento.',
            '',
            'REGLAS:',
            '- Presenta las opciones disponibles de forma natural y conversacional.',
            '- Explica brevemente en una frase qué implica cada opción.',
            '- Usa markdown: negritas para opciones importantes, saltos de línea entre ideas.',
            confirmLine ? `- Empieza con: "${confirmLine}"` : '',
            '',
            `Campo a resolver: ${modalKeys}`,
            `Opciones posibles del documento: ${conditionalFields.join(', ')}`,
          ].filter(Boolean).join('\n'),
        },
        ...history,
        { role: 'user', content: String(message ?? '') },
      ],
    });

    return completion.choices?.[0]?.message?.content?.trim() ||
      `¿${modalKeys}? Las opciones son: ${conditionalFields.join(' o ')}.`;
  }

  // Grupos regulares — agrupar lo más posible
  const groupLines = pendingGroups.map(([prefix, fields]) => {
    const labels = fields.map(f => f.label || f.key).join(', ');
    return `  Grupo "${prefix}": ${labels}`;
  }).join('\n');

  // Lista numerada de campos del primer grupo — se concatena SIEMPRE al final del reply
  const firstGroupFields = pendingGroups[0]?.[1] || [];
  const listaFields = firstGroupFields
    .map((f, i) => `${i + 1}. **${f.label || f.key}**`)
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: [
          'Eres Milo, asistente de Lyra Suite.',
          `Estás ayudando al usuario a llenar el documento "${documentName}".`,
          'Haz UNA SOLA PREGUNTA conversacional y natural que cubra los campos del grupo.',
          '',
          'REGLAS:',
          '- Sin bullets ni guiones en tu pregunta — solo texto fluido.',
          '- Fluido y conversacional.',
          confirmLine ? `- Empieza con: "${confirmLine}"` : '',
          '- NO incluyas lista de campos en tu respuesta — el sistema la agrega automáticamente.',
          '',
          `Campos a preguntar: ${firstGroupFields.map(f => f.label || f.key).join(', ')}`,
        ].filter(Boolean).join('\n'),
      },
      ...history,
      { role: 'user', content: String(message ?? '') },
    ],
  });

  const llmReply = completion.choices?.[0]?.message?.content?.trim() ||
    '¿Puedes darme los siguientes datos?';

  // Concatenar lista siempre — sin depender del LLM
  return `${llmReply}\n\nNecesito:\n${listaFields}`;
}

/**
 * Deriva los valores booleanos de conditional_fields basándose en lo recopilado.
 * Ejemplo: si instrumento_notarial = "simple" → carta_simple = true, carta_notariada = false
 * Funciona para cualquier template sin hardcodear nada.
 */
async function deriveConditionalBooleans({ openai, collected, conditionalFields }) {
  if (!conditionalFields.length) return {};

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'Eres un asistente que deriva valores booleanos para campos condicionales de documentos legales.',
          'Dado un conjunto de datos recopilados y una lista de campos booleanos condicionales,',
          'determina el valor (true/false) de cada campo condicional basándote en los datos.',
          '',
          'REGLAS:',
          '- Analiza semánticamente los valores recopilados para determinar qué opciones aplican.',
          '- Cada campo condicional representa una variante o modalidad del documento.',
          '- Solo uno o pocos de los campos condicionales deben ser true — los que aplican según los datos.',
          '- Responde con true/false para TODOS los campos condicionales de la lista.',
          '- No inventes campos nuevos.',
          '',
          'Responde SOLO con JSON: { "campo_condicional": true/false, ... }',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ collected, conditionalFields }),
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    const clean = {};
    for (const k of conditionalFields) {
      if (k in parsed) clean[k] = !!parsed[k];
    }
    console.log('[ConvFill] conditionalBooleans:', JSON.stringify(clean));
    return clean;
  } catch {
    return {};
  }
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

  // conditional_dependencies: mapa de qué campos viven dentro de cada bloque condicional
  // { carta_notariada: ['notario_nombre', ...], carta_simple: ['testigo_1_nombre', ...] }
  const conditionalDeps = (contract?.conditional_dependencies && typeof contract.conditional_dependencies === 'object')
    ? contract.conditional_dependencies
    : {};

  // Calcular qué campos excluir basándose en los valores ya recopilados
  // Si un campo condicional está en false/simple/no → excluir sus dependientes
  // NUNCA excluir campos de datos reales aunque aparezcan en conditionalDeps
  const NEVER_EXCLUDE = new Set([
    'forma_pago', 'lugar', 'fecha', 'monto', 'jurisdiccion', 'moneda',
  ]);
  function getExcludedFields(collected) {
    const excluded = new Set();
    for (const [condField, depFields] of Object.entries(conditionalDeps)) {
      // Buscar si algún campo modal indica que este condicional es false
      const condValue = collected[condField];
      // Si está explícitamente en false, excluir sus dependientes (salvo protegidos)
      if (condValue === false || condValue === 'false') {
        for (const f of depFields) {
          if (!NEVER_EXCLUDE.has(f) && !NEVER_EXCLUDE.has(f.split('_')[0])) excluded.add(f);
        }
        continue;
      }
      // Buscar en campos modales si el valor indica que este condicional no aplica
      // Ej: instrumento_notarial = "simple" → carta_notariada = false
      for (const modalField of modalFieldKeys) {
        const modalVal = String(collected[modalField] || '').toLowerCase();
        // El nombre del condicional contiene la pista — si el valor del modal
        // coincide con otra opción del condicional, este no aplica
        const condName = condField.toLowerCase();
        if (modalVal && !condName.includes(modalVal) && !modalVal.includes(condName.replace(/^(carta_|incluye_|con_|permite_|tiene_|es_)/, ''))) {
          // Verificar si algún otro conditional_field tiene mejor match
          const otherFields = conditionalFields.filter(f => f !== condField);
          const betterMatch = otherFields.some(f => {
            const fName = f.toLowerCase().replace(/^(carta_|incluye_|con_|permite_|tiene_|es_)/, '');
            return modalVal.includes(fName) || fName.includes(modalVal);
          });
          if (betterMatch) {
            for (const f of depFields) {
              if (!NEVER_EXCLUDE.has(f) && !NEVER_EXCLUDE.has(f.split('_')[0])) excluded.add(f);
            }
          }
        }
      }
    }
    return excluded;
  }

  const fieldKeySet = new Set(fields.map(f => f.key));
  const modalFieldKeys = [
    ...fields
      .filter(f => {
        const MODAL_HINTS = ['instrumento', 'tipo', 'modalidad', 'clase'];
        return f?.required && (conditionalFields.includes(f.key) || MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h)));
      })
      .map(f => f.key),
    // virtual: conditional_fields que no son fields del formulario
    ...conditionalFields.filter(k => !fieldKeySet.has(k)),
  ];

  const baseAllowedKeys = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);

  // allowedKeys dinámico — se recalcula en cada turno excluyendo campos no aplicables
  const excludedNow = getExcludedFields(collectedSoFar);
  const allowedKeys = baseAllowedKeys.filter(k => !excludedNow.has(k));

  const fieldsContext = buildFieldsContext(fields);
  const { modalFields, groups } = groupFields(fields, conditionalFields);
  const colorFields = fields.filter(f => f?.required && String(f?.key || '').startsWith('color_'));

  // ── Etapa: email ──────────────────────────────────────────────────────────
  if (stage === 'email') {
    const emailMatch = String(message ?? '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const noEmail = /sin\s*correo|no\s*correo|solo\s*pdf|no\s*quiero/i.test(String(message ?? ''));

    // si el usuario quiere volver a personalizar colores — regresar a etapa colors
    const wantsColors = /color|personaliz|cambiar\s*(el\s*)?dise[ñn]o|quiero\s*(cambiar|escoger|elegir)/i.test(String(message ?? ''));
    if (wantsColors && !emailMatch) {
      return {
        done: false,
        stage: 'colors',
        collected: collectedSoFar,
        reply: '¡Claro! ¿Quieres usar los colores predeterminados o personalizarlos? Escribe `default` para el diseño estándar.',
      };
    }

    if (emailMatch || noEmail) {
      const finalPayload = { ...collectedSoFar };
      if (conditionalFields.length > 0) {
        const implied = await deriveConditionalBooleans({ openai, collected: finalPayload, conditionalFields });
        Object.assign(finalPayload, implied);
      }
      return { done: true, payload: finalPayload, email: emailMatch ? emailMatch[0] : null };
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
      // Usuario quiere personalizar — extraer colores del mensaje
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

    // Rellenar colores faltantes — del :root del HTML si existe, o de _htmlColors pre-extraídos
    const htmlColors = extractColorsFromHtml(contract?.html || '');
    const cachedColors = contract?._htmlColors || {};
    for (const f of colorFields) {
      if (!withColors[f.key]) {
        withColors[f.key] = htmlColors[f.key] || cachedColors[f.key] || collectedSoFar[f.key] || '';
      }
    }

    // Rellenar campos excluidos con N/A para que el backend no los marque como faltantes
    const excludedFinal = getExcludedFields(withColors);
    for (const k of excludedFinal) {
      if (!withColors[k]) withColors[k] = 'N/A';
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
    // Fast-path: si el campo modal aún no tiene valor, el usuario está respondiendo esa pregunta
    // Mapear directamente sin pasar por el extractor
    const pendingModalNow = modalFields.filter(f => {
      const v = newCollected[f.key];
      return v === undefined || v === null || v === '';
    });

    if (pendingModalNow.length > 0) {
      const modalKey = pendingModalNow[0].key;
      const modalValue = String(message ?? '').trim();
      newCollected[modalKey] = modalValue;
      console.log('[ConvFill] modal direct:', modalKey, '=', modalValue);

      // Recalcular campos excluidos con el nuevo valor del modal
      const excludedAfterModal = getExcludedFields(newCollected);
      console.log('[ConvFill] excluded after modal:', [...excludedAfterModal]);

      // Resolver campos dependientes del modal — excluir campos de datos reales
      const NEVER_RESOLVE = [
        'otorgante', 'apoderado', 'testigo', 'deudor', 'acreedor',
        'arrendador', 'arrendatario', 'forma_pago', 'lugar', 'fecha',
        'monto', 'jurisdiccion', 'moneda', 'nombre', 'identificacion',
      ];
      const allMissingForModal = allowedKeys.filter(k => {
        const v = newCollected[k];
        if (v !== undefined && v !== null && v !== '') return false;
        return !NEVER_RESOLVE.some(h => k.toLowerCase().includes(h));
      });
      const impliedFromModal = await resolveImpliedFields({
        openai, fields,
        collected: newCollected,
        conditionalFields,
        missingOverride: allMissingForModal,
      });
      for (const [k, v] of Object.entries(impliedFromModal)) {
        const isProtected = NEVER_RESOLVE.some(h => k.toLowerCase().includes(h));
        if (!isProtected) newCollected[k] = v;
      }
      console.log('[ConvFill] modalImplied:', JSON.stringify(impliedFromModal));
    } else {
      const extracted = await extractFieldsFromMessage({
        openai, message, history,
        allowedKeys, fieldsContext,
        collectedSoFar: newCollected,
        conditionalFields,
      });
      newCollected = { ...newCollected, ...extracted };
    }
  }

  // Recalcular allowedKeys con el collected actual (puede haber cambiado tras guardar modal)
  const excludedCurrent = getExcludedFields(newCollected);
  const effectiveAllowedKeys = baseAllowedKeys.filter(k => !excludedCurrent.has(k));

  // Incluir conditional_fields virtuales en missingRequired
  const virtualConditionalKeys = conditionalFields.filter(k => !fieldKeySet.has(k));
  const missingRequired = [
    ...effectiveAllowedKeys.filter(k => {
      const v = newCollected[k];
      return v === undefined || v === null || v === '';
    }),
    ...virtualConditionalKeys.filter(k => {
      const v = newCollected[k];
      return v === undefined || v === null || v === '';
    }),
  ];

  console.log('[ConvFill] round:', round, 'missing:', missingRequired.length, missingRequired);

  if (missingRequired.length === 0) {
    // inyectar colores del template en el collected para que el front pueda mostrar los pickers
    const cachedColors = contract?._htmlColors || {};
    const collectedWithColors = { ...newCollected };
    for (const [k, v] of Object.entries(cachedColors)) {
      if (!collectedWithColors[k]) collectedWithColors[k] = v;
    }
    return {
      done: false,
      stage: 'colors',
      collected: collectedWithColors,
      reply: '¡Ya tengo todos los datos! ¿Quieres usar los colores predeterminados o personalizarlos? Escribe `default` para el diseño estándar.',
    };
  }

  // Construir grupos pendientes
  const pendingModal = modalFields.filter(f => missingRequired.includes(f.key));

  // Si hay campos modales pendientes — preguntar SOLO esos primero
  console.log('[ConvFill] modalFields:', modalFields.map(f => f.key));
  console.log('[ConvFill] pendingModal:', pendingModal.map(f => f.key));
  if (pendingModal.length > 0) {
    const reply = await buildNextQuestion({
      openai, history, message,
      pendingGroups: [['tipo', pendingModal]],
      collectedSoFar: newCollected,
      documentName,
      isFirstQuestion: round === 0,
      conditionalFields,
    });
    return { done: false, stage: 'filling', reply, collected: newCollected };
  }

  const pendingGroups = [];

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