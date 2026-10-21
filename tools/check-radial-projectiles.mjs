// Projectiles fall along the world's own gravity, as its matter and the first-person body do
// (src/pov/gravityField.js). Under TPT's radial gravity (Simulation.cpp GetGravityField: the full
// strength, pointed at the centre) a thrown grenade, a bullet's drop, a frag's hops, a wand bolt's arc
// and a bot's aimed lob all turn toward the box's centre; under normal gravity nothing changes, bit
// for bit. The real ballistics (src/pov/ballistics.js) and frags (src/pov/frag.js) fly over a CPU
// stand-in for the trace pass: a stone ball (a TPT-style planet) round the box's centre. Both engines
// (V1, and V2's clock with sim.compact set). No browser or GPU.
//
//   node tools/check-radial-projectiles.mjs              the check
//   node tools/check-radial-projectiles.mjs --dump FILE  also write normal gravity's paths (exact) to FILE
//   node tools/check-radial-projectiles.mjs --pin        print their hash, to re-pin NORMAL_PATHS_SHA256
//                                                        after a change to the shots or frags you meant
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createBallistics, ROUND_SPEED, ROUND_GRAVITY, gravityScale } from '../src/pov/ballistics.js';
import { createFrags } from '../src/pov/frag.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { povEvents } from '../src/pov/events.js';
import { TRACE, TRACE_MISS, TRACE_ROUND, TRACE_FACE_FLOOR } from '../src/shaders/povTrace.js';
import { THROW_SPEED } from '../src/pov/tools/bomb.tool.js';
import { E } from '../src/elements.js';
import { GRAV } from '../src/simModes.js';
import { radialGravity, pullAt, upAt, fallSegment } from '../src/pov/gravityField.js';
import { lobArc } from '../src/pov/ai/brain.js';

const FPS = 60;
const V1_STEPS = 4;                       // V1 steps a frame (app.js DEFAULTS.steps)
const V2_TICKS = 1;                       // V2 ticks a frame at a 60 Hz display (v2/host.js)
const N = 128;                            // cells: the box
const CENTRE = new THREE.Vector3(N / 2, N / 2, N / 2);
const PLANET_R = 24;                      // cells: the stone ball round the centre
const FRAMES = 360;                       // frames each scenario runs at most (6 s)
const dumpAt = process.argv.indexOf('--dump');
const DUMP = dumpAt >= 0 ? process.argv[dumpAt + 1] : null;
const PIN = process.argv.includes('--pin');
// sha256 of normal gravity's paths (every move and strike of the shots, the frag's hops and blast, as
// JSON's exact doubles), taken on 6a056d8d before projectiles followed radial gravity: normal gravity
// must stay bit for bit what it was
const NORMAL_PATHS_SHA256 = '890800541bd9ef8e3fc212388af7c492e2eb5cf24bda12a390477a96415462f8';
const SAME = 1e-9;                        // cells (or a unit vector's share): agreement to rounding
const NEAR = 1.5;                         // cells: a strike on the planet's surface (a trace's cell)
const LOB_DT = 1 / 1000;                  // s: the steps a lob's flight is sampled at (a throw moves 0.06 cells in one)
const LOB_MISS = 0.1;                     // cells: the most a sampled lob may pass its target by
const LOB_FLIGHT_S = 5;                   // s of a lob's flight searched for its nearest pass

// ---- the trace pass's stand-in: each round's segment against the planet and the box's floor,
// answered as traceFrag answers (shaders/povTrace.js: cell + face, prev cell + id, point + share)
function answer(starts, ends) {
  const buf = new Float32Array(TRACE.ROWS * TRACE.ROUNDS * 4);
  for (let i = 0; i < TRACE.ROUNDS; i++) {
    const a = i * 4, b = (TRACE.ROUNDS + i) * 4, c = (2 * TRACE.ROUNDS + i) * 4;
    buf[a + 3] = TRACE_MISS;
    if (starts[i][3] !== TRACE_ROUND) continue;
    const s = new THREE.Vector3(...starts[i]), e = new THREE.Vector3(...ends[i]), d = e.clone().sub(s);
    // the planet: the first u in [0, 1] where |s + u·d − c| = R, entering it
    const m = s.clone().sub(CENTRE), A = d.dot(d), B = 2 * m.dot(d), C = m.dot(m) - PLANET_R * PLANET_R;
    const disc = B * B - 4 * A * C;
    let u = Infinity, face = TRACE_MISS;
    if (A > 0 && disc >= 0) {
      const u0 = (-B - Math.sqrt(disc)) / (2 * A);
      if (u0 >= 0 && u0 <= 1) {
        u = u0;
        const n = s.clone().addScaledVector(d, u).sub(CENTRE), k = ['x', 'y', 'z'].reduce((x, y) => (Math.abs(n[y]) > Math.abs(n[x]) ? y : x));
        face = 'xyz'.indexOf(k) * 2 + (n[k] < 0 ? 1 : 0);   // stepping against the outward normal
      }
    }
    // the box's floor (traceFrag: stepping down out of y = 0)
    if (e.y < 0 && s.y >= 0) { const uf = s.y / (s.y - e.y); if (uf < u) { u = uf; face = TRACE_FACE_FLOOR; } }
    if (face === TRACE_MISS) continue;
    const p = s.clone().addScaledVector(d, u);
    buf.set([Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), face], a);
    buf.set([Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z), E.STONE], b);
    buf.set([p.x, p.y, p.z, u], c);
  }
  return buf.buffer;
}
let simIds = 1;
function world({ v2 = false, gravityMode = GRAV.VERTICAL, gravity = 0.025 } = {}) {
  const sim = { id: simIds++, g: { nx: N, ny: N, nz: N }, frame: 0, gravityMode, touch: () => [], touchCentres: () => [] };
  sim.gravity = gravityMode === GRAV.OFF ? 0 : gravity;   // (sim.js: the getter reads 0 with the mode off)
  if (v2) sim.compact = {};
  setPovGpu(sim, {
    ready: true, probeReady: () => true, edit: () => true,
    probe: (name, { starts, ends }) => Promise.resolve(answer(starts, ends)),
  });
  return sim;
}
const frame = (sim) => ({ sim, dt: 1 / FPS, stepsPerFrame: sim.compact ? V2_TICKS : V1_STEPS });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// everything a projectile tells the bus while `run` flies it: its moves and its strikes, exactly
async function record(run) {
  const log = [];
  const offs = [
    povEvents.on('round:move', ({ id, kind, from, to }) => log.push(['move', id, kind, ...from.toArray(), ...to.toArray()])),
    povEvents.on('round:end', ({ id, kind }) => log.push(['end', id, kind])),
  ];
  try { await run(log); } finally { offs.forEach((off) => off()); }
  return log;
}

// shots on one engine's ballistics: bullets, a bomb's throw (with the thrower's run) and a throw beside the
// planet; lob: a gentle toss there too (radial only: normal gravity's paths are pinned as they were)
const LOB_SHARE = 1 / 4;                  // of a bomb's throw speed: a toss that comes down beside the planet
async function shots(opts, { lob = false } = {}) {
  const sim = world(opts), engine = createBallistics();
  engine.prepare(sim);
  const strikes = [], flown = {};
  const onStrike = (tag) => ({ hit, dir, normal }) => strikes.push([tag, ...hit.point.toArray(), hit.t ?? null, ...dir.toArray(), ...normal.toArray()]);
  const shot = (tag, ...args) => { const id = engine.fire(...args); flown[tag] = engine.rounds.find((r) => r.id === id); };
  const log = await record(async () => {
    const gs = gravityScale(sim);
    shot('level', new THREE.Vector3(20, 100, 64), new THREE.Vector3(1, 0, 0), gs);
    shot('down', new THREE.Vector3(20, 100, 64), new THREE.Vector3(1, -0.3, 0.2), gs);
    shot('slow', new THREE.Vector3(30, 40, 20), new THREE.Vector3(0.5, 0.5, 0.1), gs, { speed: ROUND_SPEED / 4, onStrike: onStrike('slow') });
    shot('bomb', new THREE.Vector3(64, 95, 4), new THREE.Vector3(0.05, 0, 1), gs, { speed: THROW_SPEED, carry: new THREE.Vector3(1, 0, 2), kind: 'bomb', onStrike: onStrike('bomb') });
    shot('beside', new THREE.Vector3(100, 64, 64), new THREE.Vector3(0, 1, 0), gs, { speed: THROW_SPEED, kind: 'bomb', onStrike: onStrike('beside') });
    if (lob) shot('lob', new THREE.Vector3(100, 64, 64), new THREE.Vector3(0, 1, 0), gs, { speed: THROW_SPEED * LOB_SHARE, kind: 'bomb', onStrike: onStrike('lob') });
    for (let i = 0; i < FRAMES && engine.count; i++) { engine.update(frame(sim)); await tick(); }
  });
  engine.dispose();
  return { log, strikes, flown, gs: gravityScale(sim) };
}
const strikeOf = (run, tag) => run.strikes.find((s) => s[0] === tag);

// a Halo frag thrown onto the planet: its hops (each a ballistics launch), its rest and its blast
async function frag(opts) {
  const sim = world(opts), engine = createBallistics();
  engine.prepare(sim);
  const launches = [];
  const fire = engine.fire;
  engine.fire = (from, dir, gs, o) => { launches.push([...from.toArray(), ...dir.toArray(), gs, o.speed]); return fire(from, dir, gs, o); };
  const frags = createFrags({ scene: new THREE.Scene(), getSim: () => sim, getVolume: () => ({ position: new THREE.Vector3() }), getScale: () => 1, ballistics: () => engine });
  const thrower = { pos: new THREE.Vector3(64, 100, 50), vel: new THREE.Vector3() };
  const log = await record(async () => {
    assert.ok(frags.throw(thrower, new THREE.Vector3(64, 103, 50), new THREE.Vector3(0, -1, 0.4)), 'a frag leaves the hand');
    for (let i = 0; i < FRAMES && frags.count; i++) {
      const f = frame(sim);
      engine.update(f); frags.update(f.dt, f.stepsPerFrame);
      await tick();
    }
  });
  const blast = frags.lastBlast;
  frags.dispose(); engine.dispose();
  return { log, launches, blast: blast && { point: blast.point.toArray(), t: blast.t, bounced: blast.bounced } };
}

// ---- normal gravity: every path, on both engines and at the settings that scale it
const NORMAL = [
  ['V1', {}], ['V2', { v2: true }], ['V1 half', { gravity: 0.0125 }], ['V2 half', { v2: true, gravity: 0.0125 }],
  ['V1 off', { gravityMode: GRAV.OFF }], ['V2 off', { v2: true, gravityMode: GRAV.OFF }],
];
const normal = {}, normalShots = {};
for (const [name, opts] of NORMAL) {
  normalShots[name] = await shots(opts);
  normal[name] = { shots: { log: normalShots[name].log, strikes: normalShots[name].strikes }, frag: await frag(opts) };
}
const paths = JSON.stringify(normal), hash = createHash('sha256').update(paths).digest('hex');
if (DUMP) { writeFileSync(DUMP, paths); console.log(`wrote normal gravity's paths to ${DUMP}`); }
if (PIN) { console.log(`NORMAL_PATHS_SHA256 = '${hash}'`); process.exit(0); }
assert.equal(hash, NORMAL_PATHS_SHA256, 'normal gravity\'s shots and frags left the paths they flew before radial gravity '
  + '(bit for bit). If you changed them on purpose, re-pin: node tools/check-radial-projectiles.mjs --pin');
// ...and each one is the one closed form straight down: no stretches, the pull (0, −g, 0) at its scale
for (const [name, run] of Object.entries(normalShots)) for (const [tag, r] of Object.entries(run.flown)) {
  assert.equal(r.knots, null, `${name} ${tag}: one parabola straight down`);
  assert.deepEqual(r.g.toArray(), [0, -ROUND_GRAVITY * run.gs, 0], `${name} ${tag}: falls straight down at the setting's 1 g`);
}
assert.deepEqual(strikeOf(normalShots.V1, 'beside').slice(1, 4), [100, 0, 64], 'straight down, the throw beside the planet falls past it to the floor');
console.log('normal gravity: every shot, throw and frag flies the path it flew before, bit for bit (V1, V2, half, off)');

// ---- radial gravity: toward the box's centre, at each projectile's own strength
for (const v2 of [false, true]) {
  const engineName = v2 ? 'V2' : 'V1';
  const run = await shots({ v2, gravityMode: GRAV.RADIAL }, { lob: true });
  const pull = ROUND_GRAVITY * run.gs;
  // every stretch's pull points at the centre from where the stretch starts, at the round's 1 g
  for (const [tag, r] of Object.entries(run.flown)) {
    assert.ok(r.knots?.length > 1, `${engineName} ${tag}: its path turns as it flies`);
    for (const k of r.knots) {
      const to = CENTRE.clone().sub(k.p0).normalize();
      assert.ok(Math.abs(k.g.length() - pull) < SAME * pull, `${engineName} ${tag}: the pull keeps its strength (${k.g.length()} vs ${pull})`);
      assert.ok(k.g.clone().normalize().dot(to) > 1 - SAME, `${engineName} ${tag}: the pull points at the centre`);
    }
    // the stretches join: each starts where the last one's parabola has got to
    for (let i = 1; i < r.knots.length; i++) {
      const a = r.knots[i - 1], b = r.knots[i], u = b.t0 - a.t0;
      const at = a.p0.clone().addScaledVector(a.v0, u).addScaledVector(a.g, 0.5 * u * u);
      assert.ok(at.distanceTo(b.p0) < SAME, `${engineName} ${tag}: stretch ${i} starts where ${i - 1} ends`);
    }
  }
  // a bomb tossed "up" beside the planet (sideways to the pull there) falls back onto the planet's near side
  // (straight down the same throw falls past it to the floor: above)
  const beside = strikeOf(run, 'lob');
  assert.ok(beside, `${engineName}: the toss beside the planet lands`);
  const point = new THREE.Vector3(...beside.slice(1, 4));
  assert.ok(Math.abs(point.distanceTo(CENTRE) - PLANET_R) < NEAR, `${engineName}: it lands on the planet (${point.toArray()})`);
  assert.ok(point.x > CENTRE.x + PLANET_R / 2, `${engineName}: on the side it was thrown from (${point.toArray()})`);
  assert.deepEqual(beside.slice(-3), [1, 0, 0], `${engineName}: on the face turned toward it`);
  console.log(`radial ${engineName}: rounds pull at ${pull.toFixed(1)} cells/s² toward the centre; a bomb tossed beside the planet lands on it at ${point.toArray().map((x) => x.toFixed(1))}`);
}

// a big map's window moving over the world (docs/scaling.md D11): a round in flight keeps its path in the
// world, every stretch of it moved back with the window (the field stays the window's, as for its matter)
{
  const sim = world({ gravityMode: GRAV.RADIAL }), engine = createBallistics();
  sim.g.windowed = true;
  engine.prepare(sim);
  const id = engine.fire(new THREE.Vector3(100, 64, 64), new THREE.Vector3(0, 1, 0), gravityScale(sim), { speed: THROW_SPEED * LOB_SHARE, kind: 'bomb', onStrike() {} });
  const r = engine.rounds.find((x) => x.id === id);
  for (let i = 0; i < 6; i++) { engine.update(frame(sim)); await tick(); }
  const before = r.knots.map((k) => k.p0.clone()), SHIFT = [8, -4];
  engine.windowShifted(...SHIFT);
  r.knots.slice(0, before.length).forEach((k, i) => assert.ok(k.p0.distanceTo(before[i].clone().sub(new THREE.Vector3(SHIFT[0], 0, SHIFT[1]))) < SAME,
    'a window shift moves every stretch of a round in flight back with the world'));
  engine.dispose();
  console.log('big maps: a window shift carries a round\'s turning path with the world');
}

// a Halo frag spilled by a body that dies on the planet's side: it drops toward the centre and lies on the
// planet there, as on a floor (straight down it falls past to the box's floor)
async function spill(gravityMode) {
  const sim = world({ gravityMode }), engine = createBallistics();
  engine.prepare(sim);
  const frags = createFrags({ scene: new THREE.Scene(), getSim: () => sim, getVolume: () => ({ position: new THREE.Vector3() }), getScale: () => 1, ballistics: () => engine });
  const random = Math.random;
  let seed = 1;
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // (its toss is random: Park–Miller, so the check repeats)
  const body = { pos: new THREE.Vector3(64, 60, 92), dead: false, grenades: 1 };
  try {
    povEvents.emit('game:spawn', { id: 'spill', body });
    frags.update(1 / FPS, V1_STEPS);
    body.dead = true;
    for (let i = 0; i < FRAMES; i++) {
      const f = frame(sim);
      engine.update(f); frags.update(f.dt, f.stepsPerFrame);
      await tick();
      if (frags.list[0]?.resting) break;
    }
    return frags.list[0];
  } finally {
    Math.random = random;
    povEvents.emit('game:stop', {});
    frags.dispose(); engine.dispose();
  }
}
const lying = await spill(GRAV.RADIAL), fallen = await spill(GRAV.VERTICAL);
assert.ok(lying?.resting, 'radial: the spilled frag comes to rest');
const lyingAt = new THREE.Vector3(...lying.pos);
assert.ok(Math.abs(lyingAt.distanceTo(CENTRE) - PLANET_R) < 2 * NEAR, `radial: it lies on the planet (${lying.pos})`);
assert.ok(lyingAt.z > CENTRE.z + PLANET_R / 2, `radial: on the side its body died on (${lying.pos})`);
assert.ok(fallen?.resting && fallen.pos[1] < NEAR, `straight down it falls past the planet to the floor (${fallen?.pos})`);
console.log(`radial frag: spilled beside the planet it lies on it at ${lying.pos} (straight down: on the floor at ${fallen.pos})`);

// ---- the shared field (gravityField.js), as the body, the wand bolts and the bots' aim read it
const radialSim = world({ gravityMode: GRAV.RADIAL }), downSim = world(), offSim = world({ gravityMode: GRAV.OFF });
assert.ok(radialGravity(radialSim) && !radialGravity(downSim) && !radialGravity(offSim), 'only radial mode turns the field');
assert.deepEqual(pullAt(downSim, { x: 3, y: 4, z: 5 }, 7), [0, -7, 0], 'straight down: (0, −g, 0)');
assert.deepEqual(pullAt(radialSim, CENTRE, 7), [0, 0, 0], 'radial: nothing pulls at the centre');
assert.equal(upAt(radialSim, CENTRE, new THREE.Vector3()), null, 'radial: no up at the centre');
assert.deepEqual(upAt(downSim, { x: 1, y: 2, z: 3 }, new THREE.Vector3()).toArray(), [0, 1, 0], 'straight down: up is +y');
assert.ok(upAt(radialSim, { x: 100, y: 64, z: 64 }, new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 0, 0)) < SAME, 'radial: up is away from the centre');
// a wand bolt's stretch: straight down, the y-only rule it had (runtime.js), bit for bit; radial, toward the centre
let rnd = 7;
const r01 = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 64; i++) {
  const g = (r01() - 0.3) * 120, step = r01() / 10, at = new THREE.Vector3(r01() * N, r01() * N, r01() * N);
  const to = new THREE.Vector3(r01(), r01(), r01()), vel = new THREE.Vector3(r01(), r01(), r01());
  const want = [to.clone(), vel.clone()];
  want[0].y -= g * step * step / 2;   // (runtime.js before: to.y -= finite(p.gravity) * step * step / 2)
  want[1].y -= g * step;              // (velocity.y -= finite(p.gravity) * step)
  fallSegment(downSim, at, g, step, to, vel);
  assert.ok(to.equals(want[0]) && vel.equals(want[1]), 'a wand bolt falls straight down bit for bit as before');
  const t2 = new THREE.Vector3(), v2 = new THREE.Vector3();
  fallSegment(radialSim, at, g, step, t2, v2);
  const toward = CENTRE.clone().sub(at).normalize().multiplyScalar(g);
  assert.ok(v2.distanceTo(toward.clone().multiplyScalar(step)) < SAME * (1 + Math.abs(g)), 'a wand bolt falls toward the centre (away for anti-gravity)');
  assert.ok(t2.distanceTo(toward.multiplyScalar(step * step / 2)) < SAME * (1 + Math.abs(g)), "and its stretch's drop is ½·g·dt² that way");
}
const runtime = readFileSync(new URL('../src/pov/wands/runtime.js', import.meta.url), 'utf8');
assert.ok(/fallSegment\(sim, grid\(r\.at\), finite\(p\.gravity\), step, to, velocity\)/.test(runtime), "the wand bolts' flight falls along the shared field");
console.log('wand bolts: straight down bit for bit as before; radial toward the centre, anti-gravity away');

// a bot's lob (ai/brain.js lobArc): straight down, the formula it had, bit for bit
const LOB_LOOK = 10;   // (brain.js)
const lobBefore = (e, p, v, g, lift) => {
  const dx = p.x - e.x, dz = p.z - e.z, x = Math.hypot(dx, dz), y = p.y + lift - e.y;
  const disc = v ** 4 - g * (g * x * x + 2 * y * v * v);
  if (disc < 0) return { x, look: null };
  const th = Math.atan((v * v - Math.sqrt(disc)) / (g * x)), c = Math.cos(th);
  return { x, look: { x: e.x + (dx / x) * c * LOB_LOOK, y: e.y + Math.sin(th) * LOB_LOOK, z: e.z + (dz / x) * c * LOB_LOOK } };
};
for (let i = 0; i < 64; i++) {
  const e = { x: r01() * N, y: r01() * N, z: r01() * N }, p = { x: r01() * N, y: r01() * N, z: r01() * N };
  const v = THROW_SPEED * (0.5 + r01()), g = ROUND_GRAVITY * (0.5 + r01()), lift = i % 2 ? 0.5 : 0;
  assert.deepEqual(lobArc(downSim, e, p, v, g, lift), lobBefore(e, p, v, g, lift), 'a bot lobs straight down as before');
}
// radial: the throw it aims, flown under the pull at its eye, comes down on the target
for (const [e, p] of [[[100, 64, 64], [100, 80, 70]], [[64, 64, 110], [70, 64, 92]], [[30, 100, 64], [52, 100, 64]]]) {
  const eye = new THREE.Vector3(...e), target = new THREE.Vector3(...p), v = THROW_SPEED, g = ROUND_GRAVITY;
  const { look } = lobArc(radialSim, eye, target, v, g);
  assert.ok(look, `radial: ${p} is in a throw's reach from ${e}`);
  const vel = new THREE.Vector3(look.x, look.y, look.z).sub(eye).setLength(v), a = new THREE.Vector3(...pullAt(radialSim, eye, g));
  let best = Infinity;
  for (let t = 0; t < LOB_FLIGHT_S; t += LOB_DT) best = Math.min(best, eye.clone().addScaledVector(vel, t).addScaledVector(a, t * t / 2).distanceTo(target));
  assert.ok(best < LOB_MISS, `radial: the lob from ${e} comes down on ${p} (misses by ${best.toFixed(3)} cells)`);
}
console.log('bots: their lobs straight down are the formula they had, bit for bit; radial lobs land in the field at their eye');
console.log('Radial projectiles: shots, throws, frags, wand bolts and the bots\' aim fall toward the centre under radial gravity; normal gravity is unchanged');
