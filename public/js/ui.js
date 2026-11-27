// Tiny DOM helpers. All user-supplied text goes in as text nodes, never as HTML.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !k.startsWith('aria')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) add(el, kid);
    else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  share: '<path d="M12 15V4"/><path d="M8 7.5L12 3.5l4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.3A9.6 9.6 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.6 3.5M6.2 6.9C4 8.6 3 12 3 12s3.5 7 9 7c1.500 0 2.800-.4 4-1"/><path d="M10 10a3 3 0 0 0 4 4"/>',
  trash: '<path d="M4.500 7h15M9.500 7V4.500h5V7M6.500 7l.8 12a2 2 0 0 0 2 1.900h5.400a2 2 0 0 0 2-1.900l.8-12"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/>',
  pin: '<path d="M12 21s-6.500-5.600-6.500-11a6.500 6.500 0 0 1 13 0c0 5.400-6.500 11-6.500 11z"/><circle cx="12" cy="10" r="2.300"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.500V17A2.5 2.5 0 0 1 4 14.500z"/><path d="M8.500 9h7M8.500 12.500h4.500"/>',
  pencil: '<path d="M4 20l1-4L16.500 4.500a2.100 2.100 0 0 1 3 3L8 19z"/><path d="M14.500 6.500l3 3"/>',
  chevL: '<path d="M14.500 5.500L8 12l6.500 6.500"/>',
  chevR: '<path d="M9.500 5.500L16 12l-6.500 6.500"/>',
  spark: '<path d="M12 3.500l1.900 5.100 5.100 1.900-5.100 1.900L12 17.500l-1.900-5.100L5 10.500l5.100-1.900z"/><path d="M18.500 16.500l.7 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7z"/>',
  shield: '<path d="M12 3.500l7 2.500v5.500c0 4.300-2.900 7.600-7 9-4.100-1.400-7-4.700-7-9V6z"/><path d="M9 12l2.200 2.200L15.200 10"/>',
  undo: '<path d="M8 6.5L4 10.5l4 4"/><path d="M4.5 10.5H14a4.5 4.5 0 0 1 0 9h-3"/>',
  globe: '<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c2.500 2.700 2.500 14.300 0 17M12 3.500c-2.500 2.700-2.500 14.300 0 17"/>',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] || ''; // static strings from the table above only
  return svg;
}

const AVATAR_HUES = [152, 24, 268, 200, 340, 48, 176, 300];

export function avatar(person, size = 28) {
  const name = person?.name || '?';
  const box = h('span', { class: 'avatar', title: name, style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` } });
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  box.style.setProperty('--hue', AVATAR_HUES[hash % AVATAR_HUES.length]);
  box.append(initials || '?');
  if (person?.picture) {
    const img = h('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: person.picture });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

let toastHost;
export function toast(message, { action, onAction, ms = 4500 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: 'toast' }, h('span', null, message));
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.append(h('button', { class: 'toast-action', type: 'button', onClick: () => { close(); onAction?.(); } }, action));
  }
  toastHost.append(el);
  setTimeout(close, ms);
  return close;
}

let pill;
let pillTimer = 0;
/**
 * The floating "Saving… / Saved" marker at the top of the screen, so it is in view wherever on the
 * page someone just answered. 'saving' stays until replaced; 'saved' and 'error' fade on their own;
 * null hides it.
 */
export function saveStatus(state) {
  if (!pill) {
    pill = h('div', { class: 'save-pill', role: 'status', 'aria-live': 'polite' });
    document.body.append(pill);
  }
  clearTimeout(pillTimer);
  if (!state) return pill.classList.remove('show');
  pill.dataset.state = state;
  pill.replaceChildren(...{
    saving: [h('span', { class: 'dot pulse' }), 'Saving…'],
    saved: [icon('check', 16), 'Saved'],
    error: [icon('x', 16), 'Not saved'],
  }[state]);
  pill.classList.add('show');
  if (state !== 'saving') pillTimer = setTimeout(() => pill.classList.remove('show'), state === 'saved' ? 2200 : 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Modal built on <dialog>. Resolves with whatever `close(value)` is given, or null when dismissed. */
export function openDialog(build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `dialog ${className}` });
    let result = null;
    const close = (value = null) => {
      result = value;
      dlg.close();
    };
    dlg.append(
      h('button', { class: 'icon-btn dialog-x', type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('x')),
      build(close),
    );
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); }); // backdrop
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog({ title, text, confirm = 'Confirm', danger = false }) {
  return openDialog((close) => h('div', { class: 'dialog-body' },
    h('h2', null, title),
    h('p', { class: 'muted' }, text),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn ghost', type: 'button', onClick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onClick: () => close(true) }, confirm),
    ),
  )).then(Boolean);
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Ana", "Ana and Bo", "Ana, Bo and Cy", "Ana, Bo and 3 others". */
export function nameList(names, max = 4) {
  if (names.length <= 1) return names[0] || '';
  const shown = names.length > max ? names.slice(0, max - 1) : names.slice(0, -1);
  const rest = names.length > max ? `${names.length - shown.length} others` : names[names.length - 1];
  return `${shown.join(', ')} and ${rest}`;
}

export const isTouch = () => matchMedia('(hover: none)').matches;
