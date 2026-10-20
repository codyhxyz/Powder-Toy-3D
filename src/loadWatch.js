// A map that never comes on screen is a bug, not a wait. The watch runs from a map
// starting to load until it is on screen (app.js: the boot's loading screen coming down,
// or a map switched in-game drawing its first frame). Past LOAD_FLAG_MS, or on an error
// while it runs, it flags the load: the player sees it (the loading screen's line, or a
// toast), the console gets a "[load-flag]" error, and a record is kept in this browser
// (LOAD_FLAG_STORE) for the bug report. It never cancels the load.
// 2026-10-20: Descent sat on its loading screen for over a minute, the WORLD renderer
// having thrown once (its world book over the binding limit) with nothing on screen.

// The longest a load should take: a cold World shader build is ~20 s on the Mac and a
// match starting behind the screen waits up to 30 s (app.js MATCH_WAIT_MS), so past
// this something is stuck, not compiling.
export const LOAD_FLAG_MS = 45000;
export const LOAD_FLAG_STORE = 'powder-toy-3d:load-flags';
const LOAD_FLAG_KEEP = 20;          // records kept, newest last
const MESSAGE_CHARS = 500;          // of an error's message, in a record

// report(record, text): show it (app.js routes it to the loading screen or a toast).
// alive(): false once the load can't finish anyway (graphics stopped, the start cancelled): no slow flag then.
export function createLoadWatch({ report, alive = () => true, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  store = globalThis.localStorage, build = '' } = {}) {
  let load = null;
  const flag = (kind, error = null) => {
    if (!load) return null;
    const record = {
      kind, map: load.what, step: load.step, elapsedMs: Math.round(now() - load.t0),
      error: error ? String(error.message ?? error).slice(0, MESSAGE_CHARS) : null,
      at: new Date().toISOString(), build,
    };
    load.flags.push(record);
    try {
      const kept = JSON.parse(store?.getItem(LOAD_FLAG_STORE) ?? '[]');
      store?.setItem(LOAD_FLAG_STORE, JSON.stringify([...kept, record].slice(-LOAD_FLAG_KEEP)));
    } catch { /* no storage: the console and the screen still have it */ }
    const seconds = Math.round(record.elapsedMs / 1000);
    const text = kind === 'slow'
      ? `Still loading after ${seconds} s, which is too long. Stuck at: ${record.step}.`
      : `Loading hit an error at: ${record.step}. ${record.error}`;
    console.error('[load-flag]', text, record);
    report?.(record, text);
    return record;
  };
  return {
    // what: the map's key; onScreen: done at its first frame on screen (a switch in-game),
    // else when done() is called (the boot: its loading screen coming down)
    start(what, { step = 'starting', onScreen = false } = {}) {
      this.stop();
      load = { what, step, onScreen, t0: now(), flags: [], timer: setTimer(() => { if (alive()) flag('slow'); }, LOAD_FLAG_MS) };
    },
    step(step) { if (load) load.step = step; },
    error(error) { return flag('error', error); },
    onScreen() { if (load?.onScreen) this.stop(); },
    done() { this.stop(); },
    stop() { if (load) clearTimer(load.timer); load = null; },
    get active() { return !!load; },
    get flags() { return load?.flags ?? []; },
  };
}
