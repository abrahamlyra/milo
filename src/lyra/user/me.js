// src/lyra/user/me.js
import { makeClient } from "../../core/http/client.js";
import { config } from "../../config/index.js";

const http = makeClient();

export async function userMe(token) {
  const url = `${config.lyraApiUrl}/user/me`;
  return await http.get(url, { token });
}
