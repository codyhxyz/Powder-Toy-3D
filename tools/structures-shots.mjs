// Stills of the World structures on the island (docs/structures.md): each
// construction stamped at T = 1 on the World's terrain, its base at the
// highest ground under it (footings fill the rest), then god views and
// first-person views from the doorways, decks and landings. Also checks
// nothing loose moves once they are placed: a census before and after a few
// seconds of sim.
// usage: node tools/structures-shots.mjs [--port 5396] [--out dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5396');
const out = opt('out', 'shots');
const W = 1280, H = 800;
const INLAND = 72;         // cells the inland window sits from the start window, toward the island's middle
const SETTLE_MS = 2500;    // sim time after stamping, before the census and the shots
const SHOT_MS = 900;       // frames to settle a view (TAA)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?size=world`);
await p.waitForFunction(() => window.__app?.win?.P, null, { timeout: 60000 });
await p.waitForTimeout(4000);
await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });

// page helpers: stamp a built-in on the terrain; frame the god view; drop the body somewhere
await p.evaluate(async () => {
  const a = window.__app;
  const { runGenerator, bake } = await import('/src/constructions/runtime.js');
  const { BUILTINS } = await import('/src/constructions/builtins.js');
  const { generatorFor } = await import('/src/world/gpu.js');
  const { heightAt, treesIn } = await import('/src/world/generator.js');
  const H = window.__ss = {};
  H.frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  H.ground = (x, z) => Math.floor(heightAt(x + a.sim.origin.x, z + a.sim.origin.z, a.win.P) + 0.5);
  const CLEARING = 6;   // cells round a footprint whose trees are felled first (stamped over with air, as app.js does for the shrine)
  const SLOPE_RUN = 8;  // cells either side the downhill direction is measured over
  // the quarter turn that points a construction's front (+z) downhill at grid column (x, z)
  H.downhill = (x, z) => {
    const gx = H.ground(x + SLOPE_RUN, z) - H.ground(x - SLOPE_RUN, z), gz = H.ground(x, z + SLOPE_RUN) - H.ground(x, z - SLOPE_RUN);
    return Math.abs(gx) > Math.abs(gz) ? (gx < 0 ? 1 : 3) : (gz < 0 ? 0 : 2);
  };
  // stamp key:variant with its front turned by quarter, its origin on grid column (cx, cz);
  // its base at the highest ground under it, or (atOrigin) at the ground under its origin
  H.place = (spec, cx, cz, quarter = 0, atOrigin = false) => {
    const [key, variant] = spec.split(':');
    const s = bake(runGenerator(BUILTINS[key], { size: 5, seed: 1, variant }), quarter);
    const x0 = cx - s.base.x, z0 = cz - s.base.z, o = a.sim.origin;
    let y = 0;
    for (let z = z0; z < z0 + s.d; z += 2) for (let x = x0; x < x0 + s.w; x += 2) y = Math.max(y, H.ground(x, z));
    if (atOrigin) y = H.ground(cx, cz);
    const trees = treesIn(o.x + x0 - CLEARING, o.z + z0 - CLEARING, o.x + x0 + s.w + CLEARING, o.z + z0 + s.d + CLEARING, a.win.P, a.win.candidates);
    for (const t of trees) {
      const tb = a.win.bakeTree(t);
      if (!tb) continue;
      const air = { ...tb, foot: 0, data: tb.data.map((v, i) => (i % 4 === 0 ? (v > 0.5 ? 1 : 0) : i % 4 === 3 ? 0 : v)) };
      generatorFor(a.sim).stamp(air, [t.x - o.x - tb.base.x, t.y - o.y - tb.base.y, t.z - o.z - tb.base.z], 7);
    }
    generatorFor(a.sim).stamp(s, [x0, y - s.base.y, z0], 7);
    return { spec, cx, cz, y, w: s.w, h: s.h, d: s.d };
  };
  H.view = (from, to) => {
    const s = a.scale, v = a.volume.position;
    a.camera.position.set(v.x + from[0] * s, from[1] * s, v.z + from[2] * s);
    a.controls.target.set(v.x + to[0] * s, to[1] * s, v.z + to[2] * s);
    a.controls.update();
  };
  H.census = () => Object.fromEntries(Object.entries(a.sim.census()).map(([id, c]) => [id, c.n]));
});
const ev = (fn, arg) => p.evaluate(fn, arg);
const shot = async (name) => { await p.waitForTimeout(SHOT_MS); await p.screenshot({ path: `${out}/${name}.png` }); console.log(`shot ${name}`); };

// ---- inland: houses, well, campfire, stones, towers, mine
const placed = await ev(async (INLAND) => {
  const a = window.__app, H = window.__ss, sim = a.sim, P = a.win.P;
  H.start = [sim.origin.x, sim.origin.z];
  const o = [sim.origin.x + 64, sim.origin.z + 64];
  const d = [P.center[0] - o[0], P.center[1] - o[1]], l = Math.hypot(...d);
  const O = [Math.round((sim.origin.x + (d[0] / l) * INLAND) / 16) * 16, Math.round((sim.origin.z + (d[1] / l) * INLAND) / 16) * 16];
  a.worldLoad([O[0], 0, O[1]]);
  a.worldFocus = [O[0] + 64, O[1] + 64];
  await H.frames(30);
  const list = [
    ['HOUSE:cottage', 18, 22], ['HOUSE:cabin', 46, 22], ['HOUSE:brick', 74, 22], ['WELL', 60, 46],
    ['CAMPFIRE:unlit', 36, 48], ['TOWER:watch', 104, 24], ['STONES', 24, 84], ['TOWER:ruin', 66, 84],
    ['TOWER:lighthouse', 104, 72], ['MINE', 104, 108],
  ];
  const r = list.map(([s, x, z]) => (s === 'MINE' ? H.place(s, x, z, H.downhill(x, z), true) : H.place(s, x, z)));
  return { origin: O, r };
}, INLAND);
console.log(JSON.stringify(placed));
const before = await ev(() => window.__ss.census());
await p.waitForTimeout(SETTLE_MS);
const after = await ev(() => window.__ss.census());
const moved = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).map((k) => `${k} ${before[k]}→${after[k]}`);
console.log(`census change after ${SETTLE_MS} ms: ${moved.join(', ') || 'none'}`);

const at = (spec) => placed.r.find((q) => q.spec === spec);
const gy = placed.r.reduce((m, q) => Math.max(m, q.y), 0);
await ev((gy) => window.__ss.view([-30, gy + 70, -40], [64, gy - 10, 64]), gy);
await shot('inland-god');
await ev((gy) => window.__ss.view([150, gy + 40, 150], [60, gy, 50]), gy);
await shot('inland-god-back');

// first person: in the cottage's doorway, on the lighthouse's gallery, in the mine
await ev(async () => { const a = window.__app; a.pov.test.assumeLocked = true; await a.pov.enter(); });
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => console.log('POV did not come on'));
const drop = async (name, feet, yaw, pitch) => {
  await ev(([f, yaw, pitch]) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.player.spawn(new V(...f));
    a.pov.setLook(yaw, pitch);
  }, [feet, yaw, pitch]);
  await shot(name);
};
const c = at('HOUSE:cottage'), L = at('TOWER:lighthouse'), M = at('MINE'), Wt = at('TOWER:watch');
// yaw: 0 looks toward -z, π toward +z (camera convention: atan2(-fwd.x, -fwd.z))
await drop('pov-cottage-door', [c.cx + 0.5, c.y + 1, c.cz + 14], 0, -0.05);
await drop('pov-cottage-inside', [c.cx + 0.5, c.y + 1, c.cz + 4], 0, -0.15);
await drop('pov-lighthouse-gallery', [L.cx + 0.5, L.y + 38, L.cz + 8], Math.PI, -0.25);
await drop('pov-watchtower-deck', [Wt.cx + 0.5, Wt.y + 26, Wt.cz + 5.5], Math.PI * 0.75, -0.2);
await drop('pov-mine', [M.cx + 0.5, M.y + 1, M.cz + 6], 0, -0.05);
await drop('pov-stones', [at('STONES').cx + 0.5, at('STONES').y + 1, at('STONES').cz + 22], 0, -0.05);
await ev(() => window.__app.pov.exit());
await p.waitForTimeout(1500);

// ---- the shore: the start window, a dock and a wreck on the beach
const start = await ev(() => window.__ss.start);
const beach = await ev(async (startOrigin) => {
  const a = window.__app, H = window.__ss, sim = a.sim, P = a.win.P;
  const { layersAt } = await import('/src/world/generator.js');
  a.worldLoad([startOrigin[0], 0, startOrigin[1]]);
  a.worldFocus = [startOrigin[0] + 64, startOrigin[1] + 64];
  await H.frames(30);
  // walk from the window's land side toward the sea: the first sand column at sea level + 1
  const toSea = [sim.origin.x + 64 - P.center[0], sim.origin.z + 64 - P.center[1]], l = Math.hypot(...toSea);
  const dir = [toSea[0] / l, toSea[1] / l];
  const q = Math.abs(dir[0]) > Math.abs(dir[1]) ? (dir[0] > 0 ? 1 : 3) : (dir[1] > 0 ? 0 : 2); // front (+z) toward the sea
  const step = q === 1 ? [1, 0] : q === 3 ? [-1, 0] : q === 0 ? [0, 1] : [0, -1];
  const found = [];
  for (const lane of [-30, 30]) {
    let x = 64 - step[0] * 60 + (step[0] ? 0 : lane), z = 64 - step[1] * 60 + (step[1] ? 0 : lane);
    for (let i = 0; i < 120; i++, x += step[0], z += step[1]) {
      if (x < 4 || z < 4 || x > 124 || z > 124) break;
      const L = layersAt(x + sim.origin.x, z + sim.origin.z, P);
      if (L.ground <= P.sea + 1) { found.push([x, z]); break; }
    }
  }
  const r = [];
  if (found[0]) r.push(H.place('DOCK:hut', found[0][0] - step[0] * 2, found[0][1] - step[1] * 2, q));
  if (found[1]) r.push(H.place('WRECK', found[1][0] - step[0] * 4, found[1][1] - step[1] * 4, (q + 1) & 3));
  return { q, dir, found, r, sea: P.sea };
}, start).catch((e) => ({ error: String(e) }));
console.log('shore', JSON.stringify(beach));
await p.waitForTimeout(SETTLE_MS);
if (beach.r?.length) {
  const d0 = beach.r[0];
  const back = [d0.cx - beach.dir[0] * 40, beach.sea + 30, d0.cz - beach.dir[1] * 40];
  await ev(([f, t]) => window.__ss.view(f, t), [back, [d0.cx + beach.dir[0] * 20, beach.sea, d0.cz + beach.dir[1] * 20]]);
  await shot('shore-god');
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close();
