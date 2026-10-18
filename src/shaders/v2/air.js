import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../v2.js';
import { dynamicsCommon, storageLayout, main64 } from './particles.js';
import { listControl, listWGSL, windGroupsWGSL } from './blasts.js';
import { AIR, DT, GRAVITY, LEGACY_PRESSURE_PA } from '../../v2/dynamics-reference.js';
import { PHYS } from '../../physics.js';
import { E } from '../../elements.js';
export const AIR_LAYOUT = storageLayout(5, [0]);
// Per-brick reach word of the acoustic substeps, its own run in control
// (listControl). Bit 0: this brick may change in the first substep; bit a+1: a
// bit-a brick lies within REACH along axis a; REACH_STEP: run its substeps. A
// word is zero unless its brick's air is live: any bit dilates over the brick
// itself to REACH_STEP, which notes it (reach), so an unlisted brick reads 0.
export const reachBase = g => listControl(g).reach;
// A substep reads only its six face neighbours, so a change travels at most one
// brick per substep. The start set is read before the neighbours' own source,
// which costs one brick more (see source): AIR.substeps in all.
export const REACH = AIR.substeps;
export const REACH_STEP = 1 << 3;
const NEGATIVE_ZERO = 0x80000000;
const f = n => Number.isInteger(n) ? `${n}.0` : String(n);
function head(g,nativeHead) {
  return /* wgsl */ `${dynamicsCommon(g,nativeHead)}
@group(1) @binding(0) var<storage, read> airIn: array<DAir>;
@group(1) @binding(1) var<storage, read_write> airOut: array<DAir>;
@group(1) @binding(2) var<storage, read_write> events: array<u32>;
@group(1) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(4) var<storage, read_write> faces: array<vec4f>;
${listWGSL(g)}
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
  return contactVacuum(core)*${f(LEGACY_PRESSURE_PA)};
}
fn aBase(b: u32) -> vec3i { return cellOf(b*64u) & vec3i(-4); }
fn aNeighbor(b: u32, axis: u32, sign_: i32) -> u32 {
  let p=mEdge(aBase(b)+dAxis(axis)*4*sign_); if (!inGrid(p)) { return D_NONE; } return brickOfCell(p);
}
fn aFace(b: u32, q: u32, axis: u32, sign_: i32) -> f32 {
  if (q==D_NONE) {
    if (P.edge!=1u) { return 0.0; }
    let base=aBase(b); var open=0.0;let u=(axis+1u)%3u;let v=(axis+2u)%3u;
    for(var i=0;i<4;i++) { for(var j=0;j<4;j++) {
      var p=base; p[axis]+=select(0,3,sign_>0);p[u]+=i;p[v]+=j;
      if(dOpen(p)) { open+=1.0/16.0; }
    } }
    return open;
  } if (sign_>0) { return faces[b][axis]; } return faces[q][axis];
}
fn aStill(a: DAir) -> bool { return abs(a.vp.w)<A_PQ && all(abs(a.vp.xyz)<vec3f(A_VQ)); }
// A resting value is a fixed point of step: zero motion bits, a full quiet run
// and no -0 scalar (x - (-0) turns a -0 into +0, a bit change).
fn aRest(a: DAir) -> bool {
  return all(bitcast<vec4u>(a.vp)==vec4u(0u)) && a.thermal.z==${f(AIR.quietTicks)} && all(bitcast<vec4u>(a.thermal)!=vec4u(${NEGATIVE_ZERO}u));
}
// Neither diffusion nor the gradient test acts across this pair: canonical
// aFlux zeroes each scalar delta under A_SQ, and |r-l| equals |l-r| exactly.
fn aLevel(a: DAir, b: DAir) -> bool { return all(abs(a.thermal.xy-b.thermal.xy)<vec2f(A_SQ)); }
// Oriented finite-volume flux; the adjacent cell evaluates the SAME face in
// canonical order, then subtracts instead of adds. Acoustic Rusanov (TPT's
// slowed sound, R12) plus bounded upwind transport, not nonconservative sampling.
fn aFlux(left: DAir, right: DAir, axis: u32) -> DAir {
  let l=vec4f(select(vec3f(0),left.vp.xyz,mAirVelocity()),select(0.0,left.vp.w,mAirPressure()));
  let r=vec4f(select(vec3f(0),right.vp.xyz,mAirVelocity()),select(0.0,right.vp.w,mAirPressure())); let delta=r-l;
  var acoustic=vec4f(0); acoustic[axis]=(l.w+r.w)/(2.0*A_RHO);
  acoustic.w=A_RHO*A_C*A_C*(l[axis]+r[axis])*0.5;
  acoustic-=0.5*A_C*delta;
  let courant=clamp((l[axis]+r[axis])*0.5*A_DT/A_DX,-1.0/12.0,1.0/12.0);
  let donor=select(r,l,courant>=0.0);
  // Pressure is an acoustic variable, not a mass density. Only velocity and
  // passive heat/gas use the upwind flux; each direction has a 1/12 budget.
  let momentum=vec4f(donor.xyz*courant,0.0);
  var scalarDelta=right.thermal.xy-left.thermal.xy;
  scalarDelta=select(scalarDelta,vec2f(0),abs(scalarDelta)<vec2f(A_SQ));
  var scalar=courant*select(right.thermal.xy,left.thermal.xy,courant>=0.0)-A_DIFF*A_DT/(A_DX*A_DX)*scalarDelta;
  scalar.x=select(0.0,scalar.x,mAirHeat());scalar.y=select(0.0,scalar.y,mAirPressure()||mAirVelocity());
  return DAir(acoustic*A_DT/A_DX+momentum,vec4f(scalar,0,0));
}
`;
}
export function airWGSL(g,nativeHead,stage) {
  const h=head(g,nativeHead);
  // What step needs from a brick's cells: its faces (open fractions toward
  // +x/+y/+z, gas buoyancy) and its vacuum are a function of its cells, its
  // six face neighbours' (mEdge topology) and the modes alone, so they are
  // read again only when one of those seven bricks noted a cell change since
  // the last reach pass cleared the notes (or a mode change, restore or window
  // scatter noted every brick). Gas sources and the durable event census read
  // only bricks noted as holding a request. No air stage writes a cell before
  // step, so order is free. faces holds faces at t, the vacuum at D_BRICKS+t.
  // The bricks source must read: what it caches or applies may differ from last
  // tick (a cell note, a request, a shock), or its air or a face neighbour's is
  // live. Any other brick's source is an identity that leaves its reach word 0:
  // its air and its neighbours' are as they were when it last settled, its faces
  // and vacuum are cached, and both copies are equal (tools/v2/air-reach-check.mjs).
  if (stage==='list') return h+main64(/* wgsl */ `
    // The tick's first air dispatch: source recounts durable events, activity the
    // working air (not live particles); no separate clear splits the pass.
    if (t==0u) { atomicStore(&control[1],0u); atomicStore(&control[2],0u); }
    if (t>=D_BRICKS) { return; }
    var seed=aLive(t) || atomicLoad(&act2[V2_STATE_DIRTY+t])!=0u || atomicLoad(&act2[V2_EVENTS+t])!=0u || atomicLoad(&control[D_SHOCK+t])!=0u;
    for (var axis=0u;axis<3u;axis++) { for (var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side); if (q!=D_NONE && (aLive(q) || atomicLoad(&act2[V2_STATE_DIRTY+q])!=0u)) { seed=true; }
    } }
    if (seed) { dAppend(LIST_SOURCE,t); }
  `);
  // After the substeps: the bricks where wind or pressure can act (dWindListed). A workgroup is one
  // group of the shared allocator's (shaders/v2.js BRICK_GROUP): its word says whether it listed any, so
  // the couple run's count reads one word for a group instead of every brick's air words. Nothing
  // writes an air-live word between here and that count (gas, couplePlan: cells and plans only).
  if (stage==='windList') return h+`${windGroupsWGSL(g)}
var<workgroup> wgWind: atomic<u32>;
`+main64(/* wgsl */ `
    // Every lane reaches the barrier: one past the bricks lists nothing.
    if (t<D_BRICKS) {
      // Every source has read its neighbours' notes, and no cell is written between source and here
      // (reach and the substeps write only air): a later write notes its brick for the next source.
      if (atomicLoad(&act2[V2_STATE_DIRTY+t])!=0u) { atomicStore(&act2[V2_STATE_DIRTY+t],0u); }
      if (dWindListed(t)) { dAppend(LIST_WIND,t); atomicStore(&wgWind,1u); }
    }
    workgroupBarrier();
    let group=wg.x+wg.y*nwg.x;
    if (li==0u && group<BRICK_GROUPS) { atomicStore(&control[D_WIND_GROUPS+group],atomicLoad(&wgWind)); }
  `);
  if (stage==='source') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } let base=aBase(t);
    var stale=atomicLoad(&act2[V2_STATE_DIRTY+t])!=0u;
    for (var axis=0u;axis<3u;axis++) { for (var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side); if (q!=D_NONE && atomicLoad(&act2[V2_STATE_DIRTY+q])!=0u) { stale=true; }
    } }
    if (stale) {
      var open=vec3f(0);
      for (var a=0u;a<3u;a++) { let u=(a+1u)%3u; let v=(a+2u)%3u;
        for (var i=0;i<4;i++) { for (var j=0;j<4;j++) {
          var p=base+dAxis(a)*3; p[u]+=i; p[v]+=j;
          if (dOpen(p) && dOpen(p+dAxis(a))) { open[a]+=1.0/16.0; }
        } }
      }
      var vacuum=0.0; var buoyancy=0.0;
      for (var s=t*64u;s<(t+1u)*64u;s++) {
        let core=loadMaterial(s).core; vacuum=min(vacuum,aVacuum(core));
        if (cls(cid(core))==4u) { buoyancy+=(f32(cTq(core))*0.25-273.25-P.ambient)/64.0; }
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
      }
      faces[t]=vec4f(open,buoyancy); faces[D_BRICKS+t]=vec4f(vacuum,0.0,0.0,0.0);
    }
    let buoyancy=faces[t].w; let vacuum=faces[D_BRICKS+t].x;
    let before=airIn[t]; var a=before; var count=0u; var heat=0.0; var pending=0u;
    if (atomicLoad(&act2[V2_EVENTS+t])!=0u) {
      for (var s=t*64u;s<(t+1u)*64u;s++) {
        if ((events[s]&2u)!=0u) {
          count++; heat+=(f32(cTq(loadMaterial(s).core))*0.25-273.25-P.ambient)/64.0;
          events[s]&=~2u; // bit consumed only together with its bounded, once-only source
        }
        // Requests left after this source. Nothing later in the air tick sets
        // or clears an event bit, so this is the census activity used to take.
        if (events[s]!=0u) { pending++; dWake(cellOf(s)); }
      }
      // Every request word of the brick is zero now; a later store notes it again.
      if (pending==0u) { atomicStore(&act2[V2_EVENTS+t],0u); }
    }
    if (pending>0u) { atomicAdd(&control[2],pending); }
    let shock=atomicExchange(&control[D_SHOCK+t],0u);
    if (shock>0u && mAirPressure()) { a.vp.w+=f32(shock)/256.0; a.thermal.z=0.0; dWake(aBase(t)); }
    if (count>0u) {
      if(mAirPressure()) { a.vp.w+=f32(count)*${f(AIR.gasPressure)}; } if(mAirHeat()) { a.thermal.x+=heat; }
      a.thermal.y+=f32(count)/64.0; a.thermal.z=0.0; dWake(aBase(t));
    }
    if (vacuum<0.0 && mAirPressure()) { a.vp.w=min(a.vp.w,vacuum); a.thermal.z=0.0; dWake(aBase(t)); }
    if(!mAirPressure()) { a.vp.w=0.0; } if(!mAirVelocity()) { a.vp=vec4f(0,0,0,a.vp.w); } if(!mAirHeat()) { a.thermal.x=0.0; }
    airOut[t]=a;
    // Start set of the substeps' reach: everything but a brick this source left
    // bitwise unchanged, resting, without buoyancy (gravity ignored: a superset)
    // and level with resting neighbours. Neighbours are read BEFORE their own
    // source; one that source changed is in the set itself, and REACH counts
    // that extra brick.
    let changed=any(bitcast<vec4u>(a.vp)!=bitcast<vec4u>(before.vp)) || any(bitcast<vec4u>(a.thermal)!=bitcast<vec4u>(before.thermal));
    var settled=!changed && aRest(a) && !(mAirHeat() && mAirVelocity() && abs(a.thermal.x+buoyancy)>0.01);
    for (var axis=0u;axis<3u;axis++) { for (var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side); if (q==D_NONE && P.edge!=1u) { continue; }
      var other=DAir(vec4f(0),vec4f(0,0,${f(AIR.quietTicks)},0)); if (q!=D_NONE) { other=airIn[q]; }
      settled=settled && aRest(other) && aLevel(a,other);
    } }
    atomicStore(&control[A_REACH+t],select(1u,0u,settled));
    // Settled: unchanged, resting, level with resting neighbours, and both copies hold it.
    atomicStore(&act2[V2_AIR_LIVE+t],select(1u,0u,settled));
  `,'dListedBrick(LIST_SOURCE,wg,nwg,li)');
  // Separable box dilation of that start set, one axis per dispatch
  // (P.substep), in step's own neighbour topology (mEdge wraps loop edges).
  // Scattered, over lists: axis 0 from the source list's start bricks, axis 1 from the bricks axis 0
  // reached (reachX), axis 2 from axis 1's (reachY). A brick with bit a marks bit a+1 on every brick
  // within REACH along a (mEdge: loop seams wrap), the same set the old gather over every brick
  // found, since that neighbourhood is symmetric; the first to mark a brick lists it.
  if (stage==='reach') return h+main64(/* wgsl */ `
    let axis=P.substep;
    if (t>=D_BRICKS || (atomicLoad(&control[A_REACH+t])&(1u<<axis))==0u) { return; }
    for (var d=-${REACH};d<=${REACH};d++) {
      let p=mEdge(aBase(t)+dAxis(axis)*4*d); if (!inGrid(p)) { continue; }
      let n=brickOfCell(p);
      if ((atomicOr(&control[A_REACH+n],2u<<axis)&(2u<<axis))!=0u) { continue; }
      if (axis==0u) { dAppend(LIST_REACHX,n); } else if (axis==1u) { dAppend(LIST_REACHY,n); }
      // Reached: the substeps run here and may move its air; list it for them.
      else { noteAir(n); dAppend(LIST_STEP,n); }
    }
  `,'select(select(dListedBrick(LIST_REACHY,wg,nwg,li),dListedBrick(LIST_REACHX,wg,nwg,li),P.substep==1u),dListedBrick(LIST_SOURCE,wg,nwg,li),P.substep==0u)');
  if (stage==='step') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; }
    // Outside the reach every substep is an exact identity and both ping-pong
    // copies already hold this value: no read, no write.
    if ((atomicLoad(&control[A_REACH+t])&${REACH_STEP}u)==0u) { return; }
    let before=airIn[t]; var next=before;
    var quiet=aStill(before); var gradient=false;
    for (var axis=0u;axis<3u;axis++) { for (var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side); if (q==D_NONE && P.edge!=1u) { continue; }
      var other=DAir(vec4f(0),vec4f(0,0,${f(AIR.quietTicks)},0));if(q!=D_NONE) { other=airIn[q]; }
      let open=aFace(t,q,axis,side); if (open==0.0) { continue; }
      quiet=quiet && aStill(other);
      gradient=gradient || (mAirHeat() && abs(other.thermal.x-before.thermal.x)>=A_SQ) || ((mAirPressure()||mAirVelocity()) && abs(other.thermal.y-before.thermal.y)>=A_SQ);
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
    let excess=before.thermal.x+faces[t].w;
    let gravity=mGravity(vec3f(aBase(t))+2.0);
    if (mAirHeat() && mAirVelocity() && abs(excess)>0.01 && dot(gravity,gravity)>0.0) {
      for(var axis=0u;axis<3u;axis++) {
        let below=aNeighbor(t,axis,-1);let open=faces[t][axis]+aFace(t,below,axis,-1);
        next.vp[axis]-=gravity[axis]*clamp(excess/max(1.0,P.ambient+273.15),-0.5,2.0)*A_DT*min(open,1.0);
        if(open>0.0 && gravity[axis]!=0.0) { quiet=false; }
      }
    }
    next.vp*=pow(${f(AIR.loss)},1.0/${f(AIR.substeps)});
    if(P.airMode==4u) { next.vp=before.vp; }
    if(!mAirVelocity()) { next.vp=vec4f(0,0,0,next.vp.w); }
    if(!mAirPressure()) { next.vp.w=0.0; }
    if(!mAirHeat()) { next.thermal.x=0.0; }
    if (P.substep==${AIR.substeps-1}u) {
      if (quiet && !gradient && aStill(next)) {
        next.thermal.z=min(${f(AIR.quietTicks)},before.thermal.z+1.0);
        // Explicit quanta are the ONLY lossy resting operation. Heat/gas stay.
        if (next.thermal.z>=${f(AIR.quietTicks)}) { next.vp=vec4f(0); }
      } else { next.thermal.z=0.0; }
    }
    airOut[t]=next;
  `,'dListedBrick(LIST_STEP,wg,nwg,li)');
  // Over the wind list: a brick outside it is at rest with resting, level neighbours.
  if (stage==='activity') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; }
    let a=airIn[t];
    var working=(a.thermal.z<${f(AIR.quietTicks)} || !aStill(a)) && P.airMode!=4u;
    if(P.airMode==4u) { for(var axis=0u;axis<3u;axis++) { for(var side=-1;side<=1;side+=2) {
      let q=aNeighbor(t,axis,side);if(q==D_NONE || aFace(t,q,axis,side)==0.0) { continue; }
      let delta=abs(airIn[q].thermal.xy-a.thermal.xy);
      working=working || (mAirHeat() && delta.x>=A_SQ) || delta.y>=A_SQ;
    } } }
    if (working) { atomicAdd(&control[1],1u); dWake(aBase(t)); }
  `,'dListedBrick(LIST_WIND,wg,nwg,li)');
  if (stage==='tool') return h+main64(/* wgsl */ `
    if (t>=D_BRICKS) { return; } var a=airIn[t];
    let delta=vec3f(aBase(t)+P.origin)+2.0-P.center; let r=length(delta);
    // Brush overlap includes the half-diagonal of a 4³ air cell.
    if (r<=P.radius+3.464101615) {
      let falloff=clamp(1.0-r/max(P.radius+3.464101615,0.001),0.0,1.0);
      if (P.mode==3u) { a.vp=vec4f(a.vp.xyz+P.vector*P.strength*falloff,a.vp.w); }
      if (P.mode==4u || P.mode==5u) { a.vp.w+=select(1.0,-1.0,P.mode==5u)*P.strength*falloff; }
      if (P.mode==6u && length(delta.xz)>0.0) { a.vp=vec4f(a.vp.xyz+normalize(vec3f(delta.z,0,-delta.x))*P.strength*falloff,a.vp.w); }
      a.thermal.z=0.0; dWake(aBase(t)); noteAir(t);
    }
    airOut[t]=a;
  `);
  if (stage==='gas') return h+main64(/* wgsl */ `
    if (t>=D_SLOTS || !mAirVelocity()) { return; } let p=cellOf(t); let axis=P.tick%3u;
    // Disjoint adjacent pairs, alternating phase. Gas moves its ENTIRE core
    // and bank, not just temperature/id; no neighboring write/read race.
    if (((p[axis]+P.origin[axis]+i32((P.tick/3u)&1u))&1)!=0) { return; }
    let q=mEdge(p+dAxis(axis)); if (!inGrid(q)) { return; }
    // No wind across the pair: neither the wake nor the swap test can pass
    // (dRandom is never negative). Decide before touching events or cells.
    let wind=(airIn[brickOfCell(p)].vp[axis]+airIn[brickOfCell(q)].vp[axis])*0.5;
    let probability=min(1.0,abs(wind)*D_DT/D_CELL*6.0); if (probability==0.0) { return; }
    let sa=slotOf(p); let sb=slotOf(q); if((events[sa]&1u)!=0u || (events[sb]&1u)!=0u) { return; }
    let a=loadMaterial(sa); let b=loadMaterial(sb);
    let ka=cls(cid(a.core)); let kb=cls(cid(b.core));
    let movable=(wind>0.0 && ka==4u && cid(b.core)==0u) || (wind<0.0 && kb==4u && cid(a.core)==0u);
    if(movable && probability>0.0) { dWake(p);dWake(q); }
    if (movable && dRandom(dId(p,0x474153u),0u)<probability) {
      // the gas takes its decoration along; the air it leaves holds none (shaders/move.js)
      let paint=decoOf(sa); setDeco(sa,select(decoOf(sb),0u,cid(b.core)==0u)); setDeco(sb,select(paint,0u,cid(a.core)==0u));
      storeMaterial(sa,a,b); storeMaterial(sb,b,a); dWake(p); dWake(q);
    }
  `,'dListedCell(LIST_WIND,wg,nwg,li)');
  if(stage==='gasBoundary') return h+main64(`
    if(t>=D_SLOTS || P.edge!=1u || !mAirVelocity()) { return; }
    // Interior cells and still edges have no outward wind: no wake, and the
    // outflow test is dRandom<0. Decide before reading events or cells.
    let p=cellOf(t);let wind=airIn[brickOfCell(p)].vp.xyz;var outward=0.0;
    for(var axis=0u;axis<3u;axis++) {
      if(!inGrid(p-dAxis(axis))) { outward+=max(0.0,-wind[axis]); }
      if(!inGrid(p+dAxis(axis))) { outward+=max(0.0,wind[axis]); }
    }
    if(outward==0.0 || (events[t]&1u)!=0u) { return; }
    let before=loadMaterial(t);if(cls(cid(before.core))!=4u) { return; }
    if(outward>0.0) { dWake(p); }
    if(dRandom(dId(p,0x4f5554u),0u)<min(1.0,outward*D_DT/D_CELL)) {
      dOutflow(p,before);setDeco(t,0u);storeMaterial(t,before,dCarrier(before));atomicAdd(&control[16],1u);
    }
  `,'dListedCell(LIST_WIND,wg,nwg,li)');
  throw new Error(`Unknown air stage ${stage}`);
}
export const AIR_STAGES=['list','source','reach','step','windList','activity','tool','gas','gasBoundary'];

export const WGSL_CHECK = AIR_STAGES.map(stage => ({ name: `v2air_${stage}`, kind: 'compute',
  code: g => airWGSL(g,nativeDynamicsHead,stage), layouts: () => [V2_DYNAMICS_LAYOUT,AIR_LAYOUT,'EMPTY'], tool: true }));
