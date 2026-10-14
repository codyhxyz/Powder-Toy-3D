// CPU-only regression of the ACTUAL generated WGSL, not just CPU live counts.
// node tools/check-shot-particles.mjs
import assert from 'node:assert/strict';
import { WGSLNodeBuilder, WebGPURenderer, Scene, PerspectiveCamera, Vector3, Object3D } from 'three/webgpu';
import { createBillboards } from '../src/gfx/billboards.js';
import { createVfx } from '../src/pov/vfx.js';
import { povEvents } from '../src/pov/events.js';

// Building nodes needs renderer capabilities, not a device, canvas, or browser.
const renderer = new WebGPURenderer({ canvas: { addEventListener() {}, removeEventListener() {}, style: {} } });
renderer.hasFeature = () => false;
for (const stretched of [false, true]) {
  const pool = createBillboards({ name: 'shot-expiry', capacity: 8, stretched });
  try {
    const builder = new WGSLNodeBuilder(pool.mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new PerspectiveCamera();
    builder.build();
    const shader = builder.vertexShader;
    const body = shader.slice(shader.indexOf('// flow'));
    // Uniform clock minus per-instance birth must run for EVERY fade mode.
    // The broken graph assigned this temp only inside the SHARP fade branch;
    // OUT then read WGSL's zero default for alpha, lifetime and position.
    const age = /(\w+)\s*=\s*\(\s*object\.\w+\s*-\s*iA\.w\s*\)/.exec(body);
    assert.ok(age, `${stretched}: generated clock-minus-birth assignment exists`);
    const before = body.slice(0, age.index);
    const depth = [...before].reduce((n, c) => n + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
    assert.equal(depth, 0, `${stretched}: particle age is assigned unconditionally`);
    assert.ok(body.includes(`${age[1]} < iB.w`), `${stretched}: GPU lifetime uses the initialized age`);
    assert.ok(builder.fragmentShader.includes('nodeVarying'), 'fragment consumes generated fade');
  } finally { pool.dispose(); }
}

const scene = new Scene(), anchor = new Object3D();
scene.add(anchor);
const vfx = createVfx({
  scene, camera: new PerspectiveCamera(),
  getVolume: () => ({ position: new Vector3() }), getScale: () => 1, isActive: () => true,
});
try {
  for (let i = 0; i < 20; i++) {
    povEvents.emit('gun:fire', { origin: new Vector3(i, 0, 0), dir: new Vector3(0, 0, -1), muzzleAnchor: anchor });
    vfx.update(1 / 60); // birth frame: at least one visible frame
    assert.equal(anchor.children.filter((c) => c.visible).length, 1, 'only this shot has a hand flash');
    vfx.update(1 / 60);
    vfx.update(1 / 60);
    assert.equal(anchor.children.length, 0, 'hand flash detached by 50 ms');
    assert.equal(vfx.light.intensity, 0, 'muzzle light off by 50 ms');
    for (let frame = 0; frame < 30; frame++) vfx.update(1 / 60);
    assert.equal(vfx.busy, false, 'effects expire between shots');
    assert.ok(Object.values(vfx.counts()).every((n) => n === 0), 'no live CPU slots from earlier shots');
  }
  console.log('PASS: round/stretched GPU age initialized for all fades; 20 shots expire, flash/light gone by 50 ms');
} finally { vfx.dispose(); }
