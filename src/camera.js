import * as THREE from 'three';

const TURN_RATE = THREE.MathUtils.degToRad(90); // Q/E turn speed, rad/s

// WASD fly movement layered on top of OrbitControls (camera and orbit target
// move together), Q/E turning around the orbit target, plus an animated reset
// to the home view.
export function createCameraRig(camera, controls, isTyping) {
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

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3(), offset = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

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
      anim = { t: 0, p0: camera.position.clone(), t0: controls.target.clone() };
    },
    get moving() { return [...keys].some((k) => !k.startsWith('Shift')); },
    update(dt) {
      if (anim) {
        anim.t = Math.min(1, anim.t + dt / 0.6);
        const k = 1 - Math.pow(1 - anim.t, 3);
        camera.position.lerpVectors(anim.p0, home.pos, k);
        controls.target.lerpVectors(anim.t0, home.target, k);
        if (anim.t >= 1) anim = null;
      }
      if (!keys.size || isTyping()) return;
      const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1;
      const turn = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
      if (turn) {
        // swing the camera around the orbit target: Q turns the view left, E right
        offset.subVectors(camera.position, controls.target).applyAxisAngle(UP, turn * TURN_RATE * fast * dt);
        camera.position.addVectors(controls.target, offset);
        anim = null;
      }
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      right.crossVectors(fwd, UP).normalize();
      move.set(0, 0, 0);
      if (keys.has('KeyW')) move.add(fwd);
      if (keys.has('KeyS')) move.sub(fwd);
      if (keys.has('KeyD')) move.add(right);
      if (keys.has('KeyA')) move.sub(right);
      if (move.lengthSq() === 0) return;
      // scale with how far we are from what we're looking at, so close-ups stay controllable
      const dist = camera.position.distanceTo(controls.target);
      move.normalize().multiplyScalar(Math.min(THREE.MathUtils.clamp(dist * 0.6, 1.2, 14) * speed * fast, maxSpeed) * dt);
      camera.position.add(move);
      controls.target.add(move);
      anim = null;
    },
  };
}
