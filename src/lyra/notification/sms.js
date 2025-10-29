// src/lyra/notification/sms.js
import { post } from "../../core/http/client.js";
import { LYRA_API_URL } from "../../config/index.js";

/**
 * payload = { toE164, message }
 */
export async function sendSms(payload, token) {
  const url = `${LYRA_API_URL}/notification/sms`;
  if (!payload?.toE164) throw new Error("toE164 es requerido");
  if (!payload?.message) throw new Error("message es requerido");
  return await post(url, payload, { token });
}
