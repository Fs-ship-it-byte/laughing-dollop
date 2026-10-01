// Provider de GNULA. Reutiliza el resolver avanzado de streamhosts.js
// (preferencia hls4>hls3>hls2, proxy liviano, respaldo con navegador) que ya
// se armó para Cuevana -- acá la única diferencia es que GNULA da el
// "locker" (vidhide/streamwish/etc) directo en su JSON, así que se lo pasamos
// como forcedFamily en vez de depender de que la URL del embed lo delate por
// su dominio (los links de GNULA son todos player.gnula.life/player.php?h=...,
// un envoltorio que redirige por JS al dominio real).

const GN = require('../sources/gnula');
const { resolveEmbedAdvanced } = require('../extractors/streamhosts');
const { resolveGenericEmbed } = require('../extractors/generic');
const { pickBestMatch } = require('../matching');

const PREFIX = 'gnula';

const LOCKER_FAMILY = { vidhide: 'vidhide', streamwish: 'streamwish' };

async function resolveServer(server) {
  const forcedFamily = server.locker ? LOCKER_FAMILY[server.locker.toLowerCase()] : null;
  try {
    if (forcedFamily) {
      const r = await resolveEmbedAdvanced(server.url, undefined, { forcedFamily });
      if (r) return r;
    }
    // Lockers sin soporte dedicado (doodstream/filemoon/streamtape/voe/etc):
    // se intenta el resolver genérico como mejor esfuerzo, sin garantía.
    const generic = await resolveGenericEmbed(server.url);
    return generic;
  } catch (e) {
    return null;
  }
}

async function getStreamsByTitle(title, { type, season, episode, titleEs, originalTitle, year } = {}) {
  const wantType = type === 'series' ? 'series' : 'movie';
  const queries = [...new Set([titleEs, title, originalTitle].filter(Boolean))];
  const seen = new Map();
  for (const q of queries) {
    const results = await GN.searchGnula(q);
    console.log(`[gnula] búsqueda "${q}" -> ${results.length} resultados`);
    for (const r of results) if (!seen.has(r.url)) seen.set(r.url, r);
  }
  const match = pickBestMatch([...seen.values()], queries, wantType, year);
  console.log(`[gnula] match para "${queries[0]}":`, match ? match.name : 'NINGUNO');
  if (!match) return [];

  let detail;
  let servers;
  if (wantType === 'series' && season && episode) {
    const slug = GN.gnlSeriesSlugFromUrl(match.url);
    if (!slug) return [];
    detail = await GN.fetchGnulaEpisode(GN.gnlEpisodeUrl(slug, season, episode));
  } else {
    detail = await GN.fetchGnulaMovie(match.url);
  }
  if (!detail) return [];
  servers = detail.servers || [];
  console.log(`[gnula] ${match.url} -> ${servers.length} servidores encontrados`);

  const resolved = await Promise.all(servers.map((s) => resolveServer(s)));
  const streams = [];
  resolved.forEach((r, i) => {
    if (!r) { console.log(`[gnula] no se pudo resolver el embed: ${servers[i].url}`); return; }
    const s = servers[i];
    const label = [s.languageLabel, r.label].filter(Boolean).join(' · ') || 'Servidor';
    streams.push({
      name: 'GNULA',
      title: `${label} · ${(r.type || 'hls').toUpperCase()}`,
      url: r.url,
      type: r.type,
      headers: r.headers,
      lightProxy: !!r.lightProxy,
    });
  });
  console.log(`[gnula] streams encontrados: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, getStreamsByTitle };
