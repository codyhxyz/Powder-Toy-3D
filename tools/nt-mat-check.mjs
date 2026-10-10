// CPU check of Noita's materials (elements.js BLOOD ... PHEROMONE), on the
// dock tiles' engine port (src/ui/tiles/engine.js: a 2D slice running the
// same rules as the GPU passes):
//   ids       the element count fits the far grid (shaders/far.js throws past it)
//   layers    each liquid poured in a tank with water settles above or below it
//             by density (whiskey floats, sludge and blood sink); the potions
//             stack in Noita's order
//   whiskey   a flame lights it within a few steps (its flash point), where oil
//             takes longer; warm (40 °C) with no flame it never burns
//   moss      grows from water over a rock floor and up a wall, stops within
//             DAMP_REACH of the water, and its grown layout then holds still:
//             no cell changes over the steps a loaded world is checked for
//             (tools/gen-check.mjs). Dry moss never grows; damp moss heated
//             dries and burns.
//   fungus    rots a log from its damp end, as far as the damp reaches, and
//             no further; on a dry log it never spreads
// Growth runs at a raised rate (GROW_FAST) where the check waits for it to
// finish; the at-rest checks run at the real rate.
// usage: node tools/nt-mat-check.mjs
import { World } from '../src/ui/tiles/engine.js';
import { E, ELEMENTS } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { FAR } from '../src/shaders/far.js';

const GRAVITY = 0.025;           // the app's default gravity (app.js DEFAULTS)
const SETTLE = 6000;             // steps for liquids to layer
const GROW_FAST = 0.01;          // growth chance per step per damp neighbour while waiting on growth
const GROW_STEPS = 60000;        // steps of fast growth (≈ 600 expected events per site: every site fills)
const REST_STEPS = 600;          // steps a loaded world must hold still (tools/gen-check.mjs)
const REAL_STEPS = 50000;        // steps at the real rate (≈ 3.5 min of play at 4 steps a frame)
const LIGHT_MAX = 400;           // steps to wait for a flame to light a liquid
const WARM_T = 40;               // °C: warm whiskey, past its flash point, far below autoignition
const FLAMBE_T = 30;             // °C: whiskey warmed for a flambé, just past its flash point
const POOL_TRIALS = 10;          // lit pools per temperature (lighting is chancy)
const POOL_WARM_MIN = 0.9;       // share of warm pools that must burn down

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const world = (nx, ny) => { const w = new World(nx, ny); w.gravity = GRAVITY; return w; };
const cells = (w, id) => { const out = []; for (let i = 0; i < w.id.length; i++) if (w.id[i] === id) out.push(i); return out; };
const meanY = (w, id) => { const c = cells(w, id); return c.reduce((s, i) => s + Math.floor(i / w.nx), 0) / c.length; };
const snapshot = (w) => Uint8Array.from(w.id);
const changed = (w, s) => { let n = 0; for (let i = 0; i < s.length; i++) n += s[i] !== w.id[i]; return n; };

// ---- ids
ok(ELEMENTS.length < FAR.LIQ_STRIDE, `${ELEMENTS.length} elements fit the far grid's ${FAR.LIQ_STRIDE} ids`);

// ---- layering: a tank, rock walls, the test liquid poured as the bottom
// half under water (or above it, for the light ones): it must end on its side
function layer(key) {
  const W = 12, H = 24, w = world(W, H);
  for (let y = 0; y < H; y++) { w.put(0, y, E.WALL); w.put(W - 1, y, E.WALL); }
  const heavy = ELEMENTS[E[key]].dens > ELEMENTS[E.WATER].dens;
  // start inverted: the heavy one on top
  for (let x = 1; x < W - 1; x++) for (let y = 0; y < 16; y++) w.put(x, y, (y < 8) === heavy ? E.WATER : E[key]);
  for (let s = 0; s < SETTLE; s++) w.step();
  const yk = meanY(w, E[key]), yw = meanY(w, E.WATER);
  ok(heavy ? yk < yw : yk > yw, `${key} (dens ${ELEMENTS[E[key]].dens}) settles ${heavy ? 'under' : 'over'} water: mean row ${yk.toFixed(1)} vs water ${yw.toFixed(1)}`);
}
for (const k of ['WHISKEY', 'TOXIC', 'BLOOD', 'SLIME', 'TELEPORTATIUM', 'LEVITATIUM', 'HEALTHIUM', 'BERSERKIUM', 'POLYMORPHINE', 'PHEROMONE']) layer(k);

// ---- whiskey: a flame on its surface; and warm with no flame
function lightAt(key) {
  const w = world(10, 10);
  for (let x = 0; x < 10; x++) for (let y = 0; y < 3; y++) w.put(x, y, E[key]);
  for (let s = 0; s < 20; s++) w.step();   // let it come to rest
  w.put(5, 3, E.FIRE);
  for (let s = 1; s <= LIGHT_MAX; s++) {
    w.step();
    if (cells(w, E[key]).some((i) => w.life[i] < ELEMENTS[E[key]].life)) return s;
  }
  return Infinity;
}
const tW = lightAt('WHISKEY'), tO = lightAt('OIL');
ok(tW < tO && tW <= 3, `a flame lights whiskey in ${tW} steps (flash point ${ELEMENTS[E.WHISKEY].flash} °C), oil in ${tO}`);
{
  const w = world(10, 10);
  for (let x = 0; x < 10; x++) for (let y = 0; y < 3; y++) w.put(x, y, E.WHISKEY, { T: WARM_T });
  for (let s = 0; s < SETTLE; s++) w.step();
  ok(cells(w, E.WHISKEY).every((i) => w.life[i] === ELEMENTS[E.WHISKEY].life) && cells(w, E.FIRE).length === 0,
    `whiskey at ${WARM_T} °C with no flame never burns (autoignition ${ELEMENTS[E.WHISKEY].ignite} °C)`);
}
// a pool lit by one flame: warmed past its flash point (as for a flambé) it
// burns down; at room temperature, just under it, a small flame often dies
// before the pool takes (as a match on cold spirit does)
function poolBurns(T) {
  const w = world(10, 10);
  for (let x = 0; x < 10; x++) for (let y = 0; y < 2; y++) w.put(x, y, E.WHISKEY, { T });
  w.put(5, 2, E.FIRE);
  const n0 = cells(w, E.WHISKEY).length;
  for (let s = 0; s < SETTLE; s++) w.step();
  return cells(w, E.WHISKEY).length < n0 / 2;
}
const share = (T) => { let n = 0; for (let r = 0; r < POOL_TRIALS; r++) n += poolBurns(T); return n / POOL_TRIALS; };
const warm = share(FLAMBE_T), cold = share(PHYS.AMBIENT);
ok(warm >= POOL_WARM_MIN, `a whiskey pool at ${FLAMBE_T} °C lit by one flame burns down in ${(warm * 100).toFixed(0)} % of ${POOL_TRIALS} trials; at ${PHYS.AMBIENT} °C in ${(cold * 100).toFixed(0)} %`);

// ---- moss: a rock floor, a pool held by moss at x = 4, a rock wall at x = 8
const DR = PHYS.DAMP_REACH;
function mossScene({ water = true } = {}) {
  const W = 20, H = 12, w = world(W, H);
  for (let x = 0; x < W; x++) w.put(x, 0, E.ROCK);
  w.put(0, 1, E.ROCK);
  if (water) for (let x = 1; x < 4; x++) w.put(x, 1, E.WATER);
  w.put(4, 1, E.MOSS);
  for (let y = 1; y < H; y++) w.put(8, y, E.ROCK);   // a wall: the moss climbs it
  return w;
}
function grow(w, steps, rate) {
  const keep = [PHYS.MOSS_GROW, PHYS.FUNGUS_GROW];
  PHYS.MOSS_GROW = PHYS.FUNGUS_GROW = rate;
  let last = 0, n = -1;
  for (let s = 0; s < steps; s++) {
    w.step();
    const m = cells(w, E.MOSS).length + cells(w, E.FUNGUS).length;
    if (m !== n) { n = m; last = s; }
  }
  [PHYS.MOSS_GROW, PHYS.FUNGUS_GROW] = keep;
  return last;   // the step of the last change in the growers' count
}
{
  const w = mossScene();
  const last = grow(w, GROW_STEPS, GROW_FAST);
  const moss = cells(w, E.MOSS);
  // reach along the mat: from the seed (damp DAMP_REACH) the floor carpet runs
  // right to the wall's foot, then up it, one less damp per cell
  const far = moss.map((i) => (i % w.nx - 4) + (Math.floor(i / w.nx) - 1)).reduce((a, b) => Math.max(a, b), 0);
  ok(far <= DR, `moss grows ${moss.length} cells, at most ${far} cells along the mat from the water (DAMP_REACH ${DR}); last growth at step ${last} of ${GROW_STEPS}`);
  ok(moss.length > 1 && w.id[w.idx(5, 1)] === E.MOSS, 'moss creeps along the floor from the water');
  ok(w.id[w.idx(7, 2)] === E.MOSS, 'moss climbs the wall at the corner');
  ok(w.id[w.idx(4, 2)] === E.EMPTY && w.id[w.idx(5, 2)] === E.EMPTY, 'moss stays a one-cell mat on the rock (it never grows up into open air)');
  const dampOk = moss.every((i) => {
    const x = i % w.nx, y = Math.floor(i / w.nx);
    const pathLen = (x - 4) + (y - 1);
    return w.ctype[i] === Math.max(DR - pathLen, 0);
  });
  ok(dampOk, `the mat's damp settles to DAMP_REACH less its distance along the mat: ${moss.map((i) => w.ctype[i]).join(' ')}`);
  // the grown layout is at rest: a generator can place it so
  const s0 = snapshot(w);
  for (let s = 0; s < REST_STEPS; s++) w.step();
  ok(changed(w, s0) === 0, `grown moss holds still for ${REST_STEPS} steps: ${changed(w, s0)} cells changed`);
  for (let s = 0; s < REAL_STEPS; s++) w.step();
  ok(changed(w, s0) === 0, `...and for ${REAL_STEPS} more at the real rate: ${changed(w, s0)} cells changed`);
}
{
  const w = mossScene({ water: false });
  grow(w, GROW_STEPS, GROW_FAST);
  ok(cells(w, E.MOSS).length === 1, `dry moss (no water) never grows: ${cells(w, E.MOSS).length} cell(s)`);
}
{
  // the real rate: how long the first creep takes
  const w = mossScene();
  let first = Infinity;
  for (let s = 0; s < REAL_STEPS && first === Infinity; s++) { w.step(); if (cells(w, E.MOSS).length > 1) first = s; }
  ok(first < REAL_STEPS, `at the real rate (MOSS_GROW ${PHYS.MOSS_GROW}) moss first creeps after ${first} steps (~${(first / 240).toFixed(0)} s at 4 steps a frame)`);
}
{
  // damp moss, heated: it dries, then burns
  const w = mossScene();
  for (let s = 0; s < 20; s++) w.step();
  const i = w.idx(4, 1);
  const damp = w.ctype[i];
  w.T[i] = 300; w.erase(w.idx(3, 1));   // hot, and no longer touching water
  w.step();
  ok(damp === DR && w.ctype[i] === 0 && w.life[i] < 1, `damp moss (damp ${damp}) heated to 300 °C dries (damp ${w.ctype[i]}) and burns (fuel ${w.life[i].toFixed(3)})`);
}

// ---- fungus: a log on a rock floor, water at its left end, a fungus seed
// between them
function logScene({ water = true } = {}) {
  const W = 20, H = 6, w = world(W, H);
  for (let x = 0; x < W; x++) w.put(x, 0, E.ROCK);
  w.put(0, 1, E.ROCK);
  if (water) w.put(1, 1, E.WATER);
  w.put(2, 1, E.FUNGUS);
  for (let x = 3; x < 16; x++) w.put(x, 1, E.WOOD);
  w.put(16, 1, E.ROCK);
  return w;
}
{
  const w = logScene();
  const wood0 = cells(w, E.WOOD).length;
  const last = grow(w, GROW_STEPS, GROW_FAST);
  const fungus = cells(w, E.FUNGUS), wood = cells(w, E.WOOD).length;
  const far = fungus.map((i) => i % w.nx - 2).reduce((a, b) => Math.max(a, b), 0);
  ok(wood === wood0 - DR && far === DR, `fungus rots ${wood0 - wood} of ${wood0} wood cells, ${far} along the log from the water (DAMP_REACH ${DR}); last growth at step ${last}`);
  const s0 = snapshot(w);
  for (let s = 0; s < REAL_STEPS; s++) w.step();
  ok(changed(w, s0) === 0, `the rotted log holds still for ${REAL_STEPS} steps: ${changed(w, s0)} cells changed`);
}
{
  const w = logScene({ water: false });
  grow(w, GROW_STEPS, GROW_FAST);
  ok(cells(w, E.FUNGUS).length === 1, `fungus on a dry log never spreads: ${cells(w, E.FUNGUS).length} cell(s)`);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
