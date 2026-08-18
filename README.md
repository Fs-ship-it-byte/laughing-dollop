# Cuevana Stremio/Nuvio Addon (portado desde storm-ext CS3)

Addon no oficial, portado desde el provider **CuevanaProvider** del repo
`storm-ext` de CloudStream 3, para usarlo en Stremio o Nuvio.

## Requisitos
- Node.js 18+ instalado en tu PC/servidor.

## Instalación y ejecución

```bash
npm install
npm start
```

Esto levanta el addon en `http://127.0.0.1:7000/manifest.json`.

## Deploy en Railway

1. Sube esta carpeta a un repo de GitHub (Railway despliega desde Git).
   ```bash
   cd cuevana-addon
   git init
   git add .
   git commit -m "cuevana addon"
   git branch -M main
   git remote add origin <URL_DE_TU_REPO>
   git push -u origin main
   ```
2. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → elige el repo.
3. Railway detecta Node automáticamente (Nixpacks) y usa `npm start` gracias a `railway.json`. No hay que tocar nada más.
4. Railway asigna el puerto vía la variable de entorno `PORT` — el código ya lo respeta (`process.env.PORT`), así que no hace falta configurarla a mano.
5. Una vez desplegado, ve a **Settings → Networking → Generate Domain** para obtener una URL pública tipo `https://tu-proyecto.up.railway.app`.
6. Tu manifest queda en:
   ```
   https://tu-proyecto.up.railway.app/manifest.json
   ```
   Esa es la URL que pegas en Nuvio.

### Alternativa sin GitHub: Railway CLI

```bash
npm i -g @railway/cli
railway login
cd cuevana-addon
railway init
railway up
railway domain   # genera/obtiene la URL pública
```

## Instalarlo en Nuvio / Stremio

Si lo tienes en Railway (ver sección de arriba), usa directamente la URL
pública que te da Railway. Si solo lo corres local para probar:

1. Corre el addon en tu PC (misma red donde uses Nuvio).
2. Copia la URL del manifest, ej: `http://TU_IP_LOCAL:7000/manifest.json`
3. En Nuvio: Addons → pega la URL → Instalar.

## Qué funciona

- Catálogo: Películas, Estrenos, Series, Series Estrenos (con paginación).
- Búsqueda.
- Metadata + lista de episodios por temporada.
- Streams: resuelve el iframe embebido de Cuevana y trata de sacar el link
  directo (m3u8/mp4) para los hosts que usan el formato "packed JS" clásico
  (streamwish, vidhidepro, filemoon y derivados vía `fixHostsLinks`).

## Limitaciones conocidas / lo que falta

- **El dominio de Cuevana cambia seguido.** Si deja de funcionar, lo primero
  es revisar `MAIN_URL` en `src/providers/cuevana.js` y actualizarlo al
  dominio vigente (los selectores HTML probablemente sigan funcionando
  porque el sitio no suele cambiar de plantilla).
- El extractor genérico (`src/extractors/generic.js`) cubre el caso más
  común (JS empacado con `file:"...m3u8"` o `sources:[{file:...}]`), pero
  **no** cubre hosts con protección extra (tokens firmados por JS complejo,
  captchas, DRM). Si un stream falla, probablemente ese host necesite un
  extractor dedicado (como los que CloudStream trae para cada uno).
- No hay caché — cada request re-scrapea. Para uso real conviene agregar un
  caché simple (ej. `node-cache`) en `getMeta`/`getCatalog`.
- No probado contra el sitio real en este entorno (sin acceso a red aquí).
  Corre `npm start` y prueba con datos reales para ajustar selectores si
  algo no calza.

## Estructura

```
src/
  index.js               # manifest + handlers del SDK de Stremio
  http.js                # fetch con headers por defecto
  providers/cuevana.js    # scraping de Cuevana (catálogo, meta, streams)
  extractors/
    generic.js            # resuelve embeds tipo streamwish/vidhidepro/filemoon
    unpacker.js            # desempaquetador de JS "eval(p,a,c,k,e,d)"
```

## Siguientes providers (pendientes)

Mismo patrón para portar: crear `src/providers/<nombre>.js` con
`getCatalog`, `search`, `getMeta`, `getStreams`, y sumarlo en `index.js`
(catálogos + prefijo de id). Pendientes de este pedido original:
- SoloLatinoProvider (tiene un paso extra: token CSRF + POST a `/api/player-url`)
- AllCalidadProvider (extractor propio, hay que revisar `Extractor.kt`)
- Pelisplus4KProvider (usa 5 extractores: ByseSX, VidStack, VidHidePro, Filesim, StreamWish)
- DeporTVProvider (el más grande, streaming en vivo de deportes — arquitectura distinta a los demás)
