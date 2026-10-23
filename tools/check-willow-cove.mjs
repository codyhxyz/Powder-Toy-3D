// CPU-only scene geometry and Sandbox registration checks; no GPU. The
// scene's WGSL itself is checked by tools/check-wgsl.mjs (world/gpu.js and
// shaders/far.js WGSL_CHECK), its cells against this twin by
// tools/willow-cove-check.mjs.
// Run: node tools/check-willow-cove.mjs
import assert from 'node:assert/strict';
import { SMALL_MAP, BIG_MAP } from '../src/mapKind.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { E, ELEMENTS, K } from '../src/elements.js';
import { mapByKey, mapsFor, mapOf, GAMEMODES, DEFAULT_MAP, MOBILE_MAP } from '../src/maps.js';
import { sceneByKey } from '../src/world/scenes/index.js';
import { willowCove as scene, willowCoveTwin, WILLOW_COVE as C, WILLOW_LANDMARKS as M } from '../src/world/scenes/willowCove.js';
import { CELL_M } from '../src/scale.js';
import { farLayout, WORLD_SIZE } from '../src/shaders/farShared.js';
import { prepareSave } from '../src/wire/saves.js';

const size = scene.size;
assert.deepEqual(size, [3072, 128, 1024]);
assert.deepEqual(WORLD_SIZE, [1024, 128, 1024], 'other maps keep their existing size');
assert.deepEqual(farLayout(size).bricks.n, [768, 32, 256], 'the wider world fits the existing far-field layout');
const P = scene.params({ size, seed: 20261008 });
const T = willowCoveTwin(P);
const world = (x, z) => [x + size[0] / 2, z + size[2] / 2];
const cell = (x, y, z) => T.wcCell(x + size[0] / 2, y, z + size[2] / 2);
assert.equal(scene.key, 'willowCove');
assert.equal(scene.label, 'Tinker Creek');
assert.equal(scene.shrine, false);
const map = mapByKey(scene.key);
assert.equal(map?.scene, scene.key);
assert.equal(map.size, 'world');
assert.deepEqual(map.dims, size);
assert.equal(sceneByKey(scene.key), scene);
assert(mapsFor('sandbox').includes(map));
assert(mapsFor('animalCrossing').includes(map));
for (const mode of GAMEMODES.filter(m => !['sandbox', 'animalCrossing'].includes(m.key))) assert(!mapsFor(mode.key).includes(map));
assert.equal(mapOf({ size: 'world', scene: scene.key }), map);
assert.equal(DEFAULT_MAP, 'island');
assert.equal(MOBILE_MAP, 'island');
assert.deepEqual(P, { size, seed: 20261008, sea: C.SEA, floor: C.FLOOR });
assert.deepEqual(scene.start(P), world(...M.plaza));
assert(scene.view.dir[1] > 0 && scene.view.dist > 0);
// the scene's WGSL (docs/webgpu.md G1): the subset through toWgsl, then a sceneCell at
// spawn temperature and life, at rest, its seed correctly rounded (H1.28)
const wgsl = scene.glsl();
assert.match(wgsl, /fn sceneCell\(w: vec3i\) -> SceneCell \{/);
assert.match(wgsl, /SceneCell\(vec4f\(f32\(id\), SPAWNT\(id\), SPAWNLIFE\(id\), appearanceCtype\(id, 0\.0, materialAppearance\(word\)\) \+ seed\), vec4f\(0\.0\)\)/);
assert.match(wgsl, /u32ToF32\(seedWorld\(w, SU\.uSceneSeed, WC_SALT_CELL\)\)/);
assert.match(wgsl, /fn wcCell\(wx: i32, y: i32, wz: i32\) -> i32 \{/);
assert.match(wgsl, /wx >= SU\.uWillowWorldX/);
assert.doesNotMatch(wgsl, /\b(?:void|ivec[234]|vec[234]\(|uniform\s+int|out\s+vec4)\b|#define/, 'no GLSL left in the scene\'s WGSL');
assert.deepEqual(Object.keys(scene.uniforms(P)), ['uSceneSeed', 'uWillowWorldX', 'uWillowWorldY', 'uWillowWorldZ']);
assert.deepEqual(Object.keys(scene.uniformStruct.sceneTypes), Object.keys(scene.uniforms(P)), 'every uniform in the struct');

// Cache the village core, including its north/south shore and dock.
// The long running circuit and distant shore are checked separately below.
const extent = 200, width = extent * 2 + 1, height = C.SKY;
const ids = new Uint16Array(width * width * height);
const legacy = willowCoveTwin(scene.params({ size: scene.legacySize, seed: P.seed }));
const legacyIds = new Uint16Array(ids.length);
const index = (x, y, z) => ((z + extent) * width + x + extent) * height + y;
const counts = new Map();
for (let z = -extent; z <= extent; z++) {
  for (let x = -extent; x <= extent; x++) {
    for (let y = 0; y < height; y++) {
      const id = cell(x, y, z);
      assert(Number.isInteger(id) && ELEMENTS[id], `invalid cell ${x},${y},${z}: ${id}`);
      ids[index(x, y, z)] = id;
      legacyIds[index(x, y, z)] = legacy.wcCell(x + 512, y, z + 512);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
}
// Golden geometry from production b81b9063, before the expansion: old saves
// retain every authored cell, rather than silently changing their generator.
assert.equal(createHash('sha256').update(new Uint8Array(legacyIds.buffer)).digest('hex'),
  '1fbc36d0ba57628e816eba5c47336d988293c0d93fd5c8c0ea01ea122303bce2');

// Load the real save preparation path, retaining old coordinates/store keys.
// Switching back to a new map must rebuild the larger world.
{
  const builds = [];
  const makeWorld = dims => ({ size: dims, whenReady: async () => {} });
  const app = {
    settings: { size: 'world', scene: scene.key }, win: makeWorld(size), mapKind: BIG_MAP, worldSeed: P.seed,
    mp: { guard: () => false, guardWorld: () => false }, pov: { exit() {} },
    WORLDS: { world: { size: WORLD_SIZE } }, sceneByKey,
    setSize(key, savedSize) { builds.push(savedSize); this.win = makeWorld(savedSize ?? scene.size); },
  };
  const h = { size: 'world', world: { scene: scene.key, seed: P.seed, size: [...scene.legacySize], origin: [448, 0, 448] } };
  const unchanged = structuredClone(h);
  assert.equal(await prepareSave(app, h), true);
  assert.deepEqual(app.win.size, scene.legacySize);
  assert.deepEqual(builds, [scene.legacySize]);
  assert.deepEqual(h, unchanged, 'saved origin, seed and dimensions are not migrated or discarded');
  assert.equal(await prepareSave(app, h), true);
  assert.equal(builds.length, 1, 'reloading the same legacy world does not rebuild');
  const fresh = { size: 'world', world: { ...h.world, size: [...size] } };
  assert.equal(await prepareSave(app, fresh), true);
  assert.deepEqual(app.win.size, size);
  assert.deepEqual(builds, [scene.legacySize, null]);
  await assert.rejects(prepareSave(app, { size: 'world', world: { ...h.world, size: [1024, 256, 1024] } }), /different size/);
  assert.equal(builds.length, 2, 'unknown save dimensions refused before rebuilding');
}
// Exercise the production co-op grid acceptance function without booting a
// renderer: guests must accept a host's restored legacy world, too.
{
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function setGrid('), source.indexOf('// The cells of size'));
  const ctx = {
    replicaMap: null, win: null, mapKind: SMALL_MAP, sim: { g: { nx: 128, ny: 128, nz: 128 } },
    SIZES: {}, WORLDS: { world: { size: WORLD_SIZE } }, sceneByKey,
    worldOf: (w, s) => ({ ...w, size: s.size ?? w.size }),
    settings: {}, presentation: { select() {} }, build() {}, gridFits: () => true,
  };
  const setGrid = runInNewContext(`${fn}; setGrid`, ctx);
  const meta = { id: 'legacy-tinker', mode: 'world', scene: scene.key, size: scene.legacySize, seed: P.seed };
  assert.equal(setGrid([128, 128, 128], meta), true);
  assert.deepEqual([...ctx.replicaMap.size], scene.legacySize);
  assert.equal(setGrid([128, 128, 128], { ...meta, id: 'new-tinker', size }), true);
  assert.equal(setGrid([128, 128, 128], { ...meta, id: 'invalid', size: [2048, 128, 1024] }), false);
  assert.equal(setGrid([128, 64, 128], { ...meta, id: 'wrong-height' }), false);
  ctx.gridFits = () => false;
  assert.equal(setGrid([128, 128, 128], { ...meta, id: 'device-refused' }), false);
}
const at = (x, y, z) => x >= -extent && x <= extent && z >= -extent && z <= extent && y >= 0 && y < height
  ? ids[index(x, y, z)] : cell(x, y, z);
const solid = (id) => ELEMENTS[id].kind === K.SOLID;
const drySupport = (id) => solid(id) || id === E.SAND;
for (const id of [E.ROCK, E.WATER, E.SAND, E.PLANT, E.WOOD, E.BRICK, E.GLASS]) assert(counts.get(id) > 0);
assert(!counts.has(E.CLONE), 'the finite pond must not silently acquire an untyped source');

// Deterministic samples, fixed topology across seeds, world and slab edges.
const edges = [-1, 0, 1, 127, 128, 255, 256, 335, 336, 511, 512, 687, 688, 895, 896, 1023, 1024, 1535, 1536, 2047, 2048, 3071, 3072];
for (const seed of [0, 1, P.seed, 0xffffffff]) {
  const params = scene.params({ size, seed });
  const twin = willowCoveTwin(params);
  assert.deepEqual(scene.start(params), scene.start(P));
  for (const x of edges) for (const z of edges) for (const y of [-1, 0, 3, 15, 23, 35, 47, 79, 127, 128]) {
    const id = twin.wcCell(x, y, z);
    assert(Number.isInteger(id) && ELEMENTS[id]);
    assert.equal(id, T.wcCell(x, y, z), `seed changed topology at ${x},${y},${z}`);
    if (x < 0 || z < 0 || y < 0 || x >= size[0] || z >= size[2] || y >= size[1]) assert.equal(id, E.EMPTY);
  }
  for (let i = 0; i < 20000; i++) {
    const x = (i * 97) % width - extent, z = (i * 193 + Math.floor(i / width)) % width - extent, y = (i * 31) % height;
    assert.equal(twin.wcCell(...[x + size[0] / 2, y, z + size[2] / 2]), at(x, y, z));
  }
}

// Independent downward scan: ground() includes roofs, foliage and water.
function scan(x, z) {
  for (let y = size[1] - 1; y >= 0; y--) if (at(x, y, z) !== E.EMPTY) return y + 1;
  return 0;
}
for (let z = -extent; z <= extent; z += 11) for (let x = -extent; x <= extent; x += 11) {
  assert.equal(scene.ground(...world(x, z), P), scan(x, z));
  assert.equal(scene.ground(...world(x + 0.75, z + 0.25), P), scan(x, z));
}
for (const [x, z, h] of [[-20, -20, C.LOW], [-20, -80, C.MID], [-20, -120, C.HIGH]]) {
  assert.equal(scan(x, z), h, 'distinct northern terrace');
  assert(solid(at(x, h - 1, z)));
}

// Spawn has a full body footprint, ample headroom and no roof above it.
const [sx, sz] = M.plaza;
for (let x = sx - 3; x < sx + 3; x++) for (let z = sz - 3; z < sz + 3; z++) {
  assert.equal(at(x, C.LOW - 1, z), E.BRICK);
  for (let y = C.LOW; y < C.LOW + 20; y++) assert.equal(at(x, y, z), E.EMPTY);
}

// River bed is connected from the upper pond to the south ocean, with solid
// side banks even at the falling sheets. Decks are above, not in, the water.
for (let z = C.POND_Z; z <= C.RADIUS; z++) {
  let bottom = -1;
  for (let y = C.FLOOR; y < C.HIGH; y++) if (at(C.RIVER_X, y, z) === E.WATER) { bottom = y; break; }
  assert(bottom > C.FLOOR, `river gap at ${z}`);
  assert.equal(at(C.RIVER_X, bottom - 1, z), E.ROCK, `river bed at ${z}`);
  if (z < C.RADIUS) assert([bottom - 1, bottom, bottom + 1].some((y) => at(C.RIVER_X, y, z + 1) === E.WATER), `disconnected river at ${z}`);
  if (z > C.POND_Z + C.POND_RADIUS && z < C.SHORE) {
    const surface = z < C.HIGH_Z ? C.HIGH - C.FREEBOARD : z < C.MID_Z ? C.MID - C.FREEBOARD : z < C.MOUTH_Z ? C.LOW - C.FREEBOARD : C.SEA;
    for (const sign of [-1, 1]) assert(solid(at(C.RIVER_X + sign * C.RIVER_HALF, surface - 1, z)), `bank gap at ${z}`);
  }
}
for (const [z, top] of [[C.HIGH_Z, C.HIGH], [C.MID_Z, C.MID]]) {
  for (let y = top - C.TERRACE_STEP - C.FREEBOARD; y < top - C.FREEBOARD; y++) assert.equal(at(C.RIVER_X, y, z), E.WATER);
  assert.equal(at(C.RIVER_X + C.RIVER_HALF, top - C.FREEBOARD - 1, z), E.ROCK);
}
assert.equal(at(...[C.RIVER_X, C.SEA - 1, C.RADIUS + 1]), E.WATER);

for (const [x, z] of M.cottages) {
  for (let dx = -C.DOOR_HALF; dx < C.DOOR_HALF; dx++) {
    for (let dz = -C.HOUSE_HALF; dz < -C.HOUSE_HALF + C.WALL_THICK; dz++) {
      for (let y = C.LOW; y < C.LOW + C.DOOR_H; y++) assert.equal(at(x + dx, y, z + dz), E.EMPTY, '8x11 doorway');
    }
  }
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
    assert.equal(at(x + dx, C.LOW - 1, z + dz), E.BRICK);
    for (let y = C.LOW; y < C.LOW + C.DOOR_H; y++) assert.equal(at(x + dx, y, z + dz), E.EMPTY, 'hollow cottage');
  }
  assert.equal(at(x - C.HOUSE_HALF, C.LOW, z), E.WOOD);
  assert.equal(at(x - C.HOUSE_HALF, C.LOW + C.WINDOW_LO, z), E.GLASS);
  assert.equal(at(x, C.LOW + C.WALL_H + C.ROOF_H - 1, z), E.BRICK);
}
for (const [x, z] of M.bridges) {
  const h = z < C.MID_Z ? C.MID : C.LOW;
  for (let y = h - C.FREEBOARD; y < h - C.DECK_THICK; y++) assert.equal(at(x, y, z), E.EMPTY, 'clearance over water');
  for (let y = h - C.DECK_THICK; y < h; y++) assert.equal(at(x, y, z), E.WOOD);
  for (const side of [-1, 1]) {
    const px = x + side * C.BRIDGE_PILE_X, pz = z + C.PATH_HALF - 2;
    for (let y = C.SEA; y < h; y++) assert.equal(at(px, y, pz), E.WOOD, 'continuous bridge pile');
    assert(solid(at(px, C.SEA - 1, pz)), 'anchored bridge pile');
  }
}
for (const z of [C.DOCK_PILE_Z, C.DOCK_PILE_Z + C.DOCK_PITCH]) {
  const x = C.PATH_X + C.DOCK_HALF - 2;
  for (let y = C.FLOOR; y < C.BEACH; y++) assert.equal(at(x, y, z), E.WOOD, 'dock pile reaches seabed');
  assert.equal(at(x, C.FLOOR - 1, z), E.ROCK);
}

// Find the first standable floor independently of the layout height function.
function walkTop(x, z) {
  for (let h = C.FLOOR; h < height - C.DOOR_H; h++) {
    if (!drySupport(at(x, h - 1, z))) continue;
    let clear = true;
    for (let y = h; y < h + C.DOOR_H; y++) if (at(x, y, z) !== E.EMPTY) { clear = false; break; }
    if (clear) return h;
  }
  assert.fail(`no walkable floor at ${x},${z}`);
}
let walked = 0;
function route(points) {
  let previous;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    assert(ax === bx || az === bz);
    const length = Math.abs(bx - ax) + Math.abs(bz - az);
    for (let n = 0; n <= length; n++) {
      const x = ax + Math.sign(bx - ax) * n, z = az + Math.sign(bz - az) * n;
      const h = walkTop(x, z);
      if (previous !== undefined) assert(Math.abs(h - previous) <= 1, `non-unit step at ${x},${z}: ${previous} -> ${h}`);
      previous = h;
      const floors = [];
      for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) floors.push(walkTop(x + dx, z + dz));
      assert(Math.max(...floors) - Math.min(...floors) <= 5, `body straddles cliff at ${x},${z}`);
      const head = Math.max(...floors);
      for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) {
        for (let y = head; y < head + C.DOOR_H; y++) assert.equal(at(x + dx, y, z + dz), E.EMPTY, `body clearance at ${x},${z}`);
      }
      walked++;
    }
  }
}
route([M.plaza, [C.PATH_X, C.PLAZA_Z], [C.PATH_X, C.PATH_NORTH], M.pondLookout]);
route([[C.PATH_X, C.MID_PATH_Z], [C.MID_PATH_EAST, C.MID_PATH_Z]]);
route([[C.PATH_X, C.LANE_Z], [C.LANE_EAST, C.LANE_Z]]);
route([[C.PATH_X, 0], M.orchard]);
route([[C.PATH_X, C.LANE_Z], M.dock]);
for (const [x, z] of M.cottages) route([[C.PATH_X, C.LANE_Z], [x, C.LANE_Z], [x, z]]);

// More than four times the ORIGINAL island's full diameter, not just its
// short village lane. Check every cell and the full body width around the lap.
const originalDiameter = 176 * 2;
const straight = C.RUN_HALF * 2;
assert(straight > originalDiameter * 4, 'over 4x the former maximum straight-line sprint distance');
const beforeLoop = walked;
route(M.runningLoop);
for (let x = -C.RUN_HALF; x <= C.RUN_HALF; x++) {
  assert.equal(walkTop(x, C.LANE_Z), C.LOW, 'flat outward straight');
  assert.equal(walkTop(x, C.RUN_RETURN_Z), C.LOW, 'flat return straight');
}
// Dry, body-clear access from home and plaza to the circuit.
route([M.plaza, [C.PATH_X, C.PLAZA_Z], [C.PATH_X, C.LANE_Z], M.runningLoop[0]]);
const lap = M.runningLoop.slice(1).reduce((n, [x, z], i) =>
  n + Math.abs(x - M.runningLoop[i][0]) + Math.abs(z - M.runningLoop[i][1]), 0);
assert.equal(lap, 3808);
assert.equal(M.runningLoop[0][0], M.runningLoop.at(-1)[0]);
assert.equal(M.runningLoop[0][1], M.runningLoop.at(-1)[1]);
console.log(`Running circuit OK: ${(straight * CELL_M).toFixed(0)} m straight (${(straight / originalDiameter).toFixed(2)}x old island); ${(lap * CELL_M).toFixed(1)} m closed lap; ${walked - beforeLoop} body-width route samples.`);

// Stability: exhaustive surface/material audit, including every beach grain
// and tree leaf. Water is intentionally allowed to move at the finite falls.
const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
for (let z = -extent + 1; z < extent; z++) for (let x = -extent + 1; x < extent; x++) {
  for (let y = C.FLOOR; y < height - 1; y++) {
    const id = at(x, y, z);
    if (id === E.SAND) {
      assert(solid(at(x, y - 1, z)), `unsupported sand at ${x},${y},${z}`);
      const open = (v) => v === E.EMPTY || v === E.WATER;
      for (const [dx, dz] of sides) assert(!(open(at(x + dx, y, z + dz)) && open(at(x + dx, y - 1, z + dz))), `toppling sand at ${x},${y},${z}`);
    }
    if (id === E.PLANT) {
      for (const [dx, dz] of sides) assert.notEqual(at(x + dx, y, z + dz), E.WATER, `plant touching water at ${x},${y},${z}`);
      assert.notEqual(at(x, y - 1, z), E.WATER);
      assert.notEqual(at(x, y + 1, z), E.WATER);
    }
  }
}
// Sample the new east/west shore at every z and every stretched terrain
// column, including the material transition and the rock-backed sand lip.
for (let z = -C.RADIUS - 1; z <= C.RADIUS + 1; z++) {
  for (let x = -C.RADIUS * C.LAND_STRETCH_X - 7; x <= C.RADIUS * C.LAND_STRETCH_X + 7; x += C.LAND_STRETCH_X) {
    if (Math.abs(x) < extent) continue;
    const h = T.wcHeight(x, z);
    const id = at(x, h - 1, z);
    if (id === E.SAND) {
      assert(solid(at(x, h - 2, z)), 'new beach has a solid foundation');
      for (const [dx, dz] of sides) assert(drySupport(at(x + dx, h - 2, z + dz)), 'new beach cannot topple');
    }
    if (id === E.PLANT) {
      for (const [dx, dz] of sides) assert.notEqual(at(x + dx, h - 1, z + dz), E.WATER, 'new grass does not touch water');
    }
  }
}
console.log(`Tinker Creek OK: ${ids.length.toLocaleString('en-US')} valid authored cells; 4 seeds; ${walked} body-width route samples; terraces, finite river, cottages, bridges, shore stability and independent ground scans.`);
