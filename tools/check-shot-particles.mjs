// CPU-only regression of the ACTUAL generated WGSL, not just CPU live counts.
// node tools/check-shot-particles.mjs
import assert from 'node:assert/strict';
import { WGSLNodeBuilder, WebGPURenderer, Scene, PerspectiveCamera, Vector3, Object3D } from 'three/webgpu';
import { createBillboards } from '../src/gfx/billboards.js';
import { createVfx } from '../src/pov/vfx.js';
import { povEvents } from '../src/pov/events.js';
import { createBallistics } from '../src/pov/ballistics.js';

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
  // Muzzle visuals do not move the eye-fired bullet or its hit endpoint.
  const origin = new Vector3(0, 0, 0), muzzle = new Vector3(1, -0.5, -2);
  const fire = (id) => povEvents.emit('gun:fire', {
    id, origin, muzzleWorld: muzzle, dir: new Vector3(0, 0, -1),
  });
  const move = (id, from, to) => povEvents.emit('round:move', { id, kind: 'round', from, to });
  const endpoints = () => {
    const mesh = vfx.batch.children.find((m) => m.name === 'pov-tracer' && m.visible);
    assert.ok(mesh, 'tracer drawn');
    mesh.updateMatrixWorld();
    return [-0.5, 0.5].map((y) => new Vector3(0, y, 0).applyMatrix4(mesh.matrixWorld));
  };
  const close = (a, b, message) => assert.ok(a.distanceTo(b) < 1e-9, message);
  vfx.clear(); fire(101);
  move(101, origin, origin);
  assert.equal(vfx.counts().tracer, 0, 'pending trace draws nothing');
  const far = new Vector3(0, 0, -20);
  move(101, origin, far);
  let [a, b] = endpoints();
  close(a, muzzle, 'first moving segment leaves the barrel');
  close(b, far, 'cosmetic tracer ends at true impact');
  close(origin, new Vector3(), 'event physics origin unchanged');
  vfx.update(1); vfx.update(1); // expire first segment without clearing the shot state
  move(101, far, new Vector3(0, 0, -40));
  [a, b] = endpoints();
  close(a, far, 'later segments follow real flight without barrel offset');
  vfx.clear(); fire(102);
  move(102, origin, new Vector3(0, 0, -0.1));
  [a, b] = endpoints();
  close(a, origin, 'point-blank tracer cannot start behind its hit');
  close(b, new Vector3(0, 0, -0.1), 'point-blank hit stays in front');
  for (const clear of [() => povEvents.emit('round:end', { id: 103 }), () => vfx.clear()]) {
    vfx.clear(); fire(103); clear(); move(103, origin, far);
    close(endpoints()[0], origin, 'ended/cleared round drops its cosmetic start');
  }
  vfx.clear();
  const playerRounds = createBallistics(), npcRounds = createBallistics();
  try {
    const dir = new Vector3(0, 0, -1);
    const playerId = playerRounds.fire(origin, dir);
    const npcId = npcRounds.fire(new Vector3(10, 0, 0), dir);
    assert.notEqual(playerId, npcId, 'separate ballistic instances have globally unique event IDs');
    fire(playerId);
    povEvents.as({ id: 'npc', at: new Vector3(10, 0, 0) }, () => {
      povEvents.emit('gun:fire', { id: npcId, origin: new Vector3(10, 0, 0), dir });
      npcRounds.clear();
    });
    move(playerId, origin, far);
    close(endpoints()[0], muzzle, 'interleaved NPC shot/end cannot consume the player muzzle');
  } finally { playerRounds.dispose(); npcRounds.dispose(); }
  console.log('PASS: round/stretched GPU age initialized for all fades; 20 shots expire, flash/light gone by 50 ms');
  console.log('PASS: muzzle-to-hit tracer, zero-motion wait, point-blank cover, true later segments, cleanup');
} finally { vfx.dispose(); }
