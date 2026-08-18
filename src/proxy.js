const fetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('./http');

function publicUrl() {
  return (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 7000}`).replace(
    /\/$/,
    ''
  );
}

/**
 * Construye la URL pública que Nuvio/Stremio va a pedir en vez del link
 * directo del host. Ese link directo casi nunca funciona pegado tal cual
 * porque el host revisa el header Referer (y a veces el User-Agent) y
 * devuelve 403 si no viene del sitio "correcto". El proxy hace ese request
 * con los headers correctos y reenvía la respuesta byte a byte.
 */
function buildProxyUrl(targetUrl, referer) {
  const params = new URLSearchParams({
    url: targetUrl,
    ref: referer || '',
  });
  return `${publicUrl()}/proxy?${params.toString()}`;
}

async function proxyHandler(req, res) {
  const { url: targetUrl, ref } = req.query;
  if (!targetUrl) {
    res.status(400).send('falta el parámetro url');
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        Referer: ref || targetUrl,
        // Reenvía el Range para que funcione el seek del reproductor.
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      redirect: 'follow',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        return;
      }
      res.setHeader(key, value);
    });
    // CORS abierto: Nuvio/Stremio corren en distintos orígenes según plataforma.
    res.setHeader('Access-Control-Allow-Origin', '*');

    upstream.body.pipe(res);
  } catch (err) {
    console.error('proxy error', targetUrl, err.message);
    res.status(502).send(`proxy error: ${err.message}`);
  }
}

module.exports = { buildProxyUrl, proxyHandler };
