const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookieFactory = require('fetch-cookie');

// Jar compartido: persiste cookies de sesión entre peticiones (necesario porque
// varios sitios ahora validan el CSRF/sesión y devuelven una página de
// verificación (HTML) en vez del JSON esperado si no llega la cookie correcta).
const jar = new CookieJar();
const fetchWithCookies = fetchCookieFactory(fetch, jar);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

async function getHtml(url, opts = {}) {
  const res = await fetchWithCookies(url, {
    headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
    } catch (e) {
      /* ignore */
    }
    const err = new Error(`GET ${url} -> HTTP ${res.status}${snippet ? ` | body: ${snippet}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// Igual que getHtml pero devuelve también la URL FINAL (después de seguir las
// redirecciones HTTP). Hace falta para saber en qué dominio quedó realmente el
// player (p.ej. streamwish.to -> vibuxer.com): de ahí salen el Referer/Origin
// que el CDN espera.
async function getHtmlWithUrl(url, opts = {}) {
  const res = await fetchWithCookies(url, {
    headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const err = new Error(`GET ${url} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const html = await res.text();
  return { html, url: res.url || url };
}

module.exports = { getHtml, getHtmlWithUrl, DEFAULT_HEADERS, fetchWithCookies, jar };
