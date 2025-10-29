// src/lyra/notification/email.js
import { post } from "../../core/http/client.js";
import { LYRA_API_URL } from "../../config/index.js";

/**
 * payload = { to, subject, html?, text?, pdfUrl? }
 */
export async function sendEmail(payload, token) {
  const url = `${LYRA_API_URL}/notification/email`;
  if (!payload?.to) throw new Error("to es requerido");
  return await post(url, payload, { token });
}
