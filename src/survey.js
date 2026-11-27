// Follow-up questionnaire: validation and summarising. Pure functions, shared
// by the Worker and the tests.

export const MAX_QUESTIONS = 12;
export const MAX_OPTIONS = 10;
export const MAX_TEXT = 1000;
/** Anonymous results stay hidden until this many people have answered. */
export const ANON_MIN = 3;
export const MAX_RADIUS_KM = 300;

export class SurveyError extends Error {}

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const freeText = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT) : '');

export function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Normalises an organizer's question list, or throws SurveyError.
 * `allowOff` lets a choice be marked as shown-but-unpickable (`off`: indexes into `options`),
 * and lets a ranking question mark one choice as last-place-only (`last`: its index). Without
 * it any such marks are dropped and every choice is an ordinary one.
 */
export function validateQuestions(input, { max = MAX_QUESTIONS, allowOff = false } = {}) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > max) throw new SurveyError('too many questions');
  const seen = new Set();
  return input.map((q) => {
    const id = q?.id;
    if (typeof id !== 'string' || !/^[a-z0-9]{4,12}$/.test(id) || seen.has(id)) throw new SurveyError('bad id');
    seen.add(id);
    const prompt = oneLine(q.prompt, 300);
    if (!prompt) throw new SurveyError('empty prompt');
    if (q.type === 'text') return { id, type: 'text', prompt };
    if (q.type === 'area') {
      // A map question. `view` is only where the map opens.
      const lat = Number(q.view?.lat), lng = Number(q.view?.lng), zoom = Math.round(Number(q.view?.zoom));
      if (![lat, lng, zoom].every(Number.isFinite) || Math.abs(lat) > 85 || Math.abs(lng) > 180) throw new SurveyError('bad view');
      return { id, type: 'area', prompt, view: { lat: round(lat, 3), lng: round(lng, 3), zoom: Math.min(16, Math.max(1, zoom)) } };
    }
    if (q.type !== 'single' && q.type !== 'multi' && q.type !== 'rank') throw new SurveyError('bad type');
    const marked = new Set(allowOff && Array.isArray(q.off) ? q.off : []);
    const lastIn = allowOff && q.type === 'rank' && Number.isInteger(q.last) ? q.last : -1;
    const kept = (Array.isArray(q.options) ? q.options : [])
      .map((o, k) => ({ label: oneLine(o, 80), off: marked.has(k), last: k === lastIn && !marked.has(k) }))
      .filter((o) => o.label);
    const options = kept.map((o) => o.label);
    const off = kept.flatMap((o, k) => (o.off ? [k] : []));
    const last = kept.findIndex((o) => o.last);
    // Two ordinary choices at least, whatever else is on the list.
    if (options.length - off.length - (last >= 0 ? 1 : 0) < 2 || options.length > MAX_OPTIONS) throw new SurveyError('bad options');
    const out = { id, type: q.type, prompt, options };
    if (off.length) out.off = off;
    if (last >= 0) out.last = last;
    return out;
  });
}

/**
 * Keeps only answers that fit the current questions: an option index for
 * 'single', a sorted list of indexes for 'multi', trimmed text for 'text',
 * a coarsened point and three radii for 'area'.
 * Also used when reading, so answers to edited or deleted questions drop out.
 */
export function cleanAnswers(questions, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const inRange = (q) => (v) => Number.isInteger(v) && v >= 0 && v < q.options.length && !q.off?.includes(v);
  for (const q of questions) {
    const v = input[q.id];
    if (q.type === 'text') {
      const text = freeText(v);
      if (text) out[q.id] = text;
    } else if (q.type === 'area') {
      const area = cleanArea(v);
      if (area) out[q.id] = area;
    } else if (q.type === 'rank') {
      const ranking = cleanRanking(q.options.length, q.off, q.last, v);
      if (ranking.length) out[q.id] = ranking;
    } else if (q.type === 'single') {
      if (inRange(q)(v)) out[q.id] = v;
    } else if (Array.isArray(v)) {
      const picked = [...new Set(v.filter(inRange(q)))].sort((a, b) => a - b);
      if (picked.length) out[q.id] = picked;
    }
  }
  return out;
}

/**
 * A ranking: choice indexes, favourite first. Ranking only some of the choices is fine.
 * Unpickable choices are dropped, and a last-place-only choice, if picked at all, always
 * ends up at the end, wherever the client put it. That choice is an extra, not an answer in
 * itself: it only counts alongside at least one ordinary choice, so on its own the ranking
 * is empty.
 */
export function cleanRanking(count, off, last, input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const v of input) {
    if (!Number.isInteger(v) || v < 0 || v >= count || seen.has(v) || off?.includes(v)) continue;
    seen.add(v);
    if (v !== last) out.push(v);
  }
  if (Number.isInteger(last) && seen.has(last) && out.length) out.push(last);
  return out;
}

/**
 * Adds rankings up. With n ordinary choices, a first place is worth n points, second n-1, and so
 * on; a choice someone left out gets nothing from them. `firsts` and `who` count first places,
 * except for a last-place-only choice, where they count the people who picked it.
 *
 * People are told to leave out anything they would skip, so `skips` and `skipWho` record, for each
 * ordinary choice, the people who answered but left it out. Someone who hasn't answered at all is
 * not counted as skipping anything.
 */
export function tallyRankings(count, off, last, rankings) {
  const ordinary = count - (off?.length ?? 0) - (Number.isInteger(last) ? 1 : 0);
  const points = Array(count).fill(0);
  const firsts = Array(count).fill(0);
  const who = Array.from({ length: count }, () => []);
  const skips = Array(count).fill(0);
  const skipWho = Array.from({ length: count }, () => []);
  let n = 0;
  for (const { name, ranking } of rankings) {
    if (!ranking.length) continue;
    n++;
    for (let k = 0; k < count; k++) {
      if (k === last || off?.includes(k) || ranking.includes(k)) continue;
      skips[k]++;
      skipWho[k].push(name);
    }
    ranking.forEach((k, place) => {
      if (k !== last) points[k] += ordinary - place;
      if (k === last || place === 0) {
        firsts[k]++;
        who[k].push(name);
      }
    });
  }
  return { n, points, firsts, who, skips, skipWho };
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * A map answer: roughly where someone will be, and how far they'd travel at
 * three levels of enthusiasm (ideal ≤ fine ≤ a stretch), in km.
 *
 * The point is rounded to 0.01° (about a kilometre) here, on the server, so a
 * precise location is never stored no matter what a client sends.
 */
export function cleanArea(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.r) || v.r.length !== 3) return null;
  const lat = Number(v.lat), lng = Number(v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  const r = v.r.map((x) => Math.round(Number(x) * 2) / 2);
  if (!r.every((x) => Number.isFinite(x) && x >= 0.5 && x <= MAX_RADIUS_KM)) return null;
  return { lat: round(lat, 2), lng: round(lng, 2), r: r.sort((a, b) => a - b) };
}

const KM_PER_DEG = 111.32;
function distKm(lat1, lng1, lat2, lng2) {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * KM_PER_DEG;
  const y = (lat2 - lat1) * KM_PER_DEG;
  return Math.hypot(x, y);
}

/**
 * Lays a grid over everyone's rings and counts, per cell, how many people find
 * it ideal / fine / a stretch. `minReach` drops cells that fewer people can
 * reach, so a lone person's rings don't draw a circle around where they live.
 * `best` is the middle of the area the most people can get to.
 */
export function coverage(points, { size = 32, minReach = 1 } = {}) {
  if (!points.length) return { grid: null, best: null };
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of points) {
    const dLat = p.r[2] / KM_PER_DEG;
    const dLng = p.r[2] / (KM_PER_DEG * Math.cos(p.lat * (Math.PI / 180)));
    s = Math.min(s, p.lat - dLat); n = Math.max(n, p.lat + dLat);
    w = Math.min(w, p.lng - dLng); e = Math.max(e, p.lng + dLng);
  }
  const dLat = (n - s) / size, dLng = (e - w) / size;
  const cells = [];
  let top = null;
  let topCells = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const lat = s + (row + 0.5) * dLat, lng = w + (col + 0.5) * dLng;
      const c = [0, 0, 0];
      for (const p of points) {
        const d = distKm(lat, lng, p.lat, p.lng);
        if (d <= p.r[0]) c[0]++;
        else if (d <= p.r[1]) c[1]++;
        else if (d <= p.r[2]) c[2]++;
      }
      const reach = c[0] + c[1] + c[2];
      if (reach === 0) continue;
      if (reach >= minReach) cells.push([row, col, ...c]);
      const score = [reach, c[0], c[1]];
      const cmp = top ? score[0] - top[0] || score[1] - top[1] || score[2] - top[2] : 1;
      if (cmp > 0) { top = score; topCells = []; }
      if (cmp >= 0) topCells.push({ lat, lng });
    }
  }
  let best = null;
  if (top && top[0] >= minReach) {
    // Centre of the best-scoring area, snapped to a cell that is actually in it.
    const cLat = topCells.reduce((a, c) => a + c.lat, 0) / topCells.length;
    const cLng = topCells.reduce((a, c) => a + c.lng, 0) / topCells.length;
    const near = topCells.reduce((a, c) => (distKm(c.lat, c.lng, cLat, cLng) < distKm(a.lat, a.lng, cLat, cLng) ? c : a));
    best = { lat: round(near.lat, 3), lng: round(near.lng, 3), reach: top[0], ideal: top[1], fine: top[2] };
  }
  return {
    grid: { s: round(s, 4), w: round(w, 4), dLat: round(dLat, 5), dLng: round(dLng, 5), size, cells },
    best,
  };
}

/**
 * What the organizer sees. `rows` are { name, answers } with answers as stored
 * JSON text. When `anon` is set no names are attached, written answers are
 * sorted so their order says nothing about who wrote them, and nothing at all
 * is returned until `min` people have answered.
 */
export function summarize(questions, rows, anon, min = ANON_MIN) {
  const people = rows.map((r) => ({ name: r.name, a: cleanAnswers(questions, parseJson(r.answers, {})) }));
  // Anonymous map pins are stored apart from other answers, so these are two separate pools of
  // people and each has to reach the threshold on its own.
  const isArea = new Set(questions.filter((q) => q.type === 'area').map((q) => q.id));
  const answered = people.filter((p) => Object.keys(p.a).some((id) => !isArea.has(id))).length;
  const pinned = people.filter((p) => Object.keys(p.a).some((id) => isArea.has(id))).length;
  if (anon && answered < min && pinned < min) return { hidden: true, answered, min: min, questions: {} };

  const out = {};
  for (const q of questions) {
    if (anon && q.type !== 'area' && answered < min) {
      out[q.id] = { n: people.filter((p) => p.a[q.id] !== undefined).length, hidden: true };
      continue;
    }
    if (q.type === 'area') {
      const points = people.filter((p) => p.a[q.id]).map((p) => ({ ...p.a[q.id], name: p.name }));
      if (anon && points.length < min) {
        out[q.id] = { n: points.length, hidden: true };
      } else if (anon) {
        // Anonymous: only the combined picture, and only where at least two people overlap.
        out[q.id] = { n: points.length, ...coverage(points, { minReach: 2 }) };
      } else {
        out[q.id] = { n: points.length, ...coverage(points), people: points };
      }
      continue;
    }
    if (q.type === 'text') {
      const texts = people.filter((p) => p.a[q.id]).map((p) => (anon ? { text: p.a[q.id] } : { text: p.a[q.id], name: p.name }));
      if (anon) texts.sort((x, y) => x.text.localeCompare(y.text));
      out[q.id] = { n: texts.length, texts };
      continue;
    }
    if (q.type === 'rank') {
      const t = tallyRankings(q.options.length, q.off, q.last, people.filter((p) => p.a[q.id]).map((p) => ({ name: p.name, ranking: p.a[q.id] })));
      out[q.id] = anon ? { n: t.n, points: t.points, firsts: t.firsts, skips: t.skips } : t;
      continue;
    }
    const counts = q.options.map(() => 0);
    const who = q.options.map(() => []);
    let n = 0;
    for (const p of people) {
      const v = p.a[q.id];
      if (v === undefined) continue;
      n++;
      for (const k of [].concat(v)) {
        counts[k]++;
        who[k].push(p.name);
      }
    }
    out[q.id] = anon ? { n, counts } : { n, counts, who };
  }
  return { hidden: false, answered, min: min, questions: out };
}
