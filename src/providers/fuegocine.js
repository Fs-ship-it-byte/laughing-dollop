// Provider de FuegoCine. Sus links a veces YA son el archivo final (un .mp4
// directo en rumble.cloud/firestream.to/eintim.me/pixeldrain) y a veces son
// un embed real (doodstream, streamtape, ok.ru, drive.google, unlimplay) --
// ver el hallazgo en potential-wizard: antes esos directos se descartaban
// sin ofrecerlos porque no matcheaban ningún resolver de embed.

const FC = require('../sources/fuegocine');
const { resolveGenericEmbed } = require('../extractors/generic');
const { pickBestMatch } = require('../matching');

const PREFIX = 'fuegocine';

const DIRECT_FILE_RE = /\.(mp4|mkv|webm|m3u8)(\?|#|$)/i;
const EMBED_PATH_RE = /player\.php|\/e\/|\/embed\/|\/v\/|\/f\/embed\//i;

async function resolveLink(url) {
  if (DIRECT_FILE_RE.test(url) && !EMBED_PATH_RE.test(url)) {
    return { url, type: /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : 'mp4', headers: {} };
  }
  try {
    return await resolveGenericEmbed(url);
  } catch (e) {
    return null;
  }
}

async function getStreamsByTitle(title, { type, titleEs, originalTitle, year } = {}) {
  // FuegoCine solo tiene fichas de película (sin fetcher de episodio individual).
  if (type === 'series') return [];

  const queries = [...new Set([titleEs, title, originalTitle].filter(Boolean))];
  const seen = new Map();
  for (const q of queries) {
    const results = await FC.searchFc(q);
    console.log(`[fuegocine] búsqueda "${q}" -> ${results.length} resultados`);
    for (const r of results) if (!seen.has(r.url)) seen.set(r.url, r);
  }
  const match = pickBestMatch([...seen.values()], queries, 'movie', year);
  console.log(`[fuegocine] match para "${queries[0]}":`, match ? match.name : 'NINGUNO');
  if (!match) return [];

  const detail = await FC.fetchFcDetail(match.url);
  if (!detail || !detail.links.length) return [];
  console.log(`[fuegocine] ${match.url} -> ${detail.links.length} links encontrados`);

  const resolved = await Promise.all(detail.links.map((l) => resolveLink(l.url)));
  const streams = [];
  resolved.forEach((r, i) => {
    if (!r) { console.log(`[fuegocine] no se pudo resolver: ${detail.links[i].url}`); return; }
    const l = detail.links[i];
    streams.push({
      name: 'FuegoCine',
      title: [l.name, l.lang, l.quality].filter(Boolean).join(' · ') || 'Servidor',
      url: r.url,
      type: r.type,
      headers: r.headers,
      lightProxy: !!r.lightProxy,
    });
  });
  console.log(`[fuegocine] streams encontrados: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, getStreamsByTitle };
