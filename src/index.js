const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cuevana = require('./providers/cuevana');

const manifest = {
  id: 'community.storm.cuevana',
  version: '0.1.0',
  name: 'Cuevana (Storm)',
  description:
    'Addon no oficial portado desde el provider Cuevana de CloudStream3 (storm-ext). Contenido en español.',
  logo: 'https://wv3.cuevana3.eu/favicon.ico',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'peliculas', name: 'Cuevana - Películas' },
    { type: 'movie', id: 'peliculas-estrenos', name: 'Cuevana - Estrenos' },
    { type: 'series', id: 'series', name: 'Cuevana - Series' },
    { type: 'series', id: 'series-estrenos', name: 'Cuevana - Series Estrenos' },
  ].map((c) => ({ ...c, extra: [{ name: 'search' }, { name: 'skip' }] })),
  idPrefixes: [cuevana.PREFIX],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    if (extra?.search) {
      const metas = await cuevana.search(extra.search);
      return { metas: metas.filter((m) => m.type === type) };
    }
    const skip = extra?.skip ? parseInt(extra.skip, 10) : 0;
    const metas = await cuevana.getCatalog(id, skip);
    return { metas: metas.filter((m) => m.type === type) };
  } catch (err) {
    console.error('catalog error', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const meta = await cuevana.getMeta(id);
    const { _url, ...clean } = meta;
    return { meta: clean };
  } catch (err) {
    console.error('meta error', err);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  try {
    const streams = await cuevana.getStreams(id);
    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Cuevana addon corriendo en http://127.0.0.1:${PORT}/manifest.json`);
