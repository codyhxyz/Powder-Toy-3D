// CPU-only source/render checks, not the menu catalogue coverage test.
// node --test tools/imported-map-thumbs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { E } from '../src/elements.js';
import { loadScene, renderImported, VIEWS } from './imported-map-thumbs.mjs';

for (const [id, view] of Object.entries(VIEWS)) {
  test(`${id}: shipped sparse cells, deterministic render and detailed 400px WebP`, () => {
    const scene = loadScene(id), map = scene.importManifest;
    assert.equal(scene.key, `${id}Local`);
    const { words } = scene.data();
    const directorySize = map.brickDims.reduce((a, b) => a * b, 1);
    let occupied = 0;
    const sourceMaterials = new Set();
    for (let i = Math.ceil(directorySize / 4) * 4; i < words.length; i++) {
      for (let k = 0; k < 4; k++) {
        const material = words[i] >>> (k * 8) & 255;
        if (material) { occupied++; sourceMaterials.add(material); }
      }
    }
    assert.equal(occupied, map.stats.cells, 'real packed cell inventory');
    const authoredMaterials = new Set(Object.values(map.materialUsage).map(m => E[m.element]));
    for (const material of sourceMaterials) assert.ok(authoredMaterials.has(material));
    const first = renderImported(scene, view, 48);
    const second = renderImported(scene, view, 48);
    assert.deepEqual(first.rgb, second.rgb, 'no random render variation');
    const landscape = renderImported(scene, view, [80, 48]);
    assert.equal(landscape.rgb.length, 80 * 48 * 3, 'landscape is rendered at its native dimensions');
    for (let y = 0; y < 48; y++) {
      assert.deepEqual(landscape.rgb.subarray((y * 80 + 16) * 3, (y * 80 + 64) * 3),
        first.rgb.subarray(y * 48 * 3, (y + 1) * 48 * 3), 'landscape extends the view, never stretches it');
    }
    assert.ok(first.hits > 48 * 48 * 0.4, 'meaningful scene coverage');
    assert.ok(first.materials.size >= 5, 'visible source material diversity');
    for (const [material, { at }] of first.materials) {
      assert.equal(scene.cell(...at), material, 'visible sample is a real scene cell');
      assert.ok(sourceMaterials.has(material));
      assert.ok(at[1] < (view.ceiling ?? scene.size[1]));
    }
    if (view.ceiling) {
      assert.notDeepEqual(first.rgb, renderImported(scene, { ...view, ceiling: undefined }, 48).rgb,
        'documented cutaway actually reveals otherwise hidden geometry');
    }
    const file = fileURLToPath(new URL(`../public/maps/${id}.webp`, import.meta.url));
    const [format, dimensions, colours, entropy] = execFileSync('magick',
      ['identify', '-format', '%m %wx%h %k %[entropy]', file], { encoding: 'utf8' }).trim().split(/\s+/);
    assert.equal(format, 'WEBP');
    assert.equal(dimensions, '400x400');
    assert.ok(+colours > 1000, 'not a flat placeholder');
    assert.ok(+entropy > 0.4, 'nontrivial rendered image detail');
    assert.ok(statSync(file).size > 4000);
    const loading = fileURLToPath(new URL(`../public/maps/${id}-loading.webp`, import.meta.url));
    const loadingDimensions = execFileSync('magick', ['identify', '-format', '%wx%h', loading], { encoding: 'utf8' });
    assert.equal(loadingDimensions, '2560x1600', 'dedicated fullscreen artwork, not the 400px thumbnail');
    assert.ok(statSync(loading).size > statSync(file).size);
    console.log(`${id}: ${occupied} shipped cells, ${sourceMaterials.size} source / ${first.materials.size} visible materials, ${colours} encoded colours, entropy ${entropy}`);
  });
}

test('unknown and blocked profiles cannot silently render a substitute', () => {
  assert.throws(() => loadScene('sinSpaceEngineering'), /Unknown published preview/);
  assert.throws(() => loadScene('not-a-map'), /Unknown published preview/);
});
