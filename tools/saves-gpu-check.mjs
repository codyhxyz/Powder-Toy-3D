// Save and load on the GPU, in the real app (src/saves). Start Vite on your own port first:
//   npm run dev -- --port 5281 --strictPort
//   node tools/saves-gpu-check.mjs --port 5281
// Box (the Lab): paint and step, ⌘S's save, change the box, load: every cell
// comes back bit for bit, the signs too; ⌘Z then takes the load back.
// World (the Island): paint, walk the window off it (the edit goes into the
// store), save, paint again, load: the window's cells and the store come back.
// tools/saves-check.mjs checks the format itself on the CPU.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const port = args[args.indexOf('--port') + 1] || '5281';
const WORLD_WAIT_MS = 120000;

// in the page: the state's cells, as one Uint32 array (bits, cell order)
const cellsBits = () => {
  const sim = window.__app.sim, g = sim.g, [a, b] = sim.readState();
  const ua = new Uint32Array(a.buffer), ub = new Uint32Array(b.buffer), out = new Uint32Array(g.nx * g.ny * g.nz * 8);
  let i = 0;
  for (let y = 0; y < g.ny; y++)
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const t = sim.cellTexel(x, y, z) * 4;
        for (let c = 0; c < 4; c++) { out[i++] = ua[t + c]; out[i++] = ub[t + c]; }
      }
  return out;
};

const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(m.text())) errors.push(m.text()); });

  // ---- a box ----
  await page.goto(`http://localhost:${port}/?map=lab`);
  await ready(page);
  // a frame first, as in play (a parked page draws none: the save's thumbnail, the next
  // frame on screen, then times out to none, which this check doesn't look at)
  await render(page);
  const box = await page.evaluate(async (cellsSrc) => {
    const cells = eval(`(${cellsSrc})`);
    const app = window.__app, sim = app.sim, THREE = app.THREE, { E } = await import("/src/elements.js");
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    sim.paint({ center: new THREE.Vector3(40, 60, 40), radius: 6, shape: 0, tool: E.SAND, rate: 1, replace: false });
    app.test.step(40);
    app.signs?.add({ cell: new THREE.Vector3(20, 4, 20), normal: new THREE.Vector3(0, 1, 0), text: 'saved {t}', edit: false });
    const saved = cells();
    const meta = await app.saveGame('saves-gpu-check');
    if (!meta) throw new Error('saveGame returned null');
    app.loadPreset('empty');   // something else entirely
    app.test.step(4);
    const before = cells();
    const loaded = await app.openSave(meta.id);
    const back = cells();
    const signs = app.signs?.toJSON() ?? [];
    app.undo();
    const undone = cells();
    return {
      loaded, bytes: meta.bytes, exact: same(saved, back), signs: signs.map((s) => s.text),
      undo: same(before, undone), changed: !same(saved, before),
    };
  }, cellsBits.toString());
  assert.ok(box.loaded, 'box: loaded');
  assert.ok(box.changed, 'box: the box changed between save and load');
  assert.ok(box.exact, 'box: every cell came back bit for bit');
  assert.deepEqual(box.signs, ['saved {t}'], 'box: the sign came back');
  assert.ok(box.undo, 'box: ⌘Z took the load back');
  console.log(`box: lossless (${(box.bytes / 1024 / 1024).toFixed(1)} MB), signs back, undo takes it back`);

  // ---- a world ----
  await page.goto(`http://localhost:${port}/?map=island`);
  await ready(page);
  await page.waitForFunction(() => window.__app.win?.loaded, null, { polling: 200, timeout: WORLD_WAIT_MS });
  await render(page);
  const world = await page.evaluate(async ({ cellsSrc, waitMs }) => {
    const cells = eval(`(${cellsSrc})`);
    const app = window.__app, sim = app.sim, win = app.win, THREE = app.THREE, { E } = await import("/src/elements.js");
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const settle = async (until) => {
      const t0 = performance.now();
      app.test.resume();
      while (!until() && performance.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 100));
      app.test.park();
      while (win.pending) await win.pending;
    };
    // an edit, then the window walked off it so it goes into the store
    sim.paint({ center: new THREE.Vector3(8, 100, 8), radius: 6, shape: 1, tool: E.WALL, rate: 1, replace: true });
    const o0 = sim.origin.clone();
    app.worldFocus = [o0.x + sim.g.nx / 2 + 96, o0.z + sim.g.nz / 2];
    await settle(() => sim.origin.x - o0.x >= 64 && !win.pending);
    app.worldFocus = null;
    const stored = win.store.size;
    const saved = cells(), origin = sim.origin.toArray();
    const meta = await app.saveGame('saves-gpu-check world');
    if (!meta) throw new Error('saveGame returned null');
    sim.paint({ center: new THREE.Vector3(64, 100, 64), radius: 8, shape: 1, tool: E.EMPTY, rate: 1, replace: true });
    const loaded = await app.openSave(meta.id);
    return { loaded, stored, storedBack: win.store.size, exact: same(saved, cells()), origin: same(origin, sim.origin.toArray()), bytes: meta.bytes };
  }, { cellsSrc: cellsBits.toString(), waitMs: WORLD_WAIT_MS });
  assert.ok(world.loaded, 'world: loaded');
  assert.ok(world.stored > 0, 'world: the edit went into the store');
  assert.equal(world.storedBack, world.stored, 'world: the store came back');
  assert.ok(world.origin, 'world: the window is where it was');
  assert.ok(world.exact, 'world: every window cell came back bit for bit');
  console.log(`world: ${world.stored} stored bricks and the window back exactly (${(world.bytes / 1024 / 1024).toFixed(1)} MB)`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('saves-gpu-check: all passed');
} finally {
  await browser.close();
}
