// src/ai/openaiClient.js
import OpenAI from 'openai';

let clientSingleton = null;

/**
 * Devuelve una instancia singleton del cliente de OpenAI.
 * Lee la API key desde process.env.OPENAI_API_KEY.
 */
export function getOpenAIClient() {
  if (clientSingleton) return clientSingleton;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[Milo][OpenAI] Falta OPENAI_API_KEY en el entorno. ' +
        'Configúrala para habilitar el cerebro LLM.'
    );
  }

  clientSingleton = new OpenAI({ apiKey });
  return clientSingleton;
}
