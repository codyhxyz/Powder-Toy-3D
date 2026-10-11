// The derived passes' harness page (docs/webgpu.md E, I1): a Simulation and
// its derived passes (src/derived.js) on this page's WebGPU device, no app.
// tools/derived-check.mjs, derived-bench.mjs and budget-check's derived
// scenarios drive it through window.__harness:
//   case:<name>    incremental against sim.incremental = false, bit for bit,
//                  every derived resource, at checkpoints of a scripted run
//   shiftModel     the window shift's kernels and copies against a CPU model
//   fused          the fused peak (boost stages 3-5) against the separable stages
//   bits           the brick map's info words: the WGSL decoders against the
//                  JS twins, and a scene's bricks against what they hold
//   budget:*       tools/budgets/derived.mjs
//   bench          GPU ms per derived kernel, incremental and full

import { boot, ready, log, test } from './harness.js';
import { Simulation, cellTexel, cellSlot, slotCell } from '/src/sim.js';
import { Derived, fieldWeights } from '/src/derived.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS } from '/src/elements.js';
import { SEED_MAX, brickIdOf, brickCoordOf } from '/src/shaders/common.js';
import { AGE, DIRTY } from '/src/shaders/fields.js';
import { unpackBrickInfo, BRICK_INFO, AIR } from '/src/shaders/bindings.js';
import { LOOK } from '/src/gfx/materials.js';

const h = await boot({ label: 'derived-check' });
const gpu = h.gpu;
Object.assign(h, { Simulation, Derived, E });

// Math.random from a seed (mulberry32, as tools/regress.mjs), so scenes and
// blankState's seeds repeat.
h.seed = (seed) => {
  let s = seed >>> 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// A simulation and its derived passes, every pipeline ready.
h.make = async (dims, opts = {}) => {
  const [nx, ny, nz] = Array.isArray(dims) ? dims : [dims, dims, dims];
  const sim = new Simulation(gpu, nx, ny, nz, { debug: false, ...opts });
  const derived = new Derived(sim);
  await Promise.all([sim.ready, derived.ready]);
  return { sim, derived, dispose: () => { derived.dispose(); sim.dispose(); } };
};

// Scenes built on the CPU (seeded): the app's presets (presets.js
// buildPreset: lab, volcano) and small ones of our own.
const SCENES = {
  // a pool in a glass tank, a block of water dropped beside it
  pool(set, g) {
    const lo = 2, hi = g.nx - 3, top = Math.floor(g.ny / 3);
    for (let y = 0; y <= top; y++)
      for (let z = lo; z <= hi; z++)
        for (let x = lo; x <= hi; x++) {
          const wall = x === lo || x === hi || z === lo || z === hi || y === 0;
          if (wall) set(x, y, z, E.GLASS);
          else if (y < top - 2) set(x, y, z, E.WATER);
        }
    for (let y = top + 4; y < top + 8; y++)
      for (let z = lo + 3; z < lo + 7; z++)
        for (let x = lo + 3; x < lo + 7; x++) set(x, y, z, E.WATER);
  },
  // a block of sand in the air over a few stones: it falls, piles and settles
  pile(set, g) {
    const c = g.nx / 2, w = Math.max(4, g.nx / 4);
    for (let y = Math.floor(g.ny * 0.5); y < Math.floor(g.ny * 0.5) + w; y++)
      for (let z = c - w / 2; z < c + w / 2; z++)
        for (let x = c - w / 2; x < c + w / 2; x++) set(x, y, z, E.SAND);
    for (let x = 2; x < g.nx - 2; x += 7) set(x, 0, g.nz / 2, E.STONE);
  },
  // wall pillars, sand and rubble falling, water and oil, a lava pocket and a puff of steam
  mix(set, g) {
    const c = g.nz / 2;
    for (let x = 3; x < g.nx - 3; x += 9) for (let y = 0; y < g.ny / 2; y++) set(x, y, c, E.WALL);
    for (let y = 2; y < 6; y++)
      for (let z = 2; z < c - 2; z++)
        for (let x = 2; x < g.nx / 2 - 2; x++) set(x, y + Math.floor(g.ny / 3), z, (x + z) % 3 ? E.SAND : E.STONE);
    for (let y = 0; y < 4; y++)
      for (let z = c + 2; z < g.nz - 2; z++)
        for (let x = g.nx / 2 + 2; x < g.nx - 2; x++) set(x, y, z, y < 2 ? E.WATER : E.OIL);
    for (let y = 0; y < 3; y++) for (let z = 3; z < 7; z++) for (let x = g.nx - 7; x < g.nx - 3; x++) set(x, y, z, E.LAVA);
    for (let y = g.ny - 8; y < g.ny - 5; y++) for (let z = c - 2; z < c + 2; z++) for (let x = 4; x < 8; x++) set(x, y, z, E.STEAM);
  },
  // bricks that each hold one thing (the brick bits test, 32³; BITS below)
  bits(set) {
    for (const [, id, lo, temp] of BITS) {
      if (id === null) continue;
      for (let y = lo[1] * 4; y < (lo[1] + 1) * 4; y++)
        for (let z = lo[2] * 4; z < (lo[2] + 1) * 4; z++)
          for (let x = lo[0] * 4; x < (lo[0] + 1) * 4; x++) {
            set(x, y, z, Array.isArray(id) ? id[x & 1] : id, temp ? { temp } : {});
          }
    }
  },
};
// The bits scene's bricks: [what, element (or two, alternating by x), brick, temperature]
const BITS = [
  ['water', E.WATER, [1, 0, 1]],
  ['rubble', E.STONE, [5, 0, 1]],
  ['steam', E.STEAM, [1, 5, 5]],
  ['hot air', E.EMPTY, [6, 5, 6], 200],
  ['water and oil', [E.WATER, E.OIL], [5, 5, 1]],
  ['lava', E.LAVA, [1, 5, 1]],
  ['empty', null, [3, 7, 3]],
];

// Loads scene `name` into sim from Math.random seeded with `seed`.
h.scene = (sim, name, seed = 12345) => {
  h.seed(seed);
  if (!SCENES[name]) return buildPreset(name, sim);
  const g = sim.g;
  const [A, B] = sim.blankState();
  const set = (x, y, z, id, extra = {}) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id;
    A[i + 1] = extra.temp ?? e.temp;
    A[i + 2] = e.life;
    A[i + 3] = (extra.ctype ?? 0) + Math.random() * SEED_MAX;
  };
  SCENES[name](set, g);
  sim.load(A, B);
  return null;
};

const check = (out, name, ok, detail = '') => { out.checks.push({ name, ok: Boolean(ok), detail }); return ok; };
const V = (x, y, z) => ({ x, y, z });
const words = (x) => new Uint32Array(x.buffer, x.byteOffset, x.byteLength >>> 2);
const fnv = (w) => {
  let x = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) x = Math.imul(x ^ w[i], 16777619);
  return x >>> 0;
};
// How many elements of two equal-length arrays differ.
const differ = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

// ---------------------------------------------------------------- incremental == full
// A scripted run: load, warm up (steps), settle (derived frames with no steps,
// so the load's rebuild ages out and the lists can shrink), then per frame the
// steps (none in the second half with pause), the writes, the window's
// shifts, a derived frame; every derived resource read at checkpoints (each
// COMPARE_EVERY frames and the last).
const COMPARE_EVERY = 6;
const PAINT_DRIFT = 1;   // cells per frame the brush moves along x
const SETTLE = 14;       // derived frames: past FIELD_EMA_SETTLE (13)
const CASES = {
  // the lab, running
  lab: { scene: 'lab', size: 32, warm: 8, settle: SETTLE, frames: 18, spf: 2 },
  // a water brush moving every frame (an edit's marks, no box)
  paint: { scene: 'pile', size: 32, warm: 8, settle: SETTLE, frames: 18, spf: 2, writes: 'paint' },
  // the heat tool, a brush that writes only temperatures (marks without a new element)
  heat: { scene: 'mix', size: 32, warm: 4, settle: SETTLE, frames: 18, spf: 1, writes: 'heat' },
  // a snapshot, then undo (a whole-grid write), and the frames it takes to settle again
  undo: { scene: 'pool', size: 32, warm: 4, settle: SETTLE, frames: 24, spf: 1, writes: 'undo' },
  // three steps a frame (maps outlive a frame), then derived frames with no steps (the age pass's steps gate)
  pause: { scene: 'pile', size: 32, warm: 8, settle: 0, frames: 24, spf: 3, writes: 'pause' },
  // a smoothing change (every brick changes), the brush too
  smoothing: { scene: 'mix', size: 32, warm: 4, settle: SETTLE, frames: 24, spf: 1, writes: 'smoothing' },
  // window moves along x and z, two in one derived frame among them, each
  // with an edit over the slab it brought in (world/window.js fills it)
  shift: {
    scene: 'mix', size: [64, 32, 32], warm: 8, settle: 0, frames: 24, spf: 1, windowed: true,
    shifts: { 4: [[16, 0]], 9: [[0, -8]], 14: [[-16, 8], [16, 0]], 19: [[-16, 0]] },
  },
  // the same moves over a still world (no steps after the warm-up), once its
  // derived passes have settled: what's rebuilt is only what the moves and
  // their slab edits changed
  shiftStill: {
    scene: 'mix', size: [64, 32, 32], warm: 8, settle: SETTLE, frames: 26, spf: 0, windowed: true,
    shifts: { 2: [[16, 0]], 8: [[0, -8]], 14: [[-16, 8], [16, 0]], 20: [[-16, 0]] },
  },
};

// The slab a shift by (dx, dz) brought in, filled the way a world fills it:
// an edit over it (a cube of sand, part of the slab).
function fillSlab(sim, dx, dz) {
  const g = sim.g;
  const x0 = dx > 0 ? g.nx - dx : 0, x1 = dx > 0 ? g.nx : dx < 0 ? -dx : g.nx;
  const z0 = dz > 0 ? g.nz - dz : 0, z1 = dz > 0 ? g.nz : dz < 0 ? -dz : g.nz;
  const c = V((x0 + x1) / 2, 3, (z0 + z1) / 2);
  sim.paint({ center: c, radius: Math.min(x1 - x0, z1 - z0) / 2, shape: 1, tool: E.SAND, rate: 0.6, replace: false });
}

async function scripted(sim, derived, spec, incremental) {
  const g = sim.g;
  sim.origin.set(0, 0, 0);   // (seeds hash world cells: a run starts where the last began)
  h.scene(sim, spec.scene);
  sim.frame = 0;
  sim.paints = 0;
  sim.smoothing = 1;
  sim.incremental = incremental;
  for (let i = 0; i < spec.warm; i++) sim.step();
  for (let i = 0; i < spec.settle; i++) derived.updateBricks();
  const snaps = [], lists = [];
  for (let f = 0; f < spec.frames; f++) {
    if (!(spec.writes === 'pause' && f >= spec.frames / 2)) for (let s = 0; s < spec.spf; s++) sim.step();
    if (spec.writes === 'paint' || (spec.writes === 'smoothing' && f % 3 === 0)) {
      sim.paint({ center: V(g.nx * 0.3 + f * PAINT_DRIFT, g.ny * 0.6, g.nz * 0.4), radius: 3, shape: f & 1, tool: E.WATER, rate: 1, replace: false });
    }
    if (spec.writes === 'heat') sim.paint({ center: V(g.nx / 2, g.ny * 0.2 + f * PAINT_DRIFT, g.nz / 2), radius: 4, shape: 0, tool: -2, rate: 1, replace: false });
    if (spec.writes === 'undo' && f === 2) sim.snapshot();
    if (spec.writes === 'undo' && f === 6) sim.undo();
    if (spec.writes === 'smoothing' && f === 6) sim.smoothing = 1.5;
    for (const [dx, dz] of spec.shifts?.[f] ?? []) {
      sim.shift(dx, dz);
      fillSlab(sim, dx, dz);
    }
    derived.updateBricks();
    if (f % COMPARE_EVERY === COMPARE_EVERY - 1 || f === spec.frames - 1) {
      snaps.push(await derived.read());
      lists.push(await derived.readLists());
    }
  }
  return { snaps, lists };
}

test('case', async (name) => {
  const spec = CASES[name];
  if (!spec) throw new Error(`derived-check: no case ${name} (have: ${Object.keys(CASES).join(', ')})`);
  const out = { checks: [], lists: [] };
  const t0 = performance.now();
  const { sim, derived, dispose } = await h.make(spec.size, { windowed: Boolean(spec.windowed) });
  try {
    const A = await scripted(sim, derived, spec, true);
    const B = await scripted(sim, derived, spec, false);
    const n = sim.g.nbricks, diffs = [];
    let compared = 0;
    A.snaps.forEach((snap, c) => {
      for (const [key, a] of Object.entries(snap)) {
        const b = B.snaps[c][key];
        compared++;
        const d = differ(words(a), words(b));
        if (d) diffs.push(`${key}@${c}: ${d} words`);
      }
      out.lists.push({ ema: A.lists[c].ema, fields: A.lists[c].fields, work: A.lists[c].work, full: B.lists[c].work, bricks: n });
    });
    check(out, `${name}: incremental == full, ${compared} resource comparisons (${A.snaps.length} checkpoints)`, !diffs.length, diffs.join(', '));
    // (the full run's lists hold every brick; a run whose incremental lists did too compared nothing)
    check(out, `${name}: the full run's lists hold every brick`, B.lists.every((l) => l.ema === n && l.fields === n && l.work === n));
    out.skipped = A.lists.some((l) => l.work < n);
    out.minWork = Math.min(...A.lists.map((l) => l.work));
  } finally { dispose(); }
  out.ms = performance.now() - t0;
  return out;
});

// ---------------------------------------------------------------- the shift against a CPU model
test('shiftModel', async ({ shift = [16, -8] } = {}) => {
  const out = { checks: [] };
  const { sim, derived, dispose } = await h.make([64, 32, 32], { windowed: true });
  try {
    const g = sim.g, n = g.nbricks, [dx, dz] = shift, sb = [dx / 4, 0, dz / 4];
    h.scene(sim, 'mix');
    for (let f = 0; f < 6; f++) { sim.step(); derived.updateBricks(); }
    // the GI history (zeros until shaders/gi.js) gets a pattern of finite halves, every brick's its own
    const pat = new Uint32Array(4 * n * 2);
    for (let i = 0; i < pat.length; i++) pat[i] = ((i * 7) & 0x3bff) | ((((i * 13) + 5) & 0x3bff) << 16);
    gpu.write(derived.giHist, 0, pat);
    sim.giReset = false;   // (the probes shift only when they don't start over)
    const before = await derived.read(), agesBefore = (await derived.readLists()).ages;
    sim.shift(dx, dz);
    const after = await derived.read(), agesAfter = (await derived.readLists()).ages;
    const inBricks = (q) => q.every((v, k) => v >= 0 && v < [g.bx, g.by, g.bz][k]);
    // ages: moved; shifted in: SHIFTED; at a face on a moving axis: age 0, bits kept
    let bad = 0, entering = 0, edges = 0;
    const brickW = (arr, id, words) => arr.subarray(id * words, id * words + words);
    let badBrick = 0, badDist = 0, badGi = 0, badGiTex = 0;
    const bw = words(before.brick), aw = words(after.brick), bd = words(before.brickDist), ad = words(after.brickDist);
    const bh = words(before.giHist), ah = words(after.giHist);
    for (let id = 0; id < n; id++) {
      const bc = brickCoordOf(g, id), q = bc.map((v, k) => v + sb[k]);
      let want;
      if (!inBricks(q)) { want = AGE.SHIFTED; entering++; } else {
        want = agesBefore[brickIdOf(g, ...q)];
        const edge = (sb[0] && (bc[0] < 1 || bc[0] >= g.bx - 1)) || (sb[2] && (bc[2] < 1 || bc[2] >= g.bz - 1));
        if (edge) { want &= ~AGE.MASK; edges++; }
      }
      if (agesAfter[id] !== want) bad++;
      const qi = inBricks(q) ? brickIdOf(g, ...q) : -1;
      const wb = qi < 0 ? new Uint32Array(4) : brickW(bw, qi, 4);
      if (differ(brickW(aw, id, 4), wb)) badBrick++;
      if (ad[id] !== (qi < 0 ? 0 : bd[qi])) badDist++;
      // GI: from the clamped brick, history and textures alike
      const c = q.map((v, k) => Math.min(Math.max(v, 0), [g.bx, g.by, g.bz][k] - 1)), ci = brickIdOf(g, ...c);
      const texel = bc[0] + g.bx * (bc[1] + g.by * bc[2]);
      for (let k = 0; k < 4; k++) {
        const hi = 2 * (k * n + id), hq = 2 * (k * n + ci);
        if (ah[hi] !== bh[hq] || ah[hi + 1] !== bh[hq + 1]) badGi++;
        const t = after[`gi${k}`];
        const want4 = [ah[hi] & 0xffff, ah[hi] >>> 16, ah[hi + 1] & 0xffff, ah[hi + 1] >>> 16];
        if (want4.some((v, j) => t[4 * texel + j] !== v)) badGiTex++;
      }
    }
    check(out, `ages: moved, ${entering} shifted in (SHIFTED), ${edges} at the moving faces re-aged`, !bad, `${bad} of ${n} bricks`);
    check(out, 'brick map: moved by whole bricks, zeros shifted in', !badBrick, `${badBrick} bricks`);
    check(out, 'brickDist: moved by whole bricks, zeros shifted in', !badDist, `${badDist} bricks`);
    check(out, 'GI history: from the clamped brick', !badGi, `${badGi} band words`);
    check(out, 'GI textures: the history\'s halves', !badGiTex, `${badGiTex} texels`);
    // the EMA, cell by cell
    const be = words(before.ema), ae = words(after.ema), S = g.slots;
    let badEma = 0;
    for (let s = 0; s < S; s++) {
      const p = slotCell(g, s), q = [p[0] + dx, p[1], p[2] + dz];
      const inside = q[0] >= 0 && q[0] < g.nx && q[2] >= 0 && q[2] < g.nz;
      const t = inside ? cellSlot(g, ...q) : -1;
      for (let k = 0; k < 3; k++) if (ae[k * S + s] !== (inside ? be[k * S + t] : 0)) badEma++;
    }
    check(out, 'EMA: moved cell by cell, none shifted in', !badEma, `${badEma} words`);
    // the final fields: the region that stays moved, the rest as it was (its bricks are rebuilt)
    let badTex = 0;
    for (const key of ['fieldSurf', 'fieldMedia', 'fieldThin']) {
      const bt = before[key], at = after[key];
      for (let z = 0; z < g.nz; z++)
        for (let y = 0; y < g.ny; y++)
          for (let x = 0; x < g.nx; x++) {
            const qx = x + dx, qz = z + dz, inside = qx >= 0 && qx < g.nx && qz >= 0 && qz < g.nz;
            const i = 4 * (x + g.nx * (y + g.ny * z)), j = inside ? 4 * (qx + g.nx * (y + g.ny * qz)) : i;
            for (let c = 0; c < 4; c++) if (at[i + c] !== bt[j + c]) badTex++;
          }
    }
    check(out, 'final fields: moved texel by texel', !badTex, `${badTex} halves`);
    // and none of it was trivially equal: the shift moved something
    check(out, 'the shift changed what it moved', differ(be, ae) > 0 && differ(bw, aw) > 0 && differ(bh, ah) > 0);
  } finally { dispose(); }
  return out;
});

// ---------------------------------------------------------------- boost stages 3-5 fused
// The fused peak against the WebGL build's separable stages: x and y
// (fieldMaxFrag), then z with the last stage's arithmetic (fieldPeakFrag with
// reach 0, 0, 1), over the same lists, bit for bit; and the peak isn't
// vacuous (reach 0 gives other fields).
test('fused', async () => {
  const out = { checks: [] };
  const { sim, derived, dispose } = await h.make(32);
  try {
    await derived.prepare('fieldMax');
    h.scene(sim, 'mix');
    sim.incremental = false;
    for (let f = 0; f < 6; f++) { sim.step(); sim.step(); derived.updateBricks(); }
    const keys = ['fieldSurf', 'fieldMedia', 'fieldThin'];
    const fused = await derived.read();
    const { bulk } = fieldWeights(sim.smoothing);
    const gr = derived.groups, f = () => gpu.frame, bind = (grp) => [sim.tables, gpu.emptyGroup, grp];
    const peak = (reach) => derived.kernels.fieldPeak.dispatch(f(), derived._over(DIRTY.FIELDS), { bind: bind(gr.peak), params: { bulk, reach } });
    // stage 2 is in scratch A: x into B, y back into A, then z
    const max = derived.passOf('fieldMax');
    max.dispatch(f(), derived._over(DIRTY.WORK), { bind: bind(gr.boost[1]), params: { axis: 0 } });
    max.dispatch(f(), derived._over(DIRTY.WORK), { bind: bind(gr.boost[2]), params: { axis: 1 } });
    peak([0, 0, 1]);
    const sep = await derived.read();
    const d = keys.map((k) => differ(words(fused[k]), words(sep[k])));
    check(out, 'fused peak == separable stages 3, 4, 5 (fieldSurf, fieldMedia, fieldThin)', d.every((x) => !x), d.join(', '));
    // the maximum matters: without it (reach 0) the boost comes out otherwise
    peak([0, 0, 0]);
    const none = await derived.read();
    const thin = words(fused.fieldThin).some((x) => x !== 0);
    check(out, 'the peak isn\'t vacuous: reach 0 gives other fields, and some cell is boosted',
      keys.some((k) => differ(words(fused[k]), words(none[k]))) && thin);
  } finally { dispose(); }
  return out;
});

// ---------------------------------------------------------------- the brick map's bits
const DECODED = 4;   // words per decoded word: bits, air, gas share (f32 bits), matter
test('bits', async () => {
  const out = { checks: [] };
  const { sim, derived, dispose } = await h.make(32);
  try {
    await derived.prepare('brickBits');
    // every combination of the fields, through the WGSL decoders, against the JS twins
    const all = [];
    for (let bits = 0; bits < 32; bits++)
      for (let air = 0; air < 8; air++)
        for (let gas = 0; gas <= 64; gas++)
          for (const matter of [false, true]) all.push((bits | (air << BRICK_INFO.AIR_SHIFT) | (gas << BRICK_INFO.GAS_SHIFT) | (matter ? BRICK_INFO.MATTER : 0)) >>> 0);
    const decodeOnGpu = async (list) => {
      const src = gpu.createBuffer({ label: 'bits words', size: Math.max(16, list.length * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const dst = gpu.createBuffer({ label: 'bits decoded', size: list.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      gpu.write(src, 0, Uint32Array.from(list));
      const group = gpu.bindGroup(derived.L.PAIR, [{ binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } }], 'bits');
      derived.passOf('brickBits').dispatch(gpu.frame, [Math.ceil(list.length / 64), 1, 1], { bind: [sim.tables, gpu.emptyGroup, group] });
      const r = new Uint32Array(await gpu.readback.buffer(dst, 0, list.length * 16));
      src.destroy();
      dst.destroy();
      return r;
    };
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    const twin = (w) => { const u = unpackBrickInfo(w); f32[0] = u.gas / 64; return [u.bits, u.air, u32[0], u.matter ? 1 : 0]; };
    const dec = await decodeOnGpu(all);
    let bad = 0;
    all.forEach((w, i) => { if (twin(w).some((v, k) => dec[DECODED * i + k] !== v)) bad++; });
    check(out, `decoders == JS twins on ${all.length} info words (bits, air flags, gas share, matter)`, !bad, `${bad} words`);
    // a scene of bricks that each hold one thing (no steps: the fields are its targets)
    h.scene(sim, 'bits');
    derived.updateBricks();
    const r = await derived.read();
    const bw = words(r.brick), g = sim.g;
    const rec = (b) => {
      const id = brickIdOf(g, ...b), info = bw[4 * id + 3];
      return { info, ...unpackBrickInfo(info), emit: new Float32Array(bw.buffer, bw.byteOffset + id * 16, 3) };
    };
    const B = BRICK_INFO;
    const has = (u, bit) => (u.bits & bit) !== 0;
    const lit = (u) => u.emit.some((x) => x > 0);
    const want = {
      water: (u) => u.matter && has(u, B.SURF) && !has(u, B.OPAQUE) && !has(u, B.MIXED) && u.gas === 0 && !lit(u),
      rubble: (u) => u.matter && has(u, B.SURF) && has(u, B.OPAQUE) && u.gas === 0 && !lit(u),
      steam: (u) => u.matter && has(u, B.MEDIA) && u.gas === 64 && !lit(u),
      'hot air': (u) => u.info === (AIR.HOT << B.AIR_SHIFT) && !lit(u),
      'water and oil': (u) => u.matter && has(u, B.MIXED) && has(u, B.SURF),
      lava: (u) => u.matter && has(u, B.OPAQUE) && lit(u),
      empty: (u) => u.info === 0 && !lit(u),
    };
    const liquids = LOOK[E.WATER].ch === 0 && LOOK[E.OIL].ch === 0;   // (both in the liquid channel, so MIXED holds)
    const seen = [];
    for (const [what, , b] of BITS) {
      const u = rec(b);
      seen.push(u.info);
      const ok = want[what](u) && (what !== 'water and oil' || liquids);
      check(out, `brick ${b.join(',')} (${what}): ${u.matter ? 'matter' : 'no matter'}, bits ${u.bits}, air ${u.air}, gas ${u.gas}, emit ${[...u.emit].map((x) => x.toFixed(3)).join(' ')}`, ok);
    }
    // the scene's real words through the decoders too
    const dec2 = await decodeOnGpu(seen);
    let bad2 = 0;
    seen.forEach((w, i) => { if (twin(w).some((v, k) => dec2[DECODED * i + k] !== v)) bad2++; });
    check(out, 'the scene\'s words decode on the GPU as in JS', !bad2, `${bad2} words`);
  } finally { dispose(); }
  return out;
});

// ---------------------------------------------------------------- budgets (tools/budgets/derived.mjs)
const measure = async (fn) => {
  const before = { ...gpu.stats };
  await fn();
  return Object.fromEntries(Object.entries(gpu.stats).map(([k, v]) => [k, v - before[k]]));
};
// The workgroups the indirect dispatches recorded since `from` ran, and those
// their lists call for (a workgroup per entry).
async function indirect(derived, from) {
  const n = await gpu.indirectWorkgroups(from);
  const l = await derived.readLists();
  // EMA once, WORK six times (blur 3, boost 3), FIELDS twice (peak, brick)
  return { workgroupsIndirect: n, listsCallFor: l.ema + 6 * l.work + 2 * l.fields, lists: l };
}
// A derived frame of the lab after 4 steps (32³): one submit, one compute
// pass, 9 indirect dispatches and 12 direct ones, nothing allocated.
test('budget:frame', async ({ scene = 'lab', size = 32, steps = 4 } = {}) => {
  const { sim, derived, dispose } = await h.make(size);
  try {
    h.scene(sim, scene);
    for (let i = 0; i < 8; i++) sim.step();
    derived.updateBricks();
    for (let i = 0; i < steps; i++) sim.step();
    await sim.gpuSync();
    const from = gpu.indirectLog.length;
    const stats = await measure(async () => { derived.updateBricks(); gpu.endFrame(); await sim.gpuSync(); });
    const ind = await indirect(derived, from);
    return { stats, ...ind, matchesLists: ind.workgroupsIndirect === ind.listsCallFor ? 1 : 0 };
  } finally { dispose(); }
});
// A settled scene (no steps, no writes for FIELD_EMA_SETTLE derived frames):
// the lists are empty, so the indirect dispatches run no workgroup; what's
// left is the bookkeeping and the brick-resolution passes.
test('budget:settled', async ({ scene = 'mix', size = 32 } = {}) => {
  const { sim, derived, dispose } = await h.make(size);
  try {
    h.scene(sim, scene);
    for (let i = 0; i < 4; i++) sim.step();
    for (let f = 0; f < 16; f++) derived.updateBricks();
    await sim.gpuSync();
    const from = gpu.indirectLog.length;
    const stats = await measure(async () => { derived.updateBricks(); gpu.endFrame(); await sim.gpuSync(); });
    return { stats, ...(await indirect(derived, from)) };
  } finally { dispose(); }
});
// A window move on a settled 64×32×32 window (docs/webgpu.md E, G1): the
// derived history shifts, and only the slab shifted in and the bricks at the
// faces on the moving axis re-age, not every brick (the WebGL build's
// changedAll). A second move allocates nothing.
test('budget:move', async () => {
  const { sim, derived, dispose } = await h.make([64, 32, 32], { windowed: true });
  try {
    h.scene(sim, 'mix');
    for (let i = 0; i < 4; i++) sim.step();
    for (let f = 0; f < 16; f++) derived.updateBricks();
    sim.shift(16, 0);
    derived.updateBricks();
    const first = await derived.readLists();
    for (let f = 0; f < 16; f++) derived.updateBricks();
    await sim.gpuSync();
    const stats = await measure(async () => { sim.shift(-16, 0); derived.updateBricks(); gpu.endFrame(); await sim.gpuSync(); });
    const l = await derived.readLists();
    return { stats, ema: first.ema, fields: first.fields, work: first.work, bricks: sim.g.nbricks, second: { ema: l.ema, fields: l.fields, work: l.work } };
  } finally { dispose(); }
});

// ---------------------------------------------------------------- bench (tools/derived-bench.mjs)
const DERIVED_KERNELS = ['noteAwake', 'awake', 'age', 'dirty', 'dirtyArgs', 'fieldEma', 'fieldBlur', 'fieldFinal', 'fieldBoost0',
  'fieldBoost', 'fieldPeak', 'brick', 'brickDist', 'blur', 'blurLast'];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] ?? NaN; };
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
// ms per derived frame per kernel (split timestamps) over `frames` frames of
// `steps` steps and a derived frame each; wall ms per frame, steps included.
async function timeChunk(sim, derived, frames, steps) {
  const timing = gpu.timing;
  await sim.gpuSync();
  timing.enabled = true;
  timing.split = true;
  const before = timing.lastFrame;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < steps; i++) sim.step();
    derived.updateBricks();
  }
  gpu.endFrame();
  await sim.gpuSync();
  const wall = (performance.now() - t0) / frames;
  for (let k = 0; k < 200 && timing.lastFrame === before; k++) await nextFrame();
  timing.enabled = false;
  timing.split = false;
  const per = {};
  for (const [name, ms] of Object.entries(timing.last)) if (DERIVED_KERNELS.includes(name)) per[name] = ms / frames;
  return { wall, per, derived: Object.values(per).reduce((a, b) => a + b, 0) };
}
/**
 * @param {{ sizes?: number[], scenes?: string[], frames?: number, steps?: number, chunks?: number, warm?: number }} [opts]
 */
async function bench({ sizes = [32, 64], scenes = ['lab', 'volcano'], frames = 6, steps = 2, chunks = 2, warm = 12 } = {}) {
  const out = { gpu: gpu.adapterInfo, timestamps: gpu.timing.supported, grids: [] };
  for (const n of sizes) {
    const { sim, derived, dispose } = await h.make(n);
    const grid = { n, scenes: [] };
    try {
      for (const scene of scenes) {
        h.scene(sim, scene);
        for (let i = 0; i < warm; i++) { sim.step(); if (i % 4 === 3) derived.updateBricks(); }
        const rows = { incremental: [], full: [] };
        for (let c = 0; c < chunks; c++) {
          for (const mode of c % 2 ? ['full', 'incremental'] : ['incremental', 'full']) {
            sim.incremental = mode === 'incremental';
            rows[mode].push(await timeChunk(sim, derived, frames, steps));
          }
        }
        sim.incremental = true;
        derived.updateBricks();
        const l = await derived.readLists();
        const res = { scene, bricks: sim.g.nbricks, lists: { ema: l.ema, fields: l.fields, work: l.work }, modes: {} };
        for (const [mode, r] of Object.entries(rows)) {
          const kernels = {};
          for (const k of DERIVED_KERNELS) { const xs = r.map((x) => x.per[k]).filter((x) => x !== undefined); if (xs.length) kernels[k] = median(xs); }
          res.modes[mode] = { gpuMsPerFrame: median(r.map((x) => x.derived)), wallMsPerFrame: median(r.map((x) => x.wall)), kernels };
        }
        grid.scenes.push(res);
        log(`${n}³ ${scene}: lists ${l.ema}/${l.fields}/${l.work} of ${sim.g.nbricks}; derived GPU ms/frame incremental ${res.modes.incremental.gpuMsPerFrame.toFixed(2)}, full ${res.modes.full.gpuMsPerFrame.toFixed(2)}`);
      }
    } finally { dispose(); }
    out.grids.push(grid);
  }
  return out;
}
test('bench', bench);

log('derived-check page ready');
ready();
