// Scraper de gnula.life -- portado de potential-wizard/lib/sources/gnula.js,
// adaptado a getHtml() (devuelve texto directo) en vez de http.request()
// (devolvía bytes). La lógica de parseo es la misma verificada ahí.

const { getHtml } = require('../http');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const GNL_BASE = 'https://gnula.life';

function gnlTableBlock(html) {
  const m = html.match(/<table class="table[^"]*">([\s\S]*?)<\/table>/);
  return m ? m[1] : html;
}

function gnlField(tableHtml, label) {
  const re = new RegExp('<td>' + label + '<\\/td><td>([\\s\\S]*?)<\\/td>');
  const m = re.exec(tableHtml);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '';
}

async function gnlExtractJsonValue(html, key) {
  const marker = `"${key}":`;
  let searchFrom = 0;
  let idx;
  let start;
  let open;
  for (;;) {
    idx = html.indexOf(marker, searchFrom);
    if (idx === -1) return null;
    start = idx + marker.length;
    const c0 = html.charAt(start);
    if (c0 === '{' || c0 === '[') { open = c0; break; }
    searchFrom = idx + marker.length;
  }
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let i = start;
  for (; i < html.length; i++) {
    const ch = html.charAt(i);
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return i > start ? html.substring(start, i) : null;
}

// El "locker" (vidhide/streamwish/etc) viene directo del JSON del sitio: es
// justo el dato que hace falta para forzar la familia en resolveEmbedAdvanced
// sin depender de que la URL del embed "parezca" streamwish/vidhide.
function gnlNormalizeLangKey(k) {
  if (!k) return '';
  const kk = k.toLowerCase();
  if (kk === 'spanish') return 'castellano';
  if (kk === 'english' || kk === 'ingles') return 'subtitulado';
  return kk;
}

const GNL_LANG_LABELS = {
  latino: 'Latino',
  castellano: 'Castellano',
  subtitulado: 'Inglés',
  ingles: 'Inglés',
  english: 'Inglés',
};

function gnlLangLabel(k) {
  return k ? GNL_LANG_LABELS[k.toLowerCase()] || k : '';
}

function gnlCollectServers(node, langHint, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) gnlCollectServers(item, langHint, out, seen);
    return;
  }
  if (node.result) {
    const locker = node.cyberlocker ? String(node.cyberlocker).toLowerCase() : '';
    if (!seen[node.result]) {
      seen[node.result] = true;
      const lang = gnlNormalizeLangKey(node.language || langHint || '');
      out.push({ url: node.result, language: lang, languageLabel: gnlLangLabel(lang), locker });
    }
    return;
  }
  for (const k of Object.keys(node)) gnlCollectServers(node[k], k, out, seen);
}

function gnlExtractServersFallback(html) {
  const servers = [];
  const seen = {};
  const normalizedHtml = html.replace(/\\\//g, '/');
  const linkRe = /https?:\/\/player\.gnula\.[a-z]+\/(?:player|download)\.php\?h=[A-Za-z0-9_-]+/gi;
  let m;
  while ((m = linkRe.exec(normalizedHtml)) !== null) {
    const lk = m[0].replace(/&amp;/g, '&');
    if (!seen[lk]) { seen[lk] = true; servers.push({ url: lk, locker: '', language: '' }); }
  }
  return servers;
}

async function fetchGnulaMovie(url) {
  let html;
  try { html = await getHtml(url, { headers: UA }); } catch (e) { return null; }
  if (!html) return null;

  const tableHtml = gnlTableBlock(html);
  const data = {};
  data.title = gnlField(tableHtml, 'Título');
  data.originalTitle = gnlField(tableHtml, 'Título Original');
  data.year = gnlField(tableHtml, 'Año de Estreno');
  if (!data.title) {
    const hm = html.match(/<h1[^>]*>([^<|]+)/);
    data.title = hm ? hm[1].replace(/\s*\|.*$/, '').trim() : '';
  }
  if (!data.title) return null;

  data.servers = [];
  const seen = {};
  const playersRaw = await gnlExtractJsonValue(html, 'players');
  let players = null;
  if (playersRaw) {
    try { players = JSON.parse(playersRaw.replace(/\\\//g, '/')); } catch (e) { players = null; }
  }
  if (players) gnlCollectServers(players, '', data.servers, seen);
  if (!data.servers.length) data.servers = gnlExtractServersFallback(html);
  return data;
}

function gnlEpisodeUrl(seriesSlug, season, episode) {
  return `${GNL_BASE}/series/${seriesSlug}/seasons/${season}/episodes/${episode}`;
}

async function fetchGnulaEpisode(url) {
  let html;
  try { html = await getHtml(url, { headers: UA }); } catch (e) { return null; }
  if (!html) return null;

  const serieRaw = await gnlExtractJsonValue(html, 'serie');
  const episodeRaw = await gnlExtractJsonValue(html, 'episode');
  if (!episodeRaw) return null;

  let serie = null;
  let episodeObj;
  try { serie = serieRaw ? JSON.parse(serieRaw.replace(/\\\//g, '/')) : null; } catch (e) { serie = null; }
  try { episodeObj = JSON.parse(episodeRaw.replace(/\\\//g, '/')); } catch (e) { return null; }
  if (!episodeObj) return null;

  const data = {};
  data.seriesTitle = serie && serie.titles ? serie.titles.name : '';
  data.year = '';
  if (serie && serie.releaseDate) data.year = String(serie.releaseDate).substring(0, 4);

  data.servers = [];
  const seen = {};
  if (episodeObj.players) gnlCollectServers(episodeObj.players, '', data.servers, seen);
  if (!data.servers.length) data.servers = gnlExtractServersFallback(html);
  return data;
}

function gnlSeriesSlugFromUrl(url) {
  const m = /gnula\.[a-z]+\/series\/([^/?#]+)/i.exec(url || '');
  return m ? m[1] : '';
}

function gnlDecodeNextImg(src) {
  if (!src) return null;
  const m = /[?&]url=([^&]+)/.exec(src);
  if (!m) return src;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

function parseGnlSearchCards(html) {
  const results = [];
  if (!html) return results;
  const parts = html.split('<article>');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const um = /<a href="(\/(?:movies|series)\/[^"]+)"/.exec(block);
    if (!um) continue;
    const im = /<img[^>]+alt="([^"]*)"[^>]*src="([^"]*)"/.exec(block);
    if (!im) continue;
    const title = im[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (!title) continue;
    const poster = gnlDecodeNextImg(im[2].replace(/&amp;/g, '&'));
    const ym = /<span>(\d{4})<\/span>/.exec(block);
    const isSeries = /\/series\//.test(um[1]);
    results.push({
      url: GNL_BASE + um[1],
      name: title,
      poster,
      year: ym ? parseInt(ym[1], 10) : undefined,
      type: isSeries ? 'series' : 'movie',
    });
  }
  return results;
}

async function searchGnula(query) {
  if (!query) return [];
  const url = `${GNL_BASE}/search?q=${encodeURIComponent(query)}`;
  let html;
  try { html = await getHtml(url, { headers: UA }); } catch (e) { return []; }
  return parseGnlSearchCards(html);
}

module.exports = {
  searchGnula,
  fetchGnulaMovie,
  fetchGnulaEpisode,
  gnlEpisodeUrl,
  gnlSeriesSlugFromUrl,
};
