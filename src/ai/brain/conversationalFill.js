// src/ai/brain/conversationalFill.js
//
// Flujo conversacional inteligente para llenado de documentos.
// Recibe el contrato con sus fields exactos, agrupa, conversa en máximo 5 rondas,
// y cuando tiene todo devuelve el payload con los keys exactos del contrato.
//
// Devuelve siempre:
//   { done: false, reply: "siguiente pregunta" }
//   { done: true, payload: { key: value, ... } }

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Agrupa los fields del contrato de forma inteligente.
 * - Ignora campos color_* (se manejan al final)
 * - Separa campos que determinan modalidad (instrumento_notarial, tipo_*, modalidad_*, etc.)
 * - Agrupa por prefijo los demás
 */
function groupFields(fields) {
  const required = fields.filter(f =>
    f?.required && !String(f?.key || '').startsWith('color_')
  );

  // Campos que determinan modalidad — van primero como pregunta inicial
  const MODAL_HINTS = ['instrumento', 'tipo', 'modalidad', 'clase', 'forma'];
  const modalFields = required.filter(f =>
    MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );
  const regularFields = required.filter(f =>
    !MODAL_HINTS.some(h => String(f.key).toLowerCase().startsWith(h))
  );

  // Agrupar regulares por prefijo
  const groups = new Map();
  for (const f of regularFields) {
    const prefix = f.key.includes('_') ? f.key.split('_')[0] : 'general';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(f);
  }

  return { modalFields, groups };
}

/**
 * Construye el contexto de fields para el LLM extractor.
 * Le dice exactamente qué keys existen y qué tipo tienen.
 */
function buildFieldsContext(fields) {
  return fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => `${f.key} (${f.type || 'text'})`)
    .join(', ');
}

/**
 * Usa el LLM para extraer valores del mensaje del usuario
 * y mapearlos a los keys EXACTOS del contrato.
 * No inventa campos — solo usa los que están en allowedKeys.
 */
async function extractFieldsFromMessage({ openai, message, history, allowedKeys, fieldsContext }) {
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
          'REGLAS ESTRICTAS:',
          '- Solo usa los campos de la lista permitida. NUNCA inventes campos nuevos.',
          '- Si el usuario no dio un valor para un campo, NO lo incluyas en el resultado.',
          '- Extrae TODOS los valores que el usuario dio en su mensaje, aunque los haya mezclado.',
          '- Para fechas, convierte a formato YYYY-MM-DD si es posible.',
          '- Para booleanos, si el usuario dijo "sí", "si", "yes" → true. Si dijo "no" → false.',
          '- Analiza el historial para entender a qué pregunta está respondiendo el usuario.',
          '',
          `Campos permitidos (usa EXACTAMENTE estos nombres): ${fieldsContext}`,
          '',
          'Responde SOLO con un JSON plano: { "campo_exacto": "valor", ... }',
          'Si no pudiste extraer nada, responde: {}',
        ].join('\n'),
      },
      ...history,
      { role: 'user', content: String(message ?? '') },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    // Filtrar solo keys permitidos
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (allowedKeys.includes(k) && v !== null && v !== undefined && v !== '') {
        clean[k] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Genera la siguiente pregunta conversacional basada en los grupos pendientes.
 */
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
          'Tu tarea es hacer UNA SOLA PREGUNTA conversacional y natural que cubra el mayor número posible de campos relacionados.',
          '',
          'REGLAS:',
          '- Una pregunta por turno, que cubra todos los campos de un grupo relacionado.',
          '- NO uses listas, bullets ni headers.',
          '- Sé fluido y conversacional, como si fuera una plática.',
          '- Si es la primera pregunta y hay campos de modalidad (simple/notariada, tipo de instrumento, etc.), pregunta eso PRIMERO.',
          '- Agrupa campos del mismo grupo en una sola oración natural.',
          confirmLine ? `- Empieza con: "${confirmLine}"` : '',
          '',
          `Grupos de campos pendientes (pregunta el primero y los que puedas combinar):\n${groupLines}`,
        ].filter(Boolean).join('\n'),
      },
      ...history,
      { role: 'user', content: String(message ?? '') },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || '¿Puedes darme los datos del documento?';
}

/**
 * Función principal del flujo conversacional.
 *
 * @param {object} params
 * @param {object} params.openai - Cliente OpenAI
 * @param {object} params.contract - Contrato con fields exactos
 * @param {Array}  params.history - Historial de conversación
 * @param {string} params.message - Mensaje actual del usuario
 * @param {object} params.collectedSoFar - Datos ya recopilados en turnos anteriores
 * @param {number} params.round - Ronda actual (empieza en 0)
 *
 * @returns {{ done: false, reply: string, collected: object } | { done: true, payload: object }}
 */
export async function runConversationalFill({ openai, contract, history, message, collectedSoFar = {}, round = 0 }) {
  const fields = Array.isArray(contract?.fields) ? contract.fields : [];
  const documentName = contract?.name || 'el documento';

  // Keys permitidos (todos los required no-color)
  const allowedKeys = fields
    .filter(f => f?.required && !String(f?.key || '').startsWith('color_'))
    .map(f => f.key);

  const fieldsContext = buildFieldsContext(fields);
  const { modalFields, groups } = groupFields(fields);

  // Si es ronda 0 (arranque), no hay nada que extraer — solo preguntar
  let newCollected = { ...collectedSoFar };

  if (round > 0) {
    // Extraer datos del mensaje del usuario
    const extracted = await extractFieldsFromMessage({
      openai,
      message,
      history,
      allowedKeys,
      fieldsContext,
    });
    newCollected = { ...newCollected, ...extracted };
  }

  // Campos color con defaults si no fueron dados
  const colorFields = fields.filter(f => f?.required && String(f?.key || '').startsWith('color_'));

  // Ver qué campos requeridos no-color faltan
  const missingRequired = allowedKeys.filter(k => {
    const v = newCollected[k];
    return v === undefined || v === null || v === '';
  });

  // Si ya tenemos todo → armar payload final con colores default si no se dieron
  if (missingRequired.length === 0) {
    const payload = { ...newCollected };

    // Inyectar colores default para los que no se dieron
    const COLOR_DEFAULTS = {
      color_fondo: '#FFFFFF',
      color_fondo_oscuro: '#F5F5F5',
      color_fondo_cards: '#FAFAFA',
      color_texto_hero: '#111111',
      color_titulo_h1: '#1a1a2e',
      color_titulo_seccion: '#16213e',
      color_subtitulo: '#444444',
      color_parrafo: '#555555',
      color_acento: '#0066CC',
      color_bordes: '#DDDDDD',
    };

    for (const f of colorFields) {
      if (!payload[f.key]) {
        payload[f.key] = COLOR_DEFAULTS[f.key] || '#000000';
      }
    }

    return { done: true, payload, collected: newCollected };
  }

  // Construir grupos pendientes
  const pendingGroups = [];

  // Primero campos modales si faltan
  const pendingModal = modalFields.filter(f => missingRequired.includes(f.key));
  if (pendingModal.length > 0) {
    pendingGroups.push(['tipo', pendingModal]);
  }

  // Luego grupos regulares pendientes
  for (const [prefix, gFields] of groups.entries()) {
    const pending = gFields.filter(f => missingRequired.includes(f.key));
    if (pending.length > 0) {
      pendingGroups.push([prefix, pending]);
    }
  }

  if (pendingGroups.length === 0) {
    // Fallback — no debería pasar pero por si acaso
    return { done: true, payload: { ...newCollected }, collected: newCollected };
  }

  const reply = await buildNextQuestion({
    openai,
    history,
    message,
    pendingGroups,
    collectedSoFar: newCollected,
    documentName,
    isFirstQuestion: round === 0,
  });

  return { done: false, reply, collected: newCollected };
}