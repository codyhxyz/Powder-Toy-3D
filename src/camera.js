import * as THREE from 'three';
import { LOOK_SENSITIVITY, LOOK_MAX_PX, PITCH_LIMIT, POV_FOV } from './pov/camera.js';
import { DRAG_PX } from './brushInput.js';

// The god view's camera, an editor viewport's (Roblox Studio's, Unreal's): hold
// the right button to look around from where you are, as in first person, and
// fly with W A S D where you look, Garry's Mod's noclip (looking down, W goes
// down), E up and Q down (Roblox Studio's); the wheel with the right button
// held sets the fly speed (Unreal's), and F flies to what's under the cursor
// (Roblox Studio's and Unreal's focus). Alt + left drag orbits the point under the cursor, Blender's and
// Maya's Alt orbit (and a trackpad's). OrbitControls keeps the rest: the wheel's
// zoom, the pans (middle drag, Shift + right drag) and two-finger touch. Its
// target rides along in front of the eye at the same distance, so zoom, pan and
// the animated reset to the home view still work from wherever you look.
const FAST = 2.5;                    // × speed with Shift held
const ORBIT_TURNS_PER_HEIGHT = 1;    // turns per screen height of Alt drag (OrbitControls' rate at rotateSpeed 1)
const GLIDE_S = 0.6;                 // s: R's glide back to the home view, and F's to a point
const UP = new THREE.Vector3(0, 1, 0);

// opts.sensitivity(): the Mouse Sensitivity setting's multiplier; opts.povFov(): the FOV setting (degrees).
export function createCameraRig(camera, controls, isTyping, { sensitivity = () => 1, povFov = () => POV_FOV } = {}) {
  const keys = new Set();
  const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  let anim = null;
  let speed = 1;
  let maxSpeed = Infinity;   // world units/s WASD never exceeds (a world's window has to keep up)

  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
  addEventListener('keydown', (e) => {
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (MOVE.has(e.code)) keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  const dir = new THREE.Vector3(), axis = new THREE.Vector3(), offset = new THREE.Vector3(), eye = new THREE.Vector3();
  const qYaw = new THREE.Quaternion(), qPitch = new THREE.Quaternion();

  // The view's right, level: from the look, or the camera's own when looking straight up or down.
  function levelRight(look, out) {
    out.crossVectors(look, UP);
    if (out.lengthSq() < 1e-12) out.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0);
    return out.normalize();
  }

  // Turns the view by yaw (about the vertical) and pitch (up +), the eye swung
  // about `pivot` with it: the eye itself to look around, a point to orbit it.
  // Pitch stops PITCH_LIMIT from straight up or down, as first person's does.
  function turnAbout(yaw, pitch, pivot) {
    dir.subVectors(controls.target, camera.position);
    const len = dir.length();
    if (len < 1e-9) return;
    const now = Math.asin(THREE.MathUtils.clamp(dir.y / len, -1, 1));
    // (a view already past the limit, as two fingers can leave it, isn't yanked back)
    pitch = THREE.MathUtils.clamp(now + pitch, Math.min(-PITCH_LIMIT, now), Math.max(PITCH_LIMIT, now)) - now;
    qPitch.setFromAxisAngle(levelRight(dir, axis), pitch);
    qYaw.setFromAxisAngle(UP, yaw).multiply(qPitch);
    offset.subVectors(camera.position, pivot).applyQuaternion(qYaw);
    camera.position.addVectors(pivot, offset);
    controls.target.addVectors(camera.position, dir.applyQuaternion(qYaw));
    camera.lookAt(controls.target);
    anim = null;
  }

  function glideTo(pos, target) {
    anim = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone() };
  }

  return {
    setHome(pos, target) { home.pos.copy(pos); home.target.copy(target); },
    setSpeed(s) { speed = s; },
    setMaxSpeed(v) { maxSpeed = v; },
    reset(instant = false) {
      if (instant) {
        camera.position.copy(home.pos);
        controls.target.copy(home.target);
        controls.update();
        return;
      }
      glideTo(home.pos, home.target);
    },
    // Glides to look at `point` from `dist` away, the way the view faces now.
    focus(point, dist) {
      dir.subVectors(controls.target, camera.position);
      if (dir.lengthSq() < 1e-18) camera.getWorldDirection(dir);
      glideTo(dir.normalize().multiplyScalar(-dist).add(point), point);
    },
    get moving() { return [...keys].some((k) => !k.startsWith('Shift')); },
    // Mouse look by (dx, dy) px, first person's: its sensitivity, slowed by the god
    // view's narrower FOV as first person's zoom slows it (HL2's zoom_sensitivity_ratio 1).
    look(dx, dy) {
      const k = LOOK_SENSITIVITY * sensitivity() * Math.min(1, camera.fov / povFov());
      const cx = THREE.MathUtils.clamp(dx, -LOOK_MAX_PX, LOOK_MAX_PX);
      const cy = THREE.MathUtils.clamp(dy, -LOOK_MAX_PX, LOOK_MAX_PX);
      turnAbout(-cx * k, -cy * k, eye.copy(camera.position));
    },
    // Orbit `pivot` by a drag of (dx, dy) px on a view `height` px tall: the world turns with the drag.
    orbit(dx, dy, pivot, height) {
      const k = 2 * Math.PI * ORBIT_TURNS_PER_HEIGHT / Math.max(1, height);
      turnAbout(-dx * k, -dy * k, pivot);
    },
    update(dt) {
      if (anim) {
        anim.t = Math.min(1, anim.t + dt / GLIDE_S);
        const k = 1 - Math.pow(1 - anim.t, 3);
        camera.position.lerpVectors(anim.p0, anim.p1, k);
        controls.target.lerpVectors(anim.t0, anim.t1, k);
        if (anim.t >= 1) anim = null;
      }
      if (!keys.size || isTyping()) return;
      const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? FAST : 1;
      // forward is the look itself, pitch included (noclip); strafing stays level, E and Q go straight up and down
      fwd.subVectors(controls.target, camera.position);
      const dist = fwd.length();
      if (dist < 1e-9) camera.getWorldDirection(fwd); else fwd.divideScalar(dist);
      levelRight(fwd, right);
      move.set(0, 0, 0);
      if (keys.has('KeyW')) move.add(fwd);
      if (keys.has('KeyS')) move.sub(fwd);
      if (keys.has('KeyD')) move.add(right);
      if (keys.has('KeyA')) move.sub(right);
      if (keys.has('KeyE')) move.add(UP);
      if (keys.has('KeyQ')) move.sub(UP);
      if (move.lengthSq() === 0) return;
      // scale with how far we are from what we're looking at, so close-ups stay controllable
      move.normalize().multiplyScalar(Math.min(THREE.MathUtils.clamp(dist * 0.6, 1.2, 14) * speed * fast, maxSpeed) * dt);
      camera.position.add(move);
      controls.target.add(move);
      anim = null;
    },
  };
}

// The god view's mouse: a right drag looks around (the cursor hidden and held by
// Pointer Lock while it does; if the browser refuses, plain movement still
// turns), Alt + left drag orbits pivot() (the point under the cursor at the
// press; null: the orbit target). A right click that doesn't drag is left to
// brushInput.js's erase, which tells a click from a drag by the same DRAG_PX.
// The wheel with the right button held calls flySpeed(notches: + faster) instead of zooming.
// enabled(): the god view has the mouse (not first person).
export function bindCameraMouse(canvas, rig, controls, { enabled = () => true, pivot = () => null, flySpeed = () => {} } = {}) {
  const doc = canvas.ownerDocument, view = doc.defaultView;
  let drag = null;       // { kind: 'look' | 'orbit', id, x, y, active, pivot }
  let lock = 'none';     // our Pointer Lock: 'none', 'pending' (asked for), 'held'
  const exitLock = () => { if (doc.pointerLockElement === canvas) doc.exitPointerLock(); };
  function requestLock() {
    lock = 'pending';
    try {
      canvas.requestPointerLock()?.catch?.(() => { if (lock === 'pending') lock = 'none'; });
    } catch { lock = 'none'; }
  }
  function end() {
    drag = null;
    // (a lock still pending is let go when it lands; first person keeps one it took over)
    if (lock === 'held') { if (enabled()) exitLock(); else lock = 'none'; }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    // OrbitControls' right button pans with Shift (its rotate turns into a pan with Shift held), else it's ours
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.RIGHT = e.shiftKey ? THREE.MOUSE.ROTATE : null;
    if (drag || !enabled()) return;
    if (e.button === 2 && !e.shiftKey) drag = { kind: 'look', id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
    else if (e.button === 0 && e.altKey) drag = { kind: 'orbit', id: e.pointerId, active: true, pivot: pivot() ?? controls.target.clone() };
  }, true);
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!enabled() || !(e.buttons & (drag.kind === 'look' ? 2 : 1))) { end(); return; }
    let dx = e.movementX, dy = e.movementY;
    if (!drag.active) {
      dx = e.clientX - drag.x; dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) < DRAG_PX) return;   // still a click: the erase's
      drag.active = true;
      requestLock();
    }
    if (drag.kind === 'look') rig.look(dx, dy);
    else rig.orbit(dx, dy, drag.pivot, canvas.clientHeight);
  }, true);
  view.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.id && e.button === (drag.kind === 'look' ? 2 : 0)) end();
  }, true);
  view.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) end(); }, true);
  view.addEventListener('blur', end);
  canvas.addEventListener('wheel', (e) => {
    if (!enabled() || !(drag?.kind === 'look' || (e.buttons & 2))) return;
    e.preventDefault();
    e.stopImmediatePropagation();   // (no zoom, nor Shift's brush size)
    const d = e.deltaY || e.deltaX;
    if (d) flySpeed(d < 0 ? 1 : -1);
  }, { capture: true, passive: false });
  doc.addEventListener('pointerlockchange', () => {
    if (doc.pointerLockElement === canvas) {
      if (lock !== 'pending') return;
      lock = 'held';
      if (!drag?.active) end();   // the button came up before the lock landed
    } else if (lock === 'held') lock = 'none';   // (Esc mid-drag: the look goes on unlocked)
  });
  return { get dragging() { return drag?.active ? drag.kind : null; } };
}
