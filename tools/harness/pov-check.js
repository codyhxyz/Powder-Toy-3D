// The first person's harness page (src/pov/gpu.js; docs/webgpu.md G2, U11):
// its edits, probes, the exact transfer, the laser and the NPCs' cell
// readback on a Simulation of this page's device, no app. tools/pov-gpu-check.mjs
// drives it through window.__harness, one stage a browser:
//   probes    the body's probe, the hook's cells, the rounds' traces (rounds and lines of
//             sight, the floor), the burrower's face slices and the physgun's centre of mass,
//             each against the state read back (readState) or the scene as built
//   edits     every edit family once over a scene it acts on: it records one dispatch (two for
//             the strike, which reads its neighbours), changes something, changes nothing
//             outside its box, and reaches outside the grid nowhere (the debug prelude)
//   transfer  exact: a take takes the first `limit` qualifying cells in slot order and nothing
//             else, each item the cell's state bit for bit, the cells left air at ambient with
//             their seed and pressure; a put places the items in rank order; a breaking take
//             gives the debris; then the shovel's and bucket's engine (tools/transfer.js) on a
//             stepping world, transfers in flight across steps: grid + loads = what there was,
//             per element
//   laser     the reach comes back through the ring and matches a JS walk of the beam (stopped
//             by WALL, run out of energy in rock); the apply ran from the reach kernel's
//             indirect args with no read in between (a readState recorded right after the shot
//             shows the bore); nothing outside the beam's box changes
//   cells     readCells (src/pov/ai/world.js) against readState: id and temperature code per
//             cell at its atlas texel, the codec's rounding; the pool's bound (null when every
//             buffer is out) and release
//   wands     the wands' world (src/pov/wands/world.js): every effect, the batch bound, traces
//             and clearance (scripts/check-wand-world.mjs's checks on WebGPU)
//   look      the wands' TSL draws (the spells' cores, shells and beams; the gem and its halo)
//             compile through gpu.three.prepare and draw what the GLSL drew
//   recipes   every preset wand cast on a small world, its effects in the cells
//             (scripts/check-wand-recipes.mjs's checks on WebGPU)
//   budget:pov  what each costs in gpu.stats (tools/budgets/pov.mjs)
//   budget:povFrame  a body's frame, wading, and one with a kick (tools/budgets/pov.mjs)

import { boot, ready, test, log, measure } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { E, ELEMENTS, K } from '/src/elements.js';
import { PHYS as SIM_PHYS } from '/src/physics.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { povGpu, preparePov, POV_EDITS, toolPass } from '/src/pov/gpu.js';
import { PROBE, PROBE_CELLS, PROBE_OUTSIDE } from '/src/shaders/povBody.js';
import { CELLS_MAX } from '/src/shaders/povKick.js';
import { TRACE, TRACE_ROUND, TRACE_SIGHT, TRACE_FACE_FLOOR, TRACE_MISS } from '/src/shaders/povTrace.js';
import { BURROW, LASER } from '/src/shaders/povBore.js';
import { axeFrag, flamerFrag, flameBox, FLAMER, PHYS, PHYS_MODE, BLAST, ROCKET } from '/src/shaders/povTools.js';
import { TRANSFER_SLOTS, TRANSFER_TAKE, TRANSFER_PUT } from '/src/shaders/transfer.js';
import { WAND_EFFECTS, WAND_COMMANDS } from '/src/shaders/wands.js';
import { createTransfer, Load, cellsNear } from '/src/pov/tools/transfer.js';
import { readCells } from '/src/pov/ai/world.js';
import { decodeTempCode, TEXEL_BYTES } from '/src/net/codec.js';
import { ELEC, SPARK_BORN, CONDUCTS, packSpark, sparkOf } from '/src/electricity.js';

const h = await boot({ label: 'pov-check' });
const gpu = h.gpu;

const check = (out, name, ok, detail = '') => { out.checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) }); return ok; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const breakInto = (id) => (ELEMENTS[id].breakInto ? E[ELEMENTS[id].breakInto] : -1);
const kindOf = (id) => ELEMENTS[id].kind;

// Math.random from a seed (mulberry32, as tools/regress.mjs), so scenes repeat
function seed(s) {
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A simulation, its pipelines and its POV kernels built (debug: the edits'
// out-of-grid reads are counted, I2.8).
async function make(n, opts = {}) {
  const [nx, ny, nz] = Array.isArray(n) ? n : [n, n, n];
  const sim = new Simulation(gpu, nx, ny, nz, { debug: true, ...opts });
  await sim.ready;
  const t0 = performance.now();
  await preparePov(sim);
  log(`pov kernels for ${nx}×${ny}×${nz}: ${Math.round(performance.now() - t0)} ms`);
  return sim;
}
// Loads a scene built on the CPU: fill(set, g), set(x, y, z, id, { temp, vel, pressure, ctype }).
function load(sim, fill, s = 12345) {
  seed(s);
  const g = sim.g, [A, B] = sim.blankState();
  const set = (x, y, z, id, { temp, vel, pressure, ctype = 0 } = {}) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id; A[i + 1] = temp ?? e.temp; A[i + 2] = e.life; A[i + 3] = ctype + Math.random() * SEED_MAX;
    if (vel) B.set(vel, i);
    if (pressure !== undefined) B[i + 3] = pressure;
  };
  fill(set, g);
  sim.load(A, B);
}
const box = (set, lo, hi, id, extra) => {
  for (let x = lo[0]; x < hi[0]; x++) for (let y = lo[1]; y < hi[1]; y++) for (let z = lo[2]; z < hi[2]; z++) set(x, y, z, id, extra);
};
// The state as it is after what's recorded: atlas-order A and B, and accessors.
async function state(sim) {
  const [A, B] = await sim.readState(), g = sim.g;
  const at = (x, y, z) => cellTexel(g, x, y, z) * 4;
  return {
    A, B, g, at,
    id: (x, y, z) => Math.round(A[at(x, y, z)]),
    a: (x, y, z) => Array.from(A.subarray(at(x, y, z), at(x, y, z) + 4)),
    b: (x, y, z) => Array.from(B.subarray(at(x, y, z), at(x, y, z) + 4)),
    count() {
      const n = {};
      for (let i = 0; i < A.length; i += 4) { const id = Math.round(A[i]); n[id] = (n[id] ?? 0) + 1; }
      return n;
    },
  };
}
// The cells whose state differs between two reads (bit for bit), as [x, y, z].
function changed(s0, s1) {
  const out = [], g = s0.g;
  const a0 = new Uint32Array(s0.A.buffer, s0.A.byteOffset, s0.A.length), a1 = new Uint32Array(s1.A.buffer, s1.A.byteOffset, s1.A.length);
  const b0 = new Uint32Array(s0.B.buffer, s0.B.byteOffset, s0.B.length), b1 = new Uint32Array(s1.B.buffer, s1.B.byteOffset, s1.B.length);
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    const i = s0.at(x, y, z);
    for (let k = 0; k < 4; k++) if (a0[i + k] !== a1[i + k] || b0[i + k] !== b1[i + k]) { out.push([x, y, z]); break; }
  }
  return out;
}
const inBox = (c, lo, hi) => c.every((v, k) => v >= lo[k] && v <= hi[k]);
const clip = (sim, { lo, hi }) => {
  const n = [sim.g.nx, sim.g.ny, sim.g.nz];
  return { lo: lo.map((v) => Math.max(0, Math.floor(v))), hi: hi.map((v, k) => Math.min(n[k] - 1, Math.floor(v))) };
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const vec = (v) => `(${v.map((x) => +x.toFixed(4)).join(', ')})`;

// ---------------------------------------------------------------- probes
test('stage:probes', async ({ size = 32 } = {}) => {
  const out = { checks: [], ms: {} };
  const sim = await make(size);
  const pov = povGpu(sim);
  try {
    // rock floor, a sand ball, a water pool, a rock wall, hot and cold patches, a WALL block
    load(sim, (set, g) => {
      box(set, [0, 0, 0], [g.nx, 3, g.nz], E.ROCK);
      box(set, [8, 6, 4], [12, 15, 13], E.WATER, { temp: 35 });
      box(set, [20, 6, 4], [23, 15, 21], E.ROCK);
      box(set, [3, 3, 3], [7, 7, 7], E.SAND, { temp: 250, pressure: 3.5 });
      box(set, [24, 3, 24], [28, 8, 28], E.WALL);
      box(set, [12, 20, 10], [15, 23, 13], E.SAND, { vel: [0.25, -0.5, 0], pressure: -2 });
      box(set, [26, 22, 3], [30, 26, 7], E.SAND);   // the physgun's: nothing else within its reach
      // a metal wire in the body's box: a full spark, a weaker one, and two cells at rest (no spark)
      set(8, 4, 15, E.METAL, { ctype: packSpark(SPARK_BORN, ELEC.SPARK_V) });
      set(9, 4, 15, E.METAL, { ctype: packSpark(SPARK_BORN, 2) });
      set(10, 4, 15, E.METAL, { ctype: packSpark(ELEC.SPARK_REST, ELEC.SPARK_V) });
      set(11, 4, 15, E.METAL);
    });
    const S = await state(sim);

    // the body's probe: a 16×32×16 box, partly outside the grid
    const boxLo = [-4, -2, 2];
    const probe = pov.probe('povProbe', { boxLo });
    check(out, 'body probe: issued (its kernel built by prepare)', probe);
    const f = new Float32Array(await probe);
    let bad = 0, firstBad = '', outside = 0, sparked = 0;
    for (let i = 0; i < PROBE_CELLS; i++) {
      const x = boxLo[0] + (i % PROBE.X), z = boxLo[2] + (Math.floor(i / PROBE.X) % PROBE.Z), y = boxLo[1] + Math.floor(i / (PROBE.X * PROBE.Z));
      const o = Array.from(f.subarray(i * 4, i * 4 + 4));
      let want;
      if (x < 0 || y < 0 || z < 0 || x >= S.g.nx || y >= S.g.ny || z >= S.g.nz) { want = [PROBE_OUTSIDE, SIM_PHYS.AMBIENT, 0, 0]; outside++; }
      else want = [S.id(x, y, z), S.a(x, y, z)[1], S.b(x, y, z)[3], sparkOf(S.id(x, y, z), S.a(x, y, z)[3])];   // (w: electricity.js cellSpark of the cell read back)
      if (want[3] > 0) sparked++;
      // (the spark is a quotient: f32 division, within an ulp of the JS one rounded)
      if (o.some((v, k) => (k === 3 ? Math.abs(v - want[3]) > 1e-6 : v !== Math.fround(want[k])))) { bad++; firstBad ||= `(${x},${y},${z}) got ${vec(o)} want ${vec(want)}`; }
    }
    check(out, `body probe: ${PROBE_CELLS} cells = readState's id, T, pressure and spark (${outside} outside the grid read as OUTSIDE at ambient, ${sparked} sparked)`,
      bad === 0 && sparked === 2 && CONDUCTS[E.METAL], `${bad} differ; first ${firstBad}; ${sparked} sparked`);

    // the hook's cells: what a few cells hold (state A), outside → −1
    const cells = [[21, 8, 10, 0], [9, 10, 8, 0], [5, 5, 5, 0], [-1, 4, 4, 0], [31, 31, 31, 0]];
    const hook = new Float32Array(await pov.probe('povCells', { cells, count: cells.length }));
    const hookOk = cells.every(([x, y, z], i) => {
      const got = Array.from(hook.subarray(i * 4, i * 4 + 4));
      const want = x < 0 ? [-1, -1, -1, -1] : S.a(x, y, z);
      return got.every((v, k) => v === Math.fround(want[k]));
    });
    check(out, `hook cells: ${cells.length} cells' state A (one outside: −1), of ${CELLS_MAX} slots`, hookOk, Array.from(hook.subarray(0, cells.length * 4)).join(','));

    // the rounds' traces: a round stops at water, a line of sight passes it and stops at rock,
    // a round into the rock wall, one down to the floor below an empty column, one idle, one clear
    const starts = Array.from({ length: TRACE.ROUNDS }, () => [0, 0, 0, 0]), ends = starts.map(() => [0, 0, 0, 0]);
    starts[0] = [2.5, 10.5, 8.5, TRACE_ROUND]; ends[0] = [30.5, 10.5, 8.5, 0];
    starts[1] = [2.5, 10.5, 8.5, TRACE_SIGHT]; ends[1] = [30.5, 10.5, 8.5, 0];
    starts[2] = [2.5, 10.5, 16.5, TRACE_ROUND]; ends[2] = [30.5, 10.5, 16.5, 0];
    starts[3] = [16.5, 3.5, 28.5, TRACE_ROUND]; ends[3] = [16.5, -2.5, 28.5, 0];   // the floor is y = 0... but the rock floor is at y < 3
    starts[4] = [16.5, 28.5, 28.5, TRACE_ROUND]; ends[4] = [16.5, 40.5, 28.5, 0];   // up and out through the top: clear
    const tr = new Float32Array(await pov.probe('povTrace', { starts, ends }));
    const row = (r, i) => Array.from(tr.subarray((r * TRACE.ROUNDS + i) * 4, (r * TRACE.ROUNDS + i) * 4 + 4));
    const same = (a, b, eps = 1e-4) => a.every((v, k) => Math.abs(v - b[k]) <= eps);
    check(out, 'trace: a round stops at the water (struck cell, its +x face, the air before it, entry and share)',
      same(row(0, 0), [8, 10, 8, 1]) && same(row(1, 0), [7, 10, 8, E.WATER]) && same(row(2, 0), [8, 10.5, 8.5, 5.5 / 28]),
      `${vec(row(0, 0))} ${vec(row(1, 0))} ${vec(row(2, 0))}`);
    check(out, 'trace: a line of sight passes the water and stops at the rock',
      same(row(0, 1), [20, 10, 8, 1]) && same(row(1, 1), [19, 10, 8, E.ROCK]) && same(row(2, 1), [20, 10.5, 8.5, 17.5 / 28]),
      `${vec(row(0, 1))} ${vec(row(1, 1))} ${vec(row(2, 1))}`);
    check(out, 'trace: a round into the rock wall', same(row(0, 2), [20, 10, 16, 1]) && same(row(1, 2), [19, 10, 16, E.ROCK]),
      `${vec(row(0, 2))} ${vec(row(1, 2))}`);
    // the rock floor (y < 3) stops the downward round at y = 2, entered across its top face (-y step: face 2)
    check(out, 'trace: a round down onto the rock floor (its top face)', same(row(0, 3), [16, 2, 28, 2]) && same(row(1, 3), [16, 3, 28, E.ROCK]) && same(row(2, 3), [16.5, 3, 28.5, 0.5 / 6]),
      `${vec(row(0, 3))} ${vec(row(1, 3))} ${vec(row(2, 3))}`);
    check(out, 'trace: out through the top is clear', row(0, 4)[3] === TRACE_MISS, vec(row(0, 4)));
    check(out, 'trace: an idle thread answers a miss', row(0, 5)[3] === TRACE_MISS, vec(row(0, 5)));
    void TRACE_FACE_FLOOR;

    // the burrower's face: slices ahead of a head looking +x at the rock wall (x 20..22) from x = 14.5
    const head = [14.5, 10.5, 12.5], dir = [1, 0, 0];
    const bp = new Float32Array(await pov.probe('povBurrowProbe', { head, dir }));
    let burrowOk = true, burrowDetail = '', burrowSolids = 0;
    const span = Math.ceil(BURROW.RADIUS) + 1;
    for (let k = 0; k < BURROW.PROBE_AHEAD; k++) {
      const s = Array.from(bp.subarray(k * 4, k * 4 + 4));
      // the slice: the cells whose centres lie within half a cell of its plane and RADIUS of the axis
      const c = head.map((v, i) => v + dir[i] * (k + 0.5)), ci = c.map(Math.floor);
      let solids = 0;
      for (let dz = -span; dz <= span; dz++) for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        const q = [ci[0] + dx, ci[1] + dy, ci[2] + dz], d = q.map((v, i) => v + 0.5 - c[i]);
        const along = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
        if (Math.abs(along) > 0.5 || Math.hypot(...d.map((v, i) => v - along * dir[i])) > BURROW.RADIUS) continue;
        if (q.every((v) => v >= 0 && v < size) && S.id(...q) === E.ROCK) solids++;
      }
      burrowSolids += solids;
      const wantId = solids ? E.ROCK : -1;
      if (s[3] !== solids || s[2] !== wantId || s[1] !== 0) { burrowOk = false; burrowDetail += ` k${k}: ${vec(s)} want solids ${solids} id ${wantId};`; }
    }
    burrowOk &&= burrowSolids > 0;
    check(out, `burrow probe: ${BURROW.PROBE_AHEAD} slices: the rock wall's disc cells and nearest id where it starts`, burrowOk, burrowDetail);

    // the physgun's centre of mass: held at the sand cube's centre (28, 24, 5), the weights are symmetric
    const comBuf = gpu.createBuffer({ label: 'pov-check com', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    check(out, 'physgun COM: issued', pov.com(comBuf, [28, 24, 5]));
    const com = new Float32Array(await gpu.readback.buffer(comBuf, 0, 16));
    check(out, 'physgun COM: the held cube\'s centre, its weight > 0', near(com[0], 28, 1e-3) && near(com[1], 24, 1e-3) && near(com[2], 5, 1e-3) && com[3] > 0, vec(Array.from(com)));
    comBuf.destroy();

    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- edits
// One edit of each family over a scene it acts on (values as their callers
// give them), each against the state before it.
test('stage:edits', async ({ size = 32 } = {}) => {
  const out = { checks: [], ms: {} };
  const sim = await make(size);
  const pov = povGpu(sim);
  try {
    const scene = () => load(sim, (set, g) => {
      box(set, [0, 0, 0], [g.nx, 2, g.nz], E.ROCK);
      box(set, [4, 2, 4], [12, 10, 12], E.WATER, { temp: 60 });
      box(set, [14, 2, 4], [20, 8, 10], E.SAND);
      box(set, [22, 2, 4], [28, 12, 10], E.WOOD);
      box(set, [14, 2, 14], [26, 12, 26], E.ROCK);
      box(set, [4, 2, 16], [10, 8, 22], E.SAND);
      box(set, [26, 2, 14], [30, 10, 15], E.GLASS);
    });
    const cases = [
      ['povCouple', 'the body pushes the water it stands in', () => {
        const lo = [6, 3, 6], hi = [8, 8, 8];
        return [sim.touchCentres(lo, hi), { vel: [0.3, 0, 0], frame: 1, lo, hi, pushFluid: 0.4, pushPowder: 0.2, ahead: [1, 0], lift: 0.2, only: -1 }];
      }, (d) => d.some(([x, y, z]) => x >= 4 && x < 12 && y >= 2 && y < 10)],
      ['povField', 'a shell cools the hot water around the body', () => {
        const c = [8, 6, 8];
        return [sim.touchCentres(c.map((x) => x - 4), c.map((x) => x + 4)), { center: c, inner: 1, feet: [8, 2, 8], outer: 4, clear: 0, cool: 30, floor: 20, pressure: 0 }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s1.a(x, y, z)[1] < s0.a(x, y, z)[1])],
      ['povKick', 'a kick breaks the glass pane into flying shards', () => {
        const c = [27.5, 5.5, 14.5], r = 2;
        return [sim.touchCentres(c.map((x) => x - r), c.map((x) => x + r)), { center: c, shove: [0, 0.1, 0.6] }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.GLASS && s1.id(x, y, z) === breakInto(E.GLASS) && s1.b(x, y, z)[2] > 0)],
      ['povBlow', 'an axe blow chips the wood', () => {
        const c = [22.5, 6.5, 6.5], r = 3;
        return [sim.touchCentres(c.map((x) => x - r), c.map((x) => x + r)), { ...axeFrag.values, center: c, dir: [1, 0, 0] }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.WOOD && s1.id(x, y, z) !== E.WOOD)],
      ['povFlame', 'the flamer heats and lights what it reaches', () => {
        const nozzle = { x: 18.5, y: 9.5, z: 6.5 }, dir = { x: 1, y: 0, z: 0 }, reach = 3.5;
        return [sim.touchCentres(...flameBox(FLAMER, nozzle, dir, reach)), { ...flamerFrag.values, nozzle, dir, reach, dt: 1 / 60, frame: 1 }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s1.a(x, y, z)[1] > s0.a(x, y, z)[1] || s1.id(x, y, z) !== s0.id(x, y, z))],
      ['povPhysgun', 'the physgun takes hold of the sand (its COM in a buffer, GPU to GPU)', () => {
        const hold = [7, 5, 19];
        pov.com(this_com(), hold);
        return [sim.touchCentres(hold.map((x) => x - PHYS.RADIUS), hold.map((x) => x + PHYS.RADIUS)),
          { hold, carry: [0, 0, 0], steps: 4, gravity: sim.gravity, mode: PHYS_MODE.HOLD ?? 0, fling: [0, 0, 0] }, { bind: [{ buffer: this_com() }] }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s1.id(x, y, z) === E.SAND && s1.b(x, y, z).slice(0, 3).some((v) => v !== 0))],
      ['povBlast', 'the blast pushes the sand down its cone', () => {
        const muzzle = [17, 12, 7], dir = [0, -1, 0], reach = 8, pad = BLAST.RADIUS0 + BLAST.SPREAD * reach;
        return [sim.touchCentres(muzzle.map((x, i) => Math.min(x, x + dir[i] * reach) - pad), muzzle.map((x, i) => Math.max(x, x + dir[i] * reach) + pad)),
          { muzzle, reach, dir }];
      }, (d) => d.length > 0],
      ['povRocket', 'a rocket blows a crater in the rock', () => {
        const c = [20, 12.5, 20], r = ROCKET.PULSE_RADIUS;
        return [sim.touchCentres(c.map((x) => x - r), c.map((x) => x + r)), { center: c, frame: 1 }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.ROCK && s1.id(x, y, z) !== E.ROCK)],
      ['povBurrow', 'the burrower cuts into the rock', () => {
        const nose0 = [14.2, 7.5, 20.5], nose1 = [15.2, 7.5, 20.5], dir = [1, 0, 0];
        const pad = BURROW.RADIUS + BURROW.CONVEY_PAD + BURROW.APRON + 1;
        const lo = [Math.floor(12 - pad), Math.floor(7.5 - pad), Math.floor(20.5 - pad)], hi = [Math.floor(15.2 + pad), Math.floor(7.5 + pad), Math.floor(20.5 + pad)];
        const path = Array.from({ length: BURROW.PATH_MAX }, () => [0, 0, 0, 0]);
        path[0] = [12, 7.5, 20.5, 1]; path[1] = [15.2, 7.5, 20.5, 1];
        return [sim.touchCentres(lo, hi), { nose0, nose1, dir, cut: 1, path, pathN: 2, lo, hi }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.ROCK && s1.id(x, y, z) !== E.ROCK)],
      ['povStrike', 'a round breaks the rock it strikes (two phases)', () => {
        const entry = [14, 8.5, 20.5], dir = [1, 0, 0], depth = 4;
        const lo = [13, 7, 19], hi = [19, 10, 22];
        return [sim.touch(lo, hi), { entry, dir, energy: 200, depth, lo, hi }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.ROCK && s1.id(x, y, z) !== E.ROCK)],
      ['povWand', 'a wand\'s dig breaks the rock to its debris', () => {
        const commands = Array.from({ length: 4 * WAND_COMMANDS }, () => [0, 0, 0, 0]);
        commands[0] = [20.5, 11.5, 20.5, 1.5];   // centre, radius (on the rock's top)
        commands[WAND_COMMANDS] = [WAND_EFFECTS.dig, 100, 0, 20];   // effect, power, id, temperature
        return [sim.touchCentres([19, 10, 19], [22, 13, 22]), { count: 1, lo: [19, 10, 19], hi: [22, 13, 22], commands }];
      }, (d, s0, s1) => d.some(([x, y, z]) => s0.id(x, y, z) === E.ROCK && s1.id(x, y, z) === E.STONE)],
    ];
    let comBuf = null;
    const this_com = () => (comBuf ??= gpu.createBuffer({ label: 'pov-check com', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    const families = new Set(Object.keys(POV_EDITS));
    for (const [name, what, make_, effect] of cases) {
      families.delete(name);
      scene();
      const s0 = await state(sim);
      const dbg0 = await sim.readDebug();
      const [boxIn, values, opts] = make_();
      let ok = false;
      const m = await measure(gpu, () => { ok = pov.edit(name, boxIn, values, opts); });
      const s1 = await state(sim);
      const d = changed(s0, s1);
      const b = clip(sim, boxIn);
      const outside = d.filter((c) => !inBox(c, b.lo, b.hi));
      // (a two-phase edit's first use on a sim allocates the sim's scratch, a 32-byte slot per cell of its bricks)
      const twoPhase = POV_EDITS[name].reads === 'neighbours', want = twoPhase ? 2 : 1;
      const nb = [0, 1, 2].map((k) => (b.hi[k] >> 2) - (b.lo[k] >> 2) + 1).reduce((x, y) => x * y);
      check(out, `${name}: ${what}`, ok && effect(d, s0, s1), `recorded ${ok}, ${d.length} cells changed`);
      check(out, `${name}: ${want} dispatch${want > 1 ? 'es' : ''}, nothing allocated${twoPhase ? ' (but the sim\'s scratch, once)' : ''}`,
        m.dispatches === want && (m.bytesAllocated === 0 || (twoPhase && m.bytesAllocated <= nb * 64 * 32)), JSON.stringify(m));
      check(out, `${name}: nothing changes outside its box ${vec(b.lo)}–${vec(b.hi)}`, outside.length === 0, `${outside.length} outside, e.g. ${outside.slice(0, 3).map(vec).join(' ')}`);
      check(out, `${name}: no out-of-grid reads`, (await sim.readDebug()) === dbg0);
      // the box is big enough: the same edit over the whole grid gives the same state (the update's
      // own test picks nothing outside the box its caller works out)
      scene();
      const [, valuesAll, optsAll] = make_();
      pov.edit(name, { lo: [0, 0, 0], hi: [sim.g.nx - 1, sim.g.ny - 1, sim.g.nz - 1] }, valuesAll, optsAll);
      const sAll = await state(sim);
      const differ = changed(s1, sAll);
      check(out, `${name}: its box holds everything it changes (over the whole grid: the same state)`, differ.length === 0, `${differ.length} cells differ, e.g. ${differ.slice(0, 3).map(vec).join(' ')}`);
    }
    comBuf?.destroy();
    check(out, 'every edit family checked', families.size === 0, [...families].join(', '));
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- transfer
// The CPU's model of a transfer (shaders/transfer.js): which slots act.
function modelTransfer(S, { cells, limit, mode, kinds = 0, breaks = 0 }) {
  const acts = [];
  let rank = 0;
  for (let i = 0; i < cells.length; i++) {
    const [x, y, z, want] = cells[i];
    if (x < 0 || y < 0 || z < 0 || x >= S.g.nx || y >= S.g.ny || z >= S.g.nz) { acts.push(-1); continue; }
    const id = S.id(x, y, z);
    let q;
    if (mode === TRANSFER_PUT) q = id === E.EMPTY;
    else q = id !== E.EMPTY && (want < 0 || id === want) && (kinds & (1 << kindOf(id))) !== 0 && (!breaks || breakInto(id) >= 0);
    acts.push(q && rank < limit ? rank : -1);
    if (q) rank++;
  }
  return acts;
}

test('stage:fungus', async () => {
  const sim = await make(32);
  const out = { checks: [] };
  try {
    load(sim, set => {
      set(4, 4, 4, E.FUNGUS, { temp: 31, ctype: 3 });
      set(5, 4, 4, E.ROCK, { temp: 45 });
    });
    const before = await state(sim);
    const engine = createTransfer({ getSim: () => sim });
    const pack = new Load(10);
    const cells = await engine.take(pack, { cells: [[4, 4, 4], [5, 4, 4]],
      kinds: [K.SOLID], breakDebris: true, maxHard: 100 });
    check(out, 'digging preserves fungus, temperature, life and damp/seed', cells[0].every((v, i) => v === before.a(4, 4, 4)[i]), cells[0]);
    check(out, 'rock still becomes debris', cells[1][0] === breakInto(E.ROCK));
    check(out, 'fungus is available in the pack', pack.totals()[E.FUNGUS] === 1);
    const dug = await state(sim);
    check(out, 'collected fungus leaves air', dug.id(4, 4, 4) === E.EMPTY);
    const placed = await engine.put(pack, { cells: [[8, 4, 4]], id: E.FUNGUS });
    const after = await state(sim);
    check(out, 'replanting restores the exact fungus cell', placed === 1 && after.a(8, 4, 4).every((v, i) => v === before.a(4, 4, 4)[i]));
    check(out, 'replanting consumes fungus exactly once', !pack.totals()[E.FUNGUS] && pack.count === 1);
    return out;
  } finally { sim.dispose(); }
});

test('stage:transfer', async ({ size = 32, frames = 30 } = {}) => {
  const out = { checks: [], ms: {} };
  const sim = await make(size);
  const pov = povGpu(sim);
  try {
    const scene = () => load(sim, (set, g) => {
      box(set, [0, 0, 0], [g.nx, 2, g.nz], E.WALL);
      box(set, [4, 2, 4], [12, 8, 12], E.SAND, { pressure: 1.25 });
      box(set, [16, 2, 4], [24, 8, 12], E.WATER, { temp: 30 });
      box(set, [4, 2, 16], [12, 8, 24], E.ROCK, { temp: 45 });
    });
    scene();
    const S0 = await state(sim);
    const f32 = (x) => Math.fround(x);
    const airT = sim.airT ?? SIM_PHYS.AMBIENT;

    // 1. a take: a list of sand, air and water cells, sand only (POWDER), the first 25 that qualify
    const cells = [];
    for (let i = 0; i < 60; i++) cells.push([4 + (i % 9), 2 + ((i * 7) % 8), 4 + ((i * 3) % 9), -1]);
    cells.push([18, 3, 5, -1], [-2, 3, 3, -1]);
    const takeParams = { count: cells.length, limit: 25, mode: TRANSFER_TAKE, kinds: 1 << K.POWDER, breaks: 0, vel: [0, 0, 0], cells, items: [] };
    // (a cell listed twice is the engine's to drop: the kernel's list here has none)
    const uniq = new Set(cells.map((c) => c.slice(0, 3).join()));
    check(out, 'take: the list has no cell twice', uniq.size === cells.length);
    const acts = modelTransfer(S0, takeParams);
    let m = null, answerP = null;
    m = await measure(gpu, () => { answerP = pov.transfer(takeParams); });
    const answer = new Float32Array(await answerP);
    const S1 = await state(sim);
    check(out, 'take: one dispatch', m.dispatches === 1, JSON.stringify(m));
    let bad = '';
    const taken = [];
    cells.forEach(([x, y, z], i) => {
      const o = Array.from(answer.subarray(i * 4, i * 4 + 4));
      if (acts[i] < 0) {
        if (o[0] !== -1) bad += ` slot ${i} acted;`;
        if (x >= 0 && x < 32 && (S1.a(x, y, z).join() !== S0.a(x, y, z).join() || S1.b(x, y, z).join() !== S0.b(x, y, z).join())) bad += ` slot ${i} cell changed;`;
        return;
      }
      const a0 = S0.a(x, y, z), b0 = S0.b(x, y, z);
      if (o.some((v, k) => v !== f32(a0[k]))) bad += ` slot ${i} item ${vec(o)} != cell ${vec(a0)};`;
      const a1 = S1.a(x, y, z), b1 = S1.b(x, y, z);
      const wantA = [E.EMPTY, f32(airT), 0, f32(a0[3] - Math.floor(a0[3]))], wantB = [0, 0, 0, b0[3]];
      if (a1.some((v, k) => v !== wantA[k]) || b1.some((v, k) => v !== wantB[k])) bad += ` slot ${i} left ${vec(a1)} ${vec(b1)};`;
      taken.push(o);
    });
    const d1 = changed(S0, S1);
    check(out, `take: the first ${takeParams.limit} qualifying slots act, in slot order, each item the cell's state A bit for bit, the cell left air at ambient (seed and pressure kept)`,
      !bad && taken.length === 25, bad.slice(0, 600) || `${taken.length} taken`);
    check(out, 'take: no other cell changes', d1.length === taken.length, `${d1.length} changed`);
    const c0 = S0.count(), c1 = S1.count();
    check(out, 'take: the grid lost exactly what came back (sand −25, air +25)', c1[E.SAND] === c0[E.SAND] - 25 && c1[E.EMPTY] === c0[E.EMPTY] + 25, `${c0[E.SAND]}→${c1[E.SAND]}`);

    // 2. a put: the items back into a list of air and occupied cells, at a velocity
    const putCells = [];
    for (let i = 0; i < 40; i++) putCells.push([14 + (i % 4), 9 + Math.floor(i / 16), 14 + (Math.floor(i / 4) % 4), -1]);
    putCells.splice(5, 0, [5, 3, 5, -1]);   // an occupied cell (sand): skipped
    const putParams = { count: putCells.length, limit: taken.length, mode: TRANSFER_PUT, kinds: 0, breaks: 0, vel: [0.25, 0, -0.5], cells: putCells, items: taken };
    const pacts = modelTransfer(S1, putParams);
    const pAnswer = new Float32Array(await pov.transfer(putParams));
    const S2 = await state(sim);
    bad = '';
    let placed = 0;
    putCells.forEach(([x, y, z], i) => {
      const r = pAnswer[i * 4];
      if (r !== pacts[i]) bad += ` slot ${i} rank ${r} want ${pacts[i]};`;
      if (pacts[i] < 0) return;
      placed++;
      const a2 = S2.a(x, y, z), b2 = S2.b(x, y, z), it = taken[pacts[i]];
      if (a2.some((v, k) => v !== it[k])) bad += ` slot ${i} holds ${vec(a2)} want ${vec(it)};`;
      if (b2[0] !== 0.25 || b2[1] !== 0 || b2[2] !== -0.5 || b2[3] !== S1.b(x, y, z)[3]) bad += ` slot ${i} B ${vec(b2)};`;
    });
    check(out, 'put: the empty cells take the items in rank order (an occupied cell skipped), at the velocity given, pressure kept', !bad && placed === taken.length, bad.slice(0, 600));
    const c2 = S2.count();
    check(out, 'put: the grid is back to what it held (per element)', Object.keys(c0).every((id) => c2[id] === c0[id]), JSON.stringify({ c0, c2 }));

    // 3. a breaking take of rock: each comes out as its debris (BREAKINTO), the grid loses the rock
    const rockCells = [];
    for (let i = 0; i < 16; i++) rockCells.push([4 + (i % 4), 5, 16 + Math.floor(i / 4), -1]);
    const bAnswer = new Float32Array(await pov.transfer({ count: 16, limit: 16, mode: TRANSFER_TAKE, kinds: 1 << K.SOLID, breaks: 1, vel: [0, 0, 0], cells: rockCells, items: [] }));
    const S3 = await state(sim);
    const debris = breakInto(E.ROCK);
    check(out, `breaking take: 16 rock cells come out as ${ELEMENTS[debris].key}, their temperature kept`,
      rockCells.every((c, i) => bAnswer[i * 4] === debris && bAnswer[i * 4 + 1] === f32(45) && S3.id(...c) === E.EMPTY), Array.from(bAnswer.subarray(0, 8)).join(','));
    const wantOnly = new Float32Array(await pov.transfer({ count: 4, limit: 4, mode: TRANSFER_TAKE, kinds: (1 << K.POWDER) | (1 << K.LIQUID), breaks: 0, vel: [0, 0, 0],
      cells: [[17, 3, 5, E.SAND], [17, 4, 5, E.WATER], [6, 3, 6, E.WATER], [6, 3, 7, E.SAND]], items: [] }));
    check(out, 'take with a wanted element: only that element (the water slot with SAND wanted is skipped)',
      wantOnly[0] === -1 && wantOnly[4] === E.WATER && wantOnly[8] === -1 && wantOnly[12] === E.SAND, Array.from(wantOnly).filter((_, i) => i % 4 === 0).join(','));

    // 4. the shovel's and bucket's engine (tools/transfer.js) on a stepping world: takes and puts in
    // flight across steps, then the grid plus the loads holds what there was, per element
    scene();
    for (let i = 0; i < 4; i++) sim.step();
    const before = (await state(sim)).count();
    for (let i = 0; i < 12; i++) sim.step();
    const control = (await state(sim)).count();
    check(out, 'control: 12 steps alone keep every element\'s count', Object.keys(before).every((id) => control[id] === before[id]), JSON.stringify({ before, control }));
    const engine = createTransfer({ getSim: () => sim });
    const shovel = new Load(400), bucket = new Load(400);
    const pending = [];
    seed(777);
    let issued = 0, took = 0, put = 0;
    for (let f = 0; f < frames; f++) {
      const r = () => 2 + Math.random() * 3;
      const at = (x0, x1, z0, z1) => ({ x: x0 + Math.random() * (x1 - x0), y: 2 + Math.random() * 8, z: z0 + Math.random() * (z1 - z0) });
      const ops = [
        () => engine.take(shovel, { cells: cellsNear(at(4, 12, 4, 12), r(), sim.g), kinds: [K.POWDER], limit: 30 }),
        () => engine.take(bucket, { cells: cellsNear(at(16, 24, 4, 12), r(), sim.g), kinds: [K.LIQUID], limit: 30 }),
        () => engine.put(shovel, { cells: cellsNear(at(4, 28, 14, 28), r(), sim.g), max: 20, vel: [0, -0.2, 0] }),
        () => engine.put(bucket, { cells: cellsNear(at(4, 28, 14, 28), r(), sim.g), max: 20, vel: [0.1, 0, 0] }),
      ];
      for (let k = 0; k < 2; k++) {
        const which = Math.floor(Math.random() * ops.length), p = ops[which]();
        if (p) {
          issued++;
          pending.push(p.then((r) => { if (which < 2 ? r.length : r) { if (which < 2) took++; else put++; } }));
        }
      }
      sim.step(); sim.step();
      await tick();
      // (in flight across three frames of steps, then landed: the puts need what the takes brought)
      if (f % 3 === 2) await Promise.all(pending);
    }
    await Promise.all(pending);
    for (let i = 0; i < 4; i++) sim.step();
    const after = (await state(sim)).count();
    const loads = {};
    for (const l of [shovel, bucket]) for (const [id, n] of Object.entries(l.totals())) loads[id] = (loads[id] ?? 0) + n;
    const ids = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(loads)]);
    const off = [...ids].filter((id) => Number(id) !== E.EMPTY && (after[id] ?? 0) + (loads[id] ?? 0) !== (before[id] ?? 0));
    check(out, `engine: ${issued} transfers over ${frames} stepping frames, grid + loads = what there was, per element (shovel ${shovel.count}, bucket ${bucket.count})`,
      off.length === 0 && shovel.reserved === 0 && shovel.out === 0 && bucket.reserved === 0 && bucket.out === 0,
      off.map((id) => `${ELEMENTS[id].key}: ${before[id] ?? 0} → ${after[id] ?? 0} + ${loads[id] ?? 0}`).join('; '));
    check(out, 'engine: the shovel holds only powders, the bucket only liquids',
      shovel.cells.every((c) => kindOf(Math.round(c[0])) === K.POWDER) && bucket.cells.every((c) => kindOf(Math.round(c[0])) === K.LIQUID));
    check(out, `engine: matter moved both ways (${issued} issued: ${took} takes landed, ${put} puts)`, took > 2 && put > 2, `shovel v${shovel.version}, bucket v${bucket.version}`);
    void TRANSFER_SLOTS;
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- laser
// The reach kernel's walk along the axis (shaders/povBore.js laserReach), in
// JS over the state read back: how far the beam gets and what stops it.
function laserReachJS(S, muzzle, dir) {
  const isGasLike = (id) => id === E.EMPTY || kindOf(id) === K.GAS;
  const proof = (id) => {
    const e = ELEMENTS[id];
    return kindOf(id) === K.SOLID && breakInto(id) < 0 && !((e.melt ?? 0) > 0) && !((e.ignite ?? 0) > 0);
  };
  const rd = dir.map((v) => (Math.abs(v) < 1e-6 ? 1e-6 : v));
  const istp = rd.map(Math.sign), tDelta = rd.map((v) => Math.abs(1 / v));
  const c = muzzle.map(Math.floor);
  const tMax = c.map((v, k) => (v + (rd[k] >= 0 ? 1 : 0) - muzzle[k]) / rd[k]);
  let E_ = LASER.ENERGY, tEnter = 0, entered = false;
  const n = [S.g.nx, S.g.ny, S.g.nz];
  for (let k = 0; k < LASER.STEPS_MAX; k++) {
    if (tEnter >= LASER.LENGTH) return { reach: LASER.LENGTH, stopId: -1 };
    const inGrid = c.every((v, i) => v >= 0 && v < n[i]);
    if (!inGrid) {
      if (c[1] < 0) return { reach: tEnter, stopId: E.WALL };
      if (entered) return { reach: LASER.LENGTH, stopId: -1 };
    } else {
      entered = true;
      const [id, T] = S.a(...c);
      const i = Math.round(id);
      if (!isGasLike(i)) {
        if (proof(i)) return { reach: tEnter, stopId: i };
        const cost = ELEMENTS[i].cap * Math.max(LASER.VAPOR_T - T, 0) * LASER.CORE_AREA;
        if (E_ < cost) return { reach: tEnter + E_ / cost, stopId: i };
        E_ -= cost;
      }
    }
    let ax = 2;
    if (tMax[0] <= tMax[1] && tMax[0] <= tMax[2]) ax = 0; else if (tMax[1] <= tMax[2]) ax = 1;
    tEnter = tMax[ax]; c[ax] += istp[ax]; tMax[ax] += tDelta[ax];
  }
  return { reach: Math.min(tEnter, LASER.LENGTH), stopId: -1 };
}

test('stage:laser', async ({ size = [128, 64, 64] } = {}) => {
  const out = { checks: [], ms: {} };
  const sim = await make(size);
  const pov = povGpu(sim);
  try {
    // a wood block then a WALL slab across the first shot; a metal block longer than the beam can melt
    // through for the second (about 70 cells of it at METAL's heat capacity)
    load(sim, (set, g) => {
      box(set, [0, 0, 0], [g.nx, 2, g.nz], E.ROCK);
      box(set, [20, 12, 22], [25, 30, 42], E.WOOD);
      box(set, [40, 12, 22], [44, 30, 42], E.WALL);
      box(set, [10, 40, 4], [126, 52, 16], E.METAL);
    });
    const shots = [
      { name: 'through the wood, stopped by WALL', muzzle: [4.5, 20.5, 32.5], dir: [1, 0, 0] },
      { name: 'into a long metal block until its energy runs out', muzzle: [4.5, 46.5, 10.5], dir: [1, 0, 0] },
      { name: 'at a slant through the wood and up out of the grid', muzzle: [6.3, 14.2, 30.7], dir: [0.8, 0.36, 0.48] },
    ];
    for (const s of shots) {
      const len = Math.hypot(...s.dir);
      s.dir = s.dir.map((v) => v / len);
      const S0 = await state(sim);
      const want = laserReachJS(S0, s.muzzle, s.dir);
      let shot = null;
      const m = await measure(gpu, () => { shot = pov.laser(s.muzzle, s.dir); });
      // the state read recorded right after the shot, before its reach is known on the CPU: the bore is already there
      const [got, S1] = await Promise.all([shot, state(sim)]);
      // (gpu.stats counts an indirect dispatch twice: Chrome validates its args with one of its own, B3;
      // the first shot on a device makes the laser's result ring)
      check(out, `laser ${s.name}: the shot returns at once (a promise), the reach and the apply, indirect`,
        shot instanceof Promise && m.dispatches === 3 && m.indirectDispatches === 1 && (m.bytesAllocated === 0 || s === shots[0]), JSON.stringify(m));
      check(out, `laser ${s.name}: reach ${got.reach.toFixed(3)} (JS ${want.reach.toFixed(3)}), stopped by ${got.stopId < 0 ? 'nothing' : ELEMENTS[got.stopId].key}`,
        near(got.reach, want.reach, 1e-3 * Math.max(1, want.reach)) && got.stopId === want.stopId, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
      const d = changed(S0, S1);
      // the core along the axis up to the reach: what was matter is vapour now (or the proof solid)
      let bored = 0, cored = 0;
      for (let t = 0.5; t < Math.min(got.reach, 120) - 0.5; t += 0.5) {
        const p = s.muzzle.map((v, k) => Math.floor(v + s.dir[k] * t));
        if (!p.every((v, k) => v >= 0 && v < [S0.g.nx, S0.g.ny, S0.g.nz][k])) continue;
        const id0 = S0.id(...p);
        if (id0 === E.EMPTY) continue;
        cored++;
        const id1 = S1.id(...p);
        if (id1 === E.FIRE || id1 === E.SMOKE || id1 === E.STEAM) bored++;
      }
      check(out, `laser ${s.name}: the matter on the axis up to the reach is vapour in the readState recorded right after the shot (${bored}/${cored})`, cored > 0 && bored === cored, `${bored}/${cored}`);
      // nothing beyond the axis box padded by the rim changes
      const end = s.muzzle.map((v, k) => v + s.dir[k] * got.reach), pad = LASER.RIM_RADIUS + 1;
      const lo = s.muzzle.map((v, k) => Math.floor(Math.min(v, end[k]) - pad)), hi = s.muzzle.map((v, k) => Math.floor(Math.max(v, end[k]) + pad));
      const outside = d.filter((c) => !inBox(c, lo, hi));
      check(out, `laser ${s.name}: ${d.length} cells changed, none outside the beam's box`, d.length > 0 && outside.length === 0, `${outside.length} outside`);
      // the indirect args the reach kernel wrote: one workgroup per brick of the box it wrote (fold()ed, B5),
      // and that box the axis to the reach padded by the rim, clipped to the grid (within a cell: f32)
      const [beamBytes, argBytes] = await Promise.all([gpu.readback.buffer(pov.d.beam, 0, 32), gpu.readback.buffer(pov.d.beamArgs, 0, 12)]);
      const beamI = new Int32Array(beamBytes), args = new Uint32Array(argBytes);
      const bLo = [beamI[0], beamI[1], beamI[2]], bHi = [beamI[4], beamI[5], beamI[6]];
      const nb = [0, 1, 2].map((k) => (bHi[k] >> 2) - (bLo[k] >> 2) + 1).reduce((x, y) => x * y);
      const fy = Math.max(1, Math.ceil(nb / 65535)), want3 = [Math.ceil(nb / fy), fy, 1];
      const N = [S0.g.nx, S0.g.ny, S0.g.nz];
      const boxNear = [0, 1, 2].every((k) => Math.abs(bLo[k] - Math.max(lo[k], 0)) <= 1 && Math.abs(bHi[k] - Math.min(hi[k], N[k] - 1)) <= 1);
      check(out, `laser ${s.name}: its apply's indirect args are the ${nb} bricks of the box the reach kernel wrote ${vec(bLo)}–${vec(bHi)}`,
        args[0] === want3[0] && args[1] === want3[1] && args[2] === 1 && boxNear, `args ${Array.from(args)} want ${want3}; box ${vec(bLo)}–${vec(bHi)} vs ${vec(lo)}–${vec(hi)}`);
    }
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- readCells
test('stage:cells', async ({ size = [64, 32, 48] } = {}) => {
  const out = { checks: [], ms: {} };
  const sim = await make(size);
  try {
    // every cell something, at temperatures over the codec's whole range (and past its ends), air at odd temperatures
    const ids = ELEMENTS.map((e, i) => i).filter((i) => i !== E.EMPTY && ELEMENTS[i].key && !ELEMENTS[i].tool);
    load(sim, (set, g) => {
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const r = Math.random();
        const T = r < 0.05 ? -300 + Math.random() * 200 : r < 0.1 ? 6000 + Math.random() * 3000 : -100 + Math.random() ** 2 * 6100;
        if (Math.random() < 0.2) set(x, y, z, E.EMPTY, { temp: T });
        else set(x, y, z, ids[Math.floor(Math.random() * ids.length)], { temp: T });
      }
    }, 4242);
    const S = await state(sim);
    let job = null;
    for (let i = 0; i < 40 && !job; i++) { job = readCells(null, sim); if (!job) await new Promise((r) => setTimeout(r, 50)); }   // (its kernel builds on first use)
    check(out, 'readCells: a capture once its kernel is built', job);
    const t0 = performance.now();
    const r = await job;
    out.ms.read = performance.now() - t0;
    const g = sim.g;
    check(out, 'readCells: g and dims are the sim\'s, bytes one texel a cell of the atlas', r.g === g && r.dims.join() === [g.nx, g.ny, g.nz].join() && r.bytes.length === g.width * g.height * TEXEL_BYTES);
    // the codec's rounding: code c holds [decode(c − ½), decode(c + ½)); allow f32 at the edges
    const lowEdge = (c) => (c <= 0 ? -Infinity : decodeTempCode(c - 0.5)), highEdge = (c) => (c >= 255 ? Infinity : decodeTempCode(c + 0.5));
    let badId = 0, badT = 0, first = '';
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const t = cellTexel(g, x, y, z) * TEXEL_BYTES;
      const id = S.id(x, y, z), T = id === E.EMPTY ? SIM_PHYS.AMBIENT : S.a(x, y, z)[1];
      const [b0, b1] = r.bytes.subarray(t, t + 4);   // (bytes 2 and 3: what a guest renders, the codec's; not the model's)
      if (b0 !== id) { badId++; first ||= `(${x},${y},${z}) id ${b0} want ${id}`; }
      const eps = 1e-4 * Math.abs(T) + 1e-3;
      if (!(T >= lowEdge(b1) - eps && T < highEdge(b1) + eps)) { badT++; first ||= `(${x},${y},${z}) T ${T} code ${b1} [${lowEdge(b1)}, ${highEdge(b1)})`; }
    }
    check(out, `readCells: ${g.slots} cells' element ids at their atlas texels = readState's`, badId === 0, `${badId} wrong; ${first}`);
    check(out, 'readCells: each temperature code is the codec\'s (air as ambient, clamped at the ends)', badT === 0, `${badT} wrong; ${first}`);
    // the pool: PACK_SLOTS captures at once, then null until one is released
    const more = [readCells(null, sim), readCells(null, sim)];
    const fourth = readCells(null, sim);
    check(out, 'readCells: null while every buffer is out (3 in flight)', more.every(Boolean) && fourth === null);
    const got = await Promise.all(more);
    r.release(r.bytes);
    const again = readCells(null, sim);
    check(out, 'readCells: a released buffer is used again', again !== null);
    (await again).release();
    for (const x of got) x.release();
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- wands
// scripts/check-wand-world.mjs's checks, on WebGPU (the voxel shading part is the volume's: U6).
test('stage:wands', async () => {
  const out = { checks: [], ms: {} };
  const THREE = await import('three');
  const { createWandWorld } = await import('/src/pov/wands/world.js');
  const sim = await make(32, { debug: false });
  let active = sim;
  const world = createWandWorld({ getSim: () => active });
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const begin = () => world.begin({ sim: active, dt: 1 / 60, stepsPerFrame: 4 });
  const c = v(8.5, 8.5, 8.5);
  const cmd = (effect, props = {}) => ({ effect, center: c, radius: 0.5, power: 100, ...props });
  const cell = (x = 8, y = 8, z = 8) => sim.readCell(x, y, z);
  const ok = (cond, name) => check(out, `wands: ${name}`, cond);
  function scene(cells = []) {
    load(sim, (set) => { for (const [x, y, z, id] of cells) set(x, y, z, id); });
    begin();
  }
  function apply(...commands) {
    begin();
    for (const command of commands) ok(world.queue(command), `queue ${command.effect}`);
    world.flush();
  }
  try {
    scene([[8, 8, 8, E.ROCK], [9, 8, 8, E.WALL], [10, 8, 8, E.CLONE]]);
    apply(cmd('dig', { power: 29 })); ok((await cell())[0][0] === E.ROCK, 'dig honors hardness');
    apply(cmd('dig')); ok((await cell())[0][0] === E.STONE, 'dig leaves debris');
    apply(cmd('erase', { radius: 3 }));
    ok((await cell())[0][0] === E.EMPTY && (await cell(9))[0][0] === E.WALL && (await cell(10))[0][0] === E.CLONE, 'erase protects WALL/CLONE');
    apply(cmd('emit', { material: 'ACID', radius: 3, velocity: v(240, 0, 0) }));
    ok((await cell())[0][0] === E.ACID && (await cell())[1][0] === 1 && (await cell(9))[0][0] === E.WALL, 'emit gas-only and step velocity');
    apply(cmd('place', { material: 'ICE' })); ok((await cell())[0][0] === E.ACID, 'place preserves liquid');
    apply(cmd('erase'), cmd('place', { material: 'ICE' })); ok((await cell())[0][0] === E.ICE, 'ordered ice placement');
    apply(cmd('heat', { power: 100 })); ok((await cell())[0][1] === 80, 'heat');
    apply(cmd('cool', { power: 200 })); ok((await cell())[0][1] === -120, 'cool');
    apply(cmd('pressure', { power: 6000 })); ok((await cell())[1][3] === 200, 'bounded pressure');
    scene([[8, 8, 8, E.GUNPOWDER]]);
    apply(cmd('ignite')); ok((await cell())[0][1] > 200, 'ignite combustible');
    apply(cmd('attract', { center: v(7.5, 8.5, 8.5), radius: 2, power: 1000, dt: 0.25 }));
    ok((await cell())[1][0] < 0, 'attract');
    apply(cmd('repel', { center: v(7.5, 8.5, 8.5), radius: 2, power: 6000, dt: 0.25 }));
    ok((await cell())[1][0] >= 0, 'repel');
    scene();
    begin();
    let all = true;
    for (let i = 0; i < 64; i++) all = world.queue(cmd('heat', { power: 1 })) && all;
    ok(all, 'accept bounded batch');
    ok(!world.queue(cmd('heat')), 'queue overflow');
    const m = await measure(gpu, () => { world.flush(); world.flush(); });
    ok(world.stats.passes === 1 && world.stats.commands === 64 && (await cell())[0][1] === 84 && m.dispatches === 1, 'one edit (one dispatch) for 64 commands');
    ok(world.stats.touched.lo[0] === 8 && world.stats.touched.hi[0] === 9, 'tight touched bounds');
    ok(!world.queue(cmd('heat')), 'one flush per frame');
    begin();
    let rejectedAll = true;
    for (const bad of [cmd('wat'), cmd('heat', { power: NaN }), cmd('emit', { material: '__proto__' }), cmd('heat', { center: v(Infinity, 0, 0) }), cmd('heat', { velocity: v(NaN, 0, 0) })]) rejectedAll = !world.queue(bad) && rejectedAll;
    ok(rejectedAll, 'reject invalid inputs');
    apply(cmd('place', { material: 'WALL' }));
    const segment = { from: v(2.5, 8.5, 8.5), to: v(12.5, 8.5, 8.5) };
    begin();
    const hits = await world.trace(Array.from({ length: 128 }, () => segment));
    ok(hits.length === 128 && hits.every((x) => x?.id === E.WALL && x.cell.x === 8 && x.normal.x === -1 && Math.abs(x.fraction - 0.55) < 1e-5), '128 batched segment hits');
    ok(world.stats.readbacks === 1, 'one probe for 128 rays');
    const floor = (await world.trace([{ from: v(2, 2, 2), to: v(2, -2, 2) }]))[0];
    ok(floor?.cell.y === -1 && floor.normal.y === 1 && floor.fraction === 0.5, 'floor ray');
    ok((await world.trace([{ from: v(-1, 10, 10), to: v(33, 10, 10) }]))[0] === null, 'empty through-grid ray');
    let rejected = false; try { await world.trace(Array(129).fill(segment)); } catch { rejected = true; }
    ok(rejected, 'overlong batch rejected');
    begin();
    ok((await world.trace([{ from: v(8, 8.5, 8.5), to: v(3, 8.5, 8.5) }]))[0] === null, 'departing exact face is clear');
    const entering = (await world.trace([{ from: v(-2, 8.5, 8.5), to: v(18, 8.5, 8.5) }]))[0];
    ok(entering?.cell.x === 8 && Math.abs(entering.fraction - 0.5) < 1e-5, 'outside-grid entry');
    const mutable = [segment, segment], captured = world.trace(mutable); mutable.length = 0;
    ok((await captured).length === 2, 'async result owns input batch length');
    begin(); const pendingHit = world.trace([segment]); world.windowShifted(4, 0);
    ok((await pendingHit)[0]?.cell.x === 4, 'pending hit shifts to current window');
    world.windowShifted(-4, 0);
    scene();
    ok(await world.clearance(v(8, 2, 8)), 'empty full-body clearance');
    ok(!await world.clearance(v(8, -0.01, 8)), 'feet below floor fails clearance');
    scene([[8, 7, 8, E.ROCK]]);
    ok(!await world.clearance(v(8, 2, 8)), 'head obstruction fails clearance');
    scene([[7, 4, 7, E.ROCK]]);
    ok(!await world.clearance(v(8, 2, 8)), 'corner obstruction fails clearance');
    scene(); const movingClearance = world.clearance(v(8, 2, 8)); world.windowShifted(4, 0);
    ok(!await movingClearance, 'shift invalidates clearance'); world.windowShifted(-4, 0);
    begin(); ok(!await world.clearance(v(0, 2, 0)), 'out-of-grid body rejected');
    begin(); const stale = world.trace([segment]); active = null;
    ok(await stale.then(() => false, () => true), 'replacement rejects pending trace'); active = sim;
    begin();
    const reads = Array.from({ length: 4 }, () => world.trace([segment]));
    const outcomes = await Promise.allSettled(reads);
    ok(outcomes[3].status === 'rejected', 'capacity failure is not reported as clear space');
    ok(world.stats.readbacks === 3 && world.stats.maxPending <= 3, 'bounded in-flight probes');
    scene(); ok(world.queue(cmd('place', { center: v(12.5, 8.5, 8.5), material: 'ICE' })), 'shift queue');
    world.windowShifted(4, 0); world.flush();
    ok((await cell())[0][0] === E.ICE, 'queued mutation shifts with the window');
    world.windowShifted(-4, 0);
    begin(); const disposedTrace = world.trace([segment]); world.dispose();
    ok(await disposedTrace.then(() => false, () => true), 'disposal rejects pending trace');
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { world.dispose(); sim.dispose(); }
});

// ---------------------------------------------------------------- look
// The wands' draws (wands/visuals.js: the spells' cores, shells and beams)
// and the held wand's gem and halo (tools/glow.js) are TSL node materials
// (docs/webgpu.md F8): each compiles through gpu.three.prepare with no error
// and draws into a half-float scene target what the GLSL drew: a still core's
// middle is its colour × CORE_GAIN + CORE_WHITE, every shell style and the
// beam light their place and nothing far from it, the gem's middle is its
// colour + its white heat, the halo's (a display value) the sRGB of its share
// of its colour in a raw view and AgX's below 1 otherwise.
test('stage:look', async () => {
  const out = { checks: [], ms: {} };
  const THREE = await import('three/webgpu');
  const { createThreeRenderer, initRenderTarget, gpuTextureOf, useWebGPUCamera } = await import('/src/gpu/three.js');
  const { halfsToFloats } = await import('/src/gpu/readback.js');
  const { createWandVisuals } = await import('/src/pov/wands/visuals.js');
  const { glowMaterial, GLOW_TONE } = await import('/src/pov/tools/glow.js');
  const W = 160, H = 100;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const three = await createThreeRenderer(gpu, canvas);
  three.setPixelRatio(1);
  three.setSize(W, H, false);
  three.autoClear = true;
  three.setClearColor(0x000000, 0);
  const camera = useWebGPUCamera(new THREE.PerspectiveCamera(50, W / H, 0.1, 100));
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const target = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
  initRenderTarget(three, target);
  gpu.three.defaults = { camera, scene, target };
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const frame = async () => {
    three.setRenderTarget(target);
    three.render(scene, camera);
    three.setRenderTarget(null);
    return halfsToFloats(await gpu.readback.texture(gpuTextureOf(three, target.texture)));
  };
  const pixel = (p) => { const q = p.clone().project(camera); return [Math.floor((q.x * 0.5 + 0.5) * W), Math.floor((0.5 - q.y * 0.5) * H)]; };
  const at = (img, [x, y]) => Array.from(img.subarray(4 * (y * W + x), 4 * (y * W + x) + 3));
  // the brightest pixel (r + g + b) within `r` px of `p`
  const peak = (img, p, r = 2) => {
    const [cx, cy] = pixel(p);
    let best = [0, 0, 0];
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const c = at(img, [x, y]);
      if (c[0] + c[1] + c[2] > best[0] + best[1] + best[2]) best = c;
    }
    return best;
  };
  const finite = (img) => img.every(Number.isFinite);
  const close = (got, want, rel) => got.every((g, k) => Math.abs(g - want[k]) <= rel * Math.abs(want[k]) + 2e-3);
  const fmt = (c) => `(${c.map((x) => x.toFixed(3)).join(', ')})`;
  const env = { scene, getSim: () => ({ gpu }), getScale: () => 1, getVolume: () => ({ position: v(0, 0, 0) }) };
  let visuals = null;
  try {
    // the spells' draws join the scene once three has built their pipelines
    let t0 = performance.now();
    visuals = createWandVisuals(env);
    const joined = async () => {
      for (let i = 0; i < 1200 && !scene.getObjectByName('wand-cores'); i++) await new Promise((r) => setTimeout(r, 50));
      return !!scene.getObjectByName('wand-beams');
    };
    check(out, 'look: the spells\' draws compile (gpu.three.prepare) and join the scene', await joined(), 'not in the scene after 60 s');
    out.ms.visualsCompile = performance.now() - t0;
    const { lookOf } = await import('/src/pov/wands/look.js');
    // a still bolt's core (no streak): its middle is the colour × CORE_GAIN + CORE_WHITE (both 1 at r = 0)
    visuals.update([{ kind: 'bolt', position: v(-3, 1.5, 0), effect: 'spark', radius: 1 }], 1 / 60);
    let img = await frame();
    const rgb = lookOf('spark').rgb, want = rgb.map((c) => c * 3.2 + 6);
    const got = peak(img, v(-3, 1.5, 0));
    check(out, 'look: a still core\'s middle is colour × CORE_GAIN + CORE_WHITE', close(got, want, 0.15) && got.every((c, k) => c <= want[k] * 1.001 + 2e-3), `${fmt(got)} want ${fmt(want)}`);
    check(out, 'look: nothing lit far from the core', at(img, pixel(v(3, -1.5, 0))).every((c) => c === 0) && finite(img), fmt(at(img, pixel(v(3, -1.5, 0)))));
    // a moving bolt streaks along its velocity: its tail lit behind it, nothing ahead past its halo
    visuals.update([{ kind: 'bolt', position: v(0, 0, 0), effect: 'spark', radius: 1, velocity: v(60, 0, 0) }], 1 / 60);
    img = await frame();
    const tail = peak(img, v(-0.8, 0, 0), 0), ahead = at(img, pixel(v(1.6, 0, 0)));
    check(out, 'look: a moving core streaks behind it (STREAK_S of travel)', tail[0] + tail[1] + tail[2] > 0.5 && ahead.every((c) => c === 0), `tail ${fmt(tail)} ahead ${fmt(ahead)}`);
    // every shell style lights its sphere's place and nothing far from it
    for (const [effect, style] of [['spark', 'glow'], ['attract', 'pull'], ['repel', 'push'], ['erase', 'void'], ['emit', 'cloud']]) {
      visuals.update([{ kind: 'field', position: v(0, 0, 0), effect, radius: 2.5, age: 1, left: 1 }], 1 / 60);
      img = await frame();
      let lit = 0;
      const [cx, cy] = pixel(v(0, 0, 0)), rpx = Math.abs(pixel(v(2.5, 0, 0))[0] - cx);
      for (let y = cy - rpx; y <= cy + rpx; y++) for (let x = cx - rpx; x <= cx + rpx; x++) { const c = at(img, [x, y]); if (c[0] + c[1] + c[2] > 0.01) lit++; }
      const far = at(img, pixel(v(6, 3.5, 0)));
      check(out, `look: a ${style} shell lights its sphere`, lit > rpx * rpx / 2 && far.every((c) => c === 0) && finite(img), `${lit} px lit of ${(2 * rpx + 1) ** 2}, far ${fmt(far)}`);
    }
    // a blast's shock shell and flash, and a beam from the wand's tip
    visuals.clear();
    visuals.pulse(v(0, 0, 0), 'pressure', 2);
    visuals.update([], 0.05);
    img = await frame();
    check(out, 'look: a blast lights a flash and a shock shell', peak(img, v(0, 0, 0)).some((c) => c > 0.5) && finite(img), fmt(peak(img, v(0, 0, 0))));
    visuals.clear();
    visuals.pulse(v(4, 0, 0), 'spark', 2, v(-4, 0, 0));
    visuals.update([], 0.01);
    img = await frame();
    const mid = peak(img, v(0, 0, 0), 0), above = at(img, pixel(v(0, 1.5, 0)));
    check(out, 'look: a beam lights its line and nothing a cell and a half off it', mid.some((c) => c > 1) && above.every((c) => c === 0) && finite(img), `on ${fmt(mid)} off ${fmt(above)}`);
    visuals.clear();
    // the gem and its halo
    const color = [1, 0.5, 0.25];
    const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), glowMaterial({ rim: 0.45, white: 1.2, whiteSharp: 6 }));
    const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 3), glowMaterial({ soft: 3, opacity: 0.35 }));
    for (const m of [gem, halo]) m.material.userData.color.value.setRGB(...color);
    t0 = performance.now();
    await Promise.all([gpu.three.prepare(gem), gpu.three.prepare(halo)]);
    out.ms.glowCompile = performance.now() - t0;
    scene.add(gem);
    img = await frame();
    const gemWant = color.map((c) => c + 1.2), gemGot = peak(img, v(0, 0, 0), 1);
    check(out, 'look: the gem\'s middle is its colour + its white heat (N·V = 1)', close(gemGot, gemWant, 0.06), `${fmt(gemGot)} want ${fmt(gemWant)}`);
    gem.removeFromParent();
    scene.add(halo);
    GLOW_TONE.raw.value = 1;
    img = await frame();
    const srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const haloWant = color.map((c) => srgb(Math.min(c * 0.35, 1))), haloRaw = peak(img, v(0, 0, 0), 1);
    check(out, 'look: the halo\'s middle in a raw view is sRGB(colour × opacity)', close(haloRaw, haloWant, 0.05), `${fmt(haloRaw)} want ${fmt(haloWant)}`);
    GLOW_TONE.raw.value = 0;
    img = await frame();
    const haloAgx = peak(img, v(0, 0, 0), 1);
    check(out, 'look: the halo tone maps itself (AgX: a display value, not the raw one)', haloAgx.every((c) => c > 0 && c < 1) && haloAgx.some((c, k) => Math.abs(c - haloRaw[k]) > 0.01), `${fmt(haloAgx)} raw ${fmt(haloRaw)}`);
    halo.removeFromParent();
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally {
    visuals?.dispose();
    target.dispose();
  }
});

// ---------------------------------------------------------------- recipes
// scripts/check-wand-recipes.mjs's checks on WebGPU: every preset wand cast
// on a small world, its effects checked in the cells (a 64×32×32 grid, not
// stepped: what the wand did, not what the world did after).
test('stage:recipes', async ({ only = null } = {}) => {
  const out = { checks: [], ms: {}, recipes: [] };
  const THREE = await import('three');
  const { PRESETS } = await import('/src/pov/wands/catalog.js');
  const { createWandRuntime } = await import('/src/pov/wands/runtime.js');
  const { createWandWorld } = await import('/src/pov/wands/world.js');
  const { addTarget } = await import('/src/pov/targets.js');
  const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const sim = await make([64, 32, 32], { debug: false });
  const scene = new THREE.Scene(), volume = { position: v() };
  // (renderer: the key the shared transfer engine and the runtime's state hang on, one per page)
  const env = { renderer: {}, scene, getSim: () => sim, getScale: () => 1, getVolume: () => volume, requestRender() {} };
  let runtime, removeTarget = () => {};
  const read = (x, y, z) => sim.readCell(x, y, z);
  const count = async () => {
    const [a] = await sim.readState(), c = {};
    for (let n = 0; n < a.length; n += 4) c[Math.round(a[n])] = (c[Math.round(a[n])] ?? 0) + 1;
    return c;
  };
  try {
    for (const preset of PRESETS.filter((x) => !only || only.includes(x.id))) {
      let commands = [], lights = [], impulses = [], teleports = [], health = 1;
      const checks = [];
      let cpuMs = 0, framesRun = 0, maxCpuMs = 0;
      const ok = (cond, label) => checks.push({ ok: !!cond, label });
      runtime?.dispose(); removeTarget();
      const [a, b] = sim.blankState();
      const put = (x, y, z, id, temperature = ELEMENTS[id].temp) => a.set([id, temperature, ELEMENTS[id].life, 0.125], sim.cellTexel(x, y, z) * 4);
      const wall = () => { for (let y = 0; y < 24; y++) for (let z = 2; z < 30; z++) put(26, y, z, E.WALL); };
      const id = preset.id;
      if (['acid-shotgun', 'stored-scrap-machinegun', 'double-explosion', 'delayed-second-explosion', 'teleport'].includes(id)) wall();
      if (['mining-vacuum', 'tunnel-cutter', 'water-extinguisher'].includes(id)) {
        put(14, 14, 16, E.ROCK, id === 'water-extinguisher' ? 800 : 20);
        put(14, 18, 16, E.ROCK);
        if (id === 'mining-vacuum') put(13, 14, 17, E.STONE);
        if (id === 'water-extinguisher') put(13, 14, 16, E.FIRE);
      }
      if (id === 'liquid-sponge') for (let x = 14; x < 16; x++) for (let y = 13; y < 15; y++) for (let z = 15; z < 17; z++) put(x, y, z, E.WATER, 42);
      if (id === 'stored-lava-mortar') for (let x = 0; x < 64; x++) for (let z = 0; z < 32; z++) put(x, 1, z, E.WALL);
      if (id === 'remote-black-hole') { put(47, 16, 16, E.ROCK); put(47, 17, 16, E.WALL); put(48, 17, 16, E.CLONE); put(9, 16, 16, E.ROCK); }
      sim.load(a, b);
      const world = createWandWorld(env), queue = world.queue, setLights = world.setLights;
      world.queue = (c) => { const accepted = queue(c); if (accepted) commands.push({ effect: c.effect, at: c.center.toArray(), time: runtime.stats.time }); return accepted; };
      world.setLights = (ls) => { if (ls.length) lights = ls.map((l) => ({ ...l, position: l.position.toArray() })); setLights(ls); };
      runtime = createWandRuntime({ ...env, world });
      runtime.equip(preset); runtime.resetWorld();
      const player = { pos: v(8, 8.5, 16), vel: v(), onGround: false, inLiquid: false,
        applyImpulse: (dv) => impulses.push(dv.toArray()), teleport: (feet) => { teleports.push(feet.toArray()); player.pos.copy(feet); } };
      const ctx = { sim, dt: 0.05, stepsPerFrame: 1, eye: v(8, 14, 16), dir: id === 'recoil-flying' ? v(0, -1, 0) : v(1, 0, 0), primary: false, player, aim: { valid: false } };
      if (id === 'spark-machinegun') removeTarget = addTarget({ id: 'wand-test-target', alive: true, box(lo, hi) { lo.set(22, 10, 12); hi.set(25, 20, 20); }, hurt(amount) { health -= amount; } });
      const frame = async (fire = false) => {
        ctx.primary = fire;
        const start = performance.now();
        runtime.update(ctx);
        const elapsed = performance.now() - start;
        cpuMs += elapsed; maxCpuMs = Math.max(maxCpuMs, elapsed); framesRun++;
        ok(runtime.stats.frameCommands <= 64 && runtime.stats.frameTransfers <= 2, 'bounded per-frame work');
        await new Promise((r) => setTimeout(r, 4));   // (a frame's probes land a frame or two later)
      };
      const frames = async (n) => { for (let k = 0; k < n; k++) await frame(); };
      await frame(true); await frames(90);
      const first = await count(), stored = runtime.stats.inventory;
      if (id === 'mining-vacuum') {
        ok((await read(14, 14, 16))[0][0] !== E.ROCK, 'fractures aimed rock');
        ok(stored > 0, 'collects powder');
        ok((first[E.STONE] ?? 0) + stored === 2, 'conserves mined and loose stone');
      } else if (id === 'tunnel-cutter') {
        ok((await read(14, 14, 16))[0][0] === E.STONE && (await read(14, 18, 16))[0][0] === E.ROCK, 'narrow drill leaves off-axis rock');
        ok(lights.length > 0, 'drill supplies cold work light');
      } else if (id === 'acid-shotgun') {
        ok((first[E.ACID] ?? 0) > 0, 'creates real acid at impacts');
        ok(commands.filter((c) => c.effect === 'emit').length === 3, 'three pellets');
        ok((await read(26, 14, 16))[0][0] === E.WALL, 'does not replace wall');
      } else if (id === 'spark-machinegun') {
        ok(health > 0 && health <= 0.77, `three nonlethal actor hits: health ${health}`);
        ok(runtime.stats.casts === 1, 'burst prepaid as one cast');
      } else if (id === 'stored-scrap-machinegun' || id === 'stored-lava-mortar') {
        const element = id.includes('scrap') ? E.SCRAP : E.LAVA;
        ok((first[element] ?? 0) > 0, 'deposits real stored matter');
        ok((first[element] ?? 0) + stored === 256, `conserves starter matter: grid ${first[element] ?? 0}, stored ${stored}`);
        runtime.equip(preset); ok(runtime.stats.inventory === stored, 'reequip does not refill');
      } else if (id === 'recoil-flying') ok(impulses.some((q) => q[1] > 0), 'downward aim gives upward propulsion');
      else if (id === 'water-extinguisher') {
        ok((first[E.WATER] ?? 0) > 0, 'creates water');
        ok((await read(14, 14, 16))[0][1] < 800, 'cools hot rock');
      } else if (id === 'liquid-sponge') {
        ok(stored === 8 && !(first[E.WATER] ?? 0), 'absorbs all eight cells');
        ctx.dir.set(-1, 0, 0); ctx.eye.set(20, 14, 16);
        await frame(true); await frames(20);
        ok(((await count())[E.WATER] ?? 0) + runtime.stats.inventory === 8, 'release conserves cells');
        ok(runtime.stats.inventory < stored, 'releases stored water');
      } else if (id === 'remote-black-hole') {
        ok((await read(47, 16, 16))[0][0] === E.EMPTY, 'remote sphere erases rock');
        ok((await read(47, 17, 16))[0][0] === E.WALL && (await read(48, 17, 16))[0][0] === E.CLONE, 'protected materials survive');
        ok((await read(9, 16, 16))[0][0] === E.ROCK, 'near-caster rock survives');
        ok(commands.filter((c) => c.effect === 'erase').every((c) => c.at[0] > 35), 'timer deploys remotely');
      } else if (id === 'double-explosion' || id === 'delayed-second-explosion') {
        const blasts = commands.filter((c) => c.effect === 'pressure');
        ok(blasts.length === 2, 'exactly two explosions');
        ok(blasts.every((c) => Math.abs(c.at[0] - 26) < 0.1), 'payloads execute at impact origin');
        ok((await read(24, 14, 16))[1][3] > 0, 'blast changes world pressure');
        if (blasts.length === 2) ok(id === 'double-explosion' ? blasts[0].time === blasts[1].time : blasts[1].time - blasts[0].time >= 0.3, 'correct blast timing');
      } else if (id === 'ice-bridge') {
        let span = true;
        for (const x of [12, 13, 14, 15, 16, 17, 18]) span = span && (await read(x, 14, 16))[0][0] === E.ICE;
        ok(span, 'connected ice span');
      } else if (id === 'cave-lantern') ok(lights.some((l) => l.position[0] > 20 && l.position[0] < 35), 'cold lantern deployed remotely in open air');
      else if (id === 'powder-and-ignition') {
        ok((first[E.GUNPOWDER] ?? 0) > 0, 'first cast places gunpowder');
        ok((await read(16, 14, 16))[0][1] < 200, 'powder starts unlit');
        await frame(true); await frames(30);
        ok((await read(16, 14, 16))[0][1] >= 200 || (await read(13, 14, 16))[0][1] >= 200, 'second cast ignites actual deposit');
      } else if (id === 'teleport') ok(teleports.length === 1 && player.pos.x > 20 && player.pos.x < 26, 'teleports to full-body clear near side');
      ok(runtime.stats.mana >= 0 && Number.isFinite(runtime.stats.mana), 'finite nonnegative mana');
      ok(!h.failures.length, 'no GPU failures');
      const failed = checks.filter((c) => !c.ok);
      check(out, `recipe ${id}: ${checks.length} checks${failed.length ? '' : ', all hold'} (CPU ${(cpuMs / framesRun).toFixed(2)} ms/frame mean, ${maxCpuMs.toFixed(1)} max)`,
        !failed.length, [...new Set(failed.map((c) => c.label))].join('; '));
      out.recipes.push({ recipe: id, commands: commands.length, stats: { casts: runtime.stats.casts, traces: runtime.stats.traceErrors, storage: runtime.stats.inventory, lastError: runtime.stats.lastError } });
    }
    return out;
  } finally { runtime?.dispose(); removeTarget(); sim.dispose(); }
});

// ---------------------------------------------------------------- budget
// What the first person's GPU work costs in gpu.stats (tools/budgets/pov.mjs):
// per edit family its dispatches (two for the strike), a probe one, the
// transfer one, the laser two (the apply indirect), a readCells capture one;
// none allocates.
test('budget:pov', async () => {
  const sim = await make(32, { debug: false });
  const pov = povGpu(sim);
  try {
    load(sim, (set, g) => { box(set, [0, 0, 0], [g.nx, 4, g.nz], E.SAND); });
    const res = {};
    const bx = sim.touchCentres([8, 2, 8], [12, 6, 12]);
    let editDispatches = 0, editAllocated = 0, editIndirect = 0;
    const comBuf = gpu.createBuffer({ label: 'pov budget com', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    pov.com(comBuf, [10, 4, 10]);
    await sim.gpuSync();
    for (const name of Object.keys(POV_EDITS)) {
      const values = name === 'povWand' ? { count: 0 } : {};
      const opts = name === 'povPhysgun' ? { bind: [{ buffer: comBuf }] } : undefined;
      pov.edit(name, bx, values, opts);   // (first use: its bind group)
      await sim.gpuSync();
      const m = await measure(gpu, () => { pov.edit(name, bx, values, opts); });
      res[`${name}Dispatches`] = m.dispatches;
      editDispatches += m.dispatches; editAllocated += m.bytesAllocated; editIndirect += m.indirectDispatches;
    }
    await sim.gpuSync();
    // (each once first: a device's result rings are made on first use)
    const take = { count: 4, limit: 4, mode: TRANSFER_TAKE, kinds: 1 << K.POWDER, breaks: 0, vel: [0, 0, 0], cells: [[1, 1, 1, -1], [2, 1, 1, -1], [3, 1, 1, -1], [4, 1, 1, -1]], items: [] };
    await Promise.all([pov.probe('povProbe', { boxLo: [0, 0, 0] }), pov.transfer(take), pov.laser([2.5, 8.5, 2.5], [1, 0, 0])]);
    let reads = [];
    const probe = await measure(gpu, () => { reads.push(pov.probe('povProbe', { boxLo: [0, 0, 0] })); });
    const transfer = await measure(gpu, () => { reads.push(pov.transfer({ ...take, cells: take.cells.map(([x, y, z, w]) => [x, y + 1, z, w]) })); });
    const laser = await measure(gpu, () => { reads.push(pov.laser([2.5, 8.5, 2.5], [1, 0, 0])); });
    await Promise.all(reads);
    reads = [];
    await sim.gpuSync();
    let job = null;
    for (let i = 0; i < 40 && !job; i++) { job = readCells(null, sim); if (!job) await new Promise((r) => setTimeout(r, 50)); }
    (await job).release();
    const cells = await measure(gpu, () => { job = readCells(null, sim); });
    (await job).release();
    await sim.gpuSync();
    comBuf.destroy();
    return {
      ...res, editDispatches, editAllocated, editIndirect,
      probeDispatches: probe.dispatches, probeAllocated: probe.bytesAllocated,
      transferDispatches: transfer.dispatches, transferAllocated: transfer.bytesAllocated,
      laserDispatches: laser.dispatches, laserIndirect: laser.indirectDispatches, laserAllocated: laser.bytesAllocated,
      cellsDispatches: cells.dispatches, cellsAllocated: cells.bytesAllocated,
    };
  } finally { sim.dispose(); }
});

// A first-person frame (tools/budgets/pov.mjs): a body wading in a 32³ world
// (water to its knees, so its coupling runs), then the frame's update (the
// body's probe and its coupling's edit), its 4 steps and the GPU done with
// them; then the same frame with a kick that breaks a glass pane at the hip
// (the kick's edit). What the app's tick adds to it (the view, three, post)
// is tools/budgets/app.mjs's.
test('budget:povFrame', async () => {
  const sim = await make(32, { debug: false });
  const THREE = await import('three');
  const { createPlayer } = await import('/src/pov/player.js');
  const pl = createPlayer({ renderer: null, getSim: () => sim });
  const STEPS = 4, DT = 1 / 60;
  try {
    load(sim, (set, g) => {
      box(set, [0, 0, 0], [g.nx, 1, g.nz], E.WALL);
      box(set, [0, 1, 0], [g.nx, 3, g.nz], E.WATER);   // two cells deep
      box(set, [18, 1, 14], [19, 7, 19], E.GLASS);     // a pane across the way, three cells ahead
    });
    pl.spawn(new THREE.Vector3(15.5, 1, 16.5));
    const frame = async (fn) => { fn?.(); pl.update(DT, {}); for (let i = 0; i < STEPS; i++) sim.step(); await gpu.fence(); await tick(); };
    for (let i = 0; i < 30; i++) await frame();   // standing, its probes landing
    const body = await measure(gpu, () => { pl.update(DT, {}); });
    for (let i = 0; i < STEPS; i++) sim.step();
    await gpu.fence(); await tick();
    const whole = await measure(gpu, () => frame());
    for (let i = 0; i < 30; i++) await frame();   // (the kick's refire wait)
    let kick = null;
    const kicked = await measure(gpu, () => { kick = pl.kick(new THREE.Vector3(1, 0, 0)); });
    await frame();
    return {
      bodyDispatches: body.dispatches, bodyAllocated: body.bytesAllocated, coupled: pl.inLiquid ? 1 : 0,
      frameSubmits: whole.submits, frameComputePasses: whole.computePasses, frameRenderPasses: whole.renderPasses, frameAllocated: whole.bytesAllocated,
      kickDispatches: kicked.dispatches, kickBroke: kick?.hit === 'cell' && kick.broke ? 1 : 0,   // (budget-check compares numbers)
    };
  } finally { pl.dispose?.(); sim.dispose(); }
});

ready();
