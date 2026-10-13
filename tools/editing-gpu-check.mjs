// Real-GPU checks for TPT's editing tools (src/editing.js) in the paint pass
// (shaders/passes.js paintFrag): a line, a box, replace mode with a target,
// specific delete, the Property tool and a flood fill, read back cell by cell
// on a parked (manual) page; then Shift-drag, ⌘-drag and ⌘+Shift-click through
// the real input on a ui page, each one undo step.
// Own Vite required: npx vite --port 54911 --strictPort, then
// node tools/editing-gpu-check.mjs --port 54911
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { E, ELEMENTS, PROP_TOOL } from '../src/elements.js';
import { PROP, boxFromCorners, oneShotRate } from '../src/editing.js';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '54911';
const N = 64;   // the grid (?size=64)
const ids = { SAND: E.SAND, WALL: E.WALL, WATER: E.WATER, EMPTY: E.EMPTY, PROP: PROP_TOOL, ERASE: -1 };
const full = (id) => oneShotRate(id, 1);
const box = boxFromCorners({ x: 20.5, y: 6, z: 20.5 }, { x: 29.5, y: 6, z: 25.5 }, 3, [N, N, N]);
const wet = boxFromCorners({ x: 26.5, y: 6, z: 18.5 }, { x: 35.5, y: 6, z: 27.5 }, 3, [N, N, N]);

const browser = await launchBrowser();
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (/GL_INVALID|WebGL:|shader/i.test(m.text())) errors.push(m.text()); });
};
try {
  // ---- the paint pass, called directly ----
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 800, height: 500 } });
  watch(page);
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`http://localhost:${port}/?size=${N}&preset=empty`);
  await ready(page);
  const got = await page.evaluate(async ({ ids, rates, box, wet, PROP }) => {
    const a = window.__app, sim = a.sim, V = a.THREE.Vector3;
    a.test.park();
    await a.test.ready();   // (the brush needs the grid's pipelines)
    // reads of the state as it is after the paints so far (docs/webgpu.md W6)
    const idAt = async (x, y, z) => Math.round((await sim.readCell(x, y, z))[0][0]);
    const count = async (id) => (await sim.census())[id]?.n ?? 0;
    const out = {};
    sim.paint({ center: new V(0, 0, 0), radius: 64, shape: 1, tool: ids.ERASE, rate: 1, replace: true });   // a clean box
    // a line: the sphere brush swept from one end to the other
    const A = new V(8.5, 40.5, 32.5), B = new V(56.5, 40.5, 40.5), R = 2;
    sim.paint({ center: A, end: B, radius: R, shape: 0, tool: ids.SAND, rate: rates.SAND, replace: false });
    let want = 0;
    const s = B.clone().sub(A), ss = s.lengthSq(), p = new V();
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) for (let z = 0; z < 64; z++) {
      p.set(x + 0.5, y + 0.5, z + 0.5).sub(A);
      const t = Math.min(Math.max(p.dot(s) / ss, 0), 1);
      if (p.sub(s.clone().multiplyScalar(t)).length() <= R) want++;
    }
    out.line = [await count(ids.SAND), want, await idAt(32, 40, 36)];
    // a box of wall, exactly its cells
    sim.paint({ center: new V(box.center.x, box.center.y, box.center.z), grow: box.grow, radius: 3, shape: 1, tool: ids.WALL, rate: rates.WALL, replace: false });
    const vol = (b) => b.hi.map((h, k) => h - b.lo[k]).reduce((m, v) => m * v, 1);
    out.box = [await count(ids.WALL), vol(box), await idAt(box.lo[0], box.lo[1], box.lo[2]), await idAt(box.hi[0], box.lo[1], box.lo[2])];
    // replace mode with a target: water only where wall was
    sim.paint({ center: new V(wet.center.x, wet.center.y, wet.center.z), grow: wet.grow, radius: 3, shape: 1, tool: ids.WATER, rate: rates.WATER, replace: true, filter: ids.WALL });
    const overlap = [0, 1, 2].map((k) => Math.max(0, Math.min(box.hi[k], wet.hi[k]) - Math.max(box.lo[k], wet.lo[k]))).reduce((m, v) => m * v, 1);
    out.replace = [await count(ids.WATER), overlap, await count(ids.WALL), vol(box) - overlap];
    // the Property tool: 500 °C on matter only, then pressure on the air too
    sim.paint({ center: new V(box.center.x, box.center.y, box.center.z), grow: box.grow, radius: 3, shape: 1, tool: ids.PROP, rate: 1, replace: false, prop: { field: PROP.TEMP, value: 500 } });
    const [[wallA], [airA]] = await Promise.all([sim.readCell(box.lo[0], box.lo[1], box.lo[2]), sim.readCell(box.lo[0], box.hi[1] + 1, box.lo[2])]);
    sim.paint({ center: new V(10.5, 20.5, 10.5), radius: 2, shape: 1, tool: ids.PROP, rate: 1, replace: false, prop: { field: PROP.PRESSURE, value: 42 } });
    out.prop = [wallA[1], airA[1], (await sim.readCell(10, 20, 10))[1][3]];
    // specific delete, filtered to water: the water goes, the wall stays
    sim.paint({ center: new V(wet.center.x, wet.center.y, wet.center.z), grow: wet.grow, radius: 3, shape: 1, tool: ids.SAND, rate: 1, replace: false, erase: true, filter: ids.WATER });
    out.del = [await count(ids.WATER), await count(ids.WALL)];
    // a flood fill: a 10×10 wall bowl 5 deep, filled with water up to y = 3
    sim.paint({ center: new V(0, 0, 0), radius: 64, shape: 1, tool: ids.ERASE, rate: 1, replace: true });
    sim.paint({ center: new V(15, 3, 15), grow: [2, 0, 2], radius: 3, shape: 1, tool: ids.WALL, rate: rates.WALL, replace: false });   // x, z 10..19, y 0..5
    sim.paint({ center: new V(15, 5, 15), grow: [1, 1, 1], radius: 3, shape: 1, tool: ids.ERASE, rate: 1, replace: true });   // hollow it: 11..18, y 1..8
    const r = await a.fill({ cell: [14, 1, 14], id: ids.EMPTY, maxY: 3, stroke: { radius: 3, shape: 0, tool: ids.WATER, rate: rates.WATER, replace: false, erase: false, prop: null } });
    out.fill = [r.count, await count(ids.WATER), 8 * 8 * 3];
    return out;
  }, { ids, rates: { SAND: full(E.SAND), WALL: full(E.WALL), WATER: full(E.WATER) }, box, wet, PROP });
  console.log(got);
  assert(Math.abs(got.line[0] - got.line[1]) <= got.line[1] * 0.01, 'a line is the brush swept along it (float edges aside)');
  assert.equal(got.line[2], E.SAND);
  assert.deepEqual(got.box, [got.box[1], got.box[1], E.WALL, E.EMPTY], 'a box fills exactly its cells');
  assert.deepEqual(got.replace.slice(0, 2), [got.replace[1], got.replace[1]], 'replace with a target touches only the target');
  assert.equal(got.replace[2], got.replace[3]);
  assert.equal(got.prop[0], 500, 'PROP sets matter');
  assert.equal(got.prop[1], 20, 'PROP leaves the air\'s temperature');
  assert(Math.abs(got.prop[2] - 42) < 1e-3, 'PROP sets the air\'s pressure');
  assert.deepEqual(got.del, [0, got.replace[3]], 'specific delete erases only the target');
  assert.equal(got.fill[0], got.fill[2], 'the fill fills the bowl to its level');
  assert.equal(got.fill[1], got.fill[2]);
  console.log('ok: line, box, replace target, PROP, specific delete, fill');
  await page.close();

  // ---- through the input: Shift-drag, ⌘-drag, ⌘+Shift-click, one undo step each ----
  const ui = await newTestPage(browser, { mode: 'ui', viewport: { width: 900, height: 600 } });
  watch(ui);
  await ui.routeWebSocket(/.*/, () => {});
  await ui.goto(`http://localhost:${port}/?size=${N}&preset=empty`);
  await ready(ui);
  await ui.evaluate((id) => { window.__app.selectTool(id); }, E.SAND);
  const frames = (n) => ui.evaluate((n) => new Promise((done) => { let k = 0; const f = () => (++k >= n ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const state = () => ui.evaluate(async (sand) => ({ sand: (await window.__app.sim.census())[sand]?.n ?? 0, undo: window.__app.sim.history?.length ?? 0 }), E.SAND);
  const drag = async (mods, from, to) => {
    await ui.mouse.move(...from);
    await frames(6);   // the hover pick
    for (const m of mods) await ui.keyboard.down(m);
    await ui.mouse.down();
    await ui.mouse.move(...to, { steps: 8 });
    await frames(4);
    await ui.mouse.up();
    for (const m of mods) await ui.keyboard.up(m);
    await frames(4);
  };
  const s0 = await state();
  await drag(['Shift'], [380, 420], [520, 400]);
  const s1 = await state();
  await drag(['Meta'], [400, 380], [480, 360]);
  const s2 = await state();
  console.log({ s0, s1, s2 });
  assert(s1.sand > s0.sand && s1.undo === s0.undo + 1, 'Shift-drag puts a line down, one undo step');
  assert(s2.sand > s1.sand && s2.undo === s1.undo + 1, '⌘-drag puts a box down, one undo step');
  console.log('ok: Shift-drag line and ⌘-drag box through the input');
  await ui.close();
  assert.deepEqual(errors, [], 'no page or GL errors');
} finally {
  await browser.close();
}
