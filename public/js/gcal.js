// Optional Google Calendar overlay.
//
// The access token is requested by, held in, and used from this browser tab
// only. It is never stored and never sent to the Rendezvous server; the two
// fetches below go straight to googleapis.com. Two levels of access, each its
// own Google scope, so "busy only" really cannot read event names:
//
//   busy     calendar.freebusy         "View your availability in your calendars"
//   details  calendar.events.readonly  "View events on all your calendars"

import { loadGis, session } from './auth.js';
import { allDayToInstants, queryWindow } from './lib/overlay.js';
import { addDays, zonedToUtc } from './lib/time.js';

export const SCOPES = {
  busy: 'https://www.googleapis.com/auth/calendar.freebusy',
  details: 'https://www.googleapis.com/auth/calendar.events.readonly',
};

const API = 'https://www.googleapis.com/calendar/v3';

export const calendarAvailable = () => !!session.config.googleClientId;

/** Must be called from a click handler: Google opens its consent popup. */
export async function requestCalendarToken(mode) {
  const google = await loadGis();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: session.config.googleClientId,
      scope: SCOPES[mode],
      hint: session.user?.email,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPES[mode])) return reject(new Error('scope_not_granted'));
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(err?.type || 'popup_failed')),
    });
    client.requestAccessToken();
  });
}

export function revokeCalendarToken(token) {
  try {
    window.google?.accounts.oauth2.revoke(token, () => {});
  } catch { /* best effort */ }
}

async function gfetch(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'token_expired' : `calendar_${res.status}`);
  return res.json();
}

/** Free/busy blocks on the primary calendar. No titles exist at this access level. */
export async function fetchBusy(token, event) {
  const { timeMin, timeMax } = queryWindow(event);
  const data = await gfetch(token, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  const cal = data.calendars?.primary;
  if (cal?.errors?.length) throw new Error('calendar_unavailable');
  return (cal?.busy || []).map((b, n) => ({
    id: `busy-${n}`, title: null, start: Date.parse(b.start), end: Date.parse(b.end),
    allDay: false, free: false, type: 'default',
  }));
}

/** Events on the primary calendar, minus ones you declined or that were cancelled. */
export async function fetchEvents(token, event) {
  const { timeMin, timeMax } = queryWindow(event);
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      fields: 'nextPageToken,items(id,summary,status,transparency,eventType,start,end,attendees(self,responseStatus))',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await gfetch(token, `/calendars/primary/events?${q}`);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items.map((it) => normalise(it, event.tz)).filter(Boolean);
}

function normalise(it, tz) {
  if (it.status === 'cancelled' || it.eventType === 'workingLocation') return null;
  if (it.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !!it.start?.date;
  const span = allDay
    ? allDayToInstants(it.start.date, it.end.date, tz)
    : { start: Date.parse(it.start?.dateTime), end: Date.parse(it.end?.dateTime) };
  if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) return null;
  return {
    id: it.id,
    title: it.summary || '(no title)',
    ...span,
    allDay,
    free: it.transparency === 'transparent',
    type: it.eventType || 'default',
  };
}

/**
 * Made-up calendar for local development (dev sign-in only), so the overlay
 * can be exercised without a Google project.
 */
export function sampleCalendar(event, mode) {
  const at = (date, min) => zonedToUtc(date, min, event.tz);
  const items = [];
  event.dates.forEach((date, d) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return;
    items.push({ id: `s-standup-${d}`, title: 'Team standup', start: at(date, 570), end: at(date, 600), allDay: false, free: false, type: 'default' });
    if (d % 2 === 0) items.push({ id: `s-11-${d}`, title: '1:1 with Priya', start: at(date, 660), end: at(date, 720), allDay: false, free: false, type: 'default' });
    if (d % 3 === 1) items.push({ id: `s-rev-${d}`, title: 'Design review', start: at(date, 840), end: at(date, 930), allDay: false, free: false, type: 'default' });
    if (d % 4 === 2) items.push({ id: `s-focus-${d}`, title: 'Focus block', start: at(date, 780), end: at(date, 900), allDay: false, free: true, type: 'focusTime' });
  });
  if (event.dates.length > 2) {
    const date = event.dates[2];
    items.push({ id: 's-ooo', title: 'Out of office: dentist + travel', ...allDayToInstants(date, addDays(date, 1), event.tz), allDay: true, free: false, type: 'outOfOffice' });
  }
  if (event.dates.length > 4) {
    const date = event.dates[4];
    items.push({ id: 's-bday', title: 'Sam’s birthday', ...allDayToInstants(date, addDays(date, 1), event.tz), allDay: true, free: true, type: 'default' });
  }
  items.sort((a, b) => a.start - b.start);
  if (mode === 'details') return items;
  // Free/busy never includes titles or "free" events.
  return items.filter((it) => !it.free).map((it, n) => ({ ...it, id: `busy-${n}`, title: null, allDay: false, type: 'default' }));
}
