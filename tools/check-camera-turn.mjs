// Real camera + OrbitControls math, no browser or GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraRig } from '../src/camera.js';

const events = new EventTarget(), document = new EventTarget(), canvas = new EventTarget();
canvas.ownerDocument = document;
canvas.getRootNode = () => document;
canvas.style = {};
const previous = globalThis.addEventListener;
globalThis.addEventListener = events.addEventListener.bind(events);
const camera = new THREE.PerspectiveCamera();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
let typing = false;
const key = (type, code) => events.dispatchEvent(Object.assign(new Event(type), { code }));
const close = (a, b, message) => assert(a.distanceTo(b) < 1e-9, message);
try {
  const rig = createCameraRig(camera, controls, () => typing);
  for (const code of ['KeyQ', 'KeyE']) for (const shift of [false, true]) {
    camera.position.set(110, 26, -75);
    controls.target.set(103, 4, -120); // distant, pitched, off-origin target
    controls.update();
    const eye = camera.position.clone();
    const look = controls.target.clone().sub(eye);
    const pitch = camera.getWorldDirection(new THREE.Vector3()).y;
    key('keydown', code);
    if (shift) key('keydown', 'ShiftLeft');
    for (let i = 0; i < 60; i++) { rig.update(1 / 60); controls.update(); }
    close(camera.position, eye, `${code}: eye must not orbit`);
    const angle = (code === 'KeyE' ? 1 : -1) * Math.PI / 2 * (shift ? 2.5 : 1);
    close(controls.target.clone().sub(eye), look.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle), 'preserve yaw direction, speed and target distance');
    assert(Math.abs(camera.getWorldDirection(new THREE.Vector3()).y - pitch) < 1e-12, 'preserve pitch');
    key('keyup', code); key('keyup', 'ShiftLeft');
  }
  camera.position.set(0, 2, 10);
  controls.target.set(0, 2, 0);
  controls.update();
  key('keydown', 'KeyE'); key('keydown', 'KeyW');
  rig.update(1); controls.update();
  close(camera.position, new THREE.Vector3(-6, 2, 10), 'W moves along the newly turned heading');
  events.dispatchEvent(new Event('blur'));
  const eye = camera.position.clone(), target = controls.target.clone();
  key('keydown', 'KeyQ'); key('keydown', 'KeyE');
  rig.update(0.1); controls.update();
  close(camera.position, eye, 'opposite keys cancel without moving the eye');
  close(controls.target, target, 'opposite keys cancel the turn');
  key('keyup', 'KeyQ');
  typing = true;
  rig.update(0.1); controls.update();
  close(controls.target, target, 'typing suppresses held turn keys');
  typing = false;
  events.dispatchEvent(new Event('blur'));
  rig.update(0.1); controls.update();
  close(controls.target, target, 'blur clears held turn keys');
  console.log('camera turning OK: fixed eye, yaw/pitch/radius preserved, Shift, WASD, typing and blur');
} finally {
  controls.dispose();
  if (previous === undefined) delete globalThis.addEventListener;
  else globalThis.addEventListener = previous;
}
