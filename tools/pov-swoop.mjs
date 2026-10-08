// CPU-only check of the POV swoop (src/pov/camera.js) at a fixed 60 fps:
// it must end exactly on its target pose, and turn smoothly on the way (no
// snaps: the angular velocity changes by little from frame to frame).
// usage: node tools/pov-swoop.mjs [--verbose]
import * as THREE from 'three';
import { createPovCamera, ENTRY_PITCH } from '../src/pov/camera.js';

const FPS = 60;
// Popping out while facing away from the god camera needs an about-turn: 180°
// in SWOOP_S under a smoothstep peaks at 1.5 × 180 / 0.9 = 300 deg/s.
const MAX_ANG_VEL = 320;     // deg/s, anywhere in the flight
const MAX_ANG_JERK = 60;     // deg/s of angular-velocity change between frames (a snap shows as hundreds)
const verbose = process.argv.includes('--verbose');

const N = 128, scale = 10 / N;
const vol = new THREE.Vector3(-N / 2 * scale, 0, -N / 2 * scale);
const toW = (g) => g.clone().multiplyScalar(scale).add(vol);
const box = { min: vol.clone(), max: new THREE.Vector3(N, N, N).multiplyScalar(scale).add(vol), margin: 0.5 * scale };
const UP = new THREE.Vector3(0, 1, 0);
const orbitPos = new THREE.Vector3(11, 12, 13), orbitTarget = new THREE.Vector3(0, 2.5, 0);
const orbitQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(orbitPos, orbitTarget, UP));

let fails = 0;
function fly(label, cam, state, endPos, endQuat) {
  let prevQ = null, prevW = null, maxW = 0, maxJ = 0, frames = 0, pose;
  const ws = [];
  for (let i = 0; i < 4 * FPS; i++) {
    pose = cam.update(state);
    if (prevQ) {
      const w = THREE.MathUtils.radToDeg(pose.quat.angleTo(prevQ)) * FPS;
      if (prevW != null) maxJ = Math.max(maxJ, Math.abs(w - prevW));
      maxW = Math.max(maxW, w);
      prevW = w;
      ws.push(w.toFixed(0));
    }
    prevQ = pose.quat.clone();
    frames++;
    if (pose.done) break;
  }
  const posErr = pose.pos.distanceTo(endPos ?? pose.pos) / scale, angErr = endQuat ? pose.quat.angleTo(endQuat) : 0;
  const ok = pose.done && maxW <= MAX_ANG_VEL && maxJ <= MAX_ANG_JERK && posErr < 1e-6 && angErr < 1e-6;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${frames} frames, peak ${maxW.toFixed(0)} deg/s, jerk ${maxJ.toFixed(0)} deg/s/frame, end error ${posErr.toExponential(1)} cells / ${angErr.toExponential(1)} rad`);
  if (verbose) console.log('     ', ws.join(' '));
}

for (const [label, feetG, pitch] of [
  ['in, near', new THREE.Vector3(95.5, 11, 47.5), ENTRY_PITCH],
  ['in, centre', new THREE.Vector3(64, 0, 64), ENTRY_PITCH],
  ['in, far side', new THREE.Vector3(30, 0, 100), ENTRY_PITCH],
  ['in, on a tower', new THREE.Vector3(64, 100, 64), ENTRY_PITCH],
]) {
  const cam = createPovCamera();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(orbitQuat);
  cam.setLook(Math.atan2(-fwd.x, -fwd.z), pitch);
  cam.reset();
  const state = { dt: 1 / FPS, eye: toW(feetG.clone().setY(feetG.y + 5)), feet: toW(feetG), scale, speedH: 0,
    onGround: true, inLiquid: false, sprinting: false, dead: false, deadTime: 0, box };
  cam.startSwoop('in', { pos: orbitPos, quat: orbitQuat, fov: 40 });
  fly(label, cam, state, state.eye, new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, cam.look.yaw, 0, 'YXZ')));
}
for (const [label, yaw, pitch] of [['out, facing away', 0.7, -0.1], ['out, looking up', 2.5, 0.8], ['out, looking down', -1, -1.2]]) {
  const feetG = new THREE.Vector3(95.5, 11, 47.5);
  const cam = createPovCamera();
  cam.setLook(yaw, pitch);
  cam.reset();
  const state = { dt: 1 / FPS, eye: toW(feetG.clone().setY(feetG.y + 5)), feet: toW(feetG), scale, speedH: 0,
    onGround: true, inLiquid: false, sprinting: false, dead: false, deadTime: 0, box };
  const p0 = cam.update(state);
  cam.startSwoop('out', { pos: p0.pos.clone(), quat: p0.quat.clone(), fov: 75 }, { to: { pos: orbitPos, quat: orbitQuat, fov: 40 } });
  fly(label, cam, state, orbitPos, orbitQuat);
}
console.log(fails ? `${fails} swoop(s) failed` : 'all swoops smooth');
process.exit(fails ? 1 : 0);
