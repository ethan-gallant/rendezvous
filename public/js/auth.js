// Sign-in. Google Identity Services hands the browser an ID token (name, email,
// photo and Workspace domain, nothing else); the server verifies it and sets a
// session cookie. Calendar access is a separate, optional grant (see gcal.js).

import { api, ApiError } from './api.js';
import { h, icon, openDialog, toast } from './ui.js';

export const session = {
  config: { googleClientId: '', devLogin: false },
  user: null,
};

const listeners = new Set();
export function onSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const RETURNING = 'rdv-returning';
function setUser(user) {
  session.user = user;
  try {
    if (user) localStorage.setItem(RETURNING, '1');
    else localStorage.removeItem(RETURNING);
  } catch { /* storage unavailable */ }
  for (const fn of [...listeners]) fn(user);
}

export async function initSession() {
  const s = await api('/session');
  session.config = s.config;
  session.user = s.user;
  if (!session.config.googleClientId) return;
  loadGis().catch(() => {});
  // Sessions are short on purpose. Someone who was signed in before is signed back in by Google
  // without a click (where the browser allows it), so a short session doesn't mean a daily prompt.
  let returning = false;
  try {
    returning = localStorage.getItem(RETURNING) === '1';
  } catch { /* storage unavailable */ }
  if (!session.user && returning) silentSignIn();
}

/** A Workspace `hd` hint for Google's account chooser when exactly one work domain applies. */
function hdHint(domains) {
  const pool = (domains.length ? domains : session.config.allowedDomains || []).filter((d) => d !== 'gmail.com');
  return pool.length === 1 ? { hd: pool[0] } : {};
}

function signInError(e) {
  if (e instanceof ApiError && e.code === 'domain_not_allowed') {
    return `This site only accepts ${(e.body.domains || []).map((d) => `@${d}`).join(' or ')} accounts.`;
  }
  if (e instanceof ApiError && e.code === 'invalid_token') return 'Google sign-in could not be verified. Please try again.';
  if (e instanceof ApiError && e.code === 'slow_down') return 'Too many attempts. Wait a minute and try again.';
  return 'Sign-in failed. Please try again.';
}

function silentSignIn() {
  loadGis().then((google) => {
    google.accounts.id.initialize({
      client_id: session.config.googleClientId,
      auto_select: true,
      use_fedcm_for_prompt: true,
      ...hdHint([]),
      callback: async ({ credential }) => {
        try {
          const { user } = await api('/auth/google', { method: 'POST', body: { credential } });
          setUser(user);
        } catch { /* they can still use the sign-in button */ }
      },
    });
    google.accounts.id.prompt();
  }).catch(() => {});
}

let gis;
export function loadGis() {
  gis ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => {
      gis = undefined;
      s.remove();
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.append(s);
  });
  return gis;
}

export async function signOut() {
  await api('/auth/logout', { method: 'POST' });
  try {
    window.google?.accounts.id.disableAutoSelect();
  } catch { /* GIS not loaded */ }
  setUser(null);
}

/**
 * Opens the sign-in sheet. Resolves with
 *   { type: 'user', user }   after Google (or local dev) sign-in,
 *   { type: 'guest', name }  when the event allows name-only answers,
 *   null                     if dismissed.
 */
export function openSignIn({ title = 'Sign in', reason = '', domains = [], allowGuest = false } = {}) {
  return openDialog((close) => {
    const error = h('p', { class: 'form-error', hidden: true });
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    const finish = (user) => {
      setUser(user);
      close({ type: 'user', user });
    };

    const limited = domains.length ? domains : session.config.allowedDomains || [];
    const googleSlot = h('div', { class: 'google-slot' });
    const body = h('div', { class: 'dialog-body signin' },
      h('h2', null, title),
      reason && h('p', { class: 'muted' }, reason),
      limited.length > 0 && h('p', { class: 'pill-note' }, icon('lock', 15), `Limited to ${limited.map((d) => `@${d}`).join(', ')} accounts`),
      googleSlot,
      error,
    );

    if (session.config.googleClientId) {
      googleSlot.append(h('div', { class: 'google-loading muted' }, 'Loading Google sign-in…'));
      loadGis().then((google) => {
        google.accounts.id.initialize({
          client_id: session.config.googleClientId,
          ux_mode: 'popup',
          ...hdHint(domains),
          callback: async ({ credential }) => {
            try {
              const { user } = await api('/auth/google', { method: 'POST', body: { credential } });
              finish(user);
            } catch (e) {
              fail(signInError(e));
            }
          },
        });
        googleSlot.replaceChildren();
        google.accounts.id.renderButton(googleSlot, {
          type: 'standard',
          theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          logo_alignment: 'left',
          width: Math.max(220, Math.min(340, googleSlot.clientWidth || 300)),
        });
      }).catch(() => {
        googleSlot.replaceChildren(h('p', { class: 'form-error' }, 'Google sign-in could not load. Check your connection or content blocker and try again.'));
      });
    } else {
      googleSlot.append(h('p', { class: 'setup-note' },
        'Google sign-in isn’t set up on this server yet. Set ', h('code', null, 'GOOGLE_CLIENT_ID'), ' to turn it on.'));
    }

    if (session.config.devLogin) {
      const email = h('input', { type: 'email', placeholder: 'you@example.com', required: true, autocomplete: 'off' });
      const name = h('input', { type: 'text', placeholder: 'Name (optional)', autocomplete: 'off' });
      body.append(h('form', {
        class: 'dev-login',
        onSubmit: async (e) => {
          e.preventDefault();
          try {
            const { user } = await api('/auth/dev', { method: 'POST', body: { email: email.value, name: name.value } });
            finish(user);
          } catch (err) {
            fail(signInError(err));
          }
        },
      }, h('span', { class: 'dev-tag' }, 'Local dev only'), email, name, h('button', { class: 'btn', type: 'submit' }, 'Dev sign-in')));
    }

    if (allowGuest) {
      const name = h('input', { type: 'text', placeholder: 'Your name', maxLength: 60, required: true, autocomplete: 'name' });
      body.append(
        h('div', { class: 'or' }, h('span', null, 'or')),
        h('form', {
          class: 'guest-form',
          onSubmit: (e) => {
            e.preventDefault();
            const value = name.value.trim();
            if (value) close({ type: 'guest', name: value });
          },
        }, name, h('button', { class: 'btn', type: 'submit' }, 'Continue with just a name')),
      );
    }

    body.append(h('p', { class: 'fine' }, icon('shield', 15),
      'Signing in shares your name, email and profile photo. Nothing else. Calendar access is a separate, optional step.'));
    return body;
  }, { className: 'signin-dialog' });
}

/** Resolves to the signed-in user, prompting if needed. Null if the prompt was dismissed. */
export async function requireUser(opts) {
  if (session.user) return session.user;
  const result = await openSignIn(opts);
  return result?.type === 'user' ? result.user : null;
}

export function reportApiError(e, fallback = 'Something went wrong. Please try again.') {
  const messages = {
    sign_in_required: 'Please sign in first.',
    not_configured: 'This server isn’t fully set up yet (a secret is missing).',
    slow_down: 'You’re going a bit fast. Wait a minute and try again.',
    too_many_events: 'You’ve created a lot of events today. Try again tomorrow.',
    event_full: 'This event has reached its response limit.',
    locked: 'The organizer has locked availability, so that can’t be changed right now.',
    too_many_polls: 'This event has as many day polls as it can hold. Delete one first.',
    bad_origin: 'Request blocked. Reload the page and try again.',
  };
  toast((e instanceof ApiError && messages[e.code]) || fallback);
}
