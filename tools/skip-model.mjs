// CPU model check of brick-granular sleeping (docs/webgpu.md D5, shaders/activity.js),
// in 1-D: the step as the WebGPU build runs it, twice from the same start under the
// same activity maps and writes, once with every unit DRAWN (skipSleeping = false) and
// once skipping by the rules, at both unit sizes (a brick, and two bricks for
// docs/scaling.md D8's supertile). Modelled as the shaders do it:
//   - the move in place on the current copy (or, at random, out of place into the
//     other copy: whitewater's mode, P.outOfPlace), one thread per Margolus block;
//     a block runs iff any of its cells lies in a DRAWN unit; its home unit's list is
//     DRAWN at offset 0 and MOVE1 (DRAWN dilated a unit toward -x) at offset 1, and
//     the low margin's block (base -1) is a dispatch of its own; a block with a quiet
//     base only settles flags (in place) or copies through (out of place);
//   - react from the moved copy into the other, every cell of a DRAWN unit, a quiet
//     brick written back with settled flags;
//   - the activity flags' writtenFlags and freshFlags, the flow field;
//   - the map: AWAKE = a non-quiet brick in the unit or just below it, forced = the
//     writers' marks (only bricks whose cells they changed), the run counter, DRAWN;
//   - writes: in-place box edits (brushes, life-only edits), whole-grid writes of the
//     current copy (load, undo, unpack: forceAll), syncCopies (an exact copy, no
//     forcing), a shift (out of place, fresh flags, forceAll), maps built by hand,
//     a tool asking for a new map.
// The quiet maps are random and drift: the rules must hold whatever they are, since
// a map is the same function of the same state in both runs. Both state copies must
// agree after every operation, values and flags, and so must the flow field. It also
// asserts that DRAWN stays bounded with one-step maps and a write every step (D5.3).
// Then each negative control (a rule D5 names, broken) must make the model fail.
// A cell is v (what neighbour tests read: element, temperature), l (what they don't:
// life, velocity) and f (the activity flags). Exits 1 if the rules fail or a control
// passes.
// usage: node tools/skip-model.mjs [seed] [runs] [operations per run]
const SELF = 1, NEAR = 2, MATTER = 4, DIRTY = 8;   // shaders/common.js FLAG
const ACTIVITY_PERIOD = 2;    // steps a map stays valid (sim.js)
const SETTLE_STEPS = 2;       // shaders/activity.js SUPER_SETTLE_STEPS
const RUN_MAX = 255;          // shaders/common.js ACT_MAP.RUN_MAX
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
const FLOW_BLEND = 0.05;      // the flow field's blend (shaders/move.js)
const BOX_MAX = 10;           // cells a brush's box spans, at most
const WRITE_SHARE = 0.6;      // share of a box's cells a brush changes
const LOAD_SHARE = 0.3;       // share of cells a load, undo or unpack changes
const QUIET_SHARE = 0.75;     // a drifting map: bricks quiet...
const DRIFT_SHARE = 0.3;      // ...and the share of them redrawn per drift
const OOP_SHARE = 0.3;        // steps the skipping run takes out of place (whitewater)
// operations and their cumulative odds per turn
const MIX = [['step', 0.62], ['brush', 0.72], ['life', 0.76], ['current', 0.78], ['sync', 0.81],
  ['shift', 0.83], ['mapByHand', 0.86], ['poke', 0.88], ['drift', 1]];
// the bounded-DRAWN scenario: maps of one step, a write after each
const BOUNDED_MAPS = 400;
const BOUNDED_QUIET = 0.9;    // its quiet maps' share of quiet bricks

const argv = process.argv.slice(2);
const SEED = +(argv[0] ?? 1), RUNS = +(argv[1] ?? 300), OPS = +(argv[2] ?? 300);
let seed = SEED;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };   // Numerical Recipes' LCG
const hash = (...xs) => { let h = 2166136261; for (const x of xs) { h ^= x & 0xffffffff; h = Math.imul(h, 16777619); h ^= h >>> 13; } return h >>> 0; };   // FNV-1a, mixed
const pick = (n) => Math.floor(rnd() * n);
const own = (c) => ((c.v % ODDS.SELF !== 0 && c.l % ODDS.LIFE === 0) ? SELF : 0) | ((c.v % ODDS.MATTER !== 0) ? MATTER : 0);
const fresh = (c) => own(c) | DIRTY;
// writtenFlags (shaders/common.js): a new v is fresh, a new l redoes SELF, else the flags stay
const written = (f, a, o) => (o.v !== a.v ? fresh(o) : o.l !== a.l ? (own(o) & SELF ? f | SELF : f & ~SELF) : f);

// The model: N cells, BS cells a brick, U bricks a unit, and the rules (a
// control breaks one).
function makeModel({ N = 64, BS = 4, U = 1, rule = {} } = {}) {
  const NB = Math.ceil(N / BS), NU = Math.ceil(NB / U);
  const brickOf = (p) => Math.floor(Math.min(Math.max(p, 0), N - 1) / BS);
  const unitOf = (p) => Math.floor(brickOf(p) / U);

  function make(skip) {
    const C = [[], []];
    for (let p = 0; p < N; p++) {
      const c = { v: hash(p, 1) % VALUES, l: hash(p, 2) % LIVES };
      C[0].push({ ...c, f: fresh(c) });
      C[1].push({ v: 0, l: 0, f: 0 });
    }
    return {
      skip, C, cur: 0, frame: 0, fresh: false, nsteps: 0, wrote: false,
      flow: new Array(N).fill(0),
      map: Array.from({ length: NU }, () => ({ awake: false, drawn: false, run: 0 })),
      marks: new Set(), forceAll: true,
      quiet: new Array(NB).fill(false), drawn: null, awake: null, move1: null,
    };
  }

  // a writer changed brick b's cells (docs/webgpu.md D6): the next map forces its unit
  const mark = (s, b) => { if (!rule.noMarks) s.marks.add(b); };

  // the map (shaders/activity.js drawn, move1) with the activity map `quiet`
  function buildMap(s, quiet) {
    s.quiet = quiet.slice();
    const drawn = [], awakeList = [];
    for (let u = 0; u < NU; u++) {
      let awake = false;
      for (let b = u * U - 1; b < (u + 1) * U; b++) if (b >= 0 && b < NB && !quiet[b]) awake = true;
      let forced = s.forceAll;
      for (let b = u * U; b < (u + 1) * U; b++) if (s.marks.has(b)) forced = true;
      const m = s.map[u];
      let d;
      if (rule.oldRule) {
        // docs/scaling.md D8's rule: prevSettled = two steps, or one and a write since
        const settled = s.nsteps >= SETTLE_STEPS || (s.nsteps > 0 && s.wrote);
        d = awake || forced || (settled ? m.awake : m.drawn);
      } else {
        let run = 0;
        if ((!forced || rule.runNotReset) && m.drawn && (!m.awake || rule.runCountsAwake)) run = Math.min(m.run + s.nsteps, RUN_MAX);
        m.run = run;
        d = awake || forced || (m.drawn && run < SETTLE_STEPS);
      }
      m.awake = awake;
      m.drawn = d;
      drawn.push(d || !s.skip);
      awakeList.push(awake);
    }
    s.drawn = drawn;
    s.awake = awakeList;
    // MOVE1: a unit of u + {0, 1} is DRAWN (without the dilation: DRAWN itself)
    s.move1 = drawn.map((d, u) => d || (!rule.noDilation && u + 1 < NU && drawn[u + 1]));
    s.marks.clear();
    s.forceAll = false;
    s.fresh = true;
    s.nsteps = 0;
  }

  function step(s, outOfPlace) {
    s.frame++;
    s.nsteps++;
    s.wrote = false;
    const par = s.frame & 1, q = s.quiet;
    const src = s.C[s.cur], dstMove = outOfPlace ? s.C[1 - s.cur] : src;
    const fresh0 = s.fresh;
    s.fresh = false;
    const drawnCell = (p) => s.drawn[unitOf(p)];
    // the move: blocks based at 2j + par, listed by their home unit per offset,
    // the low margin's (base -1) on their own; then the per-block test
    const moved = [];   // [cell, content, its source, quiet base]: each thread writes only its own cells
    for (let j = -1; 2 * j + par < N; j++) {
      const base = 2 * j + par;
      if (base < 0 && par === 0) continue;
      const cells = [base, base + 1].filter((p) => p >= 0 && p < N);
      if (base >= 0 && !(par === 0 ? s.drawn : s.move1)[unitOf(base)]) continue;
      const run = rule.baseOnly ? (base >= 0 && drawnCell(base)) : cells.some(drawnCell);
      if (!run) continue;
      if (q[brickOf(base)]) {
        for (const p of cells) moved.push([p, { v: src[p].v, l: src[p].l }, p, true]);
        continue;
      }
      const h = hash(base, s.frame);
      let out = cells.map((p) => ({ v: src[p].v, l: src[p].l }));
      let from = cells.slice();
      if (out.length === 2 && h % ODDS.BLOCK === 0) { out = [out[1], out[0]]; from = [cells[1], cells[0]]; }
      else if (h % ODDS.BLOCK === 1) out[0] = { v: out[0].v, l: (out[0].l + 1) % LIVES };   // velocity only
      else if (h % ODDS.BLOCK === 2 && h % ODDS.HEAT === 0) out[0] = { v: (out[0].v + 1) % VALUES, l: out[0].l };   // impact heat
      cells.forEach((p, i) => moved.push([p, out[i], from[i], false]));
    }
    for (const [p, c, from, quietBase] of moved) {
      let f = src[p].f;
      if (fresh0) f &= ~DIRTY;
      if (!quietBase && c.v !== src[p].v) f |= DIRTY;
      dstMove[p] = { ...c, f };
      if (!q[brickOf(p)]) s.flow[p] = Math.fround(FLOW_BLEND * (p - from) + (1 - FLOW_BLEND) * s.flow[p]);
    }
    // react, from the moved copy into the other
    const I = dstMove, O = outOfPlace ? s.C[s.cur] : s.C[1 - s.cur];
    const out = [];
    for (let p = 0; p < N; p++) {
      if (!drawnCell(p)) continue;
      const a = I[p], dirty = a.f & DIRTY;
      if (q[brickOf(p)]) { out.push([p, { v: a.v, l: a.l, f: own(a) | NEAR | dirty }]); continue; }
      const lv = p > 0 ? I[p - 1].v : OUTSIDE, rv = p < N - 1 ? I[p + 1].v : OUTSIDE;
      const h = hash(p, s.frame, lv, a.v, rv, a.l);
      const o = { v: h % ODDS.REACT_V === 0 ? (a.v + lv + rv) % VALUES : a.v, l: h % ODDS.REACT_L === 0 ? (a.l + 1) % LIVES : a.l };
      let f = own(o) | dirty;
      if ((f & SELF) && hash(o.v, lv, rv) % ODDS.NEAR) f |= NEAR;
      if (o.v !== a.v) f |= DIRTY;
      out.push([p, { ...o, f }]);
    }
    for (const [p, c] of out) O[p] = c;
    if (!outOfPlace) s.cur = 1 - s.cur;
  }

  // writes that aren't steps; `w` holds their random choices, the same for both runs
  function edit(s, w) {   // a brush, a tool: in place over [lo, hi], marking the bricks it changed
    const C0 = s.C[s.cur];
    for (let p = w.lo; p <= w.hi; p++) {
      const a = C0[p], o = { v: a.v, l: a.l, ...w.vals[p] };
      if (o.v === a.v && o.l === a.l) continue;   // writeCell stores only a change
      C0[p] = { ...o, f: written(a.f, a, o) };
      mark(s, brickOf(p));
    }
    s.wrote = true;
  }
  function currentOnly(s, w) {   // load, undo, codec unpack: the current copy, forceAll
    const C0 = s.C[s.cur];
    for (let p = 0; p < N; p++) { const o = { v: C0[p].v, l: C0[p].l, ...w.all[p] }; C0[p] = { ...o, f: fresh(o) }; }
    s.forceAll = true;
    s.wrote = true;
  }
  function syncCopies(s) {   // three buffer copies, flags included: no forcing
    s.C[1 - s.cur] = s.C[s.cur].map((c) => ({ ...c }));
  }
  function shift(s, d) {   // out of place, fresh flags, the flow follows; forceAll
    const C0 = s.C[s.cur], C1 = s.C[1 - s.cur], flow = s.flow.slice();
    for (let p = 0; p < N; p++) {
      const q = p + d, inside = q >= 0 && q < N, o = inside ? { v: C0[q].v, l: C0[q].l } : { v: 0, l: 0 };
      C1[p] = { ...o, f: fresh(o) };
      s.flow[p] = inside ? flow[q] : 0;
    }
    s.cur = 1 - s.cur;
    s.forceAll = true;
    s.wrote = true;
  }
  return { N, BS, U, NB, NU, make, buildMap, step, edit, currentOnly, syncCopies, shift };
}

function compare([A, B], N) {
  for (let p = 0; p < N; p++) if (A.flow[p] !== B.flow[p]) return `flow at cell ${p}: ${A.flow[p]} all drawn, ${B.flow[p]} skipped`;
  for (const k of [0, 1]) {
    const ca = A.C[k ? 1 - A.cur : A.cur], cb = B.C[k ? 1 - B.cur : B.cur];
    for (let p = 0; p < N; p++) {
      if (ca[p].v !== cb[p].v || ca[p].l !== cb[p].l || ca[p].f !== cb[p].f) {
        return `${k ? 'other' : 'current'} copy, cell ${p}: ${JSON.stringify(ca[p])} all drawn, ${JSON.stringify(cb[p])} skipped`;
      }
    }
  }
  return null;
}

// Maps of one step and a write every step (Speed 1 while painting, D5.3):
// unit u DRAWN under map k only if it was AWAKE or forced under one of maps k-2..k.
function boundedCheck(M) {
  const s = M.make(true);
  const quiet = new Array(M.NB).fill(true);
  const last = new Array(M.NU).fill(0);   // the last map a unit was AWAKE or forced under (map 0 forces all)
  for (let k = 0; k < BOUNDED_MAPS; k++) {
    for (let b = 0; b < M.NB; b++) if (rnd() < DRIFT_SHARE) quiet[b] = rnd() < BOUNDED_QUIET;
    const forced = new Set([...s.marks].map((b) => Math.floor(b / M.U)));
    M.buildMap(s, quiet);
    for (let u = 0; u < M.NU; u++) {
      if (s.awake[u] || forced.has(u)) last[u] = k;
      if (s.drawn[u] && k - last[u] > 2) return `bounded: unit ${u} DRAWN under map ${k}, last AWAKE or forced under map ${last[u]}`;
    }
    M.step(s, false);
    const p = pick(M.N);
    M.edit(s, { lo: p, hi: p, vals: Object.assign([], { [p]: { v: pick(VALUES) } }) });
  }
  return null;
}

// Runs the model; null-free result { skipped } if both runs agree throughout
// and DRAWN stays bounded, else a string saying what differed first.
function check(cfg, { runs = RUNS, ops = OPS, seed0 = SEED } = {}) {
  seed = seed0;
  const M = makeModel(cfg);
  const shiftBy = 2 * M.BS * M.U;   // a shift moves whole units
  let skipped = 0, total = 0;
  for (let run = 0; run < runs; run++) {
    const sims = [M.make(false), M.make(true)];
    const quiet = new Array(M.NB).fill(false);
    let age = ACTIVITY_PERIOD, dirty = true;
    for (let t = 0; t < ops; t++) {
      const r = rnd(), op = MIX.find(([, odds]) => r < odds)[0];
      // the quiet map drifts (sticky), like a world settling and stirring
      if (op === 'drift') { for (let b = 0; b < M.NB; b++) if (rnd() < DRIFT_SHARE) quiet[b] = rnd() < QUIET_SHARE; continue; }
      if (op === 'poke') { dirty = true; continue; }   // a tool asking for a new map (bench.mjs sets actDirty)
      const lo = pick(M.N), hi = Math.min(M.N - 1, lo + pick(BOX_MAX));
      const w = { lo, hi, vals: [], all: [] };
      for (let p = 0; p < M.N; p++) {
        w.vals.push(rnd() < WRITE_SHARE ? (op === 'life' ? { l: pick(LIVES) } : { v: pick(VALUES) }) : {});
        w.all.push(rnd() < LOAD_SHARE ? { v: pick(VALUES) } : {});
      }
      const d = rnd() < 0.5 ? -shiftBy : shiftBy;
      const oop = rnd() < OOP_SHARE;
      const wantMap = op === 'mapByHand' || (op === 'step' && (dirty || age >= ACTIVITY_PERIOD));
      if (wantMap) { for (const s of sims) M.buildMap(s, quiet); age = 0; dirty = false; }
      for (const s of sims) {
        if (op === 'step') M.step(s, s.skip && oop);
        else if (op === 'brush' || op === 'life') M.edit(s, w);
        else if (op === 'current') M.currentOnly(s, w);
        else if (op === 'sync') M.syncCopies(s);
        else if (op === 'shift') M.shift(s, d);
      }
      if (op === 'step') { age++; total += M.NU; skipped += sims[1].drawn.filter((x) => !x).length; }
      else if (op !== 'mapByHand') dirty = true;
      const diff = compare(sims, M.N);
      if (diff) return `run ${run} op ${t} (${op}): ${diff}`;
    }
  }
  return boundedCheck(M) ?? { skipped: skipped / total };
}

let failed = 0;
for (const [name, U] of [['brick', 1], ['supertile', 2]]) {
  const r = check({ U });
  if (typeof r === 'string') { failed++; console.log(`FAIL ${name} units: ${r}`); }
  else console.log(`ok   ${name} units: ${RUNS} runs × ${OPS} operations, both copies and the flow identical throughout, DRAWN bounded; ${(100 * r.skipped).toFixed(1)}% of unit-steps skipped`);
}
// The negative controls (docs/webgpu.md D5): each broken rule must fail, at one unit size or the other.
const CONTROLS = [
  ['the old wroteSinceStep clause with in-place writers', { rule: { oldRule: true } }],
  ['MOVE1 without the -x dilation', { rule: { noDilation: true } }],
  ['MOVE0 = DRAWN with blocks that cross a unit face (an odd unit: 3-cell bricks)', { BS: 3, N: 63 }],
  ['the per-block test on the base cell only', { rule: { baseOnly: true } }],
  ['forced marks dropped', { rule: { noMarks: true } }],
  ['run not reset by a write', { rule: { runNotReset: true } }],
  ['run counting steps of maps where the unit was AWAKE', { rule: { runCountsAwake: true } }],
];
for (const [name, cfg] of CONTROLS) {
  let caught = null;
  for (const U of [1, 2]) {
    const r = check({ U, ...cfg });
    if (typeof r === 'string') { caught = `${U === 1 ? 'brick' : 'supertile'} units, ${r}`; break; }
  }
  if (caught) console.log(`ok   control fails as it must: ${name}\n       (${caught.slice(0, 150)})`);
  else { failed++; console.log(`FAIL control passed: ${name}`); }
}
console.log(failed ? `skip-model: ${failed} failure(s)` : 'skip-model: the rules hold, and every control fails');
process.exit(failed ? 1 : 0);
