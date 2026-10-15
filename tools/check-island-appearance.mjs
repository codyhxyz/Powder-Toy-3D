// CPU-only: physical golden IDs, explicit cover roles, damp and prepass wiring.
// Run: node tools/check-island-appearance.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { Appearance as A, materialId, materialAppearance, appearanceCtype, appearanceOf, physicalCtype } from '../src/appearance.js';
import { worldParams, islandTwin, islandCellAt, islandMaterialAt } from '../src/world/generator.js';
import { island, islandGLSL, islandPreFrag } from '../src/world/scenes/island.js';
import { gridLayout } from '../src/sim.js';

// Captured from the unlabelled generator at 15e18b1f7cee60edb6bc46f61eb5b5c8b3fc9ed7.
const fixtures = [
  [20261008, false, '81e236a0c07b014cc55f6fa258a277b8ce95cee2722d26f98fe878eb6091ef64'],
  [17, true, '604445467964e79b142460bc4f976497271c6454cf9811782e9b86307a55177b'],
];
let cells = 0, grass = 0, moss = 0;
for (const [seed, snow, golden] of fixtures) {
  const P = worldParams({ size: [128, 96, 128], seed, snow }), T = islandTwin(P);
  const hash = createHash('sha256');
  for (let z = 0; z < 128; z += 4) for (let x = 0; x < 128; x += 4) {
    const top = T.genTop(x, z);
    for (let y = 0; y <= Math.max(top, Math.ceil(T.column(x, z)[3])); y++) {
      const bare = T.islandCellBare(x, y, z), id = T.islandCell(x, y, z);
      const before = T.islandMaterialBare(x, y, z), word = T.islandMaterial(x, y, z);
      assert.equal(materialId(before), bare);
      assert.equal(materialId(word), id);
      assert.equal(islandCellAt(x, y, z, P), id);
      assert.equal(islandMaterialAt(x, y, z, P), word);
      hash.update(Uint8Array.of(bare, id));
      // PLANT is authored only by GEN_COVER_PLANT, never by cave nature.
      const expected = id === E.PLANT ? A.GRASS : A.NONE;
      assert.equal(materialAppearance(word), expected);
      assert.equal(materialAppearance(before), bare === E.PLANT ? A.GRASS : A.NONE);
      const damp = T.islandDamp(y, id), ctype = appearanceCtype(id, damp, materialAppearance(word));
      assert.equal(appearanceOf(id, ctype), expected);
      assert.equal(physicalCtype(id, ctype), damp);
      if (id === E.PLANT) grass++;
      if (id === E.MOSS) { moss++; assert.equal(ctype, damp); }
      cells++;
    }
  }
  assert.equal(hash.digest('hex'), golden, `physical geometry drift: seed=${seed}, snow=${snow}`);
  for (const id of [E.MOSS, E.FUNGUS]) for (let y = 0; y < 96; y++) {
    const damp = T.islandDamp(y, id);
    assert.equal(appearanceCtype(id, damp, A.NONE), damp);
    assert.equal(appearanceOf(id, damp), A.NONE);
  }
}
assert.ok(grass > 0 && moss > 0, 'fixtures must exercise grass and cave moss');
const scene = islandGLSL(), pre = islandPreFrag(gridLayout(32, 32, 32));
assert.match(scene, /structureMaterialCell\(w, islandMaterial\(w\.x, w\.y, w\.z\)\)/);
assert.match(scene, /appearanceCtype\(id, islandDamp\(w\.y, id\), materialAppearance\(word\)\)/);
assert.match(scene, /fn islandMaterialBareDirect\(/);
assert.match(scene, /fn islandMaterialBare\(/);
assert.match(scene, /fn islandCellBare\(/);
assert.match(pre, /bitcast<u32>\(islandMaterialBareDirect\(c\.x, c\.y, c\.z\)\)/);
assert.doesNotMatch(pre, /fn islandCellBareDirect\(/);
const trees = island.trees.glsl();
assert.match(trees, /fn islandMaterialBare\(/);
assert.doesNotMatch(trees, /fn islandMaterialBareDirect\(/);
console.log(`island appearance: ${cells} physical cells unchanged; ${grass} grass, ${moss} unlabelled cave moss; prepass/direct paths generated`);
