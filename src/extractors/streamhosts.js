// Resolver de StreamWish y VidHide (y sus dominios espejo) para el provider
// de Cuevana. Es la lógica de feelling-bitter adaptada a este addon:
//
//  1. Camino HTTP (rápido, sin navegador): sigue las redirecciones (HTTP y
//     client-side) hasta la página real del player, desempaqueta el JS y saca
//     el link con preferencia hls4 > hls3 > hls2:
//        hls4 = /stream/... en el dominio del propio embed (segmentos públicos)
//        hls3 = CDN de StreamWish (playlists .txt, segmentos .woff2)
//        hls2 = CDN firmado con token atado a la red que pidió el embed (el que
//               más falla, se deja de último)
//     Antes se tomaba el PRIMERO que apareciera, y el orden cambia entre pedidos.
//  2. Camino con navegador (opcional): si el HTTP no encontró nada, abre el
//     embed en Chromium headless e intercepta el .m3u8/.txt que pide el player.
//     Se serializa, se limita la cola y se cachea el resultado. Si "puppeteer"
//     no está instalado, este paso simplemente se omite.
//
// Los headers devueltos replican lo que mandaría el navegador de verdad:
// Origin = origen de la PÁGINA del embed (no del CDN) y Referer = la página si el
// master está en el mismo origen, o su origen + "/" si es cross-origin.

const { getHtmlWithUrl, DEFAULT_HEADERS } = require('../http');
const { fixHostsLinks } = require('./generic');
const { unpackEvalBlocks, findMutantRedirect, makeAbsoluteVh } = require('./hls');

let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  /* opcional: sin puppeteer solo corre el camino HTTP */
}

const BROWSER_ENABLED = process.env.BROWSER_FALLBACK !== '0';
const BROWSER_TIMEOUT_MS = parseInt(process.env.BROWSER_TIMEOUT_MS || '25000', 10);
const BROWSER_QUEUE_MAX = parseInt(process.env.BROWSER_QUEUE_MAX || '3', 10);
const POS_TTL_MS = 10 * 60 * 1000; // resultado bueno: 10 min (los tokens duran horas)
const NEG_TTL_MS = 90 * 1000; // resultado vacío: 90 s (evita relanzar Chromium en cada reintento de Stremio)

// ---------------------------------------------------------------- familias
const STREAMWISH_HOSTS = [
  'streamwish', 'hglink', 'hgplaycdn', 'swdyu', 'cybervynx', 'dumbalag', 'niramirus',
  'embedwish', 'wishfast', 'strwish', 'awish', 'flaswish', 'embedrise', 'kerapoxy',
  'vibuxer', 'audinifer', 'hanerix', 'medixiru',
];
const VIDHIDE_HOSTS = [
  'vidhide', 'vidhidepro', 'vidhideplus', 'mivalyo', 'dinisglows', 'dhtpre',
  'filelions', 'callistanise', 'morencius', 'earnvids',
];

function familyOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
  if (STREAMWISH_HOSTS.some((h) => host.includes(h))) return 'streamwish';
  if (VIDHIDE_HOSTS.some((h) => host.includes(h))) return 'vidhide';
  return null;
}

// ------------------------------------------------------------ selección hls
const HLS_KEY_PREFERENCE = ['hls4', 'hls3', 'hls2'];
const HLS_LIKE = /\.(?:m3u8|txt)(?:\?|#|$)/i;

function pickPreferredHls(code, base) {
  const found = {};
  const re = /["']?\b(hls[234])["']?\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (!found[m[1]]) found[m[1]] = m[2].replace(/\\\//g, '/');
  }
  for (const key of HLS_KEY_PREFERENCE) {
    if (found[key] && HLS_LIKE.test(found[key])) {
      return { url: makeAbsoluteVh(found[key], base), key };
    }
  }
  return null;
}

function browserLikeHeaders(masterUrl, pageUrl) {
  let pageOrigin;
  let masterOrigin;
  try {
    pageOrigin = new URL(pageUrl).origin;
    masterOrigin = new URL(masterUrl).origin;
  } catch (e) {
    return { Referer: pageUrl };
  }
  return {
    Referer: masterOrigin === pageOrigin ? pageUrl.split('#')[0] : `${pageOrigin}/`,
    Origin: pageOrigin,
  };
}

// -------------------------------------------------------------- camino HTTP
async function resolveViaHttp(startUrl) {
  const visited = new Set();
  let currentUrl = startUrl;
  let referer = 'https://www.google.com/';

  for (let hop = 0; hop < 4; hop++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    let page;
    try {
      page = await getHtmlWithUrl(currentUrl, { headers: { Referer: referer } });
    } catch (e) {
      return null;
    }
    const finalUrl = page.url || currentUrl;
    visited.add(finalUrl);

    let origin;
    try {
      origin = new URL(finalUrl).origin;
    } catch (e) {
      return null;
    }

    const code = `${unpackEvalBlocks(page.html)}\n${page.html}`;
    const picked = pickPreferredHls(code, origin);
    if (picked) {
      return { url: picked.url, key: picked.key, headers: browserLikeHeaders(picked.url, finalUrl) };
    }

    const next = findMutantRedirect(page.html, origin);
    if (!next || visited.has(next)) return null;
    currentUrl = next;
    referer = `${origin}/`;
  }
  return null;
}

// ---------------------------------------------------------- camino navegador
let _browser = null;
let _brokenUntil = 0;
let _queue = Promise.resolve();
let _pending = 0;

function withLock(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(() => undefined, () => undefined);
  return run;
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const opts = {
    headless: 'new',
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  _browser = await puppeteer.launch(opts);
  return _browser;
}

const AD_KEYWORDS = ['/ads/', 'vast', 'vpaid', 'popads', 'popcash', 'pop.', 'tracker', 'analytics', 'doubleclick', 'adservice', 'adsystem'];
const CLICK_SELECTORS = [
  'video', '.jw-icon-playback', '.vjs-big-play-button', '.play-button', '#player',
  '.plyr__control--overlaid', '.vjs-play-control', '[id="start"]', 'img[src*="play"]',
  '[class*="skip" i]', '[id*="skip" i]', '.videoAdUiSkipButton', '.ytp-ad-skip-button',
  'button[aria-label*="skip" i]',
];

async function browserResolveInner(embedUrl, timeoutMs) {
  let page;
  let onTargetCreated;
  let browser;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);
    await page.setRequestInterception(true);
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* noop */ } });

    let resolved = null;
    let pageOrigin = null;
    try { pageOrigin = new URL(embedUrl).origin; } catch (e) { /* noop */ }
    let lastReferer = 'https://www.google.com/';
    const originFromReferer = (ref) => {
      if (ref) { try { return new URL(ref).origin; } catch (e) { /* noop */ } }
      return pageOrigin;
    };
    const capture = (url, ref) => {
      const referer = ref || lastReferer;
      return { url, headers: { Referer: referer, Origin: originFromReferer(referer) } };
    };

    onTargetCreated = async (target) => {
      try {
        if (target.opener() === page.target()) {
          const popup = await target.page();
          if (popup) await popup.close();
        }
      } catch (e) { /* noop */ }
    };
    browser.on('targetcreated', onTargetCreated);

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();
      const low = url.toLowerCase();
      if (AD_KEYWORDS.some((kw) => low.includes(kw))) { req.abort(); return; }
      if (type === 'image' || type === 'font') { req.abort(); return; }
      if (!resolved && type !== 'document' && (/\.m3u8(\?|$)/i.test(url) || /master\.json(\?|$)/i.test(url))) {
        resolved = capture(url, req.headers()['referer']);
      }
      if (!resolved && type === 'media' && /\.mp4(\?|$)/i.test(url)) {
        resolved = capture(url, req.headers()['referer']);
      }
      req.continue();
    });

    // Los masters .txt de StreamWish no matchean por URL: se detectan por content-type.
    page.on('response', (resp) => {
      if (resolved) return;
      try {
        const ct = resp.headers()['content-type'] || '';
        if (/mpegurl|vnd\.apple\.mpegurl|dash\+xml/i.test(ct) || /^video\/mp4/i.test(ct)) {
          resolved = capture(resp.url(), resp.request().headers()['referer']);
        }
      } catch (e) { /* noop */ }
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) lastReferer = frame.url();
    });

    try {
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs, referer: 'https://www.google.com/' });
    } catch (e) { /* puede que ya haya resuelto durante la navegación */ }

    const viewport = page.viewport() || { width: 1280, height: 720 };
    const cx = Math.floor(viewport.width / 2);
    const cy = Math.floor(viewport.height / 2);

    const clickEverywhere = async () => {
      try { await page.mouse.click(cx, cy); } catch (e) { /* noop */ }
      for (const frame of page.frames()) {
        try {
          await frame.evaluate((sels) => {
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) { try { el.click(); } catch (e) { /* noop */ } }
            }
            const video = document.querySelector('video');
            if (video) { try { video.muted = true; video.play().catch(() => {}); } catch (e) { /* noop */ } }
          }, CLICK_SELECTORS);
        } catch (e) { /* noop */ }
      }
    };

    await clickEverywhere();
    let attempts = 1;
    const start = Date.now();
    let lastClickAt = start;
    while (!resolved && Date.now() - start < timeoutMs) {
      if (attempts < 5 && Date.now() - lastClickAt > 3000) {
        lastClickAt = Date.now();
        attempts++;
        await clickEverywhere();
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return resolved;
  } catch (e) {
    console.log('[streamhosts] Puppeteer error:', e.message);
    if (/timed out|Target closed|Connection closed|Protocol error|Failed to launch|Could not find/i.test(e.message || '')) {
      try { if (_browser) await _browser.close(); } catch (_e) { /* noop */ }
      _browser = null;
      if (/Failed to launch|Could not find/i.test(e.message || '')) {
        // Chromium no arranca (faltan librerías/binario): no se insiste por un rato.
        _brokenUntil = Date.now() + 10 * 60 * 1000;
        console.log('[streamhosts] Chromium no disponible, se desactiva el camino con navegador por 10 min');
      }
    }
    return null;
  } finally {
    if (browser && onTargetCreated) { try { browser.off('targetcreated', onTargetCreated); } catch (e) { /* noop */ } }
    if (page) { try { await page.close(); } catch (e) { /* noop */ } }
  }
}

async function resolveViaBrowser(embedUrl) {
  if (!puppeteer || !BROWSER_ENABLED) return null;
  if (Date.now() < _brokenUntil) return null;
  if (_pending >= BROWSER_QUEUE_MAX) {
    console.log(`[streamhosts] cola del navegador llena (${_pending}), se omite: ${embedUrl}`);
    return null;
  }
  _pending++;
  try {
    return await withLock(() => browserResolveInner(embedUrl, BROWSER_TIMEOUT_MS));
  } finally {
    _pending--;
  }
}

// ------------------------------------------------------------------- caché
const _cache = new Map();
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) { _cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value) {
  if (_cache.size > 300) _cache.clear();
  _cache.set(key, { value, exp: Date.now() + (value ? POS_TTL_MS : NEG_TTL_MS) });
}

// ------------------------------------------------------------- punto de entrada
/**
 * Si `rawUrl` es de la familia StreamWish o VidHide devuelve
 * { url, type, headers, label, via, lightProxy }, o null si no se pudo resolver
 * (el llamador puede entonces probar el resolver genérico de siempre).
 * Si no es de esas familias devuelve null sin hacer nada.
 *
 * opts.force: 'http' | 'browser' (solo para pruebas desde /debug/advanced).
 */
const _inflight = new Map();

async function resolveEmbedAdvanced(rawUrl, fallbackReferer, opts = {}) {
  const url = fixHostsLinks(rawUrl);
  const family = familyOf(url);
  if (!family) return null;

  const cached = opts.force ? undefined : cacheGet(url);
  if (cached !== undefined) return cached;

  // Si ya hay una resolución en curso para este embed (p.ej. Stremio reintenta el
  // mismo pedido mientras Chromium sigue trabajando), se comparte en vez de
  // lanzar otra.
  if (!opts.force && _inflight.has(url)) return _inflight.get(url);
  const p = doResolve(url, family, opts);
  if (!opts.force) {
    _inflight.set(url, p);
    p.then(() => _inflight.delete(url), () => _inflight.delete(url));
  }
  return p;
}

async function doResolve(url, family, opts) {
  const label = family === 'streamwish' ? 'StreamWish' : 'VidHide';

  const t0 = Date.now();
  let via = 'http';
  let r = null;
  if (opts.force !== 'browser') r = await resolveViaHttp(url);
  if (!r && opts.force !== 'http') {
    via = 'browser';
    r = await resolveViaBrowser(url);
  }

  if (!r) {
    console.log(`[streamhosts] ${label} sin resultado (${Date.now() - t0}ms): ${url}`);
    cacheSet(url, null);
    return null;
  }

  const isMp4 = /\.mp4(\?|#|$)/i.test(r.url);
  const out = {
    url: r.url,
    type: isMp4 ? 'mp4' : 'hls',
    headers: r.headers,
    label,
    via,
    // Todo HLS de estas familias se sirve por el proxy liviano (la playlist la baja
    // el server con los headers del navegador; los segmentos van directo al CDN
    // con proxyHeaders): es la configuración que funciona en feelling-bitter y
    // bookish-tribble. Además evita que el player reciba un .txt sin extensión
    // .m3u8 y que el link dependa de quién lo pida (los tokens se emitieron para
    // la red de este server).
    lightProxy: !isMp4,
  };
  console.log(`[streamhosts] ${label} via ${via} (${Date.now() - t0}ms)${r.key ? ` [${r.key}]` : ''}: ${r.url}`);
  cacheSet(url, out);
  return out;
}

module.exports = { resolveEmbedAdvanced, familyOf, pickPreferredHls, browserLikeHeaders };
