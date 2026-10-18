import { rayKindOfTool, RAY_KIND, RAYS } from '../rays.js';
import { CELL_M } from '../scale.js';
import { strokeDabs } from '../editing.js';

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
// A line or box of a particle tool: V1 paints each dab of it once (sim.js paint
// -> raysLayer.paint: ceil(volume x RAY_PAINT_PER_CELL x rate) particles a dab).
export const isRayShape = stroke => !!stroke.grow?.some?.(g => g > 0) || (!!stroke.end && stroke.end !== stroke.center &&
  (stroke.end.x !== stroke.center.x || stroke.end.y !== stroke.center.y || stroke.end.z !== stroke.center.z));
const brushVolume = stroke => stroke.shape === 0 ? 4 / 3 * Math.PI * stroke.radius ** 3 : (2 * stroke.radius) ** 3;
export function emitNativeRayShape(sim, stroke) {
  const kind = nativeRayKind(stroke.tool);
  if (!kind) return false;
  const count = Math.min(RAYS.RAY_PAINT_MAX, Math.ceil(brushVolume(stroke) * RAYS.RAY_PAINT_PER_CELL * stroke.rate));
  if (!count) return true;
  let accepted = false;
  for (const c of strokeDabs(stroke.center, stroke.end ?? stroke.center, stroke.grow ?? undefined, stroke.radius))
    accepted = sim.applyNativeTool({ kind, position: worldPosition(sim, c), direction: [0, 1, 0], radius: stroke.radius, strength: 0, count }) || accepted;
  return accepted;
}
export function emitNativeRay(sim, stroke, dt = 1 / 60) {
  const kind = nativeRayKind(stroke.tool);
  if (!kind) return false;
  if (isRayShape(stroke)) return emitNativeRayShape(sim, stroke);
  // Preserve the old 60-fps brush's per-second emission strength, but integrate
  // only actual native tick time. Fractional emissions survive frame boundaries.
  sim.nativeEmission ??= { photon: 0, neutron: 0 };
  const rate = Math.min(RAYS.RAY_PAINT_MAX, brushVolume(stroke) * RAYS.RAY_PAINT_PER_CELL * stroke.rate) * 60;
  const amount = Math.min(RAYS.RAY_PAINT_MAX, sim.nativeEmission[kind] + rate * dt), count = Math.floor(amount);
  if (!count) { sim.nativeEmission[kind] = amount; return true; }
  const accepted = sim.applyNativeTool({ kind, position: worldPosition(sim, stroke.center), direction: [0, 1, 0], radius: stroke.radius, strength: 0, count });
  sim.nativeEmission[kind] = accepted ? amount - count : amount;
  return accepted;
}
// A held particle brush that isn't the local one (a multiplayer guest's, which reaches the host
// as one stroke a guest frame): held, as the host's own is (app.js paintNativeRay), and emitted
// once per native tick for the tick's 1/60 s, so its rate is the host's local brush rate whatever
// the frame or network cadence. Lines and boxes paint their dabs at once, as V1's do.
export function holdNativeRay(sim, key, stroke) {
  if (!sim.compact || !nativeRayKind(stroke.tool)) return false;
  if (isRayShape(stroke)) return emitNativeRayShape(sim, stroke);
  (sim.nativeHeldRays ??= new Map()).set(key, stroke);
  sim.compact.wake?.();
  return true;
}
export const heldNativeRays = sim => sim.nativeHeldRays?.size ?? 0;
// Each native tick (app.js nativeBeforeStep): every held brush emits for dt; after a frame's ticks
// ran they are released, and the next stroke holds them again.
export function emitHeldNativeRays(sim, dt) { for (const stroke of sim.nativeHeldRays?.values() ?? []) emitNativeRay(sim, stroke, dt); }
export function releaseHeldNativeRays(sim) { sim.nativeHeldRays?.clear(); }
// Conversion for legacy-authored single-action tunings, not a timestep.
export const legacyVelocityToMS = cellsPerStep => cellsPerStep * 240 * CELL_M;
