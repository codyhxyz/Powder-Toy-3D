import { h } from './dom.js';
import { logoMark } from './logo.js';
import { MAPS, mapByKey, mapsFor, isWorld, sizeTag } from '../maps.js';

// The start menu, Garry's Mod's New Game screen: gamemodes down the left, the
// maps built for the chosen one as square previews (public/maps, rendered by
// tools/map-thumbs.mjs) with each map's size tagged in its corner, and the
// picked map with Start along the bottom. The landing page (src/main.js), and
// over the game from the toolbar's Maps or Esc, with Resume.
//   modes                 the gamemodes to list (maps.js GAMEMODES, filtered by the build)
//   map, mode             the pick it opens on
//   onStart(map, mode)    Start (or a double-click, or Enter)
//   onResume()            Resume / Esc, over a running game
const THUMB = (key) => `/maps/${key}.webp`;
const STORE = 'powder-toy-3d:menu';   // the last gamemode and map picked here

export function createMenu({ modes, map, mode, onStart, onResume }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  let modeKey = modes.some((m) => m.key === (mode ?? saved.mode)) ? mode ?? saved.mode : modes[0].key;
  let pick = mapByKey(map) ?? mapByKey(saved.map) ?? MAPS[0];
  let inGame = false;
  let busy = false;

  const backdrop = h('div.mm-backdrop');
  const nav = h('nav.mm-modes', { 'aria-label': 'Gamemodes' });
  const modeTitle = h('h2');
  const modeDesc = h('p');
  const grid = h('div.mm-grid', { role: 'listbox', 'aria-label': 'Maps' });
  const pickThumb = h('img.mm-pick-thumb', { alt: '' });
  const pickName = h('div.mm-pick-name');
  const pickMeta = h('div.mm-pick-meta');
  const pickDesc = h('div.mm-pick-desc');
  const startBtn = h('button.mm-start', { type: 'button', on: { click: () => start() } });
  const resumeBtn = h('button.mm-resume', { type: 'button', text: 'Resume', on: { click: () => onResume?.() } });
  const loadName = h('div.mm-load-name');
  const loadMode = h('div.mm-load-mode');
  const loadStatus = h('div.mm-load-status');

  const el = h('div.mm', { role: 'dialog', 'aria-label': 'Maps' },
    backdrop,
    h('div.mm-shell', {},
      h('header.mm-top', {},
        h('div.mm-brand', { html: `${logoMark(30)}<span>Powder Toy 3D</span>` }),
        resumeBtn),
      h('div.mm-body', {},
        nav,
        h('section.mm-main', {},
          h('div.mm-mode-head', {}, modeTitle, modeDesc),
          grid)),
      h('footer.mm-bar', {},
        pickThumb,
        h('div.mm-pick', {}, h('div.mm-pick-line', {}, pickName, pickMeta), pickDesc),
        startBtn)),
    h('div.mm-load', {},
      h('div.mm-load-copy', {}, loadMode, loadName, loadStatus, h('div.mm-load-bar', {}, h('i')))));
  document.body.append(el);

  // a preview that isn't there (a map added since tools/map-thumbs.mjs last ran): the card's gradient shows
  const thumb = (m) => {
    const img = h('img', { src: THUMB(m.key), alt: '', loading: 'lazy', draggable: false });
    img.addEventListener('error', () => img.remove());
    return img;
  };

  function renderModes() {
    nav.replaceChildren(h('div.mm-label', { text: 'Gamemode' }), ...modes.map((m) => h('button.mm-mode', {
      type: 'button', 'aria-pressed': String(m.key === modeKey),
      on: { click: () => setMode(m.key) },
    }, h('span', { text: m.name }), h('small', { text: String(mapsFor(m.key).length) }))));
  }

  let cards = [];
  function renderMaps() {
    const mo = modes.find((m) => m.key === modeKey);
    modeTitle.textContent = mo.name;
    modeDesc.textContent = mo.desc;
    const list = mapsFor(modeKey);
    if (!list.includes(pick)) pick = list[0];
    cards = list.map((m) => {
      const card = h('button.mm-card', {
        type: 'button', role: 'option', 'data-map': m.key, title: m.desc,
        on: { click: () => select(m), dblclick: () => { select(m); start(); } },
      },
      h('div.mm-thumb', {}, thumb(m), h('span.mm-tag', { text: sizeTag(m), title: dimsText(m) })),
      h('div.mm-name', { text: m.name }));
      return { m, card };
    });
    grid.replaceChildren(...cards.map((c) => c.card));
    select(pick);
  }

  const dimsText = (m) => `${m.dims.join(' × ')} cells`;
  function select(m) {
    pick = m;
    for (const c of cards) c.card.setAttribute('aria-selected', String(c.m === m));
    pickThumb.src = THUMB(m.key);
    backdrop.style.backgroundImage = `url(${THUMB(m.key)})`;
    pickName.textContent = m.name;
    pickMeta.textContent = isWorld(m) ? `World · ${dimsText(m)}, simulated around you` : `Box · ${dimsText(m)}`;
    pickDesc.textContent = m.desc;
    startBtn.textContent = inGame ? 'Load map' : 'Start game';
  }

  function setMode(key) {
    modeKey = key;
    renderModes();
    renderMaps();
  }

  function start() {
    if (busy) return;
    try { localStorage.setItem(STORE, JSON.stringify({ mode: modeKey, map: pick.key })); } catch { /* ignore */ }
    onStart(pick.key, modeKey);
  }

  // arrows walk the grid (by its columns), Enter starts, Esc resumes
  function key(e) {
    if (!el.classList.contains('open')) return;
    e.stopPropagation();   // (capture phase on window: the game behind gets no keys)
    if (busy) return;
    const i = cards.findIndex((c) => c.m === pick);
    const cols = Math.max(1, Math.round(grid.clientWidth / (cards[0]?.card.offsetWidth || 1)));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (step) {
      e.preventDefault();
      const c = cards[Math.min(cards.length - 1, Math.max(0, i + step))];
      select(c.m);
      c.card.focus();
    } else if (e.key === 'Enter') {
      const b = e.target.closest?.('button');
      if (b && !b.dataset.map) return;   // another button: its own Enter clicks it
      e.preventDefault();
      start();
    } else if (e.key === 'Escape' && inGame) onResume?.();
  }
  for (const type of ['keydown', 'keyup']) addEventListener(type, (e) => (type === 'keydown' ? key(e) : el.classList.contains('open') && e.stopPropagation()), true);

  renderModes();
  renderMaps();

  return {
    // over the running game (inGame: Resume shows), on a map and gamemode
    open({ inGame: g = false, map: mk, mode: md } = {}) {
      inGame = g;
      busy = false;
      el.classList.toggle('in-game', g);
      el.classList.remove('loading');
      if (md && modes.some((m) => m.key === md)) modeKey = md;
      if (mapByKey(mk)) pick = mapByKey(mk);
      renderModes();
      renderMaps();
      el.classList.add('open');
      requestAnimationFrame(() => cards.find((c) => c.m === pick)?.card.focus({ preventScroll: true }));
      cards.find((c) => c.m === pick)?.card.scrollIntoView({ block: 'nearest' });
    },
    close() { el.classList.remove('open', 'loading'); busy = false; },
    // the loading screen: the map's preview, its name, and what is happening
    loading(status) {
      busy = true;
      const mo = modes.find((m) => m.key === modeKey);
      loadName.textContent = pick.name;
      loadMode.textContent = mo.name;
      loadStatus.textContent = status;
      el.classList.add('open', 'loading');
    },
    get isOpen() { return el.classList.contains('open'); },
  };
}
