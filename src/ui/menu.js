import { h } from './dom.js';
import { logoMark } from './logo.js';
import { MAPS, mapByKey, mapsFor, isWorld, sizeTag } from '../maps.js';
import { listSaves, getSave, putSave, deleteSave, downloadSave, pickSaveFile } from '../saves/local.js';
import { readSaveHeader } from '../saves/format.js';
import { MODEICONS, MODEICON_BOX } from './modeicons.js';
import { CELL_M } from '../scale.js';

// The start menu, Garry's Mod's New Game screen: gamemodes down the left, each
// with its icon, the maps built for the chosen one as square previews (public/maps, rendered by
// tools/map-thumbs.mjs) with each map's size tagged in its corner, and the
// picked map with Start along the bottom. One-click Play sits in the top bar
// (maps.js QUICK_PLAY): a match with your team picked, Halo 3 matchmaking's
// way. The landing page (src/main.js), and over the game from the toolbar's
// Maps or Esc, with Resume.
//   modes                 the gamemodes to list (maps.js GAMEMODES, filtered by the build)
//   quick                 the one-click Play entries (maps.js QUICK_PLAY; [] without the team games)
//   map, mode             the pick it opens on
//   onStart(map, mode)    Start (or a double-click, or Enter)
//   onResume()            Resume / Esc, over a running game
//   onLoadSave(what, meta) Load on the Saves list: a local save's id, or a save file's bytes (src/main.js)
//
// Below the gamemodes, Saves: Garry's Mod's main menu item of that name. The
// games you saved (⌘S, the toolbar's Save: saves/local.js) with their
// thumbnails, newest first; the picked one loads, exports as a file or is
// deleted, and Open file… loads a .tpt3d file (and keeps it in the list).
//
// Start turns it into the loading screen until the map is up: the map's art,
// the gamemode's emblem and rules (Halo 3's pre-game screen), the map's kind
// and size as a row of Halo 3 medals, the boot's real steps ticking by (GMod's
// loading screen), a tip (TF2's), and the player as he is ("This is you.":
// public/you.webp, tools/you-portrait.mjs).
//   loading(status, o)    the screen, with the game's line (src/main.js)
//   progress(step, text)  a boot step began (STEPS keys; 'cold': the shaders are compiling
//                         cold; 'match' with app.js's line for it)
const THUMB = (key) => `/maps/${key}.webp`;
const YOU = '/you.webp';
const STORE = 'powder-toy-3d:menu';   // the last gamemode and map picked here
// TF2 shows one tip a load; a wait long enough to read two (a world's first
// compile) gets a new one this often
const TIP_MS = 9000;

// The loading screen's status lines. GMod's loading screen ticks through the
// steps it is really on ("Retrieving server info", "Sending client info"...),
// and so does this one: the boot's own, in order, reported through progress()
// by src/main.js and app.js. Each is ticked, with the seconds it took, when
// the next one starts. world: only in a world; match: only in a gamemode that
// starts a match behind the screen (app.js bootReady: all but Sandbox).
const STEPS = [
  { key: 'fetch', text: () => 'Downloading the game' },
  { key: 'build', text: (m) => (isWorld(m) ? 'Setting up the simulation around you' : `Filling ${count(m)} cells`) },
  { key: 'compile', text: () => 'Compiling shaders' },
  { key: 'world', text: () => 'Generating the world', world: true },
  { key: 'match', text: () => 'Starting the match', match: true },
];
// a cold compile's note, said as app.js's close-up detail toast says it
const COLD_NOTE = 'The first time after an update, this can take several seconds.';
const MS_PER_S = 1000;

const count = (m) => m.dims.reduce((a, b) => a * b, 1).toLocaleString('en-US');
const dimsText = (m) => `${m.dims.join(' × ')} cells`;
const metres = (m) => `${m.dims.map((n) => Math.round(n * CELL_M)).join(' × ')} m`;

// a baked icon (tools/game-icons.mjs) as inline SVG, drawn in the text's colour
const iconSVG = (icon, box, cls) => (icon ? `<svg class="${cls}" viewBox="0 0 ${box} ${box}" aria-hidden="true"><path d="${icon.d}"/></svg>` : '');
const modeIcon = (key, cls) => iconSVG(MODEICONS[key], MODEICON_BOX, cls);
const iconEl = (tag, key, cls) => h(tag, { html: modeIcon(key, cls) });
// a Halo 3 medal: the icon on a coloured hexagon, its caption under it (menu.css .mm-medal)
const medal = (key, colour, caption) => h(`li.mm-medal.is-${colour}`, {}, iconEl('i', key, 'mm-ico'), h('span', { text: caption }));
const MB = 1024 * 1024;
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const SAVES_DESC = 'Games you saved with ⌘S or the toolbar\'s Save, kept in this browser. Export one to keep it as a file.';

export function createMenu({ modes, quick = [], map, mode, onStart, onResume, onLoadSave }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  let modeKey = modes.some((m) => m.key === (mode ?? saved.mode)) ? mode ?? saved.mode : modes[0].key;
  let pick = mapByKey(map) ?? mapByKey(saved.map) ?? MAPS[0];
  let inGame = false;
  let busy = false;
  let view = 'maps';            // 'maps': a gamemode's maps; 'saves': the Saves list
  let saveList = [], savePick = null, saveCards = [];

  const backdrop = h('div.mm-backdrop');
  const nav = h('nav.mm-modes', { 'aria-label': 'Gamemodes' });
  const modeEmblem = h('div.mm-emblem');
  const modeTitle = h('h2');
  const modeDesc = h('p');
  const grid = h('div.mm-grid', { role: 'listbox', 'aria-label': 'Maps' });
  const pickThumb = h('img.mm-pick-thumb', { alt: '' });
  const pickName = h('div.mm-pick-name');
  const pickMeta = h('div.mm-pick-meta');
  const pickDesc = h('div.mm-pick-desc');
  const startBtn = h('button.mm-start', { type: 'button', on: { click: () => start() } });
  const resumeBtn = h('button.mm-resume', { type: 'button', text: 'Resume', on: { click: () => onResume?.() } });
  // one-click Play: the first entry is the big one
  const quickBtns = quick.filter((q) => modes.some((m) => m.key === q.mode) && mapByKey(q.map)).map((q, i) =>
    h(`button.mm-play${i ? '' : '.main'}`, { type: 'button', 'data-play': q.key, title: `${q.name}: ${q.desc}`, on: { click: () => play(q) } },
      h('b', { text: q.name }), h('small', { text: q.desc })));
  const openFileBtn = h('button.mm-head-btn', { type: 'button', text: 'Open file…', title: 'Load a .tpt3d save file', on: { click: () => openFile() } });
  const exportBtn = h('button.mm-side', { type: 'button', text: 'Export', title: 'Download this save as a .tpt3d file', on: { click: () => exportPicked() } });
  const deleteBtn = h('button.mm-side', { type: 'button', text: 'Delete', on: { click: () => deletePicked() } });
  // the loading screen's parts
  const loadEmblem = h('div.mm-medal-big');
  const loadMode = h('div.mm-load-mode');
  const loadRules = h('div.mm-load-rules');
  const loadName = h('h1.mm-load-name');
  const loadDesc = h('p.mm-load-desc');
  const loadFacts = h('ul.mm-medals');
  const loadSteps = h('ol.mm-steps');
  const loadStatus = h('div.mm-load-status');
  const loadFill = h('i.mm-load-fill');
  const tipIcon = h('div.mm-tip-icon');
  const tipText = h('p.mm-tip-text');
  // (eager, at low priority: he must be there the moment Start is pressed, when the page is about to freeze compiling)
  const you = h('img', { src: YOU, alt: '', decoding: 'async', fetchpriority: 'low', draggable: false });
  // decoded while the menu is up: a fast boot freezes the page (the map build, the shaders) before an
  // undecoded image paints, and the caption then points at nothing
  you.decode?.().catch(() => {});
  you.addEventListener('error', () => you.closest('figure')?.remove());

  const el = h('div.mm', { role: 'dialog', 'aria-label': 'Maps' },
    backdrop,
    h('div.mm-shell', {},
      h('header.mm-top', {},
        h('div.mm-brand', { html: `${logoMark(30)}<span>Powder Toy 3D</span>` }),
        h('div.mm-top-actions', {}, quickBtns.length ? h('div.mm-quick', {}, quickBtns) : null, resumeBtn)),
      h('div.mm-body', {},
        nav,
        h('section.mm-main', {},
          h('div.mm-mode-head', {}, modeEmblem, h('div.mm-head-text', {}, h('div.mm-head-line', {}, modeTitle, openFileBtn), modeDesc)),
          grid)),
      h('footer.mm-bar', {},
        pickThumb,
        h('div.mm-pick', {}, h('div.mm-pick-line', {}, pickName, pickMeta), pickDesc),
        h('div.mm-actions', {}, exportBtn, deleteBtn, startBtn))),
    h('div.mm-load', { 'aria-live': 'polite' },
      h('div.mm-load-shade'),
      h('header.mm-load-top', {},
        h('div.mm-brand', { html: `${logoMark(26)}<span>Powder Toy 3D</span>` })),
      h('div.mm-load-stage', {},
        h('div.mm-load-copy', {},
          h('div.mm-load-head', {}, loadEmblem, h('div.mm-load-modeline', {}, loadMode, loadRules)),
          loadName, loadDesc, loadFacts),
        h('figure.mm-you', {}, you, h('figcaption', { text: 'This is you.' }))),
      h('footer.mm-load-foot', {},
        h('div.mm-load-progress', {}, loadSteps, loadStatus, h('div.mm-load-bar', {}, loadFill, h('i.mm-load-shine'))),
        h('aside.mm-tip', { 'aria-label': 'Tip' }, tipIcon, h('div.mm-tip-body', {}, h('b', { text: 'Tip' }), tipText)))));
  document.body.append(el);

  // a preview that isn't there (a map added since tools/map-thumbs.mjs last ran): the card's gradient shows
  const thumb = (m) => {
    const img = h('img', { src: THUMB(m.key), alt: '', loading: 'lazy', draggable: false });
    img.addEventListener('error', () => img.remove());
    return img;
  };

  function renderModes() {
    nav.replaceChildren(h('div.mm-label', { text: 'Gamemode' }), ...modes.map((m) => h('button.mm-mode', {
      type: 'button', 'aria-pressed': String(view === 'maps' && m.key === modeKey),
      on: { click: () => setMode(m.key) },
    }, iconEl('span.mm-mode-ico', m.key, 'mm-ico'), h('span.mm-mode-name', { text: m.name }), h('small', { text: String(mapsFor(m.key).length) }))),
    h('div.mm-label.mm-label-gap', { text: 'Your games' }),
    h('button.mm-mode', { type: 'button', 'aria-pressed': String(view === 'saves'), on: { click: () => showSaves() } },
      iconEl('span.mm-mode-ico', 'saves', 'mm-ico'), h('span.mm-mode-name', { text: 'Saves' }), h('small', { text: saveList.length ? String(saveList.length) : '' })));
  }

  let cards = [];
  function renderMaps() {
    el.classList.remove('saves-view');
    const mo = modes.find((m) => m.key === modeKey);
    modeEmblem.innerHTML = modeIcon(mo.key, 'mm-ico');
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

  function select(m) {
    pick = m;
    for (const c of cards) c.card.setAttribute('aria-selected', String(c.m === m));
    pickThumb.src = THUMB(m.key);
    backdrop.style.backgroundImage = `url(${THUMB(m.key)})`;
    pickName.textContent = m.name;
    pickMeta.innerHTML = modeIcon(isWorld(m) ? 'world' : 'box', 'mm-ico');
    pickMeta.append(isWorld(m) ? `World · ${dimsText(m)}, simulated around you` : `Box · ${dimsText(m)}`);
    pickDesc.textContent = m.desc;
    startBtn.textContent = inGame ? 'Load map' : 'Start game';
    startBtn.disabled = false;              // (an empty Saves list leaves it off)
    pickThumb.style.visibility = '';
  }

  function setMode(key) {
    modeKey = key;
    view = 'maps';
    renderModes();
    renderMaps();
  }

  // ---- Saves ----
  async function showSaves(select) {
    view = 'saves';
    try { saveList = await listSaves(); } catch (err) { saveList = []; console.warn('saves: storage unavailable', err); }
    if (view !== 'saves') return;
    savePick = saveList.find((x) => x.id === (select ?? savePick?.id)) ?? saveList[0] ?? null;
    renderModes();
    renderSaves();
  }

  function renderSaves() {
    el.classList.add('saves-view');
    modeEmblem.innerHTML = modeIcon('saves', 'mm-ico');
    modeTitle.textContent = 'Saves';
    modeDesc.textContent = SAVES_DESC;
    saveCards = saveList.map((sv) => {
      const img = sv.thumbnail ? h('img', { src: sv.thumbnail, alt: '', draggable: false }) : null;
      const card = h('button.mm-card', {
        type: 'button', role: 'option', title: sv.name,
        on: { click: () => pickSave(sv), dblclick: () => { pickSave(sv); start(); } },
      },
      h('div.mm-thumb', {}, img, h('span.mm-tag', { text: sv.world ? 'World' : (sv.dims ?? []).join('×') })),
      h('div.mm-name', { text: sv.name }),
      h('div.mm-date', { text: fmtDate(sv.created) }));
      return { sv, card };
    });
    if (saveCards.length) grid.replaceChildren(...saveCards.map((c) => c.card));
    else grid.replaceChildren(h('div.mm-empty', { text: 'No saves yet. In the game, ⌘S (Ctrl+S) or the toolbar\'s Save keeps one here.' }));
    pickSave(savePick);
  }

  function pickSave(sv) {
    savePick = sv;
    for (const c of saveCards) c.card.setAttribute('aria-selected', String(c.sv === sv));
    pickThumb.src = sv?.thumbnail ?? '';
    pickThumb.style.visibility = sv?.thumbnail ? '' : 'hidden';
    backdrop.style.backgroundImage = sv?.thumbnail ? `url(${sv.thumbnail})` : '';
    pickName.textContent = sv ? sv.name : 'No saves yet';
    pickMeta.textContent = sv ? [sv.mapName ?? 'Custom', sv.world ? 'World' : (sv.dims ?? []).join(' × '), `${(sv.bytes / MB).toFixed(1)} MB`].join(' · ') : '';
    pickDesc.textContent = sv ? `Saved ${fmtDate(sv.created)}` : '';
    startBtn.textContent = 'Load save';
    startBtn.disabled = exportBtn.disabled = deleteBtn.disabled = !sv;
  }

  function exportPicked() {
    const sv = savePick;
    if (!sv) return;
    getSave(sv.id).then((bytes) => downloadSave(bytes, sv.name), (err) => { modeDesc.textContent = `Couldn't export it: ${err.message}`; });
  }

  async function deletePicked() {
    const sv = savePick;
    if (!sv || !confirm(`Delete "${sv.name}"? It can't be brought back.`)) return;
    const i = saveList.indexOf(sv);
    try { await deleteSave(sv.id); } catch (err) { modeDesc.textContent = `Couldn't delete it: ${err.message}`; return; }
    savePick = saveList[i + 1] ?? saveList[i - 1] ?? null;
    showSaves(savePick?.id);
  }

  // a .tpt3d file: kept in the list (as TPT's local saves are its folder's files), then loaded
  async function openFile() {
    let bytes = null, header = null;
    try {
      bytes = await pickSaveFile();
      if (!bytes) return;
      header = readSaveHeader(bytes);
    } catch (err) { modeDesc.textContent = `That isn't a save this game can open (${err.message})`; return; }
    let meta = null;
    try { meta = await putSave(bytes); } catch (err) { console.warn('saves: could not keep the file in the list', err); }
    if (meta) await showSaves(meta.id);
    onLoadSave?.(meta ? meta.id : bytes, meta ?? { name: header.name, map: header.map, dims: header.dims, world: !!header.world });
  }

  function start() {
    if (busy) return;
    if (view === 'saves') {
      if (savePick) onLoadSave?.(savePick.id, savePick);
      return;
    }
    try { localStorage.setItem(STORE, JSON.stringify({ mode: modeKey, map: pick.key })); } catch { /* ignore */ }
    onStart(pick.key, modeKey);
  }
  // one-click Play: its gamemode and map picked (the loading screen names them), then Start
  function play(q) {
    if (busy) return;
    modeKey = q.mode;
    pick = mapByKey(q.map);
    renderModes();
    renderMaps();
    start();
  }

  // arrows walk the grid (by its columns), Enter starts, Esc resumes
  function key(e) {
    if (!el.classList.contains('open')) return;
    e.stopPropagation();   // (capture phase on window: the game behind gets no keys)
    if (busy) return;
    const list = view === 'saves' ? saveCards : cards;
    const i = view === 'saves' ? saveCards.findIndex((c) => c.sv === savePick) : cards.findIndex((c) => c.m === pick);
    const cols = Math.max(1, Math.round(grid.clientWidth / (list[0]?.card.offsetWidth || 1)));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (step && list.length) {
      e.preventDefault();
      const c = list[Math.min(list.length - 1, Math.max(0, i + step))];
      if (view === 'saves') pickSave(c.sv); else select(c.m);
      c.card.focus();
    } else if (e.key === 'Enter') {
      const b = e.target.closest?.('button');
      if (b && !b.dataset.map && !saveCards.some((c) => c.card === b)) return;   // another button: its own Enter clicks it
      e.preventDefault();
      start();
    } else if (e.key === 'Escape' && inGame) onResume?.();
  }
  for (const type of ['keydown', 'keyup']) addEventListener(type, (e) => (type === 'keydown' ? key(e) : el.classList.contains('open') && e.stopPropagation()), true);

  // ---- the loading screen
  let steps = [];        // this load's STEPS, each with its label and, once done, its ms
  let at = -1;           // the step under way
  let stepT0 = 0;
  let cold = false;      // the view's shaders are compiling cold (app.js's guard said so)
  let tips = null;       // ui/tips.js, once loaded
  let tipsLoad = null;
  let tipShown = -1;
  let tipTimer = 0;
  const loadTips = () => (tipsLoad ??= import('./tips.js').then((m) => { tips = m; }, () => {}));

  function renderSteps() {
    loadSteps.replaceChildren(...steps.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' },
      h('i.mm-step-mark'),
      h('span.mm-step-text', {}, s.label, i === at && s.key === 'compile' && cold ? h('em', { text: COLD_NOTE }) : null),
      h('b.mm-step-time', { text: s.ms == null ? '' : `${(s.ms / MS_PER_S).toFixed(1)} s` }))));
    loadFill.style.transform = `scaleX(${Math.max(at, 0) / steps.length})`;
  }

  function showTip() {
    if (!tips) return;
    const n = tips.TIPS.length;
    // a different one each time (TF2 never shows the same tip twice running)
    tipShown = (tipShown + 1 + Math.floor(Math.random() * (n - 1))) % n;
    const t = tips.TIPS[tipShown];
    tipIcon.innerHTML = iconSVG(tips.TIPICONS[t.icon], tips.TIPICON_BOX, 'mm-ico');
    tipText.textContent = t.text;
    el.classList.add('has-tip');
  }

  function stopTips() {
    clearInterval(tipTimer);
    tipTimer = 0;
  }

  renderModes();
  renderMaps();
  refreshCount();

  // the Saves count beside its button (a save made since the menu last showed)
  function refreshCount() { listSaves().then((l) => { saveList = l; if (view === 'maps') renderModes(); }, () => {}); }

  return {
    // over the running game (inGame: Resume shows), on a map and gamemode
    // saves: on the Saves list (⌘O)
    open({ inGame: g = false, map: mk, mode: md, saves = false } = {}) {
      inGame = g;
      busy = false;
      stopTips();
      el.classList.toggle('in-game', g);
      el.classList.remove('loading');
      if (md && modes.some((m) => m.key === md)) modeKey = md;
      if (mapByKey(mk)) pick = mapByKey(mk);
      view = 'maps';
      renderModes();
      renderMaps();
      if (saves) showSaves(); else refreshCount();
      el.classList.add('open');
      requestAnimationFrame(() => cards.find((c) => c.m === pick)?.card.focus({ preventScroll: true }));
      cards.find((c) => c.m === pick)?.card.scrollIntoView({ block: 'nearest' });
      // the tips, after the menu's first paint: they're for the loading screen
      requestAnimationFrame(() => setTimeout(loadTips));
    },
    close() { el.classList.remove('open', 'loading'); busy = false; stopTips(); },
    // the loading screen: the map, the gamemode, the steps, a tip, and you (on a pick of its
    // own: a link's ?map= and ?mode=, src/main.js); name: what is loading, if not the picked map (a save)
    loading(status, { map: mk, mode: md, name = null } = {}) {
      busy = true;
      if (md && modes.some((m) => m.key === md)) modeKey = md;
      if (mapByKey(mk)) { pick = mapByKey(mk); backdrop.style.backgroundImage = `url(${THUMB(pick.key)})`; }
      const mo = modes.find((m) => m.key === modeKey);
      const save = name != null;
      el.classList.toggle('load-save', save);   // (a save brings its own cells: no map's blurb or size)
      loadEmblem.innerHTML = modeIcon(save ? 'saves' : mo.key, 'mm-ico');
      loadMode.textContent = save ? 'Save' : mo.name;
      loadRules.textContent = !save && mo.key !== 'sandbox' ? mo.desc : '';   // the rules, as Halo 3 states a gametype's before the match
      loadName.textContent = name ?? pick.name;
      loadDesc.textContent = save ? '' : pick.desc;
      // the map's kind and size as a row of medals (the kind's colour: blue for a box, green for a world)
      loadFacts.replaceChildren(...(save ? [] : [
        medal(isWorld(pick) ? 'world' : 'box', isWorld(pick) ? 'green' : 'blue', isWorld(pick) ? 'World' : 'Box'),
        medal('cells', 'purple', dimsText(pick)),
        medal('metres', 'orange', metres(pick)),
      ]));
      loadStatus.textContent = status;
      const matchMode = !save && mo.key !== 'sandbox';
      steps = STEPS.filter((s) => (!s.world || (!save && isWorld(pick))) && (!s.match || matchMode))
        .map((s) => ({ key: s.key, label: s.text(pick), ms: null }));
      at = -1;
      cold = false;
      renderSteps();
      el.classList.remove('has-tip');
      loadTips().then(() => {
        if (!el.classList.contains('loading')) return;
        showTip();
        stopTips();
        tipTimer = setInterval(showTip, TIP_MS);
      });
      el.classList.add('open', 'loading');
    },
    // a boot step began (text: its line, if not STEPS' own: the match's, from app.js)
    progress(step, text) {
      if (!el.classList.contains('loading')) return;
      if (step === 'cold') { cold = true; renderSteps(); return; }
      const i = steps.findIndex((s) => s.key === step);
      if (i < 0) return;   // not this load's
      if (text) steps[i].label = text;
      if (i <= at) { renderSteps(); return; }   // already past: only its line
      const now = performance.now();
      if (at >= 0) steps[at].ms = now - stepT0;
      at = i;
      stepT0 = now;
      renderSteps();
    },
    get isOpen() { return el.classList.contains('open'); },
  };
}
