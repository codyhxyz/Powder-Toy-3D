// CPU-only: real firearm, camera, recoil and model code; no browser/GPU.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { createPovCamera } from '../src/pov/camera.js';
import { createFeel } from '../src/pov/feel.js';
import { povEvents } from '../src/pov/events.js';
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: pistol } = await import('../src/pov/tools/gun.tool.js');
const { default: smg } = await import('../src/pov/tools/smg.tool.js');
const { default: sniper } = await import('../src/pov/tools/sniper.tool.js');
const near = (a, b, label) => assert.ok(a.distanceTo(b) < 1e-9, label);
const random = Math.random;
try {
  // Zero radius within each gun's real spread cone exposes its centre exactly.
  Math.random = () => 0;
  for (const def of [pistol, smg, sniper]) {
    for (const mode of ['hip', 'ads', 'hidden', ...(def === sniper ? ['scope'] : [])]) {
      const volume = new THREE.Object3D();
      volume.position.set(-100, 30, 50);
      const scale = 0.25, camera = new THREE.PerspectiveCamera(75, 1.6, 0.01, 1000);
      const viewmodel = new THREE.Group();
      camera.add(viewmodel);
      viewmodel.visible = mode !== 'hidden';
      const pov = createPovCamera(), feel = createFeel({});
      pov.setLook(0.65, -0.3);
      const eye = new THREE.Vector3(20.5, 6.5, 20.5), baseDir = new THREE.Vector3();
      pov.dir(baseDir);
      const c = { dt: 2, eye, dir: baseDir, player: {
        pos: new THREE.Vector3(20.5, 1, 20.5), onGround: true, applyImpulse() {},
      }, sim: { g: { nx: 64, ny: 64, nz: 64 }, gravity: 0.025 },
      primary: false, primaryPressed: false, secondary: mode === 'ads', aim: { valid: false } };
      const shots = [], events = [];
      const off = povEvents.on('gun:fire', (e) => events.push(e));
      const tool = def.create({
        viewmodel, getVolume: () => volume, getScale: () => scale, getAimCamera: () => camera,
        ballistics: { count: 0, fire(origin, dir) {
          shots.push({ origin: origin.clone(), dir: dir.clone() }); return shots.length;
        } },
      });
      try {
        tool.update({ ...c, secondaryPressed: mode === 'scope' });
        feel.update({ dt: 0, live: true, eye });
        // Each preceding shot kicks the next frame's actual rendered view.
        for (const distance of [Infinity, 0.01, 5, 1000]) {
          const shake = feel.update({ dt: 0.05, live: true, eye });
          const pose = pov.update({
            dt: 0.05, eye: eye.clone().multiplyScalar(scale).add(volume.position),
            feet: c.player.pos.clone().multiplyScalar(scale).add(volume.position),
            scale, speedH: 6, onGround: true, inLiquid: false,
            box: { min: new THREE.Vector3(-1000, -1000, -1000), max: new THREE.Vector3(1000, 1000, 1000), margin: 0 },
            shake,
          });
          camera.position.copy(pose.pos); camera.quaternion.copy(pose.quat);
          camera.updateMatrixWorld();
          const viewDir = camera.getWorldDirection(new THREE.Vector3());
          if (shots.length) assert.ok(viewDir.distanceTo(baseDir) > 1e-5, 'fixture includes actual recoil');
          const expected = camera.position.clone().sub(volume.position).divideScalar(scale);
          // A stale/close hover must not steer the next bullet.
          c.aim = { valid: Number.isFinite(distance), dist: distance, cell: new THREE.Vector3(1, 1, 1) };
          tool.update({ ...c, primary: true, primaryPressed: true });
          const shot = shots.at(-1), label = `${def.key}/${mode}/${distance}`;
          near(shot.origin, expected, `${label}: starts at rendered eye, with bob and grid transform`);
          near(shot.dir, viewDir, `${label}: spread centre follows camera punch`);
          for (const range of [0.1, 2, 30, 100]) {
            const ndc = shot.origin.clone().addScaledVector(shot.dir, range)
              .multiplyScalar(scale).add(volume.position).project(camera);
            assert.ok(Math.hypot(ndc.x, ndc.y) < 1e-9, `${label}: on crosshair at range ${range}`);
          }
          near(events.at(-1).origin, shot.origin, 'sound/event uses physical origin');
          if (mode !== 'scope' && mode !== 'hidden') {
            near(events.at(-1).muzzleWorld, tool.muzzleWorld(), 'flash stays on the animated barrel');
          }
        }
        assert.equal(shots.length, 4, 'each trigger fires');
        // An NPC must never borrow the player's view, even with this environment.
        povEvents.as({ id: 'aim-test-npc', at: eye }, () => tool.update({ ...c, primary: true, primaryPressed: true }));
        near(shots.at(-1).origin, eye, 'NPC starts at its own eye');
        near(shots.at(-1).dir, baseDir, 'NPC follows its own aim');
      } finally { off(); tool.dispose(); feel.dispose(); }
    }
  }

  // A held SMG still blooms, but remains symmetrically distributed about the view.
  let seed = 12345;
  Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.set(0.3, 0.5, 0.2, 'YXZ'); camera.updateMatrixWorld();
  const axis = camera.getWorldDirection(new THREE.Vector3()), sum = new THREE.Vector3();
  const tool = smg.create({
    viewmodel: new THREE.Group(), getVolume: () => new THREE.Object3D(), getScale: () => 1,
    getAimCamera: () => camera, ballistics: { count: 0, fire: () => 1 },
  });
  try {
    let minCone = Infinity, maxCone = 0;
    for (let i = 0; i < 1024; i++) {
      tool.update({ dt: 0.08, primary: true, primaryPressed: i === 0,
        eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), aim: { valid: false },
        player: { onGround: true, applyImpulse() {} }, sim: { gravity: 0.025 },
      });
      const { dir, cone } = tool.lastShot;
      assert.ok(dir.angleTo(axis) <= cone / 2 + 1e-9, 'every round inside camera-centred spread cone');
      sum.add(dir); minCone = Math.min(minCone, cone); maxCone = Math.max(maxCone, cone);
    }
    assert.ok(maxCone > minCone * 2, 'automatic fire still increases spread');
    assert.ok(sum.normalize().angleTo(axis) < 0.005, 'spray has no systematic sideways/downward bias');
  } finally { tool.dispose(); }
  console.log('PASS: camera-centred hip/ADS/scope/hidden shots, recoil, bob, stale hover, range, scale, NPC isolation, SMG spread');
} finally { Math.random = random; }
