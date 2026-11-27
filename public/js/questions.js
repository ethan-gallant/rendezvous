// Follow-up questionnaire: the organizer's editor, the form a participant
// fills in after giving their availability, and the organizer's results.

import { h, icon, openDialog, toast, nameList, plural } from './ui.js';
import { viewPicker, areaInput, areaResults, areaSummaryLine, defaultView } from './map.js';
import { session } from './auth.js';
import { OFF_TITLE, LAST_TITLE } from './polls.js';
import { rankInput, rankResults, rankLines, RANK_HINT } from './ranking.js';

const maxQuestions = () => session.config.maxQuestions ?? 12;
const MAX_OPTIONS = 10;

const LIKELY = ['Very likely', 'Likely', 'Not sure', 'Unlikely', 'Very unlikely'];
const YES_NO = ['Yes', 'Maybe', 'No'];

const TYPE_LABEL = { single: 'Pick one', multi: 'Pick any', rank: 'Rank in order', text: 'Written answer', area: 'Map: how far they’d travel' };
const hasChoices = (type) => type === 'single' || type === 'multi' || type === 'rank';

/**
 * Starter questions. The holiday set is built around things an organizer can
 * actually change (timing, guests, format, getting home), so each answer
 * points at a decision rather than just a mood.
 */
export const SUGGESTIONS = [
  {
    group: 'Holiday party',
    items: [
      { label: 'Partners & kids welcome', type: 'single', prompt: 'Would you be more likely to come to the Christmas party if partners and kids were welcome?', options: ['Yes, more likely', 'I’m coming to the party regardless', 'I’m skipping the party regardless', 'I’d be less likely to come'] },
      { label: 'As usually run', type: 'single', prompt: 'How likely are you to come to the party the way it’s usually run?', options: LIKELY },
      { label: 'What gets in the way', type: 'multi', prompt: 'What has kept you from coming to past parties? Pick any that apply.', options: ['The date or time didn’t work', 'Childcare or family commitments', 'Too far, or hard to get home from', 'I’m not comfortable at alcohol-centred events', 'I didn’t know many people going', 'I found out too late', 'It costs me money to attend', 'Nothing, I usually come'] },
      { label: 'Best timing', type: 'multi', prompt: 'When would a party be easiest for you to attend?', options: ['During the workday', 'Weekday evening', 'Weekend daytime', 'Weekend evening'] },
      { label: 'Bringing someone', type: 'single', prompt: 'If guests were welcome, who would you bring?', options: ['A partner or friend', 'My kids or family', 'Nobody, I’d come solo', 'I’d skip it either way'] },
      { label: 'Kind of party', type: 'multi', prompt: 'What kind of party sounds best to you?', options: ['Sit-down dinner', 'Casual food and drinks', 'An activity (bowling, curling, escape room)', 'Daytime lunch or open house', 'Something low-key at the office'] },
      { label: 'Ride home', type: 'single', prompt: 'Would a covered ride home (taxi or rideshare) make you more likely to come?', options: ['Yes', 'Maybe', 'No', 'Doesn’t apply to me'] },
      { label: 'December or January', type: 'single', prompt: 'When would you rather celebrate?', options: ['Early December', 'Mid-December', 'January, after the rush', 'No preference'] },
      { label: 'How much notice', type: 'single', prompt: 'How much notice do you need to keep the date free?', options: ['Two weeks', 'A month', 'Two months or more'] },
      { label: 'Dietary & access', type: 'text', prompt: 'Any dietary or accessibility needs we should plan around?' },
    ],
  },
  {
    group: 'Any event',
    items: [
      { label: 'What to improve', type: 'text', prompt: 'Is there anything that you believe could improve future events?' },
      { label: 'One change', type: 'text', prompt: 'If you could change one thing about our events, what would it be?' },
      { label: 'Best part', type: 'text', prompt: 'What did you enjoy most about the last event you came to?' },
      { label: 'Join remotely?', type: 'single', prompt: 'Would you join remotely if there was a good way to take part?', options: YES_NO },
    ],
  },
  {
    group: 'Location (always skippable)',
    items: [
      { label: 'How far they’d travel', type: 'area', prompt: 'Roughly where will you be coming from, and how far would you travel?' },
      { label: 'Getting there', type: 'single', prompt: 'How do you plan to get there?', options: ['Driving myself', 'Getting a ride or carpooling', 'Bus, train or other public transit', 'Taxi or rideshare', 'Walking or cycling', 'Not sure yet'] },
    ],
  },
];

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return `q${Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
}

const shape = (q) => JSON.stringify([q.type, hasChoices(q.type) ? q.options : []]);

/**
 * Organizer's editor. Resolves with { questions, anonAnswers } or null.
 * A question whose choices changed gets a fresh id, so earlier answers to the
 * old wording of the choices are not misread.
 */
export function openQuestionBuilder({ questions = [], anonAnswers = true, anonLocked = false, answered = 0 } = {}) {
  return openDialog((close) => {
    // `off[k]` marks choice k as shown-but-unpickable. Only offered (and only honoured by the server) for organizers with extras.
    const extras = !!session.user?.extras;
    const offFlags = (q) => (q.options || []).map((_, k) => !!q.off?.includes(k));
    // `last` is the index of the one choice of a ranking that can only be put last (same gate).
    const items = questions.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: [...(q.options || [])], off: offFlags(q), last: q.last ?? null, view: q.view, was: shape(q) }));
    let anon = anonAnswers;

    const list = h('div', { class: 'qb-list' });
    const addBtn = h('button', { class: 'btn', type: 'button', onClick: () => add({ type: 'single', prompt: '', options: [...YES_NO] }, true) }, icon('plus', 16), 'Add a question');
    const ideas = h('details', { class: 'qb-ideas' });

    function add(q, focus = false) {
      if (items.length >= maxQuestions()) return toast(`That’s the limit: ${maxQuestions()} questions.`);
      items.push({ id: newId(), type: q.type, prompt: q.prompt, options: [...(q.options || [])], off: offFlags(q), last: q.last ?? null, view: q.type === 'area' ? defaultView() : undefined, was: null });
      render();
      const el = list.lastElementChild;
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (focus) el?.querySelector('textarea')?.focus();
    }

    function render() {
      list.replaceChildren(...items.map((q, n) => {
        const prompt = h('textarea', {
          rows: 2, maxLength: 300, value: q.prompt, placeholder: 'Ask something…', 'aria-label': `Question ${n + 1}`,
          onInput: () => { q.prompt = prompt.value; },
        });
        const type = h('select', {
          'aria-label': 'Answer type',
          onChange: () => {
            q.type = type.value;
            if (hasChoices(q.type) && q.options.length < 2) { q.options = [...YES_NO]; q.off = []; q.last = null; }
            if (q.type === 'area') q.view ??= defaultView();
            render();
          },
        }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
        type.value = q.type;

        const kids = [
          h('div', { class: 'qb-head' },
            h('span', { class: 'step-n' }, n + 1), type,
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', title: 'Move up', disabled: n === 0, onClick: () => { items.splice(n - 1, 0, items.splice(n, 1)[0]); render(); } }, icon('up', 16)),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove question', title: 'Remove', onClick: () => { items.splice(n, 1); render(); } }, icon('trash', 16)),
          ),
          prompt,
        ];

        if (q.type === 'area') kids.push(viewPicker(q.view, (v) => { q.view = v; }));
        if (hasChoices(q.type)) {
          kids.push(h('div', { class: 'qb-opts' }, q.options.map((opt, k) => {
            const input = h('input', {
              type: 'text', maxLength: 80, value: opt, placeholder: `Choice ${k + 1}`, 'aria-label': `Choice ${k + 1}`,
              onInput: () => { q.options[k] = input.value; },
            });
            return h('div', { class: `qb-opt${q.off[k] ? ' off' : ''}` }, h('i', { class: q.type === 'multi' ? 'mark box' : 'mark radio' }), input,
              extras && q.type === 'rank' && h('button', { class: `mini-toggle${q.last === k ? ' on' : ''}`, type: 'button', title: LAST_TITLE, 'aria-label': `Choice ${k + 1}: last only`, 'aria-pressed': q.last === k ? 'true' : 'false', onClick: () => { q.last = q.last === k ? null : k; if (q.last === k) q.off[k] = false; render(); } }, 'Last'),
              extras && h('button', { class: `icon-btn small${q.off[k] ? ' on' : ''}`, type: 'button', title: OFF_TITLE, 'aria-label': `Choice ${k + 1}: greyed out`, 'aria-pressed': q.off[k] ? 'true' : 'false', onClick: () => { q.off[k] = !q.off[k]; if (q.off[k] && q.last === k) q.last = null; render(); } }, icon('eyeOff', 14)),
              h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Remove choice', disabled: q.options.length <= 2, onClick: () => { q.options.splice(k, 1); q.off.splice(k, 1); q.last = q.last === k ? null : q.last > k ? q.last - 1 : q.last; render(); } }, icon('x', 14)));
          })));
          kids.push(h('div', { class: 'qb-opt-actions' },
            q.options.length < MAX_OPTIONS && h('button', { class: 'link', type: 'button', onClick: () => { q.options.push(''); render(); list.children[n].querySelector('.qb-opt:last-child input')?.focus(); } }, 'Add choice'),
            h('button', { class: 'link', type: 'button', onClick: () => { q.options = [...YES_NO]; q.off = []; q.last = null; render(); } }, 'Yes / Maybe / No'),
            h('button', { class: 'link', type: 'button', onClick: () => { q.options = [...LIKELY]; q.off = []; q.last = null; render(); } }, 'Likelihood scale'),
          ));
        }
        return h('div', { class: 'qb-item' }, kids);
      }));
      addBtn.hidden = items.length >= maxQuestions();
      if (!items.length) list.append(h('p', { class: 'muted qb-empty' }, 'No questions yet. Write your own, or start from an idea below.'));
    }

    ideas.append(
      h('summary', null, icon('spark', 16), 'Ideas: questions that explain attendance'),
      ...SUGGESTIONS.map((pack) => h('div', { class: 'qb-pack' },
        h('span', { class: 'qb-pack-name' }, pack.group),
        h('div', { class: 'chips left' }, pack.items.map((it) => h('button', { class: 'chip', type: 'button', title: it.prompt, onClick: () => add(it) }, icon('plus', 13), it.label))))),
    );
    ideas.open = items.length === 0;

    const anonBox = h('input', { type: 'checkbox', class: 'switch', checked: anon, disabled: anonLocked, onChange: () => { anon = anonBox.checked; } });
    const anonRow = h('label', { class: `opt${anonLocked ? ' disabled' : ''}` }, icon('eyeOff', 20),
      h('span', { class: 'opt-text' }, h('strong', null, 'Keep answers anonymous'),
        h('small', null, anonLocked
          ? 'People have already answered on the promise of anonymity, so this stays on.'
          : `You see totals and comments, not who said what. Answers reach you in batches of at least ${session.config.anonBatch ?? 3} people, so nobody’s answers show up on their own. People are told this before they answer.`)),
      anonBox);

    function done() {
      const out = [];
      for (const [n, q] of items.entries()) {
        const prompt = q.prompt.trim();
        if (!prompt) continue; // blank cards are simply dropped
        if (!hasChoices(q.type)) {
          // Same kind of question as before keeps its id (and its answers); a changed kind starts fresh.
          const id = !q.was || q.was === shape({ type: q.type }) ? q.id : newId();
          out.push(q.type === 'area' ? { id, type: 'area', prompt, view: q.view } : { id, type: 'text', prompt });
          continue;
        }
        const kept = q.options.map((o, k) => ({ text: o.trim(), off: !!q.off[k], last: q.type === 'rank' && q.last === k })).filter((o) => o.text);
        const options = kept.map((o) => o.text);
        const off = kept.flatMap((o, k) => (o.off ? [k] : []));
        const last = kept.findIndex((o) => o.last);
        if (options.length - off.length - (last >= 0 ? 1 : 0) < 2) {
          toast(off.length || last >= 0 ? `Question ${n + 1} needs at least two ordinary choices.` : `Question ${n + 1} needs at least two choices.`);
          list.children[n]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        const next = { type: q.type, prompt, options };
        out.push({ id: q.was && q.was !== shape(next) ? newId() : q.id, ...next, ...(off.length ? { off } : {}), ...(last >= 0 ? { last } : {}) });
      }
      close({ questions: out, anonAnswers: anon });
    }

    render();
    return h('div', { class: 'dialog-body qb' },
      h('h2', null, 'Follow-up questions'),
      h('p', { class: 'muted' }, 'Shown to each person right after they’ve given their availability. Always optional for them.'),
      answered > 0 && h('p', { class: 'notice' }, icon('users', 16),
        `${plural(answered, 'person has', 'people have')} already answered. Rewording a question is safe; changing its choices or removing it discards the answers to it.`),
      list,
      h('div', null, addBtn),
      ideas,
      anonRow,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn ghost', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onClick: done }, 'Done')),
    );
  }, { className: 'wide' });
}

/**
 * The form a participant fills in. `answers` is mutated in place and
 * `onChange` fires after each change. Choices can be un-picked by tapping again.
 */
export function buildQuestionnaire({ questions, answers, locked, onChange, reword }) {
  return h('div', { class: `qs${locked ? ' locked' : ''}` }, questions.map((q) => {
    const legend = h('div', { class: 'q-prompt' }, q.prompt);
    if (q.type === 'area') {
      return h('div', { class: 'q' }, legend, areaInput({
        view: q.view, value: answers[q.id], locked,
        onChange: (v) => {
          if (v) answers[q.id] = v;
          else delete answers[q.id];
          onChange();
        },
      }));
    }
    if (q.type === 'text') {
      const area = h('textarea', {
        rows: 3, maxLength: 1000, value: answers[q.id] || '', disabled: locked, placeholder: 'Optional', 'aria-label': q.prompt,
        onInput: () => {
          if (area.value.trim()) answers[q.id] = area.value;
          else delete answers[q.id];
          onChange();
        },
      });
      const kids = [legend, area];
      if (reword && !locked) {
        // Optional and only on request. It is a disguise for writing style, not an improvement: the
        // paraphrase is shown first and they decide whether to use it.
        const slot = h('div', { class: 'reword' });
        const ask = h('button', { class: 'link', type: 'button' }, icon('spark', 14), 'Paraphrase to anonymize');
        const idle = () => slot.replaceChildren(ask, h('span', { class: 'q-hint' },
          'AI rewrites it in plain, flat wording so it’s harder to tell who wrote it. It won’t make your point better, only less recognisably yours. Sends this draft to Cloudflare’s AI; nothing is kept.'));
        ask.addEventListener('click', async () => {
          const draft = area.value.trim();
          if (draft.length < 20) return toast('Write a sentence or two first.');
          slot.replaceChildren(h('span', { class: 'q-hint' }, 'Paraphrasing…'));
          try {
            const { text } = await reword(draft);
            slot.replaceChildren(h('div', { class: 'reword-box' },
              h('span', { class: 'q-hint' }, 'Paraphrased version'),
              h('p', null, text),
              h('div', { class: 'foot-actions' },
                h('button', {
                  class: 'btn small primary', type: 'button',
                  onClick: () => {
                    area.value = text;
                    answers[q.id] = text;
                    onChange();
                    idle();
                  },
                }, 'Use this'),
                h('button', { class: 'btn small', type: 'button', onClick: idle }, 'Keep mine'))));
          } catch (e) {
            idle();
            toast(e?.code === 'slow_down' ? 'That’s a lot of paraphrasing. Give it a minute.'
              : e?.code === 'too_short' ? 'Write a sentence or two first.'
                : 'AI paraphrasing isn’t available right now.');
          }
        });
        idle();
        kids.push(slot);
      }
      return h('div', { class: 'q' }, kids);
    }

    if (q.type === 'rank') {
      return h('div', { class: 'q' }, legend,
        rankInput({
          options: q.options, off: q.off, last: q.last ?? null, value: answers[q.id] || [], disabled: locked, label: q.prompt,
          onChange: (order) => {
            if (order.length) answers[q.id] = order;
            else delete answers[q.id];
            onChange();
          },
        }),
        h('span', { class: 'q-hint' }, RANK_HINT));
    }

    const multi = q.type === 'multi';
    const isOn = (k) => (multi ? (answers[q.id] || []).includes(k) : answers[q.id] === k);
    const isOff = (k) => !!q.off?.includes(k); // shown, but not a choice anyone can make
    const buttons = q.options.map((opt, k) => h('button', {
      type: 'button', class: `q-choice${isOff(k) ? ' off' : ''}`, role: multi ? 'checkbox' : 'radio', disabled: locked || isOff(k),
      onClick: () => {
        if (multi) {
          const set = new Set(answers[q.id] || []);
          if (set.has(k)) set.delete(k);
          else set.add(k);
          if (set.size) answers[q.id] = [...set].sort((a, b) => a - b);
          else delete answers[q.id];
        } else if (answers[q.id] === k) delete answers[q.id];
        else answers[q.id] = k;
        paint();
        onChange();
      },
    }, h('i', { class: multi ? 'mark box' : 'mark radio' }), opt));
    const paint = () => buttons.forEach((b, k) => {
      b.classList.toggle('on', isOn(k));
      b.setAttribute('aria-checked', isOn(k) ? 'true' : 'false');
    });
    paint();
    return h('div', { class: 'q' }, legend,
      h('div', { class: 'q-choices', role: multi ? 'group' : 'radiogroup', 'aria-label': q.prompt }, buttons),
      multi && h('span', { class: 'q-hint' }, 'Pick any that apply'));
  }));
}

/** Organizer's view of the answers. */
export function buildSurveyResults({ questions, survey, anon }) {
  const waiting = survey.waiting || { answers: 0, pins: 0 };
  const nothingYet = h('p', { class: 'muted' }, 'No answers yet. They’ll show up here as people respond.');
  if (survey.anon && survey.hidden) {
    const n = Math.max(waiting.answers, waiting.pins);
    return n ? h('p', { class: 'muted' },
      `${plural(n, 'person has', 'people have')} answered so far. To keep answers anonymous they reach you in batches of at least ${survey.min} people, so the first results appear once ${survey.min} have answered.`)
      : nothingYet;
  }
  if (!survey.anon && !questions.some((q) => (survey.questions[q.id]?.n ?? 0) > 0)) return nothingYet;

  // Anonymous results are a snapshot of the last batch, not a live view.
  const batch = survey.anon && h('p', { class: 'batch-note' }, icon('users', 15),
    `Showing the last batch: ${plural(survey.answered, 'person', 'people')}. `,
    waiting.answers
      ? `${plural(waiting.answers, 'new or changed answer is', 'new or changed answers are')} waiting and will be added once ${survey.min} are.`
      : 'Nothing new is waiting.');
  const missing = Array.isArray(survey.missing) && h('p', { class: 'batch-note' }, icon('clock', 15),
    survey.missing.length
      ? h('span', null, h('strong', null, 'Haven’t answered the questions yet'), survey.anon ? ' (as of the last batch): ' : ': ', nameList(survey.missing, 15))
      : 'Everyone who responded has answered the questions.');

  return h('div', { class: 'sr' }, batch, missing, questions.map((q) => {
    const notBatched = survey.anon && !survey.questions[q.id];
    const r = survey.questions[q.id] || (q.type === 'area' ? { n: waiting.pins, hidden: true } : { n: 0, hidden: notBatched });
    const head = h('div', { class: 'sr-head' }, h('strong', null, q.prompt), h('span', { class: 'muted' }, plural(r.n, q.type === 'area' ? 'pin' : 'answer')));
    if (q.type === 'area') return h('div', { class: 'sr-q' }, head, areaResults({ view: q.view, result: r, anon, min: survey.min }));
    if (r.hidden) return h('div', { class: 'sr-q' }, head, h('p', { class: 'muted small' }, `Not in a batch yet. Shown once ${survey.min} people have answered it.`));
    if (q.type === 'text') {
      return h('div', { class: 'sr-q' }, head,
        r.n ? h('ul', { class: 'sr-texts' }, r.texts.map((t) => h('li', null, h('span', null, t.text), t.name && h('em', null, t.name))))
          : h('p', { class: 'muted small' }, 'Nobody has written anything yet.'));
    }
    if (q.type === 'rank') {
      return h('div', { class: 'sr-q' }, head,
        rankResults({ options: q.options, off: q.off, last: q.last ?? null, points: r.points, firsts: r.firsts, who: anon ? null : r.who, skips: r.skips, skipWho: anon ? null : r.skipWho }),
        r.n > 0 && h('span', { class: 'q-hint' }, 'Points: a first place is worth the most, each place after that one less. “Would skip” counts people who answered but left that choice out.'));
    }
    const top = Math.max(1, ...r.counts || [0]);
    return h('div', { class: 'sr-q' }, head, h('div', { class: 'sr-bars' }, q.options.map((opt, k) => {
      if (q.off?.includes(k)) return null; // nobody could pick it, so there is nothing to chart
      const c = r.counts?.[k] ?? 0;
      const pct = r.n ? Math.round((c / r.n) * 100) : 0;
      const bar = h('i');
      bar.style.width = `${(c / top) * 100}%`;
      return h('div', { class: `sr-row${c === top && c > 0 ? ' top' : ''}` },
        h('span', { class: 'sr-label' }, opt),
        h('span', { class: 'sr-track' }, bar),
        h('span', { class: 'sr-num' }, h('b', null, c), r.n ? ` · ${pct}%` : ''),
        !anon && r.who?.[k]?.length > 0 && h('span', { class: 'sr-who' }, nameList(r.who[k], 8)));
    })), q.type === 'multi' && r.n > 0 && h('span', { class: 'q-hint' }, 'People could pick more than one, so percentages add up to more than 100.'));
  }));
}

/** Plain-text version of the results, for pasting into a doc or message. */
export function surveyText({ title, questions, survey, anon }) {
  const lines = [`${title}: follow-up answers (${plural(survey.answered, 'person', 'people')}${anon ? ', anonymous' : ''})`, ''];
  for (const q of questions) {
    const r = survey.questions[q.id] || { n: 0 };
    lines.push(`${q.prompt} (${plural(r.n, q.type === 'area' ? 'pin' : 'answer')})`);
    if (q.type === 'area') {
      lines.push(areaSummaryLine(r, survey.min));
    } else if (r.hidden) {
      lines.push(`  (shown once ${survey.min} people have answered)`);
    } else if (q.type === 'text') {
      for (const t of r.texts || []) lines.push(`  - ${t.text.replace(/\s*\n\s*/g, ' ')}${t.name ? ` (${t.name})` : ''}`);
    } else if (q.type === 'rank') {
      lines.push(...rankLines({ options: q.options, off: q.off, last: q.last ?? null, points: r.points, firsts: r.firsts, who: r.who, skips: r.skips, skipWho: r.skipWho }));
    } else {
      q.options.forEach((opt, k) => {
        if (q.off?.includes(k)) return;
        const c = r.counts?.[k] ?? 0;
        lines.push(`  ${String(c).padStart(3)}  ${r.n ? `${Math.round((c / r.n) * 100)}%`.padStart(4) : '   -'}  ${opt}`);
      });
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
