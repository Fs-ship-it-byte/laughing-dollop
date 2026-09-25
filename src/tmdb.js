const fetch = require('node-fetch');

// Se puede sobreescribir con la variable de entorno TMDB_API_KEY en Railway.
const TMDB_API_KEY = process.env.TMDB_API_KEY || '85f7b7ea4a4cca58b33ba716fc7e537a';
const TMDB_BASE = 'https://api.themoviedb.org/3';

/**
 * Dado un id de IMDb (tt1234567) devuelve { title, originalTitle, year }
 * usando el endpoint /find de TMDB. type: 'movie' | 'series'.
 */
// /find solo trae el título en el idioma que se le pida (por defecto inglés).
// Estos sitios son en español, así que se pide también en español: eso es lo
// que de verdad hay que buscar ahí, no el título en inglés.
async function findResult(imdbId, type, language) {
  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=${language}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB find ${imdbId} -> HTTP ${res.status}`);
  }
  const data = await res.json();
  return type === 'series'
    ? data.tv_results?.[0]
    : data.movie_results?.[0] || data.tv_results?.[0];
}

async function findByImdbId(imdbId, type) {
  const [enResult, esResult] = await Promise.all([
    findResult(imdbId, type, 'en-US'),
    findResult(imdbId, type, 'es-MX').catch(() => null),
  ]);
  const result = enResult || esResult;
  if (!result) return null;

  const titleEs = esResult ? esResult.title || esResult.name || '' : '';
  const titleEn = result.title || result.name || '';
  return {
    title: titleEn,
    // Si TMDB no tiene traducción al español, esto queda igual al título en
    // inglés: findBestMatch ya evita buscar dos veces lo mismo.
    titleEs: titleEs || titleEn,
    originalTitle: result.original_title || result.original_name || '',
    year: (result.release_date || result.first_air_date || '').slice(0, 4) || undefined,
    // El id numérico de TMDB: Cuevana lo usa como sufijo de slug cuando hay dos
    // fichas con el mismo nombre (remakes, live-action de una animada, etc.),
    // ej. "como-entrenar-a-tu-dragon-1087192". Sirve para encontrar la ficha
    // correcta cuando la búsqueda del sitio no la distingue de la otra.
    tmdbId: result.id,
  };
}

module.exports = { findByImdbId, TMDB_API_KEY };
