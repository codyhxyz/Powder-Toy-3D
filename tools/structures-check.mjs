// Headless check of the World's structures (world/structures.js, docs/structures.md):
//   - placement: the island's structures by kind;
//   - stability: every cell's element after STEPS sim steps vs right after
//     loading, in a window over a village and one over a dock;
//   - seams: a structure across the window's edge, the window then walked over
//     it a WIN_STEP at a time, against a fresh load at the same origin;
//   - stills: a village, walking into one of its houses in first person, the
//     lighthouse on its headland, the bridge across the gorge (and on its
//     deck), a hermit's cabin at its tarn, a mine, a dock, a wreck, and the far
//     field's structures from afar.
// usage: node tools/structures-check.mjs [outDir] [--port 5396] [--steps 600]   (needs a dev server)
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots';
const port = opt('port', '5396');
const STEPS = +opt('steps', 600);
const SETTLE_MS = 1200;     // frames for TAA to settle a still
const WALK_MS = 1800;       // holding W to walk in through a door
const W = 1280, H = 800;
mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?size=world`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.waitForFunction(() => window.__app?.win?.far?.built, null, { timeout: 90000 });
await p.waitForFunction(() => window.__app.win.far.queue.length === 0, null, { timeout: 60000 });
await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
const ev = (fn, arg) => p.evaluate(fn, arg);
const shot = async (name) => { await p.waitForTimeout(SETTLE_MS); await p.screenshot({ path: `${out}/${name}.png` }); console.log(`shot ${name}`); };

await ev(async () => {
  const a = window.__app, H = window.__sc = {};
  const { structuresOf } = await import('/src/world/structures.js');
  H.list = structuresOf(a.win.P).map(({ kind, key, variant, quarter, x, y, z, x0, z0, s }) => ({ kind, key, variant, quarter, x, y, z, x0, z0, w: s.w, h: s.h, d: s.d }));
  H.lakes = a.win.P.landforms?.lakes ?? [];
  H.ground = (x, z) => a.win.scene.ground(x, z, a.win.P);   // world column's top
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const clamp16 = (v, n) => Math.max(0, Math.min(a.win.P.size[0] - n, Math.round(v / 16) * 16));
  // the window over world column (x, z), and the god view looking at it from `from` (grid cells, relative to the window)
  H.goto = async (x, z) => {
    const n = a.sim.g.nx, o = [clamp16(x - n / 2, n), clamp16(z - n / 2, n)];
    a.worldLoad([o[0], 0, o[1]]);
    a.worldFocus = [o[0] + n / 2, o[1] + n / 2];
    await H.frames(20);
    return o;
  };
  H.view = (from, to) => {
    const s = a.scale, v = a.volume.position;
    a.camera.position.set(v.x + from[0] * s, from[1] * s, v.z + from[2] * s);
    a.controls.target.set(v.x + to[0] * s, to[1] * s, v.z + to[2] * s);
    a.controls.update();
  };
  // every cell's element in grid box [lo, hi)
  H.ids = (lo = [0, 0, 0], hi = null) => {
    const sim = a.sim, g = sim.g, [A] = sim.readState(), e = hi ?? [g.nx, g.ny, g.nz], out = [];
    for (let z = lo[2]; z < e[2]; z++) for (let y = lo[1]; y < e[1]; y++) for (let x = lo[0]; x < e[0]; x++) out.push(Math.round(A[sim.cellTexel(x, y, z) * 4]));
    return out;
  };
});
const list = await ev(() => window.__sc.list);
const tally = {};
for (const s of list) { const k = `${s.key}${s.variant ? `:${s.variant}` : ''}`; tally[k] = (tally[k] ?? 0) + 1; }
console.log(`structures: ${list.length}`, JSON.stringify(tally));
const first = (kind) => list.find((s) => s.kind === kind);

// ---- stability: a village and a dock
const stable = async (s, tag, on = true) => {
  const r = await ev(async ([s, STEPS, on]) => {
    const a = window.__app, H = window.__sc;
    a.settings.paused = true;
    a.win.sceneU.uStructOn.value = on;
    await H.goto(s.x, s.z);
    const before = H.ids(), f0 = a.sim.frame;
    a.settings.paused = false;
    while (a.sim.frame - f0 < STEPS) await H.frames(10);
    a.settings.paused = true;
    const after = H.ids(), changes = {};
    let n = 0;
    const g = a.sim.g, o = a.sim.origin, where = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) {
      n++; const k = `${before[i]}→${after[i]}`; changes[k] = (changes[k] ?? 0) + 1;
      if (where.length < 4) where.push([o.x + (i % g.nx), Math.floor(i / g.nx) % g.ny, o.z + Math.floor(i / (g.nx * g.ny))]);
    }
    a.win.sceneU.uStructOn.value = true;
    return { steps: a.sim.frame - f0, changed: n, changes, where };
  }, [s, STEPS, on]);
  console.log(`stability at ${tag}${on ? '' : ' (structures off)'}: ${JSON.stringify(r)} (the structure's box: x ${s.x0}..${s.x0 + s.w}, z ${s.z0}..${s.z0 + s.d})`);
  if (on && r.changed) await stable(s, tag, false);
};
for (const k of ['village', 'dock', 'bridge', 'hermit']) if (first(k)) await stable(first(k), k);

// ---- seams: a structure across the window's +x edge, walked over, against a fresh load
const seam = await ev(async (s) => {
  const a = window.__app, H = window.__sc, n = a.sim.g.nx;
  a.settings.paused = true;
  const ox = Math.round((s.x0 + s.w / 2 - n) / 16) * 16, oz = Math.max(0, Math.round((s.z0 + s.d / 2 - n / 2) / 16) * 16);
  a.worldLoad([ox, 0, oz]);
  a.worldFocus = [ox + n / 2, oz + n / 2];
  await H.frames(10);
  // walk the window 3 steps +x (one move per WIN_STEP), waiting out each move
  for (let i = 1; i <= 3; i++) {
    a.worldFocus = [ox + n / 2 + 16 * i + 6, oz + n / 2];
    for (let k = 0; k < 120 && (a.sim.origin.x !== ox + 16 * i || a.win.pending); k++) await H.frames(1);
  }
  const o = [a.sim.origin.x, a.sim.origin.z];
  const lo = [s.x0 - o[0], 0, s.z0 - o[1]], hi = [s.x0 - o[0] + s.w, a.sim.g.ny, s.z0 - o[1] + s.d];
  const moved = H.ids(lo, hi);
  a.worldLoad([o[0], 0, o[1]]);
  await H.frames(10);
  const fresh = H.ids(lo, hi);
  let diff = 0;
  for (let i = 0; i < fresh.length; i++) if (fresh[i] !== moved[i]) diff++;
  return { structure: `${s.key}:${s.variant ?? ''}`, startOrigin: [ox, oz], endOrigin: o, cells: fresh.length, differ: diff };
}, list.find((s) => s.key === 'HOUSE') ?? list[0]);
console.log('seam:', JSON.stringify(seam));

// ---- stills
const at = async (s, from, to) => {
  const o = await ev((s) => window.__sc.goto(s.x, s.z), s);
  const rel = (v) => [v[0], v[1], v[2]];
  await ev(([f, t]) => window.__sc.view(f, t), [rel(from(s, o)), rel(to(s, o))]);
};
const V = first('village');
if (V) {
  await at(V, (s, o) => [s.x - o[0] - 50, s.y + 45, s.z - o[1] - 50], (s, o) => [s.x - o[0], s.y, s.z - o[1]]);
  await shot('village');
  // first person: outside a village house's door, walking in
  const house = list.find((s) => s.kind === 'village' && s.key === 'HOUSE');
  if (house) {
    await ev(async (h) => {
      const a = window.__app, V3 = a.camera.position.constructor, o = a.sim.origin;
      const F = [[0, 1], [1, 0], [0, -1], [-1, 0]][h.quarter];
      a.pov.test.assumeLocked = true;
      await a.pov.enter();
      for (let k = 0; k < 200 && a.pov.mode !== 'on'; k++) await window.__sc.frames(1);
      // the door is at the front (+z turned by the quarter), on the house's middle line; stand 6 cells out from the wall
      const cx = h.x0 + h.w / 2 - o.x, cz = h.z0 + h.d / 2 - o.z, half = (F[0] ? h.w : h.d) / 2;
      a.pov.player.spawn(new V3(cx + F[0] * (half + 6), h.y + 1, cz + F[1] * (half + 6)));
      a.pov.setLook(Math.atan2(F[0], F[1]), -0.05);
    }, house);
    await shot('pov-house-door');
    await p.keyboard.down('w');
    await p.waitForTimeout(WALK_MS);
    await p.keyboard.up('w');
    await shot('pov-house-inside');
    console.log('pov after walking:', JSON.stringify(await ev((h) => {
      const a = window.__app, pp = a.pov.player.pos, o = a.sim.origin;
      const inside = pp.x + o.x > h.x0 && pp.x + o.x < h.x0 + h.w && pp.z + o.z > h.z0 && pp.z + o.z < h.z0 + h.d;
      return { feet: [+(pp.x + o.x).toFixed(1), +pp.y.toFixed(1), +(pp.z + o.z).toFixed(1)], inside };
    }, house)));
    await ev(() => window.__app.pov.exit());
    await p.waitForTimeout(1200);
  }
}
const L = first('lighthouse');
if (L) {
  await at(L, (s, o) => [s.x - o[0] + 60, s.y + 30, s.z - o[1] + 60], (s, o) => [s.x - o[0], s.y + 20, s.z - o[1]]);
  await shot('lighthouse');
}
const D = first('dock');
if (D) {
  await at(D, (s, o) => [s.x - o[0] - 30, s.y + 22, s.z - o[1] - 30], (s, o) => [s.x - o[0] + 10, s.y, s.z - o[1] + 10]);
  await shot('dock');
}
const Wr = first('wreck');
if (Wr) {
  await at(Wr, (s, o) => [s.x - o[0] + 30, s.y + 20, s.z - o[1] - 30], (s, o) => [s.x - o[0], s.y, s.z - o[1]]);
  await shot('wreck');
}
// the landform sites: front = the record's front (+z turned by its quarter)
const FRONTS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const lakes = await ev(() => window.__sc.lakes);
const Lh = first('lighthouse');
if (Lh) {   // from the sea: behind its door, which faces inland
  const [fx, fz] = FRONTS[Lh.quarter];
  const gy = await ev(([x, z]) => window.__sc.ground(x, z), [Lh.x - fx * 70, Lh.z - fz * 70]);
  await at(Lh, (s, o) => [s.x - o[0] - fx * 70, Math.max(gy, s.y) + 22, s.z - o[1] - fz * 70], (s, o) => [s.x - o[0], s.y + 14, s.z - o[1]]);
  await shot('landform-lighthouse');
}
const B = first('bridge');
if (B) {   // down the gorge: across the span's axis
  const [fx, fz] = FRONTS[B.quarter];
  await at(B, (s, o) => [s.x - o[0] - fz * 45, s.y + 10, s.z - o[1] + fx * 45], (s, o) => [s.x - o[0], s.y - 6, s.z - o[1]]);
  await shot('landform-bridge');
  await ev(async (b) => {
    const a = window.__app, V3 = a.camera.position.constructor, o = a.sim.origin, [fx, fz] = [[0, 1], [1, 0], [0, -1], [-1, 0]][b.quarter];
    a.pov.test.assumeLocked = true;
    await a.pov.enter();
    for (let k = 0; k < 200 && a.pov.mode !== 'on'; k++) await window.__sc.frames(1);
    a.pov.player.spawn(new V3(b.x - o.x + 0.5 - fx * 10, b.y + 2, b.z - o.z + 0.5 - fz * 10));
    a.pov.setLook(Math.atan2(-fx, -fz) + Math.PI, -0.1);
  }, B);
  await shot('landform-bridge-deck');
  await ev(() => window.__app.pov.exit());
  await p.waitForTimeout(1200);
}
const He = first('hermit');
if (He && lakes.length) {   // from over its tarn
  const l = lakes.reduce((b, k) => (Math.hypot(k.x - He.x, k.z - He.z) < Math.hypot(b.x - He.x, b.z - He.z) ? k : b));
  const d = Math.hypot(He.x - l.x, He.z - l.z), ux = (He.x - l.x) / d, uz = (He.z - l.z) / d;
  await at(He, (s, o) => [l.x - o[0] - ux * (l.r + 6), l.level + 14, l.z - o[1] - uz * (l.r + 6)], (s, o) => [s.x - o[0], s.y + 4, s.z - o[1]]);
  await shot('landform-hermit');
}
const Mi = first('mine');
if (Mi) {   // in front of its portal, which faces down the slope
  const [fx, fz] = FRONTS[Mi.quarter];
  const gy = await ev(([x, z]) => window.__sc.ground(x, z), [Mi.x + fx * 26, Mi.z + fz * 26]);
  console.log('mine:', JSON.stringify(Mi), 'ground at the camera', gy);
  await at(Mi, (s, o) => [s.x - o[0] + fx * 26, Math.max(gy, s.y) + 10, s.z - o[1] + fz * 26], (s, o) => [s.x - o[0], s.y + 5, s.z - o[1]]);
  await shot('landform-mine');
}

// from afar: the window at the village, the camera high over it looking toward the lighthouse
if (V && L) {
  const o = await ev((s) => window.__sc.goto(s.x, s.z), V);
  await ev(([o, L]) => window.__sc.view([64, 110, 64], [L.x - o[0], L.y + 20, L.z - o[1]]), [o, L]);
  await shot('far-lighthouse');
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close();
