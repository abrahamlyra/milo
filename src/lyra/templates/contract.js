// src/lyra/templates/contract.js
import { get } from "../../core/http/client.js";
import { LYRA_API_URL } from "../../config/index.js";

export async function getContract(templateId, token) {
  if (!templateId) throw new Error("templateId es requerido");
  const url = `${LYRA_API_URL}/templates/${encodeURIComponent(templateId)}/contract`;
  return await get(url, { token });
}
