// CPU check of underground generation (island JS twin) over the World, a
// box of it, or the Islet. No GPU.
//   - ore/grower changes keep their host strata and do not change cover;
//   - dry ore is isolated from water, lakes and (for sulfur) coal or fire;
//   - geodes keep their shell and level cup; reservoirs have two whole solid
//     layers, including diagonals, before they can meet another cavity;
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
//     (feet), as tools/caves-preview.mjs finds them;
//   - the structure overlay, across all placed footprints regardless of --box,
//     must not cut into seals or introduce dry-mineral reaction contacts.
// usage: node tools/nature-check.mjs [outDir] [--islet] [--seed n] [--box x0 z0 nx nz]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { E, ELEMENTS, K } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { worldParams, islandTwin } from '../src/world/generator.js';
import { NATURE } from '../src/world/island/nature.js';
import { CAVE } from '../src/world/island/caves.js';
import { island } from '../src/world/scenes/island.js';
import { structuresOf, structureCellAt } from '../src/world/structures.js';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'nature-check';
const bi = args.indexOf('--box'), si = args.indexOf('--seed');
const seed = si < 0 ? undefined : Number(args[si + 1]);
const islet = args.includes('--islet');
const size = islet ? [128, 128, 128] : WORLD_SIZE;
const NY = size[1];
const box = bi >= 0 ? args.slice(bi + 1, bi + 5).map(Number) : [0, 0, size[0], size[2]];
const BLOCK = 16;              // spots: elements counted per this many cells cube
const SPOT_TRIES = 40;         // ...the fullest this many blocks tried for a view
const MOSS_VIEW = 8;           // the feet's distance from what they look at, as near as can be: moss...
const FUNGUS_VIEW = 10;        // ...fungus (it glows: seen from farther)...
const GOLD_VIEW = 5;           // ...gold (dark metal in a dark cave: up close)
const DAYLIGHT = 3;            // a spot in daylight: open air at its height this many columns away at most
const VIEW_NEAR = 4;           // a spot's feet stand at least this far from what they look at...
const VIEW_FAR = 16;           // ...and at most this far
const HEADROOM = 6;            // ...under this many cells of air (the POV body is 5.5 tall)
const SIGHT_STEP = 0.5;        // line-of-sight march step, cells
const EYE = 5;                 // the POV eye over its feet, cells (pov/constants.js EYE_HEIGHT)
const EYE_FAR = 10;            // a free camera's eye: in cave air at most this far from what it looks at...
const EYE_AT = 6;              // ...this far, as near as can be
const LOG_EVERY = 64;          // rows of z between progress lines
mkdirSync(out, { recursive: true });

const P = islet ? worldParams({ size, seed }) : island.params({ size, seed });
const T = islandTwin(P);
const name = (id) => ELEMENTS[id]?.key ?? id;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const BED = new Set([E.ROCK, E.LIMESTONE, E.SANDSTONE]);             // generation hosts grower replacements
const FOOD = new Set([E.WOOD, E.SAWDUST, E.PLANT]);                    // react.js fungusFood
const BASEMENT = new Set([E.GOLD, E.NUGGETS, E.LITHIUM_ORE, E.URANIUM_ORE, E.TUNGSTEN_ORE, E.BASALT, E.DIAMOND]);
const LIME = new Set([E.COPPER_ORE, E.SULFUR, E.ROCK_SALT, E.CINNABAR]);
const DRY = new Map([[E.SULFUR, 2], [E.LITHIUM_ORE, 2], [E.ROCK_SALT, 4]]);
const FLUIDS = new Set([E.OIL, E.PROPANE, E.HEALTHIUM]);
const CARVED = new Set([...FLUIDS, E.CRYSTAL, E.BASALT, E.DIAMOND]);
const solidRock = (id) => ELEMENTS[id]?.kind === K.SOLID && id !== E.WALL;
const NEAR = (r) => {
  const offsets = [];
  for (let z = -r; z <= r; z++) for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (x || y || z) offsets.push([x, y, z]);
  }
  return offsets;
};
const RING = NEAR(CAVE.SEAL), TOUCH = NEAR(1);
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

const auditedIds = new Set([...BASEMENT, ...LIME, ...CARVED, E.IRON_ORE, E.EMBER, E.MOSS, E.FUNGUS]);
const emptyCensus = () => Object.fromEntries([...auditedIds].map((id) => [name(id), 0]));
const census = emptyCensus(), seen = emptyCensus(), changes = {}, features = {}, bad = {}, badAt = [];
const count = (table, k) => { table[k] = (table[k] ?? 0) + 1; };
const fault = (k, at) => { bad[k] = (bad[k] ?? 0) + 1; if (badAt.length < 20) badAt.push(`${k} at ${at.join(', ')}`); };
const blocks = new Map();   // `${element}:${bx},${by},${bz}` → cells in sight
const auditedSeals = new Set();
function auditSeal(x, y, z, id) {
  const n = CAVE.SEALED_CELL, corner = [x, y, z].map((v) => n * Math.floor(v / n)), key = corner.join(',');
  if (auditedSeals.has(key)) return;
  auditedSeals.add(key);
  const geode = ![E.OIL, E.PROPANE].includes(id);
  count(features, geode ? 'geodes' : `${name(id)} pockets`);
  const tissue = new Map();
  const at = (px, py, pz) => {
    const k = `${px},${py},${pz}`;
    if (!tissue.has(k)) tissue.set(k, cell(px, py, pz));
    return tissue.get(k);
  };
  const geometry = new Map();
  let poolY = null, interior = 0;
  for (let pz = corner[2]; pz < corner[2] + n; pz++) for (let py = corner[1]; py < corner[1] + n; py++)
    for (let px = corner[0]; px < corner[0] + n; px++) {
      const j = T.caveSealed(px, py, pz, -2);  // -2: reserved ordinary rock; -1: outside/rejected site
      if (j >= 0) geometry.set(`${px},${py},${pz}`, [px, py, pz, j]);
    }
  for (const [px, py, pz, j] of geometry.values()) {
    const p = [px, py, pz];
    if (at(...p) !== j || T.caveLakeClear(px, pz) || py >= T.genTop(px, pz) - CAVE.ROOF) fault('sealed geometry mismatch', p);
    if (geode && j === E.DIAMOND) count(features, 'geode diamonds');
    if (geode && (j === E.EMPTY || j === E.HEALTHIUM)) {
      interior++;
      if (T.cavePowderNear(px, py, pz)) fault('geode beside powder', p);
    }
    // Audit the enclosing buffer *outside* the whole feature, not just the
    // immediate neighbours of a fluid cell. This includes all diagonals.
    for (const [dx, dy, dz] of RING) {
      const qx = px + dx, qy = py + dy, qz = pz + dz;
      if (!geometry.has(`${qx},${qy},${qz}`) && !solidRock(at(qx, qy, qz))) fault('sealed feature lacks two rock layers', p);
    }
    if (j === E.HEALTHIUM) {
      if (poolY !== null && poolY !== py) fault('geode pool is not level', p);
      poolY = py;
      for (const [dx, dy, dz] of TOUCH) {
        if (dy > 0) continue;
        const below = at(px + dx, py + dy, pz + dz);
        if (dy < 0 ? below !== E.BASALT : !solidRock(below) && below !== E.HEALTHIUM) fault('geode pool not socketed', p);
      }
    }
  }
  if (geode && interior === 0) fault('geode not hollow', [x, y, z]);
  if (poolY !== null) count(features, 'geode pools');
}
function auditStructureOverlay() {
  const list = structuresOf(P);
  const breaches = { OIL: 0, PROPANE: 0, HEALTHIUM: 0, GEODE: 0 };
  const overlay = (x, y, z, base = cell(x, y, z)) => structureCellAt(P, x, y, z, base, (yy) => cell(x, yy, z));
  const checked = new Set();
  let dryMineralContacts = 0;
  for (const { x0, y, z0, s } of list) {
    // Visit any natural cell whose own space or two-layer buffer the stamp
    // can change, including the deepest possible footing and diagonals.
    const r = CAVE.SEAL;
    for (let z = z0 - r; z < z0 + s.d + r; z++) for (let x = x0 - r; x < x0 + s.w + r; x++)
      for (let yy = Math.max(0, y - s.foot - r); yy < Math.min(NY, y + s.h + r); yy++) {
        const id = cell(x, yy, z);
        const k = FLUIDS.has(id) ? name(id) :
          (id === E.EMPTY || id === E.BASALT || id === E.CRYSTAL || id === E.DIAMOND) && T.caveSealed(x, yy, z, -2) >= 0 ? 'GEODE' : null;
        if (!k && !DRY.has(id)) continue;
        const at = [x, yy, z];
        const key = at.join(',');
        if (checked.has(key)) continue;
        checked.add(key);
        const contacts = (test, offsets) => offsets.some(([dx, dy, dz]) => {
          const [px, py, pz] = [x + dx, yy + dy, z + dz];
          const before = cell(px, py, pz);
          return test(before, overlay(px, py, pz, before));
        });
        if (k && (overlay(...at, id) !== id || contacts((before, after) => solidRock(before) && !solidRock(after), RING))) {
          breaches[k]++;
          fault(`structure breached ${k}`, at);
        }
        const reactive = (n) => n === E.WATER || n === E.SALTWATER || (id === E.SULFUR && (n === E.COAL || n === E.FIRE));
        if (DRY.has(id) && contacts((before, after) => !reactive(before) && reactive(after), TOUCH)) {
          dryMineralContacts++;
          fault(`structure exposed ${name(id)} to reaction contact`, at);
        }
      }
  }
  if (islet && seed === 316) {
    const oil = [55, 20, 51];
    if (cell(...oil) !== E.OIL || overlay(...oil) !== E.OIL) fault('Islet seed 316 regression: expected intact oil', oil);
  }
  return { count: list.length, caveRooms: list.filter((s) => s.underground).length, breaches, dryMineralContacts };
}

const t0 = performance.now();
const postStructures = auditStructureOverlay();
console.log('post-structure overlay', JSON.stringify(postStructures));
const [x0, z0, nx, nz] = box;
for (let z = z0; z < z0 + nz; z++) {
  if ((z - z0) % LOG_EVERY === 0) console.log(`z ${z} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  for (let x = x0; x < x0 + nx; x++) {
    const top = T.genTop(x, z);
    for (let y = 0; y < Math.min(top + 1, NY); y++) {
      const bare = T.islandCellBare(x, y, z), id = T.islandNature(x, y, z, bare);
      const at = [x, y, z];
      if (id !== bare) {
        count(changes, `${name(bare)}->${name(id)}`);
        const hostOk = BASEMENT.has(id) ? bare === E.ROCK : LIME.has(id) ? bare === E.LIMESTONE
          : id === E.IRON_ORE ? bare === E.SANDSTONE && T.stUnderCoal(x + 0.5, y + 0.5, z + 0.5, 2.4)
          : id === E.EMBER ? bare === E.ROCK || bare === E.COAL : grower(id) && BED.has(bare);
        if (!hostOk) fault('unexpected nature replacement', at);
      } else {
        if (id === E.EMPTY && y >= P.sea && y <= P.sea + CAVE.BELL_RISE && y < top - CAVE.ROOF
          && T.caveRegion(x, z) === CAVE.KARST && T.islandRock(x, y, z, top) === E.LIMESTONE
          && !T.caveLakeClear(x, z) && T.caveAirBell(x, y, z, E.LIMESTONE) === E.EMPTY) {
          const [ground, , , water] = T.column(x, z);
          if (T.caveOrdinary(x, y, z, ground, water, E.LIMESTONE) === E.LIMESTONE) {
            count(features, 'air bell air');
            if (T.cavePowderNear(x, y, z)) fault('air bell beside powder', at);
          }
        }
        if (!CARVED.has(id)) continue;
        if (id !== E.CRYSTAL) {
          auditSeal(x, y, z, id);
          const host = T.islandRock(x, y, z, top);
          if (id === E.OIL ? host !== E.SANDSTONE && host !== E.LIMESTONE : id === E.PROPANE ? host !== E.SANDSTONE : host !== E.ROCK)
            fault('sealed feature in wrong host', at);
        }
      }
      count(census, name(id));
      if (DRY.has(id)) {
        if (y < P.sea + DRY.get(id) || T.caveLakeClear(x, z)) fault('dry mineral in wet stratum', at);
        for (const [dx, dy, dz] of TOUCH) {
          const near = cell(x + dx, y + dy, z + dz);
          if (near === E.WATER || (id === E.SULFUR && (near === E.COAL || near === E.FIRE))) fault('dry mineral reaction contact', at);
        }
      }
      if (id === E.TUNGSTEN_ORE) {
        if (y > P.sea + 2) fault('shallow tungsten', at);
        if (FACES.some(([dx, dy, dz]) => cell(x + dx, y + dy, z + dz) === E.WATER)) count(features, 'flooded tungsten');
      }
      if (id === E.CRYSTAL && y >= P.sea + 2 && y <= P.sea + CAVE.BELL_RISE && T.caveRegion(x, z) === CAVE.KARST
        && !T.caveLakeClear(x, z) && T.caveAirBell(x, y, z, E.LIMESTONE) === E.CRYSTAL) {
        const [ground, , , water] = T.column(x, z);
        if (T.islandRock(x, y, z, ground) === E.LIMESTONE && T.caveOrdinary(x, y, z, ground, water, E.LIMESTONE) === E.LIMESTONE)
          count(features, 'air bell crystal');
      }
      if ((id === E.IRON_ORE || id === E.COPPER_ORE) && FACES.some(([dx, dy, dz]) =>
        y + dy >= T.genTop(x + dx, z + dz) && cell(x + dx, y + dy, z + dz) === E.EMPTY)) count(features, `outcrop ${name(id)}`);
      if (id === E.URANIUM_ORE && (y > P.sea + 6 || top - y < 16)) fault('shallow uranium', at);
      if (id === E.FUNGUS && y <= P.sea + 16 && T.caveRegion(x, z) === CAVE.GROTTO) count(features, 'grotto fungus');
      if (id === E.EMBER && bare === E.COAL) count(features, 'gallery ember');
      if ((id === E.ROCK_SALT || id === E.SULFUR) && T.caveRegion(x, z) === CAVE.VAULT
        && FACES.some(([dx, dy, dz]) => y + dy < T.genTop(x + dx, z + dz) && cell(x + dx, y + dy, z + dz) === E.EMPTY)) count(features, `vault ${name(id)}`);
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
              if (k2 >> 1 !== i >> 1 && ELEMENTS[cell(cx + ex, cy + ey, cz + ez)]?.mossBed) fault('air by damp moss and bare rock', [cx, cy, cz]);
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
// The standard sample is a coverage fixture, not permission to suppress a
// feature everywhere. Arbitrary boxes and small Islets need not contain all
// rare sites; they must still pass all isolation checks.
if (!islet && si < 0 && box.join(',') === '384,384,256,256') {
  for (const [id, n] of Object.entries(census)) if (!n) fault(`standard sample missing ${id}`, box);
  for (const k of ['geodes', 'geode pools', 'OIL pockets', 'PROPANE pockets', 'grotto fungus', 'vault ROCK_SALT',
    'vault SULFUR', 'gallery ember', 'air bell air', 'air bell crystal', 'flooded tungsten', 'outcrop IRON_ORE', 'outcrop COPPER_ORE'])
    if (!features[k]) fault(`standard sample missing ${k}`, box);
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
function spotFor(id, view, lookOk = () => true, cave = true) {
  const tries = [...blocks].filter(([k]) => k.startsWith(`${id}:`)).sort((a, b) => b[1] - a[1]).slice(0, SPOT_TRIES);
  let first = null;
  for (const best of tries) {
    const s = spotIn(id, best, view, lookOk, cave);
    first ??= s;
    if (s.feet) return s;
  }
  return first;
}
function spotIn(id, best, view, lookOk, cave) {
  const [bx, by, bz] = best[0].split(':')[1].split(',').map(Number);
  const mid = [bx, by, bz].map((v) => v * BLOCK + BLOCK / 2);
  let look = null;
  for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) for (let z = bz * BLOCK; z < (bz + 1) * BLOCK; z++) for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
    if (cell(x, y, z) !== id || !lookOk(x, y, z) || !FACES.some(([dx, dy, dz]) => cell(x + dx, y + dy, z + dz) === E.EMPTY)) continue;
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
      if (cave && fy + HEADROOM >= T.genTop(fx, fz)) continue;   // in a cave: under its column's ground
      if (!clear || !sight([fx + 0.5, fy + EYE, fz + 0.5], [lx + 0.5, ly + 0.5, lz + 0.5])) continue;
      const score = Math.abs(r - view);
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
// in daylight: open air at its height within DAYLIGHT columns of an air cell beside it (a cave mouth)
const daylit = (x, y, z) => FACES.some(([dx, dy, dz]) => {
  if (cell(x + dx, y + dy, z + dz) !== E.EMPTY) return false;
  for (let j = -DAYLIGHT; j <= DAYLIGHT; j++) for (let i = -DAYLIGHT; i <= DAYLIGHT; i++) if (T.genTop(x + dx + i, z + dz + j) <= y + dy) return true;
  return false;
});
const wet = (x, y) => y <= P.sea + NATURE.WET_RISE;
const either = (a, b) => (a?.feet ? a : b);
const spots = {   // in daylight where there is a view of one (from a cave mouth, or outside it), else in a cave
  moss: either(spotFor(E.MOSS, MOSS_VIEW, (x, y, z) => wet(x, y) && daylit(x, y, z), false), spotFor(E.MOSS, MOSS_VIEW, wet)),   // damp moss: by the water
  fungus: spotFor(E.FUNGUS, FUNGUS_VIEW),
  gold: either(spotFor(E.GOLD, GOLD_VIEW, daylit, false), spotFor(E.GOLD, GOLD_VIEW)),
  nuggets: spotFor(E.NUGGETS, GOLD_VIEW),
};
writeFileSync(join(out, 'spots.json'), JSON.stringify(spots, null, 1));
console.log(JSON.stringify({ box, islet, seed: P.seed, secs: +secs.toFixed(0), census, inSight: seen, changes, features, postStructures, faults: bad, faultsAt: badAt, spots }, null, 1));
if (Object.keys(bad).length) process.exitCode = 1;
