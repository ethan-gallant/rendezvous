// Day polls: a quick follow-up about one candidate day ("Co-work day?", "Drinks + dinner?"),
// put only to the people who said they can make that day. The server decides who may answer
// and what each viewer may see; this file only draws it.

import { h, icon, openDialog, plural, nameList } from './ui.js';
import { fmtDate } from './lib/time.js';
import { rankInput, rankResults, RANK_HINT } from './ranking.js';

const MAX_OPTIONS = 6;
const IDEAS = [
  { label: 'Co-work day?', prompt: 'Co-work day?', options: ['Co-work day', 'No co-work day'] },
  { label: 'Drinks + dinner?', prompt: 'Drinks + dinner?', options: ['Drinks + dinner', 'No drinks or dinner'] },
  { label: 'Yes / No', prompt: '', options: ['Yes', 'No'] },
];

export const longDay = (day) => fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' });

/** A choice can be shown greyed out and unpickable. Only offered to organizers the server lists for extras. */
export const OFF_TITLE = 'Show greyed out: visible, but can’t be picked';
/** In a ranking, one choice can be limited to last place. Same gate. */
export const LAST_TITLE = 'Can only be ranked last';

/** Organizer's dialog. Resolves with { day, prompt, kind, options, off, last } or null. */
export function openPollBuilder({ dates, freeCount, defaultDay, extras = false }) {
  return openDialog((close) => {
    const day = h('select', { 'aria-label': 'Day' }, dates.map((d, k) => h('option', { value: d },
      freeCount ? `${longDay(d)} · ${freeCount[k]} free` : longDay(d))));
    day.value = defaultDay || dates[0];
    const prompt = h('input', { type: 'text', maxLength: 160, placeholder: 'Co-work day?', 'aria-label': 'Question' });
    let options = [{ text: '', off: false }, { text: '', off: false }];
    const kind = h('select', { 'aria-label': 'How people answer', onChange: () => draw() },
      h('option', { value: 'pick' }, 'Pick one'), h('option', { value: 'rank' }, 'Rank in order of preference'));
    const list = h('div', { class: 'qb-opts' });
    const addBtn = h('button', { class: 'link', type: 'button', onClick: () => { options.push({ text: '', off: false }); draw(); list.lastChild.querySelector('input').focus(); } }, 'Add choice');

    function draw() {
      list.replaceChildren(...options.map((o, k) => h('div', { class: `qb-opt${o.off ? ' off' : ''}` },
        h('span', { class: 'poll-radio', 'aria-hidden': 'true' }),
        h('input', { type: 'text', maxLength: 80, value: o.text, placeholder: k === 0 ? 'Co-work day' : k === 1 ? 'No co-work day' : 'Another choice', 'aria-label': `Choice ${k + 1}`, onInput: (e) => { o.text = e.target.value; } }),
        extras && kind.value === 'rank' && h('button', { class: `mini-toggle${o.last ? ' on' : ''}`, type: 'button', title: LAST_TITLE, 'aria-label': `Choice ${k + 1}: last only`, 'aria-pressed': o.last ? 'true' : 'false', onClick: () => { const next = !o.last; options.forEach((x) => { x.last = false; }); o.last = next; if (next) o.off = false; draw(); } }, 'Last'),
        extras && h('button', { class: `icon-btn small${o.off ? ' on' : ''}`, type: 'button', title: OFF_TITLE, 'aria-label': `Choice ${k + 1}: greyed out`, 'aria-pressed': o.off ? 'true' : 'false', onClick: () => { o.off = !o.off; if (o.off) o.last = false; draw(); } }, icon('eyeOff', 15)),
        h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Remove choice ${k + 1}`, disabled: options.length <= 2, onClick: () => { options.splice(k, 1); draw(); } }, icon('x', 15)),
      )));
      addBtn.hidden = options.length >= MAX_OPTIONS;
    }
    draw();

    const ideas = h('div', { class: 'chips left' }, IDEAS.map((idea) => h('button', {
      class: 'chip', type: 'button',
      onClick: () => {
        if (idea.prompt) prompt.value = idea.prompt;
        kind.value = 'pick';
        options = idea.options.map((text) => ({ text, off: false }));
        draw();
        (idea.prompt ? list.querySelector('input') : prompt).focus();
      },
    }, idea.label)));

    const error = h('p', { class: 'form-error', hidden: true });
    return h('form', {
      class: 'dialog-body',
      onSubmit: (e) => {
        e.preventDefault();
        const clean = [];
        for (const o of options) {
          const text = o.text.trim();
          if (text && !clean.some((c) => c.text === text)) clean.push({ text, off: o.off, last: kind.value === 'rank' && !!o.last });
        }
        const special = clean.some((o) => o.off || o.last);
        const problem = !prompt.value.trim() ? 'Write the question first.'
          : clean.filter((o) => !o.off && !o.last).length < 2 ? (special ? 'Give at least two ordinary choices.' : 'Give at least two different choices.') : '';
        error.textContent = problem;
        error.hidden = !problem;
        const last = clean.findIndex((o) => o.last);
        if (!problem) close({ day: day.value, prompt: prompt.value.trim(), kind: kind.value, options: clean.map((o) => o.text), off: clean.flatMap((o, k) => (o.off ? [k] : [])), ...(last >= 0 ? { last } : {}) });
      },
    },
      h('h2', null, 'Ask about one day'),
      h('p', { class: 'muted' }, 'A quick question for the people who can make that day. Anyone who didn’t mark the day is told so, and can add it unless you’ve locked availability.'),
      h('label', { class: 'field' }, h('span', null, 'Day'), day),
      h('label', { class: 'field' }, h('span', null, 'Question'), prompt),
      h('label', { class: 'field' }, h('span', null, 'How people answer'), kind),
      h('div', { class: 'field' }, h('span', null, 'Choices'), list, h('div', { class: 'qb-opt-actions' }, addBtn)),
      h('div', { class: 'field' }, h('span', null, 'Ideas'), ideas),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn ghost', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create poll')));
  }, { className: 'wide' });
}

/**
 * One poll.
 *   free      whether the viewer's saved availability includes the poll's day
 *   answered  whether the viewer has saved any availability at all
 *   gate      { locked, ownerName, addLabel, onAdd } for the "you didn't mark this day" notice
 */
export function buildPoll(poll, { free, answered, isOwner, focused, gate, onVote, onCopy, onDelete }) {
  const day = longDay(poll.day);
  const shown = Array.isArray(poll.voters); // names and totals, when this viewer may see them
  const total = shown ? poll.voters.reduce((n, v) => n + v.length, 0) : 0;

  const ranked = poll.kind === 'rank';
  const options = ranked ? h('div', { class: 'poll-opts' },
    rankInput({
      options: poll.options, off: poll.off, last: poll.last ?? null, value: poll.myRanking || [], disabled: !free, label: poll.prompt,
      onChange: (order) => onVote(order),
    }),
    free && h('p', { class: 'q-hint' }, RANK_HINT),
    shown && total > 0 && rankResults({ options: poll.options, off: poll.off, last: poll.last ?? null, points: poll.points, who: poll.voters }),
  ) : h('div', { class: 'poll-opts', role: 'radiogroup', 'aria-label': poll.prompt }, poll.options.map((label, k) => {
    if (poll.off?.includes(k)) {
      // Shown, never pickable, and left out of the tally.
      return h('div', { class: 'poll-row' }, h('button', { type: 'button', class: 'poll-opt off', role: 'radio', 'aria-checked': 'false', disabled: true },
        h('span', { class: 'poll-radio', 'aria-hidden': 'true' }), h('span', { class: 'poll-label' }, label)));
    }
    const on = poll.myVote === k;
    const names = shown ? poll.voters[k] : [];
    const btn = h('button', {
      type: 'button', class: `poll-opt${on ? ' on' : ''}`, role: 'radio', 'aria-checked': on ? 'true' : 'false',
      disabled: !free,
      title: !free ? `For people who can make ${day}` : on ? 'Click again to take your answer back' : '',
      onClick: () => onVote(on ? null : k),
    },
      h('span', { class: 'poll-radio', 'aria-hidden': 'true' }),
      h('span', { class: 'poll-label' }, label),
      shown && h('span', { class: 'poll-count' }, names.length));
    if (shown && total > 0) btn.style.setProperty('--share', `${Math.round((names.length / total) * 100)}%`);
    return h('div', { class: 'poll-row' }, btn, shown && names.length > 0 && h('p', { class: 'poll-names' }, nameList(names, 10)));
  }));

  let status = null;
  if (shown) {
    status = poll.eligible === 0 ? 'Nobody has marked this day as one they can make yet.'
      : poll.waiting.length === 0 ? `All ${plural(poll.eligible, 'person', 'people')} free that day ${poll.eligible === 1 ? 'has' : 'have'} answered.`
        : `Still to answer: ${nameList(poll.waiting, 10)}`;
  }

  let notice = null;
  if (!free) {
    notice = h('div', { class: 'poll-gate' },
      h('p', null, icon('calendar', 16), h('strong', null, answered
        ? `You didn’t mark ${day} as a day you can make.`
        : `You haven’t said whether you can make ${day}.`)),
      h('p', { class: 'muted' }, gate.locked
        ? `This question is for people who can make it, and ${isOwner ? 'you’ve' : `${gate.ownerName} has`} locked availability, so it can’t be changed right now.`
        : 'This question is for people who can make it. If you can after all, add the day and the question opens up.'),
      !gate.locked && h('button', { class: 'btn small primary', type: 'button', onClick: gate.onAdd }, icon('plus', 15), gate.addLabel));
  }

  return h('article', { class: `poll${focused ? ' focus' : ''}`, dataset: { poll: poll.id } },
    h('div', { class: 'poll-head' },
      h('div', { class: 'poll-title' },
        h('span', { class: 'poll-day' }, icon('calendar', 14), day),
        h('h3', null, poll.prompt)),
      isOwner && h('div', { class: 'poll-actions' },
        h('button', { class: 'icon-btn small', type: 'button', title: 'Copy a link straight to this poll', 'aria-label': 'Copy poll link', onClick: onCopy }, icon('link', 16)),
        h('button', { class: 'icon-btn small', type: 'button', title: 'Delete this poll', 'aria-label': 'Delete poll', onClick: onDelete }, icon('trash', 16)))),
    notice,
    options,
    status && h('p', { class: 'q-hint' }, status));
}
