const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { getHtml, DEFAULT_HEADERS } = require('../http');
const { resolveGenericEmbed, fixHostsLinks } = require('../extractors/generic');
const { loadEmbed69 } = require('../extractors/embed69');

const MAIN_URL = 'https://sololatino.net'; // revisar si cambia el dominio
const PREFIX = 'sololatino';

function toId(href) {
  const path = href.replace(MAIN_URL, '');
  return `${PREFIX}:${Buffer.from(path).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  const path = Buffer.from(b64, 'base64url').toString('utf8');
  return `${MAIN_URL}${path}`;
}

function parseCard($, el) {
  const title = $(el).find('div.card__info p.card__title').text().trim() || 'Sin título';
  let href = $(el).find('a').attr('href') || '';
  if (href.startsWith('/')) href = `${MAIN_URL}${href}`;
  const img = $(el).find('a div.card__poster-wrap img.card__poster').attr('src');
  const isSeries = !href.includes('/pelicula/');
  return {
    id: toId(href),
    type: isSeries ? 'series' : 'movie',
    name: title,
    poster: img,
  };
}

const CATALOGS = {
  peliculas: 'peliculas',
  series: 'series',
  animes: 'animes',
  cartoons: 'peliculas?genero=animacion&sort=popular',
};

async function getCatalog(catalogId, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const section = CATALOGS[catalogId] || CATALOGS.peliculas;
  const separator = section.includes('?') ? '&' : '?';
  const html = await getHtml(`${MAIN_URL}/${section}${separator}page=${page}`);
  const $ = cheerio.load(html);
  return $('div.card')
    .map((_, el) => parseCard($, el))
    .get();
}

async function search(query) {
  const html = await getHtml(`${MAIN_URL}/buscar?q=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);
  return $('div.card')
    .map((_, el) => parseCard($, el))
    .get();
}

async function getMeta(id) {
  const url = fromId(id);
  const html = await getHtml(url);
  const $ = cheerio.load(html);

  const isMovie = url.includes('/pelicula/');
  const title = $('.w-44').attr('alt') || '';
  const poster = $('.w-44').attr('src');
  const backStyle = $('.detail-hero__bg').attr('style') || '';
  const background = backStyle.split("url('")[1]?.split("');")[0] || poster;
  const description = $('p.text-sm.leading-relaxed.max-w-2xl').first().text().trim();
  const yearText = $('div.flex.flex-wrap.items-center.text-sm span').first().text().trim();
  const year = parseInt(yearText, 10) || undefined;
  const genres = $('div.flex-1.min-w-0 a[href*="/genero/"]')
    .map((_, el) => $(el).text().trim())
    .get();

  let videos = [];
  if (!isMovie) {
    $('div[data-season-panel]').each((_, panel) => {
      const season = parseInt($(panel).attr('data-season-panel'), 10);
      $(panel)
        .find('a.ep-item')
        .each((idx, epEl) => {
          let epUrl = $(epEl).attr('href') || '';
          if (epUrl.startsWith('/')) epUrl = `${MAIN_URL}${epUrl}`;
          const epTitle = $(epEl)
            .find('p.text-sm.font-semibold.text-white.leading-tight')
            .text()
            .trim();
          const thumb = $(epEl).find('img.ep-thumb').attr('src');
          videos.push({
            id: `${id}:${season}:${idx + 1}`,
            title: epTitle || `Episodio ${idx + 1}`,
            season,
            episode: idx + 1,
            thumbnail: thumb,
            _url: epUrl,
          });
        });
    });
  }

  const type = isMovie ? 'movie' : 'series';

  return {
    id,
    type,
    name: title,
    description,
    poster,
    background,
    year,
    genres,
    videos: type === 'series' ? videos : undefined,
    _url: url,
  };
}

async function loadStreamSources(pageUrl) {
  const html = await getHtml(pageUrl);
  const $ = cheerio.load(html);
  const csrf = $('meta[name="csrf-token"]').attr('content') || '';

  const tokens = $('button.server-btn')
    .map((_, el) => $(el).attr('data-player-token'))
    .get()
    .filter(Boolean);

  console.log(`[sololatino] ${pageUrl} -> ${tokens.length} botones de servidor (csrf: ${csrf ? 'sí' : 'NO'})`);

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const res = await fetch(`${MAIN_URL}/api/player-url`, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrf,
          Accept: 'application/json',
        },
        body: JSON.stringify({ t: token }),
      });
      const data = await res.json();
      if (!data?.url) {
        console.log('[sololatino] token sin url en la respuesta de /api/player-url');
        return null;
      }

      if (data.type === 'mp4') {
        return [
          {
            name: 'SoloLatino',
            title: 'Directo MP4',
            url: data.url,
            type: 'mp4',
            headers: { Referer: pageUrl },
          },
        ];
      }
      if (data.url.startsWith('https://embed69.org/')) {
        const streams = await loadEmbed69(data.url, pageUrl);
        console.log(`[sololatino] embed69 -> ${streams.length} streams`);
        return streams.map((s) => ({
          name: 'SoloLatino',
          title: `${s.language} - ${s.type.toUpperCase()}`,
          url: s.url,
          type: s.type,
          headers: s.headers,
          behaviorHints: { notWebReady: s.type === 'hls' },
        }));
      }
      if (data.url.startsWith('https://xupalace.org/video')) {
        const embedHtml = await getHtml(data.url);
        const matches = [
          ...embedHtml.matchAll(/(?:go_to_player|go_to_playerVast)\('(.*?)'/g),
        ].map((m) => m[1]);
        const sub = await Promise.allSettled(
          matches.map((m) => resolveGenericEmbed(fixHostsLinks(m), pageUrl))
        );
        return sub
          .filter((r) => r.status === 'fulfilled' && r.value)
          .map((r) => ({
            name: 'SoloLatino',
            title: r.value.type.toUpperCase(),
            url: r.value.url,
            type: r.value.type,
            headers: r.value.headers,
            behaviorHints: { notWebReady: r.value.type === 'hls' },
          }));
      }
      // Caso genérico: la url es una página intermedia con un iframe adentro.
      const midHtml = await getHtml(data.url);
      const $$ = cheerio.load(midHtml);
      const iframeSrc = $$('iframe').first().attr('src');
      if (!iframeSrc) {
        console.log(`[sololatino] sin <iframe> en la página intermedia: ${data.url}`);
        return null;
      }
      const resolved = await resolveGenericEmbed(fixHostsLinks(iframeSrc), pageUrl);
      if (!resolved) {
        console.log(`[sololatino] no se pudo resolver el embed: ${iframeSrc}`);
        return null;
      }
      return [
        {
          name: 'SoloLatino',
          title: resolved.type.toUpperCase(),
          url: resolved.url,
          type: resolved.type,
          headers: resolved.headers,
          behaviorHints: { notWebReady: resolved.type === 'hls' },
        },
      ];
    })
  );

  results.forEach((r) => {
    if (r.status === 'rejected') {
      console.log('[sololatino] servidor falló:', r.reason?.message || r.reason);
    }
  });

  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .flatMap((r) => r.value);
}

async function getStreams(id) {
  const parts = id.split(':');
  const baseId = `${parts[0]}:${parts[1]}`;

  if (parts.length === 4) {
    const meta = await getMeta(baseId);
    const season = parseInt(parts[2], 10);
    const episode = parseInt(parts[3], 10);
    const video = meta.videos?.find((v) => v.season === season && v.episode === episode);
    if (!video) return [];
    return loadStreamSources(video._url);
  }

  const pageUrl = fromId(baseId);
  return loadStreamSources(pageUrl);
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function findBestMatch(title, wantType) {
  const results = await search(title);
  console.log(`[sololatino] search("${title}") -> ${results.length} resultados:`,
    results.slice(0, 5).map((r) => `${r.name} [${r.type}]`));
  const target = normalize(title);
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (wantType && r.type !== wantType) continue;
    const n = normalize(r.name);
    const score = n === target ? 2 : n.includes(target) || target.includes(n) ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  const chosen = best || results.find((r) => !wantType || r.type === wantType) || null;
  console.log(`[sololatino] match elegido para "${title}":`, chosen ? chosen.name : 'NINGUNO');
  return chosen;
}

async function getStreamsByTitle(title, { type, season, episode } = {}) {
  const wantType = type === 'series' ? 'series' : 'movie';
  const match = await findBestMatch(title, wantType);
  if (!match) return [];

  if (wantType === 'series' && season && episode) {
    const meta = await getMeta(match.id);
    console.log(`[sololatino] episodios encontrados: ${meta.videos?.length || 0}`);
    const video = meta.videos?.find((v) => v.season === season && v.episode === episode);
    if (!video) {
      console.log(`[sololatino] no se encontró S${season}E${episode}`);
      return [];
    }
    const streams = await loadStreamSources(video._url);
    console.log(`[sololatino] streams de episodio: ${streams.length}`);
    return streams;
  }

  const pageUrl = fromId(match.id);
  const streams = await loadStreamSources(pageUrl);
  console.log(`[sololatino] streams encontrados: ${streams.length}`);
  return streams;
}

module.exports = { getCatalog, search, getMeta, getStreams, getStreamsByTitle, PREFIX, CATALOGS };
