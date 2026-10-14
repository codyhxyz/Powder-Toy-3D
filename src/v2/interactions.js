import { TOOLS, PROP_TOOL } from '../elements.js';
import { PROP } from '../editing.js';
import { PHYS } from '../physics.js';
import { ROCKET } from '../shaders/povTools.js';
import { specialBlastEnergy } from './pressure.js';
import { worldPosition } from './tools.js';

const ids = Object.fromEntries(TOOLS.map(t => [t.key, t.id]));
const pendingPaint = new Set(['VACUUM', 'CYCLONE', 'GRAV_IN', 'GRAV_OUT'].map(k => ids[k]));
const pendingPOV = new Set(['povKick', 'povStrike', 'povField']);
function refused(sim, reason) {
  sim.nativeInteractionResult = { status: 'rejected', reason };
  return false;
}
function blast(sim, center, radius, pressure) {
  const d = sim.compactOwner?.dynamics;
  if (!d?.isReady || sim.nativeTransition || sim.nativeTransitionError) return refused(sim, 'native external blast unavailable');
  // Powder Toy pressure calibration, same acoustic J/Pa conversion as native
  // voxel charges. External sources allocate half (not quarter) to air, hence /2.
  sim.compactOwner.sync();
  const result = d.applyExternalBlast({ position: worldPosition(sim, center), radius, energy: specialBlastEnergy(pressure) / 2 });
  sim.nativeInteractionResult = result;
  if (result.status !== 'queued') return false;
  sim.wake();
  return true;
}
// null means this router does not own the tool. false is an explicit refusal:
// never run a legacy B writer and report success when native import ignores it.
export function routeNativePaint(sim, stroke) {
  const { tool, prop, center, end = center, radius, shape, grow, mask, filter = -1, erase } = stroke;
  if (pendingPaint.has(tool) || (tool === PROP_TOOL && [PROP.VX, PROP.VY, PROP.VZ, PROP.PRESSURE].includes(prop?.field)))
    return refused(sim, 'native shaped forcing is not implemented yet');
  if (tool !== ids.BLAST) return null;
  const sameEnd = ['x', 'y', 'z'].every(k => center[k] === end[k]);
  if (shape !== 0 || mask || filter !== -1 || erase || !sameEnd || grow?.some(v => v !== 0))
    return refused(sim, 'external blast currently requires an unfiltered spherical dab');
  return blast(sim, center, radius, PHYS.TOOL_PRESSURE);
}
export function routeNativePOV(sim, name, box, values) {
  if (pendingPOV.has(name)) return refused(sim, `${name} native forcing is not implemented yet`);
  if (name !== 'povRocket') return null;
  if (!box) return refused(sim, 'rocket has no active bounds');
  // Do not silently expand a caller's clipped bounds. Standard rocket callers
  // supply this radius; custom sub-boxes must wait for shaped external sources.
  const center = values.center, dims = [sim.g.nx, sim.g.ny, sim.g.nz];
  if (center.some((v, a) => box.lo[a] > Math.max(0, Math.ceil(v - ROCKET.PULSE_RADIUS - 0.5)) ||
    box.hi[a] < Math.min(dims[a] - 1, Math.floor(v + ROCKET.PULSE_RADIUS - 0.5))))
    return refused(sim, 'rocket bounds do not contain its native blast sphere');
  return blast(sim, center, ROCKET.PULSE_RADIUS, ROCKET.PULSE_P);
}
