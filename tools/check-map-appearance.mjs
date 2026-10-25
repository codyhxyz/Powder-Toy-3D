// CPU-only role assertions on real producers, not only physical-ID goldens.
import assert from 'node:assert/strict';
import { E } from '../src/elements.js';
import { Appearance as A, appearanceOf, materialId, materialAppearance } from '../src/appearance.js';
import { pcg } from '../src/rng.js';
import { willowCove, willowCoveTwin, WILLOW_SIZE } from '../src/world/scenes/willowCove.js';
import { volcanoWorld, volcanoTwin, VOL } from '../src/world/scenes/volcanoWorld.js';
import { giantVolcano, giantTwin, GIANT, VOLC_SIZE } from '../src/world/scenes/giantVolcano.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { buildDamValley, ARENA_SIZE } from '../src/arenas/damValley.js';
import { buildPreset } from '../src/presets.js';

const seed = 20261008;
const town = willowCoveTwin(willowCove.params({ seed, size: WILLOW_SIZE }));
for (const kind of [1, 5]) {
  // These shells are rotated ninety degrees in the actual town layout.
  const shelf = town.cfTownShellMaterial(8, 26, -5, 24, 18, 10, kind, E.EMPTY);
  assert.equal(materialId(shelf), E.PLANKS);
  assert.equal(materialAppearance(shelf), A.PLANK_Z, 'hall/café shelf follows world Z');
}
let trees = 0;
for (const [scene, twin, cfg, prefix, stem, size] of [
  [volcanoWorld, volcanoTwin, VOL, 'VOL', 'vol', WORLD_SIZE],
  [giantVolcano, giantTwin, GIANT, 'GV', 'gv', VOLC_SIZE],
]) {
  const P = scene.params({ seed, size }), T = twin(P);
  const salt = Number(scene.glsl().match(new RegExp(`const ${prefix}_SALT_TREE: u32 = (\\d+)u;`))[1]);
  let found = false;
  for (let cz = 0; cz < 64 && !found; cz++) for (let cx = 0; cx < 64 && !found; cx++) {
    const h = pcg((cx + pcg((cz + pcg((seed + salt) >>> 0)) >>> 0)) >>> 0);
    const span = cfg.TREE_CELL - 2 * cfg.TREE_MARGIN;
    const x = cx * cfg.TREE_CELL + cfg.TREE_MARGIN + pcg((h + cfg.K_X) >>> 0) % span;
    const z = cz * cfg.TREE_CELL + cfg.TREE_MARGIN + pcg((h + cfg.K_Z) >>> 0) % span;
    const base = stem === 'vol' ? T.volTop(T.volColumn(x, z)) : T.gvTop(x, z);
    const trunk = T[`${stem}TreePartMaterial`](x, base, z, cx, cz);
    if (materialId(trunk) !== E.WOOD) continue;
    assert.equal(materialAppearance(trunk), A.LOG_Y);
    let leaf = false;
    for (let y = base; y < base + cfg.TREE_REACH; y++) {
      const word = T[`${stem}TreePartMaterial`](x + 2, y, z, cx, cz);
      if (materialId(word) === E.PLANT) { assert.equal(materialAppearance(word), A.LEAVES); leaf = true; break; }
    }
    assert(leaf, `${stem}: actual crown must carry leaves`);
    trees++; found = true;
  }
  assert(found, `${stem}: exercise a real permitted tree, not an empty branch`);
}
const arena = buildDamValley();
const counts = new Set(arena.appearances);
for (const role of [A.GRASS, A.LEAVES, A.LOG_Y, A.PLANK_X]) assert(counts.has(role), `Dam Valley role ${role}`);
const [nx, ny, nz] = ARENA_SIZE;
let loaded;
buildPreset('damValley', {
  g: { nx, ny, nz },
  blankState: () => [new Float32Array(nx * ny * nz * 4), new Float32Array(nx * ny * nz * 4)],
  cellTexel: (x, y, z) => (y * nz + z) * nx + x,
  load: a => { loaded = a; },
});
for (let i = 0; i < arena.ids.length; i++) {
  assert.equal(loaded[i * 4], arena.ids[i]);
  assert.equal(appearanceOf(loaded[i * 4], loaded[i * 4 + 3]), arena.appearances[i], `preset cell ${i}`);
}
console.log(`map appearance: rotated shelves, ${trees} real volcano trees, all ${arena.ids.length} Dam Valley/preset cells OK`);
