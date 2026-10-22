import { GRAV, AIR, EDGE, SIM_MODE_DEFAULTS } from '../simModes.js';
import { CELL_M } from '../scale.js';
import { GRAVITY_MS2 } from './gravity.js';
export { GRAVITY_MS2 };

// The saved slider remains dimensionless relative to the shipped .025 default.
// Native physics pulls with V1's gravity (v2/gravity.js GRAVITY_MS2: V1's 0.025 cells/step² at
// 240 steps/s, in m/s²), consistently in every owner. The first-person body is not a grid owner:
// it falls at Noita's 5.4 g under both engines, along gravityAt (pov/player.js).
const GRAVITY_SETTING_REFERENCE = 0.025;
export const MODE_FIELDS = { gravMode: 'u32', edge: 'u32', airMode: 'u32', ambientHeat: 'u32', gravity: 'f32', ambient: 'f32' };
const mode = (value, values, name) => {
  if (!Object.values(values).includes(value)) throw new RangeError(`Unknown native ${name}: ${value}`);
  return value;
};
export function nativeModes(sim) {
  const gravMode = mode(sim.gravityMode ?? SIM_MODE_DEFAULTS.gravityMode, GRAV, 'gravity mode');
  const airMode = mode(sim.airMode ?? SIM_MODE_DEFAULTS.airMode, AIR, 'air mode');
  const requestedEdge = mode(sim.edgeMode ?? SIM_MODE_DEFAULTS.edgeMode, EDGE, 'edge mode');
  const setting = sim._gravity ?? sim.gravity ?? GRAVITY_SETTING_REFERENCE;
  const ambient = sim.airT ?? 20;
  const heat = sim.ambientHeat ?? true;
  if (typeof heat !== 'boolean') throw new TypeError('Native ambientHeat must be boolean');
  if (!Number.isFinite(setting) || setting < 0 || !Number.isFinite(Math.fround(setting / GRAVITY_SETTING_REFERENCE * GRAVITY_MS2))) throw new RangeError('Invalid native gravity magnitude');
  if (!Number.isFinite(ambient)) throw new RangeError('Invalid native ambient temperature');
  return { gravMode, edge: sim.g?.windowed ? EDGE.SOLID : requestedEdge, airMode, ambientHeat: +heat,
    gravity: gravMode === GRAV.OFF ? 0 : setting / GRAVITY_SETTING_REFERENCE * GRAVITY_MS2, ambient };
}
export const modeSignature = p => Object.keys(MODE_FIELDS).map(k => p[k]).join('|');
export function gravityAt(position, dims, p) {
  if (p.gravMode === GRAV.OFF || p.gravity === 0) return [0, 0, 0];
  if (p.gravMode === GRAV.VERTICAL) return [0, -p.gravity, 0];
  if (p.gravMode !== GRAV.RADIAL) throw new RangeError('Unknown native gravity mode');
  const d = dims.map((n, a) => n / 2 - position[a]), length = Math.hypot(...d);
  return d.map(x => length ? p.gravity * x / length : 0);
}
export function gravityPotential(position, dims, p) {
  if (p.gravMode === GRAV.OFF) return 0;
  return p.gravity / GRAVITY_MS2 * (p.gravMode === GRAV.RADIAL ? Math.hypot(...position.map((x, a) => x - dims[a] / 2)) : position[1]);
}
export function edgeCell(position, dims, edge) {
  mode(edge, EDGE, 'edge mode');
  if (edge === EDGE.LOOP) return position.map((x, a) => ((x % dims[a]) + dims[a]) % dims[a]);
  return position.every((x, a) => x >= 0 && x < dims[a]) ? [...position] : null;
}
// The grid's own field in POV units (cells/s², not metres). The first-person
// body takes only gravityAt's direction and keeps Noita's strength under both
// engines (pov/player.js), so a jump is the same height under V1 and V2.
export function nativeBodyGravity(sim, localPosition) {
  return gravityAt(localPosition, [sim.g.nx, sim.g.ny, sim.g.nz], nativeModes(sim)).map(x => x / CELL_M);
}
export function ballisticModes(position, velocity, dt, dims, p) {
  const a = gravityAt(position, dims, p);
  return { position: position.map((x, i) => x + (velocity[i] * dt + a[i] * dt * dt / 2) / CELL_M),
    velocity: velocity.map((x, i) => x + a[i] * dt) };
}
