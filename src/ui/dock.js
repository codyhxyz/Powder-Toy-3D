import { h, inkFor, luminance } from './dom.js';
import { ICON } from './icons.js';
import { PALETTE, itemByKey, toolById, isBuild, K } from '../elements.js';
import { mountTile, setTileSettings } from './tiles/live.js';

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
  return t;
}

const CATEGORY_ICONS = [ICON.powders, ICON.liquids, ICON.gases, ICON.cube, ICON.tools, ICON.person, ICON.constructions];

// A material drawer: categories above, swatches in the middle, brush below.
export function createDock({ settings, onSelect, onBrushChange, onHover, onEyedropper }) {
  setTileSettings(settings);
  let category = Math.max(0, PALETTE.findIndex((g) => g.items.some((key) => itemByKey(key).id === settings.tool)));
  let lastTool = settings.tool;
  const tiles = [];
  const categoryName = h('h4');
  const count = h('span.material-count');
  const detailName = h('b');
  const detailText = h('span');
  const detail = h('div.material-detail', {}, detailName, detailText);
  const empty = h('p.material-empty', { text: 'No matches. Try a name like water or glass.', hidden: true });
  const collection = h('div.material-swatches', { role: 'group', 'aria-label': 'Elements' });
  PALETTE.forEach((g, group) => {
    for (const key of g.items) {
      const it = itemByKey(key);
      const t = tile(it, '.material-swatch', { live: true });
      t.style.setProperty('--ink', luminance(it.color) > 0.179 ? '#000' : '#fff');
      t.title = `${it.name} — ${it.desc}`;
      t.addEventListener('click', () => select(it));
      t.addEventListener('pointerenter', () => preview(it));
      t.addEventListener('pointerleave', () => preview());
      t.addEventListener('focus', () => preview(it));
      t.addEventListener('blur', () => preview());
      tiles.push({ el: t, it, group });
      collection.append(t);
    }
  });

  const categories = PALETTE.map((g, i) => h('button.material-category', {
    type: 'button', title: g.name, 'aria-label': g.name, 'aria-controls': 'material-collection',
    style: { '--category-color': itemByKey(g.items[0]).color },
    on: { click: () => {
      category = i;
      search.value = '';
      filter();
      preview();
    } },
  }, h('span', { html: CATEGORY_ICONS[i] }), h('span.category-tip', { text: g.name })));
  const rail = h('div.material-categories', { role: 'group', 'aria-label': 'Material categories' }, categories);
  rail.addEventListener('keydown', (e) => {
    const i = categories.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? categories.length - 1
      : (i + (e.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
    categories[next].focus();
    categories[next].click();
  });

  // Native sliders keep precise keyboard control; color belongs to the materials.
  const sizeOut = h('output');
  const size = h('input', { type: 'range', min: 1, max: 24, step: 1, 'aria-label': 'Brush size' });
  const flowOut = h('output');
  const flow = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, 'aria-label': 'Flow' });
  const iconButton = (icon, label, title, onClick) => h('button.material-control', {
    type: 'button', title, 'aria-label': label, on: { click: onClick },
  }, h('span', { html: icon }));
  const shapeSphere = iconButton(ICON.sphere, 'Sphere brush', 'Sphere brush (B)', () => onBrushChange({ shape: 0 }));
  const shapeCube = iconButton(ICON.cube, 'Cube brush', 'Cube brush (B)', () => onBrushChange({ shape: 1 }));
  const replace = iconButton(ICON.replace, 'Replace mode', 'Paint over existing material (X)',
    () => onBrushChange({ replace: !settings.replace }));
  replace.append(h('span', { text: 'Replace' }));
  const fill = (input) => input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  size.addEventListener('input', () => onBrushChange({ radius: +size.value }));
  flow.addEventListener('input', () => onBrushChange({ rate: +flow.value }));
  const sizeLabel = h('span', { text: 'Size' });
  const dropper = iconButton(ICON.eyedropper, 'Eyedropper', 'Pick an element from the world (I)', () => onEyedropper?.());
  const brush = h('div.material-brush', { role: 'group', 'aria-label': 'Brush controls' },
    h('label.material-range', {}, sizeLabel, size, sizeOut),
    h('label.material-range.paint-only', {}, h('span', { text: 'Flow' }), flow, flowOut),
    h('div.material-shapes.paint-only', { role: 'group', 'aria-label': 'Brush shape' }, shapeSphere, shapeCube),
    h('div.paint-only', {}, replace),
    h('p.build-only', { text: 'Click a surface to place. Faces the camera.' }),
    dropper);

  const search = h('input.search', { type: 'search', placeholder: 'Find an element', 'aria-label': 'Find element', spellcheck: false });
  search.addEventListener('input', () => filter());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = tiles.find((t) => !t.el.hidden);
      if (first) {
        search.value = '';
        category = first.group;
        select(first.it);
        filter();
        if (!settings.dockCollapsed) first.el.focus();
      }
    }
    if (e.key === 'Escape') {
      search.value = '';
      filter();
      categories[category].focus();
    }
    e.stopPropagation();
  });
  const find = h('label.material-find', {}, h('span', { html: ICON.search }), search, h('kbd', { text: '/' }));
  const collapse = iconButton(ICON.chevDown, 'Hide elements', 'Hide elements (T)', () => setCollapsed(true));
  const dock = h('section.dock.panel', { 'aria-label': 'Element picker' },
    h('div.material-top', {}, rail, find, collapse),
    h('div.material-library#material-collection', {},
      h('div.material-heading', { 'aria-live': 'polite', 'aria-atomic': 'true' }, categoryName, count),
      collection, empty, detail),
    brush);

  const tabTile = h('span.dock-tab-swatch', { 'aria-hidden': 'true' });
  const tabName = h('b');
  const tab = h('button.dock-tab.panel', { type: 'button', title: 'Show elements (T)', on: { click: () => setCollapsed(false) } },
    tabTile, tabName, h('span', { html: ICON.chevUp }), h('kbd', { text: 'T' }));
  // Space activates a focused control, not the simulation's global pause shortcut.
  for (const el of [dock, tab]) el.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.stopPropagation();
  });
  document.body.append(dock, tab);

  function select(it) {
    onSelect(it.id);
    if (matchMedia('(hover: none) and (pointer: coarse)').matches) setCollapsed(true);
  }

  function preview(it = toolById(settings.tool)) {
    detailName.textContent = it.name;
    detailText.textContent = it.desc;
    detail.title = `${it.name} — ${it.desc}`;
    detail.style.setProperty('--material-color', it.color);
    onHover?.(it.id);
  }

  function filter() {
    const q = search.value.trim().toLowerCase();
    let visible = 0;
    for (const { el, it, group } of tiles) {
      const hit = q ? it.name.toLowerCase().includes(q) || it.abbr.toLowerCase().includes(q) : group === category;
      el.hidden = !hit;
      if (hit) visible++;
    }
    categories.forEach((button, i) => button.setAttribute('aria-pressed', String(!q && i === category)));
    categoryName.textContent = q ? 'Search results' : PALETTE[category].name;
    count.textContent = String(visible).padStart(2, '0');
    collection.setAttribute('aria-label', categoryName.textContent);
    empty.hidden = visible > 0;
    collection.hidden = visible === 0;
    collection.scrollTop = 0;
  }

  function setCollapsed(c) {
    const moveFocus = (c ? dock : tab).contains(document.activeElement);
    settings.dockCollapsed = c;
    dock.classList.toggle('collapsed', c);
    tab.classList.toggle('show', c);
    dock.inert = c;
    tab.inert = !c;
    tab.setAttribute('aria-expanded', String(!c));
    if (moveFocus) (c ? tab : categories[category]).focus({ preventScroll: true });
    if (c) preview();
  }

  function sync() {
    for (const { el, it } of tiles) {
      el.classList.toggle('on', it.id === settings.tool);
      el.setAttribute('aria-pressed', String(it.id === settings.tool));
    }
    const it = toolById(settings.tool);
    if (settings.tool !== lastTool) {
      lastTool = settings.tool;
      category = tiles.find((t) => t.it.id === settings.tool)?.group ?? category;
      filter();
    }
    tabTile.style.background = it.color;
    tabTile.textContent = it.abbr;
    tabTile.style.color = inkFor(it.color);
    tabName.textContent = it.name;
    tab.setAttribute('aria-label', `Show elements, ${it.name} selected`);
    const build = isBuild(settings.tool);
    brush.classList.toggle('build', build);
    sizeLabel.textContent = build ? 'Scale' : 'Size';
    size.setAttribute('aria-label', build ? 'Construction size' : 'Brush size');
    size.value = settings.radius; sizeOut.textContent = settings.radius; fill(size);
    flow.value = settings.rate; flowOut.textContent = `${Math.round(settings.rate * 100)}%`; fill(flow);
    shapeSphere.setAttribute('aria-pressed', String(settings.shape === 0));
    shapeCube.setAttribute('aria-pressed', String(settings.shape === 1));
    replace.setAttribute('aria-pressed', String(settings.replace));
    preview();
  }
  function setEyedropper(on) {
    dropper.setAttribute('aria-pressed', String(on));
  }
  filter();
  sync();
  setEyedropper(false);
  setCollapsed(!!settings.dockCollapsed);
  return {
    sync,
    setCollapsed,
    setEyedropper,
    toggle: () => setCollapsed(!settings.dockCollapsed),
    focusSearch: () => { setCollapsed(false); search.focus(); search.select(); },
    get collapsed() { return !!settings.dockCollapsed; },
  };
}
