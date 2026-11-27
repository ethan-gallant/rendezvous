// The event page: paint your availability, see the group, see what's best.

import { api, ApiError } from './api.js';
import { session, onSession, openSignIn, signOut, reportApiError } from './auth.js';
import { navigate } from './router.js';
import { h, icon, avatar, toast, copyText, confirmDialog, openDialog, plural, nameList, isTouch, saveStatus } from './ui.js';
import { attachPaint, buildTimesGrid, buildDaysGrid } from './grid.js';
import { tally, split, rankDays, rankWindows, optionSlots, slotCount, slotsPerDay } from './lib/rank.js';
import { slotRanges, overlaps, busyMinutes, blocksByDefault } from './lib/overlay.js';
import {
  durationLabel, fmtDate, fmtDateSpan, fmtRange, fmtTime, localTz, prefers12h,
  tzAbbr, tzCity, tzOffsetMs, utcToZoned, zonedToUtc,
} from './lib/time.js';
import { openQuestionBuilder, buildQuestionnaire, buildSurveyResults, surveyText } from './questions.js';
import { openPollBuilder, buildPoll, longDay } from './polls.js';
import { calendarAvailable, requestCalendarToken, revokeCalendarToken, fetchBusy, fetchEvents, sampleCalendar } from './gcal.js';

const SAVE_DELAY_MS = 600;
const REFRESH_MS = 30_000;

export function renderEvent(root, id, { pollId = null } = {}) {
  let alive = true;
  const guestKey = `rdv-guest:${id}`;
  let guest = readGuest();

  let data = null;       // { event, responses, respondentCount, me }
  let mine = null;       // Uint8Array, one byte per slot
  let dirty = false;     // local picks not yet on the server
  let saveState = 'idle';
  let saveTimer = 0;
  let mode = null;       // 'mine' | 'group'
  let focusRid = null;   // person pinned in the group view
  let hoverRid = null;
  let highlight = new Set();
  let minSlots = 1;
  let showAllDays = false;
  let cal = null;        // { mode, token, items, override: Map, sample }
  let calCache = null;
  let ui = null;         // functions exposed by the current build()
  const answers = {};    // questionnaire answers; mutated in place so the rendered form keeps its reference
  let qKey = null;       // what the questionnaire card was last rendered for
  let qWasLocked;        // to notice the moment it unlocks
  let sKey = null;       // what the organizer's results card was last rendered for
  let pKey = null;       // what the day-polls card was last rendered for
  let pollJump = pollId; // the poll this link points at, until we've scrolled to it once
  let simple = null;     // polls-only view for someone coming back to answer a follow-up; decided on first load
  const justCreated = !!history.state?.created;
  if (justCreated) history.replaceState(null, ''); // show the share banner once, not on every reload

  function readGuest() {
    try {
      const g = JSON.parse(localStorage.getItem(guestKey));
      return g?.token && g?.name ? g : null;
    } catch {
      return null;
    }
  }

  const identity = () => session.user || (data?.event.allowGuests ? guest : null);
  const myResponse = () => data.responses.find((r) => r.mine) || null;
  const setAnswers = (src) => {
    for (const k of Object.keys(answers)) delete answers[k];
    Object.assign(answers, src || {});
  };

  // ------------------------------------------------------------------ loading

  async function load({ keepDraft = false } = {}) {
    try {
      const fresh = await api(`/events/${id}`, { guestToken: guest?.token });
      if (!alive) return;
      data = fresh;
      const n = slotCount(data.event);
      if (!(keepDraft && dirty && mine?.length === n)) {
        mine = fromSlots(myResponse()?.slots, n);
        setAnswers(myResponse()?.answers);
        dirty = false;
      }
      qKey = null;
      sKey = null;
      pKey = null;
      build();
      if (dirty && identity()) save();
    } catch (e) {
      if (!alive) return;
      data = null;
      ui = null;
      if (e instanceof ApiError && e.code === 'domain_required') renderGate(e.body);
      else if (e instanceof ApiError && e.status === 404) renderMessage('We couldn’t find that event', 'The link may be mistyped, or the organizer deleted it.');
      else renderMessage('Something went wrong', 'Please reload the page to try again.');
    }
  }

  /** Pull in other people's answers without disturbing what's on screen. */
  async function refresh({ force = false } = {}) {
    if (!data || !ui || (!force && document.visibilityState !== 'visible')) return;
    try {
      const fresh = await api(`/events/${id}`, { guestToken: guest?.token });
      if (!alive || !ui) return;
      const sig = (d) => JSON.stringify([d.responses, d.respondentCount, d.survey, d.event, d.polls]);
      const same = sig(fresh) === sig(data);
      if (same) return; // leave hover states and scroll positions alone
      // The page is drawn around the event's settings, so a change to those (locked, questions) redraws it.
      const eventChanged = JSON.stringify(fresh.event) !== JSON.stringify(data.event);
      data = fresh;
      if (!dirty && saveState !== 'saving') {
        mine = fromSlots(myResponse()?.slots, slotCount(data.event));
        const theirs = myResponse()?.answers || {};
        if (JSON.stringify(theirs) !== JSON.stringify(answers)) qKey = null; // changed on another device
        setAnswers(theirs);
      }
      if (eventChanged) {
        qKey = sKey = pKey = null;
        build();
      } else ui.refreshAll();
    } catch { /* transient; try again next tick */ }
  }

  function fromSlots(str, n) {
    const out = new Uint8Array(n);
    if (str && str.length === n) for (let i = 0; i < n; i++) out[i] = str.charCodeAt(i) === 49 ? 1 : 0;
    return out;
  }
  const toSlots = () => Array.from(mine, (v) => (v ? '1' : '0')).join('');

  // ------------------------------------------------------------------- saving

  function changed() {
    dirty = true;
    ui?.refreshFoot();
    if (!identity()) return setSave('needs-auth');
    setSave('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!identity()) return setSave('needs-auth');
    setSave('saving');
    const snapshot = () => `${toSlots()}|${JSON.stringify(answers)}`;
    const sent = snapshot();
    try {
      const { response } = await api(`/events/${id}/response`, {
        method: 'PUT',
        body: { slots: toSlots(), answers, name: session.user ? undefined : guest?.name },
        guestToken: session.user ? undefined : guest?.token,
      });
      if (!alive || !data) return;
      const at = data.responses.findIndex((r) => r.rid === response.rid);
      if (at >= 0) data.responses[at] = response;
      else {
        data.responses.push(response);
        data.respondentCount++;
      }
      if (snapshot() !== sent) return save(); // more changes happened meanwhile
      dirty = false;
      setSave('saved');
      ui?.refreshAll();
      // Pick up what the server recomputes: the organizer's summary, and who each day poll is waiting on.
      if ((data.me.isOwner && data.event.questions.length) || data.polls?.length) refresh({ force: true });
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 401) return setSave('needs-auth');
      if (e instanceof ApiError && e.code === 'domain_required') return load();
      if (e instanceof ApiError && e.code === 'locked') {
        // Locked while this page was open: drop the unsaved change and show what's actually saved.
        dirty = false;
        saveState = 'idle';
        reportApiError(e);
        return load();
      }
      setSave('error');
      if (e instanceof ApiError && e.code === 'event_full') reportApiError(e);
    }
  }

  function setSave(state) {
    saveState = state;
    // Also shown floating, because the status next to the grid is often off screen (or hidden
    // altogether in the polls-only view) when someone is answering questions further down.
    saveStatus(state === 'saving' || state === 'saved' || state === 'error' ? state : null);
    ui?.refreshStatus();
  }

  async function askIdentity() {
    const ev = data.event;
    const res = await openSignIn({
      title: 'Save your availability',
      reason: ev.allowGuests ? 'Sign in with Google, or just tell us your name.' : 'Sign in so the group knows whose answer this is.',
      domains: ev.domains,
      allowGuest: ev.allowGuests,
    });
    if (res?.type === 'guest') {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      guest = { token: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), name: res.name };
      try {
        localStorage.setItem(guestKey, JSON.stringify(guest));
      } catch { /* answer still works for this visit */ }
      load({ keepDraft: true });
    }
    // A Google sign-in arrives through onSession below.
  }

  // ----------------------------------------------------------- gate & errors

  function renderMessage(title, text) {
    root.replaceChildren(h('section', { class: 'card empty-state' },
      h('h1', null, title), h('p', { class: 'muted' }, text),
      h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Create an event')));
  }

  function renderGate({ domains = [], signedInAs }) {
    const list = domains.map((d) => `@${d}`).join(' or ');
    const signIn = () => openSignIn({ title: 'Sign in to open this event', domains });
    root.replaceChildren(h('section', { class: 'card empty-state gate' },
      h('div', { class: 'gate-icon' }, icon('lock', 28)),
      h('h1', null, `This event is for ${list} accounts`),
      signedInAs
        ? h('p', { class: 'muted' }, `You’re signed in as ${signedInAs}, which isn’t part of that organization.`)
        : h('p', { class: 'muted' }, 'Sign in with your work Google account to open it.'),
      h('button', {
        class: 'btn primary', type: 'button',
        onClick: async () => {
          if (signedInAs) await signOut();
          else signIn();
        },
      }, signedInAs ? 'Switch account' : 'Sign in with Google'),
    ));
  }

  // -------------------------------------------------------------------- build

  function build() {
    const ev = data.event;
    const isTimes = ev.kind === 'times';
    const hour12 = prefers12h();
    const n = slotCount(ev);
    const per = slotsPerDay(ev);
    const canSee = data.me.canSeeResults;
    const ranges = slotRanges(ev);

    // Someone who already gave their days and comes back because of a follow-up poll gets just the
    // polls, not the whole scheduling page. So does anyone arriving by a poll's own link. The organizer
    // always gets the full page. Decided once, so the page never collapses under someone using it.
    if (simple === null) simple = !data.me.isOwner && (data.polls?.length ?? 0) > 0 && (!!myResponse() || !!pollId);

    if (!mode) mode = canSee && myResponse() && data.responses.length > 1 ? 'group' : 'mine';
    if (!canSee) mode = 'mine';
    document.title = `${ev.title} · Rendezvous`;

    // ---- timezone ----
    const viewerTz = localTz();
    const probe = isTimes ? zonedToUtc(ev.dates[0], ev.startMin, ev.tz) : 0;
    const tzDiffers = isTimes && tzOffsetMs(probe, ev.tz) !== tzOffsetMs(probe, viewerTz);
    const altLabel = tzDiffers
      ? (min) => fmtTime(utcToZoned(zonedToUtc(ev.dates[0], min, ev.tz), viewerTz).minutes, { hour12, compact: true })
      : null;

    const grid = isTimes ? buildTimesGrid(ev, { hour12, altLabel }) : buildDaysGrid(ev);
    grid.el.classList.add('grid');

    // ---- organizer's preferred dates ----
    const prefSet = new Set(ev.preferred || []);
    const isPref = (i) => prefSet.has(ev.dates[Math.floor(i / per)]);
    ev.dates.forEach((date, d) => {
      if (!prefSet.has(date)) return;
      grid.dayHeads[d]?.classList.add('pref');
      for (let k = 0; k < per; k++) grid.cells[d * per + k].classList.add('pref');
    });
    const prefChip = () => h('span', { class: 'pref-chip' }, '★ Preferred');

    const slotLabel = (i) => {
      const d = Math.floor(i / per);
      const day = fmtDate(ev.dates[d]);
      if (!isTimes) return day;
      const a = ev.startMin + (i % per) * ev.slotMin;
      return `${day} · ${fmtRange(a, a + ev.slotMin, { hour12 })}`;
    };
    const itemTime = (it) => {
      if (it.allDay) return 'All day';
      const a = utcToZoned(it.start, ev.tz), b = utcToZoned(it.end, ev.tz);
      return `${fmtTime(a.minutes, { hour12, compact: true })}–${fmtTime(b.minutes, { hour12, compact: true })}`;
    };

    // ---- calendar overlay state ----
    const blocks = (it) => {
      if (cal.override.has(it.id)) return cal.override.get(it.id);
      if (cal.mode === 'busy') return isTimes; // whole-day events: show, but never assume
      return blocksByDefault(ev, it);
    };
    function calc() {
      if (!cal) return null;
      if (!calCache) {
        const perCell = overlaps(ranges, cal.items);
        const blocked = new Uint8Array(n);
        perCell.forEach((items, i) => { if (items.some(blocks)) blocked[i] = 1; });
        calCache = { perCell, blocked, minutes: busyMinutes(ranges, cal.items.filter((it) => !it.free)) };
      }
      return calCache;
    }

    // ---- header ----
    const url = `${location.origin}/e/${ev.id}`;
    const copyLink = async () => toast((await copyText(url)) ? 'Link copied' : 'Couldn’t copy. Select the link and copy it manually.');
    const share = () => navigator.share({ title: ev.title, text: `When works for “${ev.title}”?`, url }).catch(() => {});
    const meta = h('ul', { class: 'ev-meta' },
      h('li', null, icon('calendar', 16), `${plural(ev.dates.length, 'day')} · ${fmtDateSpan(ev.dates)}`),
      isTimes && h('li', null, icon('clock', 16), `${fmtRange(ev.startMin, ev.endMin, { hour12 })} · ${tzCity(ev.tz)} time`),
      ev.domains.length > 0 && h('li', null, icon('lock', 16), `${ev.domains.map((d) => `@${d}`).join(', ')} only`),
      ev.allowGuests && h('li', null, icon('users', 16), 'No sign-in needed'),
      ev.hideResults && h('li', null, icon('eyeOff', 16), data.me.isOwner ? 'Only you see responses' : 'Only the organizer sees responses'),
      ev.locked && h('li', null, icon('lock', 16), 'Availability locked'),
      h('li', null, avatar(ev.owner, 18), data.me.isOwner ? 'You’re the organizer' : `Organized by ${ev.owner.name}`),
      ev.expiresAt && h('li', { title: 'The event, everyone’s availability and all answers are deleted on this date.' }, icon('trash', 16),
        `Deleted automatically on ${fmtDate(new Date(ev.expiresAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })}`),
    );
    const head = h('header', { class: 'ev-head' },
      h('div', { class: 'ev-title' }, h('h1', null, ev.title), meta),
      h('div', { class: 'ev-actions' },
        h('button', { class: 'btn', type: 'button', onClick: copyLink }, icon('link', 16), 'Copy link'),
        navigator.share && h('button', { class: 'btn', type: 'button', onClick: share }, icon('share', 16), 'Share'),
        data.me.isOwner && h('button', {
          class: `btn${ev.locked ? ' on' : ''}`, type: 'button', 'aria-pressed': ev.locked ? 'true' : 'false',
          title: ev.locked ? 'Let people add or change their days again' : 'Freeze who has responded and which days they picked',
          onClick: toggleLock,
        }, icon('lock', 16), ev.locked ? 'Unlock' : 'Lock'),
        data.me.isOwner && h('button', { class: 'icon-btn', type: 'button', title: 'Edit name, note and preferred days', 'aria-label': 'Edit details', onClick: () => editDetails() }, icon('pencil', 18)),
        data.me.isOwner && h('button', {
          class: 'icon-btn', type: 'button', title: 'Delete event', 'aria-label': 'Delete event',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Delete this event?',
              text: `“${ev.title}” and all ${plural(data.respondentCount, 'response')} will be removed for everyone. This can’t be undone.`,
              confirm: 'Delete event', danger: true,
            });
            if (!ok) return;
            try {
              await api(`/events/${id}`, { method: 'DELETE' });
              toast('Event deleted');
              navigate('/');
            } catch (e) {
              reportApiError(e);
            }
          },
        }, icon('trash', 18)),
      ),
    );

    const prefList = [...prefSet].sort();
    const prefNote = (prefList.length > 0 || ev.note) && h('section', { class: 'pref-note' },
      prefList.length > 0 && h('div', { class: 'pref-line' }, icon('star', 18),
        h('span', null, h('strong', null, prefList.length === 1 ? 'Preferred date: ' : 'Preferred dates: '),
          nameList(prefList.map((d) => fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })), 6))),
      ev.note && h('p', { class: 'ev-note' }, ev.note),
      prefList.length > 0 && h('p', { class: 'fine' }, 'Other days are still on the table. Mark every day you can make.'));

    async function toggleLock() {
      try {
        const { locked } = await api(`/events/${id}/lock`, { method: 'PUT', body: { locked: !ev.locked } });
        toast(locked ? 'Availability locked. Nobody can add or change their days until you unlock it.' : 'Availability unlocked.');
        load({ keepDraft: !locked });
      } catch (e) {
        reportApiError(e, 'Couldn’t change the lock. Please try again.');
      }
    }

    async function editDetails() {
      const res = await openDialog((close) => {
        const title = h('input', { type: 'text', maxLength: 120, value: ev.title, 'aria-label': 'Event name' });
        const note = h('textarea', { rows: 3, maxLength: 500, value: ev.note, placeholder: 'Anything people should know while they answer', 'aria-label': 'Note for participants' });
        const chosen = new Set(prefSet);
        const chips = h('div', { class: 'chips left' }, ev.dates.map((d) => {
          const b = h('button', {
            type: 'button', class: 'chip star',
            onClick: () => {
              if (chosen.has(d)) chosen.delete(d);
              else chosen.add(d);
              paint();
            },
          });
          const paint = () => {
            b.classList.toggle('on', chosen.has(d));
            b.setAttribute('aria-pressed', chosen.has(d) ? 'true' : 'false');
            b.textContent = `${chosen.has(d) ? '★ ' : ''}${fmtDate(d)}`;
          };
          paint();
          return b;
        }));
        return h('form', {
          class: 'dialog-body',
          onSubmit: (e) => {
            e.preventDefault();
            if (title.value.trim()) close({ title: title.value, note: note.value.replace(/\s+/g, ' '), preferred: [...chosen] });
          },
        },
          h('h2', null, 'Edit details'),
          h('label', { class: 'field' }, h('span', null, 'Name'), title),
          h('label', { class: 'field' }, h('span', null, 'Note for participants'), note),
          h('div', { class: 'field' }, h('span', null, 'Preferred days (shown with a star)'), chips),
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn ghost', type: 'button', onClick: () => close(null) }, 'Cancel'),
            h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
      }, { className: 'wide' });
      if (!res) return;
      try {
        await api(`/events/${id}/details`, { method: 'PUT', body: res });
        toast('Details updated');
        load({ keepDraft: true });
      } catch (e) {
        reportApiError(e, 'Couldn’t save the details. Please try again.');
      }
    }

    const banner = justCreated && h('section', { class: 'share-banner' },
      h('div', null, h('strong', null, 'Your event is live.'), ' Send this link to the group and you’re done.'),
      h('div', { class: 'share-row' },
        h('input', { type: 'text', readOnly: true, value: url, 'aria-label': 'Event link', onFocus: (e) => e.target.select() }),
        h('button', { class: 'btn primary', type: 'button', onClick: copyLink }, icon('copy', 16), 'Copy link'),
      ),
    );

    const tzNote = tzDiffers && h('p', { class: 'notice' }, icon('globe', 16),
      `Times are in ${tzCity(ev.tz)} time (${tzAbbr(ev.tz, probe)}). The small grey labels are your local time (${tzAbbr(viewerTz, probe)}).`);

    const who = ev.owner.name.split(/\s+/)[0];
    const lockNote = ev.locked && h('p', { class: 'notice lock-note' }, icon('lock', 16), data.me.isOwner
      ? 'You’ve locked availability: nobody can add, change or remove their days until you unlock it. Day polls and questions can still be answered.'
      : `${who} has locked availability, so days can’t be added or changed now. Day polls and questions can still be answered.`);

    // ---- grid card ----
    const tab = (value, label) => h('button', {
      type: 'button', class: 'seg-btn', role: 'tab', dataset: { value },
      onClick: () => setMode(value),
    }, label);
    const groupTab = tab('group', '');
    const tabs = h('div', { class: 'seg', role: 'tablist' }, tab('mine', 'Your availability'), canSee && groupTab);
    const status = h('div', { class: 'save-status', 'aria-live': 'polite' });
    const detail = h('div', { class: 'detail' });
    const foot = h('div', { class: 'grid-foot' });
    const gridCard = h('section', { class: 'card grid-card' },
      h('div', { class: 'grid-top' }, tabs, status),
      detail,
      h('div', { class: 'grid-scroll' }, grid.el),
      foot,
    );

    // ---- side panels ----
    const best = h('section', { class: 'card panel best' });
    const people = h('section', { class: 'card panel people' });
    const calCard = h('section', { class: 'card panel cal' });
    const mineCard = h('section', { class: 'my-answer' });
    const pollCard = h('section', { class: 'card panel polls' });
    const qCard = h('section', { class: 'card panel qcard' });
    const surveyCard = h('section', { class: 'card panel survey' });
    const savebar = h('div', { class: 'savebar', hidden: true });

    const page = h('div', { class: `event${simple ? ' simple' : ''}` },
        head, banner, prefNote, tzNote, lockNote,
        h('div', { class: 'ev-body' }, h('div', { class: 'main-col' }, mineCard, gridCard, pollCard, qCard, surveyCard), h('aside', { class: 'side' }, calCard, best, people)));
    root.replaceChildren(page, savebar);

    // ---- painting ----
    attachPaint(grid.el, {
      get: (i) => mine[i] === 1,
      set: (i, on) => {
        mine[i] = on ? 1 : 0;
        grid.cells[i].classList.toggle('on', on);
      },
      region: grid.region,
      neighbor: grid.neighbor,
      enabled: () => mode === 'mine' && !ev.locked,
      onCommit: changed,
      onActivate: (i) => showDetail(i),
    });

    const bulk = (indexes) => {
      if (mode !== 'mine' || ev.locked) return;
      const allOn = indexes.every((i) => mine[i]);
      indexes.forEach((i) => { mine[i] = allOn ? 0 : 1; });
      refreshCells();
      changed();
    };
    grid.dayHeads.forEach((el, d) => el.addEventListener('click', () => bulk(Array.from({ length: per }, (_, s) => d * per + s))));
    grid.timeHeads.forEach((el, s) => el.addEventListener('click', () => bulk(ev.dates.map((_, d) => d * per + s))));

    if (!isTouch()) {
      grid.el.addEventListener('pointermove', (e) => {
        const cell = e.target.closest?.('[data-i]');
        if (cell) showDetail(Number(cell.dataset.i));
      });
      grid.el.addEventListener('pointerleave', () => showDetail(null));
    }

    // ---- rendering ----
    function setMode(next) {
      if (mode === next) return;
      mode = next;
      focusRid = hoverRid = null;
      highlight = new Set();
      refreshAll();
      if (next === 'group') refresh();
    }

    function refreshCells() {
      const rs = data.responses;
      const total = rs.length;
      const counts = canSee ? tally(ev, rs) : null;
      const rid = hoverRid ?? focusRid;
      const person = mode === 'group' && rid ? rs.find((r) => r.rid === rid) : null;
      const c = mode === 'mine' ? calc() : null;
      grid.el.dataset.mode = person ? 'person' : mode;

      for (let i = 0; i < n; i++) {
        const cell = grid.cells[i];
        const on = mode === 'mine' ? mine[i] === 1 : person ? person.slots[i] === '1' : false;
        const heat = mode === 'group' && !person;
        cell.classList.toggle('on', on);
        cell.classList.toggle('busy', !!c?.blocked[i]);
        cell.classList.toggle('full', heat && total > 0 && counts[i] === total);
        cell.classList.toggle('none', heat && counts[i] === 0);
        cell.classList.toggle('hl', highlight.has(i));
        if (heat && total > 0 && counts[i] > 0) cell.style.setProperty('--heat', `${Math.round(14 + 86 * (counts[i] / total))}%`);
        else cell.style.removeProperty('--heat');

        let label = slotLabel(i) + (isPref(i) ? ', organizer’s preferred date' : '');
        if (mode === 'mine') label += on ? ', free' : ', not free';
        else if (heat) label += `, ${counts[i]} of ${total} free`;
        cell.setAttribute('aria-label', label);

        // Text inside the cell
        if (!isTimes) {
          const metaEl = cell.querySelector('.meta');
          let text = '';
          if (heat && total > 0) text = `${counts[i]}/${total}`;
          else if (c) {
            const items = c.perCell[i];
            if (cal.mode === 'details') {
              const blocking = items.filter(blocks);
              text = blocking.length ? blocking[0].title : items.length ? plural(items.length, 'event') : '';
            } else if (c.minutes[i] >= 15) {
              text = `${durationLabel(Math.round(c.minutes[i] / 15) * 15)} busy`;
            }
          }
          metaEl.textContent = text;
        } else {
          cell.querySelector('.busy-label')?.remove();
          if (c?.blocked[i] && cal.mode === 'details') {
            const first = c.perCell[i].find(blocks);
            const above = i % per > 0 ? c.perCell[i - 1].find(blocks) : null;
            if (first && first !== above) cell.append(h('span', { class: 'busy-label' }, first.title));
          }
        }
      }
    }

    function showDetail(i) {
      if (i == null) {
        const hint = mode === 'mine' && ev.locked ? 'Availability is locked, so this shows what was saved.'
          : mode === 'mine'
          ? (isTouch()
            ? 'Tap to mark when you’re free. Press and hold, then drag, to paint a range.'
            : 'Click and drag over the times you’re free. It saves as you go.')
          : (isTouch() ? 'Tap a slot to see who’s free.' : 'Hover a slot to see who’s free. Darker means more people.');
        detail.replaceChildren(h('span', { class: 'muted' }, isTimes ? hint : hint.replace(/times you’re/, 'days you’re').replace(/a slot/g, 'a day')));
        return;
      }
      const label = h('span', { class: 'detail-label' }, h('strong', null, slotLabel(i)), isPref(i) && prefChip());
      if (mode === 'mine') {
        const c = calc();
        const items = c?.perCell[i] || [];
        if (!items.length) return detail.replaceChildren(label, h('span', { class: 'muted' }, mine[i] ? 'You’re free' : 'Not marked'));
        const text = cal.mode === 'details'
          ? `On your calendar: ${items.map((it) => `${it.title} (${itemTime(it)})`).join(', ')}`
          : isTimes ? 'Your calendar shows you as busy' : `Busy for ${durationLabel(Math.round(c.minutes[i] / 15) * 15)}`;
        return detail.replaceChildren(label, h('span', { class: 'busy-text' }, text));
      }
      const rs = data.responses;
      if (!rs.length) return detail.replaceChildren(label, h('span', { class: 'muted' }, 'No responses yet'));
      const { free, missing } = split(rs, i);
      detail.replaceChildren(label,
        h('span', { class: 'count-chip' }, `${free.length} of ${rs.length} free`),
        h('span', { class: 'muted' }, missing.length === 0 ? 'Everyone can make it'
          : free.length === 0 ? 'Nobody can make it'
            : `Can’t: ${nameList(missing.map((p) => rs[p].name), 6)}`),
      );
    }

    function refreshStatus() {
      const state = saveState === 'idle' && myResponse() && !dirty ? 'saved' : saveState;
      const content = {
        idle: [],
        saving: [h('span', { class: 'dot pulse' }), 'Saving…'],
        saved: [icon('check', 15), 'Saved'],
        error: ['Couldn’t save', h('button', { class: 'link', type: 'button', onClick: save }, 'Retry')],
        'needs-auth': ['Not saved yet'],
      }[state];
      status.replaceChildren(...content);
      status.dataset.state = state;

      const need = saveState === 'needs-auth';
      savebar.hidden = !need;
      if (need && !savebar.firstChild) {
        savebar.append(
          h('span', null, h('strong', null, 'Looks good.'), ' One step left to save it.'),
          h('button', { class: 'btn primary', type: 'button', onClick: askIdentity },
            data.event.allowGuests ? 'Save my answer' : 'Sign in to save'),
        );
      }
    }

    function refreshFoot() {
      const any = mine.some(Boolean);
      const mineResp = myResponse();
      const c = mode === 'mine' ? calc() : null;
      const legend = mode === 'mine'
        ? h('div', { class: 'legend' },
          h('span', null, h('i', { class: 'sw sw-on' }), 'Free'),
          h('span', null, h('i', { class: 'sw' }), 'Not free'),
          c && h('span', null, h('i', { class: 'sw sw-busy' }), 'On your calendar'),
          prefSet.size > 0 && h('span', null, h('i', { class: 'sw sw-pref' }, '★'), 'Organizer’s preferred'))
        : h('div', { class: 'legend' },
          h('span', null, '0'), h('i', { class: 'ramp' }), h('span', null, `${data.responses.length} free`),
          data.responses.length > 0 && h('span', null, h('i', { class: 'sw sw-full' }), 'Everyone'),
          prefSet.size > 0 && h('span', null, h('i', { class: 'sw sw-pref' }, '★'), 'Organizer’s preferred'));

      const actions = h('div', { class: 'foot-actions' });
      if (mode === 'mine' && !ev.locked) {
        if (any) {
          actions.append(h('button', {
            class: 'link', type: 'button',
            onClick: () => {
              const before = mine.slice();
              mine.fill(0);
              refreshCells();
              changed();
              toast('Cleared', { action: 'Undo', onAction: () => { mine.set(before); refreshCells(); changed(); } });
            },
          }, 'Clear'));
        } else if (!mineResp) {
          actions.append(h('button', { class: 'link', type: 'button', title: 'Lets the group know you looked and can’t make any of these', onClick: changed },
            isTimes ? 'None of these work for me' : 'I can’t make any of these days'));
        }
        if (mineResp) {
          actions.append(h('button', {
            class: 'link danger', type: 'button',
            onClick: async () => {
              try {
                await api(`/events/${id}/response`, { method: 'DELETE', guestToken: session.user ? undefined : guest?.token });
                dirty = false;
                saveState = 'idle';
                toast('Your answer was removed');
                load();
              } catch (e) {
                reportApiError(e);
              }
            },
          }, 'Remove my answer'));
        }
      }
      foot.replaceChildren(legend, actions);
    }

    function refreshTabs() {
      const count = canSee ? data.responses.length : data.respondentCount;
      groupTab.replaceChildren('Everyone', h('span', { class: 'badge' }, count));
      for (const b of tabs.children) {
        const on = b.dataset.value === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }

    // ---- best options ----
    function refreshBest() {
      const rs = data.responses;
      const title = h('h2', null, icon('spark', 18), isTimes ? 'Best times' : 'Best days');
      if (!canSee) {
        return best.replaceChildren(title, h('p', { class: 'muted' },
          `Only the organizer can see everyone’s answers. ${plural(data.respondentCount, 'person has', 'people have')} responded so far.`));
      }
      if (!rs.length) {
        return best.replaceChildren(title, h('p', { class: 'muted' },
          'No answers yet. As people respond, the best options and who can’t make each one show up here.'));
      }

      let headExtra = null;
      let options;
      if (isTimes) {
        const lengths = [...new Set([ev.slotMin, 60, 90, 120, 180, 240])]
          .filter((m) => m >= ev.slotMin && m % ev.slotMin === 0 && m <= ev.endMin - ev.startMin);
        const sel = h('select', {
          class: 'mini', 'aria-label': 'Minimum length',
          onChange: () => { minSlots = Number(sel.value); refreshBest(); },
        }, lengths.map((m, k) => h('option', { value: m / ev.slotMin }, k === 0 ? 'Any length' : `${durationLabel(m)} or more`)));
        sel.value = minSlots;
        headExtra = sel;
        options = rankWindows(ev, rs, { minSlots });
      } else {
        // A preferred date is always listed, so it's clear how it's doing even when it isn't winning.
        const ranked = rankDays(ev, rs).filter((o) => o.count > 0 || o.preferred);
        options = showAllDays ? ranked : ranked.filter((o, k) => k < 5 || o.preferred);
        if (ranked.length > 5) {
          headExtra = h('button', { class: 'link', type: 'button', onClick: () => { showAllDays = !showAllDays; refreshBest(); } },
            showAllDays ? 'Show top 5' : `Show all ${ranked.length}`);
        }
      }

      const list = h('ol', { class: 'options' }, options.map((o, k) => {
        const everyone = o.missing.length === 0;
        const when = isTimes
          ? [h('span', { class: 'opt-date' }, h('strong', null, fmtDate(o.date)), o.preferred && prefChip()),
            h('span', { class: 'opt-time' }, `${fmtRange(ev.startMin + o.s0 * ev.slotMin, ev.startMin + o.s1 * ev.slotMin, { hour12 })} · ${durationLabel((o.s1 - o.s0) * ev.slotMin)}`)]
          : [h('span', { class: 'opt-date' }, h('strong', null, fmtDate(o.date, { weekday: 'long', month: 'short', day: 'numeric' })), o.preferred && prefChip())];
        const li = h('li', { class: `option${everyone ? ' everyone' : ''}${k === 0 ? ' top' : ''}`, tabIndex: 0 },
          h('span', { class: 'frac' }, h('b', null, o.count), `/${rs.length}`),
          h('div', { class: 'opt-main' }, ...when,
            h('span', { class: `who${everyone ? ' ok' : ''}` },
              everyone ? 'Everyone can make it' : `Can’t make it: ${nameList(o.missing.map((p) => rs[p].name), 8)}`)),
        );
        const cells = optionSlots(ev, o);
        const on = () => { highlight = new Set(cells); refreshCells(); };
        const off = () => { highlight = new Set(); refreshCells(); };
        li.addEventListener('pointerenter', on);
        li.addEventListener('pointerleave', off);
        li.addEventListener('focus', on);
        li.addEventListener('blur', off);
        li.addEventListener('click', () => {
          if (mode !== 'group') setMode('group');
          highlight = new Set(cells);
          refreshCells();
          grid.cells[cells[0]].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          showDetail(cells[0]);
        });
        return li;
      }));

      const body = options.length ? list
        : h('p', { class: 'muted' }, isTimes ? 'No window that long works for anyone yet.' : 'Nobody has marked a day as free yet.');
      best.replaceChildren(h('div', { class: 'panel-head' }, title, headExtra), body);
    }

    // ---- people ----
    function refreshPeople() {
      const rs = data.responses;
      const title = h('h2', null, icon('users', 18), 'Responses', h('span', { class: 'badge' }, canSee ? rs.length : data.respondentCount));
      if (!canSee || !rs.length) {
        people.hidden = true;
        return;
      }
      people.hidden = false;
      const list = h('ul', { class: 'people-list' }, rs.map((r) => {
        const freeN = [...r.slots].filter((ch) => ch === '1').length;
        const sub = freeN === 0 ? 'Can’t make any'
          : isTimes ? `Free for ${durationLabel(freeN * ev.slotMin)}`
            : `Free ${freeN} of ${ev.dates.length} ${ev.dates.length === 1 ? 'day' : 'days'}`;
        const li = h('li', null, h('button', {
          type: 'button', class: `person${focusRid === r.rid ? ' on' : ''}${freeN === 0 ? ' cant' : ''}`,
          'aria-pressed': focusRid === r.rid ? 'true' : 'false',
          title: `Show only ${r.name}’s availability`,
          onClick: () => {
            focusRid = focusRid === r.rid ? null : r.rid;
            hoverRid = null;
            if (mode !== 'group') return setMode2Group();
            refreshCells();
            refreshPeople();
          },
        },
          avatar(r, 30),
          h('span', { class: 'p-text' },
            h('span', { class: 'p-name' }, r.name, r.mine && h('em', null, ' (you)'), r.guest && h('em', null, ' · guest')),
            h('span', { class: 'p-sub' }, r.email && data.me.isOwner && !r.mine ? `${sub} · ${r.email}` : sub)),
        ));
        if (!isTouch()) {
          li.addEventListener('pointerenter', () => { if (mode === 'group') { hoverRid = r.rid; refreshCells(); } });
          li.addEventListener('pointerleave', () => { if (hoverRid) { hoverRid = null; refreshCells(); } });
        }
        return li;
      }));
      people.replaceChildren(title, list);
    }
    function setMode2Group() {
      const keep = focusRid;
      mode = 'group';
      hoverRid = null;
      highlight = new Set();
      focusRid = keep;
      refreshAll();
    }

    // ---- calendar ----
    async function connect(kind, sample = false) {
      try {
        let token = null, items;
        if (sample) {
          items = sampleCalendar(ev, kind);
        } else {
          token = await requestCalendarToken(kind);
          items = kind === 'busy' ? await fetchBusy(token, ev) : await fetchEvents(token, ev);
        }
        if (!alive) return;
        if (cal?.token) revokeCalendarToken(cal.token);
        cal = { mode: kind, token, items, override: new Map(), sample };
        calCache = null;
        if (mode !== 'mine') mode = 'mine';
        refreshAll();
      } catch (e) {
        const msg = {
          popup_closed: 'Calendar connection cancelled.',
          popup_failed_to_open: 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
          access_denied: 'Calendar access wasn’t granted. Nothing was shared.',
          scope_not_granted: 'Calendar access wasn’t granted. Nothing was shared.',
          calendar_403: 'Google refused calendar access for this account. Your organization may restrict it.',
        }[e.message] || 'Couldn’t read your calendar. Please try again.';
        toast(msg);
      }
    }
    function disconnect() {
      if (cal?.token) revokeCalendarToken(cal.token);
      cal = null;
      calCache = null;
      refreshAll();
    }

    function refreshCal() {
      const dev = session.config.devLogin;
      calCard.hidden = mode !== 'mine' || (!calendarAvailable() && !dev);
      if (calCard.hidden) return;
      const title = h('h2', null, icon('calendar', 18), 'Check your calendar');

      if (!cal) {
        const choice = (kind, label, sub) => h('button', { class: 'choice', type: 'button', onClick: () => connect(kind, !calendarAvailable()) },
          h('strong', null, label), h('small', null, sub));
        return calCard.replaceChildren(...[title,
          h('p', { class: 'muted' }, 'Optional. See your Google Calendar drawn over the grid while you pick. Nothing is filled in for you.'),
          h('div', { class: 'choices' },
            choice('busy', 'Busy blocks only', 'Google shares when you’re busy. No event names.'),
            choice('details', 'Event names too', 'So you can tell which conflicts are movable.')),
          dev && calendarAvailable() && h('button', { class: 'link', type: 'button', onClick: () => connect('details', true) }, 'Use sample calendar (dev)'),
          !calendarAvailable() && h('p', { class: 'setup-note' }, 'Dev mode: no Google client ID set, so these load a sample calendar.'),
          h('p', { class: 'fine' }, icon('shield', 15), 'Read by your browser, straight from Google. It never reaches our server and is gone when you close this tab.'),
        ].filter(Boolean));
      }

      const c = calc();
      const shown = [...new Set(c.perCell.flat())].sort((a, b) => a.start - b.start);
      const kids = [title,
        h('p', { class: 'cal-state' },
          h('span', { class: 'live-dot' }), cal.mode === 'busy' ? 'Showing busy blocks' : 'Showing your events',
          cal.sample && h('span', { class: 'dev-tag' }, 'sample'),
          h('button', { class: 'link', type: 'button', onClick: disconnect }, 'Disconnect'))];

      if (!shown.length) {
        kids.push(h('p', { class: 'muted' }, isTimes ? 'Nothing on your calendar overlaps these times.' : 'Nothing on your calendar on these days.'));
      } else if (cal.mode === 'details') {
        kids.push(h('p', { class: 'muted small' }, isTimes
          ? 'Ticked events count as busy. Untick anything you could move or skip.'
          : 'Only out-of-office and all-day events are ticked: regular meetings usually still happen at an on-site. Tick anything that really takes you out for the day.'));
        let lastDay = '';
        const list = h('ul', { class: 'cal-list' });
        for (const it of shown) {
          const day = utcToZoned(Math.max(it.start, ranges.starts[0]), ev.tz).date;
          if (day !== lastDay) {
            lastDay = day;
            list.append(h('li', { class: 'cal-day' }, fmtDate(day)));
          }
          const box = h('input', {
            type: 'checkbox', checked: blocks(it),
            onChange: () => { cal.override.set(it.id, box.checked); calCache = null; refreshCells(); refreshFoot(); },
          });
          list.append(h('li', null, h('label', { class: 'cal-item' }, box,
            h('span', { class: 'ci-time' }, itemTime(it)),
            h('span', { class: 'ci-title' }, it.title, it.free && h('em', null, ' · marked free')))));
        }
        kids.push(list);
      } else if (!isTimes) {
        kids.push(h('p', { class: 'muted small' }, 'Each day shows how long you’re busy. For a whole-day event, you decide what counts as a conflict.'));
      }

      if ((isTimes || cal.mode === 'details') && !ev.locked) {
        kids.push(h('button', {
          class: 'btn', type: 'button',
          onClick: () => {
            const before = mine.slice();
            const blocked = calc().blocked;
            for (let i = 0; i < n; i++) mine[i] = blocked[i] ? 0 : 1;
            refreshCells();
            changed();
            toast('Marked you free around your calendar', { action: 'Undo', onAction: () => { mine.set(before); refreshCells(); changed(); } });
          },
        }, icon('spark', 16), isTimes ? 'Mark me free around these' : 'Mark me free except ticked days'));
      }
      calCard.replaceChildren(...kids);
    }

    // ---- follow-up questionnaire ----
    function refreshQuestionnaire() {
      const qs = ev.questions;
      qCard.hidden = qs.length === 0;
      if (!qs.length) return;
      const locked = !myResponse();
      if (qWasLocked === true && !locked) {
        toast(`Saved. ${plural(qs.length, 'quick question')} below, if you have a minute.`, {
          action: 'Show', onAction: () => { showEverything(); qCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        });
      }
      qWasLocked = locked;
      const key = JSON.stringify([qs, locked, ev.anonAnswers]);
      if (key === qKey) return; // don't rebuild under someone who is typing
      qKey = key;
      const heading = data.me.isOwner
        ? `Your ${plural(qs.length, 'follow-up question')}`
        : `${plural(qs.length, 'quick question')} from ${ev.owner.name.split(/\s+/)[0]}`;
      qCard.replaceChildren(
        h('h2', null, icon('chat', 18), heading),
        h('p', { class: 'fine' }, icon(ev.anonAnswers ? 'eyeOff' : 'users', 15), ev.anonAnswers
          ? 'Optional and anonymous: the organizer sees totals and comments, not who said what, and only in batches of several people.'
          : `Optional. ${data.me.isOwner ? 'You' : ev.owner.name} will see answers with names attached.`),
        ...(locked ? [h('p', { class: 'q-locked' }, icon('lock', 15),
          ev.locked ? 'Availability is locked, so these are only open to people who had already answered.'
            : isTimes ? 'Mark your times above first (or say none work), then these unlock.' : 'Mark your days above first (or say you can’t make any), then these unlock.')] : []),
        buildQuestionnaire({
          questions: qs, answers, locked, onChange: changed,
          reword: session.config.aiReword
            ? (text) => api(`/events/${id}/reword`, { method: 'POST', body: { text }, guestToken: session.user ? undefined : guest?.token })
            : null,
        }),
      );
    }

    async function editQuestions() {
      const sv = data.survey;
      const answered = (sv?.answered ?? 0) + (sv?.waiting?.answers ?? 0) + (sv?.waiting?.pins ?? 0);
      const res = await openQuestionBuilder({
        questions: ev.questions, anonAnswers: ev.anonAnswers, answered,
        anonLocked: ev.anonAnswers && answered > 0,
      });
      if (!res) return;
      try {
        await api(`/events/${id}/questions`, { method: 'PUT', body: res });
        toast(res.questions.length ? 'Questions saved' : 'Questions removed');
        load({ keepDraft: true });
      } catch (e) {
        const code = e instanceof ApiError ? e.code : '';
        toast(code === 'anon_locked' ? 'People already answered anonymously, so names can’t be switched on now.'
          : code === 'invalid' ? 'One of those questions isn’t valid. Check for blank choices and try again.'
            : 'Couldn’t save the questions. Please try again.');
      }
    }

    function refreshSurvey() {
      surveyCard.hidden = !data.me.isOwner;
      if (surveyCard.hidden) return;
      const qs = ev.questions;
      const survey = data.survey;
      const key = JSON.stringify([qs, survey, ev.anonAnswers]);
      if (key === sKey) return; // nothing new: leave the charts and map alone
      sKey = key;
      const edit = h('button', { class: 'btn small', type: 'button', onClick: editQuestions },
        icon(qs.length ? 'pencil' : 'plus', 15), qs.length ? 'Edit questions' : 'Add questions');
      if (!qs.length || !survey) {
        return surveyCard.replaceChildren(
          h('div', { class: 'panel-head' }, h('h2', null, icon('chat', 18), 'Follow-up questions'), edit),
          h('p', { class: 'muted' }, 'Ask a few questions once people have picked their days: what would make them more likely to come, what to change next time. Only you see the answers.'));
      }
      const canCopy = !survey.hidden && Object.values(survey.questions).some((r) => r.n > 0 && !r.hidden);
      surveyCard.replaceChildren(
        h('div', { class: 'panel-head' },
          h('h2', null, icon('chat', 18), 'Answers', h('span', { class: 'badge' }, survey.answered)),
          h('div', { class: 'head-actions' },
            canCopy && h('button', {
              class: 'btn small', type: 'button',
              onClick: async () => toast((await copyText(surveyText({ title: ev.title, questions: qs, survey, anon: ev.anonAnswers }))) ? 'Summary copied' : 'Couldn’t copy the summary'),
            }, icon('copy', 15), 'Copy summary'),
            edit)),
        h('p', { class: 'fine' }, icon(ev.anonAnswers ? 'eyeOff' : 'users', 15),
          `Only you can see this. ${ev.anonAnswers ? 'Answers are anonymous and arrive in batches.' : 'Answers are shown with names.'}`),
        buildSurveyResults({ questions: qs, survey, anon: ev.anonAnswers }),
      );
    }

    // ---- day polls ----
    const dayFree = (slots, d) => !!slots && slots.slice(d * per, (d + 1) * per).includes('1');
    const guestToken = () => (session.user ? undefined : guest?.token);

    async function addPoll() {
      const counts = ev.dates.map((_, d) => data.responses.filter((r) => dayFree(r.slots, d)).length);
      // Start on the day most people can make (a preferred day wins a tie), since that's the one being planned.
      const lead = ev.dates.map((date, d) => ({ date, n: counts[d], pref: prefSet.has(date) }))
        .sort((a, b) => b.n - a.n || b.pref - a.pref)[0];
      const res = await openPollBuilder({ dates: ev.dates, freeCount: canSee ? counts : null, defaultDay: lead?.date, extras: !!session.user?.extras });
      if (!res) return;
      try {
        const { poll } = await api(`/events/${id}/polls`, { method: 'POST', body: res });
        const link = `${url}/p/${poll.id}`;
        toast('Poll added', { action: 'Copy link', onAction: async () => toast((await copyText(link)) ? 'Poll link copied' : 'Couldn’t copy the link') });
        await refresh({ force: true });
      } catch (e) {
        reportApiError(e, 'Couldn’t add the poll. Please try again.');
      }
    }

    // A ranking is built one tap at a time, so it is sent once the taps pause.
    const rankTimers = new Map();
    function votePoll(poll, value) {
      saveStatus('saving');
      if (poll.kind !== 'rank') return sendVote(poll, { choice: value });
      clearTimeout(rankTimers.get(poll.id));
      rankTimers.set(poll.id, setTimeout(() => sendVote(poll, { ranking: value }), 700));
    }

    async function sendVote(poll, body) {
      try {
        await api(`/events/${id}/polls/${poll.id}/vote`, { method: 'PUT', body, guestToken: guestToken() });
        saveStatus('saved');
        await refresh({ force: true });
      } catch (e) {
        saveStatus(null);
        if (e instanceof ApiError && e.code === 'not_available') {
          toast(`That poll is for people who can make ${longDay(poll.day)}.`);
          return load({ keepDraft: true });
        }
        reportApiError(e, 'Couldn’t save your answer. Please try again.');
      }
    }

    /** "I can make that day after all": for whole-day events one press does it; for timed ones they pick the times. */
    function addDay(d) {
      if (isTimes) showEverything();
      if (mode !== 'mine') setMode('mine');
      const cells = Array.from({ length: per }, (_, k) => d * per + k);
      if (!isTimes) {
        mine[d] = 1;
        refreshCells();
        changed();
        if (identity()) toast(`Added ${longDay(ev.dates[d])} to your days`);
        return;
      }
      highlight = new Set(cells);
      refreshCells();
      requestAnimationFrame(() => grid.cells[cells[0]].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }));
      toast(`Mark the times you’re free on ${longDay(ev.dates[d])}. The poll opens up once that’s saved.`, { ms: 7000 });
    }

    /** Leave the polls-only view: bring back the calendar, the group's answers and the questions. */
    function showEverything() {
      if (!simple) return;
      simple = false;
      page.classList.remove('simple');
      mode = 'mine';
      refreshAll();
    }

    // The one line of context the polls-only view keeps: what this person said, and the way back to it.
    function refreshMine() {
      mineCard.hidden = !simple;
      if (!simple) return;
      const me = myResponse();
      const days = me ? ev.dates.filter((_, d) => dayFree(me.slots, d)) : [];
      const text = !me ? 'You haven’t given your availability for this event yet.'
        : days.length === 0 ? (isTimes ? 'You said none of these times work for you.' : 'You said you can’t make any of these days.')
          : `You’re free ${nameList(days.map((d) => fmtDate(d)), 4)}.`;
      const label = ev.locked ? (me ? 'See my response' : 'See the event') : me ? 'Change my response' : 'Give my availability';
      mineCard.replaceChildren(
        h('span', null, icon(me ? 'check' : 'calendar', 16), text),
        h('button', {
          class: 'btn small', type: 'button',
          onClick: () => { showEverything(); gridCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        }, label));
    }

    function refreshPolls() {
      const polls = data.polls || [];
      const owner = data.me.isOwner;
      pollCard.hidden = polls.length === 0 && !owner;
      if (pollCard.hidden) return;
      const me = myResponse();
      const key = JSON.stringify([polls, me?.slots, !!identity(), pollJump]);
      if (key === pKey) return;
      pKey = key;

      const add = owner && h('button', { class: 'btn small', type: 'button', onClick: addPoll }, icon('plus', 15), 'Add a poll');
      const headRow = h('div', { class: 'panel-head' },
        h('h2', null, icon('check', 18), 'Day polls', polls.length > 0 && h('span', { class: 'badge' }, polls.length)), add);
      if (!polls.length) {
        return pollCard.replaceChildren(headRow, h('p', { class: 'muted' },
          'Once a day is looking likely, ask the people who can make it a quick either-or: co-work day or not, drinks and dinner or not. Each poll gets its own link.',
          !ev.locked && ' Lock availability first if you want that group to stay put while you ask.'));
      }
      pollCard.replaceChildren(
        headRow,
        h('p', { class: 'fine' }, icon(canSee ? 'users' : 'eyeOff', 15), canSee
          ? `Each one is for the people free that day. Answers are shown with names${ev.hideResults ? ', to you only' : ''}.`
          : `Each one is for the people free that day. Only ${who} sees the answers, with your name.`),
        h('div', { class: 'poll-list' }, polls.map((p) => {
          const d = ev.dates.indexOf(p.day);
          const link = `${url}/p/${p.id}`;
          return buildPoll(p, {
            free: dayFree(me?.slots, d),
            answered: !!me,
            isOwner: owner,
            focused: p.id === pollId,
            gate: {
              locked: ev.locked, ownerName: who,
              addLabel: isTimes ? `Add my times for ${fmtDate(p.day)}` : `I can make ${fmtDate(p.day)}`,
              onAdd: () => addDay(d),
            },
            onVote: (choice) => votePoll(p, choice),
            onCopy: async () => toast((await copyText(link)) ? 'Poll link copied' : 'Couldn’t copy the link'),
            onDelete: async () => {
              const ok = await confirmDialog({ title: 'Delete this poll?', text: `“${p.prompt}” and its answers will be removed. This can’t be undone.`, confirm: 'Delete poll', danger: true });
              if (!ok) return;
              try {
                await api(`/events/${id}/polls/${p.id}`, { method: 'DELETE' });
                await refresh({ force: true });
              } catch (e) {
                reportApiError(e);
              }
            },
          });
        })),
      );

      // Arrived by a poll's own link: bring that poll into view, once.
      if (pollJump) {
        const target = pollCard.querySelector(`[data-poll="${pollJump}"]`);
        pollJump = null;
        if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
        else toast('That poll isn’t here any more. The rest of the event is below.');
      }
    }

    function refreshAll() {
      refreshTabs();
      refreshCells();
      refreshStatus();
      refreshFoot();
      refreshBest();
      refreshPeople();
      refreshCal();
      refreshMine();
      refreshPolls();
      refreshQuestionnaire();
      refreshSurvey();
      showDetail(null);
    }

    ui = { refreshAll, refreshStatus, refreshFoot };
    if (!identity() && dirty) saveState = 'needs-auth';
    refreshAll();
  }

  // --------------------------------------------------------------- lifecycle

  const offSession = onSession((user) => {
    if (!alive) return;
    if (!user) {
      dirty = false;
      saveState = 'idle';
    }
    load({ keepDraft: !!user });
  });
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => { if (!dirty && saveState !== 'saving') refresh(); }, REFRESH_MS);

  root.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'dot pulse' }), 'Loading…'));
  load();

  return () => {
    alive = false;
    offSession();
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
    clearTimeout(saveTimer);
    saveStatus(null);
    cal = null; // the calendar token only ever lived in this closure
  };
}
