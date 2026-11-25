import { initSession, session, onSession, openSignIn, signOut } from './auth.js';
import { startRouter } from './router.js';
import { renderCreate, renderPrivacy } from './create.js';
import { renderEvent } from './event.js';
import { h, avatar, icon } from './ui.js';

const app = document.getElementById('app');
const account = h('div', { class: 'account' });
const main = h('main', { id: 'main' });

function logo() {
  const mark = h('span', { class: 'logo-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  return h('a', { class: 'logo', href: '/', 'data-link': '', 'aria-label': 'Rendezvous home' }, mark, h('span', null, 'rendezvous'));
}

function renderAccount() {
  const user = session.user;
  if (!user) {
    account.replaceChildren(h('button', { class: 'btn small', type: 'button', onClick: () => openSignIn({ title: 'Sign in' }) }, 'Sign in'));
    return;
  }
  const menu = h('details', { class: 'user-menu' },
    h('summary', { 'aria-label': `Account: ${user.name}` }, avatar(user, 32)),
    h('div', { class: 'user-pop' },
      h('div', { class: 'user-id' }, h('strong', null, user.name), h('span', { class: 'muted' }, user.email)),
      h('a', { class: 'menu-item', href: '/', 'data-link': '', onClick: () => menu.removeAttribute('open') }, icon('calendar', 16), 'Your events'),
      h('button', { class: 'menu-item', type: 'button', onClick: () => signOut() }, icon('x', 16), 'Sign out'),
    ),
  );
  account.replaceChildren(menu);
}

document.addEventListener('click', (e) => {
  const open = document.querySelector('.user-menu[open]');
  if (open && !open.contains(e.target)) open.removeAttribute('open');
});

let cleanup = null;
function route() {
  cleanup?.();
  cleanup = null;
  main.replaceChildren();
  document.title = 'Rendezvous · find the days that work';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  // /e/<event> is the event; /e/<event>/p/<poll> opens it at one of its day polls.
  const m = /^\/e\/([a-z0-9]{6,20})(?:\/p\/([a-z0-9]{6,20}))?$/.exec(path);
  if (m) cleanup = renderEvent(main, m[1], { pollId: m[2] || null });
  else if (path === '/') cleanup = renderCreate(main);
  else if (path === '/privacy') cleanup = renderPrivacy(main);
  else {
    main.append(h('section', { class: 'card empty-state' },
      h('h1', null, 'Nothing here'), h('p', { class: 'muted' }, 'That page doesn’t exist.'),
      h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Go home')));
  }
  scrollTo(0, 0);
}

async function boot() {
  try {
    await initSession();
  } catch {
    app.replaceChildren(h('p', { class: 'boot-error' }, 'Rendezvous couldn’t start. Please reload.'));
    return;
  }
  app.replaceChildren(
    h('header', { class: 'topbar' }, logo(), account),
    main,
    h('footer', { class: 'footer' },
      h('span', null, icon('shield', 15), 'Your calendar never leaves your browser.'),
      h('a', { href: '/privacy', 'data-link': '' }, 'What we store')),
  );
  renderAccount();
  onSession(renderAccount);
  startRouter(route);
}

boot();
