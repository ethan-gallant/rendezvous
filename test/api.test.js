// End-to-end tests of the API: the real Worker code, called the way a hostile
// client would call it (directly, not through the page), against a real local
// D1 with the real migrations applied. The database comes from wrangler's
// getPlatformProxy, so there is nothing to mock.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';

const migrations = readdirSync('migrations').sort().map((f) => readFileSync(`migrations/${f}`, 'utf8'));
const proxies = [];
after(() => Promise.all(proxies.map((p) => p.dispose())));

/** A fresh instance with its own empty database and the given SETTINGS. */
async function boot(settings = {}, bindings = {}) {
  const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: false });
  proxies.push(proxy);
  const db = proxy.env.DB;
  for (const sql of migrations) {
    const statements = sql.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
    for (const st of statements) await db.prepare(st).run();
  }
  // No rate-limit or AI bindings unless a test passes stand-ins: those are Cloudflare's to test.
  // Everything else is real.
  const env = {
    DB: db, SETTINGS: settings, DEV_LOGIN: '1', GOOGLE_CLIENT_ID: '',
    SESSION_SECRET: 'session-secret-for-tests-only-0123456789', ANON_SECRET: 'anon-secret-for-tests-only-9876543210',
    ...bindings,
  };

  const call = async (who, method, path, body, headers = {}) => {
    const res = await worker.fetch(new Request(`http://localhost/api${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who?.cookie ? { cookie: who.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const signIn = async (email, name) => {
    const res = await call(null, 'POST', '/auth/dev', { email, name });
    const setCookie = res.headers.get('set-cookie') || '';
    return { ...res, setCookie, cookie: setCookie.split(';')[0], email, name };
  };
  const runCron = async () => {
    const tasks = [];
    await worker.scheduled({ cron: '17 4 * * *' }, env, { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
  };
  return { db, call, signIn, runCron };
}

const DAYS = ['2027-03-01', '2027-03-02', '2027-03-03'];
const QUESTIONS = [
  { id: 'qone1', type: 'single', prompt: 'Family-friendly?', options: ['Yes', 'Maybe', 'No'] },
  { id: 'qtxt2', type: 'text', prompt: 'Anything to improve?' },
];
const newEvent = (extra = {}) => ({ title: 'Party', kind: 'days', tz: 'America/Toronto', dates: DAYS, ...extra });

test('sign-in, session lifetime and response headers', async () => {
  const { call, signIn } = await boot();
  assert.equal((await call(null, 'POST', '/events', newEvent())).status, 401);

  const ana = await signIn('ana@acme.test', 'Ana');
  assert.equal(ana.status, 200);
  assert.match(ana.setCookie, /Max-Age=86400\b/, 'sessions last 24 hours by default');
  assert.match(ana.setCookie, /HttpOnly; SameSite=Lax/);
  assert.equal(ana.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ana.headers.get('cache-control'), 'no-store');
  assert.equal((await call(ana, 'GET', '/session')).body.user.email, 'ana@acme.test');

  // A cookie with a tampered payload or signature is simply not a session.
  const [payload, sig] = ana.cookie.split('=')[1].split('.');
  const forged = { cookie: `rdv_session=${payload.slice(0, -2)}AA.${sig}` };
  assert.equal((await call(forged, 'GET', '/session')).body.user, null);
  assert.equal((await call({ cookie: `rdv_session=${payload}.${sig.slice(0, -2)}AA` }, 'GET', '/session')).body.user, null);

  // Cross-site writes are refused even with a valid cookie.
  assert.equal((await call(ana, 'POST', '/events', newEvent(), { origin: 'https://evil.example' })).status, 403);
});

test('allowedDomains locks the whole instance to those Google domains', async () => {
  const { call, signIn } = await boot({ allowedDomains: ['acme.test'] });
  const outsider = await signIn('mallory@other.test', 'Mallory');
  assert.equal(outsider.status, 403);
  assert.deepEqual(outsider.body, { error: 'domain_not_allowed', domains: ['acme.test'] });

  const ana = await signIn('ana@acme.test', 'Ana');
  const cfg = (await call(null, 'GET', '/session')).body.config;
  assert.deepEqual([cfg.allowedDomains, cfg.allowGuestResponses], [['acme.test'], false]);

  // An event cannot widen the audience, and name-only answers are off by default on a locked instance.
  assert.equal((await call(ana, 'POST', '/events', newEvent({ domains: ['other.test'] }))).status, 400);
  const { id } = (await call(ana, 'POST', '/events', newEvent({ allowGuests: true }))).body;
  const asAna = await call(ana, 'GET', `/events/${id}`);
  assert.equal(asAna.body.event.allowGuests, false);

  // Nobody gets in without signing in, and the refusal says nothing about the event itself.
  const anon = await call(null, 'GET', `/events/${id}`);
  assert.equal(anon.status, 401);
  assert.deepEqual(anon.body, { error: 'domain_required', domains: ['acme.test'], signedInAs: null });
  const guest = await call(null, 'PUT', `/events/${id}/response`, { slots: '111', name: 'Guest' }, { 'x-guest-token': 'g'.repeat(40) });
  assert.equal(guest.status, 401);
});

test('configured limits are enforced', async () => {
  const { call, signIn } = await boot({ maxEventsPerUserPerDay: 2, maxResponsesPerEvent: 2, maxQuestions: 1 });
  const ana = await signIn('ana@acme.test', 'Ana');
  assert.equal((await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS }))).status, 400, 'two questions when one is allowed');
  const { id } = (await call(ana, 'POST', '/events', newEvent())).body;
  assert.equal((await call(ana, 'POST', '/events', newEvent())).status, 201);
  const third = await call(ana, 'POST', '/events', newEvent());
  assert.deepEqual([third.status, third.body.error], [429, 'too_many_events']);

  for (const who of ['ben', 'chloe']) {
    const u = await signIn(`${who}@acme.test`, who);
    assert.equal((await call(u, 'PUT', `/events/${id}/response`, { slots: '110' })).status, 200);
  }
  const dev = await signIn('dev@acme.test', 'Dev');
  const full = await call(dev, 'PUT', `/events/${id}/response`, { slots: '110' });
  assert.deepEqual([full.status, full.body.error], [409, 'event_full']);
});

test('only the organizer can manage an event or see questionnaire results', async () => {
  const { call, signIn } = await boot();
  const ana = await signIn('ana@acme.test', 'Ana');
  const ben = await signIn('ben@acme.test', 'Ben');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS, hideResults: true }))).body;
  await call(ana, 'PUT', `/events/${id}/response`, { slots: '100' });
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '011', answers: { qone1: 0 } });

  assert.equal((await call(ben, 'PUT', `/events/${id}/details`, { note: 'x' })).status, 403);
  assert.equal((await call(ben, 'PUT', `/events/${id}/questions`, { questions: [] })).status, 403);
  assert.equal((await call(ben, 'DELETE', `/events/${id}`)).status, 403);

  const asBen = (await call(ben, 'GET', `/events/${id}`)).body;
  assert.equal(asBen.survey, null);
  assert.deepEqual(asBen.responses.map((r) => r.name), ['Ben'], 'hidden results: a participant sees only their own row');
  assert.deepEqual(asBen.responses[0].answers, { qone1: 0 });
  assert.ok(!('updatedAt' in asBen.responses[0]), 'no timestamps are sent to clients');
  assert.equal(asBen.responses[0].email, 'ben@acme.test');

  const asAna = (await call(ana, 'GET', `/events/${id}`)).body;
  assert.equal(asAna.responses.length, 2);
  assert.equal(asAna.responses.find((r) => r.name === 'Ben').answers, undefined, 'even the organizer never gets a person’s answers');
});

test('anonymous answers are stored unlinked and released only in batches', async () => {
  const { db, call, signIn } = await boot({ anonBatch: 3 });
  const ana = await signIn('ana@acme.test', 'Ana');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS }))).body;
  const people = {};
  for (const name of ['Ben', 'Chloe', 'Dev', 'Eli', 'Fay']) people[name] = await signIn(`${name.toLowerCase()}@acme.test`, name);
  const answer = (name, answers) => call(people[name], 'PUT', `/events/${id}/response`, { slots: '110', answers });
  const survey = async () => (await call(ana, 'GET', `/events/${id}`)).body.survey;

  await answer('Ben', { qone1: 0, qtxt2: 'Start earlier.' });
  await answer('Chloe', { qone1: 1 });
  await call(people.Fay, 'PUT', `/events/${id}/response`, { slots: '001' }); // availability only
  let s = await survey();
  assert.deepEqual([s.hidden, s.answered, s.waiting.answers, s.missing], [true, 0, 2, null], 'two answers in: the organizer sees nothing yet');
  assert.deepEqual(s.questions, {});

  // Saving availability again must not count as a changed answer.
  await answer('Ben', { qone1: 0, qtxt2: 'Start earlier.' });
  assert.equal((await survey()).waiting.answers, 2);

  await answer('Dev', { qone1: 0, qtxt2: 'Near transit.' });
  s = await survey();
  assert.deepEqual([s.hidden, s.answered, s.waiting.answers], [false, 3, 0], 'the third answer completes a batch');
  assert.deepEqual(s.questions.qone1, { n: 3, counts: [2, 1, 0] });
  assert.deepEqual(s.questions.qtxt2.texts, [{ text: 'Near transit.' }, { text: 'Start earlier.' }]);
  assert.deepEqual(s.missing, ['Fay'], 'who has not answered, as of this batch');
  assert.ok(!JSON.stringify(s.questions).match(/Ben|Chloe|Dev/));

  // One more person answers, and one changes their mind: nothing the organizer sees moves.
  await answer('Eli', { qone1: 2, qtxt2: 'Shorter speeches.' });
  await answer('Chloe', { qone1: 2 });
  const frozen = await survey();
  assert.deepEqual(frozen.questions, s.questions);
  assert.deepEqual([frozen.answered, frozen.missing, frozen.waiting.answers], [3, ['Fay'], 2]);

  // A third change (a withdrawal) fills the next batch and everything lands together.
  assert.equal((await call(people.Dev, 'DELETE', `/events/${id}/response`)).status, 200);
  s = await survey();
  assert.deepEqual([s.answered, s.waiting.answers], [3, 0]);
  assert.deepEqual(s.questions.qone1, { n: 3, counts: [1, 0, 2] });
  assert.deepEqual(s.missing, ['Fay']);

  // What the database holds: named rows carry no answers; answer rows carry no identity.
  const named = (await db.prepare('SELECT name, answers FROM responses WHERE event_id = ?').bind(id).all()).results;
  assert.ok(named.length >= 4 && named.every((r) => r.answers === '{}'));
  const cols = (await db.prepare("SELECT name FROM pragma_table_info('anon_answers')").all()).results.map((r) => r.name);
  assert.deepEqual(cols, ['event_id', 'key', 'answers', 'part', 'pending']);
  const rows = (await db.prepare('SELECT key, answers FROM anon_answers WHERE event_id = ?').bind(id).all()).results;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key) && !/acme|Ben|Chloe|Eli/.test(JSON.stringify(r))));

  // The promise can't be withdrawn once people have answered under it.
  const flip = await call(ana, 'PUT', `/events/${id}/questions`, { questions: QUESTIONS, anonAnswers: false });
  assert.deepEqual([flip.status, flip.body.error], [409, 'anon_locked']);

  // Each person still gets their own answers back.
  const asEli = (await call(people.Eli, 'GET', `/events/${id}`)).body;
  assert.deepEqual(asEli.responses.find((r) => r.mine).answers, { qone1: 2, qtxt2: 'Shorter speeches.' });
});

test('events carry a deletion date and are gone after it', async () => {
  const { db, call, signIn, runCron } = await boot({ retentionDays: 10 });
  const ana = await signIn('ana@acme.test', 'Ana');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS }))).body;
  const { id: keep } = (await call(ana, 'POST', '/events', newEvent())).body;
  await call(ana, 'PUT', `/events/${id}/response`, { slots: '111', answers: { qone1: 1 } });

  const { event } = (await call(ana, 'GET', `/events/${id}`)).body;
  assert.equal(new Date(event.expiresAt).toISOString(), '2027-03-14T00:00:00.000Z', 'last day + 1 + 10 days');

  await db.prepare('UPDATE events SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, id).run();
  assert.equal((await call(ana, 'GET', `/events/${id}`)).status, 404, 'expired events are unreachable even before cleanup runs');
  assert.deepEqual((await call(ana, 'GET', '/my/events')).body.created.map((e) => e.id), [keep]);

  await runCron();
  const count = async (table, col) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(id).first()).n;
  assert.deepEqual([await count('events', 'id'), await count('responses', 'event_id'), await count('anon_answers', 'event_id')], [0, 0, 0]);
  assert.equal((await call(ana, 'GET', `/events/${keep}`)).status, 200);
});

test('AI rewording is unavailable without the AI binding', async () => {
  const { call, signIn } = await boot();
  const ana = await signIn('ana@acme.test', 'Ana');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS }))).body;
  assert.equal((await call(null, 'GET', '/session')).body.config.aiReword, false);
  assert.equal((await call(ana, 'POST', `/events/${id}/reword`, { text: 'This is a long enough draft to reword.' })).status, 404);
});

test('the AI reword limit counts name-only guests by address, not by their own token', async () => {
  // Stand-ins for the two platform bindings: a limiter that allows 4 per key, and a model that answers.
  const used = new Map();
  const AI_LIMIT = { limit: async ({ key }) => { used.set(key, (used.get(key) || 0) + 1); return { success: used.get(key) <= 4 }; } };
  const AI = { run: async () => ({ response: 'Start earlier in the evening.' }) };
  const { call, signIn } = await boot({}, { AI, AI_LIMIT });
  const ana = await signIn('ana@acme.test', 'Ana');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ allowGuests: true }))).body;
  const draft = { text: 'ok so honestly start EARLIER, some of us cannot do 9pm' };
  const asGuest = (n, ip) => call(null, 'POST', `/events/${id}/reword`, draft,
    { 'X-Guest-Token': `guest-token-number-${n}-padded-to-length`, 'CF-Connecting-IP': ip });

  // A fresh guest token on every request does not buy a fresh budget.
  for (let n = 0; n < 4; n++) assert.equal((await asGuest(n, '203.0.113.7')).status, 200);
  const fifth = await asGuest(4, '203.0.113.7');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.error, 'slow_down');
  assert.deepEqual([...used.keys()], ['ip:203.0.113.7']);

  // Another address, and a signed-in person, each have their own budget.
  assert.equal((await asGuest(5, '203.0.113.8')).status, 200);
  assert.equal((await call(ana, 'POST', `/events/${id}/reword`, draft, { 'CF-Connecting-IP': '203.0.113.7' })).status, 200);
  assert.ok([...used.keys()].some((k) => k.startsWith('u:')));
});
