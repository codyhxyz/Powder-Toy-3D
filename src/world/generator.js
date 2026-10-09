// Procedural world generator (docs/scaling.md D11, "Generator"): the CPU half.
//
// The terrain is a pure function of world position and a world seed, so any
// region generates seamlessly next to any other. The GPU evaluates it per cell
// (shaders/generate.js); this module holds its parameters, a JS twin of the
// height function (heightAt: close enough to place things on land) and the
// tree placement, which is deterministic per brick column.
//
// The look, top down:
//   - a heightfield: fBm gradient noise, domain warped, under a radial island
//     mask whose coastline is itself noisy, so there is land in the middle and
//     sea toward the edges;
//   - ROCK below the surface (it never moves);
//   - SAND on beaches around sea level, WATER filling everything below it;
//   - PLANT ground cover on gentle mid slopes, SNOW on gentle high ground.
//
// Stability. A loaded world must not churn.
//   - Powders (sand, snow) topple into a lower diagonal cell when the cell
//     beside it is open (move.js), so they lie only on columns no more than
//     POWDER_STEP_MAX cells above any of their 8 neighbours: the cellular
//     automaton's angle of repose.
//   - They lie at least two cells deep, so the grains resting on rock (the
//     only ones the move pass's landing scatter nudges sideways) are walled in
//     by the neighbouring ground.
//   - Plants grow into water they touch (react.js), so ground cover starts
//     above sea level.
//   - The sea fills every column below sea level up to it, so it is flat and
//     walled in by land or the box.
//   - Snow lies on rock frozen to its own temperature (FROST_DEPTH, FROST_SPAN),
//     so the ground doesn't melt it from below. The 20 °C air still will,
//     slowly: the box has no cold upper air.

// ---------------------------------------------------------------- constants
// Shared by the GLSL generator (as #defines, see genGLSL) and the JS twin
// below: keep the two algorithms in step. Noise frequencies are per feature
// length (the world's FEATURE_CELLS, see worldParams).
export const GEN = {
  // gradient noise and fBm
  NOISE_NORM: 1.4142,        // 2D gradient noise peaks near ±1/√2: this scales it to about ±1
  OCT_ROT_C: 0.8,            // each octave is turned by this rotation (cos, sin: a 3-4-5 triangle),
  OCT_ROT_S: 0.6,            // so the lattices of successive octaves never line up
  LACUNARITY: 2.0,           // frequency step per octave
  GAIN: 0.5,                 // amplitude step per octave

  // domain warp: the hills are looked up at a point displaced by two fBm fields
  WARP_FREQ: 0.6,
  WARP_AMP: 0.55,            // displacement, feature lengths

  // island mask: 1 - r², r = distance from the centre in island radii, plus coast noise
  COAST_FREQ: 1.6,
  COAST_AMP: 0.3,            // radius wobble, island radii

  // hills: fBm whose octaves are damped where the terrain is already steep
  // (Quilez's gradient-damped fBm), so valleys come out smooth and crests sharp
  HILL_AMP: 0.5,             // hill relief added to the mask, mask units
  HILL_EROSION: 0.6,         // damping per unit of squared accumulated slope (noise units)
  RIDGE_FREQ: 1.3,           // mountain crests: ridged fBm
  RIDGE_AMP: 0.4,            // share of the relief that is crests (the rest is the hills' profile)
  RIDGE_EXP: 1.5,            // crests grow as (land / span)^this: on high ground only
  LAND_SPAN: 0.95,           // land units (mask + hills) from the shore to the highest ground
  SHORE_EXP: 1.7,            // land height grows as (land / span)^this: gentle beaches...
  CLIFF_EXP: 0.75,           // ...or, where the cliff noise says so, steep rocky shores
  CLIFF_FREQ: 1.4,           // cliff noise
  CLIFF_EDGE_LO: 0.25,       // cliff noise (-1..1) range over which beaches turn into cliffs
  CLIFF_EDGE_HI: 0.6,
  CLIFF_SEA: 1.5,            // off cliffs the sea floor falls this much faster
  SEA_SLOPE: 0.7,            // sea floor depth per land unit below 0, shares of the relief
  DETAIL_FREQ: 6.0,          // surface roughness
  DETAIL_AMP: 0.3,           // its relief on high ground, cells (it fades out toward the shore)

  // bands: cells relative to sea level, or shares of the relief above it
  BEACH_BELOW: 4,            // sand reaches this many cells below sea level...
  BEACH_ABOVE: 3,            // ...and this many above it (plus jitter)
  BEACH_JITTER: 2.5,         // band edge noise, cells
  BEACH_SLOPE_MAX: 0.6,      // sand only where the terrain is gentler than this (cells per cell)
  PLANT_ABOVE: 1,            // ground cover starts this many cells above sea level (so it never touches the sea)
  PLANT_SLOPE_MAX: 1.3,      // ...on terrain gentler than this (cells per cell)
  PLANT_PATCH_FREQ: 2.6,     // meadow patchiness
  PLANT_PATCH_CUT: -0.5,     // ground cover where the patch noise (-1..1) is above this
  PLANT_JITTER: 3,           // the ground cover's upper edge comes down by up to this many cells (band noise)
  PLANT_SNOW_GAP: 2,         // ...and stays this many cells below the lowest snow, so it never touches snow
  SNOW_LINE: 0.72,           // snow from here up, share of the relief above sea level...
  SNOW_JITTER: 2,            // ...give or take this many cells (band noise)
  SNOW_SLOPE_MAX: 0.9,       // snow only on terrain gentler than this (cells per cell)
  FROST_DEPTH: 6,            // rock is frozen to the snow's temperature from this many cells below the lowest snow up...
  FROST_SPAN: 8,             // ...and warms to ambient over this many cells below that
  BAND_FREQ: 3.3,            // band edge noise
};

// Integer constants (octave counts, layer depths in cells).
export const GEN_INT = {
  WARP_OCT: 3,
  COAST_OCT: 3,
  HILL_OCT: 4,                // each fBm octave adds as much slope as the first: few octaves keep slopes walkable
  RIDGE_OCT: 3,
  DETAIL_OCT: 2,
  BAND_OCT: 2,
  PATCH_OCT: 3,
  CLIFF_OCT: 2,
  SAND_DEPTH: 3,             // sand layer, cells (at least 2: see Stability)
  SNOW_DEPTH: 2,             // snow layer, cells (at least 2: see Stability)
  POWDER_STEP_MAX: 1,        // a powder column may stand this many cells above each neighbour
};

// Hash salts: each noise field gets its own random stream (and each octave
// its own, by adding the octave's index).
export const GEN_SALT = {
  WARP_X: 0x10, WARP_Z: 0x20, COAST: 0x30, HILLS: 0x40, RIDGE: 0x50,
  DETAIL: 0x60, PATCH: 0x70, BAND: 0x80, CLIFF: 0xa0,
  SHAPE: 0xb0,               // the island's long axis (worldParams)
  CELL: 0x90,                // per-cell colour seeds
};

const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const genGLSL = () => [
  ...Object.entries(GEN).map(([k, v]) => `#define GEN_${k} ${v < 0 ? `(${glslFloat(v)})` : glslFloat(v)}`),
  ...Object.entries(GEN_INT).map(([k, v]) => `#define GEN_${k} ${v}`),
  ...Object.entries(GEN_SALT).map(([k, v]) => `#define GEN_SALT_${k} ${v}u`),
].join('\n');

// ---------------------------------------------------------------- world parameters
// A world: its seed and size, and its levels and shape in cells. Heights are
// shares of the world's height, so the same island fits every grid size.
export const WORLD_SEED = 20261008;   // the default world
const SEA_SHARE = 0.14;               // sea level, share of the world's height
const RELIEF_PER_RADIUS = 0.6;       // the highest ground above sea level, cells per cell of island radius
const PEAK_SHARE_MAX = 0.62;          // ...but no higher than this share of the world's height
const FLOOR_CELLS = 2;                // rock under even the deepest sea, cells
const ISLAND_SHARE = 0.76;            // island diameter (if it were round), share of the world's shorter side
const FEATURE_SHARE = 0.38;           // the largest hills' wavelength, share of the world's shorter side
const STRETCH_MAX = 1.18;             // the island is longer than wide by up to this squared (seeded)

// size: the world in cells [x, y, z]
export function worldParams({ size, seed = WORLD_SEED } = {}) {
  const [wx, wy, wz] = size;
  const side = Math.min(wx, wz);
  const sea = Math.round(SEA_SHARE * wy);
  const radius = (ISLAND_SHARE * side) / 2;
  const relief = Math.min(RELIEF_PER_RADIUS * radius, PEAK_SHARE_MAX * wy - sea);
  // the island's long axis and how much longer than wide it is, from the seed
  const shape = pcg((seed + GEN_SALT.SHAPE) >>> 0);
  const angle = ((shape & 0xffff) / 0x10000) * TAU;
  return {
    seed: seed >>> 0,
    size: [wx, wy, wz],
    sea,                              // cells below this height (y < sea) are sea where not ground
    relief,                           // cells from sea level to the highest ground
    floor: FLOOR_CELLS,
    center: [wx / 2, wz / 2],         // island centre (world cells, x and z)
    radius,
    axis: [Math.cos(angle), Math.sin(angle)],   // the island's long axis (unit, x and z)
    stretch: 1 + (STRETCH_MAX - 1) * ((shape >>> 16) / 0x10000),   // long / wide = stretch²
    feature: FEATURE_SHARE * side,    // cells per feature length (noise frequency unit)
  };
}

// ---------------------------------------------------------------- noise (JS twin of shaders/generate.js)
const UINT_RANGE = 4294967296;        // 2^32
const TAU = Math.PI * 2;

// PCG hash, as common.js's pcg (uint32 arithmetic)
export function pcg(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
// a noise field's stream: the world seed and the field's salt
const stream = (seed, salt) => pcg((seed + salt) >>> 0);
const latticeHash = (ix, iz, s) => pcg(((ix >>> 0) + pcg(((iz >>> 0) + s) >>> 0)) >>> 0);

// Gradient noise with its derivatives: [value, d/dx, d/dz], value about ±1.
function noised(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const g = (cx, cz) => { const a = (latticeHash(ix + cx, iz + cz, s) / UINT_RANGE) * TAU; return [Math.cos(a), Math.sin(a)]; };
  const ga = g(0, 0), gb = g(1, 0), gc = g(0, 1), gd = g(1, 1);
  const va = ga[0] * fx + ga[1] * fz;
  const vb = gb[0] * (fx - 1) + gb[1] * fz;
  const vc = gc[0] * fx + gc[1] * (fz - 1);
  const vd = gd[0] * (fx - 1) + gd[1] * (fz - 1);
  const k = va - vb - vc + vd;
  const v = va + ux * (vb - va) + uz * (vc - va) + ux * uz * k;
  const dx = ga[0] + ux * (gb[0] - ga[0]) + uz * (gc[0] - ga[0]) + ux * uz * (ga[0] - gb[0] - gc[0] + gd[0])
    + dux * (uz * k + vb - va);
  const dz = ga[1] + ux * (gb[1] - ga[1]) + uz * (gc[1] - ga[1]) + ux * uz * (ga[1] - gb[1] - gc[1] + gd[1])
    + duz * (ux * k + vc - va);
  return [v * GEN.NOISE_NORM, dx * GEN.NOISE_NORM, dz * GEN.NOISE_NORM];
}

// the next octave's point: turned and scaled
const nextOctave = (p) => {
  const x = GEN.OCT_ROT_C * p[0] - GEN.OCT_ROT_S * p[1], z = GEN.OCT_ROT_S * p[0] + GEN.OCT_ROT_C * p[1];
  p[0] = x * GEN.LACUNARITY; p[1] = z * GEN.LACUNARITY;
};

// fBm, normalised to about ±1
function fbm(x, z, s, oct) {
  const p = [x, z];
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noised(p[0], p[1], (s + i) >>> 0)[0];
    norm += amp; amp *= GEN.GAIN;
    nextOctave(p);
  }
  return sum / norm;
}

// gradient-damped fBm: an octave counts less where the octaves before it are steep
function erodedFbm(x, z, s, oct) {
  const p = [x, z];
  let sum = 0, amp = 1, norm = 0, dx = 0, dz = 0;
  for (let i = 0; i < oct; i++) {
    const n = noised(p[0], p[1], (s + i) >>> 0);
    dx += n[1]; dz += n[2];
    sum += (amp * n[0]) / (1 + GEN.HILL_EROSION * (dx * dx + dz * dz));
    norm += amp; amp *= GEN.GAIN;
    nextOctave(p);
  }
  return sum / norm;
}

// ridged fBm in [0, 1]: sharp crests where the noise crosses zero
function ridgedFbm(x, z, s, oct) {
  const p = [x, z];
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const r = 1 - Math.abs(noised(p[0], p[1], (s + i) >>> 0)[0]);
    sum += amp * r * r;
    norm += amp; amp *= GEN.GAIN;
    nextOctave(p);
  }
  return sum / norm;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- height
// The terrain's height at world column (x, z), in cells: the column is ground
// below it. Continuous; the GPU twin is genHeight in shaders/generate.js.
export function heightAt(x, z, P) {
  const S = GEN_SALT, I = GEN_INT;
  const px = x + 0.5, pz = z + 0.5;   // the column's centre
  const qx = px / P.feature, qz = pz / P.feature;
  // domain warp: everything below is looked up at a displaced point
  const wx = qx + GEN.WARP_AMP * fbm(qx * GEN.WARP_FREQ, qz * GEN.WARP_FREQ, stream(P.seed, S.WARP_X), I.WARP_OCT);
  const wz = qz + GEN.WARP_AMP * fbm(qx * GEN.WARP_FREQ, qz * GEN.WARP_FREQ, stream(P.seed, S.WARP_Z), I.WARP_OCT);
  // island mask: distance from the centre in island radii, along the island's
  // (seeded) long axis and across it, plus coast noise
  const dx = wx * P.feature - P.center[0], dz = wz * P.feature - P.center[1];
  const along = (dx * P.axis[0] + dz * P.axis[1]) / P.stretch, across = (dz * P.axis[0] - dx * P.axis[1]) * P.stretch;
  const r = Math.hypot(along, across) / P.radius
    + GEN.COAST_AMP * fbm(wx * GEN.COAST_FREQ, wz * GEN.COAST_FREQ, stream(P.seed, S.COAST), I.COAST_OCT);
  const land = 1 - r * r + GEN.HILL_AMP * erodedFbm(wx, wz, stream(P.seed, S.HILLS), I.HILL_OCT);
  // cliffs: where this noise is high the shore rises (and the sea floor falls) steeply
  const cliff = smoothstep(GEN.CLIFF_EDGE_LO, GEN.CLIFF_EDGE_HI,
    fbm(wx * GEN.CLIFF_FREQ, wz * GEN.CLIFF_FREQ, stream(P.seed, S.CLIFF), I.CLIFF_OCT));
  if (land <= 0) {
    const depth = -land * GEN.SEA_SLOPE * (1 + GEN.CLIFF_SEA * cliff) * P.relief;
    return Math.max(P.floor, P.sea - depth);
  }
  const t = Math.min(land / GEN.LAND_SPAN, 1);
  const shore = Math.pow(t, GEN.SHORE_EXP + (GEN.CLIFF_EXP - GEN.SHORE_EXP) * cliff);
  const ridge = ridgedFbm(wx * GEN.RIDGE_FREQ, wz * GEN.RIDGE_FREQ, stream(P.seed, S.RIDGE), I.RIDGE_OCT);
  const detail = fbm(wx * GEN.DETAIL_FREQ, wz * GEN.DETAIL_FREQ, stream(P.seed, S.DETAIL), I.DETAIL_OCT);
  const h = (1 - GEN.RIDGE_AMP) * shore + GEN.RIDGE_AMP * ridge * Math.pow(t, GEN.RIDGE_EXP);
  return P.sea + h * P.relief + GEN.DETAIL_AMP * detail * t;
}

// ---------------------------------------------------------------- layers
// What world column (x, z) holds (twin of genColumn + genLayers): ground =
// the number of ground cells (y < ground), the depths of its sand and snow
// layers (0: none), whether its top cell is plant cover, and its slope.
export function layersAt(x, z, P) {
  const I = GEN_INT;
  const h = [];
  for (let i = 0; i < 9; i++) h.push(heightAt(x + (i % 3) - 1, z + Math.floor(i / 3) - 1, P));
  const qx = (x + 0.5) / P.feature, qz = (z + 0.5) / P.feature;
  const band = fbm(qx * GEN.BAND_FREQ, qz * GEN.BAND_FREQ, stream(P.seed, GEN_SALT.BAND), I.BAND_OCT);
  const meadow = fbm(qx * GEN.PLANT_PATCH_FREQ, qz * GEN.PLANT_PATCH_FREQ, stream(P.seed, GEN_SALT.PATCH), I.PATCH_OCT);
  const G = h.map((v) => Math.floor(v + 0.5)), ground = G[4];
  const stable = Math.max(...G.map((n) => ground - n)) <= I.POWDER_STEP_MAX;
  // a grain in the water with water on both sides along an axis gets knocked off by the flow
  const ridge = ground <= P.sea && ((G[3] < ground && G[5] < ground) || (G[1] < ground && G[7] < ground));
  const slope = 0.5 * Math.hypot(h[5] - h[3], h[7] - h[1]);
  const sea = P.sea, frost = frostLine(P);
  const beach = ground >= sea - GEN.BEACH_BELOW && ground <= sea + GEN.BEACH_ABOVE + GEN.BEACH_JITTER * band
    && slope < GEN.BEACH_SLOPE_MAX && !ridge;
  const snowy = ground >= frost + GEN.SNOW_JITTER * (1 + band) && slope < GEN.SNOW_SLOPE_MAX;
  const L = { ground, sand: 0, snow: 0, plant: false, slope };
  if (stable && beach) L.sand = I.SAND_DEPTH;
  else if (stable && snowy) L.snow = I.SNOW_DEPTH;
  else L.plant = ground >= sea + GEN.PLANT_ABOVE && ground <= plantLine(P, band)
    && slope < GEN.PLANT_SLOPE_MAX && meadow > GEN.PLANT_PATCH_CUT;
  return L;
}

// The lowest snow (the snow line less its jitter): rock is frozen from here up.
export const frostLine = (P) => P.sea + GEN.SNOW_LINE * P.relief - GEN.SNOW_JITTER;
// The highest ground cover on a column with band noise `band`: just below the lowest snow.
export const plantLine = (P, band) => frostLine(P) - GEN.PLANT_SNOW_GAP - GEN.PLANT_JITTER * (1 + band) / 2;

// ---------------------------------------------------------------- trees
// Trees are the TREE constructions (constructions/builtins.js), stamped by
// world/island.js. Each brick column (BRICK × BRICK cells) may hold one
// candidate, hashed from its brick coordinates and the world seed: whether
// it has one, where in the column, which kind, how big, which way it faces
// and its construction seed. A candidate on unsuitable ground is dropped, and
// one with a higher-priority candidate within TREE_SPACING is too (Matérn
// thinning), so placement depends only on nearby brick columns: any region
// places the same trees as any other.
export const TREE = {
  BRICK: 4,                  // cells per brick column side (shaders/common.js BRICK)
  CHANCE: 0.5,               // chance a brick column has a candidate
  SPACING: 8,                // cells: no two trees stand closer
  ABOVE_SEA: 2,              // trunks stand at least this many cells above sea level
  SLOPE_MAX: 0.8,            // ...on ground gentler than this (cells per cell; the stamp grows a footing)
  SIZE_MIN: 3,               // construction size (runtime.js scaleFor: 3..5 is 0.78..1 of the default tree)
  SIZE_MAX: 5,
  PALM_BELOW: 4,             // palms grow on beaches, up to this many cells above sea level
  PINE_ABOVE: 0.3,           // pines from this share of the relief above sea level
  SNOW_GAP: 5,               // cells: trees stand at least this far below the lowest snow, so their crowns don't reach it
  REACH: 16,                 // cells: the widest crown's reach from its trunk (a region stamps trees this far outside it)
};
const TREE_SALT = 0xc0;
// Kinds by zone: cumulative weights for the mid slopes (the rest is dead trees).
const MID_TREES = [['oak', 0.5], ['birch', 0.75], ['pine', 0.95]];
const HIGH_TREES = [['pine', 0.85], ['birch', 0.97]];   // the rest dead
const UNIT16 = 0x10000;                                  // 16-bit hash field to [0, 1)

function treeCandidate(bx, bz, P) {
  const h = latticeHash(bx, bz, stream(P.seed, TREE_SALT));
  if ((h & 0xffff) / UNIT16 >= TREE.CHANCE) return null;
  const h2 = pcg(h), h3 = pcg(h2);
  const x = bx * TREE.BRICK + (h2 & (TREE.BRICK - 1)), z = bz * TREE.BRICK + ((h2 >>> 2) & (TREE.BRICK - 1));
  const L = layersAt(x, z, P);
  const above = L.ground - P.sea;
  if (above < TREE.ABOVE_SEA || L.slope >= TREE.SLOPE_MAX || !(L.plant || L.sand)) return null;
  if (L.ground > frostLine(P) - TREE.SNOW_GAP) return null;
  const coast = L.sand && above <= TREE.PALM_BELOW;
  if (L.sand && !coast) return null;
  const pick = (h3 & 0xffff) / UNIT16;
  const zone = coast ? [['palm', 1]] : above >= TREE.PINE_ABOVE * P.relief ? HIGH_TREES : MID_TREES;
  const variant = zone.find(([, w]) => pick < w)?.[0] ?? 'dead';
  return {
    x, y: L.ground, z, variant,
    size: TREE.SIZE_MIN + ((h3 >>> 16) % (TREE.SIZE_MAX - TREE.SIZE_MIN + 1)),
    quarter: (h3 >>> 20) & 3,          // which way its front faces (runtime.js bake)
    seed: pcg(h3),                     // its construction seed
    priority: h2 >>> 8,
  };
}

// The trees whose trunks stand in world columns [x0, x1) × [z0, z1).
export function treesIn(x0, z0, x1, z1, P) {
  const B = TREE.BRICK, R = Math.ceil(TREE.SPACING / B);
  const bx0 = Math.floor(x0 / B), bz0 = Math.floor(z0 / B), bx1 = Math.ceil(x1 / B), bz1 = Math.ceil(z1 / B);
  const cache = new Map();
  const candidate = (bx, bz) => {
    const k = `${bx},${bz}`;
    if (!cache.has(k)) cache.set(k, treeCandidate(bx, bz, P));
    return cache.get(k);
  };
  const out = [];
  for (let bz = bz0; bz < bz1; bz++)
    for (let bx = bx0; bx < bx1; bx++) {
      const c = candidate(bx, bz);
      if (!c || c.x < x0 || c.x >= x1 || c.z < z0 || c.z >= z1) continue;
      let wins = true;
      for (let dz = -R; dz <= R && wins; dz++)
        for (let dx = -R; dx <= R && wins; dx++) {
          if (!dx && !dz) continue;
          const o = candidate(bx + dx, bz + dz);
          if (!o || Math.hypot(o.x - c.x, o.z - c.z) >= TREE.SPACING) continue;
          // the higher priority stays (ties: the lower brick index)
          if (o.priority > c.priority || (o.priority === c.priority && (dz < 0 || (dz === 0 && dx < 0)))) wins = false;
        }
      if (wins) out.push(c);
    }
  return out;
}
