const crypto = require('crypto');
const cheerio = require('cheerio');
const { getHtml } = require('../http');
const { fixHostsLinks, resolveGenericEmbed } = require('./generic');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function sha256Bytes(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

// Resuelve el mini proof-of-work que usa embed69 para derivar la key AES.
// OJO: es CPU-bound y bloqueante; con difficulty alta puede tardar. Si un
// video tarda demasiado en resolver, este es el primer sospechoso.
function deriveAesKey(challenge, difficulty, salt) {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  // Límite de seguridad para no colgar el proceso si algo cambió en el sitio.
  const MAX_TRIES = 5_000_000;
  while (nonce < MAX_TRIES) {
    const hashHex = sha256Hex(challenge + nonce);
    if (hashHex.startsWith(prefix)) {
      return sha256Bytes(challenge + nonce + salt);
    }
    nonce++;
  }
  throw new Error('embed69: no se pudo resolver el proof-of-work (MAX_TRIES alcanzado)');
}

function decryptAes(encryptedBase64, aesKey) {
  try {
    const raw = Buffer.from(encryptedBase64, 'base64');
    const iv = raw.subarray(0, 16);
    const ciphertext = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Devuelve una lista de { language, streams: [...] } resolviendo cada link
 * encriptado a un stream reproducible (vía el extractor genérico).
 */
async function loadEmbed69(url, referer) {
  const html = await getHtml(url, { headers: { Referer: referer } });
  const $ = cheerio.load(html);

  let scriptContent = null;
  $('script').each((_, s) => {
    const c = $(s).html() || '';
    if (c.includes('dataLink = [')) scriptContent = c;
  });
  if (!scriptContent) return [];

  const challenge = scriptContent.split("const POW_CHALLENGE = '")[1]?.split("';")[0];
  const difficulty = parseInt(
    scriptContent.split('const POW_DIFFICULTY = ')[1]?.split(';')[0],
    10
  );
  const salt = scriptContent.split("const POW_SALT = '")[1]?.split("';")[0];
  const dataLinkRaw = scriptContent.split('dataLink = ')[1]?.split(';')[0];

  if (!challenge || !difficulty || !salt || !dataLinkRaw) return [];

  const aesKey = deriveAesKey(challenge, difficulty, salt);
  const dataLink = JSON.parse(dataLinkRaw);

  const results = [];
  for (const lang of dataLink) {
    const embeds = lang.sortedEmbeds || [];
    for (const server of embeds) {
      if (!server.link) continue;
      const decrypted = decryptAes(server.link, aesKey);
      if (!decrypted) continue;
      try {
        const resolved = await resolveGenericEmbed(fixHostsLinks(decrypted), referer);
        if (resolved) {
          results.push({
            language: lang.video_language || lang.videoLanguage || '??',
            ...resolved,
          });
        }
      } catch (_) {
        // host individual falló, seguimos con el resto
      }
    }
  }
  return results;
}

module.exports = { loadEmbed69 };
