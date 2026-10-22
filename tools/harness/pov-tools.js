// The first person's tools, body and engine work in the harness (U11;
// docs/webgpu.md G2, I1): the real tool code (the toolbelt, the flask, the
// axe, the physgun), the real body (pov/player.js) and the engine's breaking
// and blast rules, each on a Simulation of this page's device (32³ for the
// tools, 64³ for the axe, the body and the engine), no app, so no app boot and
// no first-person drop-in before the check. A frame is what the app's tick
// does with them: the tools' or the body's update, the frame's steps, the GPU
// done with them, their answers landed. Game time is the frames' dt, never
// the wall's.
//   toolbelt   (tools/pov-tools-a.mjs; parts shovel, bucket) the hotbar's keys and wheel; the
//              shovel scoops and throws sand, breaks rock into stone, refuses WALL; the bucket
//              scoops and pours water, keeps lava hot; takes and puts overlapping in flight:
//              every phase's grid census plus every load is exactly what it was (stone for
//              rock, cell for cell)
//   flask      (tools/flask-check.mjs, part 1) the flask's pour, scoop, drink, mixed scoop and
//              drink, and throw: conserved, the shatter adding exactly FLASK_GLASS shards
//   hand       (tools/pov-tools-b.mjs) the axe on six materials (what breaks, into what, nothing
//              made or lost), the physgun lifting sand and water to a hold point and flinging it
//   char       (tools/gibs-check.mjs --gpu, part burn) cooked meat under its flash point stays,
//              past it burns to ash
//   meat       (tools/gibs-check.mjs --gpu, part lay) a body's burst laid as meat exactly (in the
//              open, buried), cooked meat eaten exactly
//   player:<tests>  (tools/pov-player-check.mjs) the body in small scenes: its numbers
//   engine:<scene>  (tools/pov-engine-check.mjs) impact breaking, heat and blasts: its numbers

import { boot, ready, test, log, nativeSim } from './harness.js';
import { Simulation, cellTexel } from '/src/sim.js';
import { E, ELEMENTS, K } from '/src/elements.js';
import { SEED_MAX } from '/src/shaders/common.js';
import { preparePov } from '/src/pov/gpu.js';
import * as THREE from 'three';

const h = await boot({ label: 'pov-tools' });
const gpu = h.gpu;

// a stage's progress, as it goes (tools/pov-gpu-check.mjs prints these lines: a run cut short still says how far it got)
let stageT0 = performance.now();
const progress = (what) => console.log(`· ${what} (${((performance.now() - stageT0) / 1000).toFixed(0)} s)`);
const check = (out, name, ok, detail = '') => {
  out.checks.push({ name, ok: Boolean(ok), detail: ok ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
  progress(`${ok ? 'ok' : 'FAIL'}: ${name}`);
  return ok;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const STEPS = 4;          // sim steps a frame (the app's default)
const DT = 1 / 60;        // s a frame (the app's tick at 60 Hz)
// The toolbelt's and the flask's frames: 30 a second of tool time and 2 steps
// each (ctx.stepsPerFrame says so, so the tools' velocities match), on a 32³
// world: what they check is matter conserved with transfers in flight across
// steps, which doesn't need the app's step rate, and SwiftShader shared by two
// agents is slow (docs/webgpu.md I1).
const TOOL_STEPS = 2;
const TOOL_DT = 1 / 30;
const NOTICE_WAIT_MS = 1600;   // ms: past a tool's notice interval (tools/index.js NOTICE_INTERVAL)
const THROW_FRAMES = 8;   // frames a click's button is held (past the tools' refires: the shovel's 0.2 s throw)
const STRESS_FRAMES = 150;   // frames of four overlapping transfers each: 600 transfers, the old pov-tools-a's

// A simulation at n³ with its POV kernels built.
async function make(n = 64, opts = {}) {
  stageT0 = performance.now();
  const sim = await nativeSim(gpu, n, n, n, { debug: false, ...opts });
  const t0 = performance.now();
  await preparePov(sim);
  log(`pov kernels for ${n}³: ${Math.round(performance.now() - t0)} ms`);
  progress(`a ${n}³ world and its POV kernels built`);
  return sim;
}
// One frame: fn (the tools' or the body's update), the frame's steps, the GPU
// done with them and the answers they made landed.
async function frame(sim, fn, steps = sim.frameSteps ?? STEPS) {
  fn?.();
  for (let i = 0; i < steps; i++) sim.step();
  await gpu.fence();
  await tick();
}
// Loads a scene built on the CPU: fill(set, g), set(x, y, z, id, { temp, life, vel }).
function load(sim, fill) {
  const g = sim.g, [A, B] = sim.blankState();
  const set = (x, y, z, id, { temp, life, vel } = {}) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const i = cellTexel(g, x, y, z) * 4, e = ELEMENTS[id];
    A[i] = id; A[i + 1] = temp ?? e.temp; A[i + 2] = life ?? e.life; A[i + 3] = Math.random() * SEED_MAX;
    if (vel) B.set(vel, i);
  };
  fill(set, g);
  sim.load(A, B);
}
// The cells as they are now, read back once: an element by cell, a column's top, every cell of an element.
async function snap(sim) {
  const [A, B] = await sim.readState(), g = sim.g;
  const at = (x, y, z) => cellTexel(g, x, y, z) * 4;
  const id = (x, y, z) => Math.round(A[at(x, y, z)]);
  return {
    A, B, at, id,
    top(x, z) { for (let y = g.ny - 1; y >= 0; y--) if (id(x, y, z) !== E.EMPTY) return y; return -1; },
    cells(want) {
      const out = [];
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = at(x, y, z);
        if (Math.round(A[i]) === want) out.push({ x, y, z, T: A[i + 1], v: [B[i], B[i + 1], B[i + 2]] });
      }
      return out;
    },
  };
}
// Matter by element key: the grid's census (air aside) plus every load.
async function totals(sim, loads = []) {
  const c = await sim.census(), t = {};
  for (const k in c) if (+k !== E.EMPTY) t[ELEMENTS[k].key] = c[k].n;
  for (const l of loads) for (const [id, n] of Object.entries(l.totals())) t[ELEMENTS[id].key] = (t[ELEMENTS[id].key] ?? 0) + n;
  return t;
}
const diff = (x, y) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])]
  .map((k) => [k, (y[k] ?? 0) - (x[k] ?? 0)]).filter(([, d]) => d));
const zero = (d) => Object.keys(d).length === 0;
// What a tool's env holds without the app: no renderer (the transfer engine's key is this env's
// own object), a scene and a viewmodel group nobody draws, the grid's transform at the world's
// origin, scale 1.
function toolEnv(sim, toasts, extra = {}) {
  const volume = new THREE.Object3D();   // (the app's volume: the grid's transform, at the origin here)
  return {
    renderer: {}, scene: new THREE.Scene(), getSim: () => sim, getVolume: () => volume, getScale: () => 1,
    hud: { toast: (t) => toasts.push(t) }, viewmodel: new THREE.Group(), isActive: () => true, ...extra,
  };
}
// A tool's ctx: the eye above and before the aim cell, looking at it (or ahead at nothing).
function toolCtx(sim, player, aimCell, id, extra = {}) {
  const eye = aimCell ? V(aimCell.x + 0.5, aimCell.y + 3.5, aimCell.z - 1.5) : V(sim.g.nx / 2, 8, sim.g.nz / 2);
  const dir = aimCell ? V(aimCell.x + 0.5, aimCell.y + 0.5, aimCell.z + 0.5).sub(eye).normalize() : V(0, -0.5, 1).normalize();
  return {
    sim, dt: TOOL_DT, stepsPerFrame: TOOL_STEPS, eye, dir, toolRate: 1,
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
    aim: aimCell ? { valid: true, cell: aimCell, face: 2, id, T: 20, P: 0, dist: 3 } : { valid: false },
    player, drink: false, drinkPressed: false, ...extra,
  };
}
const paint = (sim, center, radius, tool, shape = 1) => sim.paint({ center: V(...center), radius, shape, tool, rate: 4, replace: true });

// ---------------------------------------------------------------- toolbelt
test('stage:toolbelt', async ({ parts = ['shovel', 'bucket'] } = {}) => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(32);
  sim.frameSteps = TOOL_STEPS;
  const { createToolbelt } = await import('/src/pov/tools/index.js');
  const { Load, cellsNear } = await import('/src/pov/tools/transfer.js');
  const { gearByKey } = await import('/src/pov/tools/catalog.js');
  const toasts = [];
  const belt = createToolbelt(toolEnv(sim, toasts));
  belt.setVisible(true);
  const player = { pos: V(2, 0, 2), vel: V(), onGround: true, inLiquid: false, applyImpulse() {} };
  const ctx = (cell, id, extra) => toolCtx(sim, player, cell, id, extra);
  const settle = async () => { for (let i = 0; i < 300 && belt.transfer.pending; i++) await frame(sim); await frame(sim); await frame(sim); };
  try {
    // ---- the scene (pov-tools-a's, on 32³): a sand heap, a water pool in a wall basin, a rock block
    paint(sim, [8, 3, 8], 3, E.SAND);
    paint(sim, [23, 2, 23], 5, E.WALL);
    paint(sim, [23, 3, 23], 4, E.WATER);
    paint(sim, [8, 3, 23], 2, E.ROCK);
    for (let i = 0; i < 10; i++) await frame(sim);
    progress('the scene settled');

    let S = null;
    if (parts.includes('shovel')) {
      // ---- hotbar: a number key picks its slot, the wheel the next tool
      dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      const keySel = belt.selected;
      belt.update(ctx(null, -1, { wheel: 1 }));
      const wheelSel = belt.selected;
      check(out, 'hotbar: key 2 picks a tool of slot 2, the wheel the next', gearByKey(keySel)?.slot === 1 && wheelSel !== keySel, { keySel, wheelSel });

      // ---- shovel: scoop sand, throw it elsewhere
      belt.select('SHOVEL');
      const shovel = belt.tool('SHOVEL'), pack = shovel.load;
      const t0 = await totals(sim, [pack]);
      for (let i = 0; i < 120 && pack.count + pack.reserved < 30; i++) {
        if (i % 8 === 0) S = await snap(sim);   // (the aim follows the heap's top about once a scoop: SCOOP_INTERVAL)
        const y = S.top(8, 8);
        await frame(sim, () => belt.update(ctx(V(8, y, 8), S.id(8, y, 8), { primary: true })));
      }
      await settle();
      const t1 = await totals(sim, [pack]);
      out.numbers.shovelScoop = { load: pack.status(), diff: diff(t0, t1) };
      check(out, 'shovel: scoops sand into the pack, grid + pack conserved exactly', pack.totals()[E.SAND] >= 30 && zero(diff(t0, t1)), out.numbers.shovelScoop);
      // right-click throws a block's worth at the floor ahead (aimed at the top of what's there by then),
      // the button held for THROW_FRAMES frames as a player's click is (throws have a refire)
      const throwAt = async (x, z) => {
        const T = await snap(sim), y = T.top(x, z);
        for (let f = 0; f < THROW_FRAMES; f++) await frame(sim, () => belt.update(ctx(V(x, y, z), T.id(x, y, z), { secondary: true, secondaryPressed: f === 0 })));
        await settle();
      };
      for (let i = 0; i < 8 && pack.count; i++) await throwAt(16, 12 + (i % 3));
      for (let i = 0; i < 10; i++) await frame(sim);
      const t2 = await totals(sim, [pack]);
      check(out, 'shovel: throws the load back into the world, nothing lost', pack.count === 0 && zero(diff(t0, t2)), { left: pack.count, diff: diff(t0, t2) });

      // ---- shovel on rock: rock is the pickaxe's (dig.js materials): it refuses, naming the tool, and takes nothing
      const r0 = await totals(sim, [pack]);
      S = await snap(sim);
      toasts.length = 0;
      for (let f = 0; f < THROW_FRAMES; f++) {
        const y = S.top(8, 23);
        await frame(sim, () => belt.update(ctx(V(8, y, 23), S.id(8, y, 23), { primary: true, primaryPressed: f === 0 })));
      }
      await settle();
      const dr = diff(r0, await totals(sim, [pack]));
      out.numbers.shovelRock = { toasts: toasts.slice(), diff: dr };
      check(out, 'shovel: rock refuses, naming the pickaxe, and nothing moves', zero(dr) && toasts.some((t) => /pickaxe/i.test(String(t?.text ?? t))), out.numbers.shovelRock);
      // WALL refuses (the basin's rim), on a click held past the last dig's refire (and past the
      // rock's notice: a tool's notices come at most once per NOTICE_INTERVAL, tools/index.js)
      await new Promise((r) => setTimeout(r, NOTICE_WAIT_MS));
      toasts.length = 0;
      for (let f = 0; f < THROW_FRAMES; f++) belt.update(ctx(V(18, 7, 23), E.WALL, { primary: true, primaryPressed: f === 0 }));
      check(out, 'shovel: WALL refuses, with a toast', toasts.length > 0, toasts);
      // a bite of sand with wood in it: the sand comes up, the wood (the axe's) stays put
      paint(sim, [25, 4, 7], 3, E.SAND);
      for (let i = 0; i < 6; i++) await frame(sim);
      const woodAt = [V(25, 4, 7), V(24, 3, 7)];
      for (const w of woodAt) paint(sim, [w.x + 0.5, w.y + 0.5, w.z + 0.5], 0.5, E.WOOD);
      await frame(sim);
      const m0 = await totals(sim, [pack]);
      const W0 = await snap(sim), woodBefore = woodAt.filter((w) => W0.id(w.x, w.y, w.z) === E.WOOD).length;
      await frame(sim, () => belt.update(ctx(V(25, 5, 7), E.SAND, { primary: true, primaryPressed: true })));
      await settle();
      const W1 = await snap(sim), woodAfter = woodAt.filter((w) => W1.id(w.x, w.y, w.z) === E.WOOD).length, dm = diff(m0, await totals(sim, [pack]));
      out.numbers.shovelMixed = { woodBefore, woodAfter, diff: dm, sand: pack.totals()[E.SAND] ?? 0 };
      check(out, 'shovel: a bite takes the sand around wood and leaves the wood', woodBefore > 0 && woodAfter === woodBefore && zero(dm) && !pack.totals()[E.WOOD] && !pack.totals()[E.SAWDUST], out.numbers.shovelMixed);
      for (let i = 0; i < 8 && pack.count; i++) await throwAt(16, 6 + (i % 3));
      for (let i = 0; i < 10; i++) await frame(sim);

      // ---- pickaxe: one blow brings the whole outlined lattice block of rock up as stone (dig.js)
      paint(sim, [15, 5, 15], 5, E.ROCK);
      for (let i = 0; i < 4; i++) await frame(sim);
      belt.select('PICKAXE');
      const k0 = await totals(sim, [pack]);
      await frame(sim, () => belt.update(ctx(V(13, 5, 13), E.ROCK, { primary: true, primaryPressed: true })));
      await settle();
      const k1 = await totals(sim, [pack]), dk = diff(k0, k1), B = await snap(sim);
      let left = 0;
      for (let x = 12; x < 15; x++) for (let y = 3; y < 6; y++) for (let z = 12; z < 15; z++) if (B.id(x, y, z) !== E.EMPTY) left++;
      out.numbers.pickBlock = { diff: dk, left };
      check(out, 'pickaxe: one blow digs the 3³ block of rock, all of it into the pack as stone', dk.ROCK === -27 && dk.STONE === 27 && Object.keys(dk).length === 2 && left === 0, out.numbers.pickBlock);
      belt.select('SHOVEL');
      for (let i = 0; i < 8 && pack.count; i++) await throwAt(16, 6 + (i % 3));
      for (let i = 0; i < 10; i++) await frame(sim);
    }

    if (parts.includes('bucket')) {
      const pack = belt.tool('SHOVEL').load;   // (empty here: it counts in the totals all the same)
      // ---- bucket: scoop water
      belt.select('BUCKET');
      const bucket = belt.tool('BUCKET'), pail = bucket.load;
      const w0 = await totals(sim, [pack, pail]);
      for (let i = 0; i < 60 && pail.count + pail.reserved < 60; i++) {
        if (i % 5 === 0) S = await snap(sim);
        const y = S.top(23, 23);
        await frame(sim, () => belt.update(ctx(V(23, y, 23), S.id(23, y, 23), { primary: true, primaryPressed: i === 0 })));
      }
      await settle();
      const w1 = await totals(sim, [pack, pail]);
      out.numbers.bucketScoop = { load: pail.status(), diff: diff(w0, w1) };
      check(out, 'bucket: scoops water, grid + bucket conserved exactly', (pail.totals()[E.WATER] ?? 0) > 0 && zero(diff(w0, w1)), out.numbers.bucketScoop);
      // ---- stress: overlapping takes and puts in flight together, the sim running
      const tx = belt.transfer, g = sim.g;
      const LA = new Load(200), LB = new Load(200);
      paint(sim, [14, 3, 14], 3, E.SAND);
      for (let i = 0; i < 10; i++) await frame(sim);
      const loads = [pack, pail, LA, LB];
      const s0 = await totals(sim, loads);
      let ops = 0, moved = 0;
      const c = V(14.5, 2, 14.5), up = V(14.5, 6, 14.5);
      for (let i = 0; i < STRESS_FRAMES; i++) {
        const r = [
          tx.take(LA, { cells: cellsNear(c, 3, g), kinds: [2] }),
          tx.put(LA, { cells: cellsNear(up, 3, g), max: 10 }),
          tx.take(LB, { cells: cellsNear(c, 2.5, g), kinds: [2], limit: 7 }),
          tx.put(LB, { cells: cellsNear(c, 3, g), max: 5 }),
        ];
        for (const q of r) if (q) { ops++; q.then((v) => { moved += Array.isArray(v) ? v.length : v; }); }
        await frame(sim);
      }
      await settle();
      const s1 = await totals(sim, loads);
      out.numbers.stress = { ops, moved, inLoads: LA.count + LB.count, diff: diff(s0, s1) };
      check(out, 'transfer: overlapping takes and puts, in flight across steps: grid + loads exact', ops > 50 && moved > 0 && zero(diff(s0, s1)), out.numbers.stress);

      // ---- the player's bucket is bottomless (bucket.tool.js): a pour puts its cells exactly and copies
      // back what landed, so the world gains exactly what landed, of the bucket's liquid, and the bucket stays as full
      const landedBefore = pail.count;
      let landed = 0;
      const put = tx.put;
      tx.put = (load, spec) => { const q = put.call(tx, load, spec); if (load === pail) q?.then((v) => { landed += Array.isArray(v) ? v.length : v; }); return q; };
      const p0 = await totals(sim, [pack, pail, LA, LB]);
      const pourCtx = () => ({ ...ctx(null, -1, { secondary: true }), eye: V(12, 10, 6), dir: V(0.3, -0.2, 0.93).normalize() });
      for (let i = 0; i < 30; i++) await frame(sim, () => belt.update(pourCtx()));
      await settle();
      tx.put = put;
      const dp = diff(p0, await totals(sim, [pack, pail, LA, LB]));
      out.numbers.bucketPour = { landed, bucket: pail.count, diff: dp };
      check(out, 'bucket: pours exactly what lands, and the bottomless bucket copies it back (the world gains just that water)',
        landed > 0 && pail.count === landedBefore && Object.keys(dp).length === 1 && dp.WATER === landed, out.numbers.bucketPour);

      // ---- lava keeps its temperature in the bucket
      paint(sim, [26, 1, 6], 2, E.LAVA);
      for (let i = 0; i < 5; i++) await frame(sim);
      S = await snap(sim);
      const ly = S.top(26, 6);
      for (let i = 0; i < 3; i++) await frame(sim, () => belt.update(ctx(V(26, ly, 6), E.LAVA, { primary: true, primaryPressed: i === 0 })));
      await settle();
      const hot = pail.cells.filter((c) => c[0] === E.LAVA).map((c) => c[1]);
      out.numbers.lava = { status: pail.status(), T: hot.slice(0, 3).map((t) => +t.toFixed(0)) };
      check(out, 'bucket: lava keeps its heat in the bucket', hot.length > 0 && Math.min(...hot) > 900, out.numbers.lava);
    }

    out.numbers.statuses = [...document.querySelectorAll('.hb-status')].map((e) => e.textContent).filter(Boolean);
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally {
    belt.setVisible(false);
    belt.dispose();
    sim.dispose();
  }
});

// ---------------------------------------------------------------- flask
test('stage:flask', async () => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(32);
  sim.frameSteps = TOOL_STEPS;
  const { createToolbelt } = await import('/src/pov/tools/index.js');
  const { FLASK_CAP, DRINK_CELLS, FLASK_GLASS } = await import('/src/pov/tools/flask.tool.js');
  const { inventory } = await import('/src/pov/tools/inventory.js');
  const toasts = [];
  const belt = createToolbelt(toolEnv(sim, toasts));
  belt.setVisible(true);
  belt.select('FLASK');
  const flask = belt.tool('FLASK');
  const body = { skinT: 37, dead: false, hurts: [], hurt(amount, cause, o) { this.hurts.push({ amount: +amount.toFixed(3), cause, o }); } };
  const player = { pos: V(16, 0, 6), vel: V(), onGround: true, inLiquid: false, applyImpulse() {}, body };
  const ctx = (cell, id, extra) => toolCtx(sim, player, cell, id, extra);
  const extra = new Set();   // a broken flask still spilling
  const all = () => [flask.load, ...extra];
  const settle = async () => { for (let i = 0; i < 300 && (belt.transfer.pending || flask.spilling); i++) await frame(sim); await frame(sim); await frame(sim); };
  const named = (t) => Object.fromEntries(Object.entries(t).map(([id, n]) => [ELEMENTS[id].key, n]));
  try {
    // (flask-check's scene on 32³: a water pool in a wall basin, a sand heap, a wall to throw at)
    paint(sim, [24, 2, 8], 5, E.WALL);
    paint(sim, [24, 3, 8], 4, E.WATER);
    paint(sim, [6, 3, 6], 3, E.SAND);
    paint(sim, [16, 6, 28], 3, E.WALL);
    for (let i = 0; i < 30; i++) await frame(sim);
    progress('the scene settled');
    const start = { inHand: flask.inHand, status: flask.status(), totals: named(flask.load.totals()) };
    check(out, 'flask: starts with one flask of water', start.inHand && start.status === 'WATR 100%' && start.totals.WATER === FLASK_CAP && Object.keys(start.totals).length === 1, start);

    // left-click at nothing in reach pours: the starting water goes into the world
    const t0 = await totals(sim, all());
    const pourCtx = (o) => ({ ...ctx(null, -1, o), eye: V(8, 12, 14), dir: V(0.3, -0.2, 0.93).normalize() });
    for (let i = 0; i < 300 && flask.load.count; i++) await frame(sim, () => belt.update(pourCtx({ primary: true, primaryPressed: i === 0 })));
    await settle();
    const pour = { left: flask.load.count, diff: diff(t0, await totals(sim, all())) };
    check(out, 'flask: pouring puts every cell in the world', pour.left === 0 && zero(pour.diff), pour);

    // empty, it scoops: fill from the pool
    const t1 = await totals(sim, all());
    let S = null;
    for (let i = 0; i < 180 && flask.load.free > 0; i++) {
      if (i % 5 === 0) S = await snap(sim);
      const y = S.top(24, 8);
      await frame(sim, () => belt.update(ctx(V(24, y, 8), S.id(24, y, 8), { primary: true, primaryPressed: i === 0 })));
    }
    await settle();
    const fill = { count: flask.load.count, status: flask.status(), diff: diff(t1, await totals(sim, all())) };
    check(out, 'flask: empty, it scoops from the pool to full', fill.count === FLASK_CAP && zero(fill.diff), fill);
    // full and pointed at the pool: a press pours there instead of scooping
    const tFull = await totals(sim, all());
    S = await snap(sim);
    const py = S.top(24, 8);
    for (let i = 0; i < 6; i++) await frame(sim, () => belt.update(ctx(V(24, py, 8), S.id(24, py, 8), { primary: true, primaryPressed: i === 0 })));
    belt.update(ctx(V(24, py, 8), S.id(24, py, 8)));
    await settle();
    const fullPress = { count: flask.load.count, diff: diff(tFull, await totals(sim, all())) };
    check(out, 'flask: full and aimed at the pool, a press pours (no scoop)', fullPress.count < FLASK_CAP && zero(fullPress.diff), fullPress);

    // a drink: DRINK_CELLS, water quenches a hot skin
    body.skinT = 70;
    const t2 = await totals(sim, all());
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    belt.update(ctx(null, -1));
    const drink = { count: flask.load.count, doses: flask.lastDrink?.doses.map((d) => ({ key: d.key, n: d.n })), skinT: +body.skinT.toFixed(1), hurts: body.hurts.length,
      diff: diff(t2, await totals(sim, all())) };
    check(out, 'flask: a drink takes a full gulp and quenches', drink.doses?.[0]?.key === 'WATER' && drink.doses[0].n === DRINK_CELLS && drink.skinT < 37 && drink.hurts === 0
      && drink.diff.WATER === -DRINK_CELLS && Object.keys(drink.diff).length === 1, drink);

    // pointed at sand with room: it scoops sand in on top (mixed)
    const t3 = await totals(sim, all());
    for (let i = 0; i < 60 && flask.load.free > 0; i++) {
      if (i % 5 === 0) S = await snap(sim);
      const y = S.top(6, 6);
      await frame(sim, () => belt.update(ctx(V(6, y, 6), S.id(6, y, 6), { primary: true, primaryPressed: i === 0 })));
    }
    await settle();
    const mix = { status: flask.status(), totals: named(flask.load.totals()), diff: diff(t3, await totals(sim, all())) };
    check(out, 'flask: sand scoops in on top: mixed', /\+/.test(mix.status) && mix.totals.SAND > 0 && mix.totals.WATER > 0 && zero(mix.diff), mix);

    // a mixed drink: the same share of each material
    for (let i = 0; i < 23; i++) await frame(sim, () => belt.update(ctx(null, -1)));   // past the gulp's refire wait (1.5 s)
    await settle();
    const before = named(flask.load.totals());
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    belt.update(ctx(null, -1));
    const doses = flask.lastDrink?.doses.map((d) => ({ key: d.key, n: d.n })) ?? [];
    const tot = Object.values(before).reduce((s, n) => s + n, 0);
    check(out, 'flask: a mixed drink takes the same share of each', doses.length === Object.keys(before).length && doses.reduce((s, d) => s + d.n, 0) === DRINK_CELLS
      && doses.every((d) => Math.abs(d.n - (DRINK_CELLS * before[d.key]) / tot) < 1), { before, doses });

    // throw: it flies, strikes the wall and shatters: its contents + FLASK_GLASS shards, nothing else
    const held = named(flask.load.totals());
    const t4 = await totals(sim, all());
    const throwCtx = (o) => ({ ...ctx(null, -1, o), eye: V(16.5, 5, 10.5), dir: V(0, 0.15, 1).normalize() });
    belt.update(throwCtx({ secondary: true, secondaryPressed: true }));
    const afterThrow = { inHand: flask.inHand, flying: flask.flying, left: flask.load.count };
    check(out, 'flask: the throw empties the hand', !afterThrow.inHand && afterThrow.flying === 1 && afterThrow.left === 0, afterThrow);
    let frames = 0;
    for (; frames < 300 && (flask.flying || !flask.lastShatter); frames++) await frame(sim, () => belt.update(throwCtx()));
    if (flask.lastShatter) extra.add(flask.lastShatter.load);
    await settle();
    for (let i = 0; i < 15; i++) await frame(sim);
    const sh = flask.lastShatter, heldN = Object.values(held).reduce((s, n) => s + n, 0);
    const shatter = sh ? { frames, point: [sh.point.x, sh.point.y, sh.point.z].map((v) => +v.toFixed(1)), held: sh.held, glass: sh.glass, spillLeft: sh.load.count, lost: flask.lost } : null;
    check(out, 'flask: the shatter lands: spill done, nothing lost', shatter && shatter.spillLeft === 0 && shatter.lost === 0 && shatter.held === heldN, shatter);
    const dThrow = diff(t4, await totals(sim, all()));
    check(out, 'flask: conserved: its contents + exactly FLASK_GLASS shards', Object.keys(dThrow).length === 1 && dThrow.SHARDS === FLASK_GLASS, { held, diff: dThrow });

    // empty-handed: every button refuses; the palette gives a fresh one
    toasts.length = 0;
    belt.update(ctx(null, -1, { primary: true, primaryPressed: true }));
    belt.update(ctx(null, -1, { drink: true, drinkPressed: true }));
    check(out, 'flask: none in hand: the buttons refuse', flask.status() === 'none' && toasts.some((t) => /No flask/.test(t)), { status: flask.status(), toasts });
    inventory.give('FLASK');
    check(out, 'flask: the palette gives a fresh flask of water', flask.inHand && flask.status() === 'WATR 100%', { inHand: flask.inHand, status: flask.status() });
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally {
    belt.setVisible(false);
    belt.dispose();
    sim.dispose();
  }
});

// ---------------------------------------------------------------- jackhammer (same 64³ hand-tool fixture)
test('stage:jackhammer', async () => {
  const out = { checks: [], numbers: {} };
  const sim = await make(64);
  const { default: definition } = await import('/src/pov/tools/jackhammer.tool.js');
  const { HAND_REACH } = await import('/src/pov/constants.js');
  const { pack, createTransfer } = await import('/src/pov/tools/transfer.js');
  const { createToolbelt } = await import('/src/pov/tools/index.js');
  const { povEvents } = await import('/src/pov/events.js');
  const toasts = [], impacts = [];
  const env = toolEnv(sim, toasts, { owner: 'jackhammer-check', feedback: { act() {}, refuse: (t) => toasts.push(t) } });
  env.transfer = createTransfer(env);
  let tool = definition.create(env);
  const loadout = pack(env.owner);
  const player = { pos: V(2, 0, 2), vel: V(), onGround: true };
  const center = V(20, 20, 20);
  const off = povEvents.on('impact', (e) => { if (e.source === 'jackhammer') impacts.push(e); });
  const settle = async () => {
    for (let i = 0; i < 300 && env.transfer.pending; i++) { await gpu.fence(); await tick(); }
    if (env.transfer.pending) throw new Error('jackhammer transfer did not settle');
  };
  const clearPack = () => { loadout.cells.length = 0; loadout.version++; };
  // Identical 9×9×3 slab dimensions to stage:hand. No physics steps between
  // edit and census: the check is exact fracture/transfer, not rubble settling.
  const slab = (id) => {
    // Fresh dig history after a world replacement (do not treat a new slab
    // as the previous scene's recently mined/stale aim).
    tool.dispose(); tool = definition.create(env);
    load(sim, (set) => {
      for (let z = 20; z < 23; z++) for (let y = 16; y < 25; y++) for (let x = 16; x < 25; x++) set(x, y, z, id);
    });
  };
  const strike = async (id, aimExtra = {}) => {
    tool.deselect();
    const c = toolCtx(sim, player, center.clone(), id, { primary: true, primaryPressed: true });
    Object.assign(c.aim, { face: 5 }, aimExtra);
    tool.update(c); await settle();
  };
  let belt;
  try {
    clearPack();
    belt = createToolbelt(toolEnv(sim, [])); belt.setVisible(true);
    dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    const cycle = [belt.selectedKey];
    for (let i = 0; i < 4; i++) { dispatchEvent(new KeyboardEvent('keydown', { key: '1' })); cycle.push(belt.selectedKey); }
    check(out, 'Dig slot cycles through appended jackhammer', cycle.includes('JACKHAMMER'), cycle);
    belt.select('JACKHAMMER');
    check(out, 'direct selection and hotbar agree', belt.selectedKey === 'JACKHAMMER'
      && document.querySelector('.hb-tool[data-key="JACKHAMMER"][aria-pressed="true"]') !== null);
    const { gfxUniforms } = await import('/src/gfx/uniforms.js');
    belt.update(toolCtx(sim, player, center, E.ROCK));
    check(out, 'selected jackhammer outlines its mining bite', gfxUniforms.uDigMax.value[3] > 0);
    belt.update(toolCtx(sim, player, null, -1, { wheel: 1 }));
    check(out, 'wheel moves from last Dig tool to Build slot', belt.selectedKey === 'TROWEL', belt.selectedKey);
    check(out, 'switching tools clears mining outline', gfxUniforms.uDigMax.value[3] === 0);
    belt.dispose(); belt = null;

    slab(E.ROCK);
    const before = (await totals(sim)).ROCK;
    await strike(E.ROCK);
    let t = await totals(sim, [loadout]);
    out.numbers.rock = { before, ...t, pack: loadout.count };
    check(out, 'outlined 3³ rock bite becomes 27 stone, exactly conserved', loadout.count === 27 && loadout.mainId === E.STONE
      && t.ROCK === before - 27 && (t.ROCK ?? 0) + (t.STONE ?? 0) === before, out.numbers.rock);
    check(out, 'rock impact classified as mining break', impacts.at(-1)?.broke === true && impacts.at(-1)?.id === E.ROCK);
    tool.windowShifted(3, 4);
    check(out, 'lastHit follows window shifts', tool.lastHit.cell.equals(V(17, 20, 16)));

    clearPack(); slab(E.METAL); await strike(E.METAL);
    t = await totals(sim, [loadout]);
    check(out, 'metal remains intact; refused mining impact', t.METAL === before && !t.SCRAP && loadout.count === 0
      && impacts.at(-1)?.broke === false, t);
    slab(E.ROCK); await strike(E.ROCK, { dist: 6 });
    check(out, 'mines beyond eye height without cutting out', loadout.count === 27
      && (await totals(sim)).ROCK === before - 27);
    clearPack(); slab(E.ROCK); await strike(E.ROCK, { dist: HAND_REACH + 1 });
    check(out, 'mining still respects hand reach', (await totals(sim)).ROCK === before && loadout.count === 0);

    slab(E.WOOD); await strike(E.WOOD);
    check(out, 'pickaxe material tags: leaves wood to the axe', (await totals(sim)).WOOD === before && loadout.count === 0);

    // Full real pack (not a lowered capacity) leaves unmined rock intact.
    for (let i = 0; i < loadout.capacity; i++) loadout.cells.push([E.STONE, 20, 0, 0]);
    loadout.version++;
    slab(E.ROCK); await strike(E.ROCK);
    t = await totals(sim);
    check(out, 'full pack: rock stays intact, no debris lost', loadout.count === loadout.capacity && !t.STONE
      && t.ROCK === before && toasts.some((v) => /pack is full/.test(v)), t);
    clearPack();
    await strike(E.ROCK);
    check(out, 'mining resumes when pack is emptied', loadout.count === 27 && loadout.mainId === E.STONE);
    t = await totals(sim, [loadout]);
    check(out, 'resumed mining still conserves mass', (t.ROCK ?? 0) + (t.STONE ?? 0) === before, t);

    clearPack(); slab(E.STONE); await strike(E.STONE);
    check(out, 'existing loose stone is collected without duplication', loadout.count === 27 && loadout.mainId === E.STONE
      && (await totals(sim, [loadout])).STONE === before);

    // One free slot: only one cell mined, the rest stays rock.
    clearPack();
    for (let i = 1; i < loadout.capacity; i++) loadout.cells.push([E.STONE, 20, 0, 0]);
    loadout.version++;
    slab(E.ROCK); await strike(E.ROCK);
    t = await totals(sim);
    check(out, 'one free slot: exactly one taken, remaining rock intact', loadout.count === loadout.capacity
      && !t.STONE && t.ROCK === before - 1, t);
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally {
    await settle(); off(); belt?.dispose(); tool.dispose(); clearPack(); sim.dispose();
  }
});

// ---------------------------------------------------------------- hand (axe, physgun)
// pov-tools-b's scenes. The axe's: the old check's slabs, cell for cell (9
// tall, 9 wide, 3 deep, 20 cells apart), two rows of three on 64³ where the
// old 128³ had one of six; its swing lands by its own clock (the world isn't
// stepped). The physgun's on 32³, its basin nearer the origin (the matter and
// the hold point 12 cells up as the old 128³ check had them), its frames the
// old pov-tools-b's, the app's tick: DT and STEPS steps (its spring works per
// step), 0.5 s gathering, 2 s raising, 3 s holding. It holds a ball, not the
// pool: the falloff's full-strength core (PHYS.CORE of its RADIUS, PHYS.PACKING
// of it matter) is ~140 cells. A powder fills it: sand must lift at least half
// that ball above the basin, round the hold point. A liquid drains from it as
// it is held; how much water stays up is printed, as the old check printed it
// (no WebGL figure was ever recorded for it: docs/webgpu.md I4's cross-build
// list has it).
test('stage:hand', async ({ only = ['axe', 'phys'], mats: physMats = ['SAND', 'WATER'] } = {}) => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(only.includes('axe') ? 64 : 32);
  const toasts = [];
  const env = toolEnv(sim, toasts);
  const count = async () => Object.fromEntries(Object.entries(await sim.census()).map(([k, v]) => [k, v.n]));
  try {
    if (only.includes('axe')) {
      const axe = (await import('/src/pov/tools/axe.tool.js')).default;
      const tool = axe.create(env);
      const mats = ['WOOD', 'GLASS', 'ICE', 'PLANT', 'ROCK', 'METAL'];
      // a 3 × 9 × 9 slab of each, facing −x: three at z = 10, 30, 50 with x from 30, three with x from 50
      const at = (i) => ({ x0: 30 + 20 * Math.floor(i / 3), zc: 10 + 20 * (i % 3) });
      load(sim, (set) => mats.forEach((m, i) => {
        const { x0, zc } = at(i);
        for (let x = x0; x < x0 + 3; x++) for (let y = 2; y < 11; y++) for (let z = zc - 4; z <= zc + 4; z++) set(x, y, z, E[m]);
      }));
      const c0 = await count();
      const player = { pos: V(), vel: V(), applyImpulse() {} };
      const res = {};
      for (const [i, m] of mats.entries()) {
        const { x0, zc } = at(i);
        const ctx = (over) => ({ sim, dt: DT, stepsPerFrame: STEPS, eye: V(x0 - 3.5, 6.5, zc + 0.5), dir: V(1, 0, 0),
          primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
          aim: { valid: true, cell: V(x0, 6, zc), face: 0, id: E[m], dist: 3.5 }, player, ...over });
        const before = await count();
        tool.update(ctx({ primaryPressed: true, primary: true }));
        for (let f = 0; f < 40; f++) tool.update(ctx({}));   // the swing lands (its own clock), the world not stepped
        const after = await count();
        const into = ELEMENTS[E[m]].breakInto;
        res[m] = { broken: (before[E[m]] ?? 0) - (after[E[m]] ?? 0), debris: into ? (after[E[into]] ?? 0) - (before[E[into]] ?? 0) : 0, into };
      }
      const snow = (await snap(sim)).cells(E.SNOW);
      res.snowT = snow.length ? +(snow.reduce((a, c) => a + c.T, 0) / snow.length).toFixed(1) : null;
      const c1 = await count();
      res.totalBefore = Object.values(c0).reduce((a, n) => a + n, 0);
      res.totalAfter = Object.values(c1).reduce((a, n) => a + n, 0);
      out.numbers.axe = res;
      // AXE (shaders/povTools.js): wood, glass, ice and plant break where the blow beats their hardness; rock and metal never
      for (const m of ['WOOD', 'GLASS', 'ICE', 'PLANT']) check(out, `axe: breaks ${m} into its debris, cell for cell`, res[m].broken > 0 && (!res[m].into || res[m].debris === res[m].broken), res[m]);
      for (const m of ['ROCK', 'METAL']) check(out, `axe: ${m} holds`, res[m].broken === 0, res[m]);
      check(out, 'axe: snow keeps the ice\'s temperature', res.snowT !== null && Math.abs(res.snowT - ELEMENTS[E.ICE].temp) < 1, { snowT: res.snowT, ice: ELEMENTS[E.ICE].temp });
      check(out, 'axe: nothing made or lost', res.totalBefore === res.totalAfter, res);
      tool.deselect?.(); tool.dispose?.();
    }
    if (only.includes('phys')) {
      const phys = (await import('/src/pov/tools/physgun.tool.js')).default;
      const { PHYS } = await import('/src/shaders/povTools.js');
      const BALL = Math.round(4 / 3 * Math.PI * (PHYS.CORE * PHYS.RADIUS) ** 3 * PHYS.PACKING);   // cells: the core's matter
      out.numbers.phys = {};
      for (const mat of physMats) {
        const t0 = performance.now();
        const tool = phys.create(env);
        const id = E[mat];
        // a WALL floor, a WALL basin holding a 10×5×10 block
        load(sim, (set, g) => {
          for (let x = 0; x < g.nx; x++) for (let z = 0; z < g.nz; z++) set(x, 0, z, E.WALL);
          for (let x = 13; x <= 24; x++) for (let z = 9; z <= 20; z++) for (let y = 1; y <= 6; y++) if (x === 13 || x === 24 || z === 9 || z === 20) set(x, y, z, E.WALL);
          for (let x = 14; x < 24; x++) for (let z = 10; z < 20; z++) for (let y = 1; y < 6; y++) set(x, y, z, id);
        });
        for (let i = 0; i < 15; i++) await frame(sim);   // settle (60 steps)
        const n0 = (await count())[id];
        const eye = V(4.5, 8.5, 15), surface = V(19, 5.5, 15), target = V(19, 18, 15);
        const player = { pos: V(4.5, 3.5, 15), vel: V(), applyImpulse() {} };
        let dir = surface.clone().sub(eye).normalize();
        const ctx = (over) => ({ sim, dt: DT, stepsPerFrame: STEPS, eye, dir,
          primary: true, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
          aim: { valid: true, cell: V(19, 5, 15), face: 2, id, dist: surface.distanceTo(eye) }, player, ...over });
        await frame(sim, () => tool.update(ctx({ primaryPressed: true })));
        // gather for 0.5 s, raise the aim over 2 s to a point 12 cells up, then hold 3 s
        const gather = Math.round(0.5 / DT), raise = Math.round(2 / DT), hold = Math.round(3 / DT);
        for (let f = 1; f <= gather + raise + hold; f++) {
          const k = THREE.MathUtils.clamp((f - gather) / raise, 0, 1);
          dir = surface.clone().lerp(target, k).sub(eye).normalize();
          await frame(sim, () => tool.update(ctx({})));
          if (f % 60 === 0) progress(`physgun ${mat}: frame ${f} of ${gather + raise + hold}, ${(await sim.compact.readStats()).awake} of ${sim.g.nbricks} bricks awake`);
        }
        const holdAt = tool.hold, com = await tool.readCom();
        const cells = (await snap(sim)).cells(id);
        const lifted = cells.filter((c) => c.y > 8);
        const dist = lifted.reduce((a, c) => a + V(c.x + 0.5, c.y + 0.5, c.z + 0.5).distanceTo(holdAt), 0) / (lifted.length || 1);
        // fling along the aim: the held cells' mean velocity right after
        tool.update(ctx({ secondaryPressed: true, secondary: true }));
        const flung = (await snap(sim)).cells(id).filter((c) => c.y > 8);
        const vFling = flung.reduce((a, c) => a.add(V(...c.v)), V()).divideScalar(flung.length || 1);
        for (let i = 0; i < 25; i++) await frame(sim);
        const n1 = (await count())[id];
        const r = out.numbers.phys[mat] = {
          hold: holdAt?.toArray().map((v) => +v.toFixed(1)), com: com?.map((v) => +v.toFixed(1)), lifted: lifted.length, of: n0, ball: BALL,
          meanDistFromHold: +dist.toFixed(2), flingV: vFling.toArray().map((v) => +v.toFixed(2)), along: +vFling.dot(dir).toFixed(2), census: [n0, n1],
        };
        // the beam holds matter round the hold point, raised 12 cells (both); a powder fills the ball's core (sand)
        check(out, `physgun: lifts ${mat} to the hold point 12 cells up, round it`, holdAt && holdAt.y > 14 && lifted.length > 0 && dist < PHYS.CORE * PHYS.RADIUS, r);
        if (ELEMENTS[id].kind === K.POWDER) check(out, `physgun: the ${mat} fills at least half the ball's core (${BALL} cells)`, lifted.length >= BALL / 2, r);
        check(out, `physgun: flings the ${mat} along the aim`, r.along > 0, r);
        check(out, `physgun: ${mat} conserved`, n0 === n1, r.census);
        tool.deselect?.(); tool.dispose?.();
        out.ms[`phys${mat}`] = performance.now() - t0;
      }
    }
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- player
// The body (pov/player.js) in small scenes, as tools/pov-player-check.mjs
// printed them at 128³, here at 64³ (the scenes 32 cells nearer the origin
// in x and z). A frame is BODY_DT of the body's time and STEPS steps: a
// 20 fps app (the body's own frame cap is 0.1 s), as the old check's frames
// mostly were in headless Chromium. Numbers, not pass or fail.
const BODY_DT = 0.05;
test('stage:player', async ({ only = null, from = 0, budgetMs = Infinity } = {}) => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(64);
  const { createPlayer } = await import('/src/pov/player.js');
  const D = 32;   // the old scenes' offset in x and z
  // replace the world: build({ box(x0, y0, z0, x1, y1, z1, id, T) }), upper bounds exclusive, in the old 128³ coordinates
  const scene = (build) => load(sim, (set) => build({
    box(x0, y0, z0, x1, y1, z1, id, T) {
      for (let y = y0; y < y1; y++) for (let z = z0 - D; z < z1 - D; z++) for (let x = x0 - D; x < x1 - D; x++) set(x, y, z, id, { temp: T });
    },
  }));
  const at = (x, y, z) => V(x - D, y, z - D);
  let body = null;
  const player = () => {
    body?.dispose?.();
    const pl = createPlayer({ renderer: null, getSim: () => sim });
    pl.events = [];
    for (const n of ['hurt', 'death', 'land', 'splash']) pl.on(n, (d) => pl.events.push([n, JSON.stringify(d)]));
    body = pl;
    return pl;
  };
  // the body for `secs` of its time, a frame at a time
  const run = async (pl, secs, input = {}, each) => {
    for (let t = 0; t < secs;) {
      await frame(sim, () => pl.update(BODY_DT, typeof input === 'function' ? input(pl) : input));
      t += BODY_DT;
      pl.t = t;
      await each?.(pl);
    }
  };
  const settle = async (secs) => { for (let t = 0; t < secs; t += BODY_DT) await frame(sim); };
  const v = (pl) => [pl.pos.x + D, pl.pos.y, pl.pos.z + D].map((n) => +n.toFixed(2));   // (reported in the old coordinates)
  const state = (pl) => ({
    pos: v(pl), vel: [pl.vel.x, pl.vel.y, pl.vel.z].map((n) => +n.toFixed(1)), onGround: pl.onGround,
    inLiquid: pl.inLiquid, headInLiquid: pl.headInLiquid, liquidId: pl.liquidId, sub: +pl.submerged.toFixed(2),
    health: +pl.health.toFixed(3), breath: +pl.breath.toFixed(3), dead: pl.dead, cause: pl.cause, skinT: +pl.skinT.toFixed(1),
  });
  const tests = {
    async falls() {   // (pov-player-check's floor)
      scene(() => {});
      await settle(0.3);
      const pl = player();
      pl.spawn(at(64, 8, 64));
      await run(pl, 1.5);
      const low = state(pl);
      pl.spawn(at(64, 40, 64));   // 12 m: lands unhurt (no fall damage, as in Noita)
      await run(pl, 2.5);
      return { from8: low, from40: state(pl), events: pl.events.slice(0, 6) };
    },
    async sandPile() {
      scene(({ box }) => box(54, 0, 54, 74, 8, 74, E.SAND));
      await settle(2);
      const pl = player();
      pl.spawn(at(64, 20, 64));
      await run(pl, 2.5);
      return state(pl);
    },
    async stepUp() {
      scene(({ box }) => {
        box(70, 0, 40, 128, 1, 90, E.ROCK);   // a 1-cell ledge at x = 70
        box(80, 1, 40, 128, 2, 90, E.ROCK);   // and a second one at x = 80
        box(90, 2, 40, 128, 4, 90, E.ROCK);   // then a 2-cell wall at x = 90
      });
      await settle(0.3);
      const pl = player();
      pl.spawn(at(62, 0, 64));
      let maxX = -Infinity;
      await run(pl, 6, { move: { x: 1, z: 0 } }, (q) => { maxX = Math.max(maxX, q.pos.x + D); });
      return { end: state(pl), maxX: +maxX.toFixed(2) };
    },
    async wall() {
      scene(({ box }) => box(70, 0, 40, 72, 30, 90, E.WALL));
      await settle(0.3);
      const pl = player();
      pl.spawn(at(62, 0, 64));
      let maxX = 0;
      await run(pl, 3, { move: { x: 1, z: 0 }, sprint: true }, (q) => { maxX = Math.max(maxX, q.pos.x + D); });
      await run(pl, 1.5, { move: { x: 1, z: 0.2 }, sprint: true, jump: true }, (q) => { maxX = Math.max(maxX, q.pos.x + D); });
      return { end: state(pl), maxX: +maxX.toFixed(3), wallFace: 70 - 0.8 };
    },
    async water() {
      scene(({ box }) => {
        box(40, 0, 40, 90, 22, 90, E.GLASS);
        box(41, 1, 41, 89, 22, 89, E.EMPTY);
        box(41, 1, 41, 89, 16, 89, E.WATER);   // surface at y = 16
      });
      await settle(1.5);
      const pl = player();
      pl.spawn(at(64, 26, 64));
      let minY = 99;
      await run(pl, 4, {}, (q) => { minY = Math.min(minY, q.pos.y); });
      const plunge = { minFeetY: +minY.toFixed(2), riseAfter4s: +pl.pos.y.toFixed(2) };
      pl.spawn(at(64, 9, 64));   // float: the head just under the surface, left to settle
      const ys = [];
      await run(pl, 10, {}, (q) => ys.push(q.pos.y));
      const tail = ys.slice(-60);
      const mean = tail.reduce((a, y) => a + y, 0) / tail.length;
      const r = { plunge, state: state(pl), meanFeetY: +mean.toFixed(2), headTopMinusSurface: +(mean + 5.5 - 16).toFixed(2),
        range: +(Math.max(...tail) - Math.min(...tail)).toFixed(2), events: pl.events.slice(0, 4) };
      await run(pl, 3, { jump: true });   // swim up: the head comes out
      r.swimUp = { feetY: +pl.pos.y.toFixed(2), headInLiquid: pl.headInLiquid };
      return r;
    },
    async oil() {
      scene(({ box }) => {
        box(40, 0, 40, 90, 22, 90, E.GLASS);
        box(41, 1, 41, 89, 22, 89, E.EMPTY);
        box(41, 1, 41, 89, 16, 89, E.OIL);
      });
      await settle(1.5);
      const pl = player();
      pl.spawn(at(64, 17, 64));
      await run(pl, 6);
      return state(pl);
    },
    async drown() {
      scene(({ box }) => {
        box(40, 0, 40, 90, 30, 90, E.GLASS);
        box(41, 1, 41, 89, 30, 89, E.EMPTY);
        box(41, 1, 41, 89, 24, 89, E.WATER);
      });
      await settle(1.5);
      const pl = player();
      pl.spawn(at(64, 5, 64));
      let firstHurt = null, breath10 = null;
      await run(pl, 24, { down: true }, (q) => {
        if (breath10 === null && q.t > 10) breath10 = +q.breath.toFixed(3);
        if (firstHurt === null && q.health < 1) firstHurt = +q.t.toFixed(1);
      });
      return { state: state(pl), breathAt10s: breath10, firstHurtAt: firstHurt, events: pl.events.slice(-3) };
    },
    async lava() {
      scene(({ box }) => {
        box(40, 0, 40, 90, 10, 90, E.WALL);
        box(42, 1, 42, 88, 10, 88, E.EMPTY);
        box(42, 1, 42, 88, 8, 88, E.LAVA);
      });
      await settle(1);
      const pl = player();
      pl.spawn(at(64, 14, 64));
      let deathAt = null;
      await run(pl, 6, {}, (q) => { if (q.dead && deathAt === null) deathAt = +q.t.toFixed(2); });
      return { state: state(pl), deathAt, events: pl.events.slice(-3) };
    },
    async blast() {
      scene(({ box }) => box(72, 0, 63, 75, 3, 66, E.GUNPOWDER));
      await settle(0.5);
      const pl = player();
      pl.spawn(at(62, 0, 64));
      await run(pl, 0.5);
      sim.paint({ center: at(73.5, 3.5, 64.5), radius: 1.5, shape: 0, tool: E.FIRE, rate: 10, replace: false });   // light it
      let maxSpeed = 0, minX = pl.pos.x + D, maxY = 0;
      await run(pl, 3, {}, (q) => { maxSpeed = Math.max(maxSpeed, q.vel.length()); minX = Math.min(minX, q.pos.x + D); maxY = Math.max(maxY, q.pos.y); });
      return { state: state(pl), maxSpeed: +maxSpeed.toFixed(1), thrownX: +(62 - minX).toFixed(2), maxY: +maxY.toFixed(2), events: pl.events.slice(0, 6) };
    },
    async fire() {
      // standing next to a burning wooden block: how hard its pressure pushes, how hot it gets
      scene(({ box }) => box(66, 0, 61, 72, 10, 67, E.WOOD, 400));
      await settle(3);
      const pl = player();
      pl.spawn(at(63, 0, 64));
      let maxSpeed = 0;
      await run(pl, 5, {}, (q) => { maxSpeed = Math.max(maxSpeed, q.vel.length()); });
      const c = await sim.census();
      return { state: state(pl), maxSpeed: +maxSpeed.toFixed(1), drift: +(pl.pos.x + D - 63).toFixed(2), fire: c[E.FIRE]?.n ?? 0 };
    },
    async coupling() {
      scene(({ box }) => {
        box(30, 0, 30, 100, 12, 100, E.GLASS);
        box(31, 1, 31, 99, 12, 99, E.EMPTY);
        box(31, 1, 31, 99, 4, 99, E.WATER);   // wading depth: 3 cells
        box(31, 4, 60, 40, 6, 70, E.SAND);
      });
      await settle(1.5);
      const census0 = await sim.census();
      const pl = player();
      pl.spawn(at(40, 1, 64));
      // the water cells' velocity in a body-sized box at (x, z) (grid cells), read right after the frame's coupling
      const readV = async (cx, cz) => {
        const S = await snap(sim);
        let n = 0, fwd = 0, outw = 0;
        for (let y = 1; y < 4; y++) for (let z = Math.floor(cz - 1); z <= cz + 1; z++) for (let x = Math.floor(cx - 1); x <= cx + 1; x++) {
          if (Math.abs(x + 0.5 - cx) > 0.8 || Math.abs(z + 0.5 - cz) > 0.8) continue;
          const i = S.at(x, y, z);
          if (Math.round(S.A[i]) !== E.WATER) continue;
          const rx = x + 0.5 - cx, rz = z + 0.5 - cz, r = Math.hypot(rx, rz) || 1;
          n++; fwd += S.B[i]; outw += (S.B[i] * rx + S.B[i + 2] * rz) / r;
        }
        return { n, fwd: +(fwd / Math.max(n, 1)).toFixed(3), out: +(outw / Math.max(n, 1)).toFixed(3) };
      };
      const bodyV = [], control = [];
      await run(pl, 4, { move: { x: 1, z: 0 }, sprint: true }, async (q) => {
        if (q.pos.x + D > 45 && q.pos.x + D < 80 && bodyV.length < 20) {
          bodyV.push(await readV(q.pos.x, q.pos.z));
          control.push(await readV(q.pos.x, q.pos.z + 15));
        }
      });
      const avg = (arr, k) => +(arr.reduce((a, r) => a + r[k], 0) / Math.max(arr.length, 1)).toFixed(3);
      const samples = { frames: bodyV.length, body: { fwd: avg(bodyV, 'fwd'), out: avg(bodyV, 'out'), n: avg(bodyV, 'n') },
        control: { fwd: avg(control, 'fwd'), out: avg(control, 'out'), n: avg(control, 'n') } };
      await settle(1);
      const census1 = await sim.census();
      const d = {};
      for (const k of new Set([...Object.keys(census0), ...Object.keys(census1)])) {
        const dk = (census1[k]?.n ?? 0) - (census0[k]?.n ?? 0);
        if (dk) d[ELEMENTS[k].key] = dk;
      }
      return { state: state(pl), samples, censusDiff: d, water: census1[E.WATER]?.n, sand: census1[E.SAND]?.n };
    },
  };
  // the tests from `from` on, until budgetMs is spent (out.next: the first not run; tools/pov-gpu-check.mjs runStages)
  const names = Object.keys(tests).filter((n) => !only || only.includes(n));
  const unknown = (only ?? []).filter((n) => !tests[n]);
  if (unknown.length) check(out, 'player: the tests asked for exist', false, `no test ${unknown.join(', ')} (have: ${Object.keys(tests).join(', ')})`);
  try {
    const start = performance.now();
    let i = from;
    for (; i < names.length && (i === from || performance.now() - start < budgetMs); i++) {
      const name = names[i], t0 = performance.now();
      try {
        out.numbers[name] = await tests[name]();
      } catch (e) {
        check(out, `player: ${name} ran`, false, String(e).slice(0, 500));
      }
      out.ms[name] = performance.now() - t0;
      progress(`player: ${name} done`);
    }
    out.next = i < names.length ? i : null;
    out.of = names.length;
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally {
    body?.dispose?.();
    sim.dispose();
  }
});

// ---------------------------------------------------------------- char
// tools/gibs-check.mjs --gpu's part burn, the app part char's witness on this
// host (char wakes the 64³ box's air with its heat and fire and takes ten
// minutes and more on SwiftShader, so it runs when asked): a block of cooked
// meat in open air, stepped by hand at the app's 4 steps a frame. Held just
// under its fat's flash point (elements.js COOKED_MEAT ignite) it stays meat;
// brought past it, it chars and burns to ash. On a 16³ world: the smoke and
// fire wake every brick of any box, and the burn is the box's size's to
// cost but not to change (here: ash first seen after 140 frames at 32³ and at
// 16³, 8 and 9 cells of it, in 199 s and 55 s; `size` picks the world).
const CHAR_BELOW = 20, CHAR_OVER = 10;   // °C under the flash point for the control, over it for the burn
const CHAR_CONTROL_FRAMES = 30, CHAR_MAX_FRAMES = 300, CHAR_LOOK_EVERY = 10;
test('stage:char', async ({ size = 16 } = {}) => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(size);
  try {
    const g = sim.g, cx = g.nx / 2 - 1, cz = g.nz / 2 - 1, ignite = ELEMENTS[E.COOKED_MEAT].ignite;
    const block = (temp) => load(sim, (set) => {
      for (let y = 0; y < 3; y++) for (let z = cz; z < cz + 3; z++) for (let x = cx; x < cx + 3; x++) set(x, y, z, E.COOKED_MEAT, { temp });
    });
    const count = async () => Object.fromEntries(Object.entries(await sim.census()).filter(([k]) => +k !== E.EMPTY).map(([k, v]) => [ELEMENTS[k].key, v.n]));
    const awake = async () => (await sim.compact.readStats()).awake;   // (V2's awake bricks)
    // the control: just under the flash point, the meat neither chars nor burns
    block(ignite - CHAR_BELOW);
    for (let f = 0; f < CHAR_CONTROL_FRAMES; f++) await frame(sim);
    const c0 = await count();
    out.numbers.under = { T: ignite - CHAR_BELOW, frames: CHAR_CONTROL_FRAMES, ...c0 };
    check(out, `char: cooked meat at ${ignite - CHAR_BELOW} °C (under its flash point, ${ignite} °C) stays meat`, c0.COOKED_MEAT === 27 && !c0.ASH && !c0.FIRE, c0);
    progress(`char: the control done, ${await awake()} bricks awake`);
    // past it: it chars and burns, leaving ash
    block(ignite + CHAR_OVER);
    let c1 = null, f = 0, fireSeen = 0;
    while (f < CHAR_MAX_FRAMES) {
      for (let i = 0; i < CHAR_LOOK_EVERY; i++, f++) await frame(sim);
      c1 = await count();
      fireSeen = Math.max(fireSeen, c1.FIRE ?? 0);
      if ((c1.ASH ?? 0) > 0 && (c1.COOKED_MEAT ?? 0) < 27) break;
      if (f % 60 === 0) progress(`char: frame ${f}, ${await awake()} bricks awake, ${JSON.stringify(c1)}`);
    }
    out.numbers.over = { T: ignite + CHAR_OVER, frames: f, fireSeen, ...c1 };
    check(out, `char: past its flash point (${ignite + CHAR_OVER} °C) cooked meat burns and leaves ash`, (c1.ASH ?? 0) > 0 && (c1.COOKED_MEAT ?? 0) < 27 && fireSeen > 0, out.numbers.over);
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- meat
// tools/gibs-check.mjs --gpu's part lay, the app part gib's witness on this
// host (gib waits for the lab spawner's NPC and fires rockets at it, which
// wakes the 64³ box and takes over ten minutes on SwiftShader, so it runs when
// asked; the rules of when a body gibs are the check's CPU part): a body's
// burst (pov/meat.js gib) on a 32³ world, its meat laid through the exact
// transfer, in open air and buried in rock; and cooked meat eaten (meat.js
// eat) leaving the grid exactly.
const LAY_FRAMES = 30;   // frames a burst has to finish in (GIB_TRIES of them at most, one put in flight each)
test('stage:meat', async () => {
  const out = { checks: [], ms: {}, numbers: {} };
  const { createMeat, GIB_CELLS } = await import('/src/pov/meat.js');
  const sim = await make(32);
  try {
    const g = sim.g, meat = createMeat({ renderer: {}, getSim: () => sim });
    const burst = async (pos) => {
      const t0 = await totals(sim);
      let done = null;
      meat.gib(pos, V(0, 0, 0), STEPS / DT, (placed, lost) => { done = { placed, lost }; });
      for (let f = 0; f < LAY_FRAMES && !done; f++) await frame(sim, () => meat.update());
      for (let f = 0; f < 5; f++) await frame(sim);
      return { done, diff: diff(t0, await totals(sim)) };
    };
    // in open air on the floor: all of it laid
    const open = await burst(V(g.nx / 2, 0, g.nz / 2));
    out.numbers.open = open;
    check(out, `meat: a burst in the open lays the body's mass, ${GIB_CELLS} cells of meat, exactly`,
      open.done?.placed === GIB_CELLS && open.done.lost === 0 && open.diff.MEAT === GIB_CELLS && Object.keys(open.diff).length === 1, open);
    // buried in rock: what found no room is lost, and only what was laid is in the grid
    load(sim, (set) => { for (let y = 0; y < 24; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) set(x, y, z, E.ROCK); });
    for (let f = 0; f < 5; f++) await frame(sim);
    const buried = await burst(V(g.nx / 2, 8, g.nz / 2));
    out.numbers.buried = buried;
    check(out, 'meat: a burst buried in rock: laid + lost is the body\'s mass, the grid gains just what was laid',
      buried.done && buried.done.placed + buried.done.lost === GIB_CELLS && (buried.diff.MEAT ?? 0) === buried.done.placed
        && Object.keys(buried.diff).every((k) => k === 'MEAT'), buried);
    // eating: cooked meat on the floor, a want of 5 cells
    load(sim, (set) => { for (let z = 14; z < 18; z++) for (let x = 14; x < 18; x++) set(x, 0, z, E.COOKED_MEAT); });
    for (let f = 0; f < 5; f++) await frame(sim);
    const e0 = await totals(sim);
    const cells = [];
    for (let z = 14; z < 18; z++) for (let x = 14; x < 18; x++) cells.push([x, 0, z]);
    let eaten = 0;
    meat.eat(cells, 5, (n) => { eaten += n; });
    for (let f = 0; f < 10 && meat.busy; f++) await frame(sim, () => meat.update());
    const de = diff(e0, await totals(sim));
    out.numbers.eat = { eaten, diff: de };
    check(out, 'meat: eating takes what it wants of the cooked meat, and exactly that leaves the grid',
      eaten === 5 && de.COOKED_MEAT === -5 && Object.keys(de).length === 1, out.numbers.eat);
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

// ---------------------------------------------------------------- engine
// tools/pov-engine-check.mjs's scenes (hardness and breaking, impact heat,
// blasts, conservation) on a 64³ world built on the CPU and stepped by hand.
// Each scene is a list of cases (a ball, a pane, a shot, a keg's range and
// offset…), the old check's every one; a run takes the requested scenes'
// cases (the first perScene of each) from `from` until it has spent budgetMs, and says where it stopped
// (out.next: tools/pov-gpu-check.mjs runStages goes on from there in a
// browser of its own). Where a case follows a few cells step by step it reads
// just those (readCell, one flush for all of them); where it follows matter
// anywhere it reads the whole state, every step (slugs, keg) or every
// SAND_DROP_EVERY steps (sandDrop: impact heat lingers for many steps).
// Numbers, not pass or fail.
const SAND_DROP_EVERY = 4;
const ENGINE_SCENES = ['blastProfile', 'paneLoad', 'slugs', 'keg', 'blast', 'sandDrop', 'debris'];
test('stage:engine', async ({ scenes: names = ENGINE_SCENES, perScene = Infinity, from = 0, budgetMs = Infinity } = {}) => {
  const out = { checks: [], ms: {}, numbers: {} };
  const sim = await make(64);
  const g = sim.g, idx = (x, y, z) => cellTexel(g, x, y, z) * 4;
  const t = {
    fresh() { [t.A, t.B] = sim.blankState(); },
    set(x, y, z, key, o = {}) {
      const id = E[key], i = idx(x, y, z), e = ELEMENTS[id];
      t.A[i] = id; t.A[i + 1] = o.T ?? e.temp; t.A[i + 2] = o.life ?? e.life; t.A[i + 3] = (o.ctype ?? 0) + (t.A[i + 3] % 1);
      t.B[i] = o.vx ?? 0; t.B[i + 1] = o.vy ?? 0; t.B[i + 2] = o.vz ?? 0; t.B[i + 3] = o.P ?? 0;
    },
    box(x0, x1, y0, y1, z0, z1, key, o) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) t.set(x, y, z, key, o); },
    load() { sim.frame = 0; sim.load(t.A, t.B); },
    step(n = 1) { for (let i = 0; i < n; i++) sim.step(); },
    async read() { [t.rA, t.rB] = await sim.readState(); },
    // the pressure at a few cells, read back now (one flush)
    async pressures(cells) { return (await Promise.all(cells.map(([x, y, z]) => sim.readCell(x, y, z)))).map(([, b]) => b[3]); },
    cell(x, y, z) {
      const i = idx(x, y, z);
      return { id: Math.round(t.rA[i]), key: ELEMENTS[Math.round(t.rA[i])].key, T: +t.rA[i + 1].toFixed(1), life: +t.rA[i + 2].toFixed(3),
        ctype: Math.floor(t.rA[i + 3]), v: [t.rB[i], t.rB[i + 1], t.rB[i + 2]].map((v) => +v.toFixed(3)), P: +t.rB[i + 3].toFixed(2) };
    },
    counts() {
      const c = {};
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z), k = ELEMENTS[Math.round(t.rA[i])].key;
        const o = (c[k] ??= { n: 0, Tmax: -1e9 });
        o.n++; o.Tmax = Math.max(o.Tmax, +t.rA[i + 1].toFixed(1));
      }
      delete c.EMPTY;
      return c;
    },
    where(key) {
      const res = [], id = E[key];
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z);
        if (Math.round(t.rA[i]) === id) res.push([x, y, z, +t.rA[i + 1].toFixed(1)]);
      }
      return res;
    },
    async edit(fn) { await t.read(); fn((x, y, z) => idx(x, y, z)); sim.load(t.rA, t.rB); },
    total() { return Object.values(t.counts()).reduce((a, c) => a + c.n, 0); },
  };

  // ---- the scenes' cases: [name, run → its numbers]
  const scenes = {};
  // peak blast pressure in open air at distance d from a gunpowder ball, and from a pile lit at a corner
  const D = [1, 2, 3, 4, 6, 8, 10, 14, 18];
  scenes.blastProfile = [
    ...[1, 2].map((r) => [`ball ${2 * r + 1}³`, async () => {
      t.fresh();
      t.box(20 - r, 20 + r, 30 - r, 30 + r, 32 - r, 32 + r, 'GUNPOWDER', { T: 250 });
      t.load();
      const peak = {};
      for (let s = 0; s < 40; s++) {
        t.step();
        const P = await t.pressures(D.map((d) => [20 + r + d, 30, 32]));
        D.forEach((d, k) => { peak[d] = Math.max(peak[d] ?? -1e9, +P[k].toFixed(2)); });
      }
      return peak;
    }]),
    ['9³ pile, lit at a corner', async () => {
      t.fresh();
      t.box(10, 18, 2, 10, 28, 36, 'GUNPOWDER');
      t.set(9, 2, 28, 'FIRE');
      t.load();
      const peak = {}, D2 = [1, 2, 3, 4, 6, 8, 10, 14];
      let pin = 0;
      for (let s = 0; s < 120; s++) {
        t.step();
        const P = await t.pressures([...Array.from({ length: 9 }, (_, k) => [10 + k, 6, 32]), ...D2.map((d) => [18 + d, 6, 32])]);
        for (let k = 0; k < 9; k++) pin = Math.max(pin, +P[k].toFixed(2));
        D2.forEach((d, k) => { peak[d] = Math.max(peak[d] ?? -1e9, +P[9 + k].toFixed(2)); });
      }
      return { inside: pin, ...peak };
    }],
  ];
  // peak pressure on a WALL pane's face at distance d from lit piles: panes da cells off on +x and db on −x
  scenes.paneLoad = [1, 3, 5, 7].flatMap((n) => ['flame', 'heat'].flatMap((lit) => [[1, 2], [3, 4], [6, 8]].map(([da, db]) => [
    `${n}³ ${lit === 'flame' ? 'lit by a flame' : 'all at once'}, panes ${da} and ${db} off`, async () => {
      t.fresh();
      const a0 = 32 - (n >> 1), a1 = a0 + n - 1, y0 = 10, y1 = y0 + n - 1;
      t.box(a0, a1, y0, y1, a0, a1, 'GUNPOWDER', lit === 'heat' ? { T: 250 } : {});
      if (lit === 'flame') t.set(a0 - 1, y0, a0, 'FIRE');
      const yc = (y0 + y1) >> 1;
      t.box(a1 + da, a1 + da, y0 - 6, y1 + 6, a0 - 6, a1 + 6, 'WALL');
      t.box(a0 - db, a0 - db, y0 - 6, y1 + 6, a0 - 6, a1 + 6, 'WALL');
      t.load();
      let pa = 0, pb = 0;
      for (let s = 0; s < 60; s++) {
        t.step();
        const [qa, qb] = await t.pressures([[a1 + da - 1, yc, 32], [a0 - db + 1, yc, 32]]);
        pa = Math.max(pa, qa); pb = Math.max(pb, qb);
      }
      return { [da]: +pa.toFixed(0), [db]: +pb.toFixed(0) };
    }])));
  // a SCRAP slug at vx = 1 into a pane or block of each material
  const shoot = async (target, thick, gap, steps = 40, v = { vx: 1 }, extra) => {
    const x0 = 40;
    t.fresh();
    t.box(x0, x0 + thick - 1, 28, 52, 22, 42, target);
    extra?.();
    t.set(x0 - 1 - gap, 40, 32, 'SCRAP', v);
    t.load(); await t.read();
    const before = t.counts(), debris = ELEMENTS[E[target]].breakInto;
    const slug = () => t.where('SCRAP').map((c) => [c, t.cell(c[0], c[1], c[2])]).sort((a, b) => b[1].v[0] - a[1].v[0])[0];
    const peak = {};
    let prev = slug(), hit = null;
    for (let s = 1; s <= steps; s++) {
      t.step(); await t.read();
      for (const [k, c] of Object.entries(t.counts())) peak[k] = Math.max(peak[k] ?? -1e9, c.Tmax);
      const cur = slug();
      if (!hit && cur && prev && cur[1].v[0] < prev[1].v[0] - 0.05) hit = { step: s, vxBefore: prev[1].v[0], vxAfter: cur[1].v[0], debrisV: debris && t.where(debris).map((c) => t.cell(c[0], c[1], c[2]).v[0]) };
      prev = cur ?? prev;
    }
    const after = t.counts();
    return {
      before: Object.fromEntries(Object.entries(before).map(([k, c]) => [k, c.n])),
      after: Object.fromEntries(Object.entries(after).map(([k, c]) => [k, `${c.n} (peak T ${peak[k]})`])),
      hit, Ehit: hit && +(0.5 * 78 * hit.vxBefore ** 2).toFixed(1),
      conserved: t.total() === Object.values(before).reduce((a, c) => a + c.n, 0),
    };
  };
  scenes.slugs = [
    ['GLASS pane, 1 thick, gap 5', () => shoot('GLASS', 1, 5)],
    ['GLASS pane, 3 thick, gap 5', () => shoot('GLASS', 3, 5)],
    ['METAL plate, 2 thick, gap 5', () => shoot('METAL', 2, 5)],
    ['ROCK block, 6 thick, gap 2', () => shoot('ROCK', 6, 2)],
    ['ROCK block, 6 thick, gap 12', () => shoot('ROCK', 6, 12)],
    ['WOOD plank, 2 thick, gap 5', () => shoot('WOOD', 2, 5)],
    ['WALL, gap 5', () => shoot('WALL', 2, 5)],
    ['GLASS pane, gap 20', () => shoot('GLASS', 1, 20)],   // the pane starts out in quiet bricks and has to wake in time
    ['GLASS pane, diagonal xz', () => shoot('GLASS', 1, 5, 40, { vx: 0.8, vz: 0.6 })],
    ['GLASS corner, diagonal down', () => shoot('GLASS', 1, 3, 40, { vx: 0.75, vy: -0.75 }, () => t.box(20, 39, 35, 35, 22, 42, 'GLASS'))],
  ];
  // a slug into a powder keg (constructions/builtins.js barrel 'keg') from the old check's 4 ranges × 7 offsets
  scenes.keg = [1, 6, 14, 24].flatMap((gap) => [-3, -2, -1, 0, 1, 2, 3].map((trial) => [`gap ${gap}, z${trial}`, async () => {
    const { barrel } = await import('/src/constructions/builtins.js');
    const y0 = 6 + Math.round(0.0125 * (gap + 1) ** 2);   // aim higher from further out: the slug drops ~g·n²/2
    t.fresh();
    t.box(0, 63, 0, 0, 0, 63, 'ROCK');
    barrel({ put: (x, y, z, key) => key !== 'AIR' && t.set(32 + x, 1 + y, 32 + z, key), T: 1 }, 'keg');
    t.set(32 - 5 - gap, y0, 32 + trial, 'SCRAP', { vx: 1 });
    t.load();
    await t.read();
    const gp0 = t.where('GUNPOWDER').length;
    let boom = null, broke = null;
    for (let s = 1; s <= 90 && boom === null; s++) {
      t.step(); await t.read();
      if (broke === null && t.where('SAWDUST').length) broke = s;
      if (t.where('GUNPOWDER').length < gp0) boom = s;
    }
    return `${broke === null ? 'shell held' : `shell broke at step ${broke}`}, ${boom === null ? 'no boom' : `BOOM at ${boom}`}`;
  }]));
  // gunpowder blasts next to panes: touching on +x, 3 cells off on −x, 6 off on +z
  scenes.blast = ['small', 'big'].flatMap((pile) => ['GLASS', 'ICE', 'PLANT', 'WOOD', 'ROCK', 'METAL'].map((mat) => [`${pile} ${mat}`, async () => {
    t.fresh();
    const [a0, a1] = pile === 'small' ? [31, 33] : [29, 35];
    const y0 = 10, y1 = y0 + a1 - a0;
    t.box(a0, a1, y0, y1, a0, a1, 'GUNPOWDER', pile === 'small' ? { T: 250 } : {});
    if (pile !== 'small') t.set(a0 - 1, y0, a0, 'FIRE');
    const panes = {
      touching: [a1 + 1, a1 + 1, y0 - 4, y1 + 4, a0 - 4, a1 + 4],
      'gap 3': [a0 - 4, a0 - 4, y0 - 4, y1 + 4, a0 - 4, a1 + 4],
      'gap 6': [a0 - 2, a1 + 2, y0 - 4, y1 + 4, a1 + 7, a1 + 7],
    };
    for (const b of Object.values(panes)) t.box(...b, mat);
    t.load();
    const n0 = {};
    await t.read();
    const inPane = (b) => { let n = 0; for (let x = b[0]; x <= b[1]; x++) for (let y = b[2]; y <= b[3]; y++) for (let z = b[4]; z <= b[5]; z++) if (t.cell(x, y, z).key === mat) n++; return n; };
    for (const [k, b] of Object.entries(panes)) n0[k] = inPane(b);
    t.step(80); await t.read();
    return Object.fromEntries(Object.entries(panes).map(([k, b]) => [k, `${n0[k] - inPane(b)}/${n0[k]} broken`]));
  }]));
  // sand dropped onto a rock floor and onto the box floor: how warm does it get?
  scenes.sandDrop = ['ROCK', 'box'].flatMap((floor) => [10, 30, 55].map((hgt) => [`${floor} floor, drop ${hgt}`, async () => {
    t.fresh();
    if (floor === 'ROCK') t.box(0, 63, 0, 1, 0, 63, 'ROCK');
    const y = (floor === 'ROCK' ? 2 : 0) + hgt;
    t.box(30, 34, y, y + 1, 30, 34, 'SAND');
    t.load();
    let sMax = -1e9, rMax = -1e9;
    for (let s = 0; s < 160; s += SAND_DROP_EVERY) {
      t.step(SAND_DROP_EVERY); await t.read();
      for (const c of t.where('SAND')) sMax = Math.max(sMax, c[3]);
      if (floor === 'ROCK') for (let x = 30; x <= 34; x++) for (let z = 30; z <= 34; z++) rMax = Math.max(rMax, t.cell(x, 1, z).T);
    }
    return { sandTmax: sMax, floorTmax: floor === 'ROCK' ? rMax : null, sandCount: t.where('SAND').length };
  }]));
  // debris: shards resist acid, sawdust burns, shards and scrap melt and recast
  scenes.debris = [
    ['acid', async () => {
      t.fresh();
      t.box(10, 20, 0, 1, 10, 20, 'SHARDS');
      t.box(30, 40, 0, 1, 10, 20, 'SAND');
      t.box(10, 20, 2, 4, 10, 20, 'ACID');
      t.box(30, 40, 2, 4, 10, 20, 'ACID');
      t.load();
      t.step(200); await t.read();
      return { shardsLeft: `${t.where('SHARDS').length}/242`, sandLeft: `${t.where('SAND').length}/242` };
    }],
    ['sawdust', async () => {
      t.fresh();
      t.box(20, 24, 0, 1, 20, 24, 'SAWDUST', { T: 300 });
      t.load();
      t.step(300); await t.read();
      const c = t.counts();
      return { SAWDUST: c.SAWDUST?.n ?? 0, ASH: c.ASH?.n ?? 0, FIRE: c.FIRE?.n ?? 0, SMOKE: c.SMOKE?.n ?? 0 };
    }],
    ...['SHARDS', 'SCRAP'].map((key) => [key, async () => {
      t.fresh();
      t.box(0, 63, 0, 0, 0, 63, 'WALL');
      t.set(32, 1, 32, key, { T: key === 'SHARDS' ? 1450 : 1550 });
      t.load();
      t.step(2); await t.read();
      const melted = t.cell(32, 1, 32);
      await t.edit((at) => { t.rA[at(32, 1, 32) + 1] = 1000; });
      t.step(2); await t.read();
      return { melted: `${melted.key}, remembers ${ELEMENTS[melted.ctype].key}`, cooled: t.cell(32, 1, 32).key };
    }]),
  ];

  try {
    const bad = names.filter((n) => !scenes[n]);
    if (bad.length) throw new Error(`engine: no scene ${bad.join(', ')} (have: ${Object.keys(scenes).join(', ')})`);
    // the cases from `from` on, until budgetMs is spent
    const cases = names.flatMap((n) => scenes[n].slice(0, perScene ?? Infinity).map(([c, run]) => [n, c, run]));
    const start = performance.now();
    let i = from;
    for (; i < cases.length && (i === from || performance.now() - start < budgetMs); i++) {
      const [scene, name, run] = cases[i], t0 = performance.now();
      (out.numbers[scene] ??= {})[name] = await run();
      out.ms[`${scene}: ${name}`] = performance.now() - t0;
      progress(`engine: ${scene}, ${name}`);
    }
    out.next = i < cases.length ? i : null;
    out.of = cases.length;
    check(out, 'no GPU failures', !h.failures.length, h.failures.join(' | '));
    return out;
  } finally { sim.dispose(); }
});

ready();
