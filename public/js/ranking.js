// Ranking: the tap-in-order input and the points list, shared by day polls and
// follow-up questions. The server re-checks every order it is sent (cleanRanking).

import { h, nameList, plural } from './ui.js';

export const RANK_HINT = 'Tap in order, favourite first. Leave out any you’d skip. Tap one again to take it out.';

/**
 * Tap choices in order of preference; each shows its place. Ranking only some is fine.
 *   off   indexes that are shown but can't be picked
 *   last  index of a choice that can only ever be put last, or null
 */
export function rankInput({ options, off = [], last = null, value = [], disabled = false, label, onChange }) {
  let order = [...value];
  const wrap = h('div', { class: 'rank', role: 'group', 'aria-label': label });
  const draw = () => {
    wrap.replaceChildren(...options.map((text, k) => {
      const isOff = off.includes(k);
      const place = order.indexOf(k);
      const picked = place >= 0;
      return h('button', {
        type: 'button', class: `rank-opt${picked ? ' on' : ''}${isOff ? ' off' : ''}`,
        disabled: disabled || isOff, 'aria-pressed': picked ? 'true' : 'false',
        'aria-label': picked ? `${text}: ${k === last ? 'last' : `number ${place + 1}`}` : text,
        onClick: () => {
          if (picked) order = order.filter((x) => x !== k);
          else if (k === last || last === null || !order.includes(last)) order = [...order, k];
          else order = [...order.filter((x) => x !== last), k, last]; // keep the last-only one at the end
          draw();
          onChange([...order]);
        },
      }, h('span', { class: 'rank-badge', 'aria-hidden': 'true' }, !picked ? '' : k === last ? 'Last' : place + 1), h('span', { class: 'rank-label' }, text));
    }));
  };
  draw();
  return wrap;
}

/**
 * Standings: ordinary choices by points, most first, then how many picked the last-only one.
 * `who` (names per choice) is optional; `firsts` (counts) is used when names aren't available.
 * `skipWho` / `skips` are the people who answered but left a choice out, which the input tells
 * them means they'd skip it. The choice the fewest people would skip is flagged.
 */
export function rankResults({ options, off = [], last = null, points, firsts, who, skips, skipWho }) {
  const count = (k) => who?.[k]?.length ?? firsts?.[k] ?? 0;
  const skipCount = (k) => skipWho?.[k]?.length ?? skips?.[k] ?? 0;
  const hasSkips = !!(skipWho || skips);
  const rows = options.map((label, k) => ({ label, k, pts: points?.[k] ?? 0 }))
    .filter((r) => !off.includes(r.k) && r.k !== last)
    .sort((a, b) => b.pts - a.pts || count(b.k) - count(a.k));
  const top = Math.max(1, ...rows.map((r) => r.pts));
  const skipNums = rows.map((r) => skipCount(r.k));
  const fewest = Math.min(...skipNums);
  // Only worth pointing out when the choices actually differ on it.
  const flagFewest = hasSkips && rows.length > 1 && fewest < Math.max(...skipNums);
  const out = rows.map((r, n) => {
    const bar = h('i');
    bar.style.width = `${(r.pts / top) * 100}%`;
    const c = count(r.k);
    const s = skipCount(r.k);
    return h('div', { class: `sr-row${n === 0 && r.pts > 0 ? ' top' : ''}` },
      h('span', { class: 'sr-label' }, r.label, flagFewest && s === fewest && h('span', { class: 'count-chip' }, s === 0 ? 'Nobody would skip' : 'Fewest would skip')),
      h('span', { class: 'sr-track' }, bar),
      h('span', { class: 'sr-num' }, h('b', null, r.pts), r.pts === 1 ? ' pt' : ' pts'),
      c > 0 && h('span', { class: 'sr-who' }, who ? `First choice: ${nameList(who[r.k], 8)}` : `First choice of ${c}`),
      hasSkips && s > 0 && h('span', { class: 'sr-who skip' }, skipWho ? `Would skip (${s}): ${nameList(skipWho[r.k], 8)}` : `${plural(s, 'person', 'people')} would skip`));
  });
  if (last !== null && !off.includes(last) && count(last) > 0) {
    out.push(h('div', { class: 'sr-row' },
      h('span', { class: 'sr-label' }, options[last]),
      h('span', { class: 'sr-who' }, who ? `Put last by ${nameList(who[last], 8)}` : `Put last by ${plural(count(last), 'person', 'people')}`)));
  }
  return h('div', { class: 'sr-bars' }, out);
}

/** The same standings as plain text lines. */
export function rankLines({ options, off = [], last = null, points, firsts, who, skips, skipWho }) {
  const count = (k) => who?.[k]?.length ?? firsts?.[k] ?? 0;
  const skipCount = (k) => skipWho?.[k]?.length ?? skips?.[k] ?? 0;
  const lines = options.map((label, k) => ({ label, k, pts: points?.[k] ?? 0 }))
    .filter((r) => !off.includes(r.k) && r.k !== last)
    .sort((a, b) => b.pts - a.pts)
    .map((r) => `  ${String(r.pts).padStart(3)} pts  ${r.label}${count(r.k) ? ` (first choice of ${count(r.k)})` : ''}${skipCount(r.k) ? ` (${skipCount(r.k)} would skip)` : ''}`);
  if (last !== null && count(last) > 0) lines.push(`  ${options[last]}: put last by ${count(last)}`);
  return lines;
}
