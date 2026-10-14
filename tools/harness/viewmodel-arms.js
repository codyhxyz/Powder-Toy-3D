import * as THREE from 'three/webgpu';
import { attachModel } from '/src/pov/models.js';
import { loadModel as loadBodyModel } from '/src/pov/figureReal.js';
import { viewmodelRig } from '/src/pov/viewmodel.js';

export async function preview() {
  await loadBodyModel('real');
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer._getFallback = null;
  renderer.setSize(1440, 600);
  document.body.append(renderer.domElement);
  await renderer.init();
  const camera = new THREE.PerspectiveCamera(75, 480 / 600, 0.01, 20);
  const panels = [
    ['stick', 'jackhammer', [1, -0.15, -3.2]],
    ['real', 'jackhammer', [1, -0.15, -3.2]],
    ['real', 'pistol', [0.45, -0.42, -1.3]],
  ];
  const fixtures = panels.map(([choice, key, pos]) => {
    const scene = new THREE.Scene(), vm = new THREE.Group();
    scene.background = new THREE.Color('#263843');
    scene.add(vm, new THREE.AmbientLight(0xffffff, 1.5));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(-2, 4, 3);
    scene.add(light);
    const rig = viewmodelRig({ viewmodel: vm, getScale: () => 1, getCharacter: () => choice });
    const hand = rig.hand(pos), model = attachModel(hand, key);
    hand.visible = true;
    rig.update({ dt: 0, dir: new THREE.Vector3(0, 0, -1), player: {} });
    // This fixture draws directly, not through the app's layer-5 composite.
    return { choice, scene, vm, rig, model };
  });
  await new Promise(requestAnimationFrame);
  for (const f of fixtures) {
    if (f.choice === 'real' && !f.vm.getObjectByName('view-arm-real')) throw new Error('Real arm did not load');
    f.vm.traverse(o => o.layers.set(0));
    await renderer.compileAsync(f.scene, camera);
  }
  renderer.setScissorTest(true);
  for (const [i, f] of fixtures.entries()) {
    renderer.setViewport(i * 480, 0, 480, 600);
    renderer.setScissor(i * 480, 0, 480, 600);
    renderer.render(f.scene, camera);
  }
  window.armsPreview = { renderer, fixtures };
  return fixtures.map(f => ({ choice: f.choice, real: !!f.vm.getObjectByName('view-arm-real') }));
}
