// CPU check of the birds' flocking (src/birds/flock.js) against a made-up
// world: rolling hills, a sea, a wood of tree crowns to perch in, and a fire.
// No browser or GPU. usage: node tools/birds-check.mjs [--seed n]
//
// Checks: a flock stays together and clear of the ground and water for a few
// minutes of flight; it lands on tree crowns; a loud event and a body walking
// up flush it, away from the source; it roosts at night and stays down; fire
// sets birds alight and they fall; a killed bird falls to the ground and is
// cleared away; and what a frame of it costs.
import { Flock, BIRD, S, G } from '../src/birds/flock.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// mulberry32: the same flight every run (Yuka's wander draws Math.random too)
let seed = Number(arg('--seed', 7)) >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- the made-up world (cells)
const SEA = 18;                // water's surface
const SHORE_X = 420;           // sea past this x
const hills = (x, z) => 24 + 14 * Math.sin(x / 41) * Math.cos(z / 33) + 6 * Math.sin((x + z) / 17);
const TREES = [];              // crowns: centre column, ground, crown top
for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) {
  const x = 140 + i * 22, z = 140 + k * 22;
  TREES.push({ x, z, top: Math.floor(hills(x, z)) + 16, r: 4 });
}
const crownAt = (x, z) => TREES.find((t) => Math.hypot(x - t.x, z - t.z) <= t.r);
let fire = null;               // { x, z, r, lo, hi }: hot cells
const burnt = new Set();       // crowns that burned away
const world = {
  bounds: null,
  ground(x, z) {
    if (x > SHORE_X) return SEA;
    const c = crownAt(x, z);
    return c && !burnt.has(c) ? c.top : Math.max(SEA, hills(x, z));
  },
  hot(x, y, z) { return !!fire && Math.hypot(x - fire.x, z - fire.z) <= fire.r && y >= fire.lo && y <= fire.hi; },
  perches(x, z, r) {
    const out = [];
    for (const t of TREES) {
      if (burnt.has(t) || Math.hypot(t.x - x, t.z - z) > r + t.r) continue;
      for (let dx = -t.r; dx <= t.r; dx++) for (let dz = -t.r; dz <= t.r; dz++)
        if (Math.hypot(dx, dz) <= t.r) out.push({ x: t.x + dx + 0.5, y: t.top, z: t.z + dz + 0.5, tree: true });
    }
    return out;
  },
  holds(s) { return Math.abs(this.ground(s.x, s.z) - s.y) < 1; },
};

const BODY = 0.3 / 0.3;   // cells: a pigeon's body is ~0.3 m long
const TOUCH_SHARE = 1e-3;  // share of bird-frames with a neighbour nearer than that, at most
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const DT = 1 / 60;
const run = (flock, s, ctx = {}, each = null) => { for (let t = 0; t < s; t += DT) { flock.update(DT, typeof ctx === 'function' ? ctx(t) : ctx); each?.(t); } };
const count = (flock, st) => flock.birds.filter((b) => b.state === st).length;
const N = 12;

// ---- 1. flight: cohesion, clearance, spacing, speed
{
  const f = new Flock(world, [200, 70, 200], N);
  f.timer = Infinity;   // never lands
  let touches = 0, birdFrames = 0, maxSpread = 0, sumSpread = 0, frames = 0, minClear = Infinity, minGap = Infinity, minSpeed = Infinity, maxSpeed = 0, strays = 0;
  run(f, 180, {}, (t) => {
    if (t < 5) return;   // settled from the spawn
    f.updateCentre();
    let spread = 0;
    for (const b of f.birds) {
      const p = b.v.position;
      const d = p.distanceTo(f.centre);
      spread = Math.max(spread, d);
      if (d > BIRD.NEIGHBOR_R * 4) strays++;
      minClear = Math.min(minClear, p.y - world.ground(p.x, p.z));
      const s = b.v.getSpeed();
      minSpeed = Math.min(minSpeed, s); maxSpeed = Math.max(maxSpeed, s);
      let gap = Infinity;
      for (const o of f.birds) if (o !== b) gap = Math.min(gap, p.distanceTo(o.v.position));
      minGap = Math.min(minGap, gap);
      if (gap < BODY) touches++;
      birdFrames++;
    }
    maxSpread = Math.max(maxSpread, spread); sumSpread += spread; frames++;
  });
  const m = (c) => `${(c * 0.3).toFixed(1)} m`;
  console.log(`flight 3 min: spread mean ${m(sumSpread / frames)} max ${m(maxSpread)}; clearance min ${m(minClear)}; nearest pair ${m(minGap)}; speed ${(minSpeed * 0.3).toFixed(1)}–${(maxSpeed * 0.3).toFixed(1)} m/s`);
  check(sumSpread / frames < BIRD.NEIGHBOR_R * 2.5, 'flock stays cohesive (mean spread from its centre under 2.5 neighbourhoods)');
  check(strays === 0, `no bird strays past 4 neighbourhoods (${strays} bird-frames did)`);
  check(minClear > BIRD.SPAN / 2, 'never touches the ground or water');
  check(touches / birdFrames < TOUCH_SHARE, `birds keep a body length apart (closer in ${(100 * touches / birdFrames).toFixed(3)}% of bird-frames)`);
  check(minSpeed > BIRD.CRUISE * 0.15 && maxSpeed <= BIRD.MAX_SPEED + 1e-6, 'keeps flying speed, never past its top speed');
}

// ---- 2. over the sea and rising ground
{
  const f = new Flock(world, [SHORE_X + 60, SEA + 30, 220], N);
  f.timer = Infinity;
  f.home.set(260, 0, 220);   // home is inland, across the shore and up the hills
  let minClear = Infinity;
  run(f, 60, {}, () => { for (const b of f.birds) { const p = b.v.position; minClear = Math.min(minClear, p.y - world.ground(p.x, p.z)); } });
  f.updateCentre();
  check(minClear > BIRD.SPAN / 2, `crosses the sea and the shore inland clear of both (min ${(minClear * 0.3).toFixed(1)} m)`);
  check(Math.hypot(f.centre.x - 260, f.centre.z - 220) < BIRD.HOME_R * 1.5, 'turns back toward home');
}

// ---- 3. perching on tree crowns
const perched = (() => {
  const f = new Flock(world, [190, 70, 190], N);
  run(f, 3);
  f.timer = 0;   // time to land
  let t = 0;
  while (t < BIRD.LAND_TIMEOUT_S && count(f, S.PERCH) < f.birds.length) { f.update(DT); t += DT; }
  const n = count(f, S.PERCH);
  f.timer = Infinity;   // (its perch time, for the checks below)
  const onTrees = f.birds.filter((b) => b.state === S.PERCH && crownAt(b.v.position.x, b.v.position.z)
    && Math.abs(b.v.position.y - crownAt(b.v.position.x, b.v.position.z).top) < 1e-6).length;
  console.log(`landing: ${n}/${N} perched in ${t.toFixed(1)} s, ${onTrees} on crown tops`);
  check(n >= N * 0.75, 'most of the flock lands');
  check(onTrees === n, 'every perched bird stands on a tree crown');
  const down = f.birds.filter((b) => b.state === S.PERCH);
  run(f, 5);
  check(down.every((b) => b.state === S.PERCH), 'they stay put while nothing happens');
  return f;
})();

// ---- 4. a gunshot flushes the flock, away from it
{
  const f = perched;
  f.updateCentre();
  const shot = { x: f.centre.x + 30, y: f.centre.y, z: f.centre.z };
  const d0 = f.centre.distanceTo(shot);
  const were = f.birds.filter((b) => b.state === S.PERCH);
  f.startle(shot);
  check(count(f, S.PERCH) === 0, 'a loud event takes every perched bird off at once');
  const away = were.filter((b) => b.state === S.FLY && (b.v.velocity.x * (b.v.position.x - shot.x) + b.v.velocity.z * (b.v.position.z - shot.z)) > 0 && b.v.velocity.y > 0).length;
  check(away === were.length, `each leaves upward and away from it (${away}/${were.length})`);
  run(f, 2);
  f.updateCentre();
  console.log(`after 2 s: ${(f.centre.distanceTo(shot) * 0.3).toFixed(1)} m from the shot (was ${(d0 * 0.3).toFixed(1)} m)`);
  check(f.centre.distanceTo(shot) > d0 + BIRD.CRUISE * 0.5, 'the flock moves off from where the shot was');
}

// ---- 5. a body walking up flushes a perched flock
{
  const f = new Flock(world, [190, 70, 190], N);
  run(f, 3);
  f.timer = 0;
  let tl = 0;
  while (tl < BIRD.LAND_TIMEOUT_S && f.mode !== 'perch') { f.update(DT); tl += DT; }
  f.timer = Infinity;
  const before = count(f, S.PERCH);
  f.updateCentre();
  const c = f.centre.clone();
  const EYE = 5;   // cells: the body's head over the ground it walks on
  const body = { x: c.x - 60, y: 0, z: c.z };
  let flushedAt = null;
  run(f, 20, { threats: [body] }, (t) => {
    body.x += 1.4 / 0.3 * DT;   // walking, 1.4 m/s, over the hills
    body.y = Math.max(SEA, hills(body.x, body.z)) + EYE;
    if (flushedAt === null && count(f, S.PERCH) === 0) flushedAt = Math.hypot(body.x - c.x, body.z - c.z);
  });
  console.log(`walk-up: ${before} perched; flushed with the body ${flushedAt === null ? '—' : `${(flushedAt * 0.3).toFixed(1)} m`} from the flock's centre`);
  check(before > 0 && flushedAt !== null && flushedAt > BIRD.STARTLE_R * 0.5, 'a body coming near flushes them before it reaches them');
}

// ---- 6. roosting at night
{
  const f = new Flock(world, [190, 70, 190], N);
  f.timer = Infinity;
  run(f, 3);
  let t = 0;
  while (t < 30 && f.mode !== 'perch') { f.update(DT, { night: true }); t += DT; }
  const n0 = count(f, S.PERCH);
  const roosted = f.birds.filter((b) => b.state === S.PERCH);
  run(f, 180, { night: true });
  const n1 = count(f, S.PERCH);
  console.log(`night: settled in ${t.toFixed(1)} s, ${n0} perched, ${n1} still after 3 min`);
  check(n0 >= N * 0.75 && roosted.every((b) => b.state === S.PERCH), 'at night the flock roosts and stays down');
  run(f, 2, { night: false });
  check(count(f, S.PERCH) === 0, 'in the morning it flies again (its perch time ran out in the night)');
}

// ---- 7. fire: birds that fly into it burn and fall
{
  const f = new Flock(world, [200, 60, 200], N);
  f.timer = Infinity;
  run(f, 2);
  f.updateCentre();
  fire = { x: f.centre.x, z: f.centre.z, r: 40, lo: 0, hi: f.centre.y + 40 };
  let burnedAny = false;
  run(f, 0.5, {}, () => { if (count(f, S.BURN)) burnedAny = true; });
  fire = null;
  run(f, 12);
  const dead = count(f, S.DEAD);
  const onGround = f.birds.filter((b) => b.state === S.DEAD && Math.abs(b.v.position.y - world.ground(b.v.position.x, b.v.position.z)) < 1e-6).length;
  console.log(`fire: ${dead}/${N} burned and fell, ${onGround} lie on the ground`);
  check(burnedAny && dead === N && onGround === N, 'every bird in the fire caught alight, fell and lies on the ground');
}

// ---- 8. a killed bird falls, lies a while, then is cleared
{
  const f = new Flock(world, [200, 60, 200], N);
  f.timer = Infinity;
  run(f, 2);
  const b = f.birds[0];
  const y0 = b.v.position.y;
  f.kill(b, { x: 1, y: 0, z: 0 });
  let t = 0;
  while (b.state === S.FALL && t < 10) { f.update(DT); t += DT; }
  const h = y0 - b.v.position.y;
  const tFree = Math.sqrt(2 * Math.max(h, 0) / G);
  console.log(`shot: fell ${(h * 0.3).toFixed(1)} m in ${t.toFixed(2)} s (free fall ${tFree.toFixed(2)} s)`);
  const lies = Math.abs(b.v.position.y - world.ground(b.v.position.x, b.v.position.z)) < 1e-6;
  check(b.state === S.DEAD && lies && t < tFree * 2, 'a shot bird falls (under gravity, with drag) to the ground');
  check(f.alive === N - 1, 'the rest fly on');
  run(f, BIRD.DEAD_LINGER_S + 0.1);
  f.prune();
  check(f.birds.length === N - 1, 'it is cleared away after a while');
}

// ---- 9. cost: three flocks over the world
{
  const flocks = [0, 1, 2].map((i) => new Flock(world, [180 + i * 40, 70, 200], 14));
  for (const f of flocks) f.timer = Infinity;
  for (let i = 0; i < 120; i++) for (const f of flocks) f.update(DT);
  const FR = 1200;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FR; i++) for (const f of flocks) f.update(DT);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / FR;
  console.log(`cost: ${ms.toFixed(3)} ms a frame for 3 flocks of 14 (60 fps, node)`);
  check(ms < 0.5, 'under 0.5 ms of CPU a frame');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall birds checks passed');
process.exit(fails ? 1 : 0);
