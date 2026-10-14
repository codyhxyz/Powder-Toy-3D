// Native scene provenance only: CPU twins and generated WGSL, no GPU/server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { E } from '../src/elements.js';
import { FOLIAGE_CTYPE } from '../src/foliage.js';
import { volcanoWorld, volcanoTwin, VOL } from '../src/world/scenes/volcanoWorld.js';
import { giantVolcano, giantTwin, GIANT } from '../src/world/scenes/giantVolcano.js';
import { willowCove, willowCoveTwin } from '../src/world/scenes/willowCove.js';
import { DESCENT_SCENES, descentTwin, descentConstants } from '../src/world/scenes/descent/scenes.js';

assert.equal(FOLIAGE_CTYPE, E.PLANT);
const source = file => readFileSync(new URL(`../src/world/scenes/${file}`, import.meta.url), 'utf8');
const shared = text => text.match(/const SRC = \/\* glsl \*\/ `([\s\S]*?)`;/)[1];
const fingerprint = values => createHash('sha256').update(Uint8Array.from(values)).digest('hex');
const fingerprints = [];

// These two scenes intentionally have no grass. Guard the sole-PLANT-source
// invariant behind the cheap sceneCell id test: future ground plants must not
// silently inherit the tree provenance tag.
for (const [scene, twin, C, prefix, file] of [
  [volcanoWorld, volcanoTwin, VOL, 'vol', 'volcanoWorld.js'],
  [giantVolcano, giantTwin, GIANT, 'gv', 'giantVolcano.js'],
]) {
  const src = shared(source(file));
  const treesStart = src.indexOf(`int ${prefix}TreePart(`);
  const treesEnd = src.indexOf(`int ${prefix}CellIn(`);
  assert.ok(treesStart >= 0 && treesEnd > treesStart);
  assert.ok(!`${src.slice(0, treesStart)}${src.slice(treesEnd)}`.includes('E_PLANT'), 'only tree functions produce PLANT');
  const wgsl = scene.glsl(); // exercises the GLSL-subset -> WGSL compiler on CPU
  assert.match(wgsl, /if \(id == E_PLANT\) \{ ctype = f32\(E_PLANT\); \}/);
  assert.match(wgsl, /vec4f\(f32\(id\), T, SPAWNLIFE\(id\), ctype \+ seed\)/);
  for (const seed of [0, 20261008, 0xffffffff]) {
    const T = twin(scene.params({ size: scene.size ?? [1024, 128, 1024], seed }));
    const ids = [];
    let leaves = 0, trunks = 0;
    for (let z = 13; z < 1024; z += 17) for (let x = 17; x < 1024; x += 17) {
      const col = prefix === 'vol' ? T.volColumn(x, z) : T.gvTop(x, z);
      const top = prefix === 'vol' ? T.volTop(col) : col;
      for (const y of [0, top - 1, top, top + 1, top + 5, top + 10, top + 15, top + C.TREE_REACH, C.SKY]) {
        const id = T[`${prefix}CellIn`](x, y, z, col);
        ids.push(id);
        if (id === E.PLANT) {
          leaves++;
          assert.ok(y >= top && y >= C.SEA && y < C.SKY);
          assert.equal(T[`${prefix}Tree`](x, y, z, top), E.PLANT);
        }
        if (id === E.WOOD) trunks++;
      }
    }
    assert.ok(leaves > 0 && trunks > 0, `${scene.key}/${seed}: samples cover crowns (${leaves}) and trunks (${trunks})`);
    fingerprints.push(`${scene.key}/${seed} ${fingerprint(ids)}`);
    console.log(`PASS ${scene.key}/${seed}: ${ids.length} IDs, ${leaves} crown cells, ${trunks} trunk cells`);
  }
}

for (const seed of [0, 20261008, 0xffffffff]) {
  const T = willowCoveTwin(willowCove.params({ size: [1024, 128, 1024], seed }));
  const ids = [];
  let leaves = 0, grass = 0, trunks = 0;
  for (let z = -176; z <= 176; z += 4) for (let x = -176; x <= 176; x += 4) {
    const h = T.wcHeight(x, z);
    for (const y of [0, h - 1, h, h + 6, h + 12, h + 14, h + 21, 80]) {
      const id = T.wcCell(x + 512, y, z + 512);
      const tag = T.wcFoliage(x + 512, y, z + 512, id);
      ids.push(id);
      const crown = id === E.PLANT && y >= h && T.wcTree(x, y, z) === E.PLANT;
      assert.equal(tag, crown ? FOLIAGE_CTYPE : 0);
      if (tag) leaves++;
      if (id === E.PLANT && y < h) { grass++; assert.equal(tag, 0); }
      if (id === E.WOOD) { trunks++; assert.equal(tag, 0); }
    }
  }
  assert.ok(leaves > 0 && grass > 0 && trunks > 0);
  fingerprints.push(`willowCove/${seed} ${fingerprint(ids)}`);
  console.log(`PASS willowCove/${seed}: ${ids.length} IDs, ${leaves} crowns, ${grass} grass, ${trunks} wood`);
}

for (let level = 0; level < 3; level++) {
  const T = descentTwin(level), C = descentConstants(level), ids = [];
  let leaves = 0, grass = 0, trunks = 0;
  for (let z = 4; z < 512; z += 8) for (let x = 4; x < 512; x += 8) {
    const top = level === 0 ? T.dsTop(x, z) : T.dsRoof(x, z);
    for (const y of [0, C.BAND_TOP - 1, C.BIOME_Y0 + 2, top - 1, top, top + 5, top + 10, top + 12, top + 16]) {
      const id = T.dsCell(x, y, z), tag = T.dsFoliage(x, y, z, id);
      ids.push(id);
      if (tag) {
        leaves++;
        assert.equal(level, 0);
        assert.equal(id, E.PLANT);
        assert.equal(T.dsTree(x, y, z), E.PLANT);
        assert.ok(y >= T.dsTop(x, z));
      }
      if (level === 0 && id === E.PLANT && y === top) { grass++; assert.equal(tag, 0); }
      if (id === E.WOOD) { trunks++; assert.equal(tag, 0); }
      if (id !== E.PLANT || level !== 0 || y < C.SURF_LO) assert.equal(tag, 0);
      if (level === 0 && id === E.PLANT && y > top) assert.equal(tag, FOLIAGE_CTYPE);
    }
  }
  if (level === 0) assert.ok(leaves > 0 && grass > 0 && trunks > 0);
  else assert.equal(leaves, 0);
  fingerprints.push(`descent/${level} ${fingerprint(ids)}`);
  console.log(`PASS descent/${level}: ${ids.length} IDs, ${leaves} crowns, ${grass} grass, ${trunks} wood`);
}

// Only integer ctype is added to A.w: id/temp/life and the original seed
// expression are untouched. These constructors have no JS state twin.
for (const [scene, file, prefix, helper] of [
  [willowCove, 'willowCove.js', 'WC', 'wcFoliage'],
  ...DESCENT_SCENES.map(scene => [scene, 'descent/scenes.js', 'DS', 'dsFoliage']),
]) {
  const wgsl = scene.glsl();
  assert.match(wgsl, new RegExp(`let ctype = f32\\(${helper}\\(w.x, w.y, w.z, id\\)\\);`));
  assert.match(wgsl, /vec4f\(f32\(id\), (?:T|SPAWNT\(id\)), SPAWNLIFE\(id\), ctype \+ seed\)/);
  assert.ok(source(file).includes(`seedWorld(w, SU.uSceneSeed, ${prefix}_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX`));
}
// Pre-tag ID baselines: the original geometry functions were audited byte-for-
// byte unchanged before recording these sampled world/seed fingerprints.
assert.deepEqual(fingerprints, [
  'volcanoWorld/0 1bfb127235ef095bce19330421f311c71929129b3360c6deb9eaf9a2617a0561',
  'volcanoWorld/20261008 9bfc84e994eeba6f415003cda9a37aecc96274fd4e670763d479e20e41efe2cf',
  'volcanoWorld/4294967295 49201df80a6f3fdaa4bbf0acbe1daa610084c0c56b78c30b5ce9f807a31dea27',
  'giantVolcano/0 40a021643e7797dbd395fbaf9b3c77958d0179810d18569c8205405cbd696838',
  'giantVolcano/20261008 1b31e491a2f8ab0c9b9e96e41762cfed7823547b5c63130a569b4f10f5a2d43e',
  'giantVolcano/4294967295 2200d23daed7c5c4102d94ac4b5221c5e77de2dcb7a02db116ab2bbd612ee87d',
  'willowCove/0 fd1eb47242cec26bc9a719de01e47a2faeee7c1bb398d5e6c239008a70c71b0e',
  'willowCove/20261008 fd1eb47242cec26bc9a719de01e47a2faeee7c1bb398d5e6c239008a70c71b0e',
  'willowCove/4294967295 fd1eb47242cec26bc9a719de01e47a2faeee7c1bb398d5e6c239008a70c71b0e',
  'descent/0 0e80ec5550014d0445a9ee0ad2947648106eb5e48c01d1750ef76758711fcbd6',
  'descent/1 49cabff4c5e440a108e13aa19cf4eca73b7dc8b6288be925f34574afea0f9c4a',
  'descent/2 66c63a92cf61657843e10e4379f933b2f60fb55e2890db3a826bb963baad2923',
]);
console.log('PASS native scene provenance CPU checks and 12 baseline ID fingerprints (WGSL generation only; no GPU execution)');
