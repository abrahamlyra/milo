// src/config/index.js
const toInt = (v, d) => {
  const n = parseInt(`${v}`, 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: toInt(process.env.PORT, 8080),
  lyraApiUrl: (process.env.LYRA_API_URL || '').replace(/\/+$/, ''),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  httpTimeoutMs: toInt(process.env.HTTP_TIMEOUT_MS, 15000),
  httpRetries: toInt(process.env.HTTP_RETRIES, 2),
};

if (!config.lyraApiUrl) {
  console.warn('⚠️  LYRA_API_URL no está definido.');
}
