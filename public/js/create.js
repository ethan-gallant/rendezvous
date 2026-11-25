// Home page: the create-event form, plus a list of your events when signed in.

import { api, ApiError } from './api.js';
import { session, onSession, requireUser, reportApiError } from './auth.js';
import { navigate } from './router.js';
import { h, icon, toast, plural } from './ui.js';
import { openQuestionBuilder } from './questions.js';
import { attachPaint, buildMonth } from './grid.js';
import { addDays, epochDay, fromEpochDay, fmtDate, fmtDateSpan, fmtTime, localTz, prefers12h, todayIn, tzCity, weekday } from './lib/time.js';

const DRAFT_KEY = 'rdv-draft';

function loadDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (d && Array.isArray(d.dates)) return d;
  } catch { /* no draft */ }
  return null;
}

export function renderCreate(root) {
  const tz0 = localTz();
  const today = todayIn(tz0);
  const hour12 = prefers12h();
  const draft = loadDraft();
  const form = {
    title: '', kind: 'days', startMin: 540, endMin: 1020, slotMin: 30, tz: tz0,
    limitDomain: false, domain: session.user?.hd || '', allowGuests: false, hideResults: false,
    questions: [], anonAnswers: true, note: '', preferred: [],
    ...draft,
    dates: new Set((draft?.dates || []).filter((d) => d >= today).map(epochDay)),
  };
  let viewMonth = (form.dates.size ? fromEpochDay(Math.min(...form.dates)) : today).slice(0, 7);

  const persist = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...form, dates: [...form.dates].map(fromEpochDay) }));
    } catch { /* storage unavailable */ }
  };

  // ---------- title ----------
  const title = h('input', {
    class: 'title-input', type: 'text', maxLength: 120, value: form.title,
    placeholder: 'What are you planning?', 'aria-label': 'Event name', autocomplete: 'off',
    onInput: () => { form.title = title.value; persist(); refreshSubmit(); },
  });

  // ---------- kind ----------
  const kindBtn = (value, label, sub) => h('button', {
    type: 'button', class: 'seg-btn', role: 'radio', dataset: { value },
    onClick: () => { form.kind = value; persist(); refreshKind(); },
  }, h('strong', null, label), h('small', null, sub));
  const kindSeg = h('div', { class: 'seg seg-big', role: 'radiogroup', 'aria-label': 'What are people choosing?' },
    kindBtn('days', 'Whole days', 'On-sites, trips, launches'),
    kindBtn('times', 'Times of day', 'Meetings, calls, interviews'),
  );

  // ---------- dates ----------
  const months = h('div', { class: 'months' });
  const summary = h('p', { class: 'date-summary muted' });
  const shiftMonth = (n) => {
    const [y, m] = viewMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    viewMonth = d.toISOString().slice(0, 7);
    renderMonths();
  };
  const prevBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onClick: () => shiftMonth(-1) }, icon('chevL'));
  const nextBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onClick: () => shiftMonth(1) }, icon('chevR'));

  function renderMonths() {
    const [y, m] = viewMonth.split('-').map(Number);
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    months.replaceChildren(
      buildMonth(viewMonth, { min: today, isOn: (d) => form.dates.has(d) }),
      buildMonth(next, { min: today, isOn: (d) => form.dates.has(d) }),
    );
    const first = months.querySelector('[data-i]');
    if (first) first.tabIndex = 0;
    prevBtn.disabled = viewMonth <= today.slice(0, 7);
  }
  // ---------- preferred days & note ----------
  if (!Array.isArray(form.preferred)) form.preferred = [];
  const note = h('input', {
    type: 'text', class: 'note-input', maxLength: 500, value: form.note || '',
    placeholder: 'Add a note people will see (optional)', 'aria-label': 'Note for participants', autocomplete: 'off',
    onInput: () => { form.note = note.value; persist(); },
  });
  const prefChips = h('div', { class: 'chips left' });
  const prefBlock = h('div', { class: 'pref-block' },
    h('div', { class: 'pref-label' }, icon('star', 16),
      h('span', null, h('strong', null, 'Is one of these preferred?'), ' Tap a day to star it. People see the star while they answer, and can still pick any day.')),
    prefChips);
  function refreshPreferred() {
    const dates = [...form.dates].sort((a, b) => a - b).map(fromEpochDay);
    form.preferred = form.preferred.filter((d) => dates.includes(d));
    prefBlock.hidden = dates.length < 2;
    prefChips.replaceChildren(...dates.map((d) => {
      const on = form.preferred.includes(d);
      return h('button', {
        type: 'button', class: `chip star${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false',
        onClick: () => {
          form.preferred = on ? form.preferred.filter((x) => x !== d) : [...form.preferred, d];
          persist();
          refreshPreferred();
        },
      }, on ? '★ ' : '', fmtDate(d));
    }));
  }

  function refreshSummary() {
    const dates = [...form.dates].sort((a, b) => a - b).map(fromEpochDay);
    summary.textContent = dates.length
      ? `${plural(dates.length, 'day')} selected · ${fmtDateSpan(dates)}`
      : 'Click or drag across the days you’re considering.';
    summary.classList.toggle('has', dates.length > 0);
    refreshPreferred();
    refreshRetention();
  }
  const minDay = epochDay(today);
  attachPaint(months, {
    get: (d) => form.dates.has(d),
    set: (d, on) => {
      if (on) form.dates.add(d);
      else form.dates.delete(d);
      const cell = months.querySelector(`[data-i="${d}"]`);
      cell?.classList.toggle('on', on);
      cell?.setAttribute('aria-selected', on ? 'true' : 'false');
    },
    region: (a, b) => {
      const out = [];
      for (let d = Math.max(Math.min(a, b), minDay); d <= Math.max(a, b); d++) out.push(d);
      return out;
    },
    neighbor: (d, dir) => {
      const to = d + { left: -1, right: 1, up: -7, down: 7 }[dir];
      return months.querySelector(`[data-i="${to}"]`) ? to : null;
    },
    onCommit: () => {
      if (form.dates.size > 62) {
        toast('That’s a lot of days. Events are limited to 62.');
        [...form.dates].sort((a, b) => a - b).slice(62).forEach((d) => form.dates.delete(d));
        renderMonths();
      }
      persist(); refreshSummary(); refreshSubmit();
    },
  });

  const quick = (label, pick) => h('button', {
    type: 'button', class: 'chip',
    onClick: () => {
      form.dates = new Set(pick().map(epochDay));
      if (form.dates.size) viewMonth = fromEpochDay(Math.min(...form.dates)).slice(0, 7);
      persist(); renderMonths(); refreshSummary(); refreshSubmit();
    },
  }, label);
  const upcoming = (n, filter = () => true) => {
    const out = [];
    for (let k = 1; out.length < n && k < 60; k++) {
      const d = addDays(today, k);
      if (filter(d)) out.push(d);
    }
    return out;
  };
  const isWeekday = (d) => weekday(d) >= 1 && weekday(d) <= 5;
  const quicks = h('div', { class: 'chips' },
    quick('Next 7 days', () => upcoming(7)),
    quick('Next 5 weekdays', () => upcoming(5, isWeekday)),
    quick('Next 10 weekdays', () => upcoming(10, isWeekday)),
    quick('Clear', () => []),
  );

  // ---------- times ----------
  const timeSelect = (key, label) => {
    const sel = h('select', {
      'aria-label': label,
      onChange: () => { form[key] = Number(sel.value); fixTimes(key); persist(); },
    });
    return sel;
  };
  const startSel = timeSelect('startMin', 'Earliest time');
  const endSel = timeSelect('endMin', 'Latest time');
  const slotSel = h('select', {
    'aria-label': 'Slot length',
    onChange: () => { form.slotMin = Number(slotSel.value); fixTimes('slotMin'); persist(); },
  }, [[15, '15 min'], [30, '30 min'], [60, '1 hour']].map(([v, l]) => h('option', { value: v }, l)));

  function fixTimes(changed) {
    const step = form.slotMin === 60 ? 60 : 30;
    form.startMin = Math.floor(form.startMin / step) * step;
    form.endMin = Math.ceil(form.endMin / step) * step;
    if (form.endMin <= form.startMin) {
      if (changed === 'startMin') form.endMin = Math.min(1440, form.startMin + 60);
      else form.startMin = Math.max(0, form.endMin - 60);
    }
    const opts = (from, to) => {
      const out = [];
      for (let m = from; m <= to; m += step) out.push(h('option', { value: m }, m === 1440 ? (hour12 ? '12:00 AM (midnight)' : '24:00') : fmtTime(m, { hour12 })));
      return out;
    };
    startSel.replaceChildren(...opts(0, 1440 - step));
    endSel.replaceChildren(...opts(step, 1440));
    startSel.value = form.startMin;
    endSel.value = form.endMin;
    slotSel.value = form.slotMin;
  }

  let zones;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  if (!zones.includes(form.tz)) zones = [form.tz, ...zones];
  const tzSel = h('select', { 'aria-label': 'Timezone', onChange: () => { form.tz = tzSel.value; persist(); } },
    zones.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  tzSel.value = form.tz;

  const timesRow = h('div', { class: 'times-row' },
    h('label', { class: 'field' }, h('span', null, 'From'), startSel),
    h('label', { class: 'field' }, h('span', null, 'Until'), endSel),
    h('label', { class: 'field' }, h('span', null, 'In blocks of'), slotSel),
    h('label', { class: 'field grow' }, h('span', null, 'Timezone'), tzSel),
  );

  // ---------- options ----------
  const switchRow = (key, iconName, label, sub, onToggle) => {
    const input = h('input', {
      type: 'checkbox', class: 'switch', checked: !!form[key],
      onChange: () => { form[key] = input.checked; persist(); onToggle?.(); },
    });
    const row = h('label', { class: 'opt' }, icon(iconName, 20),
      h('span', { class: 'opt-text' }, h('strong', null, label), h('small', null, sub)), input);
    return { row, input };
  };
  const domainInput = h('input', {
    type: 'text', class: 'domain-input', placeholder: 'yourcompany.com', value: form.domain,
    'aria-label': 'Google Workspace domain', autocapitalize: 'none', autocomplete: 'off', spellcheck: false,
    onInput: () => { form.domain = domainInput.value; persist(); },
  });
  const domainRow = h('div', { class: 'opt-extra' }, h('span', { class: 'at' }, '@'), domainInput);
  const guests = switchRow('allowGuests', 'users', 'Let people answer with just a name',
    'Skips Google sign-in for them. Anyone with the link can respond.');
  const limit = switchRow('limitDomain', 'lock', 'Limit to a Google Workspace domain',
    'Only people signed in with that organization’s accounts can open the link.', () => {
      refreshOptions();
      if (form.limitDomain) domainInput.focus();
    });
  const qSub = h('small');
  const qBtn = h('button', {
    class: 'btn small', type: 'button',
    onClick: async () => {
      const res = await openQuestionBuilder({ questions: form.questions, anonAnswers: form.anonAnswers });
      if (!res) return;
      form.questions = res.questions;
      form.anonAnswers = res.anonAnswers;
      persist();
      refreshQuestions();
    },
  });
  const questionsRow = h('div', { class: 'opt static' }, icon('chat', 20),
    h('span', { class: 'opt-text' }, h('strong', null, 'Ask follow-up questions'), qSub), qBtn);
  function refreshQuestions() {
    const n = form.questions.length;
    qSub.textContent = n
      ? `${plural(n, 'question')} · ${form.anonAnswers ? 'anonymous answers' : 'answers shown with names'}`
      : 'A short questionnaire after people pick their days, like what would make them more likely to come.';
    qBtn.textContent = n ? 'Edit' : 'Add';
  }
  const hide = switchRow('hideResults', 'eyeOff', 'Only I can see responses',
    'Participants see their own answer; you see everyone’s.');
  function refreshOptions() {
    // What the instance allows (wrangler.jsonc → SETTINGS) shapes which options make sense.
    const allowed = session.config.allowedDomains || [];
    siteNote.hidden = allowed.length === 0;
    siteNote.replaceChildren(icon('lock', 15), `Only ${allowed.map((d) => `@${d}`).join(' and ')} accounts can sign in here${session.config.allowGuestResponses ? '' : ', so every event is limited to them'}.`);
    limit.row.hidden = allowed.length === 1; // already limited to that one domain
    if (limit.row.hidden) form.limitDomain = false;
    guests.row.hidden = !session.config.allowGuestResponses;
    if (guests.row.hidden) form.allowGuests = false;

    domainRow.hidden = !form.limitDomain;
    if (form.limitDomain && !form.domain && session.user?.hd) {
      form.domain = session.user.hd;
      domainInput.value = form.domain;
    }
    guests.input.disabled = form.limitDomain;
    guests.row.classList.toggle('disabled', form.limitDomain);
    if (form.limitDomain && form.allowGuests) {
      form.allowGuests = false;
      guests.input.checked = false;
    }
  }

  // ---------- submit ----------
  const submit = h('button', { type: 'submit', class: 'btn primary big' });
  const submitHint = h('p', { class: 'fine center' });
  const siteNote = h('p', { class: 'pill-note', hidden: true });
  // Said up front: how long this event and everything in it will exist.
  const retentionNote = h('p', { class: 'fine center' });
  function refreshRetention() {
    const days = session.config.retentionDays ?? 60;
    const picked = [...form.dates].sort((a, b) => a - b).map(fromEpochDay);
    retentionNote.replaceChildren(icon('trash', 15), picked.length
      ? `The event and all answers are deleted automatically on ${fmtDate(addDays(picked[picked.length - 1], days + 1), { month: 'long', day: 'numeric', year: 'numeric' })}, ${days} days after the last day.`
      : `Events and all their answers are deleted automatically ${days} days after their last day.`);
  }
  function refreshSubmit() {
    const ready = form.title.trim() && form.dates.size > 0;
    submit.textContent = session.user ? 'Create event' : 'Continue with Google';
    submit.classList.toggle('not-ready', !ready);
    submitHint.textContent = session.user
      ? 'You’ll get one link to share. That’s it.'
      : 'Sign in once so the event is yours to manage. You’ll get one link to share.';
  }
  function refreshKind() {
    for (const b of kindSeg.children) {
      const on = b.dataset.value === form.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    timesRow.hidden = form.kind !== 'times';
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast('Give your event a name first.');
      title.focus();
      return;
    }
    if (!form.dates.size) {
      toast('Pick at least one day.');
      months.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const domain = form.domain.trim().toLowerCase().replace(/^@/, '');
    const allowedHere = session.config.allowedDomains || [];
    if (form.limitDomain && allowedHere.length && !allowedHere.includes(domain)) {
      toast(`This site only allows ${allowedHere.map((d) => `@${d}`).join(', ')}. Pick one of those, or turn the limit off.`);
      domainInput.focus();
      return;
    }
    if (form.limitDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      toast('Enter a domain like yourcompany.com, or turn the limit off.');
      domainInput.focus();
      return;
    }
    const user = await requireUser({
      title: 'Sign in to create your event',
      reason: 'So you can come back to it later and manage responses.',
    });
    if (!user) return;
    if (form.limitDomain && domain !== user.hd && !(domain === 'gmail.com' && user.email.endsWith('@gmail.com'))) {
      toast(`Heads up: you’re signed in as ${user.email}, which isn’t @${domain}. You’ll still have access as the organizer.`, { ms: 7000 });
    }
    submit.disabled = true;
    try {
      const { id } = await api('/events', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          kind: form.kind,
          tz: form.tz,
          dates: [...form.dates].sort((a, b) => a - b).map(fromEpochDay),
          ...(form.kind === 'times' ? { startMin: form.startMin, endMin: form.endMin, slotMin: form.slotMin } : {}),
          domains: form.limitDomain ? [domain] : [],
          allowGuests: form.allowGuests,
          hideResults: form.hideResults,
          note: (form.note || '').trim(),
          preferred: form.preferred,
          questions: form.questions,
          anonAnswers: form.anonAnswers,
        },
      });
      sessionStorage.removeItem(DRAFT_KEY);
      navigate(`/e/${id}`, { created: true });
    } catch (err) {
      submit.disabled = false;
      if (err instanceof ApiError && err.code === 'invalid') toast(`Please check the ${err.body.field} and try again.`);
      else reportApiError(err, 'Could not create the event. Please try again.');
    }
  }

  // ---------- your events ----------
  const yours = h('section', { class: 'yours' });
  async function loadYours() {
    yours.replaceChildren();
    if (!session.user) return;
    try {
      const { created, answered } = await api('/my/events');
      const list = (heading, events) => events.length > 0 && h('div', { class: 'yours-group' },
        h('h2', null, heading),
        h('ul', { class: 'event-list' }, events.map((ev) => h('li', null,
          h('a', { href: `/e/${ev.id}`, 'data-link': '' },
            h('span', { class: 'el-title' }, ev.title),
            h('span', { class: 'el-meta muted' },
              `${fmtDateSpan(ev.dates)} · ${ev.kind === 'times' ? 'times' : 'whole days'} · ${plural(ev.responseCount, 'response')}`),
            icon('chevR', 16),
          )))),
      );
      yours.replaceChildren(...[list('Your events', created), list('Events you’ve answered', answered)].filter(Boolean));
    } catch { /* non-essential */ }
  }

  // ---------- assemble ----------
  const step = (n, label, ...kids) => h('div', { class: 'step' },
    h('div', { class: 'step-label' }, h('span', { class: 'step-n' }, n), label), ...kids);

  root.append(
    h('section', { class: 'hero' },
      h('div', { class: 'hero-copy' },
        h('h1', null, 'Find the days that work for ', h('em', null, 'everyone'), '.'),
        h('p', { class: 'lede' }, 'Pick some days, share one link, and see at a glance which options are best and who can’t make each one.'),
      ),
      heroArt(),
    ),
    h('form', { class: 'card create', onSubmit, novalidate: true },
      step(1, 'Name it', title, note),
      step(2, 'What are people choosing?', kindSeg),
      step(3, 'Which days are on the table?',
        h('div', { class: 'cal-nav' }, prevBtn, quicks, nextBtn),
        months, summary, prefBlock, timesRow),
      step(4, 'Options', h('div', { class: 'opts' }, siteNote, limit.row, domainRow, guests.row, hide.row, questionsRow)),
      h('div', { class: 'create-foot' }, submit, submitHint, retentionNote),
    ),
    yours,
  );

  fixTimes();
  refreshKind();
  refreshOptions();
  refreshQuestions();
  renderMonths();
  refreshSummary();
  refreshSubmit();
  loadYours();
  if (!matchMedia('(hover: none)').matches) title.focus({ preventScroll: true });

  const off = onSession(() => {
    refreshSubmit();
    refreshOptions();
    loadYours();
  });
  return off;
}

/** Decorative mini heat-map for the hero. Purely visual. */
function heroArt() {
  const rows = [
    [0, 1, 2, 1, 0], [1, 2, 3, 2, 0], [1, 3, 4, 3, 1], [2, 4, 4, 3, 1], [1, 3, 4, 2, 0], [0, 1, 2, 1, 0],
  ];
  const art = h('div', { class: 'hero-art', 'aria-hidden': 'true' });
  rows.forEach((row, r) => row.forEach((v, c) => {
    const cell = h('span', { class: `ha ha-${v}` });
    cell.style.animationDelay = `${(r + c) * 45}ms`;
    art.append(cell);
  }));
  return art;
}

export function renderPrivacy(root) {
  const item = (iconName, head, text) => h('li', null, icon(iconName, 22), h('div', null, h('strong', null, head), h('p', null, text)));
  root.append(h('article', { class: 'card prose' },
    h('h1', null, 'What Rendezvous knows about you'),
    h('ul', { class: 'privacy-list' },
      item('users', 'Your Google profile', 'When you sign in we receive your name, email address, profile photo and, for work accounts, your organization’s domain. Other participants see your name and photo; only the organizer sees your email. Sign-ins last a day at most before Google is asked again.'),
      item('check', 'The availability you paint', 'The days or times you mark as free are saved so the group can see them. You can remove your answer at any time.'),
      item('chat', 'Answers to follow-up questions', 'Always optional, and they go to the organizer only. Each questionnaire says up front whether it is anonymous. When it is: your answers are stored in a separate table with no name, email, account or timestamp; the organizer sees totals and comments only in batches of several people, so your answers never arrive on their own; and the organizer is not told when anyone answered. The organizer can see who has not answered yet, also only updated in batches.'),
      item('check', 'Answers to day polls', 'An organizer can ask a quick follow-up about one day, such as whether to add a co-work day or a dinner. Only people free that day are asked. These answers are saved with your name, because the organizer is counting who is in, and they are shown to whoever can see the group’s availability. Drop the day or remove your response and your answer goes with it.'),
      item('spark', 'AI paraphrase to anonymize: only if you press it', 'Written answers have an optional button that sends your draft to Cloudflare’s Workers AI to be paraphrased in plain wording, so your writing style doesn’t give you away. It isn’t meant to improve what you wrote. You see the result and decide whether to use it. The draft is not stored.'),
      item('pin', 'Where you’re coming from: only if you choose', 'A map question is always optional. If you place a pin it is rounded to roughly a kilometre before it is stored, and in an anonymous questionnaire it is kept apart from your other answers. The organizer sees where the group overlaps, not individual pins. The map images come from OpenStreetMap, which sees your IP address and the area you look at; you are told this before anything is loaded.'),
      item('calendar', 'Your calendar: never', 'Connecting Google Calendar is optional and separate from signing in. Your browser reads the calendar directly from Google and draws it over the grid. It is not sent to, or stored on, our servers, and it disappears when you close the tab.'),
      item('trash', 'Everything is deleted on a schedule', 'Each event shows the date it will be deleted, fixed when it is created. On that date the event, everyone’s availability and all answers are removed. The organizer can delete it sooner.'),
      item('shield', 'What we can’t prove, and promise instead', 'Whoever runs this site controls its server and database, and the database keeps restorable history for up to 30 days. No design can stop an operator who changes the code. What you get instead is that the code is available to read, the operator runs it as published, and it is built so that linking an anonymous answer to a person takes deliberate effort rather than a glance at a table. No analytics, no ads, no third-party scripts other than Google’s sign-in button.'),
    ),
    h('p', null, h('a', { href: '/', 'data-link': '' }, '← Back')),
  ));
  return () => {};
}
