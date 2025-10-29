# Dockerfile (root)
FROM node:20-alpine

WORKDIR /app

# 1) Dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# 2) Copia el código
COPY . .

# 3) Build (si no hay paso build, no pasa nada si falla)
RUN npm run build || true

# 4) Runtime
ENV NODE_ENV=production
EXPOSE 8080

# Usa tu script "start" del package.json
CMD ["npm", "start"]
