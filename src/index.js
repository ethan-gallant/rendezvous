// Rendezvous API. Static files in ./public are served by the assets binding;
// only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
//
// Calendar data never passes through here: the browser talks to Google
// Calendar directly and only the painted availability is saved.
//
// Identity comes from Google. This file checks Google's signed token, keeps a
// short signed session, and otherwise leans on the platform: rate limiting,
// TLS, HSTS and DDoS handling are Cloudflare's job, not reimplemented here.

import { settings, signInAllowed, domainAllowed } from './config.js';
import { validateQuestions, cleanAnswers, summarize, parseJson, SurveyError } from './survey.js';
import { reword, REWORD_MIN_CHARS, REWORD_MAX_CHARS } from './reword.js';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, no look-alikes
const MAX_DATES = 62;
const DAY_MS = 86_400_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, ...err.extra }, err.status);
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },

  // Daily cron (see triggers in wrangler.jsonc): delete everything past its retention date.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(purgeExpired(env));
  },
};

async function handleApi(request, env, url) {
  const s = settings(env);
  const method = request.method;
  if (method !== 'GET') {
    // Session cookie is SameSite=Lax; this closes the remaining cross-site POST paths.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'bad_origin');
  }

  const seg = url.pathname.slice(5).split('/').filter(Boolean);
  const route = `${method} /${seg.join('/')}`;
  const session = await readSession(request, env, url, s);
  const devLogin = devLoginEnabled(env, url);

  // One per-minute budget for anything that writes, per person (or per address before sign-in).
  if (method !== 'GET') {
    await rateLimit(env.WRITE_LIMIT, session ? `u:${session.sub}` : addressKey(request));
  }

  if (route === 'GET /session') {
    return json({
      config: {
        googleClientId: env.GOOGLE_CLIENT_ID || '',
        devLogin,
        allowedDomains: s.allowedDomains,
        allowGuestResponses: s.allowGuestResponses,
        retentionDays: s.retentionDays,
        sessionHours: s.sessionHours,
        maxQuestions: s.maxQuestions,
        maxDayPolls: s.maxDayPolls,
        anonBatch: s.anonBatch,
        aiReword: s.aiReword && !!env.AI,
        map: {
          tiles: env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution: env.MAP_ATTRIBUTION || '© OpenStreetMap contributors',
        },
        // City-level guess from the connection, used only to open maps somewhere sensible. Not stored.
        geo: roughGeo(request),
      },
      user: session && publicUser(session),
    });
  }

  if (route === 'POST /auth/google') {
    if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'google_not_configured');
    const { credential } = await readJson(request);
    if (typeof credential !== 'string') throw new HttpError(400, 'bad_request');
    const claims = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
    const user = {
      sub: claims.sub,
      email: String(claims.email).toLowerCase(),
      name: claims.name || claims.email,
      picture: claims.picture || null,
      hd: claims.hd ? String(claims.hd).toLowerCase() : null,
    };
    if (!signInAllowed(user, s)) throw new HttpError(403, 'domain_not_allowed', { domains: s.allowedDomains });
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await sessionCookie(user, env, url, s) });
  }

  if (route === 'POST /auth/dev') {
    if (!devLogin) throw new HttpError(404, 'not_found');
    const body = await readJson(request);
    const email = cleanText(body.email, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_email');
    const domain = email.split('@')[1];
    const user = {
      sub: `dev-${email}`,
      email,
      name: cleanText(body.name, 60) || email.split('@')[0],
      picture: null,
      hd: domain === 'gmail.com' ? null : domain,
    };
    if (!signInAllowed(user, s)) throw new HttpError(403, 'domain_not_allowed', { domains: s.allowedDomains });
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await sessionCookie(user, env, url, s) });
  }

  if (route === 'POST /auth/logout') {
    return json({ ok: true }, 200, { 'set-cookie': `${cookieName(url)}=; ${cookieFlags(url)}; Max-Age=0` });
  }

  if (route === 'GET /my/events') {
    if (!session) throw new HttpError(401, 'sign_in_required');
    const now = Date.now();
    const [mine, answered] = await env.DB.batch([
      env.DB.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM responses r WHERE r.event_id = e.id) AS n
           FROM events e WHERE e.owner_sub = ? AND (e.expires_at IS NULL OR e.expires_at > ?)
          ORDER BY e.created_at DESC LIMIT 50`,
      ).bind(session.sub, now),
      env.DB.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM responses r2 WHERE r2.event_id = e.id) AS n
           FROM responses r JOIN events e ON e.id = r.event_id
          WHERE r.user_key = ? AND e.owner_sub != ? AND (e.expires_at IS NULL OR e.expires_at > ?)
          ORDER BY r.updated_at DESC LIMIT 50`,
      ).bind(`u:${session.sub}`, session.sub, now),
    ]);
    const brief = (row) => ({ ...publicEvent(row), responseCount: row.n });
    return json({ created: mine.results.map(brief), answered: answered.results.map(brief) });
  }

  if (route === 'POST /events') {
    if (!session) throw new HttpError(401, 'sign_in_required');
    const input = validateEvent(await readJson(request), s);
    const now = Date.now();
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE owner_sub = ? AND created_at > ?')
      .bind(session.sub, now - DAY_MS).first();
    if (n >= s.maxEventsPerUserPerDay) throw new HttpError(429, 'too_many_events', { limit: s.maxEventsPerUserPerDay });

    const id = randomId(10);
    // Fixed at creation and shown to everyone, so a later config change never shortens a promise already made.
    const lastDay = Date.parse(`${input.dates[input.dates.length - 1]}T00:00:00Z`);
    const expiresAt = lastDay + DAY_MS + s.retentionDays * DAY_MS;
    await env.DB.prepare(
      `INSERT INTO events (id, title, note, kind, tz, dates, start_min, end_min, slot_min, domains,
                           allow_guests, hide_results, questions, anon_answers, preferred,
                           owner_sub, owner_name, owner_email, owner_picture, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, input.title, input.note, input.kind, input.tz, JSON.stringify(input.dates),
        input.startMin, input.endMin, input.slotMin, JSON.stringify(input.domains),
        input.allowGuests ? 1 : 0, input.hideResults ? 1 : 0,
        JSON.stringify(input.questions), input.anonAnswers ? 1 : 0, JSON.stringify(input.preferred),
        session.sub, session.name, session.email, session.picture, now, expiresAt,
      )
      .run();
    return json({ id }, 201);
  }

  if (seg[0] === 'events' && seg[1]) {
    const id = seg[1];
    if (!/^[a-z0-9]{6,20}$/.test(id)) throw new HttpError(404, 'not_found');
    const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
    // Past its retention date an event is gone, even if the nightly cleanup hasn't reached it yet.
    if (!row || (row.expires_at && row.expires_at < Date.now())) throw new HttpError(404, 'not_found');

    const event = publicEvent(row);
    const isOwner = !!session && session.sub === row.owner_sub;
    const guestsOk = event.allowGuests && s.allowGuestResponses;
    // An event's own domain limit wins. Otherwise a domain-locked instance requires sign-in for
    // everything except events whose organizer chose to accept name-only answers.
    const gate = event.domains.length ? event.domains : (s.allowedDomains.length && !guestsOk ? s.allowedDomains : []);
    if (gate.length && !isOwner && !domainAllowed(session, gate)) {
      // Deliberately reveals nothing about the event beyond which domain it wants.
      throw new HttpError(session ? 403 : 401, 'domain_required', { domains: gate, signedInAs: session?.email ?? null });
    }
    const guestKey = guestsOk ? await guestKeyFrom(request) : null;
    const myKey = session ? `u:${session.sub}` : guestKey;

    if (seg.length === 2 && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT rid, user_key, name, email, picture, slots, answers FROM responses WHERE event_id = ? ORDER BY rowid',
      ).bind(id).all();
      const visible = event.hideResults && !isOwner ? results.filter((r) => r.user_key === myKey) : results;

      // Questionnaire answers: a person gets their own back; the organizer gets a summary; nobody else gets anything.
      let myAnswers = {};
      let survey = null;
      if (event.questions.length && event.anonAnswers) {
        if (myKey) myAnswers = cleanAnswers(event.questions, await readAnon(env, id, myKey));
        if (isOwner) survey = await anonSurvey(env, row, s);
      } else if (event.questions.length) {
        const own = results.find((r) => r.user_key === myKey);
        myAnswers = cleanAnswers(event.questions, parseJson(own?.answers ?? '{}', {}));
        if (isOwner) {
          const named = summarize(event.questions, results, false);
          const blank = (r) => Object.keys(cleanAnswers(event.questions, parseJson(r.answers ?? '{}', {}))).length === 0;
          survey = { ...named, anon: false, missing: results.filter(blank).map((r) => r.name) };
        }
      }

      const canSee = !event.hideResults || isOwner;
      return json({
        event,
        responses: visible.map((r) => publicResponse(r, myKey, isOwner, myAnswers)),
        respondentCount: results.length,
        survey,
        polls: await readPolls(env, event, results, myKey, canSee),
        me: { isOwner, canSeeResults: canSee },
      });
    }

    if (seg.length === 2 && method === 'DELETE') {
      if (!isOwner) throw new HttpError(403, 'forbidden');
      await env.DB.batch(deleteEventStatements(env, 'id = ?', id));
      return json({ ok: true });
    }

    if (seg.length === 3 && seg[2] === 'response' && method === 'PUT') {
      if (!myKey) throw new HttpError(401, 'sign_in_required');
      const body = await readJson(request);
      const slots = body.slots;
      if (typeof slots !== 'string' || slots.length !== slotCount(event) || !/^[01]+$/.test(slots)) {
        throw new HttpError(400, 'bad_slots');
      }
      const name = session ? session.name : cleanText(body.name, 60);
      if (!name) throw new HttpError(400, 'name_required');

      const existing = await env.DB.prepare('SELECT rid, slots, answers FROM responses WHERE event_id = ? AND user_key = ?')
        .bind(id, myKey).first();
      // Locked: nobody joins and nobody's days change. Questionnaire answers can still be saved.
      if (event.locked && existing?.slots !== slots) throw new HttpError(403, 'locked');
      // Anonymous events keep answers in a separate table that holds no identity (see migration 0004).
      const anon = event.anonAnswers;
      const stored = anon ? await readAnon(env, id, myKey) : parseJson(existing?.answers ?? '{}', {});
      // Answers are optional in the request; leaving them out keeps what was saved before.
      const cleaned = cleanAnswers(event.questions, body.answers === undefined ? stored : body.answers);
      const answers = JSON.stringify(cleaned);
      if (!existing) {
        const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM responses WHERE event_id = ?').bind(id).first();
        if (n >= s.maxResponsesPerEvent) throw new HttpError(409, 'event_full');
      }
      const now = Date.now();
      const rid = existing?.rid ?? randomId(8);
      const anonChanges = await anonWrites(env, id, myKey, anon ? cleaned : {}, event.questions);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO responses (event_id, user_key, rid, name, email, picture, slots, answers, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id, user_key) DO UPDATE SET
             name = excluded.name, email = excluded.email, picture = excluded.picture,
             slots = excluded.slots, answers = excluded.answers, updated_at = excluded.updated_at`,
        ).bind(id, myKey, rid, name, session?.email ?? null, session?.picture ?? null, slots, anon ? '{}' : answers, now),
        // A day-poll answer only stands while the person is free that day.
        env.DB.prepare(
          `DELETE FROM day_poll_votes WHERE event_id = ? AND user_key = ? AND poll_id IN
             (SELECT id FROM day_polls WHERE event_id = ? AND day IN (SELECT value FROM json_each(?)))`,
        ).bind(id, myKey, id, JSON.stringify(event.dates.filter((_, d) => !freeOnDay(event, slots, d)))),
        ...anonChanges,
      ]);
      if (anonChanges.length) await maybeRelease(env, event, s);
      return json({
        response: publicResponse(
          { rid, user_key: myKey, name, email: session?.email ?? null, picture: session?.picture ?? null, slots },
          myKey, isOwner, cleaned,
        ),
      });
    }

    if (seg.length === 3 && seg[2] === 'response' && method === 'DELETE') {
      if (!myKey) throw new HttpError(401, 'sign_in_required');
      if (event.locked) throw new HttpError(403, 'locked');
      const anonChanges = await anonWrites(env, id, myKey, {}, event.questions);
      await env.DB.batch([
        ...anonChanges,
        env.DB.prepare('DELETE FROM day_poll_votes WHERE event_id = ? AND user_key = ?').bind(id, myKey),
        env.DB.prepare('DELETE FROM responses WHERE event_id = ? AND user_key = ?').bind(id, myKey),
      ]);
      if (anonChanges.length) await maybeRelease(env, event, s);
      return json({ ok: true });
    }

    if (seg.length === 3 && seg[2] === 'reword' && method === 'POST') {
      // A participant asks for their own draft to be reworded. Nothing is stored; they choose whether to use it.
      if (!myKey) throw new HttpError(401, 'sign_in_required');
      if (!s.aiReword || !env.AI) throw new HttpError(404, 'not_found');
      // Name-only guests identify themselves with a token their browser makes up, so a new token would
      // be a new budget. They are counted by address instead.
      await rateLimit(env.AI_LIMIT, session ? myKey : addressKey(request));
      const body = await readJson(request);
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, REWORD_MAX_CHARS) : '';
      if (text.length < REWORD_MIN_CHARS) throw new HttpError(400, 'too_short');
      try {
        return json({ text: await reword(env.AI, s.aiModel, text) });
      } catch (e) {
        console.warn('reword failed:', e.message);
        throw new HttpError(502, 'ai_failed');
      }
    }

    if (seg.length === 3 && seg[2] === 'details' && method === 'PUT') {
      if (!isOwner) throw new HttpError(403, 'forbidden');
      const body = await readJson(request);
      const title = body.title === undefined ? event.title : cleanText(body.title, 120);
      if (!title) throw new HttpError(400, 'invalid', { field: 'title' });
      const note = body.note === undefined ? event.note : cleanText(body.note, 500);
      const preferred = body.preferred === undefined ? event.preferred : pickPreferred(body.preferred, event.dates);
      await env.DB.prepare('UPDATE events SET title = ?, note = ?, preferred = ? WHERE id = ?')
        .bind(title, note, JSON.stringify(preferred), id).run();
      return json({ title, note, preferred });
    }

    if (seg.length === 3 && seg[2] === 'lock' && method === 'PUT') {
      if (!isOwner) throw new HttpError(403, 'forbidden');
      const locked = (await readJson(request)).locked === true;
      await env.DB.prepare('UPDATE events SET locked = ? WHERE id = ?').bind(locked ? 1 : 0, id).run();
      return json({ locked });
    }

    if (seg.length === 3 && seg[2] === 'polls' && method === 'POST') {
      if (!isOwner) throw new HttpError(403, 'forbidden');
      const poll = validatePoll(await readJson(request), event);
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM day_polls WHERE event_id = ?').bind(id).first();
      if (n >= s.maxDayPolls) throw new HttpError(409, 'too_many_polls', { limit: s.maxDayPolls });
      const pid = randomId(8);
      await env.DB.prepare('INSERT INTO day_polls (id, event_id, day, prompt, options, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pid, id, poll.day, poll.prompt, JSON.stringify(poll.options), Date.now()).run();
      return json({ poll: { id: pid, ...poll } }, 201);
    }

    if (seg[2] === 'polls' && seg[3]) {
      const pid = seg[3];
      const poll = /^[a-z0-9]{6,20}$/.test(pid)
        ? await env.DB.prepare('SELECT id, day, options FROM day_polls WHERE id = ? AND event_id = ?').bind(pid, id).first()
        : null;
      if (!poll) throw new HttpError(404, 'not_found');

      if (seg.length === 4 && method === 'DELETE') {
        if (!isOwner) throw new HttpError(403, 'forbidden');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM day_poll_votes WHERE poll_id = ?').bind(pid),
          env.DB.prepare('DELETE FROM day_polls WHERE id = ?').bind(pid),
        ]);
        return json({ ok: true });
      }

      if (seg.length === 5 && seg[4] === 'vote' && method === 'PUT') {
        if (!myKey) throw new HttpError(401, 'sign_in_required');
        // The poll is only for people who said they can make that day. Checked against what is
        // saved, not what the page claims.
        const mine = await env.DB.prepare('SELECT slots FROM responses WHERE event_id = ? AND user_key = ?').bind(id, myKey).first();
        if (!mine || !freeOnDay(event, mine.slots, event.dates.indexOf(poll.day))) {
          throw new HttpError(403, 'not_available', { day: poll.day });
        }
        const { choice } = await readJson(request);
        if (choice === null) {
          await env.DB.prepare('DELETE FROM day_poll_votes WHERE poll_id = ? AND user_key = ?').bind(pid, myKey).run();
          return json({ myVote: null });
        }
        if (!Number.isInteger(choice) || choice < 0 || choice >= parseJson(poll.options, []).length) {
          throw new HttpError(400, 'bad_choice');
        }
        await env.DB.prepare(
          `INSERT INTO day_poll_votes (poll_id, event_id, user_key, choice) VALUES (?, ?, ?, ?)
           ON CONFLICT (poll_id, user_key) DO UPDATE SET choice = excluded.choice`,
        ).bind(pid, id, myKey, choice).run();
        return json({ myVote: choice });
      }
    }

    if (seg.length === 3 && seg[2] === 'questions' && method === 'PUT') {
      if (!isOwner) throw new HttpError(403, 'forbidden');
      const body = await readJson(request);
      const questions = questionsOrThrow(body.questions, s);
      const anon = body.anonAnswers !== false;
      const writes = [env.DB.prepare('UPDATE events SET questions = ?, anon_answers = ? WHERE id = ?')
        .bind(JSON.stringify(questions), anon ? 1 : 0, id)];
      if (event.anonAnswers && !anon) {
        // People who answered were told it was anonymous, and their answers are stored with no way
        // to say whose they are. Named mode is only possible while nobody has answered.
        const { results } = await env.DB.prepare('SELECT answers FROM anon_answers WHERE event_id = ?').bind(id).all();
        const anyAnswers = results.some((r) => Object.keys(cleanAnswers(event.questions, parseJson(r.answers, {}))).length > 0);
        if (anyAnswers) throw new HttpError(409, 'anon_locked');
        writes.push(
          env.DB.prepare('DELETE FROM anon_answers WHERE event_id = ?').bind(id),
          env.DB.prepare('UPDATE events SET survey_release = NULL WHERE id = ?').bind(id),
        );
      } else if (!event.anonAnswers && anon) {
        // Named → anonymous: move every answer out of its named row.
        const { results } = await env.DB.prepare("SELECT user_key, answers FROM responses WHERE event_id = ? AND answers != '{}'").bind(id).all();
        for (const r of results) {
          writes.push(...await anonWrites(env, id, r.user_key, cleanAnswers(questions, parseJson(r.answers, {})), questions));
        }
        writes.push(env.DB.prepare("UPDATE responses SET answers = '{}' WHERE event_id = ?").bind(id));
      }
      await env.DB.batch(writes);
      if (anon) await maybeRelease(env, { ...event, questions }, s);
      return json({ questions, anonAnswers: anon });
    }
  }

  throw new HttpError(404, 'not_found');
}

// ---------- shaping ----------

function publicUser(u) {
  return { email: u.email, name: u.name, picture: u.picture, hd: u.hd };
}

function publicEvent(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    kind: row.kind,
    tz: row.tz,
    dates: JSON.parse(row.dates),
    startMin: row.start_min,
    endMin: row.end_min,
    slotMin: row.slot_min,
    domains: JSON.parse(row.domains),
    allowGuests: !!row.allow_guests,
    hideResults: !!row.hide_results,
    questions: parseJson(row.questions ?? '[]', []),
    anonAnswers: row.anon_answers !== 0,
    preferred: parseJson(row.preferred ?? '[]', []),
    locked: !!row.locked,
    owner: { name: row.owner_name, picture: row.owner_picture },
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
  };
}

function publicResponse(r, myKey, isOwner, myAnswers = {}) {
  const mine = r.user_key === myKey;
  // No timestamps here on purpose: when someone answered is not anyone else's business, and it
  // would help an organizer guess whose anonymous answers just arrived.
  return {
    rid: r.rid,
    name: r.name,
    picture: r.picture,
    // Other participants see names only; the organizer also sees who answered.
    email: isOwner || mine ? r.email : undefined,
    guest: r.user_key.startsWith('g:'),
    slots: r.slots,
    // Only ever echoed back to the person who gave them; the organizer gets `survey` instead.
    answers: mine ? myAnswers : undefined,
    mine,
  };
}

function slotCount(event) {
  return event.kind === 'times'
    ? event.dates.length * ((event.endMin - event.startMin) / event.slotMin)
    : event.dates.length;
}

// ---------- day polls ----------

/** Did this person mark the event's d-th day (any time on it) as one they can make? */
function freeOnDay(event, slots, d) {
  if (d < 0 || typeof slots !== 'string') return false;
  const per = event.kind === 'times' ? (event.endMin - event.startMin) / event.slotMin : 1;
  return slots.slice(d * per, (d + 1) * per).includes('1');
}

function validatePoll(b, event) {
  const bad = (field) => new HttpError(400, 'invalid', { field });
  if (!event.dates.includes(b.day)) throw bad('day');
  const prompt = cleanText(b.prompt, 160);
  if (!prompt) throw bad('prompt');
  const options = [...new Set((Array.isArray(b.options) ? b.options : []).map((o) => cleanText(o, 80)).filter(Boolean))];
  if (options.length < 2 || options.length > 6) throw bad('options');
  return { day: b.day, prompt, options };
}

/**
 * Polls as this viewer may see them. Everyone gets the question and their own answer; names and
 * totals follow the same rule as availability (hidden from participants when the organizer chose
 * "only I can see responses"). A vote counts only while its owner is still free that day.
 */
async function readPolls(env, event, responses, myKey, canSee) {
  const [polls, votes] = await env.DB.batch([
    env.DB.prepare('SELECT id, day, prompt, options FROM day_polls WHERE event_id = ? ORDER BY created_at, id').bind(event.id),
    env.DB.prepare('SELECT poll_id, user_key, choice FROM day_poll_votes WHERE event_id = ?').bind(event.id),
  ]);
  return polls.results.map((p) => {
    const options = parseJson(p.options, []);
    const d = event.dates.indexOf(p.day);
    const free = responses.filter((r) => freeOnDay(event, r.slots, d));
    const byKey = new Map(free.map((r) => [r.user_key, r]));
    const counted = votes.results.filter((v) => v.poll_id === p.id && byKey.has(v.user_key) && v.choice < options.length);
    const out = {
      id: p.id, day: p.day, prompt: p.prompt, options,
      myVote: counted.find((v) => v.user_key === myKey)?.choice ?? null,
    };
    if (canSee) {
      const voted = new Set(counted.map((v) => v.user_key));
      out.eligible = free.length;
      out.voters = options.map((_, k) => free.filter((r) => counted.some((v) => v.user_key === r.user_key && v.choice === k)).map((r) => r.name));
      out.waiting = free.filter((r) => !voted.has(r.user_key)).map((r) => r.name);
    }
    return out;
  });
}

// ---------- validation ----------

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function validateEvent(b, s) {
  const bad = (field) => new HttpError(400, 'invalid', { field });
  const title = cleanText(b.title, 120);
  if (!title) throw bad('title');
  const kind = b.kind;
  if (kind !== 'days' && kind !== 'times') throw bad('kind');

  const tz = typeof b.tz === 'string' ? b.tz : '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw bad('tz');
  }
  if (!tz) throw bad('tz');

  if (!Array.isArray(b.dates) || !b.dates.every(validDate)) throw bad('dates');
  const dates = [...new Set(b.dates)].sort();
  if (dates.length < 1 || dates.length > MAX_DATES) throw bad('dates');

  let startMin = null, endMin = null, slotMin = null;
  if (kind === 'times') {
    ({ startMin, endMin, slotMin } = b);
    if (![15, 30, 60].includes(slotMin)) throw bad('slotMin');
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) throw bad('time');
    if (startMin < 0 || endMin > 1440 || startMin >= endMin) throw bad('time');
    if (startMin % slotMin || endMin % slotMin) throw bad('time');
  }

  const domains = [...new Set((Array.isArray(b.domains) ? b.domains : [])
    .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
  if (domains.length > 5 || !domains.every((d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d))) {
    throw bad('domains');
  }
  // On a domain-locked instance an event can narrow the audience but never widen it.
  if (s.allowedDomains.length && !domains.every((d) => s.allowedDomains.includes(d))) throw bad('domains');

  return {
    title,
    note: cleanText(b.note, 500),
    kind, tz, dates, startMin, endMin, slotMin, domains,
    // A domain-limited event can't also accept anonymous names, and the instance can forbid them outright.
    allowGuests: !!b.allowGuests && domains.length === 0 && s.allowGuestResponses,
    hideResults: !!b.hideResults,
    preferred: pickPreferred(b.preferred, dates),
    questions: questionsOrThrow(b.questions, s),
    anonAnswers: b.anonAnswers !== false,
  };
}

/** The organizer's preferred dates: whichever of the given ones are actually candidates. */
function pickPreferred(input, dates) {
  return [...new Set((Array.isArray(input) ? input : []).filter((d) => dates.includes(d)))].sort();
}

function roughGeo(request) {
  const lat = Number(request.cf?.latitude), lng = Number(request.cf?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 };
}

function questionsOrThrow(input, s) {
  try {
    return validateQuestions(input, { max: s.maxQuestions });
  } catch (e) {
    if (e instanceof SurveyError) throw new HttpError(400, 'invalid', { field: 'questions' });
    throw e;
  }
}

// ---------- limits & retention ----------

/** Workers rate-limiting binding. Absent binding (tests, or removed from config) means no limit. */
const addressKey = (request) => `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;

async function rateLimit(binding, key) {
  if (!binding) return;
  const { success } = await binding.limit({ key });
  if (!success) throw new HttpError(429, 'slow_down');
}

function deleteEventStatements(env, where, ...args) {
  return [
    env.DB.prepare(`DELETE FROM anon_answers WHERE event_id IN (SELECT id FROM events WHERE ${where})`).bind(...args),
    env.DB.prepare(`DELETE FROM day_poll_votes WHERE event_id IN (SELECT id FROM events WHERE ${where})`).bind(...args),
    env.DB.prepare(`DELETE FROM day_polls WHERE event_id IN (SELECT id FROM events WHERE ${where})`).bind(...args),
    env.DB.prepare(`DELETE FROM responses WHERE event_id IN (SELECT id FROM events WHERE ${where})`).bind(...args),
    env.DB.prepare(`DELETE FROM events WHERE ${where}`).bind(...args),
  ];
}

async function purgeExpired(env) {
  await env.DB.batch(deleteEventStatements(env, 'expires_at IS NOT NULL AND expires_at < ?', Date.now()));
}

// ---------- sessions ----------

function devLoginEnabled(env, url) {
  return env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
}

async function hmacKey(secret, name) {
  if (!secret) throw new HttpError(503, 'not_configured', { missing: name });
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/,
// so a sibling subdomain can't plant one. It can't be used over plain http, which only happens in local dev.
const cookieName = (url) => (url.protocol === 'https:' ? '__Host-rdv_session' : 'rdv_session');
const cookieFlags = (url) => `Path=/; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;

async function sessionCookie(user, env, url, s) {
  const ttl = Math.round(s.sessionHours * 3600);
  const payload = b64url(enc.encode(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET, 'SESSION_SECRET'), enc.encode(payload)));
  return `${cookieName(url)}=${payload}.${sig}; ${cookieFlags(url)}; Max-Age=${ttl}`;
}

async function readSession(request, env, url, s) {
  const name = cookieName(url);
  const cookie = request.headers.get('Cookie') || '';
  const raw = cookie.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw || !env.SESSION_SECRET) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET, 'SESSION_SECRET'), unb64url(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(unb64url(payload)));
    if (!data.sub || !data.email || data.exp < Date.now() / 1000) return null;
    // Tightening allowedDomains takes effect immediately, not when old sessions run out.
    if (!signInAllowed(data, s)) return null;
    return data;
  } catch {
    return null;
  }
}

async function guestKeyFrom(request) {
  const token = request.headers.get('X-Guest-Token');
  if (!token || token.length < 20 || token.length > 100) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
  return `g:${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------- anonymous answers ----------
//
// Stored apart from the people who gave them (migration 0004) and shown to the organizer only in
// batches (migration 0005). Each person has up to two rows under unrelated keys: one for what they
// said, one for their map pin, because a pin can hint at who someone is.

const ANON_PARTS = [
  { name: 'answers', col: 'a', owns: (q) => q.type !== 'area' },
  { name: 'area', col: 'm', owns: (q) => q.type === 'area' },
];

/**
 * A keyed hash, so the database on its own cannot tell which row belongs to whom; only the running
 * Worker, holding ANON_SECRET, can find it again. ANON_SECRET is separate from the session secret:
 * leaking one does not expose the other, and sessions can be rotated without orphaning answers.
 */
async function anonKey(env, eventId, userKey, part) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(env.ANON_SECRET, 'ANON_SECRET'), enc.encode(`anon-${part}\n${eventId}\n${userKey}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readAnon(env, eventId, userKey) {
  const keys = await Promise.all(ANON_PARTS.map((p) => anonKey(env, eventId, userKey, p.name)));
  const { results } = await env.DB.prepare('SELECT answers FROM anon_answers WHERE event_id = ? AND key IN (?, ?)')
    .bind(eventId, ...keys).all();
  return Object.assign({}, ...results.map((r) => parseJson(r.answers, {})));
}

/**
 * Statements that make a person's anonymous rows match `cleaned`. Returns nothing when nothing
 * changed, so saving availability alone never marks answers as new. A withdrawn answer is kept as
 * an empty row until the next batch, so a withdrawal is batched like any other change.
 */
async function anonWrites(env, eventId, userKey, cleaned, questions) {
  const out = [];
  for (const part of ANON_PARTS) {
    const mine = {};
    for (const q of questions) if (part.owns(q) && cleaned[q.id] !== undefined) mine[q.id] = cleaned[q.id];
    const next = JSON.stringify(mine);
    const key = await anonKey(env, eventId, userKey, part.name);
    const row = await env.DB.prepare('SELECT answers FROM anon_answers WHERE event_id = ? AND key = ?').bind(eventId, key).first();
    if ((row?.answers ?? '{}') === next) continue;
    out.push(env.DB.prepare(
      `INSERT INTO anon_answers (event_id, key, part, answers, pending) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (event_id, key) DO UPDATE SET answers = excluded.answers, pending = 1`,
    ).bind(eventId, key, part.col, next));
  }
  return out;
}

/**
 * Rebuilds the organizer's summary, but only for a part where at least a batch of people have new
 * or changed answers waiting. Until then the organizer keeps seeing the previous summary, so one
 * person's answers never appear as a change on their own.
 */
async function maybeRelease(env, event, s) {
  const id = event.id;
  const { results } = await env.DB.prepare('SELECT key, part, answers, pending FROM anon_answers WHERE event_id = ?').bind(id).all();
  const due = ANON_PARTS.filter((p) => results.filter((r) => r.part === p.col && r.pending).length >= s.anonBatch);
  if (!due.length) return;

  const current = await env.DB.prepare('SELECT survey_release FROM events WHERE id = ?').bind(id).first();
  const release = parseJson(current?.survey_release ?? 'null', null) || { answered: 0, missing: null, questions: {} };
  const writes = [];
  for (const part of due) {
    const rows = results.filter((r) => r.part === part.col);
    const summary = summarize(event.questions.filter(part.owns), rows, true, s.anonBatch);
    if (summary.hidden) continue; // e.g. mostly withdrawals: still fewer than a batch of real answers
    Object.assign(release.questions, summary.questions);
    if (part.col === 'a') {
      release.answered = summary.answered;
      release.missing = await whoHasNotAnswered(env, id, rows);
    }
    writes.push(
      env.DB.prepare('UPDATE anon_answers SET pending = 0 WHERE event_id = ? AND part = ?').bind(id, part.col),
      env.DB.prepare("DELETE FROM anon_answers WHERE event_id = ? AND part = ? AND answers = '{}'").bind(id, part.col),
    );
  }
  if (!writes.length) return;
  const live = new Set(event.questions.map((q) => q.id));
  for (const qid of Object.keys(release.questions)) if (!live.has(qid)) delete release.questions[qid];
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET survey_release = ? WHERE id = ?').bind(JSON.stringify(release), id),
    ...writes,
  ]);
}

/**
 * Names of people who gave availability but no answers, as of this batch. Lets an organizer nudge
 * them. It is computed only at release time, so the list also changes in batches.
 */
async function whoHasNotAnswered(env, eventId, answerRows) {
  const answered = new Set(answerRows.filter((r) => r.answers !== '{}').map((r) => r.key));
  const { results } = await env.DB.prepare('SELECT user_key, name FROM responses WHERE event_id = ? ORDER BY name').bind(eventId).all();
  const out = [];
  for (const r of results) {
    if (!answered.has(await anonKey(env, eventId, r.user_key, 'answers'))) out.push(r.name);
  }
  return out;
}

/** What the organizer of an anonymous questionnaire gets: the last released batch, plus how many are waiting. */
async function anonSurvey(env, row, s) {
  const release = parseJson(row.survey_release ?? 'null', null);
  const { results } = await env.DB.prepare(
    'SELECT part, COUNT(*) AS n FROM anon_answers WHERE event_id = ? AND pending = 1 GROUP BY part',
  ).bind(row.id).all();
  const waiting = (col) => results.find((r) => r.part === col)?.n ?? 0;
  return {
    anon: true,
    hidden: !release,
    min: s.anonBatch,
    answered: release?.answered ?? 0,
    missing: release?.missing ?? null,
    questions: release?.questions ?? {},
    waiting: { answers: waiting('a'), pins: waiting('m') },
  };
}

// ---------- Google ID token ----------

let jwksCache = { keys: [], expires: 0 };

async function googleKeys(force = false) {
  if (!force && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new HttpError(502, 'google_keys_unavailable');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] ?? 3600);
  jwksCache = { keys: (await res.json()).keys, expires: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

async function verifyGoogleIdToken(token, clientId) {
  const invalid = new HttpError(401, 'invalid_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid;
  let header, claims;
  try {
    header = JSON.parse(dec.decode(unb64url(parts[0])));
    claims = JSON.parse(dec.decode(unb64url(parts[1])));
  } catch {
    throw invalid;
  }
  if (header.alg !== 'RS256') throw invalid;

  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // key rotation
  if (!jwk) throw invalid;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw invalid;

  const now = Date.now() / 1000;
  if (claims.aud !== clientId) throw invalid;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw invalid;
  if (!(claims.exp > now - 30) || !claims.sub || !claims.email || claims.email_verified === false) throw invalid;
  return claims;
}

// ---------- helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      ...headers,
    },
  });
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > 20_000) throw new Error('too large');
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

function randomId(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ID_ALPHABET[b & 31]).join('');
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
