import { h } from '../ui/dom.js';
import './console.css';
import { ScriptWorld } from './world.js';
import { createGpuBackend } from './gpu.js';
import { installBuiltins } from './api.js';

// The scripting console (docs/console.md), The Powder Toy's Lua console with
// Garry's Mod's look: ` opens it (TPT's src/gui/game/GameView.cpp,
// SDL_SCANCODE_GRAVE → ShowConsole; GMod's console key too). It runs only
// what the player types or pastes: nothing from URLs, saves or multiplayer
// peers. In multiplayer, scripts run on the host only: a guest's console is
// disabled (its world is the host's, streamed).
//
// The Lua VM (console/lua.js, fengari) loads the first time the console opens.
// The app calls the frame hooks around its steps:
//   tick()        once a frame, before the steps (event.tick: TPT fires it every frame, paused too)
//   beforeStep()  before each simulation step (event.beforesim), then flushes the queued writes
//   afterStep()   after each step (event.aftersim)
//   endFrame()    flushes what's left and lets the read cache refresh
//
// app = { getSim, isGuest, paused, setPaused, stepNow(n), gravity, setGravity,
//   brushRadius, setBrushRadius, brushShape, setBrushShape, selected, select,
//   paint({ x, y, z, radius, shape, tool }), snapshot(), requestRender(), exitPointerLock() }

// console/lua.js EVENTS, without loading it
const EVENT = { TICK: 0, BEFORESIM: 1, AFTERSIM: 2 };
// TPT's console key, by physical key (SDL scancode there, KeyboardEvent.code here)
export const CONSOLE_KEY = 'Backquote';
// All the event handlers of a frame share this much time; past it the rest
// wait for the next frame (a slow script slows itself, never the game).
const FRAME_BUDGET_MS = 8;
const MAX_LOG_LINES = 500;
const MAX_HISTORY = 100;
const HISTORY_STORE = 'powder-toy-3d:console-history';
// How often the "handlers ran out of time" notice may repeat.
const BUDGET_NOTICE_MS = 5000;
// sim.createParts dabs per frame (or typed command): each is a full-grid brush
// pass, where partCreate's cells share one small pass.
const MAX_DABS = 64;

const GREETING = 'Lua 5.3 (fengari). TPT\'s API with a z: sim.partCreate(-1, x, y, z, elem.DEFAULT_PT_SAND), '
  + 'event.register(event.tick, fn). help() lists everything. Enter runs, Shift+Enter adds a line, ` closes.';

export function createConsole(app) {
  const world = new ScriptWorld(createGpuBackend(app.getSim));
  let inCommand = false, snapped = false, dabs = 0;
  // a typed command's first write takes an undo snapshot (⌘Z undoes the command)
  world.onEdit = () => { if (inCommand && !snapped) { snapped = true; app.snapshot(); } };
  installBuiltins({
    world,
    paused: app.paused, setPaused: app.setPaused,
    step: (n) => { world.flush(); app.stepNow(n); world.invalidate(); },
    gravity: app.gravity, setGravity: app.setGravity,
    brushRadius: app.brushRadius, setBrushRadius: app.setBrushRadius,
    brushShape: app.brushShape, setBrushShape: app.setBrushShape,
    selected: app.selected, select: app.select,
    paint: (p) => {
      if (++dabs > MAX_DABS) throw new Error(`at most ${MAX_DABS} createParts dabs a frame (each is a full GPU pass): use partCreate for single cells`);
      world.onEdit(); world.flush(); app.paint(p);
    },
    origin: () => { const o = app.getSim().origin; return [o.x, o.y, o.z]; },
  });

  let lua = null, loading = null, open = false;
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_STORE) || '[]').slice(-MAX_HISTORY); } catch { /* no storage */ }
  let hIndex = history.length, draft = '';
  let frameEnd = 0, lastBudgetNotice = -Infinity;

  // ---- the panel
  const logEl = h('div.console-log', { role: 'log', 'aria-live': 'polite' });
  const errorEl = h('div.console-error', { role: 'alert' });
  const prompt = h('span.console-prompt', { text: '>', 'aria-hidden': 'true' });
  const input = h('textarea.console-input', {
    rows: 1, spellcheck: false, autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Lua command',
    placeholder: 'Lua: print(sim.elementCount("SAND"))',
  });
  const status = h('span.console-status');
  const stopBtn = h('button.btn.console-stop', { type: 'button', text: 'Stop scripts', title: 'Unregister every event handler',
    on: { click: () => { lua?.clearHandlers(); print('Every event handler was unregistered.', 'info'); sync(); input.focus(); } } });
  const closeBtn = h('button.btn.console-close', { type: 'button', 'aria-label': 'Close console', text: '×', on: { click: () => setOpen(false) } });
  const panel = h('section.console.panel', { 'aria-label': 'Console', hidden: true },
    h('header.console-head', {}, h('h2', { text: 'Console' }), status, stopBtn, closeBtn),
    logEl, errorEl,
    h('div.console-line', {}, prompt, input));
  document.body.append(panel);

  function print(text, kind = 'out') {
    // (row-: the app's .error is its fatal-error overlay, hidden)
    for (const line of String(text).split('\n')) logEl.append(h(`div.console-row.row-${kind}`, { text: line }));
    while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }
  function showError(text) { errorEl.textContent = text ?? ''; }

  function sync() {
    const n = lua?.handlerCount() ?? 0;
    status.textContent = app.isGuest() ? 'Guest: scripts run on the host' : n ? `${n} event handler${n === 1 ? '' : 's'}` : '';
    stopBtn.hidden = !n;
    input.disabled = app.isGuest();
    prompt.textContent = lua?.continuing ? '…' : '>';
    input.rows = Math.min(8, Math.max(1, input.value.split('\n').length));
  }

  async function load() {
    if (lua) return lua;
    loading ??= import('./lua.js').then(({ createLua }) => {
      lua = createLua({ log: print });
      return lua;
    });
    return loading;
  }

  function setOpen(v) {
    open = v;
    panel.hidden = !v;
    if (v) {
      app.exitPointerLock?.();
      sync();
      if (app.isGuest()) { showError('Scripts run on the host only: this console is off while you\'re a guest.'); return; }
      input.focus();
      if (!lua) {
        print('Loading Lua…', 'info');
        load().then(() => { logEl.lastElementChild?.remove(); print(GREETING, 'info'); sync(); })
          .catch((e) => { showError(`Lua failed to load: ${e.message}`); });
      }
    } else if (document.activeElement === input) input.blur();
  }

  function submit() {
    const code = input.value;
    if (!code.trim() && !lua?.continuing) return;
    if (app.isGuest()) { showError('Scripts run on the host only.'); return; }
    if (!lua) { showError('Lua is still loading…'); return; }
    print(`${lua.continuing ? '…' : '>'} ${code}`, 'cmd');
    if (code.trim() && history.at(-1) !== code) {
      history.push(code);
      history = history.slice(-MAX_HISTORY);
      try { localStorage.setItem(HISTORY_STORE, JSON.stringify(history)); } catch { /* no storage */ }
    }
    hIndex = history.length;
    draft = '';
    input.value = '';
    inCommand = true; snapped = false; dabs = 0;
    world.beginCommand();
    let r;
    try {
      r = lua.run(code);
      world.flush();
    } catch (e) {
      r = { ok: false, error: e.message ?? String(e) };   // (a GPU failure while applying the writes)
    } finally { inCommand = false; }
    if (r.more) showError('');
    else if (r.ok) { showError(''); if (r.text != null) print(r.text, 'out'); }
    else { showError(r.error); print(r.error, 'error'); }
    app.requestRender();
    sync();
  }

  input.addEventListener('keydown', (e) => {
    // the game never sees what's typed here (its Escape would open the map
    // menu once this closes; app.js isTyping covers the rest)
    e.stopPropagation();
    if (e.code === CONSOLE_KEY && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    const before = input.value.slice(0, input.selectionStart), after = input.value.slice(input.selectionEnd);
    if (e.key === 'ArrowUp' && !before.includes('\n') && hIndex > 0) {
      e.preventDefault();
      if (hIndex === history.length) draft = input.value;
      input.value = history[--hIndex];
      sync();
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && hIndex < history.length) {
      e.preventDefault();
      input.value = ++hIndex === history.length ? draft : history[hIndex];
      sync();
    }
  });
  input.addEventListener('input', sync);

  // Esc, while it's open, cancels an unfinished chunk or closes it, and goes no
  // further (the app's Esc would open the map menu): taken in the capture phase,
  // as the map menu takes its keys (ui/menu.js). ` anywhere opens or closes it
  // (the app's own keys ignore it while you type here: app.js isTyping).
  addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (lua?.continuing) { lua.cancel(); print('(cancelled)', 'info'); sync(); } else setOpen(false);
      return;
    }
    if (e.code !== CONSOLE_KEY || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target === input) return;   // (its own handler)
    const a = document.activeElement;
    if (a && a !== document.body && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)) return;   // typing elsewhere
    e.preventDefault();
    setOpen(!open);
  }, { capture: true });

  // ---- frame hooks
  const active = () => lua && !app.isGuest();
  const dispatch = (type) => {
    if (lua.dispatch(type, frameEnd)) return;
    const t = performance.now();
    if (t - lastBudgetNotice > BUDGET_NOTICE_MS) {
      lastBudgetNotice = t;
      print(`Event handlers used their ${FRAME_BUDGET_MS} ms this frame: the rest wait for the next one.`, 'info');
    }
  };
  return {
    get open() { return open; },
    setOpen,
    toggle: () => setOpen(!open),
    world,
    tick() {
      frameEnd = performance.now() + FRAME_BUDGET_MS;
      dabs = 0;
      if (!active() || !lua.handlerCount()) return;
      dispatch(EVENT.TICK);
      world.flush();
      if (open) sync();
    },
    beforeStep() {
      if (!active()) return;
      if (lua.handlerCount(EVENT.BEFORESIM)) dispatch(EVENT.BEFORESIM);
      world.flush();
    },
    afterStep() {
      if (active() && lua.handlerCount(EVENT.AFTERSIM)) dispatch(EVENT.AFTERSIM);
    },
    endFrame() {
      if (!lua) return;
      world.flush();
      world.pump();
    },
  };
}
