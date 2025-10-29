// src/lyra/user/me.js
import { get } from "../../core/http/client.js";
import { LYRA_API_URL } from "../../config/index.js";

export async function userMe(token) {
  const url = `${LYRA_API_URL}/user/me`;
  return await get(url, { token });
}
