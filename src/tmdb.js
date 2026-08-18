const fetch = require('node-fetch');

// Se puede sobreescribir con la variable de entorno TMDB_API_KEY en Railway.
const TMDB_API_KEY = process.env.TMDB_API_KEY || '85f7b7ea4a4cca58b33ba716fc7e537a';
const TMDB_BASE = 'https://api.themoviedb.org/3';

/**
 * Dado un id de IMDb (tt1234567) devuelve { title, originalTitle, year }
 * usando el endpoint /find de TMDB. type: 'movie' | 'series'.
 */
async function findByImdbId(imdbId, type) {
  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB find ${imdbId} -> HTTP ${res.status}`);
  }
  const data = await res.json();

  const result =
    type === 'series'
      ? data.tv_results?.[0]
      : data.movie_results?.[0] || data.tv_results?.[0];

  if (!result) return null;

  return {
    title: result.title || result.name || '',
    originalTitle: result.original_title || result.original_name || '',
    year: (result.release_date || result.first_air_date || '').slice(0, 4) || undefined,
  };
}

module.exports = { findByImdbId, TMDB_API_KEY };
