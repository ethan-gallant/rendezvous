# Rendezvous

A WhenIsGood-style availability poll: pick candidate days (or days × times), share one link, see which
options work best and who can't make each one. Google sign-in, optional domain restriction, and an
optional Google Calendar overlay that never leaves the browser.

Cloudflare Worker + D1 + static assets. No build step, no frontend framework.

```
src/index.js          API (sessions, events, responses)
src/config.js         instance settings and their defaults
src/survey.js         questionnaire validation, location coarsening and summaries (unit-tested)
src/reword.js         the Workers AI paraphrasing prompt
migrations/           D1 schema
public/               the app (plain ES modules)
public/js/lib/        pure logic: time zones, ranking, calendar overlay (unit-tested)
test/                 node --test
```

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars     # then put two different random strings in SESSION_SECRET and ANON_SECRET
npm run db:local
npm run dev
```

With `DEV_LOGIN=1` in `.dev.vars` (honoured on localhost only) the sign-in dialog has a fake-login form
and the calendar panel loads a sample calendar, so everything works without a Google project.

```bash
npm test
```

## Google setup (one time)

1. Google Cloud console → APIs & Services → **OAuth consent screen**. For a company-only tool choose
   *Internal*; otherwise *External*.
2. **Data access / scopes**: add `.../auth/calendar.freebusy` and `.../auth/calendar.events.readonly`
   (sign-in itself only needs the default `openid email profile`). Enable the **Google Calendar API**.
3. **Credentials → Create OAuth client ID → Web application.** Under *Authorized JavaScript origins* add
   your production origin and `http://localhost:8787`. No redirect URIs are needed.
4. Put the client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID` (it is public, not a secret).

An *External* app that has not been through Google's verification shows an "unverified app" warning when
people connect a calendar, and is limited to 100 users. Sign-in alone is not affected.

## Deploy

```bash
npx wrangler deploy               # first run creates the D1 database and writes its id to wrangler.jsonc
npx wrangler secret put SESSION_SECRET   # signs sign-in sessions
npx wrangler secret put ANON_SECRET      # keys anonymous answers; a different random string
npm run db:remote
```

The two secrets are separate on purpose: leaking one does not expose the other, and `SESSION_SECRET` can
be rotated (which just signs everyone out) without touching answers. Rotating `ANON_SECRET` permanently
cuts people off from the answers they gave, so treat it as write-once.

## Configure it

Everything an operator would want to change lives in `wrangler.jsonc`:

| Setting (`vars.SETTINGS`) | Default | What it does |
|---|---|---|
| `allowedDomains` | `[]` | Google Workspace domains allowed to sign in. Empty means any Google account. With domains set, every event requires sign-in from one of them. Add `"gmail.com"` to allow personal accounts too. |
| `sessionHours` | `24` | How long a sign-in lasts. Returning users are signed back in by Google without a click where the browser allows it. |
| `retentionDays` | `60` | Events, responses and answers are deleted this many days after an event's last candidate day. |
| `allowGuestResponses` | on if `allowedDomains` is empty, else off | Whether organizers may accept name-only answers. |
| `maxEventsPerUserPerDay` | `20` | |
| `maxResponsesPerEvent` | `300` | |
| `maxQuestions` | `12` | |
| `maxDayPolls` | `12` | Follow-up polls about a single day, per event. |
| `anonBatch` | `3` | Anonymous answers reach the organizer in batches of at least this many people. |
| `aiReword`, `aiModel` | `true`, a small Llama model | The "Paraphrase to anonymize" button on written answers. Remove the `ai` binding to switch it off entirely. |

Per-minute rate limits are the two `ratelimits` entries in the same file: `WRITE_LIMIT` (anything that
changes data, per person) and `AI_LIMIT` (paraphrase presses, per signed-in person, or per address for name-only guests).

Security leans on the platform rather than reimplementing it: identity is Google's, TLS/HSTS/DDoS and
rate limiting are Cloudflare's, and request-by-request logging is switched off
(`observability.logs.invocation_logs: false`) so there is no record of who saved what when. To put the
whole site behind Cloudflare Access as well, add an Access application for its hostname; nothing in the
app needs to change.

```bash
npm test    # includes end-to-end API tests of the access, limit, batching and retention rules
```

## Preferred dates and note

The organizer can star one or more candidate days and add a short note ("we're encouraged to aim for the
12th"). Participants see both while they answer; starred days are marked in the grid, always listed in the
ranking, and win ties. Editable later from the pencil button on the event page.

## Day polls and locking

Once a day is looking likely, the organizer can add a **day poll**: one either-or question about that
day ("Co-work day?" / "No co-work day", "Drinks + dinner?" / "No drinks or dinner"), from the event page.
It can be added at any time, including to events created before this feature existed.

- **Who is asked.** Only people whose saved availability includes that day can answer. The Worker checks
  this against the database on every answer; the page's own idea of who is free is not trusted.
- **The link.** Every poll has its own link (`/e/<event>/p/<poll>`), and the event's ordinary link works
  too. Someone who has already responded and opens either one gets just the polls, with a "Change my
  response" button that brings back the calendar and everything else. The organizer always gets the full
  page.
- **Someone who didn't mark the day** is told so, and can add it on the spot (one press for whole-day
  events; for timed events the grid opens at that day). The poll opens up once that is saved.
- **Answers follow availability.** If a person later drops the day, or removes their response, their
  answer to that day's polls is deleted with it.
- **Answers are named**, unlike the questionnaire: the organizer is counting heads. Other participants see
  them too, unless the event is set to "only I can see responses", in which case each person gets back
  only their own answer.

**Lock** (organizer, toggle in the event header) freezes availability: nobody new can respond, and
nobody can change or remove their days, until it is unlocked. Day polls and the questionnaire can still
be answered while locked, which is the point: fix the group first, then ask it things.

## Follow-up questionnaire

An organizer can attach up to 12 questions when creating an event or later from the event page:
pick one, pick any, written answer, or a map ("how far would you travel"). Participants see them once
their availability is saved; every question is optional. Answers go to the organizer only.

The map question lets a person drop a pin roughly where they'll be coming from and size three rings
around it (ideal, fine, a stretch). The organizer gets a combined map of where the group overlaps and a
suggested best area. Leaflet is vendored in `public/vendor/leaflet`; tiles default to OpenStreetMap's
public server, which needs no account or API key and is fine for light use. (The tile source can be
changed with the optional `MAP_TILE_URL` and `MAP_ATTRIBUTION` vars; its host must then be added to
`img-src` in `public/_headers`.) There is deliberately no address search: people zoom and tap.

### Where the privacy is enforced

Nothing below depends on the page behaving. The browser is treated as untrusted; these hold for anyone
calling the API directly, and are covered by `test/api.test.js`.

- **Anonymous answers are stored unlinked.** `anon_answers` holds an event id, an opaque key, the
  answers, which kind of row it is, and a "changed since last batch" flag. No user id, name, email or
  timestamp, and the table is `WITHOUT ROWID` so rows sit in key order rather than arrival order. The key
  is `HMAC(ANON_SECRET, part | event | user)`, which lets the Worker find a returning person's row but
  cannot be reversed or recomputed from the database alone. For an anonymous event the `responses` row
  keeps availability only.
- **The organizer sees batches, not a live feed.** The organizer's view is a stored snapshot
  (`events.survey_release`) that is only rebuilt when at least `anonBatch` people have new or changed
  answers waiting. One person's answers therefore never appear as a change on their own, and a withdrawal
  is batched like any other change. The API sends no per-response timestamps to anyone.
- **"Who hasn't answered" is batched too.** The organizer gets a list of people who gave availability
  but no answers, so they can nudge them. It is computed only when a batch is released.
- **Pins are kept apart from comments.** A person's map pin and their other answers are two rows under
  unrelated keys, batched separately, because a location can hint at who someone is.
- **Locations are coarsened before storage.** The Worker rounds every pin to 0.01° (about a kilometre)
  regardless of what the client sends.
- **Summaries are computed on the server.** An anonymous summary contains counts, unattributed comments
  in sorted order, and a coverage grid. It never contains individual pins, and it leaves out map cells
  only one person can reach.
- **Anonymity is one-way.** An event can go from named to anonymous (answers are moved and unlinked); it
  cannot go back once anyone has answered.
- **Everything expires.** Each event stores the date it will be deleted, fixed at creation and shown to
  everyone. Past that date the API treats it as gone, and a daily cron removes the rows.
- **AI paraphrasing is opt-in per press.** It exists to disguise writing style, not to improve the
  answer. A written answer is sent to Workers AI only when its author presses the button; they see the
  paraphrase and choose whether to use it. Nothing is stored.

This is best-effort anonymity, and it is worth being plain about its limits:

- A batch of three is small. With `anonBatch: 3`, an organizer who knows which three people just answered
  knows the new answers are theirs collectively, though not which is whose. Raise it for larger groups.
- Written comments can be recognisable by content, whatever the wording.
- Whoever operates the deployment holds `ANON_SECRET`, controls the code, and has a database that keeps
  restorable history (D1 Time Travel, up to 30 days; Durable Objects have the same). No storage choice
  removes that. What stands in its place is a promise: the operator runs this published code unmodified
  and does not go looking.

## How the privacy model works

- **Sign-in** uses Google Identity Services' ID token. The Worker verifies the signature against Google's
  keys and stores name, email, photo and Workspace domain (`hd`) in a signed, HttpOnly session cookie.
- **Domain restriction** compares the event's domain to the `hd` claim, which is Google's own assertion
  that the account belongs to that Workspace. Outside that domain the API returns nothing about the event.
- **Calendar** is a separate, optional grant made from the event page, with two levels that map to two
  different Google scopes:
  - *Busy blocks only* → `calendar.freebusy`: Google returns busy intervals and nothing else.
  - *Event names too* → `calendar.events.readonly`: titles, so people can untick movable conflicts.

  The access token lives in a JS variable in the tab. The browser calls `googleapis.com` directly; the
  Worker has no calendar endpoint, and the page's Content-Security-Policy only allows connections to this
  origin, Google, and map image tiles. Only the cells a person paints are ever saved.
- Calendar busy time is drawn over the grid but never auto-applied. For whole-day events (on-sites),
  ordinary meetings are listed but not counted as conflicts unless the person ticks them; only
  out-of-office and all-day events are pre-ticked.
