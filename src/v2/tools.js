import { rayKindOfTool, RAY_KIND, RAYS } from '../rays.js';
import { CELL_M } from '../scale.js';

export const nativeRayKind = tool => rayKindOfTool(tool) === RAY_KIND.PHOTON ? 'photon' : rayKindOfTool(tool) === RAY_KIND.NEUTRON ? 'neutron' : null;
export const worldPosition = (sim, p) => [p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]].map((v, i) => v + [sim.origin.x, sim.origin.y, sim.origin.z][i]);
export function nativeImpulse(sim, { position, direction, radius, acceleration, dt, deltaV }) {
  const d = [direction.x ?? direction[0], direction.y ?? direction[1], direction.z ?? direction[2]];
  const length = Math.hypot(...d);
  if (!length) return false;
  return sim.applyNativeTool({ kind: 'impulse', position: worldPosition(sim, position), direction: d.map(v => v / length), radius,
    // Continuous tools supply m/s² and actual committed native time; one-shot
    // actions supply delta-v. Never smuggle cells/legacy-step across this ABI.
    strength: deltaV ?? acceleration * dt });
}
export function emitNativeRay(sim, stroke, dt = 1 / 60) {
  const kind = nativeRayKind(stroke.tool);
  if (!kind || !sim.nativeCapabilities[kind]) return false;
  const vol = stroke.shape === 0 ? 4 / 3 * Math.PI * stroke.radius ** 3 : (2 * stroke.radius) ** 3;
  // Preserve the old 60-fps brush's per-second emission strength, but integrate
  // only actual native tick time. Fractional emissions survive frame boundaries.
  sim.nativeEmission ??= { photon: 0, neutron: 0 };
  const rate = Math.min(RAYS.RAY_PAINT_MAX, vol * RAYS.RAY_PAINT_PER_CELL * stroke.rate) * 60;
  const amount = Math.min(RAYS.RAY_PAINT_MAX, sim.nativeEmission[kind] + rate * dt), count = Math.floor(amount);
  if (!count) { sim.nativeEmission[kind] = amount; return true; }
  const accepted = sim.applyNativeTool({ kind, position: worldPosition(sim, stroke.center), direction: [0, 1, 0], radius: stroke.radius, strength: 0, count });
  sim.nativeEmission[kind] = accepted ? amount - count : amount;
  return accepted;
}
// Conversion for legacy-authored single-action tunings, not a timestep.
export const legacyVelocityToMS = cellsPerStep => cellsPerStep * 240 * CELL_M;
