import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, storageLayout, main64 } from './particles.js';
import { AIR, DT, GRAVITY, LEGACY_PRESSURE_PA } from '../../v2/dynamics-reference.js';
import { PHYS } from '../../physics.js';
import { E } from '../../elements.js';
export const AIR_LAYOUT = storageLayout(5, [0]);
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
function head(g,nativeHead) {
  return /* wgsl */ `${dynamicsCommon(g,nativeHead)}
@group(1) @binding(0) var<storage, read> airIn: array<DAir>;
@group(1) @binding(1) var<storage, read_write> airOut: array<DAir>;
@group(1) @binding(2) var<storage, read_write> events: array<u32>;
@group(1) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(4) var<storage, read_write> faces: array<vec4f>;
const A_DT: f32 = ${f(DT/AIR.substeps)};
const A_DX: f32 = ${f(AIR.edge)};
const A_C: f32 = ${f(AIR.sound)};
const A_RHO: f32 = ${f(AIR.rho)};
const A_DIFF: f32 = ${f(AIR.diffusion)};
const A_PQ: f32 = ${f(AIR.pQuantum)};
const A_VQ: f32 = ${f(AIR.vQuantum)};
const A_SQ: f32 = ${f(AIR.scalarQuantum)};
// contactVacuum twin: singularity raw life is mass in1/256-cell units.
// Legacy pressure is explicitly converted, shared with native tool adapters.
fn aVacuum(core: vec4u) -> f32 {
  if (cid(core)!=${E.SINGULARITY}u) { return 0.0; }
  return max(${f(PHYS.P_MIN)},-${f(PHYS.SING_P_PER_MASS)}*f32(payloadOf(core))/256.0)*${f(LEGACY_PRESSURE_PA)};
}
fn aBase(b: u32) -> vec3i { return cellOf(b*64u) & vec3i(-4); }
fn aNeighbor(b: u32, axis: u32, sign_: i32) -> u32 {
  let p=aBase(b)+dAxis(axis)*4*sign_; if (!inGrid(p)) { return D_NONE; } return brickOfCell(p);
}
fn aFace(b: u32, q: u32, axis: u32, sign_: i32) -> f32 {
  if (q==D_NONE) { return 0.0; } if (sign_>0) { return faces[b][axis]; } return faces[q][axis];
}
fn aStill(a: DAir) -> bool { return abs(a.vp.w)<A_PQ && all(abs(a.vp.xyz)<vec3f(A_VQ)); }
// Oriented finite-volume flux; the adjacent cell evaluates the SAME face in
// canonical order, then subtracts instead of adds. Acoustic Rusanov (TPT's
// slowed sound, R12) plus bounded upwind transport, not nonconservative sampling.
fn aFlux(left: DAir, right: DAir, axis: u32) -> DAir {
  let l=left.vp; let r=right.vp; let delta=r-l;
  var acoustic=vec4f(0); acoustic[axis]=(l.w+r.w)/(2.0*A_RHO);
  acoustic.w=A_RHO*A_C*A_C*(l[axis]+r[axis])*0.5;
  acoustic-=0.5*A_C*delta;
  let courant=clamp((l[axis]+r[axis])*0.5*A_DT/A_DX,-1.0/12.0,1.0/12.0);
  let donor=select(right.vp,left.vp,courant>=0.0);
  // Pressure is an acoustic variable, not a mass density. Only velocity and
  // passive heat/gas use the upwind flux; each direction has a 1/12 budget.
  let momentum=vec4f(donor.xyz*courant,0.0);
  var scalarDelta=right.thermal.xy-left.thermal.xy;
  scalarDelta=select(scalarDelta,vec2f(0),abs(scalarDelta)<vec2f(A_SQ));
  let scalar=courant*select(right.thermal.xy,left.thermal.xy,courant>=0.0)-A_DIFF*A_DT/(A_DX*A_DX)*scalarDelta;
  return DAir(acoustic*A_DT/A_DX+momentum,vec4f(scalar,0,0));
}
`;
}
export function airWGSL(g,nativeHead,stage) {
  const h=head(g,nativeHead);
  if (stage==='faces') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } let base=aBase(t); var open=vec3f(0);
    for (var a=0u;a<3u;a++) { let u=(a+1u)%3u; let v=(a+2u)%3u;
      for (var i=0;i<4;i++) { for (var j=0;j<4;j++) {
        var p=base+dAxis(a)*3; p[u]+=i; p[v]+=j;
        if (dOpen(p) && dOpen(p+dAxis(a))) { open[a]+=1.0/16.0; }
      } }
    }
    var buoyancy=0.0;
    for (var s=t*64u;s<(t+1u)*64u;s++) {
      let c=loadMaterial(s).core;
      if (cls(cid(c))==4u) { buoyancy+=(f32(cTq(c))*0.25-293.25)/64.0; }
    }
    faces[t]=vec4f(open,buoyancy);
  `);
  if (stage==='source') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } var a=airIn[t]; var count=0u; var heat=0.0; var vacuum=0.0;
    for (var s=t*64u;s<(t+1u)*64u;s++) {
      let core=loadMaterial(s).core; vacuum=min(vacuum,aVacuum(core));
      // The contact rule's0.6 open-neighbour ring, including cross-brick faces.
      // Interior neighbours already share the stronger source-brick target.
      if (cls(cid(core))==0u || cls(cid(core))==4u) {
        let p=cellOf(s);
        for(var axis=0u;axis<3u;axis++) {
          let local=p[axis]&3; if(local!=0 && local!=3) { continue; }
          let q=p+dAxis(axis)*select(-1,1,local==3);
          if(inGrid(q)) { vacuum=min(vacuum,${f(PHYS.SING_RING)}*aVacuum(loadMaterial(slotOf(q)).core)); }
        }
      }
      if ((events[s]&2u)!=0u) {
        count++; heat+=(f32(cTq(loadMaterial(s).core))*0.25-293.25)/64.0;
        events[s]&=~2u; // bit consumed only together with its bounded, once-only source
      }
    }
    let shock=atomicExchange(&control[D_SHOCK+t],0u);
    if (shock>0u) { a.vp.w+=f32(shock)/256.0; a.thermal.z=0.0; dWake(aBase(t)); }
    if (count>0u) {
      a.vp.w+=f32(count)*${f(AIR.gasPressure)}; a.thermal.x+=heat;
      a.thermal.y+=f32(count)/64.0; a.thermal.z=0.0; dWake(aBase(t));
    }
    if (vacuum<0.0) { a.vp.w=min(a.vp.w,vacuum); a.thermal.z=0.0; dWake(aBase(t)); }
    airOut[t]=a;
  `);
  if (stage==='step') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } let before=airIn[t]; var next=before;
    var quiet=aStill(before); var gradient=false;
    for (var axis=0u;axis<3u;axis++) { for (var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side); if (q==D_NONE) { continue; }
      let other=airIn[q]; let open=aFace(t,q,axis,side); if (open==0.0) { continue; }
      quiet=quiet && aStill(other);
      gradient=gradient || any(abs(other.thermal.xy-before.thermal.xy)>=vec2f(A_SQ));
      var flux: DAir;
      if (side>0) { flux=aFlux(before,other,axis); } else { flux=aFlux(other,before,axis); }
      next.vp-=f32(side)*open*flux.vp;
      // Closed fractions exert wall pressure too. Subtracting the cell's
      // pressure baseline makes uniform pressure a rest state even at walls.
      next.vp[axis]+=f32(side)*open*before.vp.w/A_RHO*A_DT/A_DX;
      next.thermal-=f32(side)*open*flux.thermal;
    } }
    // Thermal expansion and gas buoyancy. No permanent acceleration in a
    // fully sealed brick: vertical open faces alone couple the two layers.
    let below=aNeighbor(t,1u,-1); let vertical=faces[t].y+aFace(t,below,1u,-1);
    let excess=before.thermal.x+faces[t].w;
    if (vertical>0.0 && abs(excess)>0.01) {
      next.vp.y+=${f(GRAVITY)}*clamp(excess/293.15,-0.5,2.0)*A_DT*min(vertical,1.0); quiet=false;
    }
    next.vp*=pow(${f(AIR.loss)},1.0/${f(AIR.substeps)});
    if (P.substep==${AIR.substeps-1}u) {
      if (quiet && !gradient && aStill(next)) {
        next.thermal.z=min(${f(AIR.quietTicks)},before.thermal.z+1.0);
        // Explicit quanta are the ONLY lossy resting operation. Heat/gas stay.
        if (next.thermal.z>=${f(AIR.quietTicks)}) { next.vp=vec4f(0); }
      } else { next.thermal.z=0.0; }
    }
    airOut[t]=next;
  `);
  if (stage==='activity') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; }
    let a=airIn[t]; var pending=0u;
    for (var s=t*64u;s<(t+1u)*64u;s++) { if (events[s]!=0u) { pending++; dWake(cellOf(s)); } }
    if (pending>0u) { atomicAdd(&control[2],pending); }
    if (a.thermal.z<${f(AIR.quietTicks)} || !aStill(a)) { atomicAdd(&control[1],1u); dWake(aBase(t)); }
  `);
  if (stage==='tool') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } var a=airIn[t];
    let delta=vec3f(aBase(t)+P.origin)+2.0-P.center; let r=length(delta);
    // Brush overlap includes the half-diagonal of a 4³ air cell.
    if (r<=P.radius+3.464101615) {
      let falloff=clamp(1.0-r/max(P.radius+3.464101615,0.001),0.0,1.0);
      if (P.mode==3u) { a.vp=vec4f(a.vp.xyz+P.vector*P.strength*falloff,a.vp.w); }
      if (P.mode==4u || P.mode==5u) { a.vp.w+=select(1.0,-1.0,P.mode==5u)*P.strength*falloff; }
      if (P.mode==6u && length(delta.xz)>0.0) { a.vp=vec4f(a.vp.xyz+normalize(vec3f(delta.z,0,-delta.x))*P.strength*falloff,a.vp.w); }
      a.thermal.z=0.0; dWake(aBase(t));
    }
    airOut[t]=a;
  `);
  if (stage==='gas') return h+main64(/* wgsl */ `
    if (t>=D_SLOTS) { return; } let p=cellOf(t); let axis=P.tick%3u;
    // Disjoint adjacent pairs, alternating phase. Gas moves its ENTIRE core
    // and bank, not just temperature/id; no neighboring write/read race.
    if (((p[axis]+P.origin[axis]+i32((P.tick/3u)&1u))&1)!=0) { return; }
    let q=p+dAxis(axis); if (!inGrid(q)) { return; }
    let sa=slotOf(p); let sb=slotOf(q); let a=loadMaterial(sa); let b=loadMaterial(sb);
    let ka=cls(cid(a.core)); let kb=cls(cid(b.core));
    let wind=(airIn[brickOfCell(p)].vp[axis]+airIn[brickOfCell(q)].vp[axis])*0.5;
    let probability=min(1.0,abs(wind)*D_DT/D_CELL*6.0);
    let movable=(wind>0.0 && ka==4u && cid(b.core)==0u) || (wind<0.0 && kb==4u && cid(a.core)==0u);
    if (movable && dRandom(dId(p,0x474153u),0u)<probability) {
      storeMaterial(sa,a,b); storeMaterial(sb,b,a); dWake(p); dWake(q);
    }
  `);
  throw new Error(`Unknown air stage ${stage}`);
}
export const AIR_STAGES=['faces','source','step','activity','tool','gas'];

export const WGSL_CHECK = AIR_STAGES.map(stage => ({ name: `v2air_${stage}`, kind: 'compute',
  code: g => airWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,AIR_LAYOUT,'EMPTY'], tool: true }));
