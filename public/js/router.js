let handler = () => {};

export function startRouter(onRoute) {
  handler = onRoute;
  addEventListener('popstate', () => handler());
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  handler();
}

export function navigate(path, state = null) {
  history.pushState(state, '', path);
  handler();
}
