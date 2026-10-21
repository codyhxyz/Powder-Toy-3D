import { createNativeForceKernel } from './nativeForcing.js';
import { createNativePaintKernel } from './nativePaint.js';
import { paintUpdateWGSL, PaintParams, paintDeclsWGSL, PAINT_LAYOUT } from '../shaders/passes.js';
import { kickWGSL, KickParams } from '../shaders/povKick.js';
import { strikeWGSL, StrikeParams } from '../shaders/povTrace.js';
import { povFieldWGSL, FieldParams } from '../shaders/povBody.js';
import { TOOLS, PROP_TOOL, E } from '../elements.js';
import { PROP } from '../editing.js';
import { PHYS } from '../physics.js';
import { ROCKET, blowWGSL, BlowParams, flameWGSL, FlameParams } from '../shaders/povTools.js';
import { burrowWGSL, BurrowParams, laserNativeWGSL, LaserNativeParams, LASER_NATIVE_LAYOUT, LASER, LASER_SEGMENT } from '../shaders/povBore.js';
import { wandApplyWGSL, WandParams } from '../shaders/wands.js';
import { scriptEditUpdateWGSL, ScriptEditParams, scriptEditDeclsWGSL, SCRIPT_EDIT_LAYOUT } from '../shaders/script.js';
import { specialBlastEnergy } from './pressure.js';
import { worldPosition } from './tools.js';

const ids = Object.fromEntries(TOOLS.map(t => [t.key, t.id]));
const pendingPaint = new Set(['VACUUM', 'CYCLONE', 'GRAV_IN', 'GRAV_OUT'].map(k => ids[k]));
// Tools whose V1 rule moves or retypes whole cells: the native paint kernel (nativePaint.js).
const nativeCellPaint = stroke => stroke.tool === ids.MIX || (stroke.tool === PROP_TOOL && stroke.prop?.field === PROP.TYPE);
// Tools whose V1 rule changes what a cell is or holds (passes.js update: Heat, Cool, Spark and the
// Property tool's type, temperature, life and ctype). V1's flying matter was grid cells, so they
// reach V2's particles too (nativePaint.js particleCommit); the grid cells keep their own route.
const particleRule = stroke => [ids.HEAT, ids.COOL, ids.SPARK].includes(stroke.tool) ||
  (stroke.tool === PROP_TOOL && [PROP.TYPE, PROP.TEMP, PROP.LIFE, PROP.CTYPE].includes(stroke.prop?.field));
// The POV writers whose V1 rule sets velocity or pressure, or throws matter, as native forcing: V1's
// update on the frozen native grid, its motion as V2 launches and air (nativeForcing.js).
//   povBlow (axe, pickaxe, knife, jackhammer, a worm's bite): V1's fracture into debris with the
//     cut's spare energy as the chip's speed, renamed at once so the melee gather's take finds the
//     debris where V1's did (tools/melee.js flushes the launches after it);
//   povBurrow: the bore's debris and its conveyor's spoil thrown back out of it;
//   povFlame (flamethrower, torch, a burning body): air into fire at the flame's temperature and
//     life (a new cell, not a fracture), the stream as the air's wind, heat as energy;
//   povWand: a wand's dig, emit, place, erase, heat and its pressure, attract/repel and velocity;
//   povLaser: the laser cannon's beam over its segments (nativeLaser): heat as energy, its core
//     vaporised as V2's own boiling converts (vaporise: energy-exact, so a thin film's steam is the
//     film's), the rim's spalled debris left at rest on the grid, the plume as the air's wind.
const LASER_REST='if(all(r.motion.xyz==vec3f(0.0))) { flags&=~1u; }'; // (debris the rule sets at rest stays on the grid, as V1's B=0 leaves it)
const forceSpecs={povKick:{update:kickWGSL,params:KickParams},povStrike:{update:strikeWGSL,params:StrikeParams},povField:{update:povFieldWGSL,params:FieldParams},
  povBlow:{update:blowWGSL,params:BlowParams,commit:{renameNow:true}},povBurrow:{update:burrowWGSL,params:BurrowParams},
  povFlame:{update:flameWGSL,params:FlameParams,commit:{sources:true}},povWand:{update:wandApplyWGSL,params:WandParams,commit:{sources:true}},
  povLaser:{update:laserNativeWGSL,params:LaserNativeParams,layout:LASER_NATIVE_LAYOUT,commit:{vaporise:true,sparse:true,motion:{flags:LASER_REST}}}};
// The melee blow's launches wait for its gather (nativeForcing.js defer).
// The console's writes (shaders/script.js: partCreate, partKill, partProperty, sim.pressure, ...):
// a created or retyped cell is a new cell as V1 makes it, temperature as heat, life and ctype as
// V1 sets them, vx/vy/vz as launches or the air's wind, pressure as the air's.
const scriptSpec={update:scriptEditUpdateWGSL,params:ScriptEditParams,decls:scriptEditDeclsWGSL,layout:SCRIPT_EDIT_LAYOUT,commit:{sources:true,life:true}};
export const nativeScriptKernel=sim=>forceKernel(sim,'nativeScriptEdit');
const deferred=new Set(['povBlow']);
const forces=new WeakMap();
function forceKernel(sim,name) {
  let cache=forces.get(sim);if(!cache || cache.owner!==sim.compactOwner) {cache={owner:sim.compactOwner,kernels:new Map()};forces.set(sim,cache);}
  let kernel=cache.kernels.get(name);
  if(!kernel && name==='nativePaint') cache.kernels.set(name,kernel=createNativePaintKernel(sim));
  if(!kernel) {
    const spec=name==='nativePaintForce'?{update:paintUpdateWGSL,params:PaintParams,decls:paintDeclsWGSL(sim.g),layout:PAINT_LAYOUT}:name==='nativeScriptEdit'?scriptSpec:forceSpecs[name];
    cache.kernels.set(name,kernel=createNativeForceKernel(sim,name,spec));
  }
  return kernel;
}
export const prepareNativePOVForces=sim=>Promise.all(Object.keys(forceSpecs).map(name=>forceKernel(sim,name).ready));
// The god-view brush's native kernels build with the native owner (sim.prepareNative), as V1's
// paint pass builds with the simulation: the first stroke never finds them still compiling.
export const NATIVE_BRUSH_KERNELS=['nativePaintForce','nativePaint'];
export const prepareNativeBrush=sim=>Promise.all(NATIVE_BRUSH_KERNELS.map(name=>forceKernel(sim,name).ready));
export const nativePOVForcesReady=sim=>Object.keys(forceSpecs).every(name=>forces.get(sim)?.owner===sim.compactOwner && forces.get(sim).kernels.get(name)?.isReady);
function force(sim,name,box,values,source,opts) {
  const accepted=forceKernel(sim,name).run(box,values,source,opts);
  sim.nativeInteractionResult=accepted?{status:'queued',fallback:'capacity-limited packets remain exact on grid; capacityFallbacks counts refused launches'}:{status:'rejected',reason:'native force kernel not ready or empty bounds'};
  return accepted;
}
function refused(sim, reason) {
  sim.nativeInteractionResult = { status: 'rejected', reason };
  return false;
}
function blast(sim, center, radius, pressure, selection) {
  const d = sim.compactOwner?.dynamics;
  if (!d?.isReady || sim.nativeTransition || sim.nativeTransitionError) return refused(sim, 'native external blast unavailable');
  // Powder Toy pressure calibration, same acoustic J/Pa conversion as native
  // voxel charges. External sources allocate half (not quarter) to air, hence /2.
  sim.compactOwner.sync();
  const result = d.applyExternalBlast({ position: worldPosition(sim, center), radius, energy: specialBlastEnergy(pressure) / 2, ...(selection?{selection}:{}) });
  sim.nativeInteractionResult = result;
  if (result.status !== 'queued') return false;
  sim.wake();
  return true;
}
// null means this router does not own the tool. false is an explicit refusal:
// never run a legacy B writer and report success when native import ignores it.
export function routeNativePaint(sim, stroke) {
  const { tool, prop, center, end = center, radius, shape, grow, mask, filter = -1, erase } = stroke;
  const erases = tool === ids.ERASE || (tool >= 0 && erase) || (tool === PROP_TOOL && prop?.field === PROP.TYPE && prop.value === E.EMPTY);
  if (nativeCellPaint(stroke) || erases || particleRule(stroke)) {
    const a=[center.x,center.y,center.z],b=[end.x,end.y,end.z],reach=a.map((_,k)=>radius+Math.max(grow?.[k]??0,0));
    const box=mask?{lo:mask.lo,hi:mask.hi}:sim.touchCentres(a.map((x,k)=>Math.min(x,b[k])-reach[k]),a.map((x,k)=>Math.max(x,b[k])+reach[k]));
    const grid=nativeCellPaint(stroke);
    // (an erase of grid cells stays the edit intent's replacement, which is exact; it follows in sim.paint,
    // as do Heat, Cool, Spark and the Property tool's temperature, life and ctype on grid cells)
    const accepted=forceKernel(sim,'nativePaint').run(box,{center:a,end:b,radius,shape,tool,rate:stroke.rate??1,replace:+!!stroke.replace,
      frame:grid?++sim.paints:sim.paints+1,wind:stroke.wind??[0,0,0],grow:grow??[0,0,0],masked:+!!mask,filter_:filter,del:+!!erase,prop:prop?.field??0,propValue:prop?.value??0},mask?.data,{grid,particles:erases||particleRule(stroke)});
    if (!grid) return null;
    sim.nativeInteractionResult=accepted?{status:'queued'}:{status:'rejected',reason:'native paint kernel not ready or empty bounds'};
    return accepted;
  }
  if (pendingPaint.has(tool) || (tool === PROP_TOOL && [PROP.VX, PROP.VY, PROP.VZ, PROP.PRESSURE].includes(prop?.field)))
  {
    const a=[center.x,center.y,center.z],b=[end.x,end.y,end.z],reach=a.map((_,k)=>radius+Math.max(grow?.[k]??0,0));
    const box=mask?{lo:mask.lo,hi:mask.hi}:sim.touchCentres(a.map((x,k)=>Math.min(x,b[k])-reach[k]),a.map((x,k)=>Math.max(x,b[k])+reach[k]));
    return force(sim,'nativePaintForce',box,{center:a,end:b,radius,shape,tool,rate:stroke.rate??1,replace:+!!stroke.replace,
      frame:++sim.paints,wind:stroke.wind??[0,0,0],grow:grow??[0,0,0],masked:+!!mask,filter_:filter,del:+!!erase,prop:prop?.field??0,propValue:prop?.value??0},mask?sim._paintMask(mask.data):sim.noMask);
  }
  if (tool !== ids.BLAST) return null;
  const selection={shape,end:worldPosition(sim,end),grow:grow??[0,0,0],filter,fade:true};
  if(mask) {
    const bytes=new Uint8Array(Math.ceil(sim.g.width*sim.g.height/4)*4);
    bytes.set(mask.data.subarray(0,bytes.length));selection.maskWords=new Uint32Array(bytes.buffer);
    selection.maskOrigin=[sim.origin.x,sim.origin.y,sim.origin.z];
    selection.lo=mask.lo.map((v,a)=>Math.ceil(v)+selection.maskOrigin[a]);selection.hi=mask.hi.map((v,a)=>Math.floor(v)+selection.maskOrigin[a]);
  }
  return blast(sim, center, radius, PHYS.TOOL_PRESSURE, selection);
}
export function routeNativePOV(sim, name, box, values) {
  if (forceSpecs[name]) return force(sim,name,box,values,undefined,{defer:deferred.has(name)});
  if (name !== 'povRocket') return null;
  if (!box) return refused(sim, 'rocket has no active bounds');
  const origin=[sim.origin.x,sim.origin.y,sim.origin.z];
  return blast(sim,values.center,ROCKET.PULSE_RADIUS,ROCKET.PULSE_P,{shape:0,end:worldPosition(sim,values.center),grow:[0,0,0],filter:-1,fade:false,
    lo:box.lo.map((v,a)=>Math.ceil(v)+origin[a]),hi:box.hi.map((v,a)=>Math.floor(v)+origin[a])});
}
// V2's laser shot (src/pov/gpu.js laser), after the reach kernel wrote its shot into `beam`: V1's
// beam rule (shaders/povBore.js laser) on V2's own cells over the beam's segments, the reach read
// from the shot on the GPU, so nothing waits for it. Each segment's box is its stretch of the axis
// [segFrom, segTo) padded by the rim, as V1's reach kernel pads the apply's box (RIM_RADIUS + 1);
// the stretches cover the longest beam the rule reaches (LENGTH + RIM_RADIUS: the round end).
export const nativeLaserReady = sim => forceKernel(sim,'povLaser').isReady;
export function laserSegments(muzzle, dir) {
  const span=LASER.LENGTH+LASER.RIM_RADIUS, pad=LASER.RIM_RADIUS+1, parts=[];
  const at=t=>muzzle.map((m,i)=>m+dir[i]*t);
  for(let from=0;from<span;from+=LASER_SEGMENT) {
    const a=at(from),b=at(from+LASER_SEGMENT);
    parts.push({box:{lo:a.map((v,i)=>Math.floor(Math.min(v,b[i])-pad)),hi:a.map((v,i)=>Math.floor(Math.max(v,b[i])+pad))},values:{segFrom:from,segTo:from+LASER_SEGMENT}});
  }
  return parts;
}
const EVERY_SEGMENT=3e38; // (the particle pass: a particle is evaluated once, whichever stretch it is in)
export function nativeLaser(sim, muzzle, dir, beam) {
  const parts=laserSegments(muzzle,dir);
  const union={lo:[0,1,2].map(a=>Math.min(...parts.map(q=>q.box.lo[a]))),hi:[0,1,2].map(a=>Math.max(...parts.map(q=>q.box.hi[a])))};
  return force(sim,'povLaser',union,{muzzle,dir,segFrom:-EVERY_SEGMENT,segTo:EVERY_SEGMENT},beam,{parts});
}
// Allocates the launches a deferred writer left for its take (dynamics.js flushLaunch); a no-op on V1.
export function flushNativeLaunch(sim) { return sim?.compact?.dynamics?.flushLaunch?.() ?? false; }
