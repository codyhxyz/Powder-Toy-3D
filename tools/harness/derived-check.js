// The derived passes' harness page (docs/webgpu.md E, I1): a Simulation and
// its derived passes (src/derived.js) on this page's WebGPU device, no app.
// tools/derived-check.mjs, derived-bench.mjs and budget-check's derived
// scenarios drive it through window.__harness:
//   case:<name>    incremental against sim.incremental = false, bit for bit,
//                  every derived resource, at checkpoints of a scripted run
//   shiftModel     the window shift's kernels and copies against a CPU model
//   fused          the fused peak (boost stages 3-5) against the separable stages
//   bits           the brick map's info words: the WGSL decoders against the
//                  JS twins, and a scene's bricks against what they hold (a
//                  lit lamp's light with LAMP_ROOM_GAIN)
//   jet            pours from whitewater's aeration field (shaders/fields.js
//                  jetWGSL): every record kind through the EMA, the boost
//                  and the brick map, against a JS twin
//   budget:*       tools/budgets/derived.mjs
//   bench          GPU ms per derived kernel, incremental and full

import { boot, ready, log, test } from './harness.js';
import { Simulation, cellTexel, cellSlot, slotCell } from '/src/sim.js';
import { Derived, fieldWeights } from '/src/derived.js';
import { buildPreset } from '/src/presets.js';
import { E, ELEMENTS, TOOLS } from '/src/elements.js';
import { SEED_MAX, BRICK, brickIdOf, brickCoordOf } from '/src/shaders/common.js';
import { AGE, DIRTY } from '/src/shaders/fields.js';
import { unpackBrickInfo, BRICK_INFO, AIR } from '/src/shaders/bindings.js';
import { LOOK, LAMP_GLOW, LAMP_ROOM_GAIN } from '/src/gfx/materials.js';
import { LAMP_DC } from '/src/electricity.js';
import { JOIN_REACH } from '/src/shaders/gfx/liquidDetail.js';

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
  // a wall floor and wall pillars: nothing moves, so the lists of a running
  // world hold only what its writes set moving (shiftPending)
  calm(set, g) {
    for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) set(x, 0, z, E.WALL);
    for (let x = 5; x < g.nx; x += 11) for (let y = 1; y < g.ny / 2; y++) set(x, y, g.nz / 2, E.WALL);
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
    for (const [, id, lo, temp, ctype] of BITS) {
      if (id === null) continue;
      for (let y = lo[1] * 4; y < (lo[1] + 1) * 4; y++)
        for (let z = lo[2] * 4; z < (lo[2] + 1) * 4; z++)
          for (let x = lo[0] * 4; x < (lo[0] + 1) * 4; x++) {
            set(x, y, z, Array.isArray(id) ? id[x & 1] : id, { ...(temp ? { temp } : {}), ...(ctype ? { ctype } : {}) });
          }
    }
  },
};
// The bits scene's bricks: [what, element (or two, alternating by x), brick, temperature, ctype]
const BITS = [
  ['water', E.WATER, [1, 0, 1]],
  ['rubble', E.STONE, [5, 0, 1]],
  ['steam', E.STEAM, [1, 5, 5]],
  ['hot air', E.EMPTY, [6, 5, 6], 200],
  ['water and oil', [E.WATER, E.OIL], [5, 5, 1]],
  ['lava', E.LAVA, [1, 5, 1]],
  ['empty', null, [3, 7, 3]],
  ['lit lamp', E.LAMP, [3, 3, 6], null, LAMP_DC],   // (src/electricity.js: a lamp on a battery's current)
  ['lamp', E.LAMP, [6, 2, 3]],
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

const ERASE = TOOLS.find((t) => t.key === 'ERASE').id;
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
// COMPARE_EVERY frames and the last, or with checkMoves each move's frame and
// the one after).
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
  // a still world (no steps) painted every frame with stone and water: only the
  // bricks the brush changes are marked, so the lists' dilation alone covers
  // the fields around them (in a running world the quiet map's own dilation
  // hides a short one)
  still: { scene: 'mix', size: 32, warm: 4, settle: SETTLE, frames: 18, spf: 0, writes: 'still' },
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
  // moves in a settled, running world, each tick in the app's order (docs/webgpu.md
  // B3): an edit, the steps, an edit after them, the move, the slab's fill (static
  // ground, as a world's generator mostly fills it), the derived frame. Every move
  // finds changes the age pass hasn't counted yet: the edits' marks, and the
  // steps' `changed` map, with sand falling into a settled brick that only the
  // steps changed (pendingWrites). Compared at each move's frame and the next,
  // where the lists must skip bricks (one axis a move, far enough apart for the
  // last one's bricks to settle: in this window two at once re-age nearly every
  // brick, and the cases above have them); and dropping the fold before the
  // shift (src/derived.js) must make incremental differ from full.
  shiftPending: {
    scene: 'calm', size: [64, 32, 32], warm: 8, settle: SETTLE, frames: 32, spf: 1, windowed: true, writes: 'pending',
    slab: E.WALL, shifts: { 2: [[16, 0]], 16: [[0, -8]], 30: [[-16, 0]] },
    checkMoves: true, mustSkip: true, control: 'dropFold',
  },
  // pours (shaders/fields.js jetWGSL) in a still world: whitewater's
  // aeration attached with records over settled bricks (JET_RECORDS), then
  // detached, each time long enough for the lists to empty again. Its start
  // and stop rebuild every brick (src/derived.js updateDirty); without that
  // (the control) the settled bricks would keep what they held
  jetToggle: {
    scene: 'pool', size: 32, warm: 4, settle: SETTLE, frames: 36, spf: 0, aer: { on: 1, off: 19 },
    control: 'dropJetToggle',
  },
};
// The grid of a case at --size n (tools/derived-check.mjs): n³, or a window
// twice as wide for the moving cases (as 64×32×32 is to 32); else its own.
const caseDims = (spec, n) => (!n ? spec.size : spec.windowed ? [2 * n, n, n] : n);

// A shiftPending tick around a move m, away from the grid's faces and the
// slab: at m - 1 a tick with no steps (the pacer's, at a low speed) that
// pours sand into the air, its bottom row on a brick's, so its derived frame
// counts the sand's bricks (marks) but not the one below; m's tick takes four
// steps (catching up), in which the sand falls into that settled brick: a
// change only the steps' `changed` map holds. Around those steps a block of
// wall into the air before (POV edits, the brush) and one after (lightning:
// a write the steps never saw). At m + 1 the sand, wherever it fell, is
// erased before it piles up (a pile's edge stays unsettled for a long time,
// 80 steps and more here, and its bricks young with it).
const PENDING_STEPS = 4;
const pendingSteps = (spec, f) => (spec.shifts[f + 1] ? 0 : spec.shifts[f] ? PENDING_STEPS : spec.spf);
function pendingWrites(sim, spec, f, when) {
  const g = sim.g;
  const yb = BRICK * Math.floor((0.65 * g.ny) / BRICK);   // the sand's bottom row
  const sand = [Math.floor(g.nx * 0.4) + 0.5, Math.floor(g.nz * 0.4) + 0.5];
  const box = (x, y, z, radius, tool, replace = false) => sim.paint({ center: V(x, y, z), radius, shape: 1, tool, rate: 4, replace });
  if (when === 'before' && spec.shifts[f + 1]) box(sand[0], yb + 1.5, sand[1], 1.5, E.SAND);   // (rate 4: every cell)
  if (when === 'before' && spec.shifts[f]) box(g.nx * 0.5, g.ny * 0.3, g.nz * 0.55, 1.5, E.WALL);
  if (when === 'after' && spec.shifts[f]) box(g.nx * 0.56, g.ny * 0.42, g.nz * 0.45, 1.5, E.WALL);
  // (the sand moved with the window: it is at its old place less the move)
  const [[dx, dz] = []] = spec.shifts[f - 1] ?? [];
  if (when === 'before' && dx !== undefined) box(sand[0] - dx, yb + 0.5, sand[1] - dz, 4.5, ERASE, true);
}

// The slab a shift by (dx, dz) brought in, filled the way a world fills it:
// an edit over it (a cube of sand, or of tool, part of the slab).
function fillSlab(sim, dx, dz, tool = E.SAND) {
  const g = sim.g;
  const x0 = dx > 0 ? g.nx - dx : 0, x1 = dx > 0 ? g.nx : dx < 0 ? -dx : g.nx;
  const z0 = dz > 0 ? g.nz - dz : 0, z1 = dz > 0 ? g.nz : dz < 0 ? -dz : g.nz;
  const c = V((x0 + x1) / 2, 3, (z0 + z1) / 2);
  sim.paint({ center: c, radius: Math.min(x1 - x0, z1 - z0) / 2, shape: 1, tool, rate: 0.6, replace: false });
}

// test: derived.test's switches for this run (the negative controls)
const NO_CONTROLS = { dropFold: false, dropJetToggle: false };
async function scripted(sim, derived, spec, incremental, test = {}) {
  const g = sim.g;
  Object.assign(derived.test, NO_CONTROLS, test);
  sim.attachAeration(null);
  let aer = null;
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
    if (spec.writes === 'pending') pendingWrites(sim, spec, f, 'before');
    const steps = spec.writes === 'pause' && f >= spec.frames / 2 ? 0 : spec.writes === 'pending' ? pendingSteps(spec, f) : spec.spf;
    for (let s = 0; s < steps; s++) sim.step();
    if (spec.writes === 'pending') pendingWrites(sim, spec, f, 'after');
    if (spec.writes === 'paint' || (spec.writes === 'smoothing' && f % 3 === 0)) {
      sim.paint({ center: V(g.nx * 0.3 + f * PAINT_DRIFT, g.ny * 0.6, g.nz * 0.4), radius: 3, shape: f & 1, tool: E.WATER, rate: 1, replace: false });
    }
    if (spec.writes === 'still') {
      sim.paint({ center: V(g.nx * 0.25 + f * PAINT_DRIFT, g.ny * 0.75, g.nz * 0.6), radius: 1.5, shape: f & 1, tool: f & 2 ? E.WATER : E.STONE, rate: 1, replace: true });
    }
    if (spec.writes === 'heat') sim.paint({ center: V(g.nx / 2, g.ny * 0.2 + f * PAINT_DRIFT, g.nz / 2), radius: 4, shape: 0, tool: -2, rate: 1, replace: false });
    if (spec.writes === 'undo' && f === 2) sim.snapshot();
    if (spec.writes === 'undo' && f === 6) sim.undo();
    if (spec.writes === 'smoothing' && f === 6) sim.smoothing = 1.5;
    for (const [dx, dz] of spec.shifts?.[f] ?? []) {
      sim.shift(dx, dz);
      fillSlab(sim, dx, dz, spec.slab);
    }
    if (spec.aer?.on === f) sim.attachAeration(aer = fakeAeration(sim, JET_RECORDS, 1));
    if (spec.aer?.off === f) sim.attachAeration(null);
    derived.updateBricks();
    const due = spec.checkMoves ? Boolean(spec.shifts[f] || spec.shifts[f - 1]) : f % COMPARE_EVERY === COMPARE_EVERY - 1;
    if (due || f === spec.frames - 1) {
      snaps.push(await derived.read());
      lists.push(await derived.readLists());
    }
  }
  Object.assign(derived.test, NO_CONTROLS);
  sim.attachAeration(null);
  aer?.dispose();
  return { snaps, lists };
}

// Every derived resource of two runs' checkpoints compared: [key@checkpoint: n words].
function compareRuns(A, B) {
  const diffs = [];
  let compared = 0, total = 0;
  A.snaps.forEach((snap, c) => {
    for (const [key, a] of Object.entries(snap)) {
      compared++;
      const d = differ(words(a), words(B.snaps[c][key]));
      total += d;
      if (d) diffs.push(`${key}@${c}: ${d} words`);
    }
  });
  return { diffs, compared, words: total };
}

// size: tools/derived-check.mjs --size (caseDims)
test('case', async (name, { size = null } = {}) => {
  const spec = CASES[name];
  if (!spec) throw new Error(`derived-check: no case ${name} (have: ${Object.keys(CASES).join(', ')})`);
  const out = { checks: [], lists: [] };
  const t0 = performance.now();
  const { sim, derived, dispose } = await h.make(caseDims(spec, size), { windowed: Boolean(spec.windowed) });
  try {
    const g = sim.g;
    out.grid = `${g.nx}×${g.ny}×${g.nz}`;
    const A = await scripted(sim, derived, spec, true);
    const B = await scripted(sim, derived, spec, false);
    const n = g.nbricks, { diffs, compared } = compareRuns(A, B);
    A.lists.forEach((l, c) => out.lists.push({ ema: l.ema, fields: l.fields, work: l.work, full: B.lists[c].work, bricks: n }));
    check(out, `${name}: incremental == full, ${compared} resource comparisons (${A.snaps.length} checkpoints)`, !diffs.length, diffs.join(', '));
    // (the full run's lists hold every brick; a run whose incremental lists did too compared nothing)
    check(out, `${name}: the full run's lists hold every brick`, B.lists.every((l) => l.ema === n && l.fields === n && l.work === n));
    if (spec.mustSkip) {
      const all = A.lists.filter((l) => l.work >= n).length;
      check(out, `${name}: the incremental lists skipped bricks at every checkpoint`, !all, `${all} of ${A.lists.length} checkpoints listed every brick`);
    }
    // the negative control: the same run with a part of the incremental scheme switched off must differ
    if (spec.control) {
      const C = await scripted(sim, derived, spec, true, { [spec.control]: true });
      const c = compareRuns(C, B);
      check(out, `${name}: negative control (derived.test.${spec.control}): incremental != full`, c.diffs.length > 0,
        'no difference: the case doesn\'t exercise what the control drops');
      out.control = { words: c.words, first: c.diffs.slice(0, 6).join(', ') };
    }
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
    for (let f = 0; f < 5; f++) { sim.step(); derived.updateBricks(); }
    // the GI history (zeros until shaders/gi.js) gets a pattern of finite halves, every brick's its own
    const pat = new Uint32Array(4 * n * 2);
    for (let i = 0; i < pat.length; i++) pat[i] = ((i * 7) & 0x3bff) | ((((i * 13) + 5) & 0x3bff) << 16);
    gpu.write(derived.giHist, 0, pat);
    sim.giReset = false;   // (the probes shift only when they don't start over)
    // changes pending at the move: a step after the last derived frame, under
    // the map that frame's age pass already counted (the fold's carry notes it
    // again), and rubble into the air (an edit's marks: the bricks where A or B
    // changed). The fold before the shift gives each of their bricks CHANGED,
    // which it carries with it.
    sim.step();
    const [A0, B0] = await sim.readState();
    sim.paint({ center: V(g.nx * 0.6, g.ny * 0.6, g.nz * 0.4), radius: 2, shape: 1, tool: E.STONE, rate: 1, replace: true });
    const [A1, B1] = await sim.readState();
    const marked = new Set();
    for (let z = 0; z < g.nz; z++)
      for (let y = 0; y < g.ny; y++)
        for (let x = 0; x < g.nx; x++) {
          const i = cellTexel(g, x, y, z) * 4;
          for (let c = 0; c < 4; c++) {
            if (A0[i + c] !== A1[i + c] || B0[i + c] !== B1[i + c]) marked.add(brickIdOf(g, Math.floor(x / BRICK), Math.floor(y / BRICK), Math.floor(z / BRICK)));
          }
        }
    // what the fold counts (src/derived.js shift, passes.js ageFrag at tick 0):
    // the carry's note of the current map (sim.noteAwake: changed = !quiet, or
    // over what `changed` holds when it is noted), then `changed` if noted
    const AL = sim.actLayout;
    const act = new Uint32Array(await gpu.readback.buffer(sim.act, 0, AL.map * 4));
    const carry = sim.actCarry !== null && sim.actAge > sim.actCarry;
    const noted = carry || sim.actNoted;
    const pending = (b) => {
      if (marked.has(b)) return true;
      const was = act[AL.changed + b] !== 0, woke = act[AL.quiet + b] === 0;
      return noted && (carry ? woke || (sim.actNoted && was) : was);
    };
    const before = await derived.read(), agesBefore = (await derived.readLists()).ages;
    sim.shift(dx, dz);
    const after = await derived.read(), agesAfter = (await derived.readLists()).ages;
    const inBricks = (q) => q.every((v, k) => v >= 0 && v < [g.bx, g.by, g.bz][k]);
    // ages: moved, with CHANGED where a change was pending; shifted in: SHIFTED; at a face on a moving axis: age 0, bits kept
    let bad = 0, entering = 0, edges = 0, carried = 0, edited = 0;
    const brickW = (arr, id, words) => arr.subarray(id * words, id * words + words);
    let badBrick = 0, badDist = 0, badGi = 0, badGiTex = 0;
    const bw = words(before.brick), aw = words(after.brick), bd = words(before.brickDist), ad = words(after.brickDist);
    const bh = words(before.giHist), ah = words(after.giHist);
    for (let id = 0; id < n; id++) {
      const bc = brickCoordOf(g, id), q = bc.map((v, k) => v + sb[k]);
      let want;
      if (!inBricks(q)) { want = AGE.SHIFTED; entering++; } else {
        const qi = brickIdOf(g, ...q);
        want = agesBefore[qi] | (pending(qi) ? AGE.CHANGED : 0);
        if (pending(qi)) carried++;
        if (marked.has(qi)) edited++;
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
    check(out, `ages: moved, ${entering} shifted in (SHIFTED), ${edges} at the moving faces re-aged, ${carried} CHANGED `
      + `(${edited} of the edit's ${marked.size} bricks, the rest the steps'; carry ${carry ? 'noted' : 'not needed'})`,
    !bad && edited > 0 && carried > edited && carry, `${bad} of ${n} bricks${carry ? '' : '; no carry: the step started a map'}`);
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
    // The slab filled, a derived frame: its bricks are FRESH (the age pass took
    // their SHIFTED), and their cells start over at their targets: sand in it
    // has full granular occupancy at once, not a blend from no history.
    fillSlab(sim, dx, dz);
    derived.updateBricks();
    const [A] = await sim.readState();
    const ema = words((await derived.read()).ema), ages = (await derived.readLists()).ages;
    let fresh = 0, notFresh = 0, counted = 0, notCounted = 0, left = 0;
    for (let id = 0; id < n; id++) {
      if (ages[id] & AGE.CHANGED) left++;
      const q = brickCoordOf(g, id).map((v, k) => v + sb[k]);
      if (inBricks(q)) {
        if (agesAfter[id] & AGE.CHANGED) { if ((ages[id] & AGE.MASK) === 0) counted++; else notCounted++; }
        continue;
      }
      if ((ages[id] & AGE.FRESH) && !(ages[id] & AGE.SHIFTED)) fresh++; else notFresh++;
    }
    let sand = 0, blended = 0;
    for (let s = 0; s < S; s++) {
      const [x, y, z] = slotCell(g, s);
      const inSlab = (dx > 0 ? x >= g.nx - dx : x < -dx) || (dz > 0 ? z >= g.nz - dz : z < -dz);
      if (!inSlab || Math.round(A[cellTexel(g, x, y, z) * 4]) !== E.SAND) continue;
      sand++;
      if (((ema[s] >>> 16) & 255) !== 255) blended++;   // byte 2: the granular channel
    }
    check(out, `the slab's ${fresh} bricks are FRESH after the next age pass`, fresh > 0 && !notFresh, `${notFresh} not`);
    check(out, `the next age pass counts the ${counted} CHANGED bricks (age 0) and clears the bit`, counted > 0 && !notCounted && !left,
      `${notCounted} older, ${left} CHANGED left`);
    check(out, `the slab's ${sand} sand cells start at full occupancy (no blend from a history they lack)`, sand > 0 && !blended, `${blended} blended`);
    // resetGI: the probes (history and the textures the shift wrote) back to zeros
    const giBefore = [0, 1, 2, 3].some((k) => words(after[`gi${k}`]).some((x) => x !== 0));
    derived.resetGI();
    const z = await derived.read();
    const zero = (x) => words(x).every((w) => w === 0);
    check(out, 'resetGI zeroes the GI history and its four textures', giBefore && zero(z.giHist) && [0, 1, 2, 3].every((k) => zero(z[`gi${k}`])));
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
    const peak = (reach) => derived.kernels.fieldPeak.dispatch(f(), derived._over(DIRTY.FIELDS), { bind: [sim.tables, sim.bindRO, gr.peak], header: sim.header(), params: { bulk, reach } });
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
      // a lamp is opaque matter: lit, it sheds LAMP_ROOM_GAIN × its glow
      // through its open faces (the brick's 96, × GLOW_FACE_GAIN = BRICK
      // each), averaged over the brick's 64 cells; unlit and cold, nothing
      'lit lamp': (u) => u.matter && has(u, B.OPAQUE) && u.emit.every((x, k) => Math.abs(x - lampWant[k]) <= 1e-5 * lampWant[k]),
      lamp: (u) => u.matter && has(u, B.OPAQUE) && !lit(u),
    };
    const lampWant = LAMP_GLOW.map((v) => Math.fround(+v.toFixed(4)) * LAMP_ROOM_GAIN * ((96 * BRICK) / 64));
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

// ---------------------------------------------------------------- pours (jetWGSL)
// A stand-in for whitewater's aeration field (gfx/foam.js, U12): records put
// by hand, both copies, `cur` the current one. sim.attachAeration takes it.
const half = (x) => {   // f32 → f16 bits (the mantissa truncated: exact for values f16 holds)
  if (x === 0) return 0;
  const u = new Uint32Array(new Float32Array([x]).buffer)[0];
  return ((u >>> 16) & 0x8000) | ((((u >>> 23) & 255) - 112) << 10) | ((u >>> 13) & 1023);
};
const unhalf = (h) => {   // f16 bits → the number (normal values and 0)
  if (!(h & 0x7fff)) return 0;
  return (h & 0x8000 ? -1 : 1) * 2 ** (((h >>> 10) & 31) - 15) * (1 + (h & 1023) / 1024);
};
function fakeAeration(sim, records, cur = 1) {
  const g = sim.g, words = new Uint32Array(4 * g.slots);   // vec2u per slot, two copies
  for (const { at: [x, y, z], f, copy = cur } of records) {
    if (x >= g.nx || y >= g.ny || z >= g.nz) continue;
    const i = 2 * (copy * g.slots + cellSlot(g, x, y, z));
    words[i] = half(f[0]) | (half(f[1]) << 16);
    words[i + 1] = half(f[2]) | (half(f[3]) << 16);
  }
  const buffer = gpu.createBuffer({ label: 'fake aeration', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  gpu.write(buffer, 0, words);
  return { active: true, buffer, cur, step() {}, idle() {}, reset() {}, dispose: () => buffer.destroy() };
}
// jetWGSL's jetAt, the JS twin: does cell p draw as a pour, given the records
// of the current copy (as the GPU reads them back: f16)?
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };
function jetTwin(g, records, cur) {
  const at = new Map();
  for (const rec of records) if ((rec.copy ?? cur) === cur) at.set(rec.at.join(','), rec.f.map((v) => unhalf(half(v))));
  const inGrid = ([x, y, z]) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
  const aerAt = (c) => (inGrid(c) && at.get(c.join(','))) || [0, 0, 0, 0];
  return (p) => {
    const f = aerAt(p);
    if (f[1] > 1.5) return true;
    if (f[1] >= 0 || f[0] * f[0] + f[2] * f[2] + f[3] * f[3] < 0.5) return false;
    for (let k = 1; k <= JOIN_REACH; k++) {
      if (aerAt([p[0] - roundEven(f[0] * k), p[1] - roundEven(f[2] * k), p[2] - roundEven(f[3] * k)])[1] > 1.5) return true;
    }
    return false;
  };
}
// Records in the air over the pool scene's tank (32³), in the aeration's
// layout (shaders/gfx/liquidDetail.js, the aeration model): liquid (aeration,
// 1 or 2 for a pour's parcel, fall, grounded); a wake (way x, −age, way y, way
// z), the way a unit vector if a pour's parcel left it, half that if not. Each
// kind, each way a wake can fail to show, and one record in the other copy.
const DOWN = [0, -1, 0];
const wake = (way, age = 0.5) => [way[0], -age, way[1], way[2]];
const PARCEL = [0.5, 2, 0.25, 0];
const JET_RECORDS = [
  { what: 'a pour\'s parcel', at: [12, 24, 12], f: PARCEL, shows: true },
  { what: 'a pour\'s parcel two cells behind a wake', at: [12, 28, 12], f: PARCEL, shows: true },
  { what: 'the wake between them', at: [12, 26, 12], f: wake(DOWN), shows: true },
  { what: 'liquid off the ground, not a pour', at: [20, 24, 12], f: [0.625, 1, 0, 0], shows: false },
  { what: 'a pour\'s wake nothing comes up behind', at: [20, 26, 20], f: wake(DOWN, 1), shows: false },
  { what: 'a wake liquid that isn\'t a pour comes up behind', at: [26, 26, 6], f: wake(DOWN), shows: false },
  { what: '(that liquid)', at: [26, 27, 6], f: [0.25, 1, 0, 0], shows: false },
  { what: 'a wake a lone parcel left (half its way), a pour\'s parcel behind', at: [6, 24, 26], f: wake([0, -0.5, 0]), shows: false },
  { what: '(that parcel)', at: [6, 25, 26], f: PARCEL, shows: true },
  { what: 'a pour\'s wake whose next parcel is past JOIN_REACH', at: [26, 22, 26], f: wake(DOWN), shows: false },
  { what: '(that parcel)', at: [26, 22 + JOIN_REACH + 1, 26], f: PARCEL, shows: true },
  { what: 'a slanting pour\'s wake (the reach rounded along its way)', at: [16, 22, 20], f: wake([0.6, -0.8, 0]), shows: true },
  { what: '(its parcel, three cells back)', at: [14, 24, 20], f: PARCEL, shows: true },
  { what: 'the other copy\'s parcel', at: [16, 28, 16], f: PARCEL, copy: 0, shows: false },
];
test('jet', async () => {
  const out = { checks: [] };
  const { sim, derived, dispose } = await h.make(32);
  let aer = null;
  try {
    const g = sim.g;
    h.scene(sim, 'pool');
    for (let i = 0; i < 4; i++) sim.step();
    sim.incremental = false;
    for (let i = 0; i < SETTLE; i++) derived.updateBricks();   // the EMA at its fixed point
    const before = await derived.read();
    aer = fakeAeration(sim, JET_RECORDS, 1);
    sim.attachAeration(aer);
    derived.updateBricks();
    const r = await derived.read();
    // the twin agrees with what each record says it is
    const twin = jetTwin(g, JET_RECORDS, aer.cur);
    const wrong = JET_RECORDS.filter((rec) => twin(rec.at) !== rec.shows);
    check(out, `the JS twin: ${JET_RECORDS.filter((rec) => rec.shows).length} records show, ${JET_RECORDS.filter((rec) => !rec.shows).length} don't`,
      !wrong.length, wrong.map((rec) => rec.what).join('; '));
    // the EMA at every cell: a pour at full liquid occupancy at once, every other cell as it was
    const ema = words(r.ema), ema0 = words(before.ema);
    let bad = 0, shown = 0;
    const firstBad = [];
    for (let z = 0; z < g.nz; z++)
      for (let y = 0; y < g.ny; y++)
        for (let x = 0; x < g.nx; x++) {
          const s = cellSlot(g, x, y, z), shows = twin([x, y, z]);
          if (shows) shown++;
          const want = shows ? 255 : ema0[s] & 255;
          if ((ema[s] & 255) !== want) {
            bad++;
            if (firstBad.length < 4) firstBad.push(`${x},${y},${z}: ${ema[s] & 255} (want ${want})`);
          }
        }
    check(out, `EMA liquid occupancy == the JS twin at every cell (255 at the ${shown} that show, unchanged elsewhere)`,
      !bad && shown === JET_RECORDS.filter((rec) => rec.shows && (rec.copy ?? 1) === 1).length, `${bad} cells: ${firstBad.join('; ')}`);
    // the boost: a pour's cell in the air counts as current liquid, so it is boosted (thin mask x)
    const texel = (at) => 4 * (at[0] + g.nx * (at[1] + g.ny * at[2]));
    const thinX = (t, at) => t.fieldThin[texel(at)];
    const lone = JET_RECORDS.filter((rec) => (rec.copy ?? 1) === aer.cur && rec.shows);
    check(out, `boost: the ${lone.length} cells that show are boosted (thin mask x > 0; 0 before)`,
      lone.every((rec) => thinX(r, rec.at) !== 0 && thinX(before, rec.at) === 0),
      lone.map((rec) => `${rec.what}: ${thinX(before, rec.at)} → ${thinX(r, rec.at)}`).join('; '));
    // the thin mask's y and z are the molten and granular channels' alone now (no pour in them)
    const jetYZ = JET_RECORDS.filter((rec) => r.fieldThin[texel(rec.at) + 1] || r.fieldThin[texel(rec.at) + 2]);
    check(out, 'thin mask y, z: nothing at the records (they carry no pour)', !jetYZ.length, jetYZ.map((rec) => rec.what).join('; '));
    // the brick map: the thin bit reads every cubic channel's mask, liquid's (x) among them
    const bw = words(r.brick), bw0 = words(before.brick);
    const info = (w, at) => w[4 * brickIdOf(g, ...at.map((v) => Math.floor(v / BRICK))) + 3];
    const bricks = lone.map((rec) => ({ rec, was: unpackBrickInfo(info(bw0, rec.at)), now: unpackBrickInfo(info(bw, rec.at)) }));
    check(out, 'brick map: the bricks of the cells that show were empty and now hold matter with the thin bit',
      bricks.every((q) => !q.was.matter && q.now.matter && (q.now.bits & BRICK_INFO.THIN)),
      bricks.map((q) => `${q.rec.what}: ${JSON.stringify(q.was)} → ${JSON.stringify(q.now)}`).join('; '));
    // the copy: read from the other copy, its parcel shows (boosted) and this copy's records don't
    aer.cur = 0;
    derived.updateBricks();
    const c0 = await derived.read();
    const decoy = JET_RECORDS.find((rec) => rec.copy === 0), first = JET_RECORDS[0];
    check(out, 'the current copy decides (cur = 0 shows the other copy\'s parcel, and not this one\'s)',
      thinX(c0, decoy.at) !== 0 && thinX(c0, first.at) === 0 && thinX(r, decoy.at) === 0 && thinX(r, first.at) !== 0,
      `cur 1: ${thinX(r, decoy.at)}, ${thinX(r, first.at)}; cur 0: ${thinX(c0, decoy.at)}, ${thinX(c0, first.at)}`);
    // off: detached, no pour is boosted any more
    sim.attachAeration(null);
    derived.updateBricks();
    const off = await derived.read();
    check(out, 'detached: no pour left in the thin mask', lone.every((rec) => thinX(off, rec.at) === 0) && thinX(off, decoy.at) === 0);
  } finally { aer?.dispose(); dispose(); }
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
 * Two simulations of the same scene, one incremental and one full (a full
 * frame ages every brick to 0, so one simulation switching modes would time
 * its incremental chunks over everything), stepped alike, their chunks
 * alternating A B B A.
 * @param {{ sizes?: number[], scenes?: string[], frames?: number, steps?: number, chunks?: number, warm?: number }} [opts]
 */
async function bench({ sizes = [32, 64], scenes = ['lab', 'volcano', 'pile'], frames = 6, steps = 2, chunks = 2, warm = 8 } = {}) {
  const out = { gpu: gpu.adapterInfo, timestamps: gpu.timing.supported, grids: [] };
  for (const n of sizes) {
    const modes = { incremental: await h.make(n), full: await h.make(n) };
    modes.full.sim.incremental = false;
    const grid = { n, scenes: [] };
    try {
      for (const scene of scenes) {
        // each: the scene running, then settled (the load rebuilt every brick: that ages out)
        for (const { sim, derived } of Object.values(modes)) {
          sim.origin.set(0, 0, 0);
          h.scene(sim, scene);
          sim.frame = 0;
          for (let i = 0; i < warm; i++) sim.step();
          for (let i = 0; i < SETTLE; i++) derived.updateBricks();
        }
        const rows = { incremental: [], full: [] };
        for (let c = 0; c < chunks; c++) {
          for (const mode of c % 2 ? ['full', 'incremental'] : ['incremental', 'full']) {
            rows[mode].push(await timeChunk(modes[mode].sim, modes[mode].derived, frames, steps));
          }
        }
        const l = await modes.incremental.derived.readLists();
        const res = { scene, bricks: modes.incremental.sim.g.nbricks, lists: { ema: l.ema, fields: l.fields, work: l.work }, modes: {} };
        for (const [mode, r] of Object.entries(rows)) {
          const kernels = {};
          for (const k of DERIVED_KERNELS) { const xs = r.map((x) => x.per[k]).filter((x) => x !== undefined); if (xs.length) kernels[k] = median(xs); }
          res.modes[mode] = { gpuMsPerFrame: median(r.map((x) => x.derived)), wallMsPerFrame: median(r.map((x) => x.wall)), kernels };
        }
        grid.scenes.push(res);
        log(`${n}³ ${scene}: lists ${l.ema}/${l.fields}/${l.work} of ${res.bricks}; derived GPU ms/frame incremental ${res.modes.incremental.gpuMsPerFrame.toFixed(2)}, full ${res.modes.full.gpuMsPerFrame.toFixed(2)}`);
      }
    } finally { for (const m of Object.values(modes)) m.dispose(); }
    out.grids.push(grid);
  }
  return out;
}
test('bench', bench);

log('derived-check page ready');
ready();
