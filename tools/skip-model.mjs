// CPU model check of D8's sleeping supertiles (docs/scaling.md D8, shaders/activity.js
// SUPER_MAP), in 1-D: the step passes' semantics as the shaders implement them (the
// block pass and gather of shaders/move.js, shaders/react.js, the activity flags'
// writtenFlags and freshFlags), run twice from the same start under the same activity
// maps and writes, once drawing every supertile and once skipping the sleeping ones by
// the supertile map's rule (Simulation.updateActivity, noteWrite). The maps are random
// and drift: the rule must hold whatever they are, since a map is the same function of
// the same current state in both runs. Both state copies must agree after every
// operation, values and flags. Writes: brushes with and without a declared box, a
// write of only what no neighbour test reads, load/undo/unpack (the current copy
// alone), syncCopies, a shift, maps built by hand, a tool asking for a new map.
// A cell is v (what neighbour tests read: element, temperature), l (what they don't:
// life, velocity) and f (the activity flags). Exits 1 on the first difference.
// usage: node tools/skip-model.mjs [seed] [runs] [operations per run]
const N = 64, BS = 4, SUPER = 2;              // cells, cells per brick, bricks per supertile
const NB = N / BS, NS = NB / SUPER;
const SELF = 1, NEAR = 2, MATTER = 4, DIRTY = 8;   // shaders/common.js FLAG
const ACTIVITY_PERIOD = 2;    // steps a map stays valid (sim.js)
const SETTLE_STEPS = 2;       // shaders/activity.js SUPER_SETTLE_STEPS
const VALUES = 50, LIVES = 4; // distinct v and l a cell holds
const OUTSIDE = VALUES;       // v that react reads past the grid's ends (a wall)
// the model's dynamics, as odds 1 in n (decided by hashes of the block or cell and the frame):
const ODDS = {
  SELF: 3, LIFE: 2,           // a cell isn't inert, from v / from l (own flags)
  MATTER: 5,                  // a cell is air
  BLOCK: 3,                   // a solved block swaps its cells, else nudges a velocity, else...
  HEAT: 5,                    // ...warms a cell (impact heat)
  REACT_V: 4, REACT_L: 3,     // react changes a cell's v, its l
  NEAR: 2,                    // its neighbour test fails
};
const SHIFT = 8;              // cells a shift moves the state
const BOX_MAX = 10;           // cells a brush's box spans, at most
const WRITE_SHARE = 0.6;      // share of a box's cells a brush changes
const LOAD_SHARE = 0.3;       // share of cells a load, undo or unpack changes
const QUIET_SHARE = 0.75;     // a drifting map: bricks quiet...
const DRIFT_SHARE = 0.3;      // ...and the share of them redrawn per drift
// operations and their cumulative odds per turn
const MIX = [['step', 0.64], ['brush', 0.74], ['brushNoBox', 0.77], ['life', 0.80], ['current', 0.82],
  ['sync', 0.84], ['shift', 0.86], ['mapByHand', 0.88], ['poke', 0.90], ['drift', 1]];
let seed = +(process.argv[2] ?? 1);
const RUNS = +(process.argv[3] ?? 400), OPS = +(process.argv[4] ?? 300);
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };   // Numerical Recipes' LCG
const hash = (...xs) => { let h = 2166136261; for (const x of xs) { h ^= x & 0xffffffff; h = Math.imul(h, 16777619); h ^= h >>> 13; } return h >>> 0; };   // FNV-1a, mixed
const pick = (n) => Math.floor(rnd() * n);
const own = (c) => ((c.v % ODDS.SELF !== 0 && c.l % ODDS.LIFE === 0) ? SELF : 0) | ((c.v % ODDS.MATTER !== 0) ? MATTER : 0);
const fresh = (c) => own(c) | DIRTY;
// writtenFlags (shaders/common.js): a new v is fresh, a new l redoes SELF, else the flags stay
const written = (f, a, o) => (o.v !== a.v ? fresh(o) : o.l !== a.l ? (own(o) & SELF ? f | SELF : f & ~SELF) : f);
const brick = (p) => Math.floor(Math.min(Math.max(p, 0), N - 1) / BS);
const sup = (b) => Math.floor(b / SUPER);

function makeSim(skip) {
  const C = [[], []];
  for (let p = 0; p < N; p++) {
    const c = { v: hash(p, 1) % VALUES, l: hash(p, 2) % LIVES };
    C[0].push({ ...c, f: fresh(c) });
    C[1].push({ v: 0, l: 0, f: 0 });
  }
  return {
    skip, C, cur: 0, frame: 0, fresh: false, nsteps: 0, wrote: false,
    prevAwake: new Array(NS).fill(false), prevDrawn: new Array(NS).fill(false),
    forceAll: true, forceLo: 1e9, forceHi: -1,
    quiet: new Array(NB).fill(false), awake: null, steps: null, drawn: null,
  };
}

function noteWrite(s, box) {
  s.wrote = true;
  if (!box) { s.forceAll = true; return; }
  s.forceLo = Math.min(s.forceLo, sup(Math.floor(box[0] / BS)));
  s.forceHi = Math.max(s.forceHi, sup(Math.floor(box[1] / BS)));
}

// the supertile map (superMapFrag) with the activity map `quiet`
function buildMap(s, quiet) {
  s.quiet = quiet.slice();
  // the last map's steps settled what slept under it: two of them, or one and then a write
  const settled = s.nsteps >= SETTLE_STEPS || (s.nsteps >= 1 && s.wrote);
  const awake = [], steps = [], drawn = [];
  for (let i = 0; i < NS; i++) {
    let a = false, st = false;
    for (let b = i * SUPER - 1; b < (i + 1) * SUPER; b++) {
      if (b < 0 || quiet[b]) continue;
      a = true;
      if (b >= i * SUPER) st = true;
    }
    const forced = s.forceAll || (i >= s.forceLo && i <= s.forceHi);
    awake.push(a); steps.push(st);
    drawn.push(a || forced || (settled ? s.prevAwake[i] : s.prevDrawn[i]));
  }
  s.prevAwake = awake; s.prevDrawn = drawn;
  s.awake = awake; s.steps = steps; s.drawn = drawn;
  s.forceAll = false; s.forceLo = 1e9; s.forceHi = -1;
  s.fresh = true; s.nsteps = 0;
}

function step(s) {
  s.frame++;
  s.nsteps++;
  s.wrote = false;
  const par = s.frame & 1, q = s.quiet, all = !s.skip;
  // block pass: a block based in a brick that isn't quiet is solved (a swap or a
  // nudge, from a hash of the block and frame), where its supertile has STEPS
  const solved = new Map();
  const C0 = s.C[s.cur];
  for (let j = -1; j <= N / 2; j++) {
    const base = 2 * j + par;
    if (base < -1 || base >= N || (par === 0 && base < 0)) continue;
    const hb = brick(base);
    if (q[hb]) continue;
    if (!all && base >= 0 && !s.steps[sup(hb)]) continue;
    const cells = [base, base + 1].filter((p) => p >= 0 && p < N);
    const h = hash(base, s.frame);
    let out = cells.map((p) => ({ v: C0[p].v, l: C0[p].l }));
    if (out.length === 2 && h % ODDS.BLOCK === 0) out = [out[1], out[0]];
    else if (h % ODDS.BLOCK === 1) out[0] = { v: out[0].v, l: (out[0].l + 1) % LIVES };   // velocity only
    else if (h % ODDS.BLOCK === 2 && h % ODDS.HEAT === 0) out[0] = { v: (out[0].v + 1) % VALUES, l: out[0].l };   // impact heat
    solved.set(base, { cells, out });
  }
  // gather (current copy -> other)
  const C1 = s.C[1 - s.cur];
  const blockBase = (p) => (par ? ((p + 1) >> 1) * 2 - 1 : (p >> 1) * 2);
  for (let p = 0; p < N; p++) {
    if (!all && !s.drawn[sup(brick(p))]) continue;
    const base = blockBase(p);
    let c;
    if (q[brick(base)]) c = { v: C0[p].v, l: C0[p].l };
    else {
      const b = solved.get(base);
      if (!b) throw new Error(`gather read a block not solved this step (base ${base}, frame ${s.frame})`);
      c = b.out[b.cells.indexOf(p)];
    }
    let f = C0[p].f;
    if (s.fresh) f &= ~DIRTY;
    if (c.v !== C0[p].v) f |= DIRTY;
    C1[p] = { ...c, f };
  }
  s.cur = 1 - s.cur;
  s.fresh = false;
  // react (other -> current)
  const I = s.C[s.cur], O = s.C[1 - s.cur];
  for (let p = 0; p < N; p++) {
    if (!all && !s.drawn[sup(brick(p))]) continue;
    const a = I[p], dirty = a.f & DIRTY;
    if (q[brick(p)]) { O[p] = { v: a.v, l: a.l, f: own(a) | NEAR | dirty }; continue; }
    const lv = p > 0 ? I[p - 1].v : OUTSIDE, rv = p < N - 1 ? I[p + 1].v : OUTSIDE;
    const h = hash(p, s.frame, lv, a.v, rv, a.l);
    const o = { v: h % ODDS.REACT_V === 0 ? (a.v + lv + rv) % VALUES : a.v, l: h % ODDS.REACT_L === 0 ? (a.l + 1) % LIVES : a.l };
    let f = own(o) | dirty;
    if ((f & SELF) && hash(o.v, lv, rv) % ODDS.NEAR) f |= NEAR;
    if (o.v !== a.v) f |= DIRTY;
    O[p] = { ...o, f };
  }
  s.cur = 1 - s.cur;
}

// writes that aren't steps; `w` holds their random choices, the same for both sims
function copyThrough(s, w, declare) {   // a brush, a tool: changes cells in [lo, hi]
  const C0 = s.C[s.cur], C1 = s.C[1 - s.cur];
  for (let p = 0; p < N; p++) {
    const a = C0[p], o = { v: a.v, l: a.l };
    if (p >= w.lo && p <= w.hi) Object.assign(o, w.vals[p]);
    C1[p] = { ...o, f: written(a.f, a, o) };
  }
  s.cur = 1 - s.cur;
  noteWrite(s, declare ? [w.lo, w.hi] : null);
}
function currentOnly(s, w) {   // load, undo, codec unpack
  const C0 = s.C[s.cur];
  for (let p = 0; p < N; p++) { const o = { v: C0[p].v, l: C0[p].l, ...w.all[p] }; C0[p] = { ...o, f: fresh(o) }; }
  noteWrite(s, null);
}
function syncCopies(s) {
  const C0 = s.C[s.cur], C1 = s.C[1 - s.cur];
  for (let p = 0; p < N; p++) C1[p] = { v: C0[p].v, l: C0[p].l, f: fresh(C0[p]) };
  noteWrite(s, null);
}
function shift(s, d) {
  const C0 = s.C[s.cur], C1 = s.C[1 - s.cur];
  for (let p = 0; p < N; p++) {
    const q = p + d, o = q >= 0 && q < N ? { v: C0[q].v, l: C0[q].l } : { v: 0, l: 0 };
    C1[p] = { ...o, f: fresh(o) };
  }
  s.cur = 1 - s.cur;
  noteWrite(s, null);
}

let ops = 0, skipped = 0, total = 0, mapsByHand = 0;
for (let run = 0; run < RUNS; run++) {
  const sims = [makeSim(false), makeSim(true)];
  const quiet = new Array(NB).fill(false);
  let age = ACTIVITY_PERIOD, dirty = true;
  for (let t = 0; t < OPS; t++) {
    const r = rnd(), op = MIX.find(([, odds]) => r < odds)[0];
    // the quiet map drifts (sticky), like a world settling and stirring
    if (op === 'drift') { for (let b = 0; b < NB; b++) if (rnd() < DRIFT_SHARE) quiet[b] = rnd() < QUIET_SHARE; continue; }
    if (op === 'poke') { dirty = true; continue; }   // a tool asking for a new map (bench.mjs sets actDirty)
    const lo = pick(N), hi = Math.min(N - 1, lo + pick(BOX_MAX));
    const w = { lo, hi, vals: [], all: [] };
    for (let p = 0; p < N; p++) {
      w.vals.push(rnd() < WRITE_SHARE ? (op === 'life' ? { l: pick(LIVES) } : { v: pick(VALUES) }) : {});
      w.all.push(rnd() < LOAD_SHARE ? { v: pick(VALUES) } : {});
    }
    const d = rnd() < 0.5 ? -SHIFT : SHIFT;
    const wantMap = op === 'mapByHand' || (op === 'step' && (dirty || age >= ACTIVITY_PERIOD));
    if (wantMap) { for (const s of sims) buildMap(s, quiet); age = 0; dirty = false; if (op === 'mapByHand') mapsByHand++; }
    for (const s of sims) {
      if (op === 'step') step(s);
      else if (op === 'brush' || op === 'life') copyThrough(s, w, true);
      else if (op === 'brushNoBox') copyThrough(s, w, false);
      else if (op === 'current') currentOnly(s, w);
      else if (op === 'sync') syncCopies(s);
      else if (op === 'shift') shift(s, d);
    }
    if (op === 'step') { age++; total += NS; skipped += sims[1].drawn.filter((x) => !x).length; }
    else if (op !== 'mapByHand') dirty = true;
    ops++;
    const [A, B] = sims;
    for (const k of [0, 1]) {
      const ca = A.C[k ? 1 - A.cur : A.cur], cb = B.C[k ? 1 - B.cur : B.cur];
      for (let p = 0; p < N; p++) {
        if (ca[p].v !== cb[p].v || ca[p].l !== cb[p].l || ca[p].f !== cb[p].f) {
          console.log(`run ${run} op ${t} (${op}): ${k ? 'other' : 'current'} copy, cell ${p}: ${JSON.stringify(ca[p])} drawn, ${JSON.stringify(cb[p])} skipped`);
          process.exit(1);
        }
      }
    }
  }
}
console.log(`model OK: ${ops} operations (${mapsByHand} maps built by hand), both copies identical throughout;`
  + ` ${(100 * skipped / total).toFixed(1)}% of supertile-steps skipped`);
