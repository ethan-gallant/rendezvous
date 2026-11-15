import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestions, cleanAnswers, cleanArea, coverage, summarize, SurveyError, ANON_MIN } from '../src/survey.js';

const qs = validateQuestions([
  { id: 'qfam1', type: 'single', prompt: '  Family-friendly party?  ', options: ['Very likely', 'Not sure', '', 'Unlikely'] },
  { id: 'qwhy2', type: 'multi', prompt: 'What got in the way?', options: ['Timing', 'Travel', 'Childcare'] },
  { id: 'qtxt3', type: 'text', prompt: 'Anything to improve?', options: ['ignored'] },
]);

test('validateQuestions normalises and rejects bad input', () => {
  assert.deepEqual(qs[0], { id: 'qfam1', type: 'single', prompt: 'Family-friendly party?', options: ['Very likely', 'Not sure', 'Unlikely'] });
  assert.deepEqual(qs[2], { id: 'qtxt3', type: 'text', prompt: 'Anything to improve?' });
  assert.deepEqual(validateQuestions(undefined), []);
  const bad = (q) => assert.throws(() => validateQuestions([q]), SurveyError);
  bad({ id: 'qa11', type: 'single', prompt: 'One option', options: ['only'] });
  bad({ id: 'qa11', type: 'rating', prompt: 'Unknown type' });
  bad({ id: 'qa11', type: 'text', prompt: '   ' });
  bad({ id: 'NOPE!', type: 'text', prompt: 'Bad id' });
  assert.throws(() => validateQuestions([{ id: 'qdup1', type: 'text', prompt: 'a' }, { id: 'qdup1', type: 'text', prompt: 'b' }]), SurveyError);
  assert.throws(() => validateQuestions(Array.from({ length: 13 }, (_, i) => ({ id: `qq${i}aa`, type: 'text', prompt: 'x' }))), SurveyError);
});

test('cleanAnswers keeps only answers that fit the current questions', () => {
  assert.deepEqual(
    cleanAnswers(qs, { qfam1: 2, qwhy2: [2, 0, 2, 9, 'x'], qtxt3: '  More notice\nplease  ', gone: 1 }),
    { qfam1: 2, qwhy2: [0, 2], qtxt3: 'More notice\nplease' },
  );
  assert.deepEqual(cleanAnswers(qs, { qfam1: 3, qwhy2: [], qtxt3: '   ' }), {}); // out of range, empty, blank
  assert.deepEqual(cleanAnswers(qs, { qfam1: '1', qwhy2: 1, qtxt3: 5 }), {}); // wrong types
  assert.deepEqual(cleanAnswers(qs, null), {});
  assert.equal(cleanAnswers(qs, { qtxt3: 'x'.repeat(5000) }).qtxt3.length, 1000);
});

const row = (name, answers) => ({ name, answers: JSON.stringify(answers) });

test('anonymous summary hides everything until enough people answer, then drops names', () => {
  const two = [row('Ana', { qfam1: 0 }), row('Ben', { qtxt3: 'Zebra' }), row('Cy', {})];
  const hidden = summarize(qs, two, true);
  assert.deepEqual(hidden, { hidden: true, answered: 2, min: ANON_MIN, questions: {} });

  const three = [...two, row('Dee', { qfam1: 0, qwhy2: [0, 2], qtxt3: 'Apple' })];
  const s = summarize(qs, three, true);
  assert.equal(s.hidden, false);
  assert.equal(s.answered, 3);
  assert.deepEqual(s.questions.qfam1, { n: 2, counts: [2, 0, 0] });
  assert.deepEqual(s.questions.qwhy2, { n: 1, counts: [1, 0, 1] });
  assert.deepEqual(s.questions.qtxt3, { n: 2, texts: [{ text: 'Apple' }, { text: 'Zebra' }] }); // sorted, no names
  assert.ok(!JSON.stringify(s).match(/Ana|Ben|Dee/));
});

test('named summary attaches names and has no threshold', () => {
  const s = summarize(qs, [row('Ana', { qfam1: 1, qtxt3: 'Earlier in December' })], false);
  assert.equal(s.hidden, false);
  assert.deepEqual(s.questions.qfam1, { n: 1, counts: [0, 1, 0], who: [[], ['Ana'], []] });
  assert.deepEqual(s.questions.qtxt3.texts, [{ text: 'Earlier in December', name: 'Ana' }]);
});

test('summary ignores corrupt stored answers', () => {
  const s = summarize(qs, [{ name: 'X', answers: 'not json' }, { name: 'Y', answers: 'null' }], false);
  assert.equal(s.answered, 0);
});

const areaQ = validateQuestions([{ id: 'qmap1', type: 'area', prompt: 'Where can you get to?', view: { lat: 43.65321, lng: -79.38321, zoom: 10.4 } }]);

test('area questions and answers are validated and coarsened on the server', () => {
  assert.deepEqual(areaQ[0], { id: 'qmap1', type: 'area', prompt: 'Where can you get to?', view: { lat: 43.653, lng: -79.383, zoom: 10 } });
  assert.throws(() => validateQuestions([{ id: 'qmap1', type: 'area', prompt: 'x', view: { lat: 'north' } }]), SurveyError);

  // A precise point never survives: ~1 km rounding, radii sorted and snapped to 0.5 km.
  assert.deepEqual(cleanArea({ lat: 43.6532146, lng: -79.3831843, r: [40, 5.2, 15] }), { lat: 43.65, lng: -79.38, r: [5, 15, 40] });
  assert.equal(cleanArea({ lat: 43.65, lng: -79.38, r: [5, 15] }), null);
  assert.equal(cleanArea({ lat: 43.65, lng: -79.38, r: [5, 15, 9000] }), null);
  assert.equal(cleanArea({ lat: 91, lng: 0, r: [1, 2, 3] }), null);
  assert.deepEqual(cleanAnswers(areaQ, { qmap1: { lat: 43.6599, lng: -79.3811, r: [1, 2, 3], extra: 'x' } }), { qmap1: { lat: 43.66, lng: -79.38, r: [1, 2, 3] } });
});

test('coverage finds the area the most people can reach', () => {
  const a = { lat: 43.65, lng: -79.40, r: [3, 8, 20] };
  const b = { lat: 43.65, lng: -79.30, r: [3, 8, 20] }; // ~8 km east of a
  const c = { lat: 43.90, lng: -79.35, r: [2, 4, 6] }; // well north, reaches neither
  const all = coverage([a, b, c]);
  assert.equal(all.best.reach, 2);
  assert.ok(all.best.lng > -79.40 && all.best.lng < -79.30, 'best spot sits between the two who overlap');
  assert.ok(Math.abs(all.best.lat - 43.65) < 0.05);
  assert.ok(all.grid.cells.some(([, , i, f, st]) => i + f + st === 1));

  // With minReach 2, cells only one person can reach are withheld entirely.
  const shared = coverage([a, b, c], { minReach: 2 });
  assert.ok(shared.grid.cells.length > 0);
  assert.ok(shared.grid.cells.every(([, , i, f, st]) => i + f + st >= 2));
  assert.equal(coverage([c], { minReach: 2 }).best, null);
  assert.deepEqual(coverage([]), { grid: null, best: null });
});

test('anonymous map summary never includes individual points', () => {
  const pt = (lat, lng) => JSON.stringify({ qmap1: { lat, lng, r: [5, 10, 20] } });
  const rows = [{ name: 'Ana', answers: pt(43.65, -79.4) }, { name: 'Ben', answers: pt(43.66, -79.38) }];
  // The whole anonymous summary stays hidden below the threshold.
  assert.equal(summarize(areaQ, rows, true).hidden, true);

  rows.push({ name: 'Cy', answers: pt(43.7, -79.35) });
  const anon = summarize(areaQ, rows, true).questions.qmap1;
  assert.equal(anon.n, 3);
  assert.equal(anon.people, undefined);
  assert.ok(anon.best.reach >= 2);
  assert.ok(!JSON.stringify(anon).includes('Ana'));

  const named = summarize(areaQ, rows, false).questions.qmap1;
  assert.deepEqual(named.people.map((p) => p.name), ['Ana', 'Ben', 'Cy']);
});

test('pins and other answers reach the anonymity threshold separately', () => {
  const both = validateQuestions([areaQ[0], { id: 'qtxt9', type: 'text', prompt: 'Anything else?' }]);
  const pin = (lat) => ({ name: null, answers: JSON.stringify({ qmap1: { lat, lng: -79.4, r: [5, 10, 20] } }) });
  const rows = [pin(43.65), pin(43.66), pin(43.67), { name: null, answers: JSON.stringify({ qtxt9: 'Only one person wrote something' }) }];
  const s = summarize(both, rows, true);
  assert.equal(s.hidden, false);
  assert.equal(s.answered, 1);
  assert.equal(s.questions.qmap1.n, 3);
  assert.ok(s.questions.qmap1.grid);
  assert.deepEqual(s.questions.qtxt9, { n: 1, hidden: true }); // one comment is not shown on its own
});
