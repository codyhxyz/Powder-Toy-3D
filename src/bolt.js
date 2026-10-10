// Lightning: one bolt, shared by the Lightning tool and by storms (src/lightning.js
// runs it on the GPU, shaders/lightning.js; the dock tiles' CPU twin,
// ui/tiles/engine.js, runs the same path and cell rules).
//
// The shape is TPT's LIGH (src/simulation/elements/LIGH.cpp), adapted to 3D: a
// stepped leader of straight segments, each turned off course by up to ±30°,
// that branches with chance 7/10 per segment; a branch turns up to ±100° from
// its parent and each of its segments is 1/1.5 as long as the last, so
// branches die out. TPT's bolt falls along gravity wherever it lands; ours
// steers each segment toward its target, so the main channel ends where it was
// sent: the surface under the cursor, or the point a storm's leader picked.
//
// What it leaves: the channel's air becomes PLASMA (elements.js: 10,000 °C, it
// recombines into air within a fraction of a second, as a real channel's
// afterglow does) with a little overpressure (thunder); matter the channel
// passes through takes BOLT.E of heat; at the strike point matter takes
// STRIKE_E (sand there fuses into glass: a fulgurite) and the air takes
// STRIKE_P, which cracks rock, brick and wood at the surface (lightning
// spalls rock: Knight & Grab 2014, Earth-Sci. Rev.) but not metal
// (physics.js P_BREAK_PER_HARD).
//
// Energy. A flash dissipates ~1 GJ, most of it heating the channel's air; one
// cell (0.3 m, 0.027 m³) at cap 1 per °C is 4.18 J/cm³ × 27,000 cm³ ≈ 113 kJ,
// so STRIKE_E (700 cap·°C) is ~80 MJ per cell of ground, over a strike's few
// cells a fraction of the flash, as ground strikes take. Wood (cap 0.3) takes
// +2,300 °C and lights, sand (0.35) +2,000 °C and fuses, water boils, steel
// (0.85) glows at +800 °C.
import { ELEMENTS, E } from './elements.js';

export const BOLT = {
  JITTER_DEG: 30,          // TPT: each segment turns up to ±30° (real channels: ~16° mean, Hill 1968)
  SEG_MIN: 4,              // cells: main-channel segment length, uniform between these...
  SEG_MAX: 10,             // ...(1.2-3 m: a channel's visible tortuosity, not a leader's 50 m steps)
  BRANCH_CHANCE: 0.7,      // TPT: chance a segment branches
  BRANCH_DEG: 100,         // TPT: a branch turns up to ±100° from its parent...
  BRANCH_DOWN: 0.2,        // ...but heads down at least this much (unit y): branches follow the field down
  BRANCH_DECAY: 1 / 1.5,   // TPT: each branch segment is this share of the last one's length
  BRANCH_MIN: 1.5,         // cells: a branch ends when its next segment would be shorter
  BRANCH_DEPTH: 2,         // branches of branches, at most this deep
  MAX_SEGS: 64,            // segments one bolt draws (the pass's uniform arrays)
  RADIUS: 0.75,            // cells: the main channel's radius (a continuous line of cells)
  BRANCH_RADIUS: 0.6,      // cells: a branch's
  START_JITTER: 6,         // cells: a tool bolt starts this far off the target's vertical, at most
  P: 10,                   // air pressure added along the channel (thunder)
  E: 300,                  // cap·°C into matter the channel passes through
  STRIKE_E: 700,           // cap·°C into matter at the strike point (falls off past STRIKE_CORE)
  STRIKE_CORE: 0.5,        // share of the strike radius at full strength
  STRIKE_P: 160,           // air pressure at the strike point: rock (hard 30) cracks at 150
  STRIKE_P_REACH: 1,       // cells past the strike radius that the pressure reaches
  STRIKE_R_SHARE: 0.35,    // the tool's strike radius: this share of the brush radius...
  STRIKE_R_MIN: 1,         // ...clamped to these, cells
  STRIKE_R_MAX: 4,
  RNG_SALT: 0x11e7,        // the bolt pass's own random stream (seed3)
};

// Storms (react.js charges cloud: physics.js CHARGE_*). A cloud cell at
// CHARGE_BREAKDOWN starts a leader; it strikes what it reaches first, the
// point nearest it within the striking distance (the rolling-sphere model of
// lightning protection, IEC 62305-3: r = 10·I^0.65 m, ~45 m for a 10 kA
// stroke; here what a box can hold). An upward streamer leaves a conductor
// first, so metal and water count as nearer by CONDUCTOR_BONUS.
export const STORM = {
  POLL_STEPS: 60,          // steps between looks for a charged cloud cell
  MIN_STEPS: 480,          // rate limit, map-wide: steps between natural strikes (2 s at 240 steps/s)
  SEARCH_R: 16,            // cells: candidate columns within this of the origin's column
  CANDIDATES: 16,          // columns examined: the origin's own, then rings
  CONDUCTOR_BONUS: 8,      // cells nearer a conductor counts
  STRIKE_R: 1.5,           // cells: a natural strike's radius
  DISCHARGE_R: 12,         // cells: cloud charge around the origin that a strike spends
};

// Matter a leader prefers: conductors (elements.js conducts), and water.
export const prefersStrike = (id) => id >= 0 && (Boolean(ELEMENTS[id]?.conducts) || id === E.WATER);

const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const madd = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

// dir turned by angle (radians) toward azimuth az around it
function deflect(dir, angle, az) {
  const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([dir[1] * ref[2] - dir[2] * ref[1], dir[2] * ref[0] - dir[0] * ref[2], dir[0] * ref[1] - dir[1] * ref[0]]);
  const w = [dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]];
  const c = Math.cos(angle), s = Math.sin(angle), ca = Math.cos(az), sa = Math.sin(az);
  return norm([0, 1, 2].map((k) => dir[k] * c + (u[k] * ca + w[k] * sa) * s));
}

// The bolt from `from` to `to` (cells, [x, y, z]), inside the box [0, size).
// rng: () => [0, 1). flat: a 2D slice (z held: the dock tiles). Returns
// segments { a, b, r } (ends in cells, channel radius r), main channel first,
// at most BOLT.MAX_SEGS.
export function boltPath(from, to, rng, size, flat = false) {
  const clampIn = (p) => p.map((v, k) => Math.min(Math.max(v, 0), size[k] - 1e-3));
  const segs = [];
  const turn = (dir, maxDeg) => {
    let d = deflect(dir, rng() * maxDeg * DEG, rng() * 2 * Math.PI);
    if (flat) d = norm([d[0], d[1], 0]);
    return d;
  };
  // main channel: steered at the target
  const joints = [];
  let p = from.slice();
  for (let guard = 0; segs.length < BOLT.MAX_SEGS; guard++) {
    const d = sub(to, p), dist = len(d);
    const step = BOLT.SEG_MIN + rng() * (BOLT.SEG_MAX - BOLT.SEG_MIN);
    if (dist <= step || segs.length === BOLT.MAX_SEGS - 1 || guard > BOLT.MAX_SEGS) { segs.push({ a: p, b: to.slice(), r: BOLT.RADIUS }); break; }
    const dir = turn(norm(d), BOLT.JITTER_DEG);
    const q = clampIn(madd(p, dir, step));
    q[1] = Math.max(q[1], to[1]);   // never below where it lands
    segs.push({ a: p, b: q, r: BOLT.RADIUS });
    joints.push({ p: q, dir, step });
    p = q;
  }
  // branches, from the main channel's joints while the budget lasts
  const branch = (start, dir0, step0, depth) => {
    let q = start, dir = dir0, step = step0 * BOLT.BRANCH_DECAY;
    while (step >= BOLT.BRANCH_MIN && segs.length < BOLT.MAX_SEGS) {
      const nq = clampIn(madd(q, dir, step));
      segs.push({ a: q, b: nq, r: BOLT.BRANCH_RADIUS });
      if (depth < BOLT.BRANCH_DEPTH && rng() < BOLT.BRANCH_CHANCE * BOLT.BRANCH_DECAY) branch(nq, fork(dir), step, depth + 1);
      q = nq;
      dir = turn(dir, BOLT.JITTER_DEG);
      step *= BOLT.BRANCH_DECAY;
    }
  };
  const fork = (dir) => {
    const d = turn(dir, BOLT.BRANCH_DEG);
    if (d[1] > -BOLT.BRANCH_DOWN) d[1] = -BOLT.BRANCH_DOWN;
    return flat ? norm([d[0], d[1], 0]) : norm(d);
  };
  for (const j of joints) if (rng() < BOLT.BRANCH_CHANCE) branch(j.p, fork(j.dir), j.step, 1);
  return segs;
}

// The tool's strike radius for a brush radius.
export const toolStrikeR = (radius) =>
  Math.min(BOLT.STRIKE_R_MAX, Math.max(BOLT.STRIKE_R_MIN, radius * BOLT.STRIKE_R_SHARE));

// Where a tool bolt starts: the top of the box, up to START_JITTER off the
// target's vertical.
export function boltStart(to, rng, size, flat = false) {
  const off = () => (rng() * 2 - 1) * BOLT.START_JITTER;
  const x = Math.min(Math.max(to[0] + off(), 0), size[0] - 1e-3);
  const z = flat ? to[2] : Math.min(Math.max(to[2] + off(), 0), size[2] - 1e-3);
  return [x, size[1] - 0.5, z];
}

// Candidate columns for a storm's leader (cells, [x, z]), around the origin's
// column: itself, then rings out to SEARCH_R, inside the box.
export function stormColumns(origin, size, n = STORM.CANDIDATES, flat = false) {
  const cols = [[Math.floor(origin[0]), Math.floor(origin[2])]];
  const rings = 2, perRing = Math.ceil((n - 1) / rings);
  for (let r = 1; r <= rings && cols.length < n; r++)
    for (let k = 0; k < perRing && cols.length < n; k++) {
      const a = (k / perRing) * 2 * Math.PI, d = (STORM.SEARCH_R * r) / rings;
      const x = Math.floor(origin[0] + Math.cos(a) * d), z = flat ? Math.floor(origin[2]) : Math.floor(origin[2] + Math.sin(a) * d);
      if (x >= 0 && z >= 0 && x < size[0] && z < size[2]) cols.push([x, z]);
    }
  return cols;
}

// Pick the strike point among the columns scanned: { x, z, top, id } with top
// the highest matter cell's y below the cloud (-1: the floor) and id what it
// holds. Nearest the leader (origin) wins, conductors counting nearer.
// Returns { to, id } (to: the point the bolt lands on, cells) or null.
export function pickStrike(origin, hits) {
  let best = null, bestScore = Infinity;
  for (const h of hits) {
    const to = [h.x + 0.5, h.top + 1, h.z + 0.5];
    const score = len(sub(to, origin)) - (prefersStrike(h.id) ? STORM.CONDUCTOR_BONUS : 0);
    if (score < bestScore) { bestScore = score; best = { to, id: h.id, cell: [h.x, h.top, h.z] }; }
  }
  return best;
}

// The GLSL defines the bolt pass and the storm passes read.
export const boltGLSL = () => [
  `#define BOLT_MAX_SEGS ${BOLT.MAX_SEGS}`,
  `#define BOLT_P ${BOLT.P.toFixed(1)}`,
  `#define BOLT_E ${BOLT.E.toFixed(1)}`,
  `#define STRIKE_E ${BOLT.STRIKE_E.toFixed(1)}`,
  `#define STRIKE_CORE ${BOLT.STRIKE_CORE}`,
  `#define STRIKE_P ${BOLT.STRIKE_P.toFixed(1)}`,
  `#define STRIKE_P_REACH ${BOLT.STRIKE_P_REACH.toFixed(1)}`,
  `#define BOLT_RNG_SALT ${BOLT.RNG_SALT}u`,
  `#define STORM_CANDIDATES ${STORM.CANDIDATES}`,
].join('\n');
