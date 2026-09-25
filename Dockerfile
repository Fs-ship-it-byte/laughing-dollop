FROM node:20-slim

WORKDIR /app

# Dependencias de sistema que Chromium necesita para correr en headless
# dentro de un contenedor Linux mínimo (sin esto, Puppeteer crashea al
# lanzar el browser con errores de librerías faltantes).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copiamos primero solo el manifest de deps para aprovechar la cache de
# Docker: si no cambiaste package.json, no vuelve a correr npm install.
COPY package.json package-lock.json* ./
# puppeteer va como optionalDependency: descarga Chromium (~200MB) en este paso.
# Si falla, el addon arranca igual y solo omite el camino con navegador.
RUN npm install --omit=dev

# Recién ahora copiamos el resto del código.
COPY . .

ENV PORT=7000
EXPOSE $PORT

CMD ["sh", "-c", "node src/index.js"]
