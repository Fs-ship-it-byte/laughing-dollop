const { getHtml } = require('../http');
const { isPacked, unpack } = require('./unpacker');

// Mismos reemplazos que fixHostsLinks() en el CuevanaProvider original de CS3.
function fixHostsLinks(url) {
  return url
    .replace('https://hglink.to', 'https://streamwish.to')
    .replace('https://swdyu.com', 'https://streamwish.to')
    .replace('https://cybervynx.com', 'https://streamwish.to')
    .replace('https://dumbalag.com', 'https://streamwish.to')
    .replace('https://mivalyo.com', 'https://vidhidepro.com')
    .replace('https://dinisglows.com', 'https://vidhidepro.com')
    .replace('https://dhtpre.com', 'https://vidhidepro.com')
    .replace('https://filemoon.link', 'https://filemoon.sx')
    .replace('https://sblona.com', 'https://watchsb.com')
    .replace('https://lulu.st', 'https://lulustream.com')
    .replace('https://uqload.io', 'https://uqload.com')
    .replace('https://do7go.com', 'https://dood.la');
}

const FILE_REGEX = /(?:file|source)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i;
const SOURCES_ARRAY_REGEX = /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i;

/**
 * Intenta resolver un embed genérico (streamwish/vidhidepro/filemoon/etc)
 * a un link directo reproducible. Cubre los casos comunes basados en
 * JS "packeado" (eval/p,a,c,k,e,d) + variable jwplayer "sources"/"file".
 * No cubre hosts con protección extra (captcha, DRM, tokens firmados por JS complejo).
 */
async function resolveGenericEmbed(rawUrl, referer) {
  const url = fixHostsLinks(rawUrl);
  const html = await getHtml(url, { headers: { Referer: referer || url } });

  let workingHtml = html;
  if (isPacked(html)) {
    const unpacked = unpack(html);
    if (unpacked) workingHtml = unpacked + '\n' + html;
  }

  const m =
    workingHtml.match(FILE_REGEX) || workingHtml.match(SOURCES_ARRAY_REGEX);
  if (!m) return null;

  const fileUrl = m[1].replace(/\\\//g, '/');
  const isM3u8 = fileUrl.includes('.m3u8');

  return {
    url: fileUrl,
    quality: 'auto',
    type: isM3u8 ? 'hls' : 'mp4',
    referer: url,
  };
}

module.exports = { resolveGenericEmbed, fixHostsLinks };
