// CPU check of what lives and lies in the island's caves (src/world/island/
// nature.js: gold veins, placer nuggets, moss, fungus) from the island's JS
// twin, over the whole World (or a box of it). No GPU: fine on battery.
//   - unchanged elsewhere: every cell where islandCell differs from
//     islandCellBare (the island before the hook) is GOLD, NUGGETS, MOSS or
//     FUNGUS, put where bare rock was (by from → to);
//   - at rest, cell by cell against the engine's rules, in the finished world:
//     each grower's ctype (islandDamp) is react.js dampOf of its neighbours (so
//     it is the settled damp: dampOf has one fixed point); no air cell touches
//     damp moss and bare rock across the moss's axis (mossSite); no damp fungus
//     touches WOOD, SAWDUST or PLANT; each nugget's sides and the 3 × 3 under it
//     are solid or nuggets (move.js: nothing to topple into);
//   - a census per element (and how many are in sight: a face open to air),
//     and spots for stills (spots.json): for each, the 16³ block holding the
//     most in sight with a view, its cell nearest the
//     block's middle (look), and a dry cave floor in sight of it to stand on,
//     under the ground
//     (feet), as tools/caves-preview.mjs finds them.
// usage: node tools/nature-check.mjs [outDir] [--box x0 z0 nx nz]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { E, ELEMENTS, K } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { worldParams, islandTwin } from '../src/world/generator.js';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'nature-check';
const bi = args.indexOf('--box');
const NY = WORLD_SIZE[1];
const box = bi >= 0 ? args.slice(bi + 1, bi + 5).map(Number) : [0, 0, WORLD_SIZE[0], WORLD_SIZE[2]];
const BLOCK = 16;              // spots: elements counted per this many cells cube
const SPOT_TRIES = 40;         // ...the fullest this many blocks tried for a view
const VIEW_NEAR = 4;           // a spot's feet stand at least this far from what they look at...
const VIEW_FAR = 16;           // ...and at most this far
const HEADROOM = 6;            // ...under this many cells of air (the POV body is 5.5 tall)
const SIGHT_STEP = 0.5;        // line-of-sight march step, cells
const EYE = 5;                 // the POV eye over its feet, cells (pov/constants.js EYE_HEIGHT)
const EYE_FAR = 10;            // a free camera's eye: in cave air at most this far from what it looks at...
const EYE_AT = 6;              // ...this far, as near as can be
const LOG_EVERY = 64;          // rows of z between progress lines
mkdirSync(out, { recursive: true });

const P = worldParams({ size: WORLD_SIZE, snow: false });
const T = islandTwin(P);
const name = (id) => ELEMENTS[id]?.key ?? id;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const BED = new Set([E.ROCK, E.STONE, E.LIMESTONE, E.SANDSTONE]);    // react.js mossBed
const FOOD = new Set([E.WOOD, E.SAWDUST, E.PLANT]);                    // react.js fungusFood
const PLACED = new Set([E.GOLD, E.NUGGETS, E.MOSS, E.FUNGUS]);
const grower = (id) => id === E.MOSS || id === E.FUNGUS;
const inWorld = (y) => y >= 0 && y < NY;
const cell = (x, y, z) => (inWorld(y) ? T.islandCell(x, y, z) : E.WALL);

// react.js dampOf: DAMP_REACH beside water, else one less than the dampest grower beside it
function dampOf(x, y, z) {
  let h = 0;
  for (const [dx, dy, dz] of FACES) {
    const j = cell(x + dx, y + dy, z + dz);
    if (j === E.WATER) return PHYS.DAMP_REACH;
    if (grower(j)) h = Math.max(h, Math.floor(T.islandDamp(y + dy, j)) - 1);
  }
  return h;
}

const census = {}, seen = {}, changes = {}, bad = {}, badAt = [];
const fault = (k, at) => { bad[k] = (bad[k] ?? 0) + 1; if (badAt.length < 20) badAt.push(`${k} at ${at.join(', ')}`); };
const blocks = new Map();   // `${element}:${bx},${by},${bz}` → cells in sight
const t0 = performance.now();
const [x0, z0, nx, nz] = box;
for (let z = z0; z < z0 + nz; z++) {
  if ((z - z0) % LOG_EVERY === 0) console.log(`z ${z} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  for (let x = x0; x < x0 + nx; x++) {
    const top = T.genTop(x, z);
    for (let y = 0; y < Math.min(top + 1, NY); y++) {
      const bare = T.islandCellBare(x, y, z), id = T.islandNature(x, y, z, bare);
      if (id === bare) continue;
      const k = `${name(bare)}->${name(id)}`;
      changes[k] = (changes[k] ?? 0) + 1;
      census[name(id)] = (census[name(id)] ?? 0) + 1;
      const at = [x, y, z];
      if (!PLACED.has(id) || !BED.has(bare)) fault('not ours', at);
      if (FACES.some(([dx, dy, dz]) => cell(x + dx, y + dy, z + dz) === E.EMPTY)) {   // in sight: on a face open to air
        seen[name(id)] = (seen[name(id)] ?? 0) + 1;
        const bk = `${id}:${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)},${Math.floor(z / BLOCK)}`;
        blocks.set(bk, (blocks.get(bk) ?? 0) + 1);
      }
      if (grower(id)) {
        const ct = T.islandDamp(y, id);
        if (dampOf(x, y, z) !== ct) fault(`${name(id)} damp ${ct} not settled (${dampOf(x, y, z)})`, at);
        if (ct >= 1 && id === E.FUNGUS)
          for (const [dx, dy, dz] of FACES) if (FOOD.has(cell(x + dx, y + dy, z + dz))) fault('damp fungus by food', at);
        if (ct >= 1 && id === E.MOSS)
          FACES.forEach(([dx, dy, dz], i) => {
            const cx = x + dx, cy = y + dy, cz = z + dz;
            if (cell(cx, cy, cz) !== E.EMPTY) return;
            FACES.forEach(([ex, ey, ez], k2) => {
              if (k2 >> 1 !== i >> 1 && BED.has(cell(cx + ex, cy + ey, cz + ez))) fault('air by damp moss and bare rock', [cx, cy, cz]);
            });
          });
      }
      if (id === E.NUGGETS) {
        const cup = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cup.push([dx, -1, dz]);
        for (const [dx, dy, dz] of cup) {   // (nuggets beside nuggets: a grain doesn't move into its own kind)
          const j = cell(x + dx, y + dy, z + dz);
          if (ELEMENTS[j]?.kind !== K.SOLID && j !== E.NUGGETS) fault('nugget not socketed', at);
        }
        if (cell(x, y + 1, z) !== E.WATER) fault('nugget not under water', at);
      }
    }
  }
}
const secs = (performance.now() - t0) / 1000;

// spots: the fullest block per element, its cell nearest the middle, feet in sight of it
const solid = (id) => ELEMENTS[id]?.kind === K.SOLID || ELEMENTS[id]?.kind === K.POWDER;
function sight(a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.ceil(Math.hypot(...d) / SIGHT_STEP);
  for (let i = 1; i < n; i++) {
    const p = a.map((v, k) => Math.floor(v + (d[k] * i) / n));
    if (p[0] === Math.floor(b[0]) && p[1] === Math.floor(b[1]) && p[2] === Math.floor(b[2])) return true;
    if (cell(...p) !== E.EMPTY) return false;
  }
  return true;
}
// the fullest blocks first, until one has feet in sight in a cave
function spotFor(id) {
  const tries = [...blocks].filter(([k]) => k.startsWith(`${id}:`)).sort((a, b) => b[1] - a[1]).slice(0, SPOT_TRIES);
  let first = null;
  for (const best of tries) {
    const s = spotIn(id, best);
    first ??= s;
    if (s.feet) return s;
  }
  return first;
}
function spotIn(id, best) {
  const [bx, by, bz] = best[0].split(':')[1].split(',').map(Number);
  const mid = [bx, by, bz].map((v) => v * BLOCK + BLOCK / 2);
  let look = null;
  for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) for (let z = bz * BLOCK; z < (bz + 1) * BLOCK; z++) for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
    if (cell(x, y, z) !== id || !FACES.some(([dx, dy, dz]) => cell(x + dx, y + dy, z + dz) === E.EMPTY)) continue;
    const d = Math.hypot(x - mid[0], y - mid[1], z - mid[2]);
    if (!look || d < look[1]) look = [[x, y, z], d];
  }
  if (!look) return { block: best, look: null };
  const [lx, ly, lz] = look[0];
  let feet = null;
  for (let dz = -VIEW_FAR; dz <= VIEW_FAR; dz++) for (let dx = -VIEW_FAR; dx <= VIEW_FAR; dx++) {
    const r = Math.hypot(dx, dz);
    if (r < VIEW_NEAR || r > VIEW_FAR) continue;
    const fx = lx + dx, fz = lz + dz;
    for (let fy = ly - VIEW_FAR; fy <= ly + VIEW_FAR; fy++) {
      if (!inWorld(fy - 1) || fy >= T.genTop(fx, fz) || !solid(cell(fx, fy - 1, fz)) || cell(fx, fy - 1, fz) === E.WATER) continue;
      let clear = true;
      for (let h = 0; h < HEADROOM && clear; h++) clear = cell(fx, fy + h, fz) === E.EMPTY;
      if (fy + HEADROOM >= T.genTop(fx, fz)) continue;   // in a cave: under its column's ground
      if (!clear || !sight([fx + 0.5, fy + EYE, fz + 0.5], [lx + 0.5, ly + 0.5, lz + 0.5])) continue;
      const score = Math.abs(r - (VIEW_NEAR + VIEW_FAR) / 2);
      if (!feet || score < feet[1]) feet = [[fx, fy, fz], score];
    }
  }
  // (and an eye anywhere in the air in sight of it, for a camera where no floor is)
  let eye = null;
  for (let dz = -EYE_FAR; dz <= EYE_FAR; dz++) for (let dy = -EYE_FAR; dy <= EYE_FAR; dy++) for (let dx = -EYE_FAR; dx <= EYE_FAR; dx++) {
    const r = Math.hypot(dx, dy, dz), e = [lx + dx, ly + dy, lz + dz];
    if (r < VIEW_NEAR || r > EYE_FAR || cell(...e) !== E.EMPTY || e[1] >= T.genTop(e[0], e[2])) continue;
    if (!sight(e.map((v) => v + 0.5), [lx + 0.5, ly + 0.5, lz + 0.5])) continue;
    if (!eye || Math.abs(r - EYE_AT) < eye[1]) eye = [e, Math.abs(r - EYE_AT)];
  }
  return { block: best, look: look[0], feet: feet?.[0] ?? null, eye: eye?.[0] ?? null };
}
const spots = { moss: spotFor(E.MOSS), fungus: spotFor(E.FUNGUS), gold: spotFor(E.GOLD), nuggets: spotFor(E.NUGGETS) };
writeFileSync(join(out, 'spots.json'), JSON.stringify(spots, null, 1));
console.log(JSON.stringify({ box, secs: +secs.toFixed(0), census, inSight: seen, changes, faults: bad, faultsAt: badAt, spots }, null, 1));
if (Object.keys(bad).length) process.exitCode = 1;
