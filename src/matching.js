// Compartido entre providers: normalización de texto y puntaje de coincidencia
// de títulos por solapamiento de palabras (no por substring). Ver el
// comentario histórico en cuevana.js: comparar por substring hacía que
// "How to Train Your Dragon" pudiera terminar emparejado con "Cazadores de
// Dragones" solo por ser el primer resultado de la búsqueda.

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

// results: [{name, year?, type?, ...}]. titles: variantes a probar (es/en/original).
// wantType/year: preferencias, no filtros obligatorios (suman puntos, no descartan).
function pickBestMatch(results, titles, wantType, year) {
  const targets = titles.filter(Boolean).map(normalize);
  if (!targets.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    const n = normalize(r.name);
    let score = Math.max(...targets.map((t) => wordOverlapScore(t, n)));
    if (wantType && r.type === wantType) score += 0.2;
    if (year && r.year && Math.abs(r.year - year) <= 1) score += 0.3;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= MIN_MATCH_SCORE ? best : null;
}

module.exports = { normalize, wordOverlapScore, MIN_MATCH_SCORE, pickBestMatch };
