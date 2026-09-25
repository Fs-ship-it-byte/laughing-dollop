const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const cuevana = require('./providers/cuevana');
const sololatino = require('./providers/sololatino');
const tmdb = require('./tmdb');
const {
  publicUrl,
  hasPublicUrl,
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
} = require('./hlsproxy');

const PROVIDERS = [cuevana, sololatino];

// Sin catálogo propio: el addon solo resuelve "stream" para ids de IMDb
// (tt1234567 para películas, tt1234567:temporada:episodio para series) que
// llegan porque el usuario ya tiene Cinemeta (u otro addon de catálogo)
// instalado. No aparece ninguna estantería/catálogo propio en Nuvio/Stremio.
const manifest = {
  id: 'community.storm.multi',
  version: '0.5.5',
  name: 'Storm CS3 (Cuevana + SoloLatino)',
  description:
    'Streams en español desde Cuevana y SoloLatino, resueltos vía TMDB a partir del id de IMDb. No trae catálogo propio: úsalo junto con Cinemeta u otro addon de catálogo.',
  logo: 'https://sololatino.net/favicon.ico',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const [imdbId, seasonStr, episodeStr] = id.split(':');
    const season = seasonStr ? parseInt(seasonStr, 10) : undefined;
    const episode = episodeStr ? parseInt(episodeStr, 10) : undefined;

    const info = await tmdb.findByImdbId(imdbId, type);
    if (!info || !info.title) {
      console.error('tmdb: sin resultado para', imdbId, type);
      return { streams: [] };
    }
    console.log('tmdb ->', imdbId, '=>', info.title, info.year);

    const results = await Promise.allSettled(
      PROVIDERS.map((provider) =>
        provider.getStreamsByTitle(info.title, {
          type,
          season,
          episode,
          titleEs: info.titleEs,
          originalTitle: info.originalTitle,
          year: info.year,
        })
      )
    );

    let streams = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        streams = streams.concat(r.value);
      } else {
        console.error(`provider ${PROVIDERS[i].PREFIX} falló:`, r.reason?.message || r.reason);
      }
    });

    // Entrega directa: le pasamos a Stremio la URL real del CDN y los headers
    // (Referer/Origin/User-Agent) van en behaviorHints.proxyHeaders. Es la app
    // de Stremio (desktop/mobile) la que agrega esos headers al pedir el
    // video directo del CDN, así el video nunca pasa por nuestro servidor.
    //
    // OJO: esto no funciona en el player web (web.stremio.com) porque un
    // <video> de navegador no puede mandar headers custom. Para esos casos
    // dejamos el proxy como fallback vía USE_PROXY=1 (ver abajo).
    const USE_PROXY = process.env.USE_PROXY === '1';

    streams = streams
      .filter((s) => s && s.url)
      .map((s) => {
        // Masters .txt (StreamWish): la URL cruda no termina en .m3u8 y el player
        // no la reconoce como HLS, así que la playlist pasa por el proxy liviano
        // (segmentos directos al CDN, con proxyHeaders del cliente).
        if (!USE_PROXY && s.lightProxy) {
          return {
            name: s.name,
            title: s.title,
            url: buildProxyPlaylistUrl(s.url, s.headers, { light: true }),
            behaviorHints: {
              ...s.behaviorHints,
              notWebReady: true,
              proxyHeaders: s.headers ? { request: s.headers } : undefined,
            },
          };
        }
        if (USE_PROXY) {
          return {
            name: s.name,
            title: s.title,
            url:
              s.type === 'hls'
                ? buildProxyPlaylistUrl(s.url, s.headers)
                : buildProxyDirectUrl(s.url, s.headers),
            behaviorHints: s.behaviorHints,
          };
        }
        return {
          name: s.name,
          title: s.title,
          url: s.url,
          behaviorHints: {
            ...s.behaviorHints,
            notWebReady: true,
            proxyHeaders: s.headers ? { request: s.headers } : undefined,
          },
        };
      });

    console.log(`total streams devueltos: ${streams.length}`);
    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));

app.get('/hlsproxy/playlist/:token/:file', handlePlaylistProxy);
app.get('/hlsproxy/segment/:token/:file', handleSegmentProxy);
app.get('/hlsproxy/direct/:token/:file', handleDirectProxy);

// ==========================================
// RUTAS DE DEBUG (para probar desde el navegador, sin instalar nada)
// ==========================================
// /debug/sololatino?url=<URL de la página del episodio/película en
//   sololatino.net, tal cual, SIN codificar>
// /debug/cuevana?url=<URL de la página en cuevana>
// /debug/embed?url=<URL del embed a resolver>&referer=<referer opcional>
//
// Devuelven el JSON crudo con lo que resolvió cada provider (url, type,
// headers) para ver exactamente qué le está llegando a Stremio, sin tener
// que instalar el addon ni mirar logs.
const { resolveGenericEmbed } = require('./extractors/generic');
const { resolveEmbedAdvanced } = require('./extractors/streamhosts');

app.get('/debug/sololatino', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'falta ?url=' });
  try {
    const streams = await sololatino.loadStreamSources(url);
    res.json({ pageUrl: url, count: streams.length, streams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/cuevana', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'falta ?url=' });
  try {
    const streams = await cuevana.loadStreamSources(url);
    res.json({ pageUrl: url, count: streams.length, streams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/embed', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).json({ error: 'falta ?url=' });
  try {
    const resolved = await resolveGenericEmbed(url, referer);
    res.json({ embedUrl: url, resolved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /debug/advanced?url=<embed de streamwish/vidhide>&force=http|browser
// Prueba el resolver avanzado de Cuevana (sin caché) y muestra por qué camino salió.
app.get('/debug/advanced', async (req, res) => {
  const { url, force } = req.query;
  if (!url) return res.status(400).json({ error: 'falta ?url=' });
  const t0 = Date.now();
  try {
    const resolved = await resolveEmbedAdvanced(url, undefined, { force: force || 'all' });
    res.json({ embedUrl: url, ms: Date.now() - t0, resolved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Addon corriendo en ${publicUrl()}/manifest.json`);
  if (!hasPublicUrl()) {
    console.warn(
      'AVISO: no está seteada la variable PUBLIC_URL (ni RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN). Hay que configurarla con la URL pública del servicio (ej. https://tu-addon.onrender.com), si no el proxy arma links con 127.0.0.1 y no van a funcionar.'
    );
  }
});
