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
// - God view: The Powder Toy's own layout (Jakob's law: players know it), open
//   from the start and left open. From TPT's GameView.cpp:
//   - the category buttons, a column down the right edge stacked up from the
//     bottom (NotifyMenuListChanged: MenuButtons at WINDOWW-16 from WINDOWH-48 up),
//     with element search under them (the button at WINDOWW-16, WINDOWH-32);
//   - the open category's element buttons in one row along the bottom (30×18,
//     one pixel apart, at YRES+1), the first at the right by the categories and
//     the rest running left (NotifyToolListChanged: currentX -= 31). A row too
//     long for the screen slides with the mouse's x (updateToolButtonScroll), with
//     TPT's two-pixel position bar under it (scrollBar at YRES+21);
//   - hovering a category opens it (MenuButton's mouseEnterCallback; Deco needs a
//     click, needsClick); a hovered element's description is drawn just above the
//     bar, right-aligned left of the categories (ToolTip: Size.X-27, Size.Y-MENUSIZE-10),
//     a category's name level with its button.
//   TPT has no brush panel; ours (brush, flow, mode and the eyedropper, laid out
//   as Photoshop's options bar, below) sits at the left end of the bottom row,
//   where TPT puts its deco presets (NotifyColourPresetsChanged: currentX = 5). Picking an element or
//   painting closes nothing. The chevron atop the categories, or T, hides it; the
//   tab left in its place brings it back (settings.spawnBar).
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
      t.style.setProperty('--i', tiles.length);   // the bar lays them out right to left (styles.css)
      t.addEventListener('click', (e) => (e.altKey && it.id >= 0 && onTarget ? onTarget(it.id) : select(it)));
      t.addEventListener('pointerenter', () => { preview(it); if (bar) showTip(it.desc); });
      t.addEventListener('pointerleave', () => { preview(); hideTip(); });
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
        if (!bar) return;
        showTip(g.name, categories[i]);
        if (e.pointerType === 'mouse' && !e.buttons && g.name !== 'Deco' && !search.value && i !== category) openCategory(i);
      },
      pointerleave: () => hideTip(),
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

  // The brush options, compact the way Photoshop's options bar is (Jakob's law):
  // a Brush Preset picker (the tip and its size, a caret; a pop-up with the Size
  // slider and the tip shapes), a percentage field for Flow that drops a slider,
  // a blend Mode menu (Paint, Replace, Delete only, and the one element they keep
  // to), and the eyedropper. Pop-ups sit over the bar (under the first-person
  // menu's buttons), close on Esc, a click outside or a pick, and never keep the
  // keyboard, so Space still pauses.
  // Native sliders keep precise keyboard control; color belongs to the materials.
  const iconButton = (icon, label, title, onClick) => h('button.material-control', {
    type: 'button', title, 'aria-label': label, on: { click: onClick },
  }, h('span', { html: icon }));
  const caret = () => h('span.opt-caret', { html: ICON.chevDown });
  const optButton = (label, title, ...kids) => h('button.material-control.opt-btn', {
    type: 'button', title, 'aria-label': label, 'aria-haspopup': 'true', 'aria-expanded': 'false',
  }, ...kids, caret());
  const fill = (input) => input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);

  const pops = [];
  let openPop = null;
  function makePop(label, ...kids) {
    const el = h('div.bar-pop.panel', { role: 'dialog', 'aria-label': label, hidden: true }, ...kids);
    el.addEventListener('keydown', (e) => { if (e.code === 'Space') e.stopPropagation(); });
    // like the bar: a control used with the mouse doesn't keep the keyboard
    el.addEventListener('pointerup', () => {
      const f = document.activeElement;
      if (el.contains(f)) f.blur();   // (the click still lands: it doesn't need the focus)
    });
    pops.push(el);
    return el;
  }
  const POP_GAP_PX = 8;
  const POP_EDGE_PX = 8;
  function placePop(pop, button) {
    const r = button.getBoundingClientRect();
    pop.style.left = `${Math.max(POP_EDGE_PX, Math.min(r.left, innerWidth - pop.offsetWidth - POP_EDGE_PX))}px`;
    pop.style.top = `${bar ? r.top - pop.offsetHeight - POP_GAP_PX : r.bottom + POP_GAP_PX}px`;
  }
  function togglePop(pop, button) {
    const was = openPop?.pop === pop;
    closePop();
    if (was) return;
    openPop = { pop, button };
    pop.hidden = false;
    placePop(pop, button);
    button.setAttribute('aria-expanded', 'true');
  }
  function closePop() {
    if (!openPop) return;
    if (openPop.pop.contains(document.activeElement)) document.activeElement.blur();   // a pick hands Space back at once
    openPop.pop.hidden = true;
    openPop.button.setAttribute('aria-expanded', 'false');
    openPop = null;
  }
  addEventListener('pointerdown', (e) => {
    if (openPop && !openPop.pop.contains(e.target) && !openPop.button.contains(e.target)) closePop();
  }, true);
  addEventListener('keydown', (e) => {
    if (openPop && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePop(); }
  }, true);

  // 1. Brush: Photoshop's Brush Preset picker. [ ], Shift+scroll and B work as before.
  const TIP_SVG = [
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/></svg>',
  ];
  const brushTip = h('span.opt-tip');
  const brushValue = h('b.opt-value');
  const brushButton = optButton('Brush', 'Brush: size [ ] or Shift+scroll, shape B', brushTip, brushValue);
  const sizeOut = h('output');
  const size = h('input', { type: 'range', min: 1, max: 24, step: 1, 'aria-label': 'Brush size' });
  size.addEventListener('input', () => onBrushChange({ radius: +size.value }));
  const sizeLabel = h('span', { text: 'Size' });
  const shapeButton = (shape, name) => h('button.pop-shape', {
    type: 'button', title: `${name} brush (B)`, 'aria-label': `${name} brush`,
    on: { click: () => { onBrushChange({ shape }); closePop(); } },
  }, h('span', { html: TIP_SVG[shape] }), h('span', { text: name }));
  const shapeSphere = shapeButton(0, 'Sphere');
  const shapeCube = shapeButton(1, 'Cube');
  const brushPop = makePop('Brush',
    h('label.pop-range', {}, sizeLabel, size, sizeOut),
    h('div.pop-shapes.paint-only', { role: 'group', 'aria-label': 'Brush shape' }, shapeSphere, shapeCube));
  brushButton.addEventListener('click', () => togglePop(brushPop, brushButton));

  // 2. Flow: a Photoshop percentage field, its slider dropping from the caret
  const flowValue = h('b.opt-value');
  const flowButton = optButton('Flow', 'Flow', h('span.opt-icon.opt-gauge', { html: ICON.flow }), flowValue);
  const GAUGE_SWEEP_DEG = 240;   // the gauge icon's arc: its needle sweeps it from 0 to 100% flow
  const flowOut = h('output');
  const flow = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, 'aria-label': 'Flow' });
  flow.addEventListener('input', () => onBrushChange({ rate: +flow.value }));
  const flowPop = makePop('Flow', h('label.pop-range', {}, h('span', { text: 'Flow' }), flow, flowOut));
  flowButton.addEventListener('click', () => togglePop(flowPop, flowButton));

  // 3. Mode: Photoshop's blend Mode menu. TPT's replace mode (X, ; or Insert) and
  // specific delete (Delete, Ctrl+;), one at a time, and the element both keep to
  // (TPT's Ctrl+Alt-click on an element button; here Alt+click a tile or Alt+I).
  const MODES = [
    { key: 'paint', name: 'Paint', note: 'Fills air only', icon: ICON.paint, kbd: '', patch: { replace: false, specificDelete: false } },
    { key: 'replace', name: 'Replace', note: 'Paints over material', icon: ICON.replace, kbd: 'X', patch: { replace: true } },
    { key: 'delete', name: 'Delete only', note: 'The eraser takes only the target', icon: ICON.eraser, kbd: 'Del', patch: { specificDelete: true } },
  ];
  const modeOf = () => (settings.specificDelete ? MODES[2] : settings.replace ? MODES[1] : MODES[0]);
  const modeIcon = h('span.opt-icon');
  const modeName = h('b.opt-value.opt-name');   // named, as Photoshop's Mode: Normal is, so it doesn't read as a tool
  const modeDot = h('i.opt-dot');
  const modeButton = optButton('Mode', 'Mode: Paint, Replace (X) or Delete only (Delete)', modeIcon, modeName, modeDot);
  const modeItems = MODES.map((m) => h('button.pop-item', {
    type: 'button', role: 'menuitemradio', 'aria-label': m.name,
    on: { click: () => { onBrushChange(m.patch); closePop(); } },
  }, h('span.pop-item-icon', { html: m.icon }), h('span.pop-item-text', {}, h('b', { text: m.name }), h('small', { text: m.note })),
  m.kbd ? h('kbd', { text: m.kbd }) : null));
  const targetChip = h('i.material-target-chip');
  const targetName = h('span');
  const target = h('button.pop-target', {
    type: 'button', 'aria-label': 'Replace and delete target',
    title: 'Alt+click an element tile (or Alt+I over the world) to make it the only one replace and delete touch. Click to clear.',
    on: { click: () => { onBrushChange({ replaceTarget: -1 }); closePop(); } },
  }, h('span', { text: 'Only' }), targetChip, targetName);
  const modePop = makePop('Mode', h('div.pop-menu', { role: 'menu', 'aria-label': 'Mode' }, modeItems), target,
    h('p.pop-hint', { text: 'Alt+click a tile to keep to one element' }));
  modeButton.addEventListener('click', () => togglePop(modePop, modeButton));

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
  const dropper = iconButton(ICON.eyedropper, 'Eyedropper', 'Eyedropper (I)', () => onEyedropper?.());
  dropper.classList.add('opt-dropper');
  const decoPicker = createDecoPicker({ onToggle: () => onDecoToggle?.() });   // the deco tools' colour (TPT's DECO menu)
  const brush = h('div.material-brush', { role: 'group', 'aria-label': 'Brush controls' },
    brushButton,
    h('div.paint-only.opt-group', {}, flowButton, modeButton),
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
  // the bar's field opens from the search button and closes once it's left empty
  search.addEventListener('blur', () => { if (!search.value) dock.classList.remove('searching'); });
  const find = h('label.material-find', {}, h('span', { html: ICON.search }), search, h('kbd', { text: '/' }));
  const collapse = iconButton(ICON.chevUp, 'Hide elements', 'Hide elements (T)', () => setCollapsed(true));
  // phones: the bar is one tile wide, so its search and brush options open beside it
  const optsButton = iconButton(ICON.sphere, 'Brush options', 'Search and brush options', () => {
    dock.classList.toggle('opts');
    optsButton.setAttribute('aria-pressed', String(dock.classList.contains('opts')));
  });
  optsButton.classList.add('material-opts');
  optsButton.setAttribute('aria-pressed', 'false');
  // TPT's element search button, under its categories (the bar only)
  const railSearch = iconButton(ICON.search, 'Search for elements', 'Search for elements (/)', () => focusSearch());
  railSearch.classList.add('material-railsearch');
  const top = h('div.material-top', {}, rail, find, collapse, optsButton, railSearch);
  const side = h('aside.material-side', {}, detail, brush);
  // TPT's scroll bar under the row: where the row has slid to, when it is longer than the screen
  const scrollThumb = h('i');
  const scrollBar = h('div.bar-scroll', { 'aria-hidden': 'true' }, scrollThumb);
  const library = h('div.material-library#material-collection', {},
    h('div.material-heading', { 'aria-live': 'polite', 'aria-atomic': 'true' }, categoryName, count),
    collection, empty, scrollBar);
  const dock = h('section.dock.panel', { 'aria-label': 'Element picker' },
    top,
    h('div.material-body', {}, library, side));
  // TPT's tooltip: plain outlined text, no box (GameView::OnDraw, BlendTextOutline)
  const tip = h('div.bar-tip', { 'aria-hidden': 'true' });
  const TIP_GAP_PX = 10;   // TPT: Size.X-27 is 10 px left of its 17 px column; Size.Y-MENUSIZE-10 is 10 px above its bar
  const TIP_BUTTON_DY_PX = 3;   // a category's: level with its button (senderPosition.Y+3)
  function showTip(text, button) {
    tip.textContent = text;
    tip.style.right = `${innerWidth - top.getBoundingClientRect().left + TIP_GAP_PX}px`;
    const barTop = library.getBoundingClientRect().top - TIP_GAP_PX;
    const y = button ? Math.min(button.getBoundingClientRect().top + TIP_BUTTON_DY_PX, barTop - tip.offsetHeight) : barTop - tip.offsetHeight;
    tip.style.top = `${y}px`;
    tip.classList.add('show');
  }
  function hideTip() { tip.classList.remove('show'); }

  // The row slides with the mouse's x anywhere on the screen, as TPT's does
  // (updateToolButtonScroll: at the right edge the first elements show, at the
  // left the last), so the element under the pointer is settled before it gets
  // there. A wheel over the row and a finger's swipe scroll it too.
  const overflow = () => collection.scrollWidth - collection.clientWidth;
  addEventListener('pointermove', (e) => {
    if (!bar || e.pointerType !== 'mouse' || hidden() || overflow() <= 0) return;
    const r = collection.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    collection.scrollLeft = overflow() * f;
  }, { passive: true });
  collection.addEventListener('wheel', (e) => {
    if (!bar || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    collection.scrollLeft += e.deltaY;
  }, { passive: false });
  function syncScroll() {
    const o = overflow();
    scrollBar.hidden = !bar || o <= 0;
    if (scrollBar.hidden) return;
    const w = collection.clientWidth;
    scrollThumb.style.width = `${(w / collection.scrollWidth) * 100}%`;
    scrollThumb.style.left = `${(collection.scrollLeft / collection.scrollWidth) * 100}%`;
  }
  collection.addEventListener('scroll', syncScroll, { passive: true });

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
    if (bar && dock.contains(el) && !el.matches('input[type=search], input[type=text], input[type=color], select')) el.blur();
  });
  document.body.append(dock, tab, tip, ...pops);
  // --dock-bottom (styles.css): the pop-up menu tab's bottom edge, which what sits
  // under it clears (the open menu is an overlay, so it doesn't count); the bar
  // and its tab sit on the right, so there it is the toolbar's.
  // --spawn-bar-w: how much of the right edge the open bar takes, which the
  // frame stats, notices, killfeed and data legend step left of.
  const BAR_GAP_PX = 10;
  const root = document.documentElement.style;
  // --spawn-bar-h: how far up the open bar's bottom row reaches, which the hint,
  // frame stats and profiler sit above. (Layout sizes, not rects: the hide
  // animation moves the bar with a transform.)
  const edge = () => {
    root.setProperty('--dock-bottom', bar ? 'var(--bar-bottom)' : `${tab.offsetTop + tab.offsetHeight}px`);
    let w = 0, hgt = 0;
    if (bar && !hidden()) {
      w = innerWidth - dock.offsetLeft - dock.offsetWidth + top.offsetWidth + BAR_GAP_PX;
      hgt = innerHeight - dock.offsetTop - dock.offsetHeight + library.offsetHeight + BAR_GAP_PX;
    } else if (bar && !tab.hidden) w = innerWidth - tab.offsetLeft + BAR_GAP_PX;   // the tab in the corner
    root.setProperty('--spawn-bar-w', `${w}px`);
    root.setProperty('--spawn-bar-h', `${hgt}px`);
    document.body.classList.toggle('spawn-bar', bar && !hidden());
    syncScroll();
  };
  for (const el of [tab, dock, top, library, collection]) new ResizeObserver(edge).observe(el);
  addEventListener('resize', edge);

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
    collection.scrollLeft = collection.scrollWidth;   // (the bar's row back to its first elements, at the right)
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
    if (c) { preview(); hideTip(); closePop(); dock.classList.remove('opts', 'searching'); optsButton.setAttribute('aria-pressed', 'false'); }
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
    collapse.firstChild.innerHTML = bar ? ICON.chevDown : ICON.chevUp;
    tabChev.innerHTML = bar ? ICON.chevUp : ICON.chevDown;
    // the bar's tooltips are TPT's (showTip), so the browser's would only double them
    for (const { el, it } of tiles) el.title = bar ? '' : it.desc;
    categories.forEach((el, i) => { el.title = bar ? '' : PALETTE[i].name; });
    hideTip();
    closePop();
    apply();
    collection.scrollLeft = collection.scrollWidth;   // the bar's row starts at its first elements, on the right
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
    brushPop.classList.toggle('build', build);
    sizeLabel.textContent = build ? 'Scale' : 'Size';
    size.setAttribute('aria-label', build ? 'Construction size' : 'Brush size');
    size.value = settings.radius; sizeOut.textContent = settings.radius; fill(size);
    brushTip.innerHTML = build ? ICON.constructions : TIP_SVG[settings.shape];
    brushValue.textContent = settings.radius;
    brushButton.title = build ? 'Construction scale: [ ] or Shift+scroll' : 'Brush: size [ ] or Shift+scroll, shape B';
    const pct = `${Math.round(settings.rate * 100)}%`;
    flow.value = settings.rate; flowOut.textContent = pct; fill(flow); flowValue.textContent = pct;
    flowButton.style.setProperty('--flow-turn', `${(settings.rate - 0.5) * GAUGE_SWEEP_DEG}deg`);
    shapeSphere.setAttribute('aria-pressed', String(settings.shape === 0));
    shapeCube.setAttribute('aria-pressed', String(settings.shape === 1));
    const mode = modeOf();
    const tgt = ELEMENTS[settings.replaceTarget];
    modeIcon.innerHTML = mode.icon;
    modeName.textContent = mode.name;
    modeItems.forEach((el, i) => el.setAttribute('aria-checked', String(MODES[i] === mode)));
    modeDot.hidden = !tgt;
    modeDot.style.background = tgt?.color ?? '';
    modeButton.title = `Mode: ${mode.name}${tgt ? `, only ${tgt.name}` : ''}. Replace X, Delete only Delete`;
    modeButton.classList.toggle('on', mode !== MODES[0]);
    target.classList.toggle('set', !!tgt);
    targetChip.style.background = tgt?.color ?? '';
    targetName.textContent = tgt ? tgt.name : 'Any element';
    if (openPop) placePop(openPop.pop, openPop.button);
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
  function focusSearch() {
    if (spawnLocked) return;
    setCollapsed(false);
    dock.classList.add('searching');
    search.focus();
    search.select();
  }
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
    focusSearch,
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
