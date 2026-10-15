// WORLD Plain is the original voxel-face look, evaluated along global raw rays.
// No local face pool, field smoothing, artificial world-side wall or far tier.
import { prelude } from './common.js';
import { materialsGLSL } from '../gfx/materials.js';
import { ddaGLSL } from './gfx/core.js';
import { presentationNearWGSL } from './gfx/presentation.js';
import { worldAccessWGSL } from './worldAccess.js';
import { worldQueryWGSL } from './worldRenderBackend.js';
import { blockClassesWGSL, blockVisibilityWGSL, blockFaceMetadataWGSL, blockFaceAOWGSL,
  blockLookConstantsWGSL, blockLookHelpersWGSL, blockLookWGSL } from './blockPlainShared.js';

export const worldPlainClassesWGSL = /* wgsl */ `
${blockClassesWGSL}
${blockVisibilityWGSL}
fn classAt(c: vec3i) -> u32 {
  // Real exterior only. The original WORLD view has no synthetic floor quad.
  if (c.x < 0 || c.z < 0 || c.x >= NX || c.z >= NZ || c.y >= NY) { return CL_NONE; }
  if (c.y < 0) { return CL_OPAQUE; }
  return classOf(eid(fetchA(c)));
}
fn occ(c: vec3i) -> u32 { return select(0u, 1u, classAt(c) == CL_OPAQUE); }
`;
export const worldPlainSpanWGSL = /* wgsl */ `
struct PlainSpan {
  cell: vec3i, start: vec3f, end: vec3f,
  inAxis: i32, outAxis: i32, inStep: i32, outStep: i32,
  entry: bool, valid: bool,
}
`;
// Both render and picker use these exact original DDA / quadratic helpers.
// next() advances one complete cell, never an epsilon-moved or clamped ray.
export function worldPlainWalkWGSL({ curved = false, prefix = 'plain' } = {}) {
  if (curved) return /* wgsl */ `
struct ${prefix}Walk { walk: WarpWalk }
fn ${prefix}Start(ro: vec3f, rd: vec3f, nearT: f32) -> ${prefix}Walk {
  return ${prefix}Walk(warpWalk(ro,rd,nearT));
}
fn ${prefix}Next(w: ptr<function, ${prefix}Walk>) -> PlainSpan {
  var s: PlainSpan;
  if (!warpLocate(&(*w).walk,&s.cell)) { return s; }
  let at=(*w).walk.t; let ex=warpExit((*w).walk.ray,vec3f(s.cell),vec3f(s.cell+1),at);
  if (ex.x <= at) { return s; }
  s.start=warpAt((*w).walk.ray,at);s.end=warpAt((*w).walk.ray,ex.x);
  s.inAxis=(*w).walk.axis;s.outAxis=i32(ex.y);s.entry=(*w).walk.boundary;
  s.inStep=select(-1,1,warpSlope((*w).walk.ray,at)[s.inAxis]>0.0);
  s.outStep=select(-1,1,warpSlope((*w).walk.ray,ex.x)[s.outAxis]>0.0);s.valid=true;
  (*w).walk.t=ex.x;(*w).walk.axis=s.outAxis;(*w).walk.boundary=true;
  return s;
}
`;
  return /* wgsl */ `
struct ${prefix}Walk {
  ro: vec3f, rd: vec3f, cell: vec3i, step: vec3i, delta: vec3f, next: vec3f,
  t: f32, end: f32, axis: i32, entry: bool,
}
fn ${prefix}Start(ro: vec3f, rd: vec3f, nearT: f32) -> ${prefix}Walk {
  var w: ${prefix}Walk;let bh=boxHit(ro,rd);
  w.ro=ro;w.rd=rd;w.t=max(bh.x,nearT);w.end=bh.y;w.axis=i32(bh.z);
  w.entry=bh.x>=nearT;
  if (w.end>w.t) { ddaStart(ro,rd,w.t,&w.step,&w.delta,&w.cell,&w.next); }
  return w;
}
fn ${prefix}Next(w: ptr<function, ${prefix}Walk>) -> PlainSpan {
  var s: PlainSpan;
  if ((*w).t>=(*w).end || outside((*w).cell)) { return s; }
  s.cell=(*w).cell;s.start=(*w).ro+(*w).rd*(*w).t;s.inAxis=(*w).axis;
  s.entry=(*w).entry;s.inStep=(*w).step[s.inAxis];
  s.outAxis=argmin3((*w).next);s.outStep=(*w).step[s.outAxis];
  let end=min((*w).next.x,min((*w).next.y,(*w).next.z));
  s.end=(*w).ro+(*w).rd*end;s.valid=true;
  (*w).t=end;(*w).axis=ddaStep((*w).step,(*w).delta,&(*w).cell,&(*w).next);(*w).entry=true;
  return s;
}
`;
}

export const worldPlainFaceWGSL = /* wgsl */ `
${worldPlainClassesWGSL}
${blockLookConstantsWGSL}
struct PlainFace { uv: vec2f, grid: vec3f, info: u32, heat: u32 }
${blockLookHelpersWGSL({ prefix: 'plain_', input: 'PlainFace' })}
// Four fixed-world optical taps, without the realistic view's clouds/caustics:
// Plain's original lighting intentionally has neither of those multipliers.
fn plainSun(gp: vec3f, n: vec3f) -> vec3f {
  if (FU.shadows==0u) { return vec3f(1.0); }
  let p=gp+n*(WS.depth.z*BK_SHADOW_NORMAL)+FU.sun*BK_SHADOW_BIAS;
  let q=worldSunProject(p);let i0=vec2i(floor(q.xy-0.5));let w=fract(q.xy-0.5);
  var acc=vec3f(0.0);
  for(var k=0;k<4;k++) {
    let o=vec2i(k&1,k>>1u);let sm=worldSunTap(i0+o);
    acc+=select(0.0,1.0,q.z<sm.x+0.002)*shadowTexelAtt(sm,q.z)*wk0(o,w);
  }
  return acc;
}
${blockLookWGSL({ prefix: 'plain_', input: 'PlainFace', sun: 'plainSun', coloredSun: true })}
fn plainFace(cell: vec3i, side: u32, p: vec3f) -> PlainFace {
  let a=fetchA(cell);let id=eid(a);let me=classOf(id);
${blockFaceMetadataWGSL}
  let axis=side>>1u;var d=vec3i(0);d[axis]=select(-1,1,(side&1u)==1u);let q=cell+d;
  var ao=255u;
  if (me==CL_OPAQUE || me==CL_LIQUID) {
${blockFaceAOWGSL}
  }
  let uv=clamp(vec2f(p[(axis+1u)%3u]-f32(cell[(axis+1u)%3u]),p[(axis+2u)%3u]-f32(cell[(axis+2u)%3u])),vec2f(0.0),vec2f(1.0));
  // Match the mesher's 8-bit tint and its native f16 temperature/life exactly.
  return PlainFace(uv,p,head|side|(ao<<11u),pack2x16float(a.yz));
}
struct PlainAccum { trans: vec3f, scatter: vec3f, uncovered: f32, hit: bool }
fn plainAdd(acc: ptr<function, PlainAccum>, k: plain_Look) {
  (*acc).trans*=k.tr;(*acc).scatter+=k.e;(*acc).uncovered*=1.0-k.a;(*acc).hit=true;
}
// These are native target operations, NOT a single premultiplied-over color.
// Colored absorption multiplies the existing HDR scene; deferred CSS sky
// retains the original Post scalar-coverage semantics.
fn plainAbsorb(acc: PlainAccum) -> vec4f { return vec4f(acc.trans,1.0-acc.uncovered); }
fn plainScatter(acc: PlainAccum) -> vec4f { return vec4f(acc.scatter,0.0); }
`;

export function worldPlainWGSL({ curved = false } = {}) {
  const shown = p => curved ? `warpGridPoint(${p})` : p;
  return /* wgsl */ `
${worldPlainSpanWGSL}
${worldPlainWalkWGSL({ curved })}
${worldPlainFaceWGSL}
fn traceView(ro: vec3f, rd: vec3f, t0: f32, bh: vec3f, phase: u32) -> VolumeHit {
  var acc=PlainAccum(vec3f(1.0),vec3f(0.0),1.0,false);
  let pixel=clamp(vec2i(floor(gFragCoord)),vec2i(0),vec2i(textureDimensions(worldPackedMesh))-1);
  let mesh=worldMeshAt(pixel);var covered=P.meshCut!=0u && (mesh.coverageFlags&1u)!=0u;
  // Native opaque mesh HDR/coverage is already on the target: never redraw it.
  var base=vec3f(0.0);var opaque=false;var depth=select(1.0,mesh.depth,covered);
  var walk=plainStart(ro,rd,P.marchNear);
  for(var i=0;i<${curved ? '2*' : ''}MAX_STEPS;i++) {
    let s=plainNext(&walk);if (!s.valid) { break; }
    if (covered && volumeDepth(${shown('s.start')})>depth) { break; }
    let a=fetchA(s.cell);let me=classOf(eid(a));
    if (me==CL_NONE) { continue; }
    var d=vec3i(0);d[s.inAxis]=s.inStep;
    if (s.entry && shows(me,classAt(s.cell-d))) {
      let side=u32(s.inAxis*2+select(1,0,s.inStep>0));
      let k=plain_look(plainFace(s.cell,side,s.start),false);
      if (me==CL_OPAQUE) { base=k.e;covered=true;opaque=true;depth=volumeDepth(${shown('s.start')});break; }
      plainAdd(&acc,k);
    }
    if (covered && volumeDepth(${shown('s.end')})>depth) { break; }
    // Opaque exits are back-face culled, as in the original face draw.
    d=vec3i(0);d[s.outAxis]=s.outStep;
    if (me!=CL_OPAQUE && shows(me,classAt(s.cell+d))) {
      let side=u32(s.outAxis*2+select(0,1,s.outStep>0));
      plainAdd(&acc,plain_look(plainFace(s.cell,side,s.end),true));
    }
  }
  if (phase==0u) { return VolumeHit(vec4f(base,1.0),depth,opaque); }
  if (phase==1u) { return VolumeHit(plainAbsorb(acc),depth,acc.hit); }
  return VolumeHit(plainScatter(acc),depth,acc.hit);
}
`;
}

// Explicit WORLD-only optional picker factory; the parent owns pick-cache wiring.
export function worldPlainPickWGSL(g, { params, batch }) {
  const ray = curved => {
    const name=curved?'plainCurve':'plainFlat';
    return /* wgsl */ `
fn ${name}Pick(ro: vec3f, rd0: vec3f, skipLiquids: bool) -> Pick {
  var walk=${name}Start(ro,safeDir(normalize(rd0)),0.0);
  for(var i=0;i<${curved?'2*':''}MAX_STEPS;i++) {
    let s=${name}Next(&walk);if (!s.valid) { break; }
    let a=fetchA(s.cell);let id=eid(a);let me=classOf(id);
    if (me==CL_NONE || me==CL_GAS || me==CL_FIRE || (skipLiquids && KIND(id)==K_LIQUID)) { continue; }
    var d=vec3i(0);d[s.inAxis]=s.inStep;
    if (s.entry && shows(me,classAt(s.cell-d))) {
      return Pick(vec4f(vec3f(s.cell),f32(s.inAxis*2+select(0,1,s.inStep>0))),vec4f(f32(id),a.y,fetchB(s.cell).w,a.z));
    }
    d=vec3i(0);d[s.outAxis]=s.outStep;
    if (me!=CL_OPAQUE && shows(me,classAt(s.cell+d))) {
      // Back faces still report the voxel's physical outward face, not the
      // flipped lighting normal that makes a transparent exit visible.
      return Pick(vec4f(vec3f(s.cell),f32(s.outAxis*2+select(1,0,s.outStep>0))),vec4f(f32(id),a.y,fetchB(s.cell).w,a.z));
    }
  }
  return Pick(vec4f(0.0,0.0,0.0,-1.0),vec4f(0.0,0.0,0.0,-1.0));
}
`;
  };
  return /* wgsl */ `${prelude(g,{state:false,backend:'world'})}
${worldAccessWGSL({backend:'world'})}${worldQueryWGSL}
fn fetchA(c: vec3i) -> vec4f { return worldFetchA(c); }
fn fetchB(c: vec3i) -> vec4f { return worldFetchB(c); }
${materialsGLSL()}
${ddaGLSL(g,{backend:'world'})}
${presentationNearWGSL({skip:false})}
${params.wgsl}
@group(3) @binding(0) var<uniform> P: PickParams;
@group(3) @binding(6) var<storage,read_write> picks: array<vec4f>;
struct Pick { at: vec4f, what: vec4f }
${worldPlainClassesWGSL}
${worldPlainSpanWGSL}
${worldPlainWalkWGSL({prefix:'plainFlat'})}
${worldPlainWalkWGSL({curved:true,prefix:'plainCurve'})}
${ray(false)}${ray(true)}
@compute @workgroup_size(${batch}) fn main(@builtin(local_invocation_index) i: u32) {
  if (i>=P.n) { return; }
  worldBeginQuery();var r: Pick;
  if (P.ro[i].w!=0.0) {
    warpUse(P.ro[i].w,P.warp[i].xy,P.warp[i].zw);
    r=plainCurvePick(P.ro[i].xyz,P.rd[i].xyz,P.rd[i].w!=0.0);
  } else { r=plainFlatPick(P.ro[i].xyz,P.rd[i].xyz,P.rd[i].w!=0.0); }
  worldEndQuery();
  if (worldQueryIncomplete()) { r=Pick(vec4f(0.0,0.0,0.0,-2.0),vec4f(0.0)); }
  let slot=P.slot[i/4u][i%4u]*2u;picks[slot]=r.at;picks[slot+1u]=r.what;
}
`;
}
