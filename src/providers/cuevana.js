const cheerio = require('cheerio');
const { getHtml } = require('../http');
const { resolveGenericEmbed } = require('../extractors/generic');

const MAIN_URL = 'https://wv3.cuevana3.eu'; // el dominio de Cuevana cambia seguido, revisar si deja de responder
const PREFIX = 'cuevana';

function resolvePoster(src) {
  if (!src) return null;
  if (src.startsWith('/_next/image?url=')) {
    const encoded = src.split('url=')[1].split('&')[0];
    try {
      return decodeURIComponent(encoded);
    } catch {
      return src;
    }
  }
  return src.startsWith('/') ? `${MAIN_URL}${src}` : src;
}

function toId(href) {
  // href viene como URL completa o relativa de cuevana -> guardamos el path como id
  const path = href.replace(MAIN_URL, '');
  return `${PREFIX}:${Buffer.from(path).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  const path = Buffer.from(b64, 'base64url').toString('utf8');
  return `${MAIN_URL}${path}`;
}

function parseCard($, el) {
  const title = $(el).find('span.Title').text().trim() || 'Sin título';
  let href = $(el).find('a').attr('href') || '';
  if (href.startsWith('/')) href = `${MAIN_URL}${href}`;
  const img = resolvePoster($(el).find('img').attr('src'));
  const isSeries = href.includes('/serie/');
  return {
    id: toId(href),
    type: isSeries ? 'series' : 'movie',
    name: title,
    poster: img,
  };
}

const CATALOGS = {
  peliculas: 'peliculas',
  'peliculas-estrenos': 'peliculas/estrenos',
  series: 'series',
  'series-estrenos': 'series/estrenos',
};

async function getCatalog(catalogId, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const section = CATALOGS[catalogId] || CATALOGS.peliculas;
  const html = await getHtml(`${MAIN_URL}/${section}/page/${page}`);
  const $ = cheerio.load(html);
  return $('section li.TPostMv')
    .map((_, el) => parseCard($, el))
    .get();
}

async function search(query) {
  const html = await getHtml(`${MAIN_URL}/search?q=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);
  return $('li.TPostMv')
    .map((_, el) => parseCard($, el))
    .get();
}

async function getMeta(id) {
  const url = fromId(id);
  const html = await getHtml(url);
  const $ = cheerio.load(html);

  const title = $('h1.Title').text().trim();
  const description = $('.Description p').first().text().trim();
  const poster = resolvePoster($('div.backdrop article.TPost div.Image img').attr('src'));
  const background =
    resolvePoster($('div.Image:nth-child(2) img').attr('src')) || poster;
  const yearMatch = $('footer p.meta').html()?.match(/<span>(\d+)<\/span>/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
  const genres = $('ul.InfoList li.AAIco-adjust a')
    .map((_, el) => $(el).text().trim())
    .get();

  let videos = [];
  const nextData = $('script#__NEXT_DATA__').html();
  if (nextData) {
    try {
      const json = JSON.parse(nextData);
      const serie = json?.props?.pageProps?.thisSerie;
      if (serie?.seasons) {
        videos = serie.seasons.flatMap((season) =>
          season.episodes.map((ep) => {
            const epUrl = `${MAIN_URL}/${ep.url.slug
              .replace('series/', 'serie/')
              .replace('seasons/', 'temporada/')
              .replace('episodes/', 'episodio/')}`;
            return {
              id: `${id}:${season.number}:${ep.number}`,
              title: ep.title,
              season: season.number,
              episode: ep.number,
              thumbnail: ep.image,
              released: ep.releaseDate,
              _url: epUrl,
            };
          })
        );
      }
    } catch (_) {
      // JSON embebido no siempre tiene la forma esperada; se ignora y queda como película
    }
  }

  const type = videos.length > 0 ? 'series' : 'movie';

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
  const jobs = [];

  $('li.open_submenu').each((_, submenu) => {
    const language = $(submenu)
      .text()
      .trim()
      .replace(/^([A-Za-z]) /, '$1_')
      .split(' ')[0];

    $(submenu)
      .find('li.clili')
      .each((__, li) => {
        const iframe = $(li).attr('data-tr');
        if (iframe) jobs.push({ language, iframe });
      });
  });

  console.log(`[cuevana] ${pageUrl} -> ${jobs.length} servidores encontrados en la página`);
  if (jobs.length === 0) {
    console.log('[cuevana] li.open_submenu / li.clili no matchearon nada — probable cambio de HTML');
  }

  const results = await Promise.allSettled(
    jobs.map(async ({ language, iframe }) => {
      const embedHtml = await getHtml(iframe);
      const $$ = cheerio.load(embedHtml);
      let sourceUrl = null;
      $$('script').each((_, s) => {
        const content = $$(s).html() || '';
        if (content.includes("var url = '")) {
          sourceUrl = content.split("var url = '")[1]?.split("';")[0];
        }
      });
      if (!sourceUrl) {
        console.log(`[cuevana] iframe ${iframe} -> no se encontró "var url ="`);
        return null;
      }

      const resolved = await resolveGenericEmbed(sourceUrl, MAIN_URL);
      if (!resolved) {
        console.log(`[cuevana] no se pudo resolver el embed: ${sourceUrl}`);
        return null;
      }

      return {
        name: `Cuevana`,
        title: `${language} - ${resolved.type.toUpperCase()}`,
        url: resolved.url,
        referer: resolved.referer,
        behaviorHints: { notWebReady: resolved.type === 'hls' },
      };
    })
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`[cuevana] job ${jobs[i]?.iframe} falló:`, r.reason?.message || r.reason);
    }
  });

  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}

async function getStreams(id) {
  // id puede ser "cuevana:xxx" (película) o "cuevana:xxx:season:episode" (episodio)
  const parts = id.split(':');
  const baseId = `${parts[0]}:${parts[1]}`;
  const pageUrl = fromId(baseId);

  if (parts.length === 4) {
    // Episodio: necesitamos la URL específica del episodio, no la de la serie.
    const meta = await getMeta(baseId);
    const season = parseInt(parts[2], 10);
    const episode = parseInt(parts[3], 10);
    const video = meta.videos?.find((v) => v.season === season && v.episode === episode);
    if (!video) return [];
    return loadStreamSources(video._url);
  }

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
  console.log(`[cuevana] search("${title}") -> ${results.length} resultados:`,
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
  console.log(`[cuevana] match elegido para "${title}":`, chosen ? chosen.name : 'NINGUNO');
  return chosen;
}

/**
 * Punto de entrada para el addon "sin catálogo propio": recibe el título
 * (resuelto vía TMDB a partir del id de IMDb) y devuelve los streams,
 * sin que este provider necesite tener su propio catálogo/paginado.
 */
async function getStreamsByTitle(title, { type, season, episode } = {}) {
  const wantType = type === 'series' ? 'series' : 'movie';
  const match = await findBestMatch(title, wantType);
  if (!match) return [];

  if (wantType === 'series' && season && episode) {
    const meta = await getMeta(match.id);
    console.log(`[cuevana] episodios encontrados: ${meta.videos?.length || 0}`);
    const video = meta.videos?.find((v) => v.season === season && v.episode === episode);
    if (!video) {
      console.log(`[cuevana] no se encontró S${season}E${episode}`);
      return [];
    }
    const streams = await loadStreamSources(video._url);
    console.log(`[cuevana] streams de episodio: ${streams.length}`);
    return streams;
  }

  const pageUrl = fromId(match.id);
  const streams = await loadStreamSources(pageUrl);
  console.log(`[cuevana] streams encontrados: ${streams.length}`);
  return streams;
}

module.exports = { getCatalog, search, getMeta, getStreams, getStreamsByTitle, PREFIX, CATALOGS };
