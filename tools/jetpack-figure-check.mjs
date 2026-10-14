// CPU-only: actual rigs, GLB skeleton/animations and particle birth records. No GPU.
// node tools/jetpack-figure-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildStick, createFigure } from '../src/pov/figure.js';
import { buildSpartan } from '../src/pov/figureSpartan.js';
import { buildCrasher } from '../src/pov/figureCrasher.js';
import { createVfx } from '../src/pov/vfx.js';
import { portraitScene } from '../src/pov/classPortraits.js';

const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('/pov/bodyModel.js')) {
    return { format: 'module', source: 'export const BODY_MODEL_URL = "/models/character/body.glb";', shortCircuit: true };
  }
  return next(url, context);
} });
const { createRealFigure } = await import('../src/pov/figureReal.js');
hooks.deregister();
const data = await readFile(new URL('../public/models/character/body.glb', import.meta.url));
// Geometry, bones and clips are real; image decoding is irrelevant to attachment math.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.register(parser => ({
  name: 'cpu-textures',
  beforeRoot() { parser.loadTextureImage = async () => new THREE.Texture(); },
}));
const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
const figures = [
  ['stick', createFigure(buildStick)], ['spartan', createFigure(buildSpartan)],
  ['wizard', createFigure(() => buildCrasher())], ['real', createRealFigure(gltf)],
];
const scene = new THREE.Scene();
const vfx = createVfx({
  scene, camera: new THREE.PerspectiveCamera(), getScale: () => 1,
  getVolume: () => ({ position: new THREE.Vector3() }), isActive: () => true,
});
const state = {
  feet: new THREE.Vector3(12, 8, -4), scale: 1, yaw: 0, worldToGrid: new THREE.Matrix4(),
  speedH: 0, velY: 0, onGround: true, inLiquid: false, dead: false, jetting: false,
};
const close = (a, b, label) => assert.ok(a.distanceTo(b) < 1e-5, label);
try {
  for (const [name, figure] of figures) {
    scene.add(figure.root);
    figure.setVisible(true);
    figure.update(0, state);
    assert.equal(figure.nozzles.length, 2, `${name}: two physical nozzles`);
    const pack = figure.root.getObjectByName('jetpack');
    assert.ok(pack?.visible, `${name}: pack visible while idle`);
    for (const nozzle of figure.nozzles) {
      const flame = nozzle.getObjectByName('jet-flame');
      assert.equal(flame.visible, false, `${name}: no idle flame`);
      flame.geometry.computeBoundingBox();
      assert.ok(Math.abs(flame.geometry.boundingBox.max.y) < 1e-6, 'flame begins at the mouth and extends down');
      close(flame.getWorldPosition(new THREE.Vector3()), nozzle.getWorldPosition(new THREE.Vector3()), 'flame attached to mouth');
    }
    if (name === 'real') assert.equal(pack.parent.name, 'spine_03', 'real pack follows animated chest, not root');
    // Both moving/surfacing and crouched poses; yaw, aim pitch and Shrink all affect mouths.
    for (const pose of [
      { onGround: false, jetting: true, inLiquid: true, speedH: 3 },
      { crouch: 1, look: { pitch: 0.7, spine: 0.5 } },
    ]) {
      const posed = { ...state, ...pose, yaw: 1.2, scale: 0.5 };
      for (let i = 0; i < 20; i++) figure.update(1 / 60, posed);
      const mouths = figure.nozzles.map(n => n.getWorldPosition(new THREE.Vector3()));
      const dirs = figure.nozzles.map(n => new THREE.Vector3(0, -1, 0).transformDirection(n.matrixWorld));
      assert.ok(Math.abs(mouths[0].distanceTo(mouths[1]) - 0.3) < 1e-5, `${name}: nozzle spacing shrinks with body`);
      assert.ok(dirs[0].distanceTo(new THREE.Vector3(0, -1, 0)) > 0.01, `${name}: exhaust follows torso tilt`);
      for (const nozzle of figure.nozzles) {
        assert.equal(nozzle.getObjectByName('jet-flame').visible, !!posed.jetting, `${name}: flame follows thrust`);
      }
      vfx.clear();
      vfx.jet(figure.nozzles, 0.1);
      assert.ok(vfx.counts().jet > 0, `${name}: particle exhaust emitted`);
      let records = 0;
      for (const mesh of vfx.batch.children) {
        const a = mesh.geometry?.getAttribute('iA'), b = mesh.geometry?.getAttribute('iB');
        if (!a || !b) continue;
        for (let i = 0; i < b.count; i++) {
          if (!(b.getW(i) > 0)) continue;
          const at = new THREE.Vector3().fromBufferAttribute(a, i);
          const mouth = mouths.findIndex(p => p.distanceTo(at) < 1e-5);
          assert.ok(mouth >= 0, `${name}: particle starts at animated nozzle, not a fixed feet offset`);
          const velocity = new THREE.Vector3().fromBufferAttribute(b, i).normalize();
          assert.ok(velocity.dot(dirs[mouth]) > 0.8, `${name}: exhaust points out of nozzle`);
          records++;
        }
      }
      assert.ok(records > 0, 'particle birth data checked');
    }
    figure.update(1 / 60, { ...state, dead: true, jetting: true, deadTime: 1 });
    for (const nozzle of figure.nozzles) assert.equal(nozzle.getObjectByName('jet-flame').visible, false, 'no flames on dead bodies');
    console.log(`${name}: visible pack, posed/scaled mouths, attached flames, particle origins/directions and death OK`);
  }
  const bare = createFigure(() => buildCrasher({ pack: false }));
  try {
    bare.update(1 / 60, { ...state, jetting: true });
    assert.equal(bare.nozzles.length, 0, 'unequipped character has no exhaust');
    assert.equal(bare.root.getObjectByName('jetpack'), undefined, 'unequipped character has no pack');
  } finally { bare.dispose(); }
  const portrait = portraitScene({ color: '#7655aa', pose: 'hover', model: null });
  try {
    const flames = [];
    portrait.scene.traverse(o => { if (o.name === 'jet-flame') flames.push(o); });
    assert.equal(flames.length, 2, 'class portrait still builds its pack');
    assert.ok(flames.every(f => f.visible), 'hover portrait still shows exhaust');
  } finally { portrait.dispose(); }
} finally {
  vfx.dispose();
  for (const [, figure] of figures) figure.dispose();
}
console.log('jetpack figures: all OK');
