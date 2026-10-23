// CPU only: a stalled or failed map load is flagged, never left spinning (src/loadWatch.js),
// and app.js keeps it wired: the boot's loading screen, a map switched in-game, and the
// WORLD renderer failing (2026-10-20: Descent spun for over a minute on a thrown error).
// Run: node tools/check-load-watch.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLoadWatch, LOAD_FLAG_MS, LOAD_FLAG_STORE } from '../src/loadWatch.js';

function harness() {
  let clock = 0, nextId = 1;
  const timers = new Map(), shown = [], data = new Map();
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const watch = createLoadWatch({
    now: () => clock, store, build: 'app-TEST.js',
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    report: (record, text) => shown.push({ record, text }),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
  };
  const records = () => JSON.parse(store.getItem(LOAD_FLAG_STORE) ?? '[]');
  return { watch, advance, shown, records, timers };
}
const quiet = console.error;
console.error = () => {};   // the flags' own console lines
try {
  // A load past the limit is flagged once, naming the step it's stuck on, and recorded.
  {
    const { watch, advance, shown, records } = harness();
    watch.start('descent', { step: 'building the map' });
    advance(LOAD_FLAG_MS / 2);
    watch.step("the World renderer's first frame");
    advance(LOAD_FLAG_MS / 2 - 1);
    assert.equal(shown.length, 0, 'not before the limit');
    advance(1);
    assert.equal(shown.length, 1, 'flagged at the limit');
    assert.match(shown[0].text, /Still loading after 45 s.*World renderer's first frame/);
    assert.deepEqual({ ...records()[0], at: null }, { kind: 'slow', map: 'descent', step: "the World renderer's first frame",
      elapsedMs: LOAD_FLAG_MS, error: null, at: null, build: 'app-TEST.js' });
    advance(10 * LOAD_FLAG_MS);
    assert.equal(shown.length, 1, 'a load is flagged slow once');
  }
  // A load that finishes in time is never flagged.
  {
    const { watch, advance, shown, timers } = harness();
    watch.start('island');
    advance(LOAD_FLAG_MS - 1);
    watch.done();
    advance(LOAD_FLAG_MS);
    assert.equal(shown.length, 0);
    assert.equal(timers.size, 0, 'done clears the timer');
    assert.equal(watch.active, false);
  }
  // An error while loading is flagged at once, with its message.
  {
    const { watch, shown, records } = harness();
    watch.start('descent', { step: "the World renderer's first frame" });
    watch.error(new RangeError('world book exceeds default/device binding limit'));
    assert.match(shown[0].text, /Loading hit an error at: the World renderer's first frame\. world book exceeds/);
    assert.equal(records()[0].kind, 'error');
    watch.stop();
    assert.equal(watch.error(new Error('after')), null, 'no load, no flag');
  }
  // In-game switches end on their first frame on screen; the boot's waits for done().
  {
    const { watch } = harness();
    watch.start('willowCove', { onScreen: true });
    watch.onScreen();
    assert.equal(watch.active, false);
    watch.start('descent');
    watch.onScreen();
    assert.equal(watch.active, true, "the boot's watch outlasts the first frame");
  }
  // The kept records are bounded.
  {
    const { watch, records } = harness();
    for (let i = 0; i < 30; i++) { watch.start(`m${i}`); watch.error(new Error(String(i))); }
    assert.equal(records().length, 20);
    assert.equal(records().at(-1).map, 'm29');
  }
} finally {
  console.error = quiet;
}

// app.js keeps the watch on every load and stops graphics when the WORLD renderer fails.
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
assert.match(body('bootReady'), /loadWatch\.start\(/, 'the boot watches its load');
assert.match(body('bootReady'), /loadWatch\.done\(\);\s*launch\.ready/, 'the boot ends its watch as its screen comes down');
assert.match(body('openMap'), /loadWatch\.start\([^)]*onScreen: true/, 'a map switched in-game is watched to its first frame');
assert.match(app, /try\{driver=wire\('world'\)\.prepareRender\(ctx\);\}\s*catch\(error\)\{stopGraphics\(error\);/,
  "the WORLD renderer's failure stops graphics on screen");
assert.match(body('stopGraphics'), /loadWatch\.error\(error\);[^\n]*\n\s*loadWatch\.stop\(\);/, 'a graphics failure during a load is flagged and recorded');
assert.match(app, /loadWatch\.onScreen\(\)/, 'frames end in-game watches');
// A failed WORLD driver throws every tick after: it is rebuilt once a page load, else graphics stop on screen;
// either way the failure is kept (the user's frozen "map crashed" had no record, 2026-10-23).
assert.match(app, /runView=driver\.tick\([\s\S]{0,900}?\}\);\s*\} catch\(error\) \{ worldFailed\(error\); driver=null; \}/, "a failed WORLD driver's tick goes to worldFailed");
assert.match(body('worldFailed'), /restartRender\(ctx\)\) throw stopGraphics\(/, 'past its restarts graphics stop with the failure on screen');
assert.match(body('worldFailed'), /gpuLoss\.record\(\{ kind: 'worldRestarted'/, 'a restart is kept for the bug report');
assert.match(body('frame'), /recordFrameError\(error, loadBuild\); throw error;/, 'an uncaught frame error is kept');
const worldWire = readFileSync(new URL('../src/wire/world.js', import.meta.url), 'utf8');
assert.match(worldWire, /previous\.epoch!==win\.renderSource\.epoch \|\| previous\.restart/, 'a restart retires the driver as a map switch does');
assert.match(worldWire, /worldRestarts>=WORLD_RESTARTS\)return false;/, 'restarts are bounded');
console.log(`PASS load watch: flags past ${LOAD_FLAG_MS / 1000} s and on errors, records bounded; app.js wires the boot, map switches and WORLD failures`);
