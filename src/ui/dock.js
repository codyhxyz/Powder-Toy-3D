import { h, inkFor, luminance } from './dom.js';
import { ICON } from './icons.js';
import { PALETTE, itemByKey, toolById, isBuild, isDecoTool, K, ELEMENTS, PROP_TOOL } from '../elements.js';
import { PROP_FIELDS, propIndex, parseProp } from '../editing.js';
import { mountTile, setTileSettings } from './tiles/live.js';
import { modelIcon } from '../pov/models.js';
import { createDecoPicker } from './decoPicker.js';

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

// by palette group name (elements.js PALETTE), so a new group can't shift the others' icons
const CATEGORY_ICONS = {
  Powders: ICON.powders, Liquids: ICON.liquids, Potions: ICON.flask, Gases: ICON.gases, Solids: ICON.cube, Explosives: ICON.explosives, Electronics: ICON.bolt, Radioactive: ICON.radioactive,
  Exotic: ICON.exotic, Tools: ICON.tools, Entities: ICON.person, Constructions: ICON.constructions, Deco: ICON.deco,
};

// The element menu has two layouts, picked by the camera:
// - God view: The Powder Toy's element bar, open from the start and left open.
//   TPT keeps a column of category buttons down the right edge (GameView.cpp
//   NotifyMenuListChanged: MenuButtons at WINDOWW-16) and the open category's
//   element buttons beside them. Ours are both on the right edge, the elements
//   in a slim column just left of the categories, so the bottom of the screen
//   stays clear (a bottom dock got in the way, 68e09c8). Brush options sit at the
//   top of that column. Picking an element or painting closes nothing; hovering a
//   category opens it, as TPT's MenuButton does unless "sticky categories" is on
//   (its Deco section needs a click: needsClick). The chevron at the top, or T,
//   hides it; the tab that takes its place brings it back (settings.spawnBar).
// - First person: Garry's Mod's spawn menu, shut until Q (pov/index.js setMenu),
//   then a panel under the toolbar with a tab strip of categories, a grid of big
//   icons and the tool-options pane on the right. It starts shut on every entry
//   and never changes the god-view bar.
// onTarget(id): an element tile Alt-clicked, the replace / delete target (TPT's
// Ctrl+Alt-click on an element button, GameView.cpp; Alt alone works too: a
// Mac's Ctrl-click is a right click). onLayout(): settings.spawnBar changed, to save.
export function createDock({ settings, onSelect, onBrushChange, onHover, onEyedropper, onDecoToggle, onTarget, onLayout }) {
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
  const headers = [];   // section headers (a group's sections), shown with their group
  PALETTE.forEach((g, group) => {
    const sectionOf = new Map(g.sections?.flatMap((s) => s.items.map((key, i) => [key, i === 0 ? s.name : null])) ?? []);
    for (const key of g.items) {
      const head = sectionOf.get(key);
      if (head) {
        const el = h('h5.material-section', { text: head });
        headers.push({ el, group });
        collection.append(el);
      }
      const it = itemByKey(key);
      const t = tile(it, '.material-swatch', { live: true });
      t.style.setProperty('--ink', luminance(it.color) > 0.179 ? '#000' : '#fff');
      t.title = it.desc;   // it starts with the name (docs/elements.md, "Descriptions")
      t.addEventListener('click', (e) => (e.altKey && it.id >= 0 && onTarget ? onTarget(it.id) : select(it)));
      t.addEventListener('pointerenter', () => preview(it));
      t.addEventListener('pointerleave', () => preview());
      t.addEventListener('focus', () => preview(it));
      t.addEventListener('blur', () => preview());
      tiles.push({ el: t, it, group });
      collection.append(t);
    }
  });

  const openCategory = (i) => {
    category = i;
    search.value = '';
    filter();
    preview();
  };
  const categories = PALETTE.map((g, i) => h('button.material-category', {
    type: 'button', title: g.name, 'aria-label': g.name, 'aria-controls': 'material-collection',
    style: { '--category-color': itemByKey(g.items[0]).color },
    on: {
      click: () => openCategory(i),
      // TPT's bar opens a category when the mouse passes over its button (GameView.cpp
      // MenuButton mouseEnterCallback), except Deco, which needs a click, and not
      // while a button is held. Not over a search being typed, which it would clear.
      pointerenter: (e) => {
        if (bar && e.pointerType === 'mouse' && !e.buttons && g.name !== 'Deco' && !search.value && i !== category) openCategory(i);
      },
    },
  }, h('span', { html: CATEGORY_ICONS[g.name] ?? ICON.cube }), h('span.category-name', { text: g.name })));
  const rail = h('div.material-categories', { role: 'group', 'aria-label': 'Material categories' }, categories);
  const RAIL_KEYS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };   // the tab strip runs across, the bar's column down
  rail.addEventListener('keydown', (e) => {
    const i = categories.indexOf(document.activeElement);
    if (i < 0 || !(e.key in RAIL_KEYS || e.key === 'Home' || e.key === 'End')) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? categories.length - 1
      : (i + RAIL_KEYS[e.key] + categories.length) % categories.length;
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
  // TPT's specific delete (Ctrl+; or Delete) and the element both modes keep to
  const specific = iconButton(ICON.eraser, 'Specific delete', 'Erase only the target element (Delete)',
    () => onBrushChange({ specificDelete: !settings.specificDelete }));
  specific.append(h('span', { text: 'Delete' }));
  const targetChip = h('i.material-target-chip');
  const targetName = h('span');
  const target = h('button.material-control.material-target', {
    type: 'button', 'aria-label': 'Replace and delete target',
    title: 'Alt+click an element tile (or Alt+I over the world) to make it the only one replace and delete touch. Click to clear.',
    on: { click: () => onBrushChange({ replaceTarget: -1 }) },
  }, targetChip, targetName);
  // TPT's Property tool window (PropertyTool.cpp): a property and the value to set it to
  const propField = h('select.prop-field', { 'aria-label': 'Property', on: { change: () => { onBrushChange({ propField: propField.value }); propValue.focus(); } } },
    PROP_FIELDS.map((f) => h('option', { value: f.key, text: f.label })));
  const propValue = h('input.prop-value', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'Value', 'aria-label': 'Value' });
  const propNote = h('p.prop-note', { 'aria-live': 'polite' });
  propValue.addEventListener('input', () => onBrushChange({ propText: propValue.value }));
  propValue.addEventListener('keydown', (e) => {
    // Enter is TPT's OK: back to the world, if the value reads
    // (the god-view bar stays open: only the pop-up menu closes)
    if (e.key === 'Enter' && propParsed().ok) { propValue.blur(); if (!bar) setCollapsed(true); }
    if (e.key === 'Escape') { propValue.blur(); if (!bar) setCollapsed(true); }
    e.stopPropagation();
  });
  const propParsed = () => parseProp(propIndex(settings.propField), settings.propText);
  const propPane = h('div.prop-only', {},
    h('label.prop-row', {}, h('span', { text: 'Set' }), propField),
    h('label.prop-row', {}, h('span', { text: 'To' }), propValue),
    propNote);
  const fill = (input) => input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  size.addEventListener('input', () => onBrushChange({ radius: +size.value }));
  flow.addEventListener('input', () => onBrushChange({ rate: +flow.value }));
  const sizeLabel = h('span', { text: 'Size' });
  const dropper = iconButton(ICON.eyedropper, 'Eyedropper', 'Pick an element from the world (I)', () => onEyedropper?.());
  const decoPicker = createDecoPicker({ onToggle: () => onDecoToggle?.() });   // the deco tools' colour (TPT's DECO menu)
  const brush = h('div.material-brush', { role: 'group', 'aria-label': 'Brush controls' },
    h('label.material-range', {}, sizeLabel, size, sizeOut),
    h('label.material-range.paint-only', {}, h('span', { text: 'Flow' }), flow, flowOut),
    h('div.material-shapes.paint-only', { role: 'group', 'aria-label': 'Brush shape' }, shapeSphere, shapeCube),
    h('div.paint-only.material-modes', {}, replace, specific, target),
    propPane,
    h('p.build-only', { text: 'Click a surface to place. Faces the camera.' }),
    decoPicker.el,
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
  const collapse = iconButton(ICON.chevUp, 'Hide elements', 'Hide elements (T)', () => setCollapsed(true));
  // phones: the bar is one tile wide, so its search and brush options open beside it
  const optsButton = iconButton(ICON.sphere, 'Brush options', 'Search and brush options', () => {
    dock.classList.toggle('opts');
    optsButton.setAttribute('aria-pressed', String(dock.classList.contains('opts')));
  });
  optsButton.classList.add('material-opts');
  optsButton.setAttribute('aria-pressed', 'false');
  const top = h('div.material-top', {}, rail, find, collapse, optsButton);
  const side = h('aside.material-side', {}, detail, brush);
  const dock = h('section.dock.panel', { 'aria-label': 'Element picker' },
    top,
    h('div.material-body', {},
      h('div.material-library#material-collection', {},
        h('div.material-heading', { 'aria-live': 'polite', 'aria-atomic': 'true' }, categoryName, count),
        collection, empty),
      side));

  const tabTile = h('span.dock-tab-swatch', { 'aria-hidden': 'true' });
  const tabName = h('b');
  const tabChev = h('span', { html: ICON.chevDown });
  const tab = h('button.dock-tab.panel', { type: 'button', title: 'Show elements (T)', on: { click: () => setCollapsed(false) } },
    tabTile, tabName, tabChev, h('kbd', { text: 'T' }));
  // Space activates a focused control, not the simulation's global pause shortcut.
  for (const el of [dock, tab]) el.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.stopPropagation();
  });
  // The bar stays open, so a button clicked on it mustn't keep the focus, or Space
  // (pause) would press it again. TPT's buttons never hold the keyboard. Typing fields keep it.
  dock.addEventListener('pointerup', () => {
    const el = document.activeElement;
    if (bar && dock.contains(el) && !el.matches('input[type=search], input[type=text], input[type=color], select')) requestAnimationFrame(() => el.blur());
  });
  document.body.append(dock, tab);
  // --dock-bottom (styles.css): the pop-up menu tab's bottom edge, which what sits
  // under it clears (the open menu is an overlay, so it doesn't count); the bar
  // and its tab sit on the right, so there it is the toolbar's.
  // --spawn-bar-w: how much of the right edge the open bar takes, which the
  // frame stats, notices, killfeed and data legend step left of.
  const BAR_GAP_PX = 10;
  const root = document.documentElement.style;
  const edge = () => {
    root.setProperty('--dock-bottom', bar ? 'var(--bar-bottom)' : `${tab.offsetTop + tab.offsetHeight}px`);
    root.setProperty('--spawn-bar-w', bar && !hidden() ? `${dock.offsetWidth + BAR_GAP_PX}px` : '0px');
  };
  new ResizeObserver(edge).observe(tab);
  new ResizeObserver(edge).observe(dock);

  function select(it) {
    onSelect(it.id);
    if (document.body.classList.contains('pov-on')) return;
    // TPT opens the Property tool's window when it is picked (PropertyTool::Select);
    // anything else leaves the bar as it is, as TPT's does
    if (it.id === PROP_TOOL) openProp();
  }
  function openProp() {
    setCollapsed(false);
    propValue.focus();
    propValue.select();
  }

  function preview(it = toolById(settings.tool)) {
    detailName.textContent = it.name;
    detailText.textContent = it.desc;
    detail.title = it.desc;
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
    for (const { el, group } of headers) el.hidden = !!q || group !== category;
    categories.forEach((button, i) => button.setAttribute('aria-pressed', String(!q && i === category)));
    categoryName.textContent = q ? 'Search results' : PALETTE[category].name;
    count.textContent = String(visible).padStart(2, '0');
    collection.setAttribute('aria-label', categoryName.textContent);
    empty.hidden = visible > 0;
    collection.hidden = visible === 0;
    collection.scrollTop = 0;
  }

  let spawnLocked = false;
  // bar: the god view's TPT bar (else first person's pop-up). Each layout keeps
  // its own open state: the bar's is a setting, the pop-up's starts shut each time.
  let bar = false;
  let popupOpen = false;
  const hidden = () => spawnLocked || (bar ? !settings.spawnBar : !popupOpen);
  function setCollapsed(c) {
    if (spawnLocked && (bar || !c)) return;   // (a locked bar keeps the player's choice for later)
    const moveFocus = (c ? dock : tab).contains(document.activeElement);
    if (bar) {
      if (settings.spawnBar === c) { settings.spawnBar = !c; onLayout?.(); }
    } else popupOpen = !c;
    apply();
    if (moveFocus && !tab.hidden) (c ? tab : categories[category]).focus({ preventScroll: true });
  }
  function apply() {
    const c = hidden();
    settings.dockCollapsed = c;
    dock.classList.toggle('collapsed', c);
    tab.classList.toggle('show', c);
    dock.inert = c;
    tab.inert = !c;
    tab.setAttribute('aria-expanded', String(!c));
    tab.hidden = spawnLocked;
    if (c) { preview(); dock.classList.remove('opts'); optsButton.setAttribute('aria-pressed', 'false'); }
    edge();
  }
  // which layout: the bar unless the body (first person) is on
  function layout() {
    const next = !document.body.classList.contains('pov-on');
    if (next === bar) return;
    bar = next;
    popupOpen = false;   // first person's menu starts shut on every entry
    dock.classList.toggle('bar', bar);
    tab.classList.toggle('bar', bar);
    if (bar) side.prepend(find); else top.insertBefore(find, collapse);   // the bar's search tops its options
    collapse.firstChild.innerHTML = bar ? ICON.chevRight : ICON.chevUp;
    search.placeholder = bar ? 'Search' : 'Find an element';   // (the bar's field is narrow)
    tabChev.innerHTML = bar ? ICON.chevLeft : ICON.chevDown;
    apply();
  }
  new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function sync() {
    for (const { el, it } of tiles) {
      el.classList.toggle('on', it.id === settings.tool);
      el.classList.toggle('target', it.id === settings.replaceTarget);
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
    brush.classList.toggle('deco', isDecoTool(settings.tool));
    decoPicker.sync();
    sizeLabel.textContent = build ? 'Scale' : 'Size';
    size.setAttribute('aria-label', build ? 'Construction size' : 'Brush size');
    size.value = settings.radius; sizeOut.textContent = settings.radius; fill(size);
    flow.value = settings.rate; flowOut.textContent = `${Math.round(settings.rate * 100)}%`; fill(flow);
    shapeSphere.setAttribute('aria-pressed', String(settings.shape === 0));
    shapeCube.setAttribute('aria-pressed', String(settings.shape === 1));
    replace.setAttribute('aria-pressed', String(settings.replace));
    specific.setAttribute('aria-pressed', String(!!settings.specificDelete));
    const tgt = ELEMENTS[settings.replaceTarget];
    target.classList.toggle('set', !!tgt);
    targetChip.style.background = tgt?.color ?? '';
    targetName.textContent = tgt ? `Only ${tgt.name}` : 'Any element';
    brush.classList.toggle('prop', settings.tool === PROP_TOOL);
    if (propField.value !== settings.propField) propField.value = settings.propField;
    if (document.activeElement !== propValue && propValue.value !== settings.propText) propValue.value = settings.propText;
    const parsed = propParsed();
    // the closed menu's tab names what the Property tool sets
    if (settings.tool === PROP_TOOL) tabName.textContent = parsed.ok ? `${it.name}: ${PROP_FIELDS[propIndex(settings.propField)].label} ${parsed.shown}` : `${it.name}: no value`;
    propValue.classList.toggle('bad', !parsed.ok);
    propNote.classList.toggle('bad', !parsed.ok);
    propNote.textContent = parsed.ok ? `Sets it to ${parsed.shown}. ${PROP_FIELDS[propIndex(settings.propField)].hint}.`
      : `${parsed.error}. ${PROP_FIELDS[propIndex(settings.propField)]?.hint ?? ''}`;
    preview();
  }
  function setEyedropper(on) {
    dropper.setAttribute('aria-pressed', String(on));
  }
  filter();
  sync();
  setEyedropper(false);
  bar = document.body.classList.contains('pov-on');   // so layout() runs once now
  layout();
  return {
    sync,
    setCollapsed,
    setEyedropper,
    setSpawnLocked(locked) {
      spawnLocked = !!locked;
      apply();
    },
    toggle: () => setCollapsed(!hidden()),
    // first person's Q menu closing (wire/pov.js): only ever the pop-up, even if
    // the body has already left (the bar keeps its own state)
    closeMenu() { popupOpen = false; if (!bar) apply(); },
    focusSearch: () => { if (spawnLocked) return; setCollapsed(false); search.focus(); search.select(); },
    openProp,
    // Q in first person opens the category containing the requested tool (false if no tile is it).
    reveal(pick) {
      layout();   // (the body may have come on this same task)
      if (spawnLocked) return false;
      const match = tiles.find(({ it }) => pick(it));
      if (!match) return false;
      category = match.group;
      search.value = '';
      filter();
      setCollapsed(false);
      match.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    },
    get collapsed() { return hidden(); },
  };
}
