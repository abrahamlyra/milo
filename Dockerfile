# Imagen base ligera
FROM node:20-alpine

# Dir de trabajo
WORKDIR /app

# Solo package.json primero (mejor cache)
COPY package*.json ./

# Instala deps de producción
RUN npm ci --omit=dev

# Copia el código
COPY src ./src
COPY .env.example ./

# Vars de entorno de runtime (Cloud Run pasa PORT y tus envs)
ENV NODE_ENV=production

# Arranque
CMD ["node", "src/webhook/server.js"]