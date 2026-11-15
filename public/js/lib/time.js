// Date and timezone helpers. Calendar dates travel as 'YYYY-MM-DD' strings and
// are only turned into instants together with an explicit IANA timezone.

export const DAY_MS = 86_400_000;

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return dateKey(parseDate(s) + n * DAY_MS);
}

/** Whole days since 1970-01-01, handy as a compact integer id for a date. */
export function epochDay(s) {
  return Math.round(parseDate(s) / DAY_MS);
}

export function fromEpochDay(n) {
  return dateKey(n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(s) {
  return new Date(parseDate(s)).getUTCDay();
}

const partsFmt = new Map();
function zoneParts(ms, tz) {
  let fmt = partsFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFmt.set(tz, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds (east is positive). */
export function tzOffsetMs(ms, tz) {
  const p = zoneParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads `date` + `minutes` after midnight. */
export function zonedToUtc(date, minutes, tz) {
  const wall = parseDate(date) + minutes * 60_000;
  const guess = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(guess, tz); // second pass settles DST edges
}

/** Wall-clock date and minutes-after-midnight in `tz` for the instant `ms`. */
export function utcToZoned(ms, tz) {
  const p = zoneParts(ms, tz);
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { date, minutes: (p.hour % 24) * 60 + p.minute };
}

export function todayIn(tz) {
  return utcToZoned(Date.now(), tz).date;
}

export function localTz() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function prefers12h() {
  const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return hc === 'h12' || hc === 'h11';
}

/** 570 → "9:30 AM" (12h) or "09:30" (24h). `compact` drops ":00" and the space: "9AM". */
export function fmtTime(min, { hour12 = true, compact = false } = {}) {
  const hr = Math.floor(min / 60) % 24;
  const mm = String(min % 60).padStart(2, '0');
  if (!hour12) return `${String(hr).padStart(2, '0')}:${mm}`;
  const suffix = hr < 12 ? 'AM' : 'PM';
  const h12 = hr % 12 || 12;
  if (compact) return `${h12}${mm === '00' ? '' : `:${mm}`}${suffix}`;
  return `${h12}:${mm} ${suffix}`;
}

export function fmtRange(a, b, opts) {
  return `${fmtTime(a, opts)} – ${fmtTime(b, opts)}`;
}

const dayFmt = new Map();
/** Format a date string with Intl options; always rendered as the calendar date it names. */
export function fmtDate(s, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const key = JSON.stringify(options);
  let fmt = dayFmt.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
    dayFmt.set(key, fmt);
  }
  return fmt.format(new Date(parseDate(s)));
}

/** "Nov 16 – 20", "Nov 28 – Dec 2", or a single date. */
export function fmtDateSpan(dates) {
  if (!dates.length) return '';
  const a = dates[0], b = dates[dates.length - 1];
  const md = { month: 'short', day: 'numeric' };
  if (a === b) return fmtDate(a, { weekday: 'short', ...md });
  if (a.slice(0, 7) === b.slice(0, 7)) return `${fmtDate(a, md)} – ${fmtDate(b, { day: 'numeric' })}`;
  return `${fmtDate(a, md)} – ${fmtDate(b, md)}`;
}

/** Short human name for a timezone at a given instant: "EST", "GMT+1". */
export function tzAbbr(tz, ms = Date.now()) {
  const part = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part ? part.value : tz;
}

export function tzCity(tz) {
  return tz.split('/').pop().replace(/_/g, ' ');
}

export function durationLabel(mins) {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace(/\.0$/, '')} hr`;
}
