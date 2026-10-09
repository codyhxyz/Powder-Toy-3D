// Incremental derived passes (docs/scaling.md D9) against a full rebuild, bit
// for bit. Each case runs twice from the same seed with the same steps and
// writes, once with sim.incremental and once without, and compares every
// derived target after several frames' updateBricks: the field EMA, the final
// fields, the brick map, the empty-space distance and the glow volume. Any
// difference means a dirty set missed a change (or a pass read a texel its
// region didn't cover).
// usage: node tools/derived-check.mjs --port N [--size 128]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const size = opt('size', '128');
const SEED = 4242;           // Math.random seed (mulberry32) for each load
const COMPARE_EVERY = 6;     // frames between comparisons (and after the last frame)
const BOOT_MS = 3000;
const LOAD_TIMEOUT_MS = 120000;   // page load (shader compiles stall it when the GPU is busy)
const WATER = 7, HEAT = -2;  // brush tools (elements.js ids)
// [preset, steps before, frames, steps per frame, writes]. Writes: 'paint' (a moving
// water brush every frame), 'heat' (the heat tool every frame), 'undo' (a snapshot,
// then undo six frames later), 'pause' (no steps in the second half).
// 1 and 3 steps per frame: activity maps outlive a frame (shaders/activity.js).
const CASES = [
  ['lab', 200, 40, 4, null],
  ['lab', 200, 30, 4, 'paint'],
  ['volcano', 200, 30, 4, 'heat'],
  ['island', 100, 30, 4, null],
  ['lab', 100, 24, 1, 'undo'],
  ['lab', 100, 24, 3, 'pause'],
];
const UNDO_SNAPSHOT = 8, UNDO_AT = 14;   // frames
const PAINT_AT = [90, 30, 30], PAINT_DRIFT = 1, PAINT_RADIUS = 4;   // cells, cells per frame along x
const HEAT_AT = [64, 20, 64], HEAT_DRIFT = 1, HEAT_RADIUS = 6;      // cells, cells per frame along y

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
await p.addInitScript(() => localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ paused: true })));
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
await p.goto(`http://localhost:${port}/?preset=lab&size=${size}`, { timeout: LOAD_TIMEOUT_MS });
await p.waitForTimeout(BOOT_MS);
let failed = false;
for (const c of CASES) {
  const r = await p.evaluate(([[preset, warm, frames, spf, writes], k]) => {
    const a = window.__app, R = a.renderer;
    a.settings.paused = true;
    const seed = () => { let s = k.SEED; Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const read = (t, i) => {
      const tex = t.textures[i], n = t.width * t.height * 4;
      const T = a.THREE;
      const buf = tex.type === T.FloatType ? new Float32Array(n) : tex.type === T.HalfFloatType ? new Uint16Array(n) : new Uint8Array(n);
      R.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf, undefined, i);
      return buf;
    };
    const snap = (sim) => [
      ...[0, 1, 2].map((i) => [`fields${i}`, read(sim.fields, i)]),
      ...[0, 1, 2].map((i) => [`ema${i}`, read(sim.fieldEma, i)]),
      ['brick', read(sim.brick, 0)], ['brickDist', read(sim.brickDist[0], 0)], ['light', read(sim.light[1], 0)],
    ];
    // One run, synchronous throughout, so the app's own frames can't interleave.
    const run = (incremental) => {
      seed();
      a.day.clock = 0;
      a.loadPreset(preset, false);
      const sim = a.sim;
      sim.frame = 0;
      sim.paints = 0;
      sim.incremental = incremental;
      for (let i = 0; i < warm; i++) sim.step();
      const V = a.camera.position.constructor;
      const snaps = [];
      for (let f = 0; f < frames; f++) {
        if (!(writes === 'pause' && f >= frames / 2)) for (let s = 0; s < spf; s++) sim.step();
        if (writes === 'paint') {
          const [x, y, z] = k.PAINT_AT;
          sim.paint({ center: new V(x + f * k.PAINT_DRIFT, y, z), radius: k.PAINT_RADIUS, shape: f & 1, tool: k.WATER, rate: 1, replace: false });
        }
        if (writes === 'heat') {
          const [x, y, z] = k.HEAT_AT;
          sim.paint({ center: new V(x, y + f * k.HEAT_DRIFT, z), radius: k.HEAT_RADIUS, shape: 0, tool: k.HEAT, rate: 1, replace: false });
        }
        if (writes === 'undo' && f === k.UNDO_SNAPSHOT) sim.snapshot();
        if (writes === 'undo' && f === k.UNDO_AT) sim.undo();
        sim.updateBricks();
        if (f % k.COMPARE_EVERY === k.COMPARE_EVERY - 1 || f === frames - 1) snaps.push(snap(sim));
      }
      return snaps;
    };
    const A = run(true), B = run(false);
    a.sim.incremental = true;
    const diffs = [];
    A.forEach((s, n) => s.forEach(([name, buf], j) => {
      const other = B[n][j][1];
      let d = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] !== other[i]) d++;
      if (d) diffs.push(`${name}@${n}: ${d}`);
    }));
    return { checks: A.length * A[0].length, diffs };
  }, [c, { SEED, COMPARE_EVERY, WATER, HEAT, UNDO_SNAPSHOT, UNDO_AT, PAINT_AT, PAINT_DRIFT, PAINT_RADIUS, HEAT_AT, HEAT_DRIFT, HEAT_RADIUS }]);
  if (r.diffs.length) failed = true;
  console.log(`${c.map((x) => x ?? '-').join(' ')}: ${r.checks} target comparisons, ${r.diffs.length ? 'DIFFERENT ' + r.diffs.join(', ') : 'all identical'}`);
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
process.exit(failed || errs.length ? 1 : 0);
