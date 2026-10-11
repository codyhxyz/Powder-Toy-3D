import { h } from './dom.js';
import { logoMark } from './logo.js';
import { MAPS, mapByKey, mapsFor, isWorld, sizeTag } from '../maps.js';
import { listSaves, getSave, putSave, deleteSave, downloadSave, pickSaveFile } from '../saves/local.js';
import { readSaveHeader } from '../saves/format.js';

// The start menu, Garry's Mod's New Game screen: gamemodes down the left, the
// maps built for the chosen one as square previews (public/maps, rendered by
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
const THUMB = (key) => `/maps/${key}.webp`;
const STORE = 'powder-toy-3d:menu';   // the last gamemode and map picked here
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
  const openFileBtn = h('button.mm-head-btn', { type: 'button', text: 'Open file…', title: 'Load a .tpt3d save file', on: { click: () => openFile() } });
  const exportBtn = h('button.mm-side', { type: 'button', text: 'Export', title: 'Download this save as a .tpt3d file', on: { click: () => exportPicked() } });
  const deleteBtn = h('button.mm-side', { type: 'button', text: 'Delete', on: { click: () => deletePicked() } });
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
          h('div.mm-mode-head', {}, h('div.mm-head-line', {}, modeTitle, openFileBtn), modeDesc),
          grid)),
      h('footer.mm-bar', {},
        pickThumb,
        h('div.mm-pick', {}, h('div.mm-pick-line', {}, pickName, pickMeta), pickDesc),
        h('div.mm-actions', {}, exportBtn, deleteBtn, startBtn))),
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
      type: 'button', 'aria-pressed': String(view === 'maps' && m.key === modeKey),
      on: { click: () => setMode(m.key) },
    }, h('span', { text: m.name }), h('small', { text: String(mapsFor(m.key).length) }))),
    h('div.mm-label.mm-label-gap', { text: 'Your games' }),
    h('button.mm-mode', { type: 'button', 'aria-pressed': String(view === 'saves'), on: { click: () => showSaves() } },
      h('span', { text: 'Saves' }), h('small', { text: saveList.length ? String(saveList.length) : '' })));
  }

  let cards = [];
  function renderMaps() {
    el.classList.remove('saves-view');
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
      requestAnimationFrame(() => cards.find((c) => c.m === pick)?.card.focus({ preventScroll: true }));
      cards.find((c) => c.m === pick)?.card.scrollIntoView({ block: 'nearest' });
    },
    close() { el.classList.remove('open', 'loading'); busy = false; },
    // the loading screen: the map's preview, its name, and what is happening
    // name: what is loading, if not the picked map (a save)
    loading(status, name = null) {
      busy = true;
      const mo = modes.find((m) => m.key === modeKey);
      loadName.textContent = name ?? pick.name;
      loadMode.textContent = name ? 'Save' : mo.name;
      loadStatus.textContent = status;
      el.classList.add('open', 'loading');
    },
    get isOpen() { return el.classList.contains('open'); },
  };
}
