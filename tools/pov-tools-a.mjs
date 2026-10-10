// Headless check of the POV toolbelt (hotbar, shovel, bucket, exact transfer).
// Drives createToolbelt directly with a hand-built ctx and proves matter is
// conserved exactly with sim.census() (grid + loads) while the sim runs.
// usage: node tools/pov-tools-a.mjs [--port 5194] [--shot out.png]
import { launchBrowser, newTestPage } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5194');
const shot = opt('shot');

const b = await launchBrowser();
const p = await newTestPage(b, { mode: shot ? 'visual' : 'preview', viewport: { width: 1100, height: 700 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 2000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

const res = await p.evaluate(async () => {
  const a = window.__app;
  const { E, ELEMENTS } = await import('/src/elements.js');
  const { createToolbelt } = await import('/src/pov/tools/index.js');
  const V3 = a.camera.position.constructor;
  const Group = Object.getPrototypeOf(a.scene.constructor);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const sim = () => a.sim;
  const toasts = [];
  const env = {
    renderer: a.renderer, scene: a.scene, getSim: sim, getVolume: () => a.volume, getScale: () => a.scale,
    hud: { toast: (t) => toasts.push(t) }, viewmodel: new Group(), isActive: () => true,
  };
  const belt = createToolbelt(env);
  belt.setVisible(true);

  // one cell's element, read synchronously (test only)
  const cell = (x, y, z) => Math.round(sim().readCell(x, y, z)[0][0]);
  const top = (x, z) => { for (let y = sim().g.ny - 1; y >= 0; y--) if (cell(x, y, z) !== E.EMPTY) return y; return -1; };
  // matter: grid census plus every load (ids other than air)
  function totals() {
    const c = sim().census();
    const t = {};
    for (const k in c) if (+k !== E.EMPTY) t[ELEMENTS[k].key] = c[k].n;
    for (const load of [belt.tool(0).load, belt.tool(1).load]) for (const [id, n] of Object.entries(load.totals())) t[ELEMENTS[id].key] = (t[ELEMENTS[id].key] ?? 0) + n;
    return t;
  }
  const diff = (x, y) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])]
    .map((k) => [k, (y[k] ?? 0) - (x[k] ?? 0)]).filter(([, d]) => d));
  const settle = async () => { while (belt.transfer.pending) await frame(); await wait(2); };

  // ctx: eye above-and-beside the aim cell, looking at it
  const player = { pos: new V3(2, 0, 2), vel: new V3(), onGround: true, inLiquid: false, applyImpulse() {} };
  function ctx(aimCell, id, extra = {}) {
    const eye = aimCell ? new V3(aimCell.x + 0.5, aimCell.y + 3.5, aimCell.z - 1.5) : new V3(32, 8, 32);
    const dir = aimCell ? new V3(aimCell.x + 0.5, aimCell.y + 0.5, aimCell.z + 0.5).sub(eye).normalize() : new V3(0, -0.5, 1).normalize();
    return {
      sim: sim(), dt: 1 / 60, stepsPerFrame: a.settings.steps, eye, dir,
      primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
      aim: aimCell ? { valid: true, cell: aimCell, face: 2, id, T: 20, P: 0, dist: 3 } : { valid: false },
      player, ...extra,
    };
  }
  const out = {};

  // ---- scene: a sand heap, a water pool in a wall basin, a rock block
  const paint = (center, radius, tool, shape = 1) => sim().paint({ center: new V3(...center), radius, shape, tool, rate: 4, replace: true });
  paint([16, 4, 16], 4, E.SAND);
  paint([46, 2, 46], 6, E.WALL);
  paint([46, 3, 46], 5, E.WATER);
  paint([16, 3, 46], 3, E.ROCK);
  await wait(120);

  // ---- hotbar: keys and wheel
  dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
  out.keySelect = belt.selected;
  belt.update(ctx(null, -1, { wheel: 1 }));
  out.wheelSelect = belt.selected;
  belt.select(0);

  // ---- shovel: scoop sand, throw it elsewhere
  const shovel = belt.tool(0);
  const t0 = totals();
  for (let i = 0; i < 90 && shovel.load.count + shovel.load.reserved < 30; i++) {
    const y = top(16, 16);
    belt.update(ctx(new V3(16, y, 16), cell(16, y, 16), { primary: true }));
    await frame();
  }
  await settle();
  const t1 = totals();
  out.shovelScoop = { load: shovel.load.status(), grid: sim().census()[E.SAND].n, diff: diff(t0, t1) };
  for (let i = 0; i < 6 && shovel.load.count; i++) {
    belt.update(ctx(new V3(30, -1, 20), -1, { secondaryPressed: true }));
    await settle();
  }
  await wait(60);
  const t2 = totals();
  out.shovelDump = { left: shovel.load.count, diff: diff(t0, t2) };

  // ---- shovel on rock: breaks into stone
  const tr0 = totals();
  for (let i = 0; i < 120; i++) {
    const y = top(16, 46);
    const id = cell(16, y, 46);
    belt.update(ctx(new V3(16, y, 46), id, { primary: true }));
    await frame();
  }
  await settle();
  const tr1 = totals();
  out.shovelRock = { load: shovel.load.status(), loadTotals: shovel.load.totals(), diff: diff(tr0, tr1) };
  // wall refuses
  belt.update(ctx(new V3(40, 7, 46), E.WALL, { primary: true }));
  out.wallToast = toasts.at(-1);
  // throw the stone back out
  for (let i = 0; i < 6 && shovel.load.count; i++) { belt.update(ctx(null, -1, { secondaryPressed: true })); await settle(); }
  await wait(30);
  out.shovelRockDump = { left: shovel.load.count, diff: diff(tr0, totals()) };

  // ---- bucket: scoop water, pour it out
  belt.select(1);
  const bucket = belt.tool(1);
  const tw0 = totals();
  for (let i = 0; i < 60 && bucket.load.count + bucket.load.reserved < 60; i++) {
    const y = top(46, 46);
    belt.update(ctx(new V3(46, y, 46), cell(46, y, 46), { primary: true, primaryPressed: i === 0 }));
    await frame();
  }
  await settle();
  const tw1 = totals();
  out.bucketScoop = { load: bucket.load.status(), diff: diff(tw0, tw1) };
  const pourCtx = () => ({ ...ctx(null, -1, { secondary: true }), eye: new V3(24, 10, 24), dir: new V3(0.3, -0.2, 0.93).normalize() });
  for (let i = 0; i < 240 && bucket.load.count; i++) { belt.update(pourCtx()); await frame(); }
  await settle();
  await wait(30);
  out.bucketPour = { left: bucket.load.count, diff: diff(tw0, totals()) };

  // ---- lava keeps its temperature in the bucket
  paint([30, 1, 8], 2, E.LAVA);
  await wait(10);
  const ly = top(30, 8);
  for (let i = 0; i < 3; i++) { belt.update(ctx(new V3(30, ly, 8), E.LAVA, { primary: true, primaryPressed: i === 0 })); await frame(); }
  await settle();
  out.lavaBucket = { status: bucket.load.status(), T: bucket.load.cells.slice(0, 3).map((c) => +c[1].toFixed(0)) };

  // ---- stress: overlapping takes and puts in flight together, sim running
  {
    const { Load, cellsNear } = await import('/src/pov/tools/transfer.js');
    const tx = belt.transfer, g = sim().g;
    const LA = new Load(200), LB = new Load(200);
    paint([30, 3, 30], 3, E.SAND);
    await wait(60);
    const both = () => { const t = totals(); for (const L of [LA, LB]) for (const [id, n] of Object.entries(L.totals())) t[ELEMENTS[id].key] = (t[ELEMENTS[id].key] ?? 0) + n; return t; };
    const s0 = both();
    let ops = 0, moved = 0;
    const c = new V3(30.5, 2, 30.5), up = new V3(30.5, 6, 30.5);
    for (let i = 0; i < 150; i++) {
      const r = [
        tx.take(LA, { cells: cellsNear(c, 3, g), kinds: [2] }),
        tx.put(LA, { cells: cellsNear(up, 3, g), max: 10 }),
        tx.take(LB, { cells: cellsNear(c, 2.5, g), kinds: [2], limit: 7 }),
        tx.put(LB, { cells: cellsNear(c, 3, g), max: 5 }),
      ];
      for (const q of r) if (q) { ops++; q.then((v) => { moved += Array.isArray(v) ? v.length : v; }); }
      await frame();
    }
    await settle();
    out.stress = { ops, moved, inLoads: LA.count + LB.count, diff: diff(s0, both()) };
  }

  // leave the hotbar showing a full-ish shovel for the screenshot
  belt.select(0);
  for (let i = 0; i < 30; i++) { const y = top(16, 16); belt.update(ctx(new V3(16, y, 16), cell(16, y, 16), { primary: true })); await frame(); }
  await settle();
  belt.update(ctx(null, -1));
  out.statuses = [...document.querySelectorAll('.hb-status')].map((e) => e.textContent);
  out.toasts = toasts;
  return out;
});
console.log(JSON.stringify(res, null, 1));
if (shot) {
  const box = await p.locator('.hotbar').boundingBox();
  await p.screenshot({ path: shot, clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 } });
}
if (errs.length) console.log(errs.join('\n'));
await b.close();
