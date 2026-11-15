// The paintable grids and the pointer/touch/keyboard handling they share.
//
// Every paintable cell carries data-i. Mouse: press and drag paints at once.
// Touch: a tap toggles one cell; press-and-hold then drag paints, so an
// ordinary swipe still scrolls the page.

import { h } from './ui.js';
import { epochDay, fmtDate, fmtTime, weekday, parseDate } from './lib/time.js';

const HOLD_MS = 220;
const SLOP_PX = 10;

/**
 * opts: get(i) → bool, set(i, bool), region(a, b) → i[], neighbor(i, dir) → i|null,
 *       enabled() → bool, onCommit(), onActivate(i) (tap/Enter when painting is off)
 */
export function attachPaint(root, opts) {
  const { get, set, region, neighbor, enabled = () => true, onCommit, onActivate } = opts;
  let drag = null;

  const indexOf = (node) => {
    const el = node?.closest?.('[data-i]');
    return el && root.contains(el) ? Number(el.dataset.i) : null;
  };
  const indexAt = (x, y) => indexOf(document.elementFromPoint(x, y));

  function begin(i) {
    drag = { start: i, value: !get(i), touched: new Map() };
    root.classList.add('painting');
    extend(i);
  }
  function extend(j) {
    if (!drag || j == null) return;
    const next = new Set(region(drag.start, j));
    for (const [i, original] of drag.touched) {
      if (!next.has(i)) {
        set(i, original);
        drag.touched.delete(i);
      }
    }
    for (const i of next) {
      if (!drag.touched.has(i)) {
        drag.touched.set(i, get(i));
        set(i, drag.value);
      }
    }
  }
  function end(commit = true) {
    if (!drag) return;
    const { touched, value } = drag;
    drag = null;
    root.classList.remove('painting');
    if (!commit) {
      for (const [i, original] of touched) set(i, original);
      return;
    }
    if ([...touched.values()].some((original) => original !== value)) onCommit?.();
  }
  const toggle = (i) => {
    begin(i);
    end();
  };

  // ---- mouse / pen ----
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || !enabled()) return;
    const i = indexOf(e.target);
    if (i == null) return;
    e.preventDefault(); // no text selection while dragging
    begin(i);
    const move = (ev) => extend(indexAt(ev.clientX, ev.clientY));
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      end(ev.type === 'pointerup');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });

  // ---- touch ----
  let touch = null;
  root.addEventListener('touchstart', (e) => {
    if (touch) {
      // A second finger: abandon whatever the first one was doing.
      clearTimeout(touch.timer);
      if (touch.painting) end(false);
      touch = null;
      return;
    }
    if (!enabled() || e.touches.length !== 1) return;
    const t = e.changedTouches[0];
    const i = indexOf(t.target);
    if (i == null) return;
    touch = { id: t.identifier, i, x: t.clientX, y: t.clientY, painting: false };
    touch.timer = setTimeout(() => {
      if (!touch) return;
      touch.painting = true;
      navigator.vibrate?.(8);
      begin(touch.i);
    }, HOLD_MS);
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = [...e.changedTouches].find((c) => c.identifier === touch.id);
    if (!t) return;
    if (touch.painting) {
      e.preventDefault(); // we own this gesture now; don't scroll
      extend(indexAt(t.clientX, t.clientY));
    } else if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > SLOP_PX) {
      clearTimeout(touch.timer); // moved before the hold fired: it's a scroll
      touch = null;
    }
  }, { passive: false });

  const touchDone = (e) => {
    if (!touch) return;
    const was = touch;
    touch = null;
    clearTimeout(was.timer);
    if (was.painting) {
      end(e.type === 'touchend');
    } else if (e.type === 'touchend') {
      e.preventDefault(); // swallow the synthetic click
      toggle(was.i);
    }
  };
  root.addEventListener('touchend', touchDone);
  root.addEventListener('touchcancel', touchDone);
  root.addEventListener('contextmenu', (e) => {
    if (indexOf(e.target) != null) e.preventDefault();
  });

  // ---- taps when painting is off (group view) ----
  root.addEventListener('click', (e) => {
    if (enabled()) return;
    const i = indexOf(e.target);
    if (i != null) onActivate?.(i);
  });

  // ---- keyboard: arrows move, space/enter toggles ----
  root.addEventListener('keydown', (e) => {
    const i = indexOf(e.target);
    if (i == null) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (enabled()) toggle(i);
      else onActivate?.(i);
      return;
    }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    const j = dir && neighbor?.(i, dir);
    if (j == null) return;
    e.preventDefault();
    const from = root.querySelector('[data-i][tabindex="0"]');
    const to = root.querySelector(`[data-i="${j}"]`);
    if (!to) return;
    if (from) from.tabIndex = -1;
    to.tabIndex = 0;
    to.focus();
  });
}

function firstDayOfWeek() {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7; // 7 = Sunday → 0
  } catch { /* fall through */ }
  return 0;
}

const WEEKDAY_NAMES = (() => {
  // 2023-01-01 was a Sunday.
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, d) => fmt.format(new Date(Date.UTC(2023, 0, 1 + d))));
})();

export function weekHeader(weekStart = firstDayOfWeek()) {
  return h('div', { class: 'week-head', 'aria-hidden': 'true' },
    Array.from({ length: 7 }, (_, c) => h('span', null, WEEKDAY_NAMES[(weekStart + c) % 7])));
}

export { firstDayOfWeek };

/**
 * Days × time-slots grid.
 * Returns { el, cells, per, region, neighbor, dayHeads, timeHeads }.
 */
export function buildTimesGrid(event, { hour12, altLabel } = {}) {
  const { dates, startMin, endMin, slotMin } = event;
  const per = (endMin - startMin) / slotMin;
  const el = h('div', { class: `tg slot-${slotMin}`, role: 'grid', 'aria-label': 'Availability grid' });
  el.style.setProperty('--cols', dates.length);

  const cells = new Array(dates.length * per);
  const dayHeads = [];
  const timeHeads = [];

  el.append(h('div', { class: 'tg-corner', style: { gridColumn: 1, gridRow: 1 } }));

  dates.forEach((date, d) => {
    const gap = d > 0 && epochDay(date) - epochDay(dates[d - 1]) > 1;
    const showMonth = d === 0 || date.slice(0, 7) !== dates[d - 1].slice(0, 7);
    const head = h('button', {
      type: 'button',
      class: `tg-day${gap ? ' gap' : ''}`,
      style: { gridColumn: d + 2, gridRow: 1 },
      dataset: { d },
      title: `Toggle all of ${fmtDate(date)}`,
    },
      h('span', { class: 'mon' }, showMonth ? fmtDate(date, { month: 'short' }) : ' '),
      h('span', { class: 'dow' }, fmtDate(date, { weekday: 'short' })),
      h('span', { class: 'dom' }, fmtDate(date, { day: 'numeric' })),
    );
    dayHeads.push(head);
    el.append(head);
  });

  for (let s = 0; s < per; s++) {
    const min = startMin + s * slotMin;
    const onHour = min % 60 === 0;
    const label = h('button', {
      type: 'button',
      class: `tg-time${onHour ? ' hour' : ''}`,
      style: { gridColumn: 1, gridRow: s + 2 },
      dataset: { s },
      tabIndex: -1,
      title: `Toggle ${fmtTime(min, { hour12 })} on every day`,
    });
    if (onHour || s === 0) {
      label.append(h('span', { class: 't' }, fmtTime(min, { hour12, compact: true })));
      const alt = altLabel?.(min);
      if (alt) label.append(h('span', { class: 'alt' }, alt));
    }
    timeHeads.push(label);
    el.append(label);

    dates.forEach((date, d) => {
      const i = d * per + s;
      const gap = d > 0 && epochDay(date) - epochDay(dates[d - 1]) > 1;
      const cell = h('div', {
        class: `cell${onHour ? ' hour' : ''}${gap ? ' gap' : ''}${s === 0 ? ' first' : ''}${s === per - 1 ? ' last' : ''}`,
        role: 'gridcell',
        tabIndex: i === 0 ? 0 : -1,
        style: { gridColumn: d + 2, gridRow: s + 2 },
        dataset: { i },
      });
      cells[i] = cell;
      el.append(cell);
    });
  }

  const region = (a, b) => {
    const [d0, d1] = [Math.floor(a / per), Math.floor(b / per)].sort((x, y) => x - y);
    const [s0, s1] = [a % per, b % per].sort((x, y) => x - y);
    const out = [];
    for (let d = d0; d <= d1; d++) for (let s = s0; s <= s1; s++) out.push(d * per + s);
    return out;
  };
  const neighbor = (i, dir) => {
    const d = Math.floor(i / per), s = i % per;
    if (dir === 'up') return s > 0 ? i - 1 : null;
    if (dir === 'down') return s < per - 1 ? i + 1 : null;
    if (dir === 'left') return d > 0 ? i - per : null;
    return d < dates.length - 1 ? i + per : null;
  };

  return { el, cells, per, region, neighbor, dayHeads, timeHeads };
}

/**
 * Calendar-style grid of whole days. Only weeks containing candidate dates are
 * drawn; a divider marks skipped weeks.
 */
export function buildDaysGrid(event) {
  const weekStart = firstDayOfWeek();
  const days = event.dates.map(epochDay);
  const indexByDay = new Map(days.map((d, i) => [d, i]));
  const weekOf = (d) => d - ((weekday(event.dates[indexByDay.get(d)]) - weekStart + 7) % 7);
  const weeks = [...new Set(days.map(weekOf))].sort((a, b) => a - b);

  const el = h('div', { class: 'dg', role: 'grid', 'aria-label': 'Availability calendar' });
  el.append(weekHeader(weekStart));
  const cells = new Array(days.length);
  const body = h('div', { class: 'dg-body' });
  el.append(body);

  let prevWeek = null;
  let monthShown = null;
  for (const w of weeks) {
    if (prevWeek != null && w - prevWeek > 7) body.append(h('div', { class: 'dg-skip', 'aria-hidden': 'true' }, h('span')));
    prevWeek = w;
    for (let c = 0; c < 7; c++) {
      const day = w + c;
      const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
      const i = indexByDay.get(day);
      const month = date.slice(0, 7);
      const dom = Number(date.slice(8));
      if (i == null) {
        body.append(h('div', { class: 'day off', 'aria-hidden': 'true' }, h('span', { class: 'num' }, dom)));
        continue;
      }
      const showMonth = month !== monthShown;
      monthShown = month;
      const cell = h('div', {
        class: 'cell day',
        role: 'gridcell',
        tabIndex: i === 0 ? 0 : -1,
        dataset: { i },
      },
        h('span', { class: 'mon' }, showMonth ? fmtDate(date, { month: 'short' }) : ''),
        h('span', { class: 'num' }, dom),
        h('span', { class: 'meta' }),
      );
      cells[i] = cell;
      body.append(cell);
    }
  }

  const region = (a, b) => {
    const out = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
    return out;
  };
  const neighbor = (i, dir) => {
    if (dir === 'left') return i > 0 ? i - 1 : null;
    if (dir === 'right') return i < days.length - 1 ? i + 1 : null;
    const step = dir === 'up' ? -7 : 7;
    for (let d = days[i] + step; d >= days[0] && d <= days[days.length - 1]; d += step) {
      if (indexByDay.has(d)) return indexByDay.get(d);
    }
    return null;
  };

  return { el, cells, per: 1, region, neighbor, dayHeads: [], timeHeads: [] };
}

/**
 * Month view for picking candidate dates on the create form.
 * `month` is a 'YYYY-MM' string. Cells use the epoch-day number as data-i.
 */
export function buildMonth(month, { min, isOn }) {
  const weekStart = firstDayOfWeek();
  const first = `${month}-01`;
  const start = parseDate(first);
  const year = Number(month.slice(0, 4)), mon = Number(month.slice(5));
  const daysIn = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const lead = (weekday(first) - weekStart + 7) % 7;

  const body = h('div', { class: 'dg-body' });
  for (let k = 0; k < lead; k++) body.append(h('div', { class: 'day blank' }));
  for (let d = 1; d <= daysIn; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const day = epochDay(date);
    const disabled = date < min;
    body.append(h('div', {
      class: `cell day pick${disabled ? ' disabled' : ''}${!disabled && isOn(day) ? ' on' : ''}`,
      role: 'gridcell',
      tabIndex: -1,
      'aria-label': fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' }),
      'aria-selected': !disabled && isOn(day) ? 'true' : 'false',
      'aria-disabled': disabled ? 'true' : null,
      dataset: disabled ? {} : { i: day },
    }, h('span', { class: 'num' }, d)));
  }
  return h('div', { class: 'month' },
    h('div', { class: 'month-name' }, new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(start))),
    weekHeader(weekStart),
    body,
  );
}
