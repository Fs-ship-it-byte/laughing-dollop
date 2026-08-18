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
      if (!sourceUrl) return null;

      const resolved = await resolveGenericEmbed(sourceUrl, MAIN_URL);
      if (!resolved) return null;

      return {
        name: `Cuevana`,
        title: `${language} - ${resolved.type.toUpperCase()}`,
        url: resolved.url,
        behaviorHints: { notWebReady: resolved.type === 'hls' },
      };
    })
  );

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

module.exports = { getCatalog, search, getMeta, getStreams, PREFIX, CATALOGS };
