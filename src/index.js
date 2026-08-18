const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cuevana = require('./providers/cuevana');
const sololatino = require('./providers/sololatino');

const PROVIDERS = {
  [cuevana.PREFIX]: cuevana,
  [sololatino.PREFIX]: sololatino,
};

function providerForId(id) {
  const prefix = id.split(':')[0];
  return PROVIDERS[prefix];
}

const manifest = {
  id: 'community.storm.multi',
  version: '0.2.0',
  name: 'Storm CS3 (Cuevana + SoloLatino)',
  description:
    'Addon no oficial portado desde providers de CloudStream3 (storm-ext). Contenido en español.',
  logo: 'https://sololatino.net/favicon.ico',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'peliculas', name: 'Cuevana - Películas', _provider: cuevana.PREFIX },
    { type: 'movie', id: 'peliculas-estrenos', name: 'Cuevana - Estrenos', _provider: cuevana.PREFIX },
    { type: 'series', id: 'series', name: 'Cuevana - Series', _provider: cuevana.PREFIX },
    { type: 'series', id: 'series-estrenos', name: 'Cuevana - Series Estrenos', _provider: cuevana.PREFIX },
    { type: 'movie', id: 'sl-peliculas', name: 'SoloLatino - Películas', _provider: sololatino.PREFIX, _remoteId: 'peliculas' },
    { type: 'series', id: 'sl-series', name: 'SoloLatino - Series', _provider: sololatino.PREFIX, _remoteId: 'series' },
    { type: 'series', id: 'sl-animes', name: 'SoloLatino - Animes', _provider: sololatino.PREFIX, _remoteId: 'animes' },
    { type: 'movie', id: 'sl-cartoons', name: 'SoloLatino - Cartoons', _provider: sololatino.PREFIX, _remoteId: 'cartoons' },
  ].map((c) => ({ ...c, extra: [{ name: 'search' }, { name: 'skip' }] })),
  idPrefixes: [cuevana.PREFIX, sololatino.PREFIX],
};

// Mapa rápido id de catálogo (namespaced) -> { provider, remoteId }
const CATALOG_MAP = Object.fromEntries(
  manifest.catalogs.map((c) => [c.id, { provider: c._provider, remoteId: c._remoteId || c.id }])
);

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const entry = CATALOG_MAP[id];
    if (!entry) return { metas: [] };
    const provider = PROVIDERS[entry.provider];

    if (extra?.search) {
      const metas = await provider.search(extra.search);
      return { metas: metas.filter((m) => m.type === type) };
    }
    const skip = extra?.skip ? parseInt(extra.skip, 10) : 0;
    const metas = await provider.getCatalog(entry.remoteId, skip);
    return { metas: metas.filter((m) => m.type === type) };
  } catch (err) {
    console.error('catalog error', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const provider = providerForId(id);
    if (!provider) return { meta: null };
    const meta = await provider.getMeta(id);
    const { _url, ...clean } = meta;
    return { meta: clean };
  } catch (err) {
    console.error('meta error', err);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  try {
    const provider = providerForId(id);
    if (!provider) return { streams: [] };
    const streams = await provider.getStreams(id);
    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Addon corriendo en http://127.0.0.1:${PORT}/manifest.json`);
