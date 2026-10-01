// Scraper de FuegoCine -- portado de potential-wizard/lib/sources/fuegocine.js,
// adaptado a getHtml().

const { getHtml } = require('../http');

const FC_BASE = 'https://www.fuegocine.com';
const FC_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function extractFcVideoUrl(url) {
  if (!url) return null;
  const m = url.match(/[?&]link=([^&"]+)/);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (decoded.indexOf('http') === 0) return decoded;
    } catch (e) { /* noop */ }
  }
  if (url.indexOf('http') === 0 && url.indexOf('blogspot.com') === -1) return url;
  return null;
}

function parseFcCards(html) {
  const results = [];
  if (!html) return results;
  let parts = html.split("<div class='crd'");
  if (parts.length < 2) parts = html.split('<div class="crd"');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const um = block.match(/href=['"](https?:\/\/www\.fuegocine\.com\/[0-9]{4}\/[^'"]+\.html)['"]/);
    if (!um) continue;
    const tm = block.match(/crd__title[\s\S]{0,50}?<a[^>]*>([^<]+)<\/a>/);
    if (!tm) continue;
    const title = tm[1].replace(/&#[0-9]+;/g, '').replace(/&amp;/g, '&').trim();
    results.push({ url: um[1], name: title, type: 'movie' });
  }
  return results;
}

function fcMobileUrl(url) {
  if (!url) return url;
  if (url.indexOf('?') === -1) return `${url}?m=1`;
  if (url.indexOf('m=1') === -1) return `${url}&m=1`;
  return url;
}

async function searchFc(query) {
  if (!query) return [];
  const url = `${FC_BASE}/search?q=${encodeURIComponent(query)}&max-results=20&m=1`;
  let html;
  try { html = await getHtml(url, { headers: FC_UA }); } catch (e) { return []; }
  return parseFcCards(html);
}

function parseFcDetail(html) {
  if (!html) return null;
  const data = { links: [] };

  const yearM = html.match(/data-year="([^"]+)"/);
  if (yearM) data.year = parseInt(yearM[1], 10);
  const origM = html.match(/data-original-title="([^"]+)"/);
  if (origM) data.originalTitle = origM[1];

  const svMatch = html.match(/_SV_LINKS\s*=\s*\[([\s\S]*?)\]/);
  if (svMatch) {
    const block = svMatch[1];
    const entryRx = /\{[\s\S]*?lang\s*:\s*"([^"]*)"[\s\S]*?name\s*:\s*"([^"]*)"[\s\S]*?quality\s*:\s*"([^"]*)"[\s\S]*?url\s*:\s*"([^"]*)"[\s\S]*?tagVideo\s*:\s*(true|false)[\s\S]*?\}/g;
    let em;
    while ((em = entryRx.exec(block)) !== null) {
      const rawUrl = em[4].replace(/&amp;/g, '&');
      const realUrl = extractFcVideoUrl(rawUrl);
      if (!realUrl) continue;
      data.links.push({
        lang: em[1],
        name: em[2].replace(/&#[0-9]+;/g, '').replace(/&[a-z]+;/g, '').trim(),
        quality: em[3],
        url: realUrl,
        tagVideo: em[5] === 'true',
      });
    }
  }
  return data;
}

async function fetchFcDetail(url) {
  let html;
  try { html = await getHtml(fcMobileUrl(url), { headers: FC_UA }); } catch (e) { return null; }
  return parseFcDetail(html);
}

module.exports = { searchFc, fetchFcDetail, fcMobileUrl };
