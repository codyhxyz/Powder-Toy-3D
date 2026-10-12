// The decoration layer's harness page (src/deco.js; docs/webgpu.md Sync log
// S3, U17): the layer on a Simulation of this page's device, no app.
// tools/deco-check.mjs drives it through window.__harness, one stage a
// browser:
//   rules       made on the first stroke (the wire's factory) and not before; the brush paints
//               matter, never air; the colour follows the move cell for cell; painted ice melts
//               into painted water; a brush that replaces or erases matter scrubs its paint, heat
//               doesn't, and undo brings it back; every deco mode against a JS model of TPT's
//               arithmetic; saves' read and upload round trip; a load clears it and the move stops
//               carrying it
//   store       the World's window: a slab's paint read back into the store as it leaves, the plane
//               shifted with the cells, the stored bricks written back as the slab returns
//   invariants  paint on, strokes between steps: sleeping = every brick dispatched, lists and blocks
//               permuted, in place = out of place, all with the plane identical; and paint on =
//               paint off for the state (the decoration never changes the simulation)
//   view        the plain and realistic views draw the tint; display off (Ctrl+B) draws exactly what
//               the scene drew before it was painted; the view follows the plane to a new buffer

import { boot, ready, test, log, measure } from './harness.js';
import { Simulation, cellTexel, slotCell, cellSlot } from '/src/sim.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS, DECO_ID0 } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { ensureDeco, prepareDeco, readDeco, uploadDeco, decoView, setDecoColor, decoShown, DECO_BYTES } from '/src/deco.js';
import { DECO_MODE, DECO_STRENGTH } from '/src/shaders/deco.js';

const h = await boot({ label: 'deco-check' });
const gpu = h.gpu;

const V = (x, y, z) => ({ x, y, z });
const check = (out, name, ok, detail = '') => { out.checks.push({ name, ok: Boolean(ok), detail }); return ok; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Math.random from a seed (mulberry32, as tools/regress.mjs), so scenes repeat
function seed(s) {
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A simulation as the app makes one, with the decoration's factory set as
// src/wire/deco.js sets it; `made` counts the layers the factory made.
async function make(n, opts = {}) {
  const [nx, ny, nz] = Array.isArray(n) ? n : [n, n, n];
  const sim = new Simulation(gpu, nx, ny, nz, { debug: true, ...opts });
  await sim.ready;
  sim.made = 0;
  sim.decoFactory = (s) => { s.made++; return ensureDeco(s); };
  return sim;
}
// Loads a scene built on the CPU: fill(set, g), set(x, y, z, id, { temp }).
function load(sim, fill, s = 12345) {
  seed(s);
  const g = sim.g, [A, B] = sim.blankState();
  const set = (x, y, z, id, { temp } = {}) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id; A[i + 1] = temp ?? e.temp; A[i + 2] = e.life; A[i + 3] = Math.random() * SEED_MAX;
  };
  fill(set, g);
  sim.load(A, B);
}
const boxFill = (set, lo, hi, id, extra) => {
  for (let x = lo[0]; x < hi[0]; x++) for (let y = lo[1]; y < hi[1]; y++) for (let z = lo[2]; z < hi[2]; z++) set(x, y, z, id, extra);
};
// Per slot: the element and state A's w bits.
async function cells(sim) {
  const [A] = await sim.readState(), g = sim.g, a32 = new Uint32Array(A.buffer, A.byteOffset, A.length);
  const ids = new Int32Array(g.slots), w = new Uint32Array(g.slots);
  for (let s = 0; s < g.slots; s++) {
    const t = cellTexel(g, ...slotCell(g, s)) * 4;
    ids[s] = Math.floor(A[t] + 0.5);
    w[s] = a32[t + 3];
  }
  return { ids, w };
}
// The decoration plane as the GPU holds it (slot order), after the queued work.
async function plane(sim) {
  await sim.deco?.ready;
  await tick();   // (strokes made while the kernels built record in a promise callback)
  const p = sim.decoPlane;
  if (!p) return new Uint32Array(sim.g.slots);
  return new Uint32Array(await gpu.readback.buffer(p.buffer, p.offset, p.size));
}
// Decorated cells per element key, and painted air.
function census(ids, words) {
  const out = { empty: 0 };
  for (let s = 0; s < ids.length; s++) {
    if (!words[s]) continue;
    if (ids[s] === E.EMPTY) out.empty++;
    else out[ELEMENTS[ids[s]].key] = (out[ELEMENTS[ids[s]].key] ?? 0) + 1;
  }
  return out;
}
const countOf = (ids, id) => ids.reduce((n, x) => n + (x === id), 0);
// A deco tool's stroke: the mode's tool, the picker's colour.
function stroke(sim, mode, center, radius, color, shape = 1) {
  setDecoColor(color);
  sim.paint({ center, radius, shape, tool: DECO_ID0 - mode, rate: 1, replace: false });
}
const steps = (sim, n) => { for (let i = 0; i < n; i++) sim.step(); };

// ---- a JS model of a stroke (shaders/deco.js decoPainted), in f32 ----
const f = Math.fround;
const BYTE = 255;
const bytesOf = (w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24];
const wordOf = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
const unpack = (w) => bytesOf(w).map((b) => f(b / BYTE));
const pack = (t) => wordOf(t.map((x) => Math.floor(f(f(Math.min(Math.max(x, 0), 1) * BYTE) + 0.5))));
const srgbToLin = (c) => (c >= f(0.04045) ? f(Math.pow(f(f(c + f(0.055)) / f(1.055)), f(2.4))) : f(c / f(12.92)));
const linToSrgb = (c) => (c >= f(0.0031308) ? f(f(f(1.055) * f(Math.pow(c, f(1 / 2.4)))) - f(0.055)) : f(c * f(12.92)));
const SMUDGE_REACH = 2, SMUDGE_NEAR = 2, SMUDGE_FADE = f(3 / 255);
function modelStroke(g, words, ids, { mode, center, radius, shape, color }) {
  const out = words.slice();
  const col = color.map((v) => f(v / BYTE));
  const c = [0, 1, 2].map((k) => f(f(col[k] * col[3]) * f(DECO_STRENGTH)));
  const inGrid = (p) => p.every((v, k) => v >= 0 && v < [g.nx, g.ny, g.nz][k]);
  for (let s = 0; s < words.length; s++) {
    const p = slotCell(g, s);
    const d = [f(f(p[0] + 0.5) - f(center.x)), f(f(p[1] + 0.5) - f(center.y)), f(f(p[2] + 0.5) - f(center.z))];
    const r = shape ? Math.max(...d.map(Math.abs)) : f(Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]));
    if (r > f(radius) || ids[s] === E.EMPTY) continue;
    let t = unpack(words[s]);
    if (mode === DECO_MODE.SET) t = col;
    else if (mode === DECO_MODE.CLEAR) t = [0, 0, 0, 0];
    else if (mode === DECO_MODE.ADD) t = [f(t[0] + c[0]), f(t[1] + c[1]), f(t[2] + c[2]), t[3]];
    else if (mode === DECO_MODE.SUBTRACT) t = [f(t[0] - c[0]), f(t[1] - c[1]), f(t[2] - c[2]), t[3]];
    else if (mode === DECO_MODE.MULTIPLY) t = [0, 1, 2].map((k) => f(t[k] * f(1 + c[k]))).concat(t[3]);
    else if (mode === DECO_MODE.DIVIDE) t = [0, 1, 2].map((k) => f(t[k] / f(1 + c[k]))).concat(t[3]);
    else if (mode === DECO_MODE.SMUDGE) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let z = -SMUDGE_REACH; z <= SMUDGE_REACH; z++)
        for (let y = -SMUDGE_REACH; y <= SMUDGE_REACH; y++)
          for (let x = -SMUDGE_REACH; x <= SMUDGE_REACH; x++) {
            const q = [p[0] + x, p[1] + y, p[2] + z];
            if (Math.abs(x) + Math.abs(y) + Math.abs(z) <= SMUDGE_NEAR || !inGrid(q)) continue;
            const sq = slotOf(g, q), wq = words[sq];
            if (!wq || ids[sq] === E.EMPTY) continue;
            unpack(wq).forEach((v, k) => { sum[k] = f(sum[k] + srgbToLin(v)); });
            n++;
          }
      if (!n) continue;
      const sm = sum.map((v) => linToSrgb(f(v / n)));
      if (!words[s]) sm[3] = f(sm[3] - SMUDGE_FADE);
      t = sm;
    }
    out[s] = pack(t);
  }
  return out;
}
const slotOf = (g, [x, y, z]) => cellSlot(g, x, y, z);
// byte differences between two planes: cells differing, the largest channel difference
function planeDiff(a, b) {
  let cells = 0, max = 0;
  for (let s = 0; s < a.length; s++) {
    if (a[s] === b[s]) continue;
    cells++;
    const x = bytesOf(a[s]), y = bytesOf(b[s]);
    for (let k = 0; k < 4; k++) max = Math.max(max, Math.abs(x[k] - y[k]));
  }
  return { cells, max };
}

// ---------------------------------------------------------------- stages
const STAGES = {
  async rules({ size = 32 } = {}) {
    const out = { checks: [] };
    const RED = [220, 40, 30, 255], BLUE = [40, 120, 230, 255];

    // -- lazy creation, the brush on matter only, the paint falling with its sand
    {
      const sim = await make(size);
      load(sim, (set, g) => boxFill(set, [12, 20, 12], [18, 26, 18], E.SAND));
      const before = { deco: sim.deco, side: sim.moveSrc.size };
      await prepareDeco(sim);   // (a deco tool picked: its kernels build, nothing is made yet)
      const prepared = { deco: sim.deco, side: sim.moveSrc.size };
      steps(sim, 2);
      const v0 = sim.version;
      stroke(sim, DECO_MODE.SET, V(15, 23, 15), 4, BLUE);
      let { ids } = await cells(sim);
      let words = await plane(sim);
      let n = census(ids, words);
      check(out, `made on the first stroke and not before (before: ${before.deco}, ${before.side} B; prepared: ${prepared.deco}, ${prepared.side} B; then ${sim.made} made, moveSrc ${sim.moveSrc.size} B)`,
        before.deco === null && prepared.deco === null && before.side === 16 && prepared.side === 16 && sim.made === 1 && sim.moveSrc.size === sim.g.slots * 4);
      const want = wordOf(BLUE), wrong = words.filter((w) => w && w !== want).length;
      check(out, `the brush paints the sand, never the air (${JSON.stringify(n)}; ${wrong} other colours; version ${v0} → ${sim.version})`,
        n.SAND === 216 && n.empty === 0 && Object.keys(n).length === 2 && wrong === 0 && sim.version > v0);
      check(out, 'decoShown while painted and display on', decoShown(sim) && sim.decoCarried);
      steps(sim, 40);
      ({ ids } = await cells(sim));
      words = await plane(sim);
      const after = census(ids, words), sandNow = countOf(ids, E.SAND);
      const fell = [...ids.keys()].filter((s) => ids[s] === E.SAND).reduce((y, s) => y + slotCell(sim.g, s)[1], 0) / sandNow;
      check(out, `the paint falls with its sand (decorated sand ${n.SAND} → ${after.SAND} of ${sandNow}, mean height 22.5 → ${fell.toFixed(1)}; painted air ${after.empty})`,
        after.SAND === 216 && sandNow === 216 && after.empty === 0 && fell < 18.5 && words.every((w) => !w || w === want));
      check(out, 'no out-of-grid access (I2.8)', (await sim.readDebug()) === 0);
      sim.dispose();
    }

    // -- the colour follows the move cell for cell: each cell tagged with its content's seed bits (A's w,
    //    which these elements keep) through a save's upload; read back, stepped, and compared
    {
      const sim = await make(size);
      load(sim, (set, g) => {
        const c = g.nx / 2;
        for (let x = 3; x < g.nx - 3; x += 9) for (let y = 0; y < g.ny / 2; y++) set(x, y, c, E.WALL);
        for (let y = 2; y < 8; y++) for (let z = 2; z < c - 2; z++) for (let x = 2; x < c - 2; x++) set(x, y + Math.floor(g.ny / 3), z, (x + z) % 3 ? E.SAND : E.STONE);
        for (let y = 0; y < 5; y++) for (let z = c + 2; z < g.nz - 2; z++) for (let x = c + 2; x < g.nx - 2; x++) set(x, y + Math.floor(g.ny / 4), z, y < 3 ? E.WATER : E.OIL);
      });
      const g = sim.g, tag = (w) => ((Math.imul(w, 2654435761) >>> 0) | 0x01000000) >>> 0;   // nonzero, alpha ≥ 1
      const want = async () => { const { ids, w } = await cells(sim); return Uint32Array.from(ids, (id, s) => (id === E.EMPTY ? 0 : tag(w[s]))); };
      const tags = await want();
      const bytes = new Uint8Array(g.width * g.height * DECO_BYTES), b32 = new Uint32Array(bytes.buffer);
      for (let s = 0; s < g.slots; s++) b32[cellTexel(g, ...slotCell(g, s))] = tags[s];
      const okUpload = uploadDeco(sim, bytes), refused = uploadDeco(sim, bytes.subarray(4));
      const back = await readDeco(sim);
      let diff = back.length === bytes.length ? 0 : -1;
      if (!diff) for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) diff++;
      check(out, `a save's upload makes the layer, and reads back as it was (${diff} bytes differ of ${bytes.length}; a wrong size refused: ${!refused})`, okUpload && !refused && diff === 0 && sim.deco !== null);
      steps(sim, 30);
      const now = await want(), got = await plane(sim);
      let wrong = 0, painted = 0;
      for (let s = 0; s < g.slots; s++) { if (got[s] !== now[s]) wrong++; if (now[s]) painted++; }
      check(out, `the colour follows the move cell for cell (${wrong} of ${g.slots} cells wrong, ${painted} painted)`, wrong === 0 && painted > 0);
      // negative control: the same with the move not carrying the plane (the layer said inactive) is caught
      gpu.write(sim.decoPlane.buffer, sim.decoPlane.offset, now);
      sim.deco.active = false;
      steps(sim, 10);
      sim.deco.active = true;
      const later = await want(), held = await plane(sim);
      let stale = 0;
      for (let s = 0; s < g.slots; s++) if (held[s] !== later[s]) stale++;
      check(out, `control: a plane the move doesn't carry is caught (${stale} cells wrong)`, stale > 0);
      sim.dispose();
    }

    // -- painted ice melts into painted water (react keeps the paint: TPT's part_change_type)
    {
      const sim = await make(size);
      // (hot enough to bank the latent heat and melt at once: physics.js L_FUSE)
      load(sim, (set) => boxFill(set, [12, 0, 12], [18, 3, 18], E.ICE, { temp: 250 }));
      stroke(sim, DECO_MODE.SET, V(15, 2, 15), 4, BLUE);
      let { ids } = await cells(sim);
      const n0 = census(ids, await plane(sim));
      steps(sim, 30);
      ({ ids } = await cells(sim));
      const words = await plane(sim), n1 = census(ids, words);
      check(out, `painted ice melts into painted water (${JSON.stringify(n0)} → ${JSON.stringify(n1)}; ice left ${countOf(ids, E.ICE)})`,
        n0.ICE === 108 && (n1.WATER ?? 0) + (n1.ICE ?? 0) === 108 && n1.WATER > 0 && n1.empty === 0 && words.every((w) => !w || w === wordOf(BLUE)));
      sim.dispose();
    }

    // -- the brush replacing or erasing matter scrubs its paint, heat keeps it, undo brings it back
    {
      const sim = await make(size);
      load(sim, (set) => boxFill(set, [6, 0, 6], [26, 4, 26], E.SAND));
      stroke(sim, DECO_MODE.SET, V(16, 2, 16), 12, RED);
      const c0 = await cells(sim), p0 = await plane(sim), n0 = census(c0.ids, p0);
      sim.snapshot('deco check');
      sim.paint({ center: V(10, 2, 10), radius: 3, shape: 1, tool: E.WATER, rate: 1, replace: true });
      sim.paint({ center: V(20, 2, 20), radius: 3, shape: 1, tool: -1, rate: 1, replace: false });   // ERASE
      sim.paint({ center: V(16, 2, 16), radius: 3, shape: 1, tool: -2, rate: 1, replace: false });   // HEAT: no new element
      const c1 = await cells(sim), p1 = await plane(sim), n1 = census(c1.ids, p1);
      let lost = 0;
      for (let s = 0; s < p0.length; s++) if (c1.ids[s] === E.SAND && p1[s] !== p0[s]) lost++;
      check(out, `replacing or erasing matter wipes its paint, heating it doesn't (${JSON.stringify(n0)} → ${JSON.stringify(n1)}; sand ${countOf(c0.ids, E.SAND)} → ${countOf(c1.ids, E.SAND)}, ${lost} sand cells lost paint)`,
        n0.SAND === countOf(c0.ids, E.SAND) && !n1.WATER && !n1.empty && n1.SAND === countOf(c1.ids, E.SAND) && n1.SAND < n0.SAND && lost === 0 && countOf(c1.ids, E.WATER) > 0);
      const undone = sim.undo();
      const c2 = await cells(sim), p2 = await plane(sim), d = planeDiff(p0, p2);
      check(out, `undo brings the paint back (${d.cells} cells differ; sand ${countOf(c2.ids, E.SAND)}; the snapshot's copy spent: ${sim.deco.snaps.size === 0})`,
        undone && d.cells === 0 && countOf(c2.ids, E.SAND) === countOf(c0.ids, E.SAND) && sim.deco.snaps.size === 0);
      // a snapshot with nothing painted brings no paint back (main's uBlank)
      sim.snapshot('blank');
      sim.history.at(-1).deco = null;   // (as if taken before the first stroke)
      sim.undo();
      const p3 = await plane(sim);
      check(out, `undoing to a snapshot from before any paint clears it (${p3.filter((w) => w).length} painted)`, p3.every((w) => !w));
      sim.dispose();
    }

    // -- every deco mode against the JS model (a wall block: nothing moves), and the brush's shapes
    {
      const sim = await make(size);
      load(sim, (set) => boxFill(set, [4, 0, 4], [28, 8, 28], E.WALL));
      const { ids } = await cells(sim);
      let words = await plane(sim);
      const go = async (name, mode, center, radius, shape, color, { exact = false } = {}) => {
        const want = modelStroke(sim.g, words, ids, { mode, center, radius, shape, color });
        stroke(sim, mode, center, radius, color, shape);
        const got = await plane(sim), d = planeDiff(got, want), moved = planeDiff(words, got).cells;
        check(out, `${name}: ${d.cells} of ${moved} changed cells differ from the model (largest ${d.max})`, exact ? d.cells === 0 && moved > 0 : d.max <= 1 && moved > 0);
        words = got;
      };
      await go('SET, cube', DECO_MODE.SET, V(16, 4, 16), 6, 1, [100, 150, 200, 255], { exact: true });
      await go('SET, sphere (another colour)', DECO_MODE.SET, V(13, 3, 13), 3.2, 0, [250, 20, 60, 200], { exact: true });
      await go('ADD ×1', DECO_MODE.ADD, V(16, 4, 16), 5, 1, [255, 128, 0, 255]);
      await go('ADD ×2', DECO_MODE.ADD, V(16, 4, 16), 5, 1, [255, 128, 0, 255]);
      await go('SUBTRACT', DECO_MODE.SUBTRACT, V(18, 4, 18), 4, 1, [0, 255, 128, 160]);
      await go('MULTIPLY', DECO_MODE.MULTIPLY, V(16, 4, 16), 3.2, 0, [128, 64, 255, 200]);
      await go('DIVIDE', DECO_MODE.DIVIDE, V(15, 4, 17), 3.2, 0, [255, 255, 40, 255]);
      await go('SMUDGE', DECO_MODE.SMUDGE, V(13, 3, 13), 3.2, 0, [0, 0, 0, 255]);
      await go('SMUDGE over unpainted cells', DECO_MODE.SMUDGE, V(22, 3, 22), 3.2, 0, [0, 0, 0, 255]);
      await go('CLEAR', DECO_MODE.CLEAR, V(16, 4, 16), 2, 1, [0, 0, 0, 0], { exact: true });
      // TPT's strength, spelled out: one ADD of opaque red moves red by 0.01 of the range (2.55 of 255)
      const s1 = h.cellSlot(sim.g, 27, 7, 27);
      stroke(sim, DECO_MODE.SET, V(27.5, 7.5, 27.5), 0.6, [100, 100, 100, 255], 0);
      stroke(sim, DECO_MODE.ADD, V(27.5, 7.5, 27.5), 0.6, [255, 0, 0, 255], 0);
      const one = bytesOf((await plane(sim))[s1]);
      check(out, `one ADD of opaque red: (100, 100, 100) → (${one.slice(0, 3).join(', ')}), alpha ${one[3]}`, one[0] === 103 && one[1] === 100 && one[2] === 100 && one[3] === 255);
      // air takes no paint
      stroke(sim, DECO_MODE.SET, V(16, 20, 16), 6, [255, 255, 255, 255], 1);
      const air = (await plane(sim)).filter((w, s) => w && ids[s] === E.EMPTY).length;
      check(out, `a stroke in the air paints nothing (${air} painted air cells)`, air === 0);
      sim.dispose();
    }

    // -- a load clears it; the move stops carrying it until the next stroke; dispose frees it
    {
      const sim = await make(size);
      load(sim, (set) => boxFill(set, [8, 0, 8], [24, 4, 24], E.SAND));
      stroke(sim, DECO_MODE.SET, V(16, 2, 16), 8, RED);
      await plane(sim);
      // (two steps: a step at parity 1 also runs the low margin's blocks)
      const step = async () => { const before = gpu.stats.dispatches; sim.step(); sim.step(); await tick(); return gpu.stats.dispatches - before; };
      const carried = { dispatches: await step(), carried: sim.decoCarried };
      load(sim, (set) => boxFill(set, [8, 0, 8], [24, 4, 24], E.SAND));
      const p = await plane(sim);
      check(out, `a load clears it (${p.filter((w) => w).length} painted, active ${sim.deco.active}, readDeco ${readDeco(sim)}, carried ${sim.decoCarried})`,
        p.every((w) => !w) && !sim.deco.active && readDeco(sim) === null && !sim.decoCarried && carried.carried && !decoShown(sim));
      const idle = await step();
      check(out, `the decoration adds no dispatch to a step (two steps after a load: ${carried.dispatches} carrying it, ${idle} not)`, carried.dispatches === idle);
      const label = `sim${sim.id}`;
      sim.dispose();
      const left = Object.entries(gpu.memory().byLabel).filter(([k]) => k.startsWith(`${label} `) && /deco/.test(k));
      check(out, `dispose frees its buffers (${left.map(([k]) => k).join(', ') || 'none left'})`, left.length === 0);
    }
    return out;
  },

  // The World's window: leave (stage + readback into the store), the shift, enter.
  async store({ size = 32 } = {}) {
    const out = { checks: [] };
    const sim = await make(size, { windowed: true });
    load(sim, (set, g) => boxFill(set, [0, 0, 0], [g.nx, 4, g.nz], E.WALL));
    stroke(sim, DECO_MODE.SET, V(6, 2, 6), 5, [200, 30, 30, 255]);
    stroke(sim, DECO_MODE.SET, V(10, 2, 24), 4, [30, 200, 30, 180], 0);
    stroke(sim, DECO_MODE.SET, V(24, 2, 16), 5, [30, 30, 200, 255]);
    const g = sim.g, p0 = await plane(sim), dx = 16;
    const bricks = [dx / 4, g.ny / 4, g.nz / 4], key = (x, y, z) => 1000 + x + bricks[0] * (y + bricks[1] * z);
    // the bricks of the slab with any paint, as the store should hold them (slab order: x fastest, then y, then z)
    const expect = new Map();
    for (let bz = 0; bz < bricks[2]; bz++) for (let by = 0; by < bricks[1]; by++) for (let bx = 0; bx < bricks[0]; bx++) {
      const w = new Uint32Array(64);
      for (let l = 0; l < 64; l++) w[l] = p0[h.cellSlot(g, bx * 4 + (l & 3), by * 4 + ((l >> 2) & 3), bz * 4 + (l >> 4))];
      if (w.some((v) => v)) expect.set(key(bx, by, bz), new Uint8Array(w.buffer));
    }
    sim.deco.leave([0, 0, 0], bricks, key);
    const waiting = sim.deco.pending;
    sim.shift(dx, 0);
    await waiting;
    let same = expect.size === sim.deco.store.size;
    for (const [k, b] of expect) same &&= sim.deco.store.get(k)?.every((v, i) => v === b[i]) ?? false;
    check(out, `a leaving slab's painted bricks go to the store (${sim.deco.store.size} stored, ${expect.size} painted; the window waited: ${waiting instanceof Promise}, then ${sim.deco.pending})`,
      same && expect.size > 0 && waiting instanceof Promise && sim.deco.pending === null);
    const p1 = await plane(sim);
    let wrong = 0;
    for (let s = 0; s < g.slots; s++) {
      const [x, y, z] = slotCell(g, s);
      if (p1[s] !== (x + dx < g.nx ? p0[h.cellSlot(g, x + dx, y, z)] : 0)) wrong++;
    }
    check(out, `the plane moves with the cells (${wrong} cells wrong)`, wrong === 0);
    sim.shift(-dx, 0);
    sim.deco.enter([0, 0, 0], bricks, key);
    const p2 = await plane(sim), d = planeDiff(p0, p2);
    check(out, `the slab comes back with its paint (${d.cells} cells differ; ${sim.deco.store.size} left in the store)`, d.cells === 0 && sim.deco.store.size === 0);
    // a stale readback (a reset in between) lands nowhere
    sim.deco.leave([0, 0, 0], bricks, key);
    const stale = sim.deco.pending;
    sim.deco.reset();
    await stale;
    check(out, `a readback from before a reset is dropped (${sim.deco.store.size} stored)`, sim.deco.store.size === 0);
    check(out, 'no out-of-grid access (I2.8)', (await sim.readDebug()) === 0);
    sim.dispose();
    return out;
  },

  // Sleeping, permuted lists and blocks, out of place, with paint on; and paint on = off for the state.
  async invariants({ size = 32, steps: n = 36, every = 12, scene = 'lab' } = {}) {
    const out = { checks: [], ms: {} };
    const run = async (name, { test = {}, deco = true, setup = null } = {}) => {
      const sim = await make(size);
      Object.assign(sim.test, test);
      if (test.listOrder) await sim.prepare('permute');
      if (setup) setup(sim);
      if (!deco) sim.decoFactory = null;
      seed(12345);
      buildPreset(scene, sim);
      await prepareDeco(sim);
      const g = sim.g, res = [], t0 = performance.now();
      for (let k = 0; k < n / every; k++) {
        // a deco stroke and an element stroke between stretches (the strokes' boxes cross sleeping bricks)
        stroke(sim, [DECO_MODE.SET, DECO_MODE.ADD, DECO_MODE.SMUDGE][k % 3], V(g.nx * (0.25 + 0.15 * k), g.ny * 0.3, g.nz * 0.5), 7, [60 + 50 * k, 200, 90, 255], k & 1);
        const tool = [E.SAND, E.WATER, -2][k % 3];
        sim.paint({ center: V(g.nx * (0.3 + 0.1 * k), g.ny * 0.7, g.nz * 0.4), radius: 3, shape: k & 1, tool, rate: 1, replace: false });
        await tick();
        steps(sim, every);
        res.push({ ...(await h.hashes(sim)), deco: h.fnv(await plane(sim)).toString(16), share: ((n) => n.drawn / n.units)(await sim.readCounts()) });
      }
      out.ms[name] = (performance.now() - t0) / n;
      const dbg = await sim.readDebug();
      sim.dispose();
      return { res, dbg };
    };
    const LINES = ['state', 'flow', 'copies', 'maps'];
    const cmp = (a, b, lines) => a.res.flatMap((x, i) => lines.filter((k) => x[k] !== b.res[i][k]).map((k) => `${k}@${(i + 1) * every}`));
    const base = await run('base');
    check(out, `base run: the sleeping rules skipped units (DRAWN ${base.res.map((x) => (100 * x.share).toFixed(0)).join(', ')}% of bricks) and the paint is there`, base.res.some((x) => x.share < 1) && base.res.every((x) => x.deco !== h.fnv(new Uint32Array(size ** 3)).toString(16)));
    for (const [name, opts, lines] of [
      ['every brick dispatched (skipSleeping = false)', { setup: (s) => { s.skipSleeping = false; } }, [...LINES, 'deco']],
      ['lists shuffled', { test: { listOrder: 'shuffle:7' } }, [...LINES, 'drawn', 'deco']],
      ['blocks reversed', { test: { blockOrder: 'reverse' } }, [...LINES, 'drawn', 'deco']],
      ['out of place (whitewater\'s move)', { setup: (s) => s.attachAeration({ active: true, step() {}, idle() {}, reset() {} }) }, ['state', 'flow', 'maps', 'drawn', 'deco']],
      ['no decoration at all', { deco: false }, [...LINES, 'drawn']],
    ]) {
      const r = await run(name, opts);
      const diffs = cmp(base, r, lines);
      check(out, `${name} = base (${lines.join(', ')} at ${r.res.length} checkpoints)`, !diffs.length, diffs.join(' '));
      check(out, `${name}: no out-of-grid access`, r.dbg === 0, `dbgOob ${r.dbg}`);
    }
    check(out, 'base: no out-of-grid access', base.dbg === 0, `dbgOob ${base.dbg}`);
    return out;
  },
};
for (const [name, fn] of Object.entries(STAGES)) test(`stage:${name}`, fn);

// ---- hashes, as tools/harness/sim-check.js has them (state, flow, copies, maps, drawn) ----
const fnv = (words, h0 = 0x811c9dc5) => {
  let x = h0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    x = Math.imul(x ^ (w & 0xff), 16777619); x = Math.imul(x ^ ((w >>> 8) & 0xff), 16777619);
    x = Math.imul(x ^ ((w >>> 16) & 0xff), 16777619); x = Math.imul(x ^ (w >>> 24), 16777619);
  }
  return x >>> 0;
};
h.fnv = fnv;
h.hashes = async (sim) => {
  const g = sim.g;
  const [[A, B], flow, copies, maps] = await Promise.all([sim.readState(), sim.readFlow(), sim.readCopies(), sim.readMaps()]);
  const a32 = new Uint32Array(A.buffer, A.byteOffset, A.length), b32 = new Uint32Array(B.buffer, B.byteOffset, B.length);
  const cellsW = new Uint32Array(g.slots * 8);
  let k = 0;
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    const t = cellTexel(g, x, y, z) * 4;
    for (let c = 0; c < 4; c++) cellsW[k++] = a32[t + c];
    for (let c = 0; c < 4; c++) cellsW[k++] = b32[t + c];
  }
  const w32 = (x) => new Uint32Array(x.buffer, x.byteOffset, x.byteLength / 4);
  let cp = 0x811c9dc5;
  for (const c of [sim.cur, 1 - sim.cur]) for (const arr of [copies.A[c], copies.B[c], copies.F[c]]) cp = fnv(w32(arr), cp);
  const mapWords = (m) => Uint32Array.from(m);
  return {
    state: fnv(cellsW).toString(16), flow: fnv(new Uint32Array(flow.buffer, flow.byteOffset, flow.byteLength / 4)).toString(16), copies: cp.toString(16),
    maps: fnv(mapWords(maps.awake), fnv(mapWords(maps.quiet), fnv(mapWords(maps.inert)))).toString(16), drawn: fnv(mapWords(maps.drawn)).toString(16),
  };
};
h.cellSlot = cellSlot;

// ---------------------------------------------------------------- budgets
// tools/budgets/deco.mjs: the lab's steps cost the same with paint carried as
// without; a deco stroke is its two dispatches; a brush stroke over paint is
// its edit and the scrub's two; none allocates once the layer is there.
test('budget:deco', async () => {
  const frame = async (deco) => {
    const sim = await make(32, { debug: false });
    try {
      seed(12345);
      buildPreset('lab', sim);
      if (deco) {
        stroke(sim, DECO_MODE.SET, V(16, 8, 16), 12, [90, 160, 220, 255]);
        await plane(sim);
      }
      steps(sim, 8);
      await sim.gpuSync();
      const run = await measure(gpu, async () => { steps(sim, 4); gpu.endFrame(); await sim.gpuSync(); });
      let paint = null, brush = null;
      if (deco) {
        paint = await measure(gpu, async () => { stroke(sim, DECO_MODE.ADD, V(16, 8, 16), 6, [255, 0, 0, 255]); await sim.gpuSync(); });
        brush = await measure(gpu, async () => { sim.paint({ center: V(16, 4, 16), radius: 3, shape: 1, tool: E.WATER, rate: 1, replace: true }); await sim.gpuSync(); });
      }
      return { run, paint, brush, carried: sim.decoCarried };
    } finally { sim.dispose(); }
  };
  const a = await frame(true), b = await frame(false);
  return {
    carriedDispatches: a.run.dispatches, plainDispatches: b.run.dispatches, carried: a.carried ? 1 : 0,
    carriedSubmits: a.run.submits, carriedAllocated: a.run.bytesAllocated,
    strokeDispatches: a.paint.dispatches, strokeAllocated: a.paint.bytesAllocated,
    brushDispatches: a.brush.dispatches, brushAllocated: a.brush.bytesAllocated,
  };
});

// ---------------------------------------------------------------- the view
// The volume on its own (as tools/harness/volume.js sets it up): a wall
// block and a pool in a glass tank, painted red and green; scene-target
// colours compared before the paint, with it, and with display off.
test('stage:view', async ({ size = 32, views = ['plain', 'realistic'] } = {}) => {
  const out = { checks: [], ms: {} };
  const { createPresenter } = await import('/src/gpu/index.js');
  const { halfsToFloats } = await import('/src/gpu/readback.js');
  const { useWebGPUCamera, createThreeRenderer } = await import('/src/gpu/three.js');
  const { PerspectiveCamera, Matrix4, Vector3 } = await import('three/webgpu');
  const { Derived } = await import('/src/derived.js');
  const { createPost, POST_DEFAULTS } = await import('/src/gfx/post.js');
  const { createVolume } = await import('/src/gfx/volume.js');
  const { writeFrameUniforms, updateGfxUniforms, gfxUniforms } = await import('/src/gfx/uniforms.js');
  const { VIEWS } = await import('/src/views.js');
  const canvas = document.getElementById('view');
  const presenter = createPresenter(gpu, canvas);
  const three = await createThreeRenderer(gpu, canvas);
  three.setPixelRatio(1);
  three.setSize(canvas.width, canvas.height, false);
  const post = createPost(gpu, { presenter, pixScale: gfxUniforms.uPixScale, readable: true });
  Object.assign(post.settings, POST_DEFAULTS, { taa: false, bloom: 0, adapt: false, meter: false });
  const sim = await make(size, { debug: false });
  const derived = new Derived(sim);
  const volume = createVolume(gpu, sim, { shadows: true });
  await Promise.all([post.ready, derived.ready, volume.ready, volume.noiseReady]);
  const g = sim.g;
  load(sim, (set) => {
    boxFill(set, [3, 0, 4], [13, 12, 26], E.WALL);
    for (let x = 17; x <= 29; x++) for (let z = 4; z <= 26; z++) for (let y = 0; y <= 9; y++) {
      const wall = x === 17 || x === 29 || z === 4 || z === 26 || y === 0;
      if (wall) set(x, y, z, E.GLASS); else if (y <= 8) set(x, y, z, E.WATER);
    }
  });
  const SUN = new Vector3(0.45, 0.8, 0.3).normalize();
  updateGfxUniforms(sim, SUN, [1, 1, 1]);
  for (let k = 0; k < 16; k++) sim.updateBricks();
  const SCALE = 10 / Math.max(g.nx, g.nz);
  const model = new Matrix4().makeScale(SCALE, SCALE, SCALE).setPosition(-g.nx / 2 * SCALE, 0, -g.nz / 2 * SCALE);
  const camera = useWebGPUCamera(new PerspectiveCamera(40, canvas.width / canvas.height, 0.05, 200));
  camera.position.set(2, g.ny * SCALE * 0.9 + 3, 13);
  camera.lookAt(new Vector3(0, g.ny * SCALE * 0.2, 0));
  camera.updateMatrixWorld();
  const SIZE = [160, 100];
  const target = gpu.createTexture({ label: 'deco view target', size: SIZE, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const frame = async (view) => {
    post.render({
      prepare(p) {
        writeFrameUniforms(gpu, { camera, model, sun: SUN, view: VIEWS.find((v) => v.key === view).id, shadowRes: volume.shadowRes, time: 0, lightGain: 1.6, shadows: true, far: false, jitter: p.jitter });
      },
      compute() { volume.recordShadow(); },
      draw(rp) { volume.draw(rp, { view }); },
    }, camera, target);
    gpu.endFrame();
    const scene = post.targets.scene, c = await gpu.readback.texture(scene);
    await gpu.fence();
    return { img: halfsToFloats(c), w: scene.width, h: scene.height };
  };
  // the mean colour of the pixels a box of cells covers (its centre's projection, ±3 px of the scene target)
  const meanAt = ({ img, w, h: hgt }, cell) => {
    const v = new Vector3(...cell).applyMatrix4(model).project(camera);
    const px = Math.floor((v.x * 0.5 + 0.5) * w), py = Math.floor((0.5 - v.y * 0.5) * hgt);
    const m = [0, 0, 0];
    let n = 0;
    for (let y = py - 3; y <= py + 3; y++) for (let x = px - 3; x <= px + 3; x++) {
      if (x < 0 || y < 0 || x >= w || y >= hgt) continue;
      for (let k = 0; k < 3; k++) m[k] += img[4 * (y * w + x) + k];
      n++;
    }
    return m.map((x) => x / Math.max(n, 1));
  };
  const differ = ({ img: a }, { img: b }) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++; return n; };
  const ratio = (m, k) => m[k] / Math.max(m[0] + m[1] + m[2], 1e-6);
  for (const view of views) {
    const t0 = performance.now();
    await volume.viewReady(view);
    out.ms[`${view} build`] = performance.now() - t0;
    sim.deco?.reset();   // (the view before: nothing painted)
    decoView.show = true;
    const t1 = performance.now();
    const before = await frame(view);
    out.ms[`${view} frame`] = performance.now() - t1;
    stroke(sim, DECO_MODE.SET, V(8, 6, 15), 5.5, [255, 20, 20, 255]);    // the wall, red
    stroke(sim, DECO_MODE.SET, V(23, 5, 15), 5.5, [20, 255, 20, 255]);   // the pool's water (and its glass), green
    await plane(sim);
    const shown = await frame(view);
    decoView.show = false;
    const hidden = await frame(view);
    decoView.show = true;
    // whitewater's plane comes along: moveSrc is remade and the plane moves to the new buffer
    const buffer0 = sim.decoPlane.buffer;
    sim.attachAeration({ active: false, step() {}, idle() {}, reset() {} });
    const moved = await frame(view);
    sim.attachAeration(null);
    const n = before.w * before.h;
    const wallC = [8, 11.9, 15], poolC = [23, 8.9, 15];   // on the wall's top and the water's surface (the camera looks down from +z)
    const wall0 = meanAt(before, wallC), wall1 = meanAt(shown, wallC);
    const pool0 = meanAt(before, poolC), pool1 = meanAt(shown, poolC);
    const f3 = (m) => m.map((x) => x.toFixed(3)).join(' ');
    check(out, `${view}: the paint shows (${differ(before, shown)} of ${n} pixels change; wall ${f3(wall0)} → ${f3(wall1)}; pool ${f3(pool0)} → ${f3(pool1)})`,
      differ(before, shown) > 0 && ratio(wall1, 0) > ratio(wall0, 0) + 0.1 && ratio(pool1, 1) > ratio(pool0, 1) + 0.05);
    check(out, `${view}: display off draws exactly the unpainted scene (${differ(before, hidden)} pixels differ)`, differ(before, hidden) === 0);
    check(out, `${view}: the view follows the plane to whitewater's buffer (${differ(shown, moved)} pixels differ; buffer remade: ${buffer0 !== sim.decoPlane.buffer || 'no'})`, differ(shown, moved) === 0);
  }
  check(out, 'no GPU failures', h.failures.length === 0, h.failures.join(' | '));
  return out;
});

ready();
log('deco-check ready');
