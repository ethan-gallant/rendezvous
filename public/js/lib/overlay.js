// Maps calendar items (absolute instants) onto an event's grid, entirely in
// the browser. Nothing in here talks to the network.

import { zonedToUtc, addDays } from './time.js';
import { slotsPerDay } from './rank.js';

/**
 * Start/end instant of every grid cell. For whole-day events a "cell" is the
 * full local day in the event's timezone.
 */
export function slotRanges(event) {
  const per = slotsPerDay(event);
  const n = event.dates.length * per;
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  event.dates.forEach((date, d) => {
    if (event.kind !== 'times') {
      starts[d] = zonedToUtc(date, 0, event.tz);
      ends[d] = zonedToUtc(addDays(date, 1), 0, event.tz);
      return;
    }
    for (let s = 0; s < per; s++) {
      // Per-slot conversion keeps days with a DST change correct.
      starts[d * per + s] = zonedToUtc(date, event.startMin + s * event.slotMin, event.tz);
      ends[d * per + s] = zonedToUtc(date, event.startMin + (s + 1) * event.slotMin, event.tz);
    }
  });
  return { starts, ends };
}

/** The window of time worth asking a calendar about. */
export function queryWindow(event) {
  return {
    timeMin: zonedToUtc(event.dates[0], 0, event.tz),
    timeMax: zonedToUtc(addDays(event.dates[event.dates.length - 1], 1), 0, event.tz),
  };
}

/**
 * Normalises an all-day item (given as floating dates, end exclusive) into
 * instants in the event's timezone, so it covers exactly those grid days.
 */
export function allDayToInstants(startDate, endDate, tz) {
  return { start: zonedToUtc(startDate, 0, tz), end: zonedToUtc(endDate, 0, tz) };
}

/** For each cell, the items overlapping it. `items` need { start, end } in ms. */
export function overlaps(ranges, items) {
  const n = ranges.starts.length;
  const out = Array.from({ length: n }, () => []);
  for (const item of items) {
    for (let i = 0; i < n; i++) {
      if (item.start < ranges.ends[i] && item.end > ranges.starts[i]) out[i].push(item);
    }
  }
  return out;
}

/** Minutes of `items` falling inside each cell, with overlapping items merged. */
export function busyMinutes(ranges, items) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const it of sorted) {
    const last = merged[merged.length - 1];
    if (last && it.start <= last.end) last.end = Math.max(last.end, it.end);
    else merged.push({ start: it.start, end: it.end });
  }
  const out = new Float64Array(ranges.starts.length);
  for (let i = 0; i < out.length; i++) {
    for (const m of merged) {
      const lo = Math.max(m.start, ranges.starts[i]);
      const hi = Math.min(m.end, ranges.ends[i]);
      if (hi > lo) out[i] += (hi - lo) / 60_000;
    }
  }
  return out;
}

/**
 * Whether an item should count against availability by default.
 *
 * Timed events: anything you're marked busy for.
 * Whole-day events (think on-sites and trips): only things that take you out
 * for the day. Ordinary meetings are shown but left unticked, because people
 * usually expect to take those from wherever the event is.
 */
export function blocksByDefault(event, item) {
  if (item.free) return false;
  if (event.kind === 'times') return true;
  return item.allDay || item.type === 'outOfOffice';
}
