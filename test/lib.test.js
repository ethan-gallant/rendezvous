import test from 'node:test';
import assert from 'node:assert/strict';

import { zonedToUtc, utcToZoned, tzOffsetMs, fmtTime, addDays, epochDay, fromEpochDay, weekday } from '../public/js/lib/time.js';
import { tally, rankDays, rankWindows, slotCount, optionSlots } from '../public/js/lib/rank.js';
import { slotRanges, overlaps, busyMinutes, blocksByDefault, allDayToInstants, queryWindow } from '../public/js/lib/overlay.js';

const iso = (ms) => new Date(ms).toISOString();

test('zonedToUtc handles standard time, DST, and the transition days', () => {
  assert.equal(iso(zonedToUtc('2026-11-16', 9 * 60, 'America/Toronto')), '2026-11-16T14:00:00.000Z'); // EST
  assert.equal(iso(zonedToUtc('2026-07-01', 9 * 60, 'America/Toronto')), '2026-07-01T13:00:00.000Z'); // EDT
  // Fall back happened 2026-11-01 02:00 local; 09:00 that day is already EST.
  assert.equal(iso(zonedToUtc('2026-11-01', 9 * 60, 'America/Toronto')), '2026-11-01T14:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-01', 0, 'America/Toronto')), '2026-11-01T04:00:00.000Z'); // still EDT at midnight
  // Spring forward 2026-03-08.
  assert.equal(iso(zonedToUtc('2026-03-08', 9 * 60, 'America/Toronto')), '2026-03-08T13:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-01-10', 12 * 60, 'Asia/Kolkata')), '2026-01-10T06:30:00.000Z'); // half-hour zone
  assert.equal(iso(zonedToUtc('2026-01-10', 0, 'UTC')), '2026-01-10T00:00:00.000Z');
});

test('utcToZoned round-trips', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Adelaide']) {
    const ms = zonedToUtc('2026-11-16', 13 * 60 + 30, tz);
    assert.deepEqual(utcToZoned(ms, tz), { date: '2026-11-16', minutes: 13 * 60 + 30 });
  }
  assert.equal(tzOffsetMs(Date.UTC(2026, 0, 1), 'Asia/Tokyo'), 9 * 3600_000);
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(fromEpochDay(epochDay('2026-11-16')), '2026-11-16');
  assert.equal(weekday('2026-11-16'), 1); // Monday
  assert.equal(fmtTime(570), '9:30 AM');
  assert.equal(fmtTime(0), '12:00 AM');
  assert.equal(fmtTime(780, { compact: true }), '1PM');
  assert.equal(fmtTime(570, { hour12: false }), '09:30');
});

const days = { kind: 'days', tz: 'UTC', dates: ['2026-11-16', '2026-11-17', '2026-11-18'] };
const people = (...slots) => slots.map((s, i) => ({ name: `P${i}`, slots: s }));

test('rankDays orders by head-count and reports who is missing', () => {
  const r = people('110', '011', '010');
  assert.deepEqual([...tally(days, r)], [1, 3, 1]);
  const ranked = rankDays(days, r);
  assert.deepEqual(ranked.map((o) => o.date), ['2026-11-17', '2026-11-16', '2026-11-18']);
  assert.deepEqual(ranked[0].missing, []);
  assert.deepEqual(ranked[1].missing, [1, 2]);
  assert.deepEqual(ranked[1].free, [0]);
});

// One day, 9:00–12:00 in 30-minute slots → 6 slots.
const times = { kind: 'times', tz: 'UTC', dates: ['2026-11-16'], startMin: 540, endMin: 720, slotMin: 30 };

test('rankWindows finds the longest window per group and the peak window', () => {
  // A, B, C free all morning; D joins for 10:00–11:00 only.
  const r = people('111111', '111111', '111111', '001100');
  const w = rankWindows(times, r);
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].s0, w[0].s1, w[0].count], [2, 4, 4]);
  assert.deepEqual(w[0].missing, []);
  assert.deepEqual([w[1].s0, w[1].s1, w[1].count], [0, 6, 3]); // not fragmented around D
  assert.deepEqual(w[1].missing, [3]);
  assert.deepEqual(optionSlots(times, w[0]), [2, 3]);
});

test('rankWindows respects a minimum length and skips empty slots', () => {
  const r = people('110011', '100011');
  const all = rankWindows(times, r);
  assert.deepEqual(all.map((o) => [o.s0, o.s1, o.count]), [[4, 6, 2], [0, 1, 2]]);
  const long = rankWindows(times, r, { minSlots: 2 });
  assert.deepEqual(long.map((o) => [o.s0, o.s1, o.count]), [[4, 6, 2], [0, 2, 1]]);
  assert.deepEqual(rankWindows(times, people('000000')), []);
  assert.equal(slotCount(times), 6);
});

test('rankWindows caps windows per day so one day cannot crowd out the rest', () => {
  const two = { ...times, dates: ['2026-11-16', '2026-11-17'] };
  const r = people('101010' + '110000', '101010' + '110000');
  const w = rankWindows(two, r, { perDay: 2 });
  assert.equal(w.filter((o) => o.day === 0).length, 2);
  assert.equal(w[0].day, 1); // the longer window wins the tie on head-count
});

test('overlay maps calendar items onto slots in the event timezone', () => {
  const ev = { kind: 'times', tz: 'America/Toronto', dates: ['2026-11-16', '2026-11-17'], startMin: 540, endMin: 660, slotMin: 30 };
  const ranges = slotRanges(ev);
  assert.equal(iso(ranges.starts[0]), '2026-11-16T14:00:00.000Z');
  assert.equal(iso(ranges.ends[7]), '2026-11-17T16:00:00.000Z');

  const meeting = { id: 'm', start: Date.parse('2026-11-16T14:45:00Z'), end: Date.parse('2026-11-16T15:30:00Z') };
  const hit = overlaps(ranges, [meeting]).map((x) => x.length);
  assert.deepEqual(hit, [0, 1, 1, 0, 0, 0, 0, 0]); // 9:30 and 10:00 slots; ends exactly at 10:30

  const allDay = { id: 'a', allDay: true, ...allDayToInstants('2026-11-17', '2026-11-18', ev.tz) };
  assert.deepEqual(overlaps(ranges, [allDay]).map((x) => x.length), [0, 0, 0, 0, 1, 1, 1, 1]);

  const w = queryWindow(ev);
  assert.equal(iso(w.timeMin), '2026-11-16T05:00:00.000Z');
  assert.equal(iso(w.timeMax), '2026-11-18T05:00:00.000Z');
});

test('busyMinutes merges overlapping items per day', () => {
  const ranges = slotRanges(days);
  const at = (h) => Date.parse('2026-11-16T00:00:00Z') + h * 3600_000;
  const mins = busyMinutes(ranges, [
    { start: at(9), end: at(10) },
    { start: at(9.5), end: at(11) }, // overlaps the first: 9–11 = 120 min, not 150
    { start: at(23), end: at(25) }, // spills an hour into the next day
  ]);
  assert.deepEqual([...mins], [180, 60, 0]);
});

test('default blocking: meetings block timed events but not whole-day ones', () => {
  const meeting = { allDay: false, free: false, type: 'default' };
  const ooo = { allDay: false, free: false, type: 'outOfOffice' };
  const vacation = { allDay: true, free: false, type: 'default' };
  const birthday = { allDay: true, free: true, type: 'default' };
  assert.equal(blocksByDefault(times, meeting), true);
  assert.equal(blocksByDefault(days, meeting), false);
  assert.equal(blocksByDefault(days, ooo), true);
  assert.equal(blocksByDefault(days, vacation), true);
  assert.equal(blocksByDefault(days, birthday), false);
  assert.equal(blocksByDefault(times, birthday), false);
});

test('ties go to the organizer\'s preferred date', () => {
  const ev = { ...days, preferred: ['2026-11-18'] };
  const ranked = rankDays(ev, people('101', '101'));
  assert.deepEqual(ranked.map((o) => o.date), ['2026-11-18', '2026-11-16', '2026-11-17']);
  assert.equal(ranked[0].preferred, true);
  // ...but never ahead of a day more people can make.
  assert.equal(rankDays(ev, people('101', '100'))[0].date, '2026-11-16');

  const two = { ...times, dates: ['2026-11-16', '2026-11-17'], preferred: ['2026-11-17'] };
  const w = rankWindows(two, people('110000' + '110000'));
  assert.deepEqual(w.map((o) => [o.day, o.preferred]), [[1, true], [0, false]]);
});
