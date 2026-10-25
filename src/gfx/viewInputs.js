import { DETAIL, settingKey } from './detail.js';

// Only settings read directly by rendering belong in its cache key. Simulation,
// camera and brush controls are observed through their resulting state instead.
const VIEW_SETTINGS = ['view', 'upscale', 'nearGI', 'glowLights', 'caustics', 'reflections', 'bending', ...DETAIL.map(settingKey)];
export function createViewSettings(settings) {
  return Object.defineProperties({}, Object.fromEntries(VIEW_SETTINGS.map((key) =>
    [key, { enumerable: true, get: () => settings[key] }])));
}

// Input asks the sleeping loop to check for changes; it does not mean the
// scene changed. In particular, DOM controls must not invalidate mesh-frame
// caches or restart TAA. Leave/cancel/blur also let the brush disappear at idle.
export function bindViewInputWake(target, wakeLoop) {
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'pointercancel',
    'wheel', 'keydown', 'keyup', 'input', 'change', 'resize', 'blur']) {
    target.addEventListener(type, wakeLoop, { capture: true, passive: true });
  }
}

// The brush is drawn by our passes, outside three's scene watch. Include its
// colour as well as its geometry, but ignore tool changes while it is hidden.
export function brushKey(brush, color) {
  let k = brush.visible ? `${color}|` : '';
  for (const m of Object.values(brush.parts)) {
    if (!m.visible) { k += '-|'; continue; }
    k += `${m.shape},${m.position.x},${m.position.y},${m.position.z},${m.scale.x},${m.scale.y},${m.scale.z},${m.quaternion.x},${m.quaternion.y},${m.quaternion.z},${m.quaternion.w}|`;
  }
  return k;
}
