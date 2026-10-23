import { h } from './dom.js';
import { logoMark } from './logo.js';
import { MAPS, mapByKey, mapsFor, isWorld, sizeTag, mapPreviewUrl as THUMB, mapLoadingUrl } from '../maps.js';
import { listSaves, getSave, putSave, deleteSave, downloadSave, pickSaveFile } from '../saves/local.js';
import { readSaveHeader } from '../saves/format.js';
import { MODEICONS, MODEICON_BOX } from './modeicons.js';
import { previewCharacter, nextYouZoom } from '../pov/character.js';

// The start menu, Garry's Mod's New Game screen: gamemodes down the left, each
// with its icon, the maps built for the chosen one as square previews (public/maps, rendered by
// tools/map-thumbs.mjs) with each map's size tagged in its corner, and the
// picked map with Start along the bottom. The landing page (src/main.js), and
// over the game from the toolbar's Maps or Esc, with Resume.
//   modes                 the gamemodes to list (maps.js GAMEMODES, filtered by the build)
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
// Start turns it into the loading screen until the map is up, kept plain: the
// map's art behind the gamemode, the map's name, the game's line, a bar, what
// the boot is doing now, and the player as he is ("This is you.":
// public/you.webp, tools/you-portrait.mjs), then live (ui/youViewer.js):
// breathing, turning slowly, turned left or right with a drag, and zoomed with
// the wheel, as on Skyrim's loading screen. It is the body you are about to
// spawn as (pov/character.js previewCharacter), not a fixed wizard.
//   loading(status, o)    the screen, with the game's line (src/main.js)
//   flag(text)            a load stalled or failed (app.js loadWatch): its line, under the step
//   progress(step, text)  a boot step began (STEPS keys; 'cold': the shaders are compiling
//                         cold; 'match' with app.js's line for it)
// 'stick' is the saved paper-bag choice; a new URL cannot reuse the old stickman still.
const YOU = (character) => character === 'real' ? '/you.webp' : character === 'stick' ? '/you-bag.webp' : `/you-${character}.webp`;
// the live player's canvas (ui/youWorker.js), sized once for the tallest he is shown (menu.css .mm-you)
const YOU_MAX_H = 560;                 // CSS px
const YOU_ASPECT = 260 / 420;          // the still's width over its height (tools/you-portrait.mjs SHOWN_W, SHOWN_H)
const YOU_MAX_DPR = 2;                 // px per CSS px, at most
const YOU_IDLE_TIMEOUT_MS = 2000;      // the longest it waits for an idle moment to build him (src/preload.js's wait)
const YOU_NO_IDLE_DELAY_MS = 200;      // its wait without requestIdleCallback (Safari)
const STORE = 'powder-toy-3d:menu';   // the last gamemode and map picked here
// What the loading screen says it's on, one line under its bar. GMod's loading
// screen names the step it is really on ("Retrieving server info", "Sending
// client info"...), and so does this one: the boot's own, in order, reported
// through progress() by src/main.js and app.js; only the current one shows.
// world: only in a world; match: only in a gamemode that starts a match behind
// the screen (app.js bootReady: all but Sandbox).
const STEPS = [
  { key: 'fetch', text: () => 'Downloading the game' },
  { key: 'build', text: (m) => (isWorld(m) ? 'Setting up the simulation around you' : `Filling ${count(m)} cells`) },
  { key: 'compile', text: () => 'Compiling shaders' },
  { key: 'world', text: () => 'Generating the world', world: true },
  { key: 'match', text: () => 'Starting the match', match: true },
];
// a cold compile's note, said as app.js's close-up detail toast says it
const COLD_NOTE = 'The first time after an update, this can take several seconds.';

// What the game is, under its name, for a player who has never seen it (The Powder Toy's own pitch, in 3D).
const TAGLINE = 'A 3D falling-sand game: every grain of sand, drop of water and lick of flame is simulated. Pick a map, then Start.';
const BETA_NOTE = 'In testing: this mode is still being built, so expect rough edges. Sandbox is the full game.';

const count = (m) => m.dims.reduce((a, b) => a * b, 1).toLocaleString('en-US');
const dimsText = (m) => `${m.dims.join(' × ')} cells`;
// a map's size said plainly: a big map loads around you, a small one is simulated whole
const sizeWord = (m) => (isWorld(m) ? 'Big map' : 'Small map');
const sizeLine = (m) => (isWorld(m) ? 'Big map · loads around you as you explore' : 'Small map · simulated whole, loads quickly');

// a baked icon (tools/game-icons.mjs) as inline SVG, drawn in the text's colour
const iconSVG = (icon, box, cls) => (icon ? `<svg class="${cls}" viewBox="0 0 ${box} ${box}" aria-hidden="true"><path d="${icon.d}"/></svg>` : '');
const modeIcon = (key, cls) => iconSVG(MODEICONS[key], MODEICON_BOX, cls);
const iconEl = (tag, key, cls) => h(tag, { html: modeIcon(key, cls) });
const MB = 1024 * 1024;
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const SAVES_DESC = 'Games you saved with ⌘S or the toolbar\'s Save, kept in this browser. Export one to keep it as a file.';

export function createMenu({ modes, map, mode, onStart, onResume, onLoadSave }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  let modeKey = modes.some((m) => m.key === (mode ?? saved.mode)) ? mode ?? saved.mode : modes[0].key;
  let pick = mapByKey(map) ?? mapByKey(saved.map) ?? MAPS[0];
  let inGame = false;
  let busy = false;
  let view = 'maps';            // 'maps': a gamemode's maps; 'saves': the Saves list
  let saveList = [], savePick = null, saveCards = [];
  const character = (save = view === 'saves') => {
    let savedSettings = {};
    try { savedSettings = JSON.parse(localStorage.getItem('powder-toy-3d:settings') || '{}'); } catch { /* storage unavailable */ }
    return previewCharacter(save ? 'sandbox' : modeKey, savedSettings.character, savedSettings.villageCharacter);
  };
  // Decode every still while the menu is up. A boot freezes the page before a
  // newly pointed-at image can paint, and the previous wizard would stay up.
  for (const id of ['real', 'woman', 'stick', 'spartan', 'boy', 'girl']) {
    const img = new Image();
    img.src = YOU(id);
    img.decode?.().catch(() => {});
  }

  const backdrop = h('div.mm-backdrop');
  const decodedArt = new Set();
  let backdropUrl = '';
  const mapBackdrop = (m) => {
    const url = mapLoadingUrl(m.key);
    backdropUrl = url;
    backdrop.classList.toggle('sharp', !!m.loadingArtVersion && decodedArt.has(url));
    // Fetch the full-size artwork while choosing, before shader compilation stalls the page.
    backdrop.style.backgroundImage = `url(${url}), url(${THUMB(m.key)})`;
    if (!m.loadingArtVersion || decodedArt.has(url)) return;
    const image = new Image();
    image.src = url;
    image.decode().then(() => {
      decodedArt.add(url);
      if (backdropUrl === url) backdrop.classList.add('sharp');
    }).catch(() => {}); // Missing artwork keeps the thumbnail blurred.
  };
  const nav = h('nav.mm-modes', { 'aria-label': 'Gamemodes' });
  const modeEmblem = h('div.mm-emblem');
  const modeTitle = h('h2');
  const modeDesc = h('p');
  const modeBeta = h('p.mm-beta-note', { text: BETA_NOTE });
  const grid = h('div.mm-grid', { role: 'listbox', 'aria-label': 'Maps' });
  const pickThumb = h('img.mm-pick-thumb', { alt: '' });
  const pickName = h('div.mm-pick-name');
  const pickMeta = h('div.mm-pick-meta');
  const pickDesc = h('div.mm-pick-desc');
  const startBtn = h('button.mm-start', { type: 'button', on: { click: () => start() } });
  const resumeBtn = h('button.mm-resume', { type: 'button', text: 'Resume', on: { click: () => onResume?.() } });
  const openFileBtn = h('button.mm-head-btn', { type: 'button', text: 'Open file…', title: 'Load a .tpt3d save file', on: { click: () => openFile() } });
  const exportBtn = h('button.mm-side', { type: 'button', text: 'Export', title: 'Download this save as a .tpt3d file', on: { click: () => exportPicked() } });
  const deleteBtn = h('button.mm-side', { type: 'button', text: 'Delete', on: { click: () => deletePicked() } });
  // the loading screen's parts
  const loadMode = h('div.mm-load-mode');
  const loadName = h('h1.mm-load-name');
  const loadStatus = h('div.mm-load-status');
  const loadStep = h('div.mm-load-step');
  const loadFlag = h('div.mm-load-flag');   // a stalled or failed load, said plainly (loadWatch.js)
  // (eager, at low priority: he must be there the moment Start is pressed, when the page is about to freeze compiling)
  const you = h('img', { src: YOU(character()), alt: '', decoding: 'async', fetchpriority: 'low', draggable: false });
  // decoded while the menu is up: a fast boot freezes the page (the map build, the shaders) before an
  // undecoded image paints, and the caption then points at nothing
  you.decode?.().catch(() => {});
  you.addEventListener('error', () => { you.style.visibility = 'hidden'; });
  you.addEventListener('load', () => { you.style.visibility = ''; });
  const youFig = h('figure.mm-you', {}, you, h('figcaption', { text: 'This is you.' }));
  const youLive = liveYou(youFig, you);
  // built in the background once the menu is up (an idle moment, as src/preload.js waits for one)
  const prepareYou = () => {
    const prepare = () => { if (el.classList.contains('open') && !busy) youLive.prepare(character()); };
    if (self.requestIdleCallback) requestIdleCallback(prepare, { timeout: YOU_IDLE_TIMEOUT_MS });
    else setTimeout(prepare, YOU_NO_IDLE_DELAY_MS);
  };

  const el = h('div.mm', { role: 'dialog', 'aria-label': 'Maps' },
    backdrop,
    h('div.mm-shell', {},
      h('header.mm-top', {},
        h('div.mm-brand', { html: `${logoMark(30)}<span>Powder Toy 3D</span>` }, h('p.mm-tagline', { text: TAGLINE })),
        resumeBtn),
      h('div.mm-body', {},
        nav,
        h('section.mm-main', {},
          h('div.mm-mode-head', {}, modeEmblem, h('div.mm-head-text', {}, h('div.mm-head-line', {}, modeTitle, openFileBtn), modeDesc, modeBeta)),
          grid)),
      h('footer.mm-bar', {},
        pickThumb,
        h('div.mm-pick', {}, h('div.mm-pick-line', {}, pickName, pickMeta), pickDesc),
        h('div.mm-actions', {}, exportBtn, deleteBtn, startBtn))),
    h('div.mm-load', { 'aria-live': 'polite' },
      h('div.mm-load-copy', {}, loadMode, loadName, loadStatus, h('div.mm-load-bar', {}, h('i')), loadStep, loadFlag),
      youFig));
  document.body.append(el);
  // Skyrim's loading screen: the wheel zooms him, wherever the pointer is.
  el.addEventListener('wheel', (e) => {
    if (!el.classList.contains('loading')) return;
    e.preventDefault();
    youLive.zoom(e.deltaY);
  }, { passive: false });
  prepareYou();

  // a preview that isn't there (a map added since tools/map-thumbs.mjs last ran): the card's gradient shows
  const thumb = (m) => {
    const img = h('img', { src: THUMB(m.key), alt: '', loading: 'lazy', draggable: false });
    img.addEventListener('error', () => img.remove());
    return img;
  };

  // the finished gamemodes first; the beta ones (maps.js GAMEMODES beta) after them, under "In testing"
  const modeBtn = (m) => h('button.mm-mode', {
    type: 'button', 'data-mode': m.key, 'aria-pressed': String(view === 'maps' && m.key === modeKey),
    on: { click: () => setMode(m.key) },
  }, iconEl('span.mm-mode-ico', m.key, 'mm-ico'), h('span.mm-mode-name', { text: m.name }),
  m.beta ? h('span.mm-beta', { text: 'Beta' }) : null, h('small', { text: String(mapsFor(m.key).length) }));
  function renderModes() {
    const beta = modes.filter((m) => m.beta);
    nav.replaceChildren(h('div.mm-label', { text: 'Gamemode' }), ...modes.filter((m) => !m.beta).map(modeBtn),
    ...(beta.length ? [h('div.mm-label.mm-label-gap', { text: 'In testing' }), ...beta.map(modeBtn)] : []),
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
    modeBeta.hidden = !mo.beta;
    const list = mapsFor(modeKey);
    if (!list.includes(pick)) pick = list[0];
    cards = list.map((m) => {
      const card = h('button.mm-card', {
        type: 'button', role: 'option', 'data-map': m.key, title: m.desc,
        on: { click: () => select(m), dblclick: () => { select(m); start(); } },
      },
      h('div.mm-thumb', {}, thumb(m), h('span.mm-tag', { text: sizeWord(m), title: `${sizeTag(m)}: ${dimsText(m)}` })),
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
    mapBackdrop(m);
    pickName.textContent = m.name;
    pickMeta.innerHTML = modeIcon(isWorld(m) ? 'world' : 'box', 'mm-ico');
    pickMeta.append(sizeLine(m));
    pickMeta.title = dimsText(m);
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
    prepareYou();
  }

  // ---- Saves ----
  async function showSaves(select) {
    view = 'saves';
    prepareYou();
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
    modeBeta.hidden = true;
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
    backdropUrl = '';
    backdrop.classList.remove('sharp');
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
  let steps = [];        // this load's STEPS, each with its label
  let at = -1;           // the step under way
  let cold = false;      // the view's shaders are compiling cold (app.js's guard said so)

  function renderStep() {
    const s = steps[at];
    loadStep.textContent = !s ? '' : s.key === 'compile' && cold ? `${s.label}. ${COLD_NOTE}` : s.label;
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
      el.classList.toggle('in-game', g);
      el.classList.remove('loading');
      if (md && modes.some((m) => m.key === md)) modeKey = md;
      if (mapByKey(mk)) pick = mapByKey(mk);
      view = 'maps';
      renderModes();
      renderMaps();
      if (saves) showSaves(); else refreshCount();
      el.classList.add('open');
      prepareYou();
      requestAnimationFrame(() => cards.find((c) => c.m === pick)?.card.focus({ preventScroll: true }));
      cards.find((c) => c.m === pick)?.card.scrollIntoView({ block: 'nearest' });
    },
    close() { el.classList.remove('open', 'loading'); busy = false; youLive.stop(); },
    // the loading screen: the gamemode, the map, the step under way, and you (on a pick of its
    // own: a link's ?map= and ?mode=, src/main.js); name: what is loading, if not the picked map (a save)
    loading(status, { map: mk, mode: md, name = null } = {}) {
      busy = true;
      if (md && modes.some((m) => m.key === md)) modeKey = md;
      if (mapByKey(mk)) { pick = mapByKey(mk); mapBackdrop(pick); }
      const mo = modes.find((m) => m.key === modeKey);
      const save = name != null;   // (a save brings its own cells: no map's world step)
      loadMode.textContent = save ? 'Save' : mo.name;
      loadName.textContent = name ?? pick.name;
      loadStatus.textContent = status;
      const matchMode = !save && mo.key !== 'sandbox';
      steps = STEPS.filter((s) => (!s.world || (!save && isWorld(pick))) && (!s.match || matchMode))
        .map((s) => ({ key: s.key, label: s.text(pick) }));
      at = -1;
      cold = false;
      loadFlag.textContent = '';
      renderStep();
      el.classList.add('open', 'loading');
      youLive.start(character(save));
    },
    // a boot step began (text: its line, if not STEPS' own: the match's, from app.js)
    progress(step, text) {
      if (!el.classList.contains('loading')) return;
      if (step === 'cold') { cold = true; renderStep(); return; }
      const i = steps.findIndex((s) => s.key === step);
      if (i < 0) return;   // not this load's
      if (text) steps[i].label = text;
      at = Math.max(at, i);   // (a step already past only changes its line)
      renderStep();
    },
    // a load flagged (app.js loadWatch): its line under the step; false when no loading screen is up
    flag(text) {
      if (!el.classList.contains('loading')) return false;
      loadFlag.textContent = text;
      return true;
    },
    get isOpen() { return el.classList.contains('open'); },
  };
}

// The loading screen's player live (ui/youViewer.js), in a worker on an OffscreenCanvas
// (ui/youWorker.js): built while the menu is up, so he is there the moment Start is pressed, and
// breathing and turning on through the boot's long frames. In the still's place once built; the
// worker and its WebGL context go with the screen, and the next menu builds him again. Without
// OffscreenCanvas WebGL, or on a failure, the still stays.
function liveYou(fig, still) {
  let worker = null, canvas = null, ready = false, shown = false, on = false, drag = null;
  let character = null, zoom = 1;
  const paintZoom = () => {
    // Scale the framed portrait, not its camera: a close-up must not hit a rectangular canvas edge.
    for (const portrait of [still, canvas]) {
      if (!portrait) continue;
      portrait.style.transformOrigin = 'center 58%';
      portrait.style.transform = zoom === 1 ? '' : `scale(${(1 / zoom).toFixed(4)})`;
    }
  };
  const show = () => {
    if (shown || !ready) return;
    shown = true;
    paintZoom();
    still.replaceWith(canvas);
    fig.classList.add('live');
    worker.postMessage({ run: true });
  };
  const prepare = (choice) => {
    if (choice !== character) {
      drop();
      character = choice;
      zoom = 1;
      fig.dataset.character = choice;
      const src = YOU(choice);
      // Hide the previous portrait at once. A decoded wizard otherwise stays
      // on screen until the new file paints, which a frozen boot may never do.
      if (still.getAttribute('src') !== src) still.style.visibility = 'hidden';
      still.src = src;
      still.decode?.().then(() => { if (still.getAttribute('src') === src) still.style.visibility = ''; }).catch(() => {});
      paintZoom();
    }
    if (worker || !still.isConnected || typeof OffscreenCanvas === 'undefined' || !HTMLCanvasElement.prototype.transferControlToOffscreen) return;
    const dpr = Math.min(devicePixelRatio || 1, YOU_MAX_DPR);
    canvas = h('canvas.mm-you-live');
    canvas.width = Math.round(YOU_MAX_H * YOU_ASPECT * dpr);
    canvas.height = Math.round(YOU_MAX_H * dpr);
    const off = canvas.transferControlToOffscreen();
    worker = new Worker(new URL('./youWorker.js', import.meta.url), { type: 'module' });
    const current = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== current) return;
      if (data === 'ready') { ready = true; if (on) show(); return; }
      console.warn('loading screen: the live player failed, the still stays', data.failed);
      drop();
    };
    worker.onerror = (e) => {
      if (worker !== current) return;
      console.warn('loading screen: the live player failed, the still stays', e.message); drop();
    };
    worker.postMessage({ canvas: off, width: canvas.width, height: canvas.height, character }, [off]);
  };
  const drop = () => {
    worker?.terminate();
    if (shown) { canvas.replaceWith(still); fig.classList.remove('live', 'dragging'); }
    worker = canvas = drag = null;
    ready = shown = false;
    paintZoom();
  };
  fig.addEventListener('pointerdown', (e) => {
    if (!shown || e.button !== 0) return;
    drag = { x: e.clientX };
    worker.postMessage({ drag: 'start' });
    fig.setPointerCapture(e.pointerId);
    fig.classList.add('dragging');
    e.preventDefault();
  });
  fig.addEventListener('pointermove', (e) => { if (drag) worker.postMessage({ dx: e.clientX - drag.x }); });
  const release = () => {
    if (!drag) return;
    drag = null;
    worker?.postMessage({ drag: 'end' });
    fig.classList.remove('dragging');
  };
  fig.addEventListener('pointerup', release);
  fig.addEventListener('pointercancel', release);
  return {
    prepare,
    start(choice) { on = true; prepare(choice); show(); },
    zoom(deltaY) {
      zoom = nextYouZoom(zoom, deltaY);
      paintZoom();
    },
    stop() { on = false; release(); drop(); },
  };
}
