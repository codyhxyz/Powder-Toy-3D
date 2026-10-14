// Event-level regression: mining must not overlay fake dust/chips on real debris.
// node tools/mining-vfx-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVfx } from '../src/pov/vfx.js';
import { povEvents } from '../src/pov/events.js';
import { E } from '../src/elements.js';
import { MELEE_SOURCES } from '../src/pov/constants.js';

const vfx = createVfx({
  scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
  getVolume: () => ({ position: new THREE.Vector3() }),
  getScale: () => 1, isActive: () => true,
});
const hit = (source, id, broke = true) => povEvents.emit('impact', {
  source, id, broke, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
});
try {
  for (const source of [...MELEE_SOURCES, 'gun']) {
    for (const id of [E.SAND, E.ROCK, E.STONE, E.WOOD, E.GLASS]) {
      vfx.clear();
      hit(source, id);
      assert.equal(vfx.counts().debris, undefined, `${source}: no cosmetic dust pool`);
      assert.equal(vfx.counts().chip, undefined, `${source}: no cosmetic chip pool`);
    }
  }
  for (const source of ['pickaxe', 'jackhammer']) {
    vfx.clear();
    hit(source, E.METAL, false);
    assert.ok(vfx.counts().spark > 0, `${source}: refused strike still sparks`);
  }
  vfx.clear();
  hit('pickaxe', E.WATER);
  assert.ok(vfx.counts().mist > 0, 'liquid splash unchanged');
  console.log('PASS: no impact dust/chips; sparks and splashes unchanged');
} finally {
  vfx.dispose();
}
