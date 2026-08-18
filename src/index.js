const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const cuevana = require('./providers/cuevana');
const sololatino = require('./providers/sololatino');
const tmdb = require('./tmdb');
const {
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
  version: '0.4.0',
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
        provider.getStreamsByTitle(info.title, { type, season, episode })
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

    // Cada stream se reenvía a través de nuestro propio proxy en vez del
    // link directo del host: HLS (.m3u8) pasa por el proxy que reescribe
    // TODO el playlist (sub-playlists + cada segmento .ts), porque el token
    // del CDN está atado al Referer/Origin/IP con que se negoció, y no
    // alcanza con proxear solo el archivo raíz. Streams mp4 directos pasan
    // por un proxy simple que solo reenvía el archivo con los headers
    // correctos.
    streams = streams
      .filter((s) => s && s.url)
      .map((s) => ({
        name: s.name,
        title: s.title,
        url:
          s.type === 'hls'
            ? buildProxyPlaylistUrl(s.url, s.headers)
            : buildProxyDirectUrl(s.url, s.headers),
        behaviorHints: s.behaviorHints,
      }));

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

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`Addon corriendo en ${base}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn(
      'AVISO: no está seteada la variable PUBLIC_URL. En Railway hay que configurarla con la URL pública del servicio (ej. https://tu-proyecto.up.railway.app), si no el proxy arma links con 127.0.0.1 y no van a funcionar.'
    );
  }
});
