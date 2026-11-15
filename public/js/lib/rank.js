// Turning a pile of responses into "which options are best, and who is missing".
// Pure functions over { event, responses } so they can be tested under Node.

export function slotsPerDay(event) {
  return event.kind === 'times' ? (event.endMin - event.startMin) / event.slotMin : 1;
}

export function slotCount(event) {
  return event.dates.length * slotsPerDay(event);
}

/** How many people are free in each slot. */
export function tally(event, responses) {
  const counts = new Uint16Array(slotCount(event));
  for (const r of responses) {
    for (let i = 0; i < counts.length; i++) if (r.slots[i] === '1') counts[i]++;
  }
  return counts;
}

/** Indexes (into `responses`) of who is free / not free in slot `i`. */
export function split(responses, i) {
  const free = [], missing = [];
  responses.forEach((r, p) => (r.slots[i] === '1' ? free : missing).push(p));
  return { free, missing };
}

/**
 * Whole-day events: every candidate date, best first.
 * Ties go to a date the organizer marked as preferred, then to calendar order.
 */
export function rankDays(event, responses) {
  const preferred = new Set(event.preferred || []);
  return event.dates
    .map((date, i) => ({ i, date, preferred: preferred.has(date), ...split(responses, i) }))
    .map((o) => ({ ...o, count: o.free.length }))
    .sort((a, b) => b.count - a.count || b.preferred - a.preferred || a.i - b.i);
}

/**
 * Timed events: contiguous windows in which one fixed group of people is free
 * throughout. Each window is as long as it can be for its group, so three
 * people free 9–12 with a fourth joining 10–11 yields both "9–12 (3)" and
 * "10–11 (4)".
 *
 * Sorted by head-count, then length, then calendar order.
 */
export function rankWindows(event, responses, { minSlots = 1, perDay = 2, limit = 6 } = {}) {
  const per = slotsPerDay(event);
  const preferred = new Set(event.preferred || []);
  const out = [];

  for (let d = 0; d < event.dates.length; d++) {
    const masks = new Array(per);
    for (let s = 0; s < per; s++) {
      let m = 0n;
      responses.forEach((r, p) => { if (r.slots[d * per + s] === '1') m |= 1n << BigInt(p); });
      masks[s] = m;
    }

    const seen = new Set();
    const dayWindows = [];
    for (let s = 0; s < per; s++) {
      const m = masks[s];
      if (m === 0n || (s > 0 && masks[s - 1] === m)) continue; // only start from the head of each run
      let a = s, b = s + 1;
      while (a > 0 && (masks[a - 1] & m) === m) a--;
      while (b < per && (masks[b] & m) === m) b++;
      const key = `${a}:${b}:${m}`;
      if (seen.has(key) || b - a < minSlots) continue;
      seen.add(key);
      const free = [], missing = [];
      responses.forEach((_, p) => ((m >> BigInt(p)) & 1n ? free : missing).push(p));
      dayWindows.push({ day: d, date: event.dates[d], preferred: preferred.has(event.dates[d]), s0: a, s1: b, free, missing, count: free.length });
    }
    dayWindows.sort(byQuality);
    out.push(...dayWindows.slice(0, perDay));
  }

  return out.sort(byQuality).slice(0, limit);
}

function byQuality(a, b) {
  return b.count - a.count || (b.s1 - b.s0) - (a.s1 - a.s0) || b.preferred - a.preferred || a.day - b.day || a.s0 - b.s0;
}

/** Slot indexes covered by a ranked option (a day or a window). */
export function optionSlots(event, option) {
  if (event.kind !== 'times') return [option.i];
  const per = slotsPerDay(event);
  const preferred = new Set(event.preferred || []);
  const out = [];
  for (let s = option.s0; s < option.s1; s++) out.push(option.day * per + s);
  return out;
}
