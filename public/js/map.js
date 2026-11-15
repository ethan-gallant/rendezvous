// Map pieces for the optional "where can you get to?" question.
//
// Leaflet is vendored (public/vendor/leaflet) and only loaded when someone
// actually opens a map, so the tile server hears nothing from people who skip
// the question.

import { h, icon, plural } from './ui.js';
import { session } from './auth.js';

const WORLD = { lat: 25, lng: 0, zoom: 2 };
/** Radii a new pin starts with: ideal, fine, a stretch (km). */
const DEFAULT_RINGS = [5, 15, 40];
const MAX_KM = 150;
const RING_STYLE = [
  { color: '#0f7a3b', fillColor: '#0f7a3b', fillOpacity: 0.3, weight: 1.5 },
  { color: '#2f9e5b', fillColor: '#2fbf6b', fillOpacity: 0.18, weight: 1 },
  { color: '#6cc893', fillColor: '#6cc893', fillOpacity: 0.12, weight: 1, dashArray: '4 4' },
];
export const RING_NAMES = ['Ideal', 'Fine', 'A stretch'];

let leaflet;
function loadLeaflet() {
  leaflet ??= (async () => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' }));
    return import('/vendor/leaflet/leaflet-src.esm.js');
  })();
  leaflet.catch(() => { leaflet = undefined; });
  return leaflet;
}

/** Where a brand-new map question should open: near the organizer if we can tell, else the world. */
export function defaultView() {
  const g = session.config.geo;
  return g ? { lat: g.lat, lng: g.lng, zoom: 9 } : { ...WORLD };
}

const km = (n) => `${n} km`;
const snap = (n) => Math.round(n * 100) / 100; // ~1 km; the server rounds again regardless

async function makeMap(el, view, options = {}) {
  const L = await loadLeaflet();
  // No zoom animation: these maps get thrown away and rebuilt as answers change, and Leaflet's
  // animation timers fire into a removed map.
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.5, preferCanvas: true, zoomAnimation: false, fadeAnimation: false, ...options })
    .setView([view.lat, view.lng], view.zoom);
  map.attributionControl?.setPrefix(false);
  L.tileLayer(session.config.map.tiles, { attribution: session.config.map.attribution, maxZoom: 17 }).addTo(map);

  // Maps are created inside containers that may not be laid out yet, and are thrown away with them.
  const sizer = new ResizeObserver(() => map.invalidateSize());
  sizer.observe(el);
  const watcher = new MutationObserver(() => {
    if (el.isConnected) return;
    watcher.disconnect();
    sizer.disconnect();
    map.remove();
  });
  queueMicrotask(() => {
    if (el.isConnected) watcher.observe(document.body, { childList: true, subtree: true });
  });
  return { L, map };
}

function mapShell(extraClass = '') {
  const el = h('div', { class: `map ${extraClass}` }, h('span', { class: 'map-loading muted' }, 'Loading map…'));
  const fail = () => el.replaceChildren(h('span', { class: 'map-loading muted' }, 'The map couldn’t load. Check your connection and reload.'));
  return { el, fail, ready: () => el.querySelector('.map-loading')?.remove() };
}

/** Organizer: choose where the map opens for participants. */
export function viewPicker(view, onChange) {
  const shell = mapShell('small');
  const locate = h('button', { class: 'link', type: 'button' }, 'Centre on my location');
  makeMap(shell.el, view).then(({ map }) => {
    shell.ready();
    map.on('moveend', () => {
      const c = map.getCenter();
      onChange({ lat: c.lat, lng: c.lng, zoom: Math.round(map.getZoom()) });
    });
    locate.addEventListener('click', () => {
      // Asked for only on this click; the result just moves the map.
      navigator.geolocation?.getCurrentPosition(
        (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 10),
        () => { locate.textContent = 'Location unavailable. Drag the map instead'; },
        { maximumAge: 600_000, timeout: 8000 },
      );
    });
  }).catch(shell.fail);
  return h('div', { class: 'area-edit' },
    h('span', { class: 'q-hint' }, 'Drag and zoom to the region people will be coming from. Their map opens here.'),
    shell.el, locate);
}

/**
 * Participant: drop a pin roughly where you'll be and size three rings around
 * it. `value` is { lat, lng, r: [ideal, fine, stretch] } or undefined.
 * Shown collapsed until asked for, since this is the least important thing we ask.
 */
export function areaInput({ view, value, locked, onChange }) {
  const root = h('div', { class: 'area' });
  let current = value ? { lat: value.lat, lng: value.lng, r: [...value.r] } : null;

  const describe = () => (current
    ? `Pin placed · ideal within ${km(current.r[0])}, fine within ${km(current.r[1])}, a stretch up to ${km(current.r[2])}`
    : 'Skip this if you’d rather not say.');

  function collapsed() {
    root.replaceChildren(
      h('button', { class: 'btn', type: 'button', disabled: locked, onClick: open }, icon('pin', 16), current ? 'Change on the map' : 'Open the map'),
      h('span', { class: 'q-hint' }, describe()),
      // Said before anything is loaded, so opening the map is an informed choice.
      h('span', { class: 'q-hint' }, 'The map comes from OpenStreetMap. Opening it shares your IP address and the area you look at with them; nothing is loaded until you do.'));
  }

  function open() {
    const shell = mapShell();
    const hint = h('p', { class: 'q-hint' });
    const rows = h('div', { class: 'rings' });
    const remove = h('button', { class: 'link', type: 'button' }, 'Remove my pin');
    root.replaceChildren(shell.el, hint, rows,
      h('p', { class: 'fine' }, icon('shield', 15),
        'Saved to the nearest kilometre or so, never your exact spot. Use a nearby station or landmark instead of your address if you like.'),
      h('div', { class: 'foot-actions' }, remove));

    makeMap(shell.el, current ? { lat: current.lat, lng: current.lng, zoom: view.zoom } : view).then(({ L, map }) => {
      shell.ready();
      let marker = null;
      let circles = [];

      const emit = () => onChange(current ? { lat: current.lat, lng: current.lng, r: [...current.r] } : undefined);
      const fit = () => { if (circles[2]) map.fitBounds(circles[2].getBounds(), { padding: [12, 12], maxZoom: 13 }); };

      function draw() {
        hint.textContent = current
          ? 'Drag the pin to move it. Set how far you’d go below.'
          : 'Tap the map roughly where you’ll be coming from. Zoom in for a closer look.';
        remove.hidden = !current;
        rows.hidden = !current;
        marker?.remove();
        circles.forEach((c) => c.remove());
        circles = [];
        marker = null;
        if (!current) return;
        const at = [current.lat, current.lng];
        // Largest first so the smaller rings sit on top.
        circles = [2, 1, 0].map((k) => L.circle(at, { radius: current.r[k] * 1000, interactive: false, ...RING_STYLE[k] }).addTo(map)).reverse();
        marker = L.marker(at, { draggable: true, icon: L.divIcon({ className: 'pin', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
        marker.on('dragend', () => {
          const p = marker.getLatLng();
          current.lat = snap(p.lat);
          current.lng = snap(p.lng);
          draw();
          emit();
        });
      }

      function sliders() {
        rows.replaceChildren(...RING_NAMES.map((name, k) => {
          const out = h('output', null, km(current?.r[k] ?? DEFAULT_RINGS[k]));
          const input = h('input', {
            type: 'range', min: 1, max: MAX_KM, step: 1, value: current?.r[k] ?? DEFAULT_RINGS[k],
            'aria-label': `${name}: how far`,
            onInput: () => {
              const v = Number(input.value);
              current.r[k] = v;
              // Keep ideal ≤ fine ≤ a stretch by nudging the neighbours.
              for (let j = k + 1; j < 3; j++) current.r[j] = Math.max(current.r[j], current.r[j - 1]);
              for (let j = k - 1; j >= 0; j--) current.r[j] = Math.min(current.r[j], current.r[j + 1]);
              rows.querySelectorAll('input').forEach((el, j) => { el.value = current.r[j]; });
              rows.querySelectorAll('output').forEach((el, j) => { el.textContent = km(current.r[j]); });
              circles.forEach((c, j) => c.setRadius(current.r[j] * 1000));
            },
            onChange: () => { fit(); emit(); },
          });
          return h('label', { class: 'ring-row' },
            h('i', { class: `ring-sw r${k}` }),
            h('span', { class: 'ring-name' }, name, h('small', null, k === 2 ? ' up to ' : ' within '), out),
            input);
        }));
      }

      function placeAt(lat, lng) {
        if (current) {
          current.lat = snap(lat);
          current.lng = snap(lng);
        } else {
          current = { lat: snap(lat), lng: snap(lng), r: [...DEFAULT_RINGS] };
          sliders();
        }
        draw();
        fit();
        emit();
      }
      map.on('click', (e) => placeAt(e.latlng.lat, e.latlng.lng));
      remove.addEventListener('click', () => {
        current = null;
        draw();
        emit();
      });

      if (current) sliders();
      draw();
      if (current) fit();
    }).catch(shell.fail);
  }

  collapsed();
  return root;
}

/**
 * Organizer: where the group overlaps. `result` comes from the server:
 * { n, hidden? } | { n, grid, best, people? }.
 */
export function areaResults({ view, result, anon, min }) {
  if (result.hidden) {
    return h('p', { class: 'muted small' },
      `${plural(result.n, 'person has', 'people have')} placed a pin. The combined map appears once ${min} people have.`);
  }
  if (!result.n || !result.grid) return h('p', { class: 'muted small' }, 'Nobody has placed a pin yet.');

  const { grid, best, people } = result;
  const shell = mapShell();
  makeMap(shell.el, view).then(({ L, map }) => {
    shell.ready();
    const { s, w, dLat, dLng, size, cells } = grid;
    for (const [row, col, ideal, fine, stretch] of cells) {
      const reach = ideal + fine + stretch;
      L.rectangle([[s + row * dLat, w + col * dLng], [s + (row + 1) * dLat, w + (col + 1) * dLng]], {
        stroke: false, interactive: false, fillColor: ideal * 2 >= reach ? '#0f7a3b' : '#2fbf6b',
        fillOpacity: 0.1 + 0.55 * (reach / result.n),
      }).addTo(map);
    }
    for (const p of people || []) {
      L.circle([p.lat, p.lng], { radius: p.r[2] * 1000, color: '#18211b', weight: 1, dashArray: '3 5', fill: false, interactive: false }).addTo(map);
      L.circleMarker([p.lat, p.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#18211b', fillOpacity: 1 }).addTo(map)
        .bindTooltip(`${p.name}: ideal ${km(p.r[0])}, fine ${km(p.r[1])}, stretch ${km(p.r[2])}`);
    }
    if (best) {
      L.marker([best.lat, best.lng], { interactive: false, icon: L.divIcon({ className: 'pin best', html: '★', iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(map);
    }
    map.fitBounds([[s, w], [s + size * dLat, w + size * dLng]], { padding: [10, 10] });
  }).catch(shell.fail);

  return h('div', { class: 'area-results' },
    shell.el,
    h('p', { class: 'q-hint' }, best
      ? `★ marks the middle of the area the most people can reach: ${best.reach} of ${result.n}${best.ideal ? `, ideal for ${best.ideal}` : ''}. Darker means more people.`
      : 'No single area is within reach of two people yet.',
    anon ? ' Individual pins aren’t shown, and areas only one person can reach are left out.' : ' Dots are each person’s pin; hover one for their rings.'));
}

export function areaSummaryLine(result, min) {
  if (result.hidden) return `  (${result.n} placed a pin; shown once ${min} have)`;
  if (!result.best) return '  No overlapping area yet.';
  const b = result.best;
  return `  Best area around ${b.lat.toFixed(2)}, ${b.lng.toFixed(2)}: within reach for ${b.reach} of ${result.n}${b.ideal ? `, ideal for ${b.ideal}` : ''}.`;
}
