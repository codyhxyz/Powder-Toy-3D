// Real-GPU check, one slot: the lazy legacy export's switch of projection (src/v2/physics.js
// exportLegacy, src/shaders/v2.js v2BridgeWGSL) on a box under V2 (--size 64, the default, or 128:
// the World window's size; a 128³ boot may not fit the slot).
// Water poured on sand and left to flow holds partial fills; after a switch (and after more ticks and
// another switch) A/B must equal, word for word, a full export in that projection. Then it times a
// switch against a full export (wall clock over a batch, fenced) and counts the bricks each converts.
// --world: the same on the World map's 128³ window (the island: its own water, nothing poured).
// The CPU twin is tools/v2/legacy-flip-check.mjs.
// node tools/v2/legacy-flip-browser-check.mjs --port 5391 [--size 128] [--world]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';

const t0 = Date.now(), world = process.argv.includes('--world');
const size = Number(process.argv[process.argv.indexOf('--size') + 1] ?? 64) === 128 && process.argv.includes('--size') ? 128 : 64;
// (app.js and the V2 modules load dynamically: transform them before the slot, not in it)
const vite = await startVite({ warmupEntries: ['/src/main.js', '/src/app.js', '/src/v2/physics.js', '/src/shaders/v2/contact.js', '/src/v2/dynamics.js', '/src/elements.js', '/src/shaders/v2.js'] });
let browser;
try {
  browser = await launchBrowser();
  const launched = Date.now();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 240 } });
  const errors = [];
  // (printed as they come: a slot that runs out still shows what stopped the boot)
  page.on('pageerror', e => { errors.push(e.message); console.log(`page error: ${e.message}`); });
  page.on('console', m => {
    if (m.type() === 'log' && /^(ok |t\+|result )/.test(m.text())) console.log(m.text());
    if (m.type() !== 'error') return;
    if (/ERR_CONNECTION_REFUSED/.test(m.text())) return;
    errors.push(m.text()); console.log(`console error: ${m.text()}`);
  });
  await page.goto(vite.url(world ? '/?size=world' : `/?size=${size}&preset=empty`));
  await ready(page);
  console.log(`t+${Date.now() - launched} ms: app up`);
  if (world) await page.waitForFunction(() => window.__app.win?.loaded, null, { polling: 100, timeout: 20000 });
  const result = await page.evaluate(async ([world, launchedAt]) => {
    const a = __app, { E, ELEMENTS } = await import('/src/elements.js');
    const { LEGACY_WORD } = await import('/src/shaders/v2.js');
    a.test.park(); a.settings.paused = true;
    await a.test.ready();
    const booted = performance.now(), stage = name => console.log(`t+${Date.now() - launchedAt} ms: ${name}`);
    stage('pipelines ready');
    const sim = a.sim, gpu = a.gpu, v2 = a.physics.v2, nb = sim.g.nbricks, bytes = sim.g.slots * 16;
    const check = (ok, message) => { if (!ok) throw new Error(message); console.log(`ok ${message}`); };
    const paint = (x, y, z, id, radius) => sim.paint({ center: new a.THREE.Vector3(x, y, z), radius, shape: 0, tool: id, rate: 1 / ELEMENTS[id].spawn, replace: false });
    const words = async () => new Uint32Array(await gpu.readback.buffer(v2.act, v2.layout.legacy * 4, nb * 4));
    const state = async () => (await Promise.all([sim.state.A, sim.state.B].map(b => gpu.readback.buffer(b, sim.cur * bytes, bytes)))).map(x => new Uint32Array(x));
    const equal = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const bridged = [], prev = sim.onPass;
    sim.onPass = (name, info) => { if (name === 'v2bridge') bridged.push(name); prev?.(name, info); };
    // A full export in the projection the cache is in: as before the first export (no projection yet).
    const full = native => { v2.legacyNative = undefined; sim.legacyState(native); };
    const exact = async (native, label) => {
      const incremental = await state();
      full(native);
      const reference = await state();
      check(equal(incremental[0], reference[0]) && equal(incremental[1], reference[1]), `${label}: A/B equal a full ${native ? 'edit' : 'drawn'} export, word for word`);
    };
    const converts = (w, flip) => [...w].filter(x => (x & LEGACY_WORD.STALE) || (flip && (x & LEGACY_WORD.DIFFERS))).length;

    if (!world) {
      const k = sim.g.nx / 128;   // the fixture at 128³, scaled
      for (const [x, z] of [[32, 32], [96, 40], [40, 96], [90, 90]]) paint(x * k, 6 * k, z * k, E.SAND, 10 * k);
      for (const [x, z] of [[32, 32], [96, 40], [40, 96], [90, 90]]) paint(x * k, 40 * k, z * k, E.WATER, 9 * k);
    }
    a.test.step(world ? 20 : 40);
    stage('poured and ticked');
    sim.legacyState(false);
    let w = await words();
    const differing = [...w].filter(x => x & LEGACY_WORD.DIFFERS).length;
    // (reported, not asserted: how many depends on the flow; the exactness checks below hold either way)
    const firstFlip = converts(w, true);
    console.log(`result ${differing} of ${nb} bricks differ`);
    sim.legacyState(true);
    await exact(true, 'switch to the edit projection');
    a.test.step(6);   // the water still flows: bricks go stale, some partial fills come and go
    sim.legacyState(true);
    sim.legacyState(false);   // (the brush's export, then the World copy's)
    // the bricks that switch converted: those stale after the edit's export, and those differing
    await exact(false, 'ticks, then switch back to the drawn projection');

    // Timing: a batch of switches, then a batch of full exports, each fenced.
    w = await words();
    const flipBricks = converts(w, true);
    const time = async (fn, n) => {
      await gpu.fence();
      const start = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      await gpu.fence();
      return (performance.now() - start) / n;
    };
    const N = 16;
    bridged.length = 0;
    const flipMs = await time(i => sim.legacyState(i % 2 === 0), N);
    check(bridged.length === N, 'each switch dispatched one export');
    const fullMs = await time(i => full(i % 2 === 0), N);
    console.log(`result switch ${flipBricks} bricks ${flipMs.toFixed(3)} ms; full ${nb} bricks ${fullMs.toFixed(3)} ms`);
    sim.onPass = prev;
    return { world, differing, firstFlip, flipBricks, flipMs, fullMs, nb, bootMs: booted };
  }, [world, launched]);
  assert.deepEqual(errors, []);
  const done = Date.now();
  console.log(JSON.stringify({ ...result, occupancyMs: done - launched, totalMs: done - t0 }));
  console.log(`legacy switch: ${result.flipBricks} of ${result.nb} bricks, ${result.flipMs.toFixed(3)} ms; a full export ${result.nb} bricks, ${result.fullMs.toFixed(3)} ms (slot ${((done - launched) / 1000).toFixed(1)} s)`);
} finally {
  await browser?.close();
  await vite.close();
}
