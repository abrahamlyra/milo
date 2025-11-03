// src/lyra/user/me.js
import { makeClient } from "../../core/http/client.js";
import { config } from "../../config/index.js";

// crea el cliente con baseURL (requerido por makeClient)
const http = makeClient({ baseURL: config.lyraApiUrl });

export async function userMe(token) {
  // al tener baseURL, basta el path relativo
  return await http.get('/user/me', { token });
}
