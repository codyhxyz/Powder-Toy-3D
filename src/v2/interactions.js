import { createNativeForceKernel } from './nativeForcing.js';
import { paintUpdateWGSL, PaintParams, paintDeclsWGSL, PAINT_LAYOUT } from '../shaders/passes.js';
import { kickWGSL, KickParams } from '../shaders/povKick.js';
import { strikeWGSL, StrikeParams } from '../shaders/povTrace.js';
import { povFieldWGSL, FieldParams } from '../shaders/povBody.js';
import { TOOLS, PROP_TOOL } from '../elements.js';
import { PROP } from '../editing.js';
import { PHYS } from '../physics.js';
import { ROCKET } from '../shaders/povTools.js';
import { specialBlastEnergy } from './pressure.js';
import { worldPosition } from './tools.js';

const ids = Object.fromEntries(TOOLS.map(t => [t.key, t.id]));
const pendingPaint = new Set(['VACUUM', 'CYCLONE', 'GRAV_IN', 'GRAV_OUT'].map(k => ids[k]));
const forceSpecs={povKick:{update:kickWGSL,params:KickParams},povStrike:{update:strikeWGSL,params:StrikeParams},povField:{update:povFieldWGSL,params:FieldParams}};
const forces=new WeakMap();
function forceKernel(sim,name) {
  let cache=forces.get(sim);if(!cache || cache.owner!==sim.compactOwner) {cache={owner:sim.compactOwner,kernels:new Map()};forces.set(sim,cache);}
  let kernel=cache.kernels.get(name);
  if(!kernel) {
    const spec=name==='nativePaintForce'?{update:paintUpdateWGSL,params:PaintParams,decls:paintDeclsWGSL(sim.g),layout:PAINT_LAYOUT}:forceSpecs[name];
    cache.kernels.set(name,kernel=createNativeForceKernel(sim,name,spec));
  }
  return kernel;
}
export const prepareNativePOVForces=sim=>Promise.all(Object.keys(forceSpecs).map(name=>forceKernel(sim,name).ready));
export const nativePOVForcesReady=sim=>Object.keys(forceSpecs).every(name=>forces.get(sim)?.owner===sim.compactOwner && forces.get(sim).kernels.get(name)?.isReady);
function force(sim,name,box,values,source) {
  const accepted=forceKernel(sim,name).run(box,values,source);
  sim.nativeInteractionResult=accepted?{status:'queued',fallback:'capacity-limited packets remain exact on grid; capacityFallbacks counts refused launches'}:{status:'rejected',reason:'native force kernel not ready or empty bounds'};
  return accepted;
}
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
  {
    const a=[center.x,center.y,center.z],b=[end.x,end.y,end.z],reach=a.map((_,k)=>radius+Math.max(grow?.[k]??0,0));
    const box=mask?{lo:mask.lo,hi:mask.hi}:sim.touchCentres(a.map((x,k)=>Math.min(x,b[k])-reach[k]),a.map((x,k)=>Math.max(x,b[k])+reach[k]));
    return force(sim,'nativePaintForce',box,{center:a,end:b,radius,shape,tool,rate:stroke.rate??1,replace:+!!stroke.replace,
      frame:++sim.paints,wind:stroke.wind??[0,0,0],grow:grow??[0,0,0],masked:+!!mask,filter_:filter,del:+!!erase,prop:prop?.field??0,propValue:prop?.value??0},mask?sim._paintMask(mask.data):sim.noMask);
  }
  if (tool !== ids.BLAST) return null;
  const sameEnd = ['x', 'y', 'z'].every(k => center[k] === end[k]);
  if (shape !== 0 || mask || filter !== -1 || erase || !sameEnd || grow?.some(v => v !== 0))
    return refused(sim, 'external blast currently requires an unfiltered spherical dab');
  return blast(sim, center, radius, PHYS.TOOL_PRESSURE);
}
export function routeNativePOV(sim, name, box, values) {
  if (forceSpecs[name]) return force(sim,name,box,values);
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
