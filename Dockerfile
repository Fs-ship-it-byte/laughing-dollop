FROM node:18-slim

WORKDIR /app

# Copiamos primero solo el manifest de deps para aprovechar la cache de
# Docker: si no cambiaste package.json, no vuelve a correr npm install.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Recién ahora copiamos el resto del código.
COPY . .

ENV PORT=7000
EXPOSE $PORT

CMD ["sh", "-c", "node src/index.js"]
