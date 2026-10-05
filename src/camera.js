import * as THREE from 'three';

// WASD/QE fly movement layered on top of OrbitControls (camera and orbit
// target move together), plus an animated reset to the home view.
export function createCameraRig(camera, controls, isTyping) {
  const keys = new Set();
  const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  let anim = null;
  let speed = 1;

  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
  addEventListener('keydown', (e) => {
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (MOVE.has(e.code)) keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  return {
    setHome(pos, target) { home.pos.copy(pos); home.target.copy(target); },
    setSpeed(s) { speed = s; },
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
      if (keys.has('KeyE')) move.y += 1;
      if (keys.has('KeyQ')) move.y -= 1;
      if (move.lengthSq() === 0) return;
      // scale with how far we are from what we're looking at, so close-ups stay controllable
      const dist = camera.position.distanceTo(controls.target);
      const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1;
      move.normalize().multiplyScalar(THREE.MathUtils.clamp(dist * 0.6, 1.2, 14) * speed * fast * dt);
      camera.position.add(move);
      controls.target.add(move);
      anim = null;
    },
  };
}
