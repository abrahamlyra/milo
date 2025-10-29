// src/lyra/documents/create.js
import { post } from "../../core/http/client.js";
import { LYRA_API_URL } from "../../config/index.js";

/**
 * data = { templateId, data, correlationId? }
 * Respuesta esperada: { id, pdfUrl, ... }
 */
export async function createDocument(data, token) {
  const url = `${LYRA_API_URL}/documents`;
  if (!data?.templateId) throw new Error("templateId es requerido");
  if (!data?.data || typeof data.data !== "object") throw new Error("data (payload del template) es requerido");
  return await post(url, data, { token });
}
