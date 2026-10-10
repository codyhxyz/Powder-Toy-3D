import * as THREE from 'three';
import { BRICK } from '../shaders/common.js';
import { E, ELEMENTS, K } from '../elements.js';
import { runGenerator, bake, turnPoint, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS, SHRINE_ALTARS } from '../constructions/builtins.js';
import { islandTwin, layersAt, pcg, TREE } from './generator.js';
import { LANDFORMS } from './island/landforms.js';
import { bakeFor, structureWorker } from './bake.js';

// The world's structures (docs/structures.md): houses, villages, docks, wrecks,
// towers, standing stones and mines, placed by a scene from its seed as it
// places its trees, and generated as part of its cells.
//
// Placement is a pure function of the world P, computed once per world on the
// CPU (structuresOf; a few ms): a candidate site per kind in each SITE × SITE
// square of the world, at the first of SITE_TRIES hashed points whose ground
// suits the kind (its site rule), then thinned across the whole world: kinds
// in RANK order, best site first, each kept while it stands far enough from
// those kept before it and its kind has room under its cap. Any window and the
// far field read the same list.
//
// Each placed structure is its construction (constructions/builtins.js,
// structures.js) baked at its size, quarter and seed, its base on the highest
// ground under it (footings fill the rest) or, for the dock, the mine and the
// campfire, on the ground at its origin. The scene draws them in its sceneCell
// (STRUCT_GLSL structureCell): one texel of a brick-column index finds the
// structure over a column, a cell atlas holds every structure's cells, and a
// footing grows from the base down to the ground exactly as the stamp pass's
// does (shaders/stamp.js). So the window's fill, its diff (a structure is not
// an edit), the far field and every window move see them alike, seamlessly.
//
// Trees give way: a tree candidate whose trunk stands within TREE.REACH of a
// structure's box is dropped before thinning (generator.js treeCandidate, the
// far field's sceneTreeCandidate: the index's clearing channel), so no crown
// reaches into one.
//
// Stability: only constructions that are still as generated are placed (no lit
// fire, CLONE, ice, or plants by water; constructions/structures.js), and site
// rules keep them off water.

export const SITE = 64;               // cells: the side of a site square (one candidate per kind each)
const SITE_TRIES = 6;                 // hashed points tried per square and kind
const SAMPLE = BRICK;                 // cells between ground samples under a footprint (and its far edges)
const GAP = 8;                        // cells between any two structures' boxes (two bricks: the index holds one a column)
const TOP_MARGIN = 4;                 // cells a structure's top stays under the world's
const SIZE = 5;                       // construction size: T = 1, the human scale (constructions/shared.js)
const SALT = 0x5c;                    // the layer's hash stream (generator.js GEN_SALT has the others)
const UNIT32 = 4294967296;
const MAX_SLOTS = 255;                // structures a world holds (the index's 8-bit slot)
const SEEDS = 8;                      // construction seeds a kind draws from: variety enough, and the bakes are kept
const ATLAS_W = 2048;                 // the cell atlas' widest row, cells (a 3D texture's guaranteed size)

// Site rules' numbers, cells unless noted (shares of the relief are of P.relief).
export const STRUCT = {
  HOUSE_RISE: 3,        // ground rise under a building (its plinth)
  TOWER_RISE: 4,
  RUIN_RISE: 6,
  ABOVE_SEA: 4,         // buildings stand this far above the sea at least
  CABIN_ABOVE: 0.3,     // cabins from this share of the relief up (the pines'), cottages below
  BRICK_SHARE: 0.35,    // share of a village's houses that are brick
  HILL_RING: 24,        // a hilltop is no lower than any of RING_N samples this far out, less HILL_SLACK
  RING_N: 12,
  HILL_SLACK: 1,
  RUIN_ABOVE: 0.5,      // ruins on bare rock this share of the relief up at least
  HEAD_RING: 36,        // a headland has sea on HEAD_SEA of RING_N2 samples this far out (today's gentle
  HEAD_SEA: 0.2,        // coasts reach ~0.3 at most: the most seaward high ground wins, scored by its share)
  RING_N2: 16,
  LIGHT_ABOVE: [4, 40], // a lighthouse stands this far above the sea
  SHORE_AT: [1, 2],     // a dock's root: this far above the sea
  DOCK_LEN: 30,         // its length (constructions/structures.js DOCK.LEN at T = 1)...
  DOCK_DEPTH: [3, 28],  // ...and the water's depth at its head (its stilts reach the sea floor)
  WRECK_AT: [-1, 2],    // a wreck's origin: this far above the sea
  WRECK_RISE: 4,
  MINE_SLOPE: [0.45, 2.6], // a mine's slope at its portal, cells per cell (the island's steepest are ~0.8)...
  MINE_LEN: 24,         // ...its gallery's length (MINE.LEN)...
  MINE_COVER: 9,        // ...under at least this much ground (the gallery is 8 tall), from...
  MINE_FROM: 16,        // ...this far in (the gallery's mouth is a cutting)
  MINE_SPUR: 9,         // its spur runs this far out, over ground no higher than its floor
  SLOPE_RUN: 4,         // cells either side a downhill direction is measured over
  VILLAGE_R: [20, 28],  // a village's houses stand on a ring this far from its well...
  VILLAGE_HOUSES: [3, 6],
  VILLAGE_RISE: 8,      // ...on ground with at most this rise within VILLAGE_R[1] + GAP of it
  VILLAGE_MIN: 2,       // a village needs this many houses that fit
  CAMP_OFF: 10,         // a campfire this far off a watchtower's or a village's middle
  // a cliff headland, derived from the twin until the landforms mark them (headland):
  HEAD_ABOVE: 8,        // its ground this far above the sea at least...
  CLIFF_RUN: 16,        // ...with the sea within this many cells along one of CLIFF_DIRS directions
  CLIFF_DIRS: 16,
  CLIFF_STEP: 2,
  HEAD_MIN: 0.15,       // ...and on this share of a HEAD_RING ring at least; a headland outranks any fallback site
  HEAD_BONUS: 1,        // (by this much in score)
  LIGHT_RISE: 12,       // ground rise a lighthouse's box may stand over (a cliff top: its footing builds a plinth on the seaward side)
  LATTICE: 8,           // cells between the points a lattice scan tries (headlands)
  MOUTH_LATTICE: 8,     // ...and cave mouths (most are wider than this: a finer scan costs ~1 s a world)
  // a hermit's cabin by a tarn: on a ring round it, out of islandLakeClearance
  HERMIT_GAP: 3,        // cells between the lake's clearance and the cabin's box
  HERMIT_ANGLES: 16,    // places tried round each tarn
  // a bridge over the ria's dry gorge, at its narrowest axis-aligned crossing
  GORGE_FROM: 12,       // cells past the drowned part, and short of the head, where crossings are tried...
  GORGE_STEP: 4,        // ...this often
  GORGE_DEPTH: 8,       // the gorge is at least this deep below its lower rim there
  GORGE_SPAN: [10, 56], // the crossing's span between rims
  RIM_DIFF: 6,          // ...whose heights differ by at most this (the lower abutment's footing makes it up)
  RIM_FLAT: 1,          // a rim: where the ground rises no more than this over RIM_RUN cells further out
  RIM_RUN: 3,
  DOOR_OUT: 2,          // a door opens onto ground this far out from its wall at the slab's level or a cell above
                        // (the body steps up one cell: a taller plinth there would shut it out)
  // the world's shrine (constructions/builtins.js shrine; the app sets its orbs: shrineAltars):
  // flat dry ground near P.structures.start, the middle of the window the world starts in
  SHRINE_SEARCH: 40,    // cells from there it looks within...
  SHRINE_STEP: 4,       // ...on a lattice this fine
  SHRINE_RISE: 3,       // ground rise under its floor
  SHRINE_DRY: 2,        // its lowest ground this far above the sea
  SHRINE_FAR_COST: 0.05,// a spot's score: its rise, plus this per cell from the start (lowest wins)
};

// The kinds, in RANK order (the thinning keeps rarer, grander ones first).
// cap: how many a world holds; spacing: cells between two of the kind; tries:
// points tried a square (SITE_TRIES unless said); sites(T, P): the points to
// try instead of the squares' (a lattice scan for rare ground, a landform's
// own places), or null for the squares'.
const KINDS = [
  { kind: 'shrine', cap: 1, spacing: 0, sites: (T, P) => shrineSites(P) },   // the world's perk shrine, near where it starts
  { kind: 'lighthouse', cap: 1, spacing: 400, sites: (T, P) => lattice(P, STRUCT.LATTICE, (x, z) => T.genTop(x, z) >= P.sea + STRUCT.LIGHT_ABOVE[0]) },
  { kind: 'bridge', cap: 1, spacing: 400, sites: (T, P) => gorgeCrossings(T, P) },
  { kind: 'stones', cap: 1, spacing: 400 },
  { kind: 'village', cap: 2, spacing: 300 },
  { kind: 'ruin', cap: 2, spacing: 200 },
  { kind: 'watch', cap: 3, spacing: 160 },
  { kind: 'hermit', cap: 2, spacing: 100, sites: (T, P) => tarnSites(P) },
  { kind: 'mine', cap: 3, spacing: 160,   // at the caves' mouths when they say where (caveMouth), else square tries
    sites: (T, P) => (T.islandCaveMouth ? lattice(P, STRUCT.MOUTH_LATTICE, (x, z) => T.islandCaveMouth(x, z) > 0) : null) },
  { kind: 'dock', cap: 3, spacing: 200 },
  { kind: 'wreck', cap: 2, spacing: 200 },
  { kind: 'house', cap: 6, spacing: 96 },
];

// ---------------------------------------------------------------- geometry
// quarter q turns a construction's front (+z) to face FRONT[q] (runtime.js turnCells)
const FRONT = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const quarterFacing = (dx, dz) => (Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 0 : 2));

const seedOf = (h) => 1 + (pcg(h) % SEEDS);
const baked = new Map();   // key|variant|quarter|seed → baked construction (runtime.js bake)
function bakeOf(key, variant, quarter, seed) {
  const k = `${key}|${variant}|${quarter}|${seed}`;
  if (!baked.has(k)) baked.set(k, bake(runGenerator(BUILTINS[key], { size: SIZE, seed, variant }), quarter));
  return baked.get(k);
}

// A site for construction key:variant turned by quarter with its origin on
// world column (x, z): its box's low corner, and the lowest and highest ground
// under it. base: 'max' (on the highest ground), 'origin' or 'min'.
function site(T, key, variant, quarter, seed, x, z, base = 'max') {
  const s = bakeOf(key, variant, quarter, seed);
  const x0 = x - s.base.x, z0 = z - s.base.z;
  let lo = Infinity, hi = -Infinity, wet = false;
  for (let k = 0; k <= s.d; k += SAMPLE)
    for (let i = 0; i <= s.w; i += SAMPLE) {
      const cx = x0 + Math.min(i, s.w - 1), cz = z0 + Math.min(k, s.d - 1), g = T.genTop(cx, cz);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
      if (T.column(cx, cz)[3] > g) wet = true;
    }
  const y = base === 'max' ? hi : base === 'min' ? lo : T.genTop(x, z);
  return { key, variant, quarter, seed, s, x, y, z, x0, z0, lo, hi, wet, rise: hi - lo };
}

// the downhill direction at (x, z), as a unit [dx, dz]
function downhill(T, x, z) {
  const r = STRUCT.SLOPE_RUN;
  const gx = T.genColumnHeight(x + r, z) - T.genColumnHeight(x - r, z), gz = T.genColumnHeight(x, z + r) - T.genColumnHeight(x, z - r);
  const l = Math.hypot(gx, gz) || 1;
  return [-gx / l, -gz / l];
}

// ground at ring samples of radius r round (x, z)
const ring = (T, x, z, r, n) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return T.genTop(Math.round(x + Math.cos(a) * r), Math.round(z + Math.sin(a) * r));
});

// ---------------------------------------------------------------- site rules
// Each takes the twin, the world, a point and a hash; returns the structures
// the site makes (a village makes several) with a score, or null.
const fits = (P, st, rise) => !st.wet && st.rise <= rise && st.y + st.s.h + TOP_MARGIN < P.size[1] && st.lo >= P.sea + STRUCT.ABOVE_SEA;

const RULES = {
  house(T, P, x, z, h) {
    if (T.genTop(x, z) < P.sea + STRUCT.ABOVE_SEA) return null;
    const L = layersAt(x, z, P);
    if (!L.plant) return null;
    const [dx, dz] = downhill(T, x, z);
    const variant = L.ground >= P.sea + STRUCT.CABIN_ABOVE * P.relief ? 'cabin' : 'cottage';
    const st = doorSite(T, P, variant, seedOf(h), x, z, quarterFacing(-dx, -dz));   // the door faces uphill if it can
    return st ? { score: -st.rise, parts: [st] } : null;
  },

  village(T, P, x, z, h) {
    if (T.genTop(x, z) < P.sea + STRUCT.ABOVE_SEA) return null;
    const L = layersAt(x, z, P);
    if (!L.plant) return null;
    const well = site(T, 'WELL', undefined, 0, seedOf(h), x, z);
    if (!fits(P, well, STRUCT.HOUSE_RISE)) return null;
    const R = STRUCT.VILLAGE_R[1] + GAP, around = ring(T, x, z, R, STRUCT.RING_N);
    if (Math.max(...around, well.hi) - Math.min(...around, well.lo) > STRUCT.VILLAGE_RISE) return null;
    const parts = [well];
    let r = pcg(h ^ 0x9e37);
    const next = () => (r = pcg(r)) / UNIT32;
    const n = STRUCT.VILLAGE_HOUSES[0] + Math.floor(next() * (STRUCT.VILLAGE_HOUSES[1] - STRUCT.VILLAGE_HOUSES[0] + 1));
    const a0 = next() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + (next() - 0.5) * (Math.PI / n);
      const d = STRUCT.VILLAGE_R[0] + next() * (STRUCT.VILLAGE_R[1] - STRUCT.VILLAGE_R[0]);
      const hx = Math.round(x + Math.cos(a) * d), hz = Math.round(z + Math.sin(a) * d);
      const variant = next() < STRUCT.BRICK_SHARE ? 'brick' : L.ground >= P.sea + STRUCT.CABIN_ABOVE * P.relief ? 'cabin' : 'cottage';
      const st = doorSite(T, P, variant, seedOf(r), hx, hz, quarterFacing(x - hx, z - hz));   // the door faces the well if it can
      if (st && !parts.some((o) => overlaps(o, st))) parts.push(st);
    }
    if (parts.length - 1 < STRUCT.VILLAGE_MIN) return null;
    const camp = site(T, 'CAMPFIRE', 'unlit', 0, seedOf(r ^ 1), x + STRUCT.CAMP_OFF, z, 'min');
    if (!camp.wet && !parts.some((o) => overlaps(o, camp))) parts.push(camp);
    return { score: parts.length, parts };
  },

  lighthouse(T, P, x, z, h) {
    const g = T.genTop(x, z);
    if (g < P.sea + STRUCT.LIGHT_ABOVE[0] || g > P.sea + STRUCT.LIGHT_ABOVE[1]) return null;
    // a cliff headland (headland) first; failing any, the most seaward high ground
    const sea = ring(T, x, z, STRUCT.HEAD_RING, STRUCT.RING_N2).filter((v) => v < P.sea).length / STRUCT.RING_N2;
    if (sea < Math.min(STRUCT.HEAD_MIN, STRUCT.HEAD_SEA)) return null;   // inland: no sea round it
    const cliff = headland(T, P, x, z);
    if (!cliff && sea < STRUCT.HEAD_SEA) return null;
    const [dx, dz] = downhill(T, x, z);
    const st = site(T, 'TOWER', 'lighthouse', quarterFacing(-dx, -dz), seedOf(h), x, z);
    // a cliff top is never flat: dry ground under it and a plinth on the seaward side will do
    const ok = !st.wet && st.rise <= STRUCT.LIGHT_RISE && st.lo > P.sea && st.y + st.s.h + TOP_MARGIN < P.size[1];
    return ok ? { score: sea + (cliff ? STRUCT.HEAD_BONUS : 0), parts: [st] } : null;
  },

  watch(T, P, x, z, h) {
    if (T.genTop(x, z) < P.sea + STRUCT.ABOVE_SEA) return null;
    const L = layersAt(x, z, P);
    if (!L.plant) return null;
    const top = Math.max(...ring(T, x, z, STRUCT.HILL_RING, STRUCT.RING_N));
    if (L.ground < top - STRUCT.HILL_SLACK) return null;
    const [dx, dz] = downhill(T, x, z);
    const st = site(T, 'TOWER', 'watch', quarterFacing(-dx, -dz), seedOf(h), x, z);
    if (!fits(P, st, STRUCT.TOWER_RISE)) return null;
    const parts = [st];
    const [fx, fz] = FRONT[st.quarter], camp = site(T, 'CAMPFIRE', 'unlit', 0, seedOf(h ^ 1), x + fx * STRUCT.CAMP_OFF, z + fz * STRUCT.CAMP_OFF, 'min');
    if (!camp.wet && !overlaps(st, camp)) parts.push(camp);
    return { score: L.ground - top, parts };
  },

  ruin(T, P, x, z, h) {
    if (T.genTop(x, z) < P.sea + STRUCT.RUIN_ABOVE * P.relief) return null;
    const L = layersAt(x, z, P);
    if (L.plant || L.sand || L.snow || L.ground < P.sea + STRUCT.RUIN_ABOVE * P.relief) return null;
    const [dx, dz] = downhill(T, x, z);
    const st = site(T, 'TOWER', 'ruin', quarterFacing(-dx, -dz), seedOf(h), x, z);
    return fits(P, st, STRUCT.RUIN_RISE) ? { score: L.ground, parts: [st] } : null;
  },

  stones(T, P, x, z, h) {
    if (T.genTop(x, z) < P.sea + STRUCT.ABOVE_SEA) return null;
    const L = layersAt(x, z, P);
    if (!L.plant) return null;
    const top = Math.max(...ring(T, x, z, STRUCT.HILL_RING, STRUCT.RING_N));
    if (L.ground < top - STRUCT.HILL_SLACK) return null;
    const st = site(T, 'STONES', undefined, 0, seedOf(h), x, z);
    return fits(P, st, STRUCT.TOWER_RISE) ? { score: L.ground - top, parts: [st] } : null;
  },

  // a cabin by a tarn (P.landforms.lakes): its door to the water, its box clear of the lake's clearance
  hermit(T, P, x, z, h) {
    const lake = (P.landforms?.lakes ?? []).reduce((b, l) => (!b || Math.hypot(l.x - x, l.z - z) < Math.hypot(b.x - x, b.z - z) ? l : b), null);
    if (!lake) return null;
    const st = doorSite(T, P, 'cabin', seedOf(h), x, z, quarterFacing(lake.x - x, lake.z - z));   // the door to the water if it can
    if (!st) return null;
    const g = STRUCT.HERMIT_GAP;
    for (let k = -g; k <= st.s.d + g; k += SAMPLE / 2)
      for (let i = -g; i <= st.s.w + g; i += SAMPLE / 2) if (T.islandLakeClearance(st.x0 + i, st.z0 + k)) return null;
    return { score: -Math.hypot(lake.x - x, lake.z - z), parts: [st] };
  },

  // the world's shrine: the flattest dry spot near the start
  shrine(T, P, x, z, h) {
    const st = site(T, 'SHRINE', undefined, 0, 1, x, z);
    if (st.wet || st.rise > STRUCT.SHRINE_RISE || st.lo < P.sea + STRUCT.SHRINE_DRY || st.y + st.s.h + TOP_MARGIN >= P.size[1]) return null;
    const [sx, sz] = P.structures.start;
    return { score: -(st.rise + STRUCT.SHRINE_FAR_COST * Math.hypot(x - sx, z - sz)), parts: [st] };
  },

  // a footbridge over the gorge: the crossing (gorgeCrossings) gives its span, axis and rims
  bridge(T, P, x, z, h, c) {
    if (!c) return null;
    const st = site(T, 'BRIDGE', String(c.span), c.axis ? 0 : 1, seedOf(h), x, z, 'origin');   // spanning x: front (+z) turned to +x
    st.y = c.rim;   // the deck's abutments on the higher rim (the lower one's footing makes up the rest)
    return st.y + st.s.h + TOP_MARGIN < P.size[1] ? { score: -c.span, parts: [st] } : null;
  },

  mine(T, P, x, z, h) {
    // caves hook: a cave mouth (see caveMouth) when the island has them; else a steep, deep slope
    const mouth = caveMouth(T, P, x, z);
    const slope = T.genSlope(x, z);
    if (!mouth && (slope < STRUCT.MINE_SLOPE[0] || slope > STRUCT.MINE_SLOPE[1])) return null;
    const [dx, dz] = mouth?.facing ?? downhill(T, x, z), q = quarterFacing(dx, dz), [fx, fz] = FRONT[q];
    const g = T.genTop(x, z);
    if (g < P.sea + STRUCT.ABOVE_SEA || T.column(x, z)[3] > g) return null;
    for (let t = STRUCT.MINE_FROM; t <= STRUCT.MINE_LEN; t += SAMPLE)   // the gallery is buried...
      if (T.genTop(x - fx * t, z - fz * t) < g + STRUCT.MINE_COVER) return null;
    for (let t = 2; t <= STRUCT.MINE_SPUR; t += SAMPLE)                  // ...and its spur isn't
      if (T.genTop(x + fx * t, z + fz * t) > g) return null;
    const st = site(T, 'MINE', undefined, q, seedOf(h), x, z, 'origin');
    return st.y + st.s.h + TOP_MARGIN < P.size[1] ? { score: slope, parts: [st] } : null;
  },

  dock(T, P, x, z, h) {
    const g = T.genTop(x, z);
    if (g < P.sea + STRUCT.SHORE_AT[0] || g > P.sea + STRUCT.SHORE_AT[1] || !layersAt(x, z, P).sand) return null;
    const [dx, dz] = downhill(T, x, z), q = quarterFacing(dx, dz), [fx, fz] = FRONT[q];
    for (let t = 2; t <= STRUCT.DOCK_LEN; t += SAMPLE) if (T.genTop(x + fx * t, z + fz * t) >= g) return null;
    const depth = P.sea - T.genTop(x + fx * STRUCT.DOCK_LEN, z + fz * STRUCT.DOCK_LEN);
    if (depth < STRUCT.DOCK_DEPTH[0] || depth > STRUCT.DOCK_DEPTH[1]) return null;
    const st = site(T, 'DOCK', (h >>> 8) & 1 ? 'hut' : 'pier', q, seedOf(h), x, z, 'origin');
    return { score: -Math.abs(depth - STRUCT.DOCK_DEPTH[1] / 2), parts: [st] };
  },

  wreck(T, P, x, z, h) {
    const g = T.genTop(x, z);
    if (g < P.sea + STRUCT.WRECK_AT[0] || g > P.sea + STRUCT.WRECK_AT[1] || !layersAt(x, z, P).sand) return null;
    const [dx, dz] = downhill(T, x, z);
    const st = site(T, 'WRECK', undefined, (quarterFacing(dx, dz) + 1) & 3, seedOf(h), x, z, 'origin');   // along the shore
    return st.rise <= STRUCT.WRECK_RISE ? { score: -st.rise, parts: [st] } : null;
  },
};

// Hooks for the island's landforms and caves (world/island): when they say
// where headlands and cave mouths are, the lighthouse and the mine follow
// them; until then (undefined, null) the rules above stand on the terrain.
// - headland(T, P, x, z): true/false where the landforms mark cliff headlands
//   (their site uniforms), undefined where they don't say;
// - caveMouth(T, P, x, z): { facing: [dx, dz] } at a cave mouth, else null.
function headland(T, P, x, z) { return T.islandHeadland ? T.islandHeadland(x, z) > 0 : cliffHeadland(T, P, x, z); }
function caveMouth(T, P, x, z) { return T.islandCaveMouth?.(x, z) > 0 ? { facing: downhill(T, x, z) } : null; }

// A cliff headland at (x, z), derived from the terrain (headland's fallback):
// high ground with the sea close below it in some direction (a cliff, not a
// beach) and on a good share of the ring round it.
function cliffHeadland(T, P, x, z) {
  if (T.genTop(x, z) < P.sea + STRUCT.HEAD_ABOVE) return false;
  let cliff = false;
  for (let i = 0; i < STRUCT.CLIFF_DIRS && !cliff; i++) {
    const a = (i / STRUCT.CLIFF_DIRS) * Math.PI * 2;
    for (let t = STRUCT.CLIFF_STEP; t <= STRUCT.CLIFF_RUN; t += STRUCT.CLIFF_STEP)
      if (T.genTop(Math.round(x + Math.cos(a) * t), Math.round(z + Math.sin(a) * t)) < P.sea) { cliff = true; break; }
  }
  if (!cliff) return false;
  return ring(T, x, z, STRUCT.HEAD_RING, STRUCT.RING_N2).filter((v) => v < P.sea).length / STRUCT.RING_N2 >= STRUCT.HEAD_MIN;
}

// The world's lattice points, step cells apart, that pass keep(x, z).
function lattice(P, step, keep) {
  const out = [];
  for (let z = step >> 1; z < P.size[2]; z += step) for (let x = step >> 1; x < P.size[0]; x += step) if (keep(x, z)) out.push({ x, z });
  return out;
}

// Lattice points round the world's start for its shrine (none without a start).
function shrineSites(P) {
  const st = P.structures?.start, S = STRUCT;
  if (!st) return [];
  const out = [];
  for (let dz = -S.SHRINE_SEARCH; dz <= S.SHRINE_SEARCH; dz += S.SHRINE_STEP)
    for (let dx = -S.SHRINE_SEARCH; dx <= S.SHRINE_SEARCH; dx += S.SHRINE_STEP) out.push({ x: Math.round(st[0] + dx), z: Math.round(st[1] + dz) });
  return out;
}

// The world's shrine's altars (constructions/builtins.js SHRINE_ALTARS), in
// world cells, for the app's perk orbs; null if the world placed none.
export function shrineAltars(P) {
  const s = structuresOf(P).find((r) => r.kind === 'shrine');
  if (!s) return null;
  const y0 = s.y - s.s.base.y;
  return SHRINE_ALTARS.map(([x, y, z]) => {
    const [X, Z] = turnPoint(x, z, s.quarter);
    return new THREE.Vector3(s.x0 + s.s.base.x + X + 0.5, y0 + s.s.base.y + y, s.z0 + s.s.base.z + Z + 0.5);
  });
}

// Places round each tarn for a hermit's cabin: HERMIT_ANGLES on a ring past its clearance.
function tarnSites(P) {
  const reach = LANDFORMS.LAKE_RIM + LANDFORMS.LAKE_CAVE_MARGIN + STRUCT.HERMIT_GAP;
  return (P.landforms?.lakes ?? []).flatMap((l) => Array.from({ length: STRUCT.HERMIT_ANGLES }, (_, i) => {
    const a = (i / STRUCT.HERMIT_ANGLES) * Math.PI * 2, d = (l.r + reach) / (1 - LANDFORMS.WOBBLE_AMP) + HOUSE_HALF;
    return { x: Math.round(l.x + Math.cos(a) * d), z: Math.round(l.z + Math.sin(a) * d) };
  }));
}
const HOUSE_HALF = 10;   // cells from a house's middle to its box's farthest side, about (HOUSE.W 17 · 1.08 / 2, and the log ends)

// The ria's dry gorge (P.landforms.ria), crossed along x or z every GORGE_STEP
// cells of its length: each crossing whose span between rims, depth and rim
// heights suit a bridge, as a site { x, z, c: { span, axis, rim } } at its middle.
function gorgeCrossings(T, P) {
  const R = P.landforms?.ria, S = STRUCT;
  if (!R || !(R.len > 0)) return [];
  const out = [], px = -R.dz, pz = R.dx;   // across the ria's axis
  for (let u = R.drown + S.GORGE_FROM; u <= R.len - S.GORGE_FROM; u += S.GORGE_STEP) {
    const m = T.lfMeander(u), cx = Math.round(R.x + R.dx * u + px * m), cz = Math.round(R.z + R.dz * u + pz * m);
    const floor = T.genTop(cx, cz);
    // the gorge's direction here, meander and all; the bridge crosses along the axis nearest across it
    const dm = (T.lfMeander(u + 1) - T.lfMeander(u - 1)) / 2, tx = R.dx + px * dm, tz = R.dz + pz * dm;
    {
      const axis = Math.abs(tz) > Math.abs(tx) ? 0 : 1;   // across a gorge running along z is along x
      const rim = (sgn) => {   // walk out along the axis to where the wall tops out
        for (let t = 1; t <= S.GORGE_SPAN[1]; t++) {
          const x = cx + (axis ? 0 : sgn * t), z = cz + (axis ? sgn * t : 0), g = T.genTop(x, z);
          const beyond = T.genTop(x + (axis ? 0 : sgn * S.RIM_RUN), z + (axis ? sgn * S.RIM_RUN : 0));
          if (g - floor >= S.GORGE_DEPTH && beyond - g <= S.RIM_FLAT) return { t, g };
        }
        return null;
      };
      const a = rim(-1), b = rim(1);
      if (!a || !b) continue;
      const span = a.t + b.t;
      if (span < S.GORGE_SPAN[0] || span > S.GORGE_SPAN[1] || Math.abs(a.g - b.g) > S.RIM_DIFF) continue;
      const mid = (b.t - a.t) / 2;
      out.push({ x: Math.round(cx + (axis ? 0 : mid)), z: Math.round(cz + (axis ? mid : 0)), c: { span, axis, rim: Math.max(a.g, b.g) } });
    }
  }
  return out;
}

// A house's site with its door on walkable ground: the preferred quarter
// first, then the others; null if no side will do.
function doorSite(T, P, variant, seed, x, z, prefer) {
  for (const q of [prefer, (prefer + 1) & 3, (prefer + 3) & 3, (prefer + 2) & 3]) {
    const st = site(T, 'HOUSE', variant, q, seed, x, z);
    if (!fits(P, st, STRUCT.HOUSE_RISE)) continue;
    const [fx, fz] = FRONT[q], reach = (fx ? st.s.w : st.s.d) / 2 + STRUCT.DOOR_OUT;
    const g = T.genTop(Math.round(x + fx * reach), Math.round(z + fz * reach));
    if (g >= st.y && g <= st.y + 1) return st;
  }
  return null;
}

// Do two sites' boxes come within GAP of each other?
function overlaps(a, b) {
  return a.x0 - GAP < b.x0 + b.s.w && b.x0 - GAP < a.x0 + a.s.w && a.z0 - GAP < b.z0 + b.s.d && b.z0 - GAP < a.z0 + a.s.d;
}

// ---------------------------------------------------------------- placement
const placed = new Map();   // JSON(P) → the world's structures
const PLACED_KEEP = 4;

// A placed structure as a record (world/bake.js ships them): what placement
// chose, without its baked construction, which fromRecord bakes again.
export const structureRecord = ({ kind, key, variant, quarter, seed, x, y, z, lo, hi, rise, wet }) =>
  ({ kind, key, variant, quarter, seed, x, y, z, lo, hi, rise, wet });
function fromRecord(r) {
  const s = bakeOf(r.key, r.variant, r.quarter, r.seed);
  return { ...r, s, x0: r.x - s.base.x, z0: r.z - s.base.z };
}

// World P's structures: [{ key, variant, quarter, seed, x, y, z, s (baked), x0, z0, kind }].
// From the build's bake when it is of this very world (world/bake.js), else placed here.
export function structuresOf(P) {
  if (!P.structures) return [];
  const k = JSON.stringify(P);
  if (placed.has(k)) return placed.get(k);
  const b = bakeFor(P.size, P.seed);
  if (b && JSON.stringify(b.landforms) === JSON.stringify(P.landforms) && JSON.stringify(b.start) === JSON.stringify(P.structures.start)) {
    const list = b.records.map(fromRecord);
    if (placed.size >= PLACED_KEEP) placed.clear();
    placed.set(k, list);
    return list;
  }
  const T = islandTwin(P), [wx, , wz] = P.size, stream = pcg((P.seed + SALT) >>> 0);
  const cands = [];
  // kinds with sites of their own try those (hashed per point), the rest the squares'
  const siteLists = KINDS.map(({ sites }) => sites?.(T, P) ?? null);
  siteLists.forEach((list, rank) => list?.forEach(({ x, z, c }) => {
    const h = pcg((x >>> 0) + pcg(((z >>> 0) + stream + rank) >>> 0)), r = RULES[KINDS[rank].kind](T, P, x, z, h, c);
    if (r) cands.push({ kind: KINDS[rank].kind, rank, x, z, score: r.score, tie: h, parts: r.parts });
  }));
  for (let sz = 0; sz < wz / SITE; sz++)
    for (let sx = 0; sx < wx / SITE; sx++) {
      const h0 = pcg((sx >>> 0) + pcg(((sz >>> 0) + stream) >>> 0));
      KINDS.forEach(({ kind, tries = SITE_TRIES, sites }, rank) => {
        if (sites && siteLists[rank]) return;
        let h = pcg(h0 + rank);
        for (let t = 0; t < tries; t++, h = pcg(h)) {
          const x = sx * SITE + (h % SITE), z = sz * SITE + ((h >>> 8) % SITE);
          const r = RULES[kind](T, P, x, z, h);
          if (r) { cands.push({ kind, rank, x, z, score: r.score, tie: h, parts: r.parts }); break; }
        }
      });
    }
  // thinning: by rank, then best score, then hash; kept while clear of the kept and under the cap
  cands.sort((a, b) => a.rank - b.rank || b.score - a.score || a.tie - b.tie);
  const kept = [], count = {};
  for (const c of cands) {
    const K = KINDS[c.rank];
    if ((count[c.kind] ?? 0) >= K.cap) continue;
    if (kept.some((o) => (o.kind === c.kind && Math.hypot(o.x - c.x, o.z - c.z) < K.spacing)
      || o.parts.some((p) => c.parts.some((q) => overlaps(p, q))))) continue;
    if (kept.reduce((n, o) => n + o.parts.length, 0) + c.parts.length > MAX_SLOTS) break;
    kept.push(c);
    count[c.kind] = (count[c.kind] ?? 0) + 1;
  }
  const list = kept.flatMap((c) => c.parts.map((p) => ({ ...p, kind: c.kind })));
  if (placed.size >= PLACED_KEEP) placed.clear();
  placed.set(k, list);
  return list;
}

// World P's structures, off the main thread where the app gave a worker
// (world/bakeClient.js): its list lands in structuresOf's cache, so the calls
// after it are instant. (island.prepare awaits it while its columns compile.)
export async function structuresReady(P) {
  if (!P.structures) return;
  const k = JSON.stringify(P), work = structureWorker();
  if (placed.has(k)) return;
  if (work) {
    try {
      const list = await work(P);
      if (placed.size >= PLACED_KEEP) placed.clear();
      placed.set(k, list);
      return;
    } catch (err) {
      console.error('structures: the worker failed, placing them here', err);
    }
  }
  structuresOf(P);
}
// Is world P's placement known yet (or will asking compute it here)?
const placedYet = (P) => !P.structures || placed.has(JSON.stringify(P)) || !structureWorker();

// ---------------------------------------------------------------- the textures
// index: RGBA8UI per world brick column: r = slot + 1 of the structure whose box
// covers it (0: none), g = 1 within TREE.REACH of any structure's box (no trees).
// cells: R8UI atlas of every structure's box: id + 1 (0: leave the scene's
// cell), + FOOT_BIT on base cells that grow a footing. info: RGBA32I, INFO_W
// texels a slot: (box low corner x, y, z; footing depth), (w, h, d; atlas x),
// (atlas z; 0, 0, 0).
const FOOT_BIT = 128;
const INFO_W = 3;

const textures = new Map();
export function structureData(P, list = structuresOf(P)) {
  const k = JSON.stringify(P);
  if (textures.has(k)) return textures.get(k);
  const BX = P.size[0] / BRICK, BZ = P.size[2] / BRICK;
  const index = new Uint8Array(BX * BZ * 4);
  const info = new Int32Array(Math.max(1, list.length) * INFO_W * 4);
  // shelf-pack the boxes along x, rows along z
  let ax = 0, az = 0, rowD = 0;
  const at = list.map((st) => {
    if (ax + st.s.w > ATLAS_W) { ax = 0; az += rowD; rowD = 0; }
    const a = [ax, az];
    ax += st.s.w; rowD = Math.max(rowD, st.s.d);
    return a;
  });
  const AW = Math.max(1, list.length ? Math.max(...list.map((st, i) => at[i][0] + st.s.w)) : 1);
  const AH = Math.max(1, ...list.map((st) => st.s.h)), AD = Math.max(1, az + rowD);
  const cells = new Uint8Array(AW * AH * AD);
  const R = TREE.REACH;
  list.forEach((st, slot) => {
    const { s } = st, [aX, aZ] = at[slot], y0 = st.y - s.base.y;
    for (let z = 0; z < s.d; z++)
      for (let y = 0; y < s.h; y++)
        for (let x = 0; x < s.w; x++) {
          const j = (z * s.h + y) * s.w + x, id = s.data[j * 4] - 1;
          if (id < 0) continue;
          cells[((aZ + z) * AH + y) * AW + aX + x] = (id + 1) | (s.data[j * 4 + 3] > 0.5 ? FOOT_BIT : 0);
        }
    info.set([st.x0, y0, st.z0, s.foot, s.w, s.h, s.d, aX, aZ, 0, 0, 0], slot * INFO_W * 4);
    for (let bz = Math.floor((st.z0 - R) / BRICK); bz <= Math.floor((st.z0 + s.d - 1 + R) / BRICK); bz++)
      for (let bx = Math.floor((st.x0 - R) / BRICK); bx <= Math.floor((st.x0 + s.w - 1 + R) / BRICK); bx++) {
        if (bx < 0 || bz < 0 || bx >= BX || bz >= BZ) continue;
        const o = (bz * BX + bx) * 4;
        index[o + 1] = 1;
        const inBox = bx * BRICK + BRICK > st.x0 && bx * BRICK < st.x0 + s.w && bz * BRICK + BRICK > st.z0 && bz * BRICK < st.z0 + s.d;
        if (inBox) index[o] = slot + 1;
      }
  });
  const data = { list, index, cells, info, size: [AW, AH, AD], BX, BZ };
  if (!list.pending) {
    if (textures.size >= PLACED_KEEP) textures.clear();
    textures.set(k, data);
  }
  return data;
}

// Is a tree's trunk at world column (x, z) in a structure's clearing? (CPU twin of structureClears)
export function structureClear(P, x, z) {
  if (!P.structures) return false;
  const { index, BX, BZ } = structureData(P), bx = Math.floor(x / BRICK), bz = Math.floor(z / BRICK);
  return bx >= 0 && bz >= 0 && bx < BX && bz < BZ && index[(bz * BX + bx) * 4 + 1] > 0;
}

// The element at world cell (x, y, z) with the structures in, given id, the
// scene's own cell there; cellAt(y) the scene's cell at height y in this
// column (the footing's search). (CPU twin of structureCell.)
export function structureCellAt(P, x, y, z, id, cellAt) {
  if (!P.structures) return id;
  const { index, cells, info, size: [AW, AH], BX, BZ } = structureData(P);
  const bx = Math.floor(x / BRICK), bz = Math.floor(z / BRICK);
  if (bx < 0 || bz < 0 || bx >= BX || bz >= BZ) return id;
  const slot = index[(bz * BX + bx) * 4] - 1;
  if (slot < 0) return id;
  const I = (n) => info[slot * INFO_W * 4 + n];
  const qx = x - I(0), qy = y - I(1), qz = z - I(2);
  if (qx < 0 || qz < 0 || qx >= I(4) || qz >= I(6) || qy >= I(5) || qy < -I(3)) return id;
  const cell = (yy) => cells[((I(8) + qz) * AH + yy) * AW + I(7) + qx];
  if (qy >= 0) { const c = cell(qy) & (FOOT_BIT - 1); return c ? c - 1 : id; }
  const c = cell(0);
  if (!(c & FOOT_BIT) || bears(id)) return id;
  for (let yy = I(1) - 1; yy > y; yy--) if (bears(cellAt(yy))) return id;
  for (let i = 1; i <= I(3); i++) { const yy = I(1) - i; if (yy < 0 || bears(cellAt(yy))) return (c & (FOOT_BIT - 1)) - 1; }
  return id;
}
const bears = (id) => id !== E.EMPTY && ELEMENTS[id].kind !== K.GAS && ELEMENTS[id].kind !== K.LIQUID;

// ---------------------------------------------------------------- GPU
// The textures for world P (one set per world, kept), and the uniforms that bind them.
const gpu = new Map();
export function structureUniforms(P) {
  // until a worker has placed them (structuresReady), empty textures: the window asks again after prepare
  const ready = placedYet(P), k = ready ? JSON.stringify(P) : `pending:${P.size}`;
  let t = gpu.get(k);
  if (!t) {
    const d = ready ? structureData(P) : structureData(P, Object.assign([], { pending: true }));
    const index = new THREE.DataTexture(d.index, d.BX, d.BZ, THREE.RGBAIntegerFormat, THREE.UnsignedByteType);
    index.internalFormat = 'RGBA8UI';
    const info = new THREE.DataTexture(d.info, INFO_W, Math.max(1, d.list.length), THREE.RGBAIntegerFormat, THREE.IntType);
    info.internalFormat = 'RGBA32I';
    const cells = new THREE.Data3DTexture(d.cells, ...d.size);
    cells.format = THREE.RedIntegerFormat;
    cells.type = THREE.UnsignedByteType;
    cells.internalFormat = 'R8UI';
    cells.unpackAlignment = 1;
    for (const tex of [index, info, cells]) { tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true; }
    t = { index, info, cells };
    if (gpu.size >= PLACED_KEEP) disposeStructureTextures();
    gpu.set(k, t);
  }
  return {
    uStructOn: { value: !!P.structures },
    tStructIndex: { value: t.index }, tStructInfo: { value: t.info }, tStructCells: { value: t.cells },
  };
}
export function disposeStructureTextures() {
  for (const t of gpu.values()) Object.values(t).forEach((tex) => tex.dispose());
  gpu.clear();
}

// structureCell(w, id, cellAt): sceneCell's id at world cell w with the structures
// in. The scene defines int structureGround(ivec3 w): its own cell there (the
// footing's search). structureClears(ivec2 bc): no tree in brick column bc.
export const STRUCT_GLSL = /* glsl */ `
precision highp usampler2D;
precision highp isampler2D;
precision highp usampler3D;
uniform bool uStructOn;
uniform usampler2D tStructIndex;
uniform isampler2D tStructInfo;
uniform usampler3D tStructCells;
#define STRUCT_FOOT_BIT ${FOOT_BIT}u
int structureGround(ivec3 w);
bool structBears(int id) { return id != E_EMPTY && KIND[id] != K_GAS && KIND[id] != K_LIQUID; }
bool structureClears(ivec2 bc) {
  if (!uStructOn || any(lessThan(bc, ivec2(0))) || any(greaterThanEqual(bc, textureSize(tStructIndex, 0)))) return false;
  return texelFetch(tStructIndex, bc, 0).g > 0u;
}
int structureCell(ivec3 w, int id) {
  if (!uStructOn) return id;
  ivec2 bc = w.xz / BS;
  if (any(lessThan(w.xz, ivec2(0))) || any(greaterThanEqual(bc, textureSize(tStructIndex, 0)))) return id;
  int slot = int(texelFetch(tStructIndex, bc, 0).r) - 1;
  if (slot < 0) return id;
  ivec4 lo = texelFetch(tStructInfo, ivec2(0, slot), 0), box = texelFetch(tStructInfo, ivec2(1, slot), 0);
  int az = texelFetch(tStructInfo, ivec2(2, slot), 0).x;
  ivec3 q = w - lo.xyz;
  if (q.x < 0 || q.z < 0 || q.x >= box.x || q.z >= box.z || q.y >= box.y || q.y < -lo.w) return id;
  if (q.y >= 0) {
    uint c = texelFetch(tStructCells, ivec3(box.w + q.x, q.y, az + q.z), 0).r & (STRUCT_FOOT_BIT - 1u);
    return c > 0u ? int(c) - 1 : id;
  }
  // a footing: the base cell above grows one, down through what bears no weight to ground within reach
  uint c = texelFetch(tStructCells, ivec3(box.w + q.x, 0, az + q.z), 0).r;
  if ((c & STRUCT_FOOT_BIT) == 0u || structBears(id)) return id;
  for (int y = lo.y - 1; y > w.y; y--) if (structBears(structureGround(ivec3(w.x, y, w.z)))) return id;
  for (int i = 1; i <= ${MAX_FOOT}; i++) {
    if (i > lo.w) break;
    int y = lo.y - i;
    if (y < 0 || structBears(structureGround(ivec3(w.x, y, w.z)))) return int(c & (STRUCT_FOOT_BIT - 1u)) - 1;
  }
  return id;
}
`;
