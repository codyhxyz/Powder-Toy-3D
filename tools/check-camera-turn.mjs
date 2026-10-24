// The god view's camera (src/camera.js), real camera + OrbitControls math, no browser or GPU:
// right drag looks around from the eye (Pointer Lock while it does), Alt + left drag orbits
// a pivot, W A S D fly where you look (Garry's Mod's noclip), E and Q fly straight up and down
// (they no longer turn), the wheel with the right button held sets the fly speed, F's focus glide.
// node tools/check-camera-turn.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraRig, bindCameraMouse } from '../src/camera.js';
import { DRAG_PX } from '../src/brushInput.js';
import { PITCH_LIMIT } from '../src/pov/camera.js';

const events = new EventTarget(), view = new EventTarget(), document = new EventTarget(), canvas = new EventTarget();
let lockRefused = false, lockRequests = 0;
Object.assign(document, {
  defaultView: view, pointerLockElement: null,
  exitPointerLock() { document.pointerLockElement = null; document.dispatchEvent(new Event('pointerlockchange')); },
});
Object.assign(canvas, {
  ownerDocument: document, getRootNode: () => document, style: {}, clientHeight: 600,
  setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  requestPointerLock() {
    lockRequests++;
    if (lockRefused) return Promise.reject(new Error('refused'));
    return Promise.resolve().then(() => { document.pointerLockElement = canvas; document.dispatchEvent(new Event('pointerlockchange')); });
  },
});
const previous = globalThis.addEventListener;
globalThis.addEventListener = events.addEventListener.bind(events);
const camera = new THREE.PerspectiveCamera(40);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
let typing = false;
const key = (type, code) => events.dispatchEvent(Object.assign(new Event(type), { code }));
const pointer = (target, type, o) => target.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType: 'mouse',
  button: 0, buttons: 0, clientX: 0, clientY: 0, movementX: 0, movementY: 0, altKey: false, shiftKey: false, ...o }));
const near = (a, b, message, eps = 1e-9) => assert(a.distanceTo(b) < eps, `${message}: ${a.toArray()} vs ${b.toArray()}`);
const look = () => controls.target.clone().sub(camera.position);
const pitchOf = (v) => Math.asin(v.y / v.length());
const yawOf = (v) => Math.atan2(v.x, v.z);
const frames = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) { rig.update(dt); controls.update(); } };
const place = (eye, target) => { camera.position.copy(eye); controls.target.copy(target); controls.update(); };
const tick = () => new Promise((r) => setImmediate(r));

let rig, god = true;
try {
  rig = createCameraRig(camera, controls, () => typing);
  const speedSteps = [];
  const mouse = bindCameraMouse(canvas, rig, controls, { enabled: () => god, pivot: () => pivot, flySpeed: (n) => speedSteps.push(n) });
  let pivot = null;

  // E and Q fly straight up and down at the distance-scaled speed (Shift faster), never turning
  for (const code of ['KeyQ', 'KeyE']) for (const shift of [false, true]) {
    place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 0, 0));   // pitched down: up stays the world's
    const before = look();
    const eye = camera.position.clone();
    key('keydown', code); if (shift) key('keydown', 'ShiftLeft');
    rig.update(0.5); controls.update();
    key('keyup', code); key('keyup', 'ShiftLeft');
    const rise = (code === 'KeyE' ? 1 : -1) * Math.min(14, eye.distanceTo(new THREE.Vector3()) * 0.6) * 0.5 * (shift ? 2.5 : 1);
    near(camera.position, eye.clone().add(new THREE.Vector3(0, rise, 0)), `${code}${shift ? ' + Shift' : ''} moves straight ${rise > 0 ? 'up' : 'down'}`);
    near(look(), before, `${code} doesn't turn`);
  }

  // look: the eye stays, the view turns, the target keeps its distance; right moves turn right, down looks down
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  let eye = camera.position.clone(), before = look();
  rig.look(100, 50);
  near(camera.position, eye, 'look keeps the eye');
  assert(Math.abs(look().length() - before.length()) < 1e-9, 'look keeps the target distance');
  assert(yawOf(look()) > yawOf(before) - Math.PI && look().x > 0, 'a move right turns the view right');
  assert(pitchOf(look()) < 0, 'a move down looks down');
  frames(10);
  near(camera.position, eye, 'OrbitControls keeps the looked-around eye');
  rig.look(0, 1e5); rig.look(0, 1e5); rig.look(0, 1e5);
  assert(Math.abs(pitchOf(look()) + PITCH_LIMIT) < 1e-9, 'pitch stops at first person\'s limit');

  // W flies where you look: looking down, W goes down; strafing stays level; Shift is faster
  key('keydown', 'KeyW');
  let y0 = camera.position.y;
  frames(30);
  assert(camera.position.y < y0 - 1, 'W while looking down lowers the eye');
  key('keyup', 'KeyW');
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  rig.look(0, 120);
  y0 = camera.position.y;
  key('keydown', 'KeyD'); frames(30); key('keyup', 'KeyD');
  assert(Math.abs(camera.position.y - y0) < 1e-9 && camera.position.x > 0.5, 'D strafes right, level');
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  key('keydown', 'KeyW'); rig.update(1); controls.update(); key('keyup', 'KeyW');
  near(camera.position, new THREE.Vector3(0, 2, 4), 'W level: the distance-scaled speed (6/s at 10 away)');
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  key('keydown', 'ShiftLeft'); key('keydown', 'KeyW'); rig.update(0.1); controls.update();
  key('keyup', 'KeyW'); key('keyup', 'ShiftLeft');
  near(camera.position, new THREE.Vector3(0, 2, 10 - 1.5), 'Shift flies 2.5× as fast');
  rig.setMaxSpeed(2);
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  key('keydown', 'KeyW'); rig.update(1); controls.update(); key('keyup', 'KeyW');
  near(camera.position, new THREE.Vector3(0, 2, 8), 'a big map\'s maxSpeed caps the flight');
  rig.setMaxSpeed(Infinity);
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  key('keydown', 'KeyW'); typing = true; frames(5); typing = false;
  events.dispatchEvent(new Event('blur')); frames(5);
  near(camera.position, new THREE.Vector3(0, 2, 10), 'typing and blur hold the camera still');

  // orbit: the eye swings about the pivot at the same distance, and the pivot stays where it was on screen
  place(new THREE.Vector3(0, 10, 20), new THREE.Vector3(0, 10, 0));
  const p = new THREE.Vector3(5, 0, 0);
  const dist = camera.position.distanceTo(p);
  const toPivot = () => p.clone().sub(camera.position).applyQuaternion(camera.quaternion.clone().invert()).normalize();
  const seen = toPivot();
  rig.orbit(120, 40, p, 600);
  camera.updateMatrixWorld();
  assert(Math.abs(camera.position.distanceTo(p) - dist) < 1e-9, 'orbit keeps the distance to the pivot');
  near(toPivot(), seen, 'orbit keeps the pivot in place on screen', 1e-6);
  assert(camera.position.distanceTo(new THREE.Vector3(0, 10, 20)) > 1, 'orbit moves the eye');

  // F's focus: a glide that ends looking at the point from `dist` away, facing the way the view did
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  rig.focus(new THREE.Vector3(40, 0, -30), 5);
  frames(5);
  assert(camera.position.distanceTo(new THREE.Vector3(0, 2, 10)) > 0.1, 'the focus glides');
  frames(60);
  near(controls.target, new THREE.Vector3(40, 0, -30), 'the focus ends on the point');
  near(camera.position, new THREE.Vector3(40, 0, -25), 'from dist away along the old view');
  // R's reset still glides home
  rig.setHome(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, 0));
  rig.reset(); frames(60);
  near(camera.position, new THREE.Vector3(1, 2, 3), 'reset glides home');

  // the mouse: a click stays a click (the erase's), a drag looks with Pointer Lock, let go releases it
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  eye = camera.position.clone(); before = look();
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  assert.equal(controls.mouseButtons.RIGHT, null, 'OrbitControls leaves the right button alone');
  pointer(view, 'pointermove', { buttons: 2, clientX: 100 + DRAG_PX - 2, clientY: 100, movementX: DRAG_PX - 2 });
  near(look(), before, 'a wobble under DRAG_PX doesn\'t look');
  assert.equal(lockRequests, 0, 'a click never asks for the lock');
  pointer(view, 'pointerup', { button: 2, clientX: 100 + DRAG_PX - 2, clientY: 100 });
  assert.equal(mouse.dragging, null);
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  pointer(view, 'pointermove', { buttons: 2, clientX: 130, clientY: 100, movementX: 30 });
  assert.equal(mouse.dragging, 'look');
  assert.equal(lockRequests, 1, 'the drag asks for the lock');
  await tick();
  assert.equal(document.pointerLockElement, canvas, 'the cursor is held while looking');
  pointer(view, 'pointermove', { buttons: 2, clientX: 130, clientY: 100, movementX: 20, movementY: 10 });
  near(camera.position, eye, 'the drag looks from the eye');
  assert(look().x > 0 && pitchOf(look()) < 0, 'the drag turns right and down');
  pointer(view, 'pointerup', { button: 2, clientX: 130, clientY: 100 });
  assert.equal(document.pointerLockElement, null, 'letting go frees the cursor');
  assert.equal(mouse.dragging, null);
  // a lock that lands after the button came up is let go at once
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  pointer(view, 'pointermove', { buttons: 2, clientX: 130, clientY: 100 });
  pointer(view, 'pointerup', { button: 2, clientX: 130, clientY: 100 });
  await tick();
  assert.equal(document.pointerLockElement, null, 'a late lock is released');
  // refused: plain movement still looks
  lockRefused = true;
  before = look();
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  pointer(view, 'pointermove', { buttons: 2, clientX: 130, clientY: 100 });
  await tick();
  pointer(view, 'pointermove', { buttons: 2, clientX: 160, clientY: 100, movementX: 30 });
  assert(yawOf(look()) !== yawOf(before), 'without the lock the drag still looks');
  pointer(view, 'pointerup', { button: 2 });
  lockRefused = false;
  // the wheel with the right button held steps the fly speed and doesn't zoom; without it, it zooms
  const wheel = (o) => { const e = Object.assign(new Event('wheel', { cancelable: true }), { deltaX: 0, deltaY: 0, buttons: 0, ...o }); canvas.dispatchEvent(e); return e; };
  let zoomed = 0;
  canvas.addEventListener('wheel', () => zoomed++);
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  let w = wheel({ deltaY: -100, buttons: 2 });
  assert.deepEqual(speedSteps, [1], 'scrolling up with the right button held speeds up');
  assert(w.defaultPrevented && zoomed === 0, 'and doesn\'t zoom');
  wheel({ deltaY: 100, buttons: 2 });
  assert.deepEqual(speedSteps, [1, -1], 'scrolling down slows down');
  pointer(view, 'pointerup', { button: 2, clientX: 100, clientY: 100 });
  w = wheel({ deltaY: -100 });
  assert(!w.defaultPrevented && zoomed === 1 && speedSteps.length === 2, 'a plain scroll still zooms');
  // Shift + right is OrbitControls' pan
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, shiftKey: true });
  assert.equal(controls.mouseButtons.RIGHT, THREE.MOUSE.ROTATE, 'Shift + right: OrbitControls\' pan (its Shift + rotate)');
  assert.equal(mouse.dragging, null, 'Shift + right doesn\'t look');
  pointer(view, 'pointerup', { button: 2, shiftKey: true });
  // Alt + left orbits the pivot given at the press, or the target with none
  place(new THREE.Vector3(0, 10, 20), new THREE.Vector3(0, 10, 0));
  pivot = p;
  const d0 = camera.position.distanceTo(p);
  pointer(canvas, 'pointerdown', { button: 0, buttons: 1, altKey: true });
  pivot = null;   // (the pick moving on after the press doesn't move the pivot)
  pointer(view, 'pointermove', { buttons: 1, altKey: true, movementX: 50, movementY: 20 });
  assert.equal(mouse.dragging, 'orbit');
  assert(Math.abs(camera.position.distanceTo(p) - d0) < 1e-9, 'Alt drag orbits the point under the cursor');
  pointer(view, 'pointerup', { button: 0, altKey: true });
  assert.equal(lockRequests, 3, 'orbiting keeps the cursor (no lock asked)');
  place(new THREE.Vector3(0, 10, 20), new THREE.Vector3(0, 10, 0));
  pointer(canvas, 'pointerdown', { button: 0, buttons: 1, altKey: true });
  pointer(view, 'pointermove', { buttons: 1, altKey: true, movementX: 50 });
  pointer(view, 'pointerup', { button: 0, altKey: true });
  assert(Math.abs(camera.position.distanceTo(new THREE.Vector3(0, 10, 0)) - 20) < 1e-9, 'with nothing under the cursor it orbits the target');
  // first person has the mouse: nothing here moves
  god = false;
  place(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 2, 0));
  before = look();
  pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
  pointer(view, 'pointermove', { buttons: 2, clientX: 160, clientY: 100, movementX: 60 });
  near(look(), before, 'first person\'s mouse is its own');
  pointer(view, 'pointerup', { button: 2 });
  console.log('god camera OK: E/Q up/down (no turn), F focus glide, right-held wheel = fly speed, right-drag look in place + Pointer Lock, pitch limit, noclip WASD (Shift, maxSpeed), Alt orbit about the pick, Shift pan, click stays a click');
} finally {
  controls.dispose();
  if (previous === undefined) delete globalThis.addEventListener;
  else globalThis.addEventListener = previous;
}
