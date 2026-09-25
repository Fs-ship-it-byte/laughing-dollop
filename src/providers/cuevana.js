const cheerio = require('cheerio');
const { getHtml } = require('../http');
const { resolveGenericEmbed } = require('../extractors/generic');
const { resolveEmbedAdvanced } = require('../extractors/streamhosts');

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
  const yearText = $(el).find('span.Year, .Year').first().text().trim();
  const year = /^\d{4}$/.test(yearText) ? parseInt(yearText, 10) : undefined;
  return {
    id: toId(href),
    type: isSeries ? 'series' : 'movie',
    name: title,
    poster: img,
    year,
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

// Un embed que tarda más que esto (típicamente StreamWish esperando a Chromium) no
// retiene a los demás: se responde con lo que ya está, y la resolución sigue en
// segundo plano y queda en caché para el próximo pedido (Stremio suele reintentar).
const EMBED_BUDGET_MS = parseInt(process.env.EMBED_BUDGET_MS || '20000', 10);
const TIMED_OUT = Symbol('timeout');
function withBudget(promise, ms) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function loadStreamSources(pageUrl) {
  const html = await getHtml(pageUrl);
  const $ = cheerio.load(html);
  const jobs = [];

  $('li.open_submenu').each((_, submenu) => {
    const language = normalizeLanguageLabel($(submenu).text());

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

      // StreamWish / VidHide (y espejos): resolver avanzado (preferencia hls4 > hls3 >
      // hls2, headers como el navegador, respaldo con Chromium). Si no es de esas
      // familias o no resuelve, se cae al resolver genérico de siempre, así que
      // los servidores HLS que ya funcionaban siguen igual.
      let resolved = await withBudget(
        resolveEmbedAdvanced(sourceUrl, MAIN_URL).catch(() => null),
        EMBED_BUDGET_MS
      );
      if (resolved === TIMED_OUT) {
        console.log(`[cuevana] ${EMBED_BUDGET_MS}ms agotados, sigue en segundo plano (queda en caché): ${sourceUrl}`);
        return null;
      }
      if (!resolved) resolved = await resolveGenericEmbed(sourceUrl, MAIN_URL);
      if (!resolved) {
        console.log(`[cuevana] no se pudo resolver el embed: ${sourceUrl}`);
        return null;
      }

      return {
        name: `Cuevana`,
        title: `${language} - ${resolved.label ? `${resolved.label} ` : ''}${resolved.type.toUpperCase()}`,
        url: resolved.url,
        type: resolved.type,
        headers: resolved.headers,
        lightProxy: !!resolved.lightProxy,
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

// El sitio marca el audio latino como "Español" en el menú de servidores; se
// muestra como "Latino" (que es lo que realmente es), y Castellano/Subtitulado
// se dejan como están.
function normalizeLanguageLabel(raw) {
  const t = (raw || '').toLowerCase();
  if (t.includes('latino')) return 'Latino';
  if (t.includes('castellano')) return 'Castellano';
  if (t.includes('sub')) return 'Subtitulado';
  if (t.includes('espa')) return 'Latino';
  return (raw || '').trim().split(/\s+/)[0] || 'Latino';
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Puntaje por solapamiento de palabras (Jaccard), no por substring: "How to
// Train Your Dragon" contra "Cazadores de Dragones (Dragon Hunters)" antes
// daba 0 en ambos sentidos y el código igual se quedaba con ese resultado por
// ser el primero de la lista (bestScore arrancaba en -1). Ahora un resultado
// sin relación real no se acepta ("NINGUNO" es mejor que un video equivocado).
function wordOverlapScore(a, b) {
  const wa = new Set(a.split(' ').filter((w) => w.length > 1));
  const wb = new Set(b.split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = inter / union;
  const exact = a === b ? 1 : 0;
  const substr = a.includes(b) || b.includes(a) ? 0.5 : 0;
  return Math.max(jaccard, substr) + exact * 0.5;
}

const MIN_MATCH_SCORE = 0.34; // al menos un buen puñado de palabras en común

// El sitio suele indexar todo como "movie" aunque TMDB diga "series" (o al
// revés), así que el tipo pesa como preferencia, no como filtro obligatorio:
// antes, pedir "series" cuando el sitio la tenía listada distinto daba
// "NINGUNO" aunque el resultado correcto estuviera ahí.
async function findBestMatch(titles, wantType, year) {
  const queries = [...new Set(titles.filter(Boolean))];
  const seen = new Map();
  for (const q of queries) {
    const results = await search(q);
    console.log(`[cuevana] search("${q}") -> ${results.length} resultados:`,
      results.slice(0, 5).map((r) => `${r.name} [${r.type}]`));
    for (const r of results) if (!seen.has(r.id)) seen.set(r.id, r);
  }

  const targets = queries.map(normalize);
  let best = null;
  let bestScore = -1;
  for (const r of seen.values()) {
    const n = normalize(r.name);
    let score = Math.max(...targets.map((t) => wordOverlapScore(t, n)));
    if (wantType && r.type === wantType) score += 0.2;
    if (year && r.year && Math.abs(r.year - year) <= 1) score += 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  const chosen = bestScore >= MIN_MATCH_SCORE ? best : null;
  console.log(`[cuevana] match elegido para "${queries[0]}":`,
    chosen ? `${chosen.name} (score ${bestScore.toFixed(2)})` : `NINGUNO (mejor score ${bestScore.toFixed(2)})`);
  return chosen;
}

/**
 * Punto de entrada para el addon "sin catálogo propio": recibe el título
 * (resuelto vía TMDB a partir del id de IMDb) y devuelve los streams,
 * sin que este provider necesite tener su propio catálogo/paginado.
 */
async function getStreamsByTitle(title, { type, season, episode, titleEs, originalTitle, year } = {}) {
  const wantType = type === 'series' ? 'series' : 'movie';
  // Se busca primero en español (lo que de verdad hay en el sitio) y el
  // título en inglés/original queda de respaldo si TMDB no tiene traducción.
  const match = await findBestMatch([titleEs, title, originalTitle], wantType, year);
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

module.exports = {
  getCatalog,
  search,
  getMeta,
  getStreams,
  getStreamsByTitle,
  loadStreamSources,
  PREFIX,
  CATALOGS,
};
