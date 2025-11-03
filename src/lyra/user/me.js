// src/lyra/user/me.js
import { get } from "../../core/http/client.js";
import { config } from "../../config/index.js";

export async function userMe(token) {
  const url = `${config.lyraApiUrl}/user/me`;
  return await get(url, { token });
}
