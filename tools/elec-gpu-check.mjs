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
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5416');
mkdirSync(out, { recursive: true });

const VIEW = { width: 960, height: 600 };   // small stills
const SEED = 12345;                         // Math.random seed (mulberry32, as tools/activity-check.mjs)
const CONVERGE_FRAMES = 30;                 // frames per still (TAA, GI)
const DAY = { az: 60, el: 35 };
const NIGHT = { az: 60, el: -20 };

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: VIEW });
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
  if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:|Shader Error/.test(t)) errs.push(t.slice(0, 600));
});
await p.goto(`http://localhost:${port}/?preset=empty&size=128`, { timeout: 180000, waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 120000 });
await p.waitForTimeout(1500);

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
  const a = window.__app, sim = a.sim, R = a.renderer;
  const { E, ELEMENTS, TOOLS } = await import('/src/elements.js');
  const { isLive, sparkOf, SPARK_CYCLE, ELEC } = await import('/src/electricity.js');
  const { inertRefFrag } = await import('/src/shaders/activity.js');
  const { rawMat, makeFieldTarget } = await import('/src/sim.js');
  a.settings.paused = true;
  if (a.autoRes) a.autoRes.enabled = false;
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__frames = frames;
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
  const cell = (x, y, z) => { const [ca] = sim.readCell(x, y, z); return { id: Math.round(ca[0]), T: ca[1], life: ca[2], w: ca[3] }; };
  const liveAt = (x, y, z) => { const c = cell(x, y, z); return isLive(c.id, c.w); };
  const steps = (k) => { for (let i = 0; i < k; i++) sim.step(); };

  // ---- the activity map against its reference, at every build (tools/activity-check.mjs) ----
  const g = sim.g, bw = g.bwidth, bh = g.bheight;
  const tex = sim.actInert.texture;
  const refInert = makeFieldTarget(bw, bh, 1, tex.type, tex.minFilter), refQuiet = makeFieldTarget(bw, bh, 1, tex.type, tex.minFilter);
  const ref = rawMat(inertRefFrag(g), { tA: { value: null }, tB: { value: null } });
  const px = () => new Uint8Array(bw * bh * 4);
  const bufs = { inert: px(), quiet: px(), refInert: px(), refQuiet: px() };
  const readT = (t, buf) => R.readRenderTargetPixels(t, 0, 0, bw, bh, buf);
  const act = { builds: 0, inertDiff: 0, quietDiff: 0, quietShare: 0 };
  const buildMap = sim.updateActivity.bind(sim);
  sim.updateActivity = () => {
    buildMap();
    ref.uniforms.tA.value = sim.stateA; ref.uniforms.tB.value = sim.stateB;
    sim.run(ref, refInert);
    const q = sim.mats.quiet, keep = q.uniforms.tInert.value;
    q.uniforms.tInert.value = refInert.texture; sim.run(q, refQuiet); q.uniforms.tInert.value = keep;
    readT(sim.actInert, bufs.inert); readT(sim.actQuiet, bufs.quiet); readT(refInert, bufs.refInert); readT(refQuiet, bufs.refQuiet);
    let n = 0, qn = 0;
    for (let i = 0; i < bufs.inert.length; i += 4) {
      if ((bufs.inert[i] > 127) !== (bufs.refInert[i] > 127)) act.inertDiff++;
      if ((bufs.quiet[i] > 127) !== (bufs.refQuiet[i] > 127)) act.quietDiff++;
      n++; qn += bufs.refQuiet[i] > 127;
    }
    act.builds++; act.quietShare += qn / n;
  };

  const out = {};
  window.__reseed(); build(); sim.skipQuiet = true;
  // 1. the wire's front: the farthest live cell along it after k steps
  const W = L.wire;
  const front = () => { let f = -1; for (let x = W.x0; x < W.x1; x++) if (liveAt(x, W.y, W.z)) f = x; return f; };
  out.front = {};
  let done = 0;
  for (const k of [10, 40, 75]) { steps(k - done); done = k; out.front[k] = front(); }
  out.frontWant = Object.fromEntries([10, 40, 75].map((k) => [k, W.x0 - 1 + k]));
  // 2. the water at the wire's tip: strongest spark seen per cell over 3 cycles
  const tip = W.x1 - 1;
  const probes = { 'x+1': [tip + 1, W.y, W.z], 'x+2': [tip + 2, W.y, W.z], 'x+3': [tip + 3, W.y, W.z], 'x+4': [tip + 4, W.y, W.z], 'x+5': [tip + 5, W.y, W.z],
    'y+1': [tip, W.y + 2, W.z], 'y+2': [tip, W.y + 3, W.z], 'y+3': [tip, W.y + 4, W.z], 'y+4': [tip - 0, W.y + 5, W.z] };
  steps(100 - done); done = 100;
  const maxS = Object.fromEntries(Object.keys(probes).map((k) => [k, 0]));
  for (let s = 0; s < 3 * SPARK_CYCLE; s++) {
    steps(1); done++;
    for (const [k, c] of Object.entries(probes)) { const cc = cell(...c); maxS[k] = Math.max(maxS[k], sparkOf(cc.id, cc.w)); }
  }
  out.water = maxS;
  out.waterIds = Object.fromEntries(Object.entries(probes).map(([k, c]) => [k, ELEMENTS[cell(...c).id].key]));
  // 3. the diode lines, the sensor, the powered clone
  const D = L.diode, S = L.tsns, C = L.pcln;
  const seen = { fwd: false, rev: false, revBeforeJunction: false, tsns: false };
  for (let s = 0; s < 2 * SPARK_CYCLE; s++) {
    steps(1); done++;
    seen.fwd ||= liveAt(D.x0 + D.len - 1, D.y, D.z);
    seen.rev ||= liveAt(D.x0 + D.len - 1, D.y, D.z + 4) || liveAt(D.x0 + 6, D.y, D.z + 4);
    seen.revBeforeJunction ||= liveAt(D.x0 + 5, D.y, D.z + 4);
    seen.tsns ||= liveAt(S.x0 + 10, S.y, S.z);
  }
  out.circuits = seen;
  const V3 = sim.mats.paint.uniforms.uCenter.value.constructor;
  const sparkId = TOOLS.find((t) => t.key === 'SPARK').id;
  const sand = () => { let n = 0; for (let y = 0; y <= C.y + 3; y++) for (let x = C.x - 3; x <= C.x + 3; x++) for (let z = C.z - 3; z <= C.z + 3; z++) n += cell(x, y, z).id === E.SAND; return n; };
  const sandOff = sand();
  sim.paint({ center: new V3(C.x - 1 + 0.5, C.y + 0.5, C.z + 0.5), radius: 0.6, shape: 0, tool: sparkId, rate: 1, replace: false });
  steps(30); done += 30;
  out.pcln = { sandWhileOff: sandOff, sandAfterP: sand(), life: cell(C.x, C.y, C.z).life };
  // 4. the Spark tool on the bare bar
  const Bb = L.bar;
  sim.paint({ center: new V3(Bb.x0 + 0.5, Bb.y + 0.5, Bb.z + 0.5), radius: 1.5, shape: 0, tool: sparkId, rate: 1, replace: false });
  steps(12); done += 12;
  let bf = -1; for (let x = Bb.x0; x < Bb.x1; x++) if (liveAt(x, Bb.y, Bb.z)) bf = x;
  out.sparkTool = { front: bf, want: Bb.x0 + 1 + 12, note: 'painted x0 and x0+1, then 12 steps' };
  // awake share of supertiles now, with the battery running
  const sh = new Float32Array(4);
  R.readRenderTargetPixels(sim.superShare, 0, 0, 1, 1, sh);
  out.awakeShareRunning = +sh[0].toFixed(4);
  out.activity = { ...act, quietShare: +(act.quietShare / act.builds).toFixed(3) };

  // 5. spark states with quiet bricks skipped against none skipped: the same box, the same steps
  const box = [L.bat[0], L.tank.x1, 0, 20, 36, L.tank.z1 + 30];   // x0 x1 y0 y1 z0 z1: the wire, tank, diodes, sensor, clone
  const snap = () => {
    const [SA] = sim.readState();
    const r = [];
    for (let x = box[0]; x < box[1]; x++) for (let y = box[2]; y < box[3]; y++) for (let z = box[4]; z < box[5]; z++) {
      if (z >= g.nz) continue;
      const i = sim.cellTexel(x, y, z) * 4, id = Math.round(SA[i]);
      r.push(id, ELEMENTS[id].elec > 0 ? Math.floor(SA[i + 3]) : 0, id === E.SWITCH || id === E.PCLN || id === E.TSNS ? SA[i + 2] : 0);
    }
    return r;
  };
  const runFor = (skip) => { window.__reseed(); build(); sim.skipQuiet = skip; steps(150); return snap(); };
  const s1 = runFor(true), s0 = runFor(false);
  let diff = 0; for (let i = 0; i < s1.length; i++) diff += s1[i] !== s0[i];
  out.skipVsNoSkip = { values: s1.length, differing: diff };
  sim.skipQuiet = true;
  sim.updateActivity = buildMap;
  refInert.dispose(); refQuiet.dispose(); ref.dispose();

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
  await p.evaluate((n) => window.__frames(n), CONVERGE_FRAMES);
};
// a still at a moment the wire is live near the camera: step one at a time until the cell under the camera is
const shotLive = async (name, pos, tgt, sun, at) => {
  await look(pos, tgt, sun);
  await p.evaluate(async (at) => {
    const a = window.__app, { isLive } = await import('/src/electricity.js');
    for (let k = 0; k < 9; k++) { const [c] = a.sim.readCell(...at); if (isLive(Math.round(c[0]), c[3])) break; a.sim.step(); }
    await window.__frames(2);
  }, at);
  await p.screenshot({ path: `${out}/${name}.png` });
};
const W = L.wire;
await shotLive('wire-day', [W.x0 + 30, W.y + 14, W.z + 26], [W.x0 + 40, W.y, W.z], DAY, [W.x0 + 40, W.y, W.z]);
await shotLive('wire-night', [W.x0 + 30, W.y + 14, W.z + 26], [W.x0 + 40, W.y, W.z], NIGHT, [W.x0 + 40, W.y, W.z]);
await shotLive('tank-night', [W.x1 - 14, W.y + 22, W.z + 24], [W.x1 + 2, W.y, W.z], NIGHT, [W.x1 - 1, W.y, W.z]);
res.errors = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
