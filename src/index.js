const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const cuevana = require('./providers/cuevana');
const sololatino = require('./providers/sololatino');
const tmdb = require('./tmdb');
const { buildProxyUrl, proxyHandler } = require('./proxy');

const PROVIDERS = [cuevana, sololatino];

// Sin catálogo propio: el addon solo resuelve "stream" para ids de IMDb
// (tt1234567 para películas, tt1234567:temporada:episodio para series) que
// llegan porque el usuario ya tiene Cinemeta (u otro addon de catálogo)
// instalado. No aparece ninguna estantería/catálogo propio en Nuvio/Stremio.
const manifest = {
  id: 'community.storm.multi',
  version: '0.3.0',
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

    // Todos los streams se reenvían a través de nuestro propio proxy en vez
    // del link directo del host, para que el Referer sea el correcto y no
    // devuelvan 403 (motivo más probable de "no carga nada").
    streams = streams.map((s) => ({
      name: s.name,
      title: s.title,
      url: buildProxyUrl(s.url, s.referer),
      behaviorHints: s.behaviorHints,
    }));

    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));
app.get('/proxy', proxyHandler);

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
