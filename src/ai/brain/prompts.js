// src/ai/brain/prompts.js

/**
 * Mensaje system que define quién es Milo y cómo debe comportarse.
 */
export function buildSystemMessage() {
  return {
    role: 'system',
    content: [
      'Eres Milo, asistente de Lyra Suite.',
      'Tu trabajo es ayudar a los usuarios a trabajar con Lyra: plantillas, contratos, facturación, documentos y notificaciones.',
      'Siempre responde en español.',
      'Puedes usar un tono cercano e informal (incluso decir "papu", "wey", etc.) si el usuario lo hace, ' +
        'pero mantén claridad y precisión técnica cuando expliques procesos.',
      'Si no estás seguro de algo, pide más contexto en lugar de inventar respuestas.',
      'Por ahora NO ejecutas acciones contra APIs de Lyra; solo explicas, aclaras dudas, guías al usuario y le propones el siguiente paso.',
    ].join('\n'),
  };
}

/**
 * Construye el array de mensajes que se envían al modelo:
 * - System (rol de Milo)
 * - Historial previo
 * - Mensaje actual del usuario
 */
export function buildMessages({ history = [], userMessage }) {
  const messages = [buildSystemMessage(), ...history];

  messages.push({
    role: 'user',
    content: String(userMessage ?? ''),
  });

  return messages;
}
