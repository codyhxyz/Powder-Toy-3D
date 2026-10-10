import { h, inkFor, luminance } from './dom.js';
import { ICON } from './icons.js';
import { PALETTE, itemByKey, toolById, isBuild, K } from '../elements.js';
import { mountTile, setTileSettings } from './tiles/live.js';
import { modelIcon } from '../pov/models.js';

const KIND_NAME = { [K.POWDER]: 'powder', [K.LIQUID]: 'liquid', [K.GAS]: 'gas', [K.SOLID]: 'solid' };
export const kindOf = (it) => (isBuild(it.id) ? 'build' : it.id < 0 ? 'tool' : KIND_NAME[it.kind]);

const TILE_PX = 44;     // .tile in styles.css
const BIG_TILE_PX = 56; // .tile.big

// A TPT-style element tile: the element's colour with its abbreviation. Element
// tiles draw a small scene of the element (tiles/); live ones run it on hover.
export function tile(it, cls = '', { live = false } = {}) {
  const t = h(`button.tile${cls}`, {
    type: 'button',
    'data-id': it.id,
    'data-kind': kindOf(it),
    'aria-label': it.name,
    style: { '--c': it.color, '--ink': inkFor(it.color) },
  }, h('span', { text: it.abbr }));
  if (luminance(it.color) <= 0.28) t.dataset.dark = '';
  if (it.id >= 0) mountTile(t, it, { px: cls.includes('big') ? BIG_TILE_PX : TILE_PX, live });
  if (it.model) iconLater(t, it.model);
  return t;
}

// A first-person tool's tile shows its hotbar icon (pov/models.js modelIcon),
// drawn when the page is idle rather than holding up the first frame.
const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1));
function iconLater(t, model) {
  idle(() => {
    try { t.replaceChildren(h('img.tile-icon', { src: modelIcon(model), alt: '', draggable: 'false' })); } catch { /* keep the abbreviation */ }
  });
}

// Bottom dock: brush controls, the element groups, search and collapse.
export function createDock({ settings, onSelect, onBrushChange, onHover, onEyedropper }) {
  setTileSettings(settings); // tiles run with the game's gravity, speed and flow
  const tiles = [];
  const groups = PALETTE.map((g) => {
    const items = g.items.map(itemByKey);
    const els = items.map((it) => {
      const t = tile(it, '', { live: true });
      t.addEventListener('click', () => onSelect(it.id));
      t.addEventListener('pointerenter', () => onHover?.(it.id));
      t.addEventListener('pointerleave', () => onHover?.(null));
      tiles.push({ el: t, it });
      return t;
    });
    return h('div.group', {}, h('h4', { text: g.name }), h('div.tiles', {}, els));
  });

  // brush controls
  const sizeOut = h('output');
  const size = h('input', { type: 'range', min: 1, max: 24, step: 1, 'aria-label': 'Brush size' });
  const flowOut = h('output');
  const flow = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, 'aria-label': 'Flow' });
  const shapeSphere = h('button.mini-btn', { type: 'button', title: 'Sphere brush (B)', html: ICON.sphere });
  const shapeCube = h('button.mini-btn', { type: 'button', title: 'Cube brush (B)', html: ICON.cube });
  const replace = h('button.mini-btn', { type: 'button', title: 'Replace mode: paint over existing material (X)', html: ICON.replace });
  const fill = (input) => input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  size.addEventListener('input', () => onBrushChange({ radius: +size.value }));
  flow.addEventListener('input', () => onBrushChange({ rate: +flow.value }));
  shapeSphere.addEventListener('click', () => onBrushChange({ shape: 0 }));
  shapeCube.addEventListener('click', () => onBrushChange({ shape: 1 }));
  replace.addEventListener('click', () => onBrushChange({ replace: !settings.replace }));

  // constructions only use the size; the rest of the panel explains how to place them
  const sizeLabel = h('span', { text: 'Brush size' });
  const brush = h('div.brush', {},
    h('h4', {}, sizeLabel, sizeOut), size,
    h('h4.paint-only', {}, 'Flow', flowOut), h('div.paint-only', {}, flow),
    h('div.row.paint-only', {}, shapeSphere, shapeCube, replace),
    h('p.build-only', { text: 'Click a surface to place it. It turns to face the camera.' }));

  // Utilities: each one a full-width row that shows its hotkey.
  const toolRow = (icon, label, key, title, on) => h('button.tool-btn', { type: 'button', title, on },
    h('span.ico', { html: icon }), h('span', { text: label }), h('kbd', { text: key }));
  const dropper = toolRow(ICON.eyedropper, 'Eyedropper', 'I', 'Eyedropper: click the scene to pick that element (I)',
    { click: () => onEyedropper?.() });
  const search = h('input.search', { type: 'search', placeholder: 'Find', 'aria-label': 'Find element', spellcheck: false });
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('blur', () => { if (!search.value) filter(''); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = tiles.find((t) => !t.el.classList.contains('dim'));
      if (first) onSelect(first.it.id);
      search.value = '';
      filter('');
      search.blur();
    }
    if (e.key === 'Escape') { search.value = ''; filter(''); search.blur(); }
    e.stopPropagation();
  });
  const find = h('label.find', {}, search, h('kbd', { text: '/' }));
  const collapse = toolRow(ICON.chevDown, 'Hide', 'T', 'Hide elements (T)', { click: () => setCollapsed(true) });
  const side = h('div.side', {}, h('h4', { text: 'Utilities' }), dropper, find, collapse);

  const dock = h('div.dock.panel', { role: 'toolbar', 'aria-label': 'Elements' }, brush, h('div.groups', {}, groups), side);

  let tabTile = h('span.tile');
  const tabName = h('b');
  const tab = h('button.dock-tab.panel', { type: 'button', title: 'Show elements (T)', on: { click: () => setCollapsed(false) } },
    tabTile, h('span', {}, tabName), h('kbd', { text: 'T' }));

  document.body.append(dock, tab);

  function filter(q) {
    q = q.trim().toLowerCase();
    for (const { el, it } of tiles) {
      const hit = !q || it.name.toLowerCase().includes(q) || it.abbr.toLowerCase().includes(q);
      el.classList.toggle('dim', !hit);
    }
  }

  function setCollapsed(c) {
    settings.dockCollapsed = c;
    dock.classList.toggle('collapsed', c);
    tab.classList.toggle('show', c);
  }

  function sync() {
    for (const { el, it } of tiles) el.classList.toggle('on', it.id === settings.tool);
    const it = toolById(settings.tool);
    const t = Object.assign(tile(it), { tabIndex: -1 });
    tabTile.replaceWith(t);
    tabTile = t;
    tabName.textContent = it.name;
    const build = isBuild(settings.tool);
    brush.classList.toggle('build', build);
    sizeLabel.textContent = build ? 'Size' : 'Brush size';
    size.value = settings.radius; sizeOut.textContent = settings.radius; fill(size);
    flow.value = settings.rate; flowOut.textContent = `${Math.round(settings.rate * 100)}%`; fill(flow);
    shapeSphere.classList.toggle('on', settings.shape === 0);
    shapeCube.classList.toggle('on', settings.shape === 1);
    replace.classList.toggle('on', settings.replace);
  }
  function setEyedropper(on) {
    dropper.classList.toggle('on', on);
    dropper.setAttribute('aria-pressed', on);
  }
  setCollapsed(!!settings.dockCollapsed);
  return {
    sync,
    setCollapsed,
    setEyedropper,
    toggle: () => setCollapsed(!settings.dockCollapsed),
    focusSearch: () => { setCollapsed(false); search.focus(); search.select(); },
    // scroll the first tile that `pick(item)` accepts into view (the tools menu: the first-person tools)
    reveal(pick) { tiles.find(({ it }) => pick(it))?.el.scrollIntoView({ block: 'nearest', inline: 'start' }); },
    get collapsed() { return !!settings.dockCollapsed; },
  };
}
