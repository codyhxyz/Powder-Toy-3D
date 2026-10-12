// Headless GPU check of the electricity (src/electricity.js, docs/electricity.md)
// in a Lab box (128³), one browser:
//   - the programs compile (no page or shader errors)
//   - battery → 2×2 steel wire: the spark's front reaches x0 + k at step k
//   - the wire runs into a glass tank of water: how far in the water goes live
//   - P → N passes and N → P stops; a temperature sensor touched by hot stone
//     sparks its wire; a powered clone switched on by a spark in P copies sand
//   - the Spark tool (sim.paint, tool SPARK) sparks a bare bar
//   - the activity map: the flag-built inert and quiet maps against the
//     reference built from the state (as tools/activity-check.mjs), and the
//     spark states with quiet bricks skipped against a run with none skipped
//   - stills of the wire and the tank, by day and by night
// Prints JSON and writes the stills to <outDir>.
// usage: node tools/elec-gpu-check.mjs <outDir> [--port 5416]
//   (the app on your own Vite: npx vite --port 5416 --strictPort)
import { mkdirSync } from 'fs';
import { launchBrowser, newTestContext, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5416');
mkdirSync(out, { recursive: true });

const VIEW = { width: 960, height: 600 };   // small stills
const SEED = 12345;                         // Math.random seed (mulberry32, as tools/activity-check.mjs)
const DAY = { az: 60, el: 35 };
const NIGHT = { az: 60, el: -20 };

const b = await launchBrowser();
try {
// a parked app (manual mode): the steps are ours, the stills converged views (tools/browser.mjs render)
const ctx = await newTestContext(b, { mode: 'manual', viewport: VIEW });
await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
await ctx.addInitScript((seed) => {
  let s = seed;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__reseed = () => { s = seed; };
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true }));
}, SEED);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
p.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GPUValidationError|WGSL/.test(t)) errs.push(t.slice(0, 600));
});
await p.goto(`http://localhost:${port}/?preset=empty&size=128`, { timeout: 180000, waitUntil: 'domcontentloaded' });
await ready(p);
await p.evaluate(() => window.__app.test.ready());

// The scene, in cells. Wires along x, 2×2 thick, at y WY, WY+1.
const L = {
  bat: [20, 24],                       // battery block x range (y WY-1..WY+2, z around the wire)
  wire: { x0: 24, x1: 104, y: 9, z: 63 },   // into the tank: its last 3 cells stand in the water
  tank: { x0: 100, x1: 118, y1: 17, z0: 54, z1: 74, water: 15 },   // glass, 1 thick, open on top; water below y = water
  diode: { z: 40, y: 9, x0: 20, len: 30 },   // battery, 4 metal, P N or N P, metal
  tsns: { z: 90, y: 9, x0: 20 },              // sensor, metal wire; stone above the sensor
  pcln: { z: 100, y: 20, x: 60 },             // P, then a powered clone holding sand, air above
  bar: { z: 20, y: 30, x0: 30, x1: 70 },      // a bare bar for the Spark tool
};

const res = await p.evaluate(async (L) => {
  const a = window.__app, sim = a.sim;
  const { E, ELEMENTS, TOOLS } = await import('/src/elements.js');
  const { isLive, sparkOf, SPARK_CYCLE } = await import('/src/electricity.js');
  a.test.park();
  if (a.autoRes) a.autoRes.enabled = false;
  window.__scene = (x, y, z) => { const s = a.scale, o = sim.origin, v = a.volume.position; return [v.x + (x - o.x) * s, v.y + y * s, v.z + (z - o.z) * s]; };

  // ---- the scene ----
  const build = (withBattery = true) => {
    const [A, B] = sim.blankState();
    const set = (x, y, z, id, o = {}) => {
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = o.T ?? ELEMENTS[id].temp; A[i + 2] = o.life ?? ELEMENTS[id].life;
      A[i + 3] = (o.ctype ?? 0) + Math.random() * 0.999;
    };
    const W = L.wire, T = L.tank;
    for (let x = T.x0; x < T.x1; x++) for (let y = 0; y < T.y1; y++) for (let z = T.z0; z < T.z1; z++) {
      const wall = x === T.x0 || x === T.x1 - 1 || z === T.z0 || z === T.z1 - 1 || y === 0;
      if (wall) set(x, y, z, E.GLASS); else if (y < T.water) set(x, y, z, E.WATER);
    }
    for (let x = L.bat[0]; x < L.bat[1]; x++) for (let y = W.y - 1; y <= W.y + 2; y++) for (let z = W.z - 1; z <= W.z + 2; z++) set(x, y, z, withBattery ? E.BATTERY : E.WALL);
    for (let x = W.x0; x < W.x1; x++) for (let y = W.y; y <= W.y + 1; y++) for (let z = W.z; z <= W.z + 1; z++) set(x, y, z, E.METAL);
    // the diode lines: battery, 4 metal, junction, metal
    const D = L.diode;
    [[E.PSCN, E.NSCN, 0], [E.NSCN, E.PSCN, 4]].forEach(([j0, j1, dz]) => {
      const z = D.z + dz;
      set(D.x0, D.y, z, withBattery ? E.BATTERY : E.WALL);
      for (let k = 1; k <= 4; k++) set(D.x0 + k, D.y, z, E.METAL);
      set(D.x0 + 5, D.y, z, j0); set(D.x0 + 6, D.y, z, j1);
      for (let k = 7; k < D.len; k++) set(D.x0 + k, D.y, z, E.METAL);
    });
    // the sensor: at 20 °C, a wire on its +x face, stone at 120 °C on its top face
    const S = L.tsns;
    set(S.x0, S.y, S.z, E.TSNS);
    for (let k = 1; k <= 10; k++) set(S.x0 + k, S.y, S.z, E.METAL);
    set(S.x0, S.y + 1, S.z, E.WALL, { T: 120 });   // wall: it won't fall or move, and it holds its heat (cond 0.001)
    // the powered clone: P on its -x face, holding sand, air above
    const C = L.pcln;
    set(C.x - 1, C.y, C.z, E.PSCN);
    set(C.x, C.y, C.z, E.PCLN, { ctype: E.SAND });
    // the bar
    const Bb = L.bar;
    for (let x = Bb.x0; x < Bb.x1; x++) set(x, Bb.y, Bb.z, E.METAL);
    sim.load(A, B);
    sim.frame = 0;
  };
  // cells as they are now (read back: docs/webgpu.md W6); many at once share the wait
  const cell = async (x, y, z) => { const [ca] = await sim.readCell(x, y, z); return { id: Math.round(ca[0]), T: ca[1], life: ca[2], w: ca[3] }; };
  const cells = (list) => Promise.all(list.map((c) => cell(...c)));
  const liveAt = async (x, y, z) => { const c = await cell(x, y, z); return isLive(c.id, c.w); };
  const steps = (k) => { for (let i = 0; i < k; i++) sim.step(); };

  // ---- the activity map against its reference, at every build (tools/harness/sim-activity.js:
  // the reference kernel rebuilds the inert map from the state, the quiet map follows from it) ----
  const g = sim.g;
  await sim.prepare('inertRef');
  const act = { builds: 0, inertDiff: 0, quietDiff: 0, quietShare: 0 };
  const pending = [];
  const buildMap = sim.updateActivity.bind(sim);
  sim.updateActivity = () => {
    buildMap();
    const enabled = sim.quietOk;
    pending.push(Promise.all([sim.readMaps(), sim.inertRef()]).then(([m, ref]) => {
      let qn = 0;
      for (let i = 0; i < ref.length; i++) {
        const bx = i % g.bx, by = Math.floor(i / g.bx) % g.by, bz = Math.floor(i / (g.bx * g.by));
        let q = enabled;
        for (let z = -1; z <= 1 && q; z++) for (let y = -1; y <= 1 && q; y++) for (let x = -1; x <= 1 && q; x++) {
          const nx = bx + x, ny = by + y, nz = bz + z;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= g.bx || ny >= g.by || nz >= g.bz) continue;
          if (!ref[nx + g.bx * (ny + g.by * nz)]) q = false;
        }
        if (m.inert[i] !== ref[i]) act.inertDiff++;
        if (m.quiet[i] !== (q ? 1 : 0)) act.quietDiff++;
        qn += q;
      }
      act.builds++; act.quietShare += qn / ref.length;
    }));
  };

  const out = {};
  window.__reseed(); build(); sim.skipQuiet = true;
  // 1. the wire's front: the farthest live cell along it after k steps
  const W = L.wire;
  const front = async () => {
    const xs = []; for (let x = W.x0; x < W.x1; x++) xs.push([x, W.y, W.z]);
    let f = -1; (await cells(xs)).forEach((c, k) => { if (isLive(c.id, c.w)) f = xs[k][0]; });
    return f;
  };
  out.front = {};
  let done = 0;
  for (const k of [10, 40, 75]) { steps(k - done); done = k; out.front[k] = await front(); }
  out.frontWant = Object.fromEntries([10, 40, 75].map((k) => [k, W.x0 - 1 + k]));
  // 2. the water at the wire's tip: strongest spark seen per cell over 3 cycles
  const tip = W.x1 - 1;
  const probes = { 'x+1': [tip + 1, W.y, W.z], 'x+2': [tip + 2, W.y, W.z], 'x+3': [tip + 3, W.y, W.z], 'x+4': [tip + 4, W.y, W.z], 'x+5': [tip + 5, W.y, W.z],
    'y+1': [tip, W.y + 2, W.z], 'y+2': [tip, W.y + 3, W.z], 'y+3': [tip, W.y + 4, W.z], 'y+4': [tip - 0, W.y + 5, W.z] };
  steps(100 - done); done = 100;
  const maxS = Object.fromEntries(Object.keys(probes).map((k) => [k, 0]));
  for (let s = 0; s < 3 * SPARK_CYCLE; s++) {
    steps(1); done++;
    const cs = await cells(Object.values(probes));
    Object.keys(probes).forEach((k, n) => { maxS[k] = Math.max(maxS[k], sparkOf(cs[n].id, cs[n].w)); });
  }
  out.water = maxS;
  const ids = await cells(Object.values(probes));
  out.waterIds = Object.fromEntries(Object.keys(probes).map((k, n) => [k, ELEMENTS[ids[n].id].key]));
  // 3. the diode lines, the sensor, the powered clone
  const D = L.diode, S = L.tsns, C = L.pcln;
  const seen = { fwd: false, rev: false, revBeforeJunction: false, tsns: false };
  for (let s = 0; s < 2 * SPARK_CYCLE; s++) {
    steps(1); done++;
    const [f, r0, r1, rb, ts] = await Promise.all([liveAt(D.x0 + D.len - 1, D.y, D.z), liveAt(D.x0 + D.len - 1, D.y, D.z + 4),
      liveAt(D.x0 + 6, D.y, D.z + 4), liveAt(D.x0 + 5, D.y, D.z + 4), liveAt(S.x0 + 10, S.y, S.z)]);
    seen.fwd ||= f;
    seen.rev ||= r0 || r1;
    seen.revBeforeJunction ||= rb;
    seen.tsns ||= ts;
  }
  out.circuits = seen;
  const V3 = function (x, y, z) { return { x, y, z }; };
  const sparkId = TOOLS.find((t) => t.key === 'SPARK').id;
  const sand = async () => {
    const [SA] = await sim.readState();
    let n = 0;
    for (let y = 0; y <= C.y + 3; y++) for (let x = C.x - 3; x <= C.x + 3; x++) for (let z = C.z - 3; z <= C.z + 3; z++) n += Math.round(SA[sim.cellTexel(x, y, z) * 4]) === E.SAND;
    return n;
  };
  const sandOff = await sand();
  sim.paint({ center: new V3(C.x - 1 + 0.5, C.y + 0.5, C.z + 0.5), radius: 0.6, shape: 0, tool: sparkId, rate: 1, replace: false });
  steps(30); done += 30;
  out.pcln = { sandWhileOff: sandOff, sandAfterP: await sand(), life: (await cell(C.x, C.y, C.z)).life };
  // 4. the Spark tool on the bare bar
  const Bb = L.bar;
  sim.paint({ center: new V3(Bb.x0 + 0.5, Bb.y + 0.5, Bb.z + 0.5), radius: 1.5, shape: 0, tool: sparkId, rate: 1, replace: false });
  steps(12); done += 12;
  const bar = []; for (let x = Bb.x0; x < Bb.x1; x++) bar.push([x, Bb.y, Bb.z]);
  let bf = -1; (await cells(bar)).forEach((c, k) => { if (isLive(c.id, c.w)) bf = bar[k][0]; });
  out.sparkTool = { front: bf, want: Bb.x0 + 1 + 12, note: 'painted x0 and x0+1, then 12 steps' };
  // the awake share of sleeping units now, with the battery running
  const counts = await sim.readCounts();
  out.awakeShareRunning = +(counts.awake / counts.units).toFixed(4);
  await Promise.all(pending);
  out.activity = { ...act, quietShare: +(act.quietShare / act.builds).toFixed(3) };

  // 5. spark states with quiet bricks skipped against none skipped: the same box, the same steps
  const box = [L.bat[0], L.tank.x1, 0, 20, 36, L.tank.z1 + 30];   // x0 x1 y0 y1 z0 z1: the wire, tank, diodes, sensor, clone
  const snap = async () => {
    const [SA] = await sim.readState();
    const r = [];
    for (let x = box[0]; x < box[1]; x++) for (let y = box[2]; y < box[3]; y++) for (let z = box[4]; z < box[5]; z++) {
      if (z >= g.nz) continue;
      const i = sim.cellTexel(x, y, z) * 4, id = Math.round(SA[i]);
      r.push(id, ELEMENTS[id].elec > 0 ? Math.floor(SA[i + 3]) : 0, id === E.SWITCH || id === E.PCLN || id === E.TSNS ? SA[i + 2] : 0);
    }
    return r;
  };
  const runFor = (skip) => { window.__reseed(); build(); sim.skipQuiet = skip; steps(150); return snap(); };
  const s1 = await runFor(true), s0 = await runFor(false);
  let diff = 0; for (let i = 0; i < s1.length; i++) diff += s1[i] !== s0[i];
  out.skipVsNoSkip = { values: s1.length, differing: diff };
  sim.skipQuiet = true;
  await Promise.all(pending);
  sim.updateActivity = buildMap;

  // leave a running circuit for the stills
  window.__reseed(); build(); steps(110);
  return out;
}, L);

const look = async (pos, tgt, sun) => {
  await p.evaluate(([pc, tc, sun]) => {
    const a = window.__app;
    a.day.fixed = sun;
    a.camera.position.set(...window.__scene(...pc));
    a.controls.target.set(...window.__scene(...tc));
    a.controls.update();
    a.post.reset();
  }, [pos, tgt, sun]);
};
// a still at a moment the wire is live near the camera: step one at a time until the cell under the camera is
const shotLive = async (name, pos, tgt, sun, at) => {
  await look(pos, tgt, sun);
  await p.evaluate(async (at) => {
    const a = window.__app, { isLive } = await import('/src/electricity.js');
    for (let k = 0; k < 9; k++) { const [c] = await a.sim.readCell(...at); if (isLive(Math.round(c[0]), c[3])) break; a.sim.step(); }
  }, at);
  await render(p);   // the view converged (TAA, GI), no steps
  await p.screenshot({ path: `${out}/${name}.png` });
};
const W = L.wire;
await shotLive('wire-day', [W.x0 + 30, W.y + 14, W.z + 26], [W.x0 + 40, W.y, W.z], DAY, [W.x0 + 40, W.y, W.z]);
await shotLive('wire-night', [W.x0 + 30, W.y + 14, W.z + 26], [W.x0 + 40, W.y, W.z], NIGHT, [W.x0 + 40, W.y, W.z]);
await shotLive('tank-night', [W.x1 - 14, W.y + 22, W.z + 24], [W.x1 + 2, W.y, W.z], NIGHT, [W.x1 - 1, W.y, W.z]);
res.errors = errs;
console.log(JSON.stringify(res, null, 1));
} finally {
  await b.close();
}
