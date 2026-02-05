// milo/src/core/http/client.js
import axios from 'axios';
import { randomUUID } from 'crypto';

export function makeClient({ baseURL, timeoutMs, retries, getToken, getHeaders }) {
  const client = axios.create({ baseURL, timeout: timeoutMs });

  client.interceptors.request.use((cfg) => {
    cfg.headers = cfg.headers || {};

    // Authorization
    const t = getToken?.();
    if (t) cfg.headers.Authorization = `Bearer ${t}`;

    // ✅ Extra headers (multi-tenant)
    const extra = typeof getHeaders === 'function' ? (getHeaders() || {}) : {};
    for (const [k, v] of Object.entries(extra)) {
      const vv = String(v ?? '').trim();
      if (vv) cfg.headers[k] = vv;
    }

    // correlation id
    cfg.headers['x-correlation-id'] =
      cfg.headers['x-correlation-id'] || randomUUID();

    return cfg;
  });

  client.interceptors.response.use(
    (r) => r,
    async (error) => {
      const cfg = error.config || {};
      cfg.__retryCount = cfg.__retryCount || 0;

      const retriable = !error.response || error.response.status >= 500;
      if (retriable && cfg.__retryCount < retries) {
        cfg.__retryCount++;
        return client(cfg);
      }
      throw error;
    }
  );

  return client;
}
