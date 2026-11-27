// End-to-end tests of the API: the real Worker code, called the way a hostile
// client would call it (directly, not through the page), against a real local
// D1 with the real migrations applied. The database comes from wrangler's
// getPlatformProxy, so there is nothing to mock.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';

const migrations = readdirSync('migrations').sort().map((f) => ({ name: f, sql: readFileSync(`migrations/${f}`, 'utf8') }));
const proxies = [];
after(() => Promise.all(proxies.map((p) => p.dispose())));

/**
 * A fresh instance with its own empty database and the given SETTINGS. `holdFrom` stops before the
 * migration whose file name starts with it, so a test can create data on the older schema and then
 * call `migrate()` to apply the rest, the way a real upgrade happens.
 */
async function boot(settings = {}, bindings = {}, { holdFrom } = {}) {
  const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: false });
  proxies.push(proxy);
  const db = proxy.env.DB;
  const apply = async (list) => {
    for (const { sql } of list) {
      const statements = sql.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
      for (const st of statements) await db.prepare(st).run();
    }
  };
  const held = holdFrom ? migrations.filter((m) => m.name >= holdFrom) : [];
  await apply(migrations.filter((m) => !held.includes(m)));
  const migrate = () => apply(held);
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
  return { db, call, signIn, runCron, migrate };
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

test('a day poll is answered only by people free that day, and answers follow availability', async () => {
  const { db, call, signIn } = await boot({ maxDayPolls: 2 });
  const [ana, ben, cy, dee] = await Promise.all([
    signIn('ana@acme.test', 'Ana'), signIn('ben@acme.test', 'Ben'), signIn('cy@acme.test', 'Cy'), signIn('dee@acme.test', 'Dee'),
  ]);
  const { id } = (await call(ana, 'POST', '/events', newEvent())).body;
  await call(ana, 'PUT', `/events/${id}/response`, { slots: '110' });
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '010' });
  await call(cy, 'PUT', `/events/${id}/response`, { slots: '100' });   // not free on the 2nd

  const ask = { day: DAYS[1], prompt: 'Co-work day?', options: ['Co-work day', 'No co-work day'] };
  assert.equal((await call(ben, 'POST', `/events/${id}/polls`, ask)).status, 403, 'only the organizer creates polls');
  assert.equal((await call(ana, 'POST', `/events/${id}/polls`, { ...ask, day: '2027-04-01' })).status, 400, 'the day must be one of the event’s');
  assert.equal((await call(ana, 'POST', `/events/${id}/polls`, { ...ask, options: ['Only one'] })).status, 400);
  const made = await call(ana, 'POST', `/events/${id}/polls`, ask);
  assert.equal(made.status, 201);
  const pid = made.body.poll.id;
  const vote = (who, choice) => call(who, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice });

  assert.equal((await vote(ben, 0)).status, 200);
  assert.equal((await vote(ana, 1)).status, 200);
  assert.equal((await vote(ana, 7)).status, 400);
  const notFree = await vote(cy, 0);
  assert.equal(notFree.status, 403, 'free on another day is not enough');
  assert.equal(notFree.body.error, 'not_available');
  assert.equal((await vote(dee, 0)).status, 403, 'neither is not having answered at all');
  assert.equal((await vote(null, 0)).status, 401);

  let poll = (await call(ben, 'GET', `/events/${id}`)).body.polls[0];
  assert.deepEqual([poll.prompt, poll.day, poll.myVote, poll.eligible], ['Co-work day?', DAYS[1], 0, 2]);
  assert.deepEqual(poll.voters, [['Ben'], ['Ana']]);
  assert.deepEqual(poll.waiting, []);
  assert.equal((await call(cy, 'GET', `/events/${id}`)).body.polls[0].myVote, null);

  // Cy updates their availability to include the day, and can then answer.
  await call(cy, 'PUT', `/events/${id}/response`, { slots: '110' });
  assert.deepEqual((await call(ana, 'GET', `/events/${id}`)).body.polls[0].waiting, ['Cy']);
  assert.equal((await vote(cy, 0)).status, 200);

  // Ben drops the day: the answer goes with it, in the database and not just in the totals.
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '001' });
  poll = (await call(ana, 'GET', `/events/${id}`)).body.polls[0];
  assert.deepEqual([poll.eligible, poll.voters], [2, [['Cy'], ['Ana']]]);
  const votesOf = async (email) => (await db.prepare('SELECT COUNT(*) AS n FROM day_poll_votes WHERE user_key = ?').bind(`u:dev-${email}`).first()).n;
  assert.equal(await votesOf('ben@acme.test'), 0);
  // Changing something else keeps an answer; removing the whole response removes it.
  await call(cy, 'PUT', `/events/${id}/response`, { slots: '111' });
  assert.equal(await votesOf('cy@acme.test'), 1);
  await call(cy, 'DELETE', `/events/${id}/response`);
  assert.equal(await votesOf('cy@acme.test'), 0);
  assert.equal((await vote(ana, null)).body.myVote, null, 'an answer can be withdrawn');

  // Limit, and deleting.
  assert.equal((await call(ana, 'POST', `/events/${id}/polls`, { ...ask, prompt: 'Drinks + dinner?' })).status, 201);
  assert.equal((await call(ana, 'POST', `/events/${id}/polls`, { ...ask, prompt: 'A third' })).status, 409);
  assert.equal((await call(ben, 'DELETE', `/events/${id}/polls/${pid}`)).status, 403);
  await vote(ana, 0);
  assert.equal((await call(ana, 'DELETE', `/events/${id}/polls/${pid}`)).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM day_poll_votes WHERE poll_id = ?').bind(pid).first()).n, 0);
  assert.equal((await call(ana, 'DELETE', `/events/${id}`)).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM day_polls').first()).n, 0, 'deleting the event takes its polls with it');
});

test('poll answers are hidden from other participants when responses are', async () => {
  const { call, signIn } = await boot();
  const ana = await signIn('ana@acme.test', 'Ana');
  const ben = await signIn('ben@acme.test', 'Ben');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ hideResults: true }))).body;
  await call(ana, 'PUT', `/events/${id}/response`, { slots: '100' });
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '100' });
  const pid = (await call(ana, 'POST', `/events/${id}/polls`, { day: DAYS[0], prompt: 'Dinner?', options: ['Yes', 'No'] })).body.poll.id;
  await call(ana, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 0 });
  await call(ben, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 1 });

  const asBen = (await call(ben, 'GET', `/events/${id}`)).body.polls[0];
  assert.deepEqual(Object.keys(asBen).sort(), ['day', 'id', 'myVote', 'options', 'prompt'], 'a participant gets the question and their own answer only');
  assert.equal(asBen.myVote, 1);
  assert.deepEqual((await call(ana, 'GET', `/events/${id}`)).body.polls[0].voters, [['Ana'], ['Ben']]);
});

test('locking freezes who responded and which days, but not poll or questionnaire answers', async () => {
  const { call, signIn } = await boot();
  const ana = await signIn('ana@acme.test', 'Ana');
  const ben = await signIn('ben@acme.test', 'Ben');
  const cy = await signIn('cy@acme.test', 'Cy');
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: QUESTIONS, anonAnswers: false }))).body;
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '110' });
  const pid = (await call(ana, 'POST', `/events/${id}/polls`, { day: DAYS[0], prompt: 'Dinner?', options: ['Yes', 'No'] })).body.poll.id;

  assert.equal((await call(ben, 'PUT', `/events/${id}/lock`, { locked: true })).status, 403, 'only the organizer locks');
  assert.equal((await call(ana, 'PUT', `/events/${id}/lock`, { locked: true })).body.locked, true);
  assert.equal((await call(cy, 'GET', `/events/${id}`)).body.event.locked, true);

  const late = await call(cy, 'PUT', `/events/${id}/response`, { slots: '100' });
  assert.deepEqual([late.status, late.body.error], [403, 'locked'], 'nobody new joins');
  assert.equal((await call(ana, 'PUT', `/events/${id}/response`, { slots: '100' })).status, 403, 'not even the organizer');
  assert.equal((await call(ben, 'PUT', `/events/${id}/response`, { slots: '111' })).status, 403, 'days cannot change');
  assert.equal((await call(ben, 'DELETE', `/events/${id}/response`)).status, 403);

  // Same days, new questionnaire answers: allowed. So is answering the poll.
  assert.equal((await call(ben, 'PUT', `/events/${id}/response`, { slots: '110', answers: { qone1: 2 } })).status, 200);
  assert.equal((await call(ben, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 0 })).status, 200);
  assert.equal((await call(cy, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 0 })).status, 403);

  assert.equal((await call(ana, 'PUT', `/events/${id}/lock`, { locked: false })).body.locked, false);
  assert.equal((await call(cy, 'PUT', `/events/${id}/response`, { slots: '100' })).status, 200);
});

test('events created before day polls existed gain them with no changes', async () => {
  const { db, call, signIn, migrate } = await boot({}, {}, { holdFrom: '0006' });
  const ana = await signIn('ana@acme.test', 'Ana');
  const { id } = (await call(ana, 'POST', '/events', newEvent())).body;
  await db.prepare(
    `INSERT INTO responses (event_id, user_key, rid, name, email, picture, slots, answers, updated_at)
     VALUES (?, 'u:dev-ana@acme.test', 'oldrid01', 'Ana', 'ana@acme.test', NULL, '011', '{}', 1)`,
  ).bind(id).run();

  await migrate();

  const before = (await call(ana, 'GET', `/events/${id}`)).body;
  assert.equal(before.event.locked, false);
  assert.deepEqual(before.polls, []);
  assert.equal(before.responses[0].slots, '011');
  const pid = (await call(ana, 'POST', `/events/${id}/polls`, { day: DAYS[2], prompt: 'Co-work day?', options: ['Yes', 'No'] })).body.poll.id;
  assert.equal((await call(ana, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 0 })).status, 200);
  assert.equal((await call(ana, 'PUT', `/events/${id}/lock`, { locked: true })).body.locked, true);
});

test('unpickable choices are only for listed organizers, and nobody can pick one', async () => {
  const { call, signIn } = await boot({}, { EXTRAS_FOR: 'Ana@acme.test, someone@else.test' });
  const ana = await signIn('ana@acme.test', 'Ana');
  const ben = await signIn('ben@acme.test', 'Ben');
  assert.equal(ana.body.user.extras, true);
  assert.equal(ben.body.user.extras, undefined);
  assert.equal((await call(ana, 'GET', '/session')).body.user.extras, true);
  assert.equal((await call(ben, 'GET', '/session')).body.user.extras, undefined);
  assert.ok(!JSON.stringify((await call(ben, 'GET', '/session')).body).includes('acme.test, '), 'the list itself is never sent');

  const withOff = [{ id: 'qone1', type: 'single', prompt: 'Dinner?', options: ['Yes', '', 'No', 'Not offered'], off: [3] }];
  const { id } = (await call(ana, 'POST', '/events', newEvent({ questions: withOff, anonAnswers: false }))).body;
  const q = (await call(ben, 'GET', `/events/${id}`)).body.event.questions[0];
  assert.deepEqual([q.options, q.off], [['Yes', 'No', 'Not offered'], [2]], 'marks follow their choice when a blank one is dropped');

  // Not pickable, by anyone, however the request is made.
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '110', answers: { qone1: 2 } });
  assert.deepEqual((await call(ben, 'GET', `/events/${id}`)).body.responses.find((r) => r.mine).answers, {});
  await call(ben, 'PUT', `/events/${id}/response`, { slots: '110', answers: { qone1: 1 } });
  assert.deepEqual((await call(ben, 'GET', `/events/${id}`)).body.responses.find((r) => r.mine).answers, { qone1: 1 });

  const made = await call(ana, 'POST', `/events/${id}/polls`, { day: DAYS[0], prompt: 'Co-work day?', options: ['Yes', 'No', 'Not offered'], off: [2] });
  assert.deepEqual([made.status, made.body.poll.off], [201, [2]]);
  const pid = made.body.poll.id;
  assert.equal((await call(ben, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 2 })).status, 400);
  assert.equal((await call(ben, 'PUT', `/events/${id}/polls/${pid}/vote`, { choice: 1 })).status, 200);
  const poll = (await call(ben, 'GET', `/events/${id}`)).body.polls[0];
  assert.deepEqual([poll.options, poll.off, poll.voters], [['Yes', 'No', 'Not offered'], [2], [[], ['Ben'], []]]);
  // Two real choices are still required.
  assert.equal((await call(ana, 'POST', `/events/${id}/polls`, { day: DAYS[0], prompt: 'x', options: ['Yes', 'Nope'], off: [1] })).status, 400);

  // Someone not on the list sending the same thing gets ordinary choices.
  const { id: bens } = (await call(ben, 'POST', '/events', newEvent({ questions: withOff }))).body;
  assert.equal((await call(ben, 'GET', `/events/${bens}`)).body.event.questions[0].off, undefined);
  const plain = (await call(ben, 'POST', `/events/${bens}/polls`, { day: DAYS[0], prompt: 'Dinner?', options: ['Yes', 'No', 'Maybe'], off: [2] })).body.poll;
  assert.equal(plain.off, undefined);
  await call(ben, 'PUT', `/events/${bens}/response`, { slots: '100' });
  assert.equal((await call(ben, 'PUT', `/events/${bens}/polls/${plain.id}/vote`, { choice: 2 })).status, 200);
});

test('ranked day polls: orders are tallied as points, and a last-only choice stays last', async () => {
  const { call, signIn } = await boot({}, { EXTRAS_FOR: 'ana@acme.test' });
  const ana = await signIn('ana@acme.test', 'Ana');
  const ben = await signIn('ben@acme.test', 'Ben');
  const cy = await signIn('cy@acme.test', 'Cy');
  const { id } = (await call(ana, 'POST', '/events', newEvent())).body;
  for (const who of [ana, ben, cy]) await call(who, 'PUT', `/events/${id}/response`, { slots: '100' });

  const made = (await call(ana, 'POST', `/events/${id}/polls`, {
    day: DAYS[0], kind: 'rank', prompt: 'Where for dinner?', options: ['Thai', 'Pizza', 'Tacos', 'Not offered'], last: 3,
  })).body.poll;
  assert.deepEqual([made.kind, made.last], ['rank', 3]);
  const rank = (who, ranking) => call(who, 'PUT', `/events/${id}/polls/${made.id}/vote`, { ranking });

  // The last-only choice goes to the end wherever it was sent; junk and repeats are dropped.
  assert.deepEqual((await rank(ana, [3, 1, 0, 1, 9])).body.myRanking, [1, 0, 3]);
  assert.deepEqual((await rank(ben, [0, 2, 1])).body.myRanking, [0, 2, 1]);
  assert.deepEqual((await rank(cy, [1])).body.myRanking, [1], 'ranking only some is fine');

  const poll = (await call(ben, 'GET', `/events/${id}`)).body.polls[0];
  assert.deepEqual([poll.kind, poll.last, poll.myRanking], ['rank', 3, [0, 2, 1]]);
  // Three ordinary choices: 3 points for a first place, 2 for second, 1 for third.
  assert.deepEqual(poll.points, [2 + 3, 3 + 1 + 3, 2, 0]);
  assert.deepEqual(poll.voters, [['Ben'], ['Ana', 'Cy'], [], ['Ana']], 'first places, and who picked the last-only choice');
  assert.deepEqual(poll.skipped, [['Cy'], [], ['Ana', 'Cy'], []], 'who answered but left each ordinary choice out');
  assert.deepEqual(poll.waiting, []);

  assert.deepEqual((await rank(cy, [])).body.myRanking, [], 'an empty order withdraws the answer');
  assert.deepEqual((await call(ana, 'GET', `/events/${id}`)).body.polls[0].waiting, ['Cy']);

  // Without extras the mark is ignored and the choice ranks like any other.
  const { id: bens } = (await call(ben, 'POST', '/events', newEvent())).body;
  await call(ben, 'PUT', `/events/${bens}/response`, { slots: '100' });
  const plain = (await call(ben, 'POST', `/events/${bens}/polls`, { day: DAYS[0], kind: 'rank', prompt: 'Dinner?', options: ['A', 'B', 'C'], last: 2 })).body.poll;
  assert.equal(plain.last, undefined);
  assert.deepEqual((await call(ben, 'PUT', `/events/${bens}/polls/${plain.id}/vote`, { ranking: [2, 0] })).body.myRanking, [2, 0]);
});
