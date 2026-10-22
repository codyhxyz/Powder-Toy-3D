import { RAYS } from '../rays.js';
import { validateMaterialCore } from './materialValidation.js';
import { EXTERNAL_BLAST_CAP, validExternalBlast, validateExternalBlasts, cloneExternalBlast } from './externalBlast.js';
import { fold } from '../gpu/kernels.js';
import { ELEMENTS, K } from '../elements.js';
import { nativeModes } from './modes.js';
import { cellSlot, slotCell, brickCoordOf } from '../shaders/common.js';
import { DynamicParams, particlesWGSL, PARTICLE_STAGES, PARTICLES_LAYOUT, heldBase, shockBase, setOffBase, storageLayout } from '../shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, BLASTS_LAYOUT, controlWords, rayRequestBase, RAY_REQUEST_CAP, externalBlastBase, externalMaskBase, ALLOCATION_STAGES, COUPLE_MODE,
  COUPLE_ARGS, RAY_ARGS, listControl, LIST_ARGS, DISPATCH_ARGS_BYTES, LISTS_STAGES, listsStageWGSL, controlBufferWords, LAUNCH_MODE } from '../shaders/v2/blasts.js';
import { AIR as AIR_MODE, EDGE } from '../simModes.js';
import { airWGSL, AIR_STAGES, AIR_LAYOUT } from '../shaders/v2/air.js';
import { windowWGSL, WINDOW_STAGES, WINDOW_LAYOUT, WINDOW_MODE, windowWork } from '../shaders/v2/windowMove.js';
import { PARTICLE_CAP, PARTICLE_BYTES, AIR, CELL_M, EVENT, RAY_PHOTON_MS, RAY_NEUTRON_FAST_MS, RAY_STEPS_PER_TICK } from './dynamics-reference.js';
// the particle stages a V1 step of a ray takes (particles.js: integrate moves, elect and impact take the hits,
// deposit lands matter)
const RAY_STAGES=['integrate','elect','impact','deposit'];
import { NATIVE_LAUNCH_MODE } from './nativeForcing.js';
import { CONTACT_PUFF_UNIT as PUFF_UNIT } from './contact.js';   // a GAS request's puff rides above its flags
import { AIRBORNE_COLOURS, packAirborne } from './airborne.js';
// listArgs: control and the dispatch args, nothing else (it writes the args it publishes).
export const LISTS_LAYOUT = storageLayout(2);

export const DYNAMICS_ABI = Object.freeze({ version: 1, particleBytes: PARTICLE_BYTES, capacity: PARTICLE_CAP,
  position: 'world cells', velocity: 'm/s', particleIdOffset: 12, coreOffsets: [28,32,36,40], bankOffset: 44,
  airBytes: 32, airOrder: 'native brick-major', airVelocity: 'm/s', airPressure: 'Pa',
  group0: ['cells','aux','activity'], particleGroup1: ['particles','flight','claims','air(read)','control'],
  blastGroup1: ['events','particles','air','control','plans'], airGroup1: ['airIn(read)','airOut','events','control','faces'],
  maxStorageBuffers: 8, blastBatchDefault: 64, blastBatchMax: 64 });
const vector = x => Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x) : x ? [x.x,x.y,x.z] : [0,0,0];
// Finite JS numbers need not be safe shader inputs (1e100 packs to infinity).
// 1e12 also keeps squared velocities/pressures within f32's finite range.
export const safeDynamicNumber = n => Number.isFinite(n) && Math.abs(n)<=1e12 && Number.isFinite(Math.fround(n));
const finiteVector = x => { const v=vector(x); return v.length===3 && v.every(safeDynamicNumber) ? v : null; };
const key = p => p.join(',');
const isInside = (p,g) => p.every((x,a) => x>=0 && x<[g.nx,g.ny,g.nz][a]);
const equal = (a,b) => a.length===b.length && a.every((x,i)=>x===b[i]);
const IMPULSE_KINDS=['impulse','photon','neutron','wind','pressure','vacuum','cyclone'];
// modes.js mAirVelocity: the air modes that keep wind.
const AIR_VELOCITY_MODES=[AIR_MODE.ON,AIR_MODE.PRESSURE_OFF,AIR_MODE.NO_UPDATE];
const cloneRequest = r => ({ ...r, position:[...r.position], direction:[...r.direction] });
// A brick's air before anything moved it (the constructor's and emptyDynamicState's): an archive
// keeps only the bricks that differ, since one that comes back without an entry is this, bit for bit.
const QUIET_AIR=(()=>{ const f=new Float32Array(8); f[6]=AIR.quietTicks; return new Uint32Array(f.buffer); })();
const quietAir = words => words.every((w,k)=>w===QUIET_AIR[k]);
// The dynamics' longest cold compile (dawn.node, Metal, cache-busted: v2particles_react 4.7 s, the
// airborne contact table; the next is under 0.5 s): it starts ahead of their other idle builds.
const DYNAMICS_LONG_POLES = new Set(['v2particles_react']);

/** Pure validation: callers may preflight a save before ANY app/GPU mutation. */
export function validateDynamicState(snapshot,g) {
  const s=snapshot;
  const external = validateExternalBlasts(s ?? {},g);
  if (!s || s.version!==1 || !equal(s.dims??[],[g.nx,g.ny,g.nz]) || !finiteVector(s.origin) ||
    !s.origin.every(Number.isInteger) || !(s.particles instanceof Uint32Array) || s.particles.length!==PARTICLE_CAP*12 ||
    !(s.air instanceof Uint32Array) || s.air.length!==g.nbricks*8 || !(s.control instanceof Uint32Array) || s.control.length!==32 ||
    !(s.held instanceof Uint32Array) || s.held.length!==PARTICLE_CAP || !(s.shocks instanceof Uint32Array) || s.shocks.length!==g.nbricks ||
    !(s.rayRemaining instanceof Uint32Array) || s.rayRemaining.length!==RAY_REQUEST_CAP || !Array.isArray(s.requests) ||
    !Array.isArray(s.pendingEvents) || !Array.isArray(s.airArchive) || !Number.isInteger(s.sequence) || s.sequence<0 || s.sequence>0xfffffffe ||
    !Number.isInteger(s.blastBatch) || s.blastBatch<1 || s.blastBatch>64 ||
    // each pool slot's decoration (src/v2/physics.js particleDecoRange); saves from before it have none
    (s.particleDeco!==undefined && (!(s.particleDeco instanceof Uint32Array) || s.particleDeco.length!==PARTICLE_CAP)) ||
    // each pool slot's set-off mark (particles.js setOffBase); saves from before it have none, so none are set off
    (s.setOff!==undefined && (!(s.setOff instanceof Uint32Array) || s.setOff.length!==PARTICLE_CAP))) throw new Error('Invalid native dynamics snapshot');
  // a set-off mark is the id of the flying charge in its slot (snapshotDynamicState drops the stale ones)
  if(s.setOff) for(let i=0;i<PARTICLE_CAP;i++) if(s.setOff[i] && s.setOff[i]!==s.particles[i*12+3]) throw new Error('Invalid native set-off mark');
  if(s.holdSession && (!Number.isInteger(s.holdSession.token) || s.holdSession.token<1 || s.holdSession.token>s.sequence ||
    !finiteVector(s.holdSession.position) || !finiteVector(s.holdSession.target) || !safeDynamicNumber(s.holdSession.radius) || s.holdSession.radius<0 ||
    !safeDynamicNumber(s.holdSession.strength) || s.holdSession.strength<0 || !Number.isInteger(s.holdSession.lastTick))) throw new Error('Invalid native physgun state');
  for(const token of s.held) if(token && token!==s.holdSession?.token) throw new Error('Unowned native held particle');
  const particleFloats=new Float32Array(s.particles.buffer,s.particles.byteOffset,s.particles.length);
  for(let i=0;i<PARTICLE_CAP;i++) {
    if(!s.particles[i*12+3]) continue;
    if([0,1,2,4,5,6].some(k=>!safeDynamicNumber(particleFloats[i*12+k]))) throw new Error('Invalid native particle coordinates/velocity');
    const tag=s.particles[i*12+7]&255;
    if(tag===0 || (tag<ELEMENTS.length && ELEMENTS[tag].kind===K.LIQUID && (s.particles[i*12+8]&0xffffff)===0) || (tag>=ELEMENTS.length && tag<254)) throw new Error('Invalid native particle material');
    if(tag<254) validateMaterialCore(s.particles.subarray(i*12+7,i*12+11));
    if(s.held[i] && tag>=254) throw new Error('A ray cannot be a held native material');
    if(tag===254 && (((s.particles[i*12+7]>>>8)&65535)>RAYS.PHOTON_LIFE || (s.particles[i*12+7]>>>24)>=ELEMENTS.length || s.particles[i*12+11]>2)) throw new Error('Invalid native photon lifetime/medium/face');
    if(tag===255 && (s.particles[i*12+8]>RAYS.NEUT_LIFE || ![0,3,4].includes(s.particles[i*12+7]>>>8))) throw new Error('Invalid native neutron lifetime/event');
    if(tag===254 && [8,9,10].some(k=>!safeDynamicNumber(particleFloats[i*12+k]) || particleFloats[i*12+k]<0)) throw new Error('Invalid native photon energy');
    if(tag===255 && (!safeDynamicNumber(particleFloats[i*12+9]) || particleFloats[i*12+9]<0 || s.particles[i*12+10]>2)) throw new Error('Invalid native neutron payload');
  }
  if(!new Float32Array(s.air.buffer,s.air.byteOffset,s.air.length).every(safeDynamicNumber)) throw new Error('Invalid native air values');
  const requests=new Map(),archive=new Map(),outside=new Map(),events=new Uint32Array(g.slots);
  for (const r of s.requests) {
    if (!Number.isInteger(r.slot) || r.slot<0 || r.slot>=RAY_REQUEST_CAP || requests.has(r.slot) ||
      !['photon','neutron'].includes(r.kind) || !finiteVector(r.position) || !finiteVector(r.direction) ||
      !safeDynamicNumber(r.radius) || r.radius<0 || !Number.isInteger(r.count) || r.count<1 || r.count>PARTICLE_CAP ||
      !Number.isInteger(r.requestId) || r.requestId<1 || r.requestId>s.sequence || s.rayRemaining[r.slot]>r.count ||
      ![undefined,0,1].includes(r.shape)) throw new Error('Invalid queued native ray');
    requests.set(r.slot,cloneRequest(r));
  }
  for(let slot=0;slot<RAY_REQUEST_CAP;slot++) if(s.rayRemaining[slot] && !requests.has(slot)) throw new Error('Unowned native ray obligation');
  for (const e of s.pendingEvents) {
    if (!finiteVector(e.worldCell) || !e.worldCell.every(Number.isInteger) || !Number.isInteger(e.bits) || e.bits<1 || e.bits>0xffffffff || (e.bits%PUFF_UNIT&~7)!==0 ||
      (e.bits>=PUFF_UNIT && !(e.bits&EVENT.GAS))) throw new Error('Invalid pending native event');
    const p=e.worldCell.map((x,a)=>x-s.origin[a]);
    if(isInside(p,g)) events[cellSlot(g,...p)]|=e.bits;
    else outside.set(key(e.worldCell),(outside.get(key(e.worldCell))??0)|e.bits);
  }
  for (const a of s.airArchive) {
    if (!finiteVector(a.worldCell) || !a.worldCell.every(Number.isInteger) || !(a.words instanceof Uint32Array) || a.words.length!==8 || archive.has(key(a.worldCell))) throw new Error('Invalid archived native air');
    if(!new Float32Array(a.words.buffer,a.words.byteOffset,a.words.length).every(safeDynamicNumber)) throw new Error('Invalid archived native air values');
    archive.set(key(a.worldCell),new Uint32Array(a.words));
  }
  return {requests,archive,outside,events,external};
}

/** Native recording driver. No method advancing physics submits, waits, or
 * imports/exports legacy state. The owner supplies the three-buffer Material
 * adapter described in docs/v2/dynamics.md. */
export class NativeDynamics {
  constructor(owner, { blastBatch=DYNAMICS_ABI.blastBatchDefault }={}) {
    if (!owner.nativeDynamics?.head || !owner.nativeDynamics.layout || !owner.nativeDynamics.group || !owner.events)
      throw new Error('NativeDynamics requires the native Material/aux/activity adapter and events');
    if (!Number.isInteger(blastBatch) || blastBatch<1 || blastBatch>64) throw new RangeError('blastBatch must be 1..64');
    this.owner=owner; this.gpu=owner.gpu; this.g=owner.g; this.blastBatch=blastBatch;
    this.origin=vector(owner.sim.origin); this.sequence=0; this.serial=0; this.airIndex=0;
    this.isReady=false; this.isIdle=false; this.disposed=false; this.stats=null;
    this.externalBlasts=new Map(); this.rayRequests=new Map(); this.airArchive=new Map(); this.pendingOutside=new Map();
    this.drawAdapter=null; this.holdSession=null; this.buffers=[];
    const gpu=this.gpu, g=this.g;
    const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST;
    const make=(label,size,extraUsage=0) => { const b=gpu.createBuffer({label:`v2 dynamics ${label}`,size:Math.max(16,Math.ceil(size/16)*16),usage:usage|extraUsage}); this.buffers.push(b); return b; };
    this.particles=make('particles',PARTICLE_CAP*PARTICLE_BYTES);
    this.flight=make('flight',(PARTICLE_CAP+1)*32); // one record per slot, then the sweep record
    this.claims=make('claims',g.slots*16);
    this.air=[make('air0',g.nbricks*32),make('air1',g.nbricks*32)];
    this.faces=make('faces and vacuum',g.nbricks*32); // the air source's per-brick cache (air.js)
    this.control=make('control',controlBufferWords(g)*4);
    // 0..48: the batch args workArgs fills, 48: [work, CAP/64, 1]; COUPLE_ARGS: the couple gate's
    // [work, 1, 1, 0, work] then the constant tail of [work, CAP/64, 1] at COUPLE_ARGS + 16;
    // then the brick lists' args (LIST_ARGS), written by listArgs.
    this.dispatchArgs=make('dispatch args',DISPATCH_ARGS_BYTES,GPUBufferUsage.INDIRECT);
    const args=new Uint32Array(DISPATCH_ARGS_BYTES/4);args[13]=PARTICLE_CAP/64;args[14]=1;
    args[COUPLE_ARGS/4+5]=PARTICLE_CAP/64;args[COUPLE_ARGS/4+6]=1;gpu.queue.writeBuffer(this.dispatchArgs,0,args);
    this.plans=make('plans',g.slots*16);
    const initial=new Float32Array(g.nbricks*8); for (let b=0;b<g.nbricks;b++) initial[b*8+6]=AIR.quietTicks;
    for (const b of this.air) gpu.queue.writeBuffer(b,0,initial);
    const L={ particles:gpu.layout('V2_PARTICLES',PARTICLES_LAYOUT), blasts:gpu.layout('V2_BLASTS',BLASTS_LAYOUT), air:gpu.layout('V2_AIR',AIR_LAYOUT), lists:gpu.layout('V2_LISTS',LISTS_LAYOUT),
      window:gpu.layout('V2_WINDOW',WINDOW_LAYOUT) };
    this.L=L;
    const bg=(layout,buffers,label) => gpu.bindGroup(layout,buffers.map((buffer,binding)=>({binding,resource:{buffer}})),label);
    this.bg=bg;
    // a window move's work buffer (shaders/v2/windowMove.js windowWork), made on the first move
    this.windowLayout=windowWork(g); this.work=null; this.windowEpoch=0; this.leaving=new Set();
    this.groups={
      particles:this.air.map(a=>bg(L.particles,[this.particles,this.flight,this.claims,a,this.control],'native particles')),
      blasts:this.air.map(a=>bg(L.blasts,[owner.events,this.particles,a,this.control,this.plans],'native blasts')),
      air:this.air.map((a,i)=>bg(L.air,[a,this.air[1-i],owner.events,this.control,this.faces],'native air')),
    };
    const lists=bg(L.lists,[this.control,this.dispatchArgs],'native list args'); this.groups.lists=[lists,lists];
    this.kernels={};
    const specs=[];
    for (const [family,generate,stages] of [['particles',particlesWGSL,PARTICLE_STAGES],['blasts',blastsWGSL,BLAST_STAGES],['air',airWGSL,AIR_STAGES],['lists',(g,_head,name)=>listsStageWGSL(g,name),LISTS_STAGES]])
      for (const stage of stages) specs.push({family,generate,stage,name:`v2${family}_${stage}`});
    // Built behind the grid's kernels, which the first frame waits for (physics.js dynamicsReady); the
    // longest of them (DYNAMICS_LONG_POLES) made first, so its idle build is the first to start.
    specs.sort((a,b)=>DYNAMICS_LONG_POLES.has(b.name)-DYNAMICS_LONG_POLES.has(a.name));
    for (const {family,generate,stage,name} of specs) {
      const single=(family==='blasts' && ['reset','normalize','allocate','freeScan','finish','rayEmit','externalBegin','externalGate','launchMark','launchPrefix'].includes(stage)) || (family==='particles' && ['clear','holdCOM'].includes(stage)) || family==='lists';
      this.kernels[`${family}/${stage}`]=gpu.kernel({name,build:'idle',first:DYNAMICS_LONG_POLES.has(name),code:generate(g,owner.nativeDynamics.head,stage),
        params:DynamicParams,workgroupSize:single?[1,1,1]:[64,1,1],layouts:[owner.nativeDynamics.layout,L[family]]});
    }
    this.ready=Promise.all(Object.values(this.kernels).map(k=>k.ready)).then(()=>{ if(!this.disposed) this.isReady=true; return this; });
    this.ready.catch(()=>{});
    // A World window's move (shaders/v2/windowMove.js) runs on the buffers alone, so it is built with the
    // grid, not behind it: the window follows while the grid steps and the rest of these still build.
    this.windowKernel=gpu.kernel({name:'v2window_move',build:'now',code:windowWGSL(g,owner.nativeDynamics.head,'move'),
      params:DynamicParams,workgroupSize:[64,1,1],layouts:[owner.nativeDynamics.layout,L.window]});
    this.windowReady=false;
    this.windowBuilt=Promise.resolve(this.windowKernel.ready).then(()=>{ if(!this.disposed) this.windowReady=true; return this; });
    this.windowBuilt.catch(()=>{});
  }
  get capabilities() {
    const ready=this.isReady&&!this.disposed;
    return { impulse:ready, photon:ready, neutron:ready, wind:ready, pressure:ready, vacuum:ready, cyclone:ready,
      externalBlast:ready, physicsReady:ready, drawReady:ready&&this.drawAdapter?.isReady===true, physgun:ready, bodyCoupling:ready };
  }
  supportsToolKind(kind) { return [...IMPULSE_KINDS,'physgun'].includes(kind) && this.capabilities[kind]===true; }
  // deco: each pool slot's decoration words (src/v2/physics.js particleDecoRange); decoActive: the
  // layer may hold paint (src/deco.js active; the view adds its display switch, decoShown)
  get renderState() { return { ...DYNAMICS_ABI, particles:this.particles, control:this.control, liveCountOffset:0,
    ready:this.isReady&&!this.disposed, interpolationSeconds:1/60, origin:[...this.origin],
    deco:this.owner.particleDecoRange ?? null, decoActive:this.owner.sim?.deco?.active===true }; }
  attachDrawAdapter(adapter) { this.drawAdapter=adapter; }
  _params(tick,extra={}) {
    // Only clocks are shared with V2Params; full/offset/edit markers belong to
    // the grid schema and must not leak into strict DynamicParams packing.
    // Wakes go where the next activity pass reads, whatever tick a caller numbers
    // its stage with (forcing allocates as owner.tick + 1): the owner's tick now.
    const {busyIn=0,busyOut=0}=this.owner._params?.(this.owner.tick??tick)??{};
    return {busyIn,busyOut,...nativeModes(this.owner.sim),tick,nativeJets:+(this.owner.jets?.isReady===true),origin:vector(this.owner.sim.origin),sequence:this.sequence,...extra};
  }
  _check() { if (!this.isReady || this.disposed) throw new Error('NativeDynamics is not ready'); }
  // Reads and writes of the buffers alone (snapshot, restore, a window's shift) need no kernel: they
  // run while the kernels build too, so a load, an undo or a save never waits for them.
  _checkState() { if (this.disposed) throw new Error('NativeDynamics is disposed'); }
  // A window's move and an undo's merge across one: the buffers and the move's own kernel, built with the grid.
  _checkWindow() { this._checkState(); if (!this.windowReady) throw new Error('Native window move is not built yet'); }
  /** Its kernels are still building (not ready, not disposed): requests wait in their queues. */
  get building() { return !this.isReady && !this.disposed; }
  _prepareAllocation(tick,params={},count) {
    this._check();
    // Match the kernel descriptor protocol: vectors are direct dispatches.
    const indirect=!Array.isArray(count) && count?.indirect;
    if(indirect && (indirect!==this.dispatchArgs || ![32,COUPLE_ARGS].includes(count.offset))) throw new Error('Unsupported native allocation dispatch');
    // Existing ray args are [hasWork ? 1 : 0, CAP/64, 1]; dThread folds
    // their two dimensions into exactly the same canonical pool slots.
    for(const stage of ALLOCATION_STAGES) {
      const size=indirect?(stage==='freeScan'?count:{indirect:this.dispatchArgs,offset:count.offset+16}):
        (stage==='freeScan'?1:PARTICLE_CAP/64);
      this._record('blasts',stage,size,tick,params);
    }
  }
  _record(family,stage,count,tick,params={}) {
    this._check();
    // Central hook covers custom/external sequences too. The exact workArgs
    // predicate gates pool preparation for indirect batches, never a CPU guess.
    if(family==='blasts' && stage==='allocate') this._prepareAllocation(tick,params,count);
    const k=this.kernels[`${family}/${stage}`];
    k.dispatch(this.gpu.frame,typeof count==='number'?fold(count):count,{bind:[this.owner.nativeDynamics.group,this.groups[family][this.airIndex]],
      header:this.owner.sim.header?.(),params:this._params(tick,params)});
    this.owner.sim.onPass?.(k.name,{kind:'compute',gpuMs:null});
  }
  // A force writer's launches planned and held for its caller's take (nativeForcing.js defer):
  // flushLaunch allocates them at bounded forcing's absolute velocity, once.
  deferLaunch(tick) { this.launchPending=tick; this._work(); }
  flushLaunch() {
    const tick=this.launchPending; if(tick==null || this.disposed || !this.isReady) return false;
    this.launchPending=null; this._allocate(tick,{mode:NATIVE_LAUNCH_MODE}); this._externalWork(); return true;
  }
  _work() { this.isIdle=false; this.serial++; }
  _externalWork() { this._work(); this.owner.wake(); }
  _allocate(tick,params={},indirect=false) {
    const size=(offset,count)=>indirect?{indirect:this.dispatchArgs,offset}:count;
    this._record('blasts','count',size(16,Math.ceil(this.g.nbricks/64)),tick,params);
    this._record('blasts','allocate',size(32,1),tick,params);
    const candidates=params.mode===13?params.boxSize.reduce((n,v)=>n*v,1):this.g.slots;
    this._record('blasts','apply',size(0,Math.ceil(candidates/64)),tick,params);
    this._record('blasts','children',size(48,Math.ceil(PARTICLE_CAP/64)),tick,params);
  }
  /** A Factory batch's box (inclusive cells lo..hi), before its plans: lists its bricks for the
   * batch's launch, clearing the plans of each the batch hasn't listed yet (blasts.js launchMark). */
  markLaunch(tick,lo,hi) {
    this._record('blasts','launchMark',1,tick,{mode:LAUNCH_MODE,boxStart:lo,boxSize:hi.map((v,a)=>v-lo[a]+1)});
  }
  /** After a batch's last plan: _allocate over the listed bricks alone (blasts.js launchCount,
   * launchPrefix, apply as LAUNCH_MODE); pool preparation and children are the particle pool's. */
  allocateLaunch(tick) {
    const p={mode:LAUNCH_MODE},args=offset=>({indirect:this.dispatchArgs,offset});
    this._record('lists','launch',1,tick,p); // publish the list: its length and args (_publish's)
    this._prepareAllocation(tick,p,1);
    this._record('blasts','launchCount',args(LIST_ARGS.launchBricks),tick,p);
    this._record('blasts','launchPrefix',1,tick,p);
    this._record('blasts','apply',args(LIST_ARGS.launchCells),tick,p);
    this._record('blasts','children',Math.ceil(PARTICLE_CAP/64),tick,p);
  }
  _rays(tick) { for (const [slot,r] of this.rayRequests) this._recordRay(slot,r,tick); }
  // A ray request's emission (blasts.js rayEmit): at V1's speed for its kind (dynamics-reference.js RAY_PHOTON_MS,
  // RAY_NEUTRON_FAST_MS) along its direction, or each in its own random direction for the zero direction (a
  // painted brush: V1 shaders/rays.js raysPaintFrag), placed in its brush's sphere (shape 0) or cube (1).
  _recordRay(slot,r,tick) {
    const speed=r.kind==='photon'?RAY_PHOTON_MS:RAY_NEUTRON_FAST_MS;
    this._record('blasts','rayEmit',1,tick,{mode:r.kind==='photon'?7:8,center:r.position,blastShape:r.shape??0,
      vector:r.direction.map(v=>v*speed),radius:r.radius,strength:r.count,sequence:r.requestId,substep:slot});
  }
  advanceParticles(tick) {
    // Rays spawn before clear samples the live count; hold neither spawns nor counts.
    this._work(); this._rays(tick);
    this._record('particles','clear',1,tick); this._hold(tick);
    for (const stage of RAY_STAGES) this._record('particles',stage,PARTICLE_CAP/64,tick);
    // V1 steps a ray RAY_STEPS_PER_TICK times a tick, at most one interaction a step (shaders/rays.js): the stages
    // again for the tick's later V1 steps, the rays alone, over the pool only when the first moved a ray (rayGate)
    this._record('lists','rayGate',1,tick);
    for (let step=1;step<RAY_STEPS_PER_TICK;step++) for (const stage of RAY_STAGES)
      this._record('particles',stage,{indirect:this.dispatchArgs,offset:RAY_ARGS},tick,{substep:step});
    // what is still flying takes part, as V1's moving cells did (src/v2/airborne.js): each packet
    // joins its cell's list (a dust packet counts its dust faces once all have), then the cells'
    // lists run a colour at a time, so no two whose footprints overlap run together, with the block
    // pass's partition offset this tick
    this._record('particles','reactClaim',PARTICLE_CAP/64,tick);
    this._record('particles','reactDust',PARTICLE_CAP/64,tick); // a dust cloud's faces, before any walker clears its notes
    const offset=this.owner._params?.(tick)?.offset??[0,0,0];
    for (let colour=0;colour<AIRBORNE_COLOURS;colour++) this._record('particles','react',PARTICLE_CAP/64,tick,{airborne:packAirborne(offset,colour)});
    this._record('blasts','airborneEvents',PARTICLE_CAP/64,tick);
  }
  applyExternalBlast(request) {
    if(this.disposed || !validExternalBlast(request,this.g)) return {status:'rejected',reason:'invalid or unavailable external blast'};
    if(this.sequence>=0xfffffffe) return {status:'rejected',reason:'native tool sequence exhausted'};
    let slot=0;while(this.externalBlasts.has(slot)) slot++;
    if(slot>=EXTERNAL_BLAST_CAP) return {status:'rejected',reason:'external blast queue full; retry explicitly'};
    const r=cloneExternalBlast({position:request.position,energy:request.energy,radius:request.radius,requestId:++this.sequence,...(request.selection?{selection:request.selection}:{})});
    this.externalBlasts.set(slot,r);this.gpu.write(this.control,(externalBlastBase(this.g)+slot)*4,new Uint32Array([0]));
    // (while the kernels build it waits in its queue, which every tick from their first records:
    // consumeMaterialEvents, in the order the blasts came)
    this._externalWork();if(this.isReady) this._recordExternalBlast(slot,r,this.owner.tick);
    return {status:'queued',requestId:r.requestId};
  }
  _recordExternalBlast(slot,r,tick) {
    const s=r.selection;
    const p={mode:14,center:r.position,strength:r.energy,radius:r.radius,sequence:r.requestId,substep:slot,
      blastEnd:s?.end??r.position,blastGrow:s?.grow??[0,0,0],blastShape:s?.shape??0,blastFilter:s?.filter??-1,
      blastBounded:+!!s?.lo,blastLo:s?.lo??[0,0,0],blastHi:s?.hi??[0,0,0],
      blastFade:+!!s?.fade,blastMasked:+!!s?.maskWords,blastMaskOrigin:s?.maskOrigin??[0,0,0]};
    if(s?.maskWords) this.gpu.write(this.control,externalMaskBase(this.g)*4,s.maskWords);
    this._record('blasts','externalBegin',1,tick,p);
    this._record('lists','workArgs',1,tick,p); // writes the batch's dispatch args itself: no copy
    for(const stage of ['plan','externalParticlePlan','sum','normalize','damagePlan','count','allocate','externalGate','externalParticleApply','apply','finish']) {
      if(stage==='externalParticlePlan' || stage==='externalParticleApply') { this._record('blasts',stage,{indirect:this.dispatchArgs,offset:48},tick,p);continue; }
      const offset=['normalize','allocate','externalGate','finish'].includes(stage)?32:
        (['sum','count'].includes(stage)?16:0);
      this._record('blasts',stage,{indirect:this.dispatchArgs,offset},tick,p);
    }
  }
  consumeMaterialEvents(tick) {
    // GPU completion, not CPU readback latency, decides exactly-once execution.
    for(const [slot,r] of this.externalBlasts) this._recordExternalBlast(slot,r,tick);
    // One batch a tick serves every serviceable charge of up to blastBatch bricks together (the
    // default 64: 4,096 cells a tick; V1 react.js has no cap), the lowest bricks; the rest stay intact
    // and busy for the next tick. A charge the batch's damage sets off goes off in the next tick's
    // batch, as V1's goes off the step its front reaches it; within a tick the front goes on through
    // the explosives it sets off for V1's steps a tick (blasts.js dSrcPasses, BLAST_CHAIN_STEPS).
    const size=offset=>({indirect:this.dispatchArgs,offset});
    this._record('blasts','reset',1,tick);
    // Select reads only bricks noted as holding a request (noteEvents); pick takes the charges.
    this._record('blasts','eventList',Math.ceil(this.g.nbricks/64),tick); this._publish('events',tick);
    this._record('blasts','select',this._listed('eventCells'),tick);
    this._record('blasts','pick',1,tick,{substep:this.blastBatch});
    // The args go straight into the separate INDIRECT buffer (the lists layout binds it only
    // there): never a read_write binding of the indirect source of the same dispatch.
    this._record('lists','workArgs',1,tick);
    this._record('blasts','planCharges',size(0),tick);
    this._record('blasts','normalizeCharges',size(32),tick);
    this._record('blasts','damageCharges',size(0),tick);
    this._allocate(tick,{},true);
    this._record('blasts','finishCharges',size(32),tick);
  }
  // A brick list's builders have run: publish its length and dispatch args (blasts.js listArgs).
  _publish(name,tick) { this._record('lists',name,1,tick); }
  _listed(arg) { return {indirect:this.dispatchArgs,offset:LIST_ARGS[arg]}; }
  advanceAir(tick) {
    const bricks=Math.ceil(this.g.nbricks/64);
    const {airMode,edge}=nativeModes(this.owner.sim),wind=AIR_VELOCITY_MODES.includes(airMode);
    // Source, the substeps, gas, couple and activity run over GPU-built brick lists; every
    // brick off a list would be an exact identity there (air.js, tools/v2/air-reach-check.mjs).
    this._record('air','list',bricks,tick); this._publish('source',tick);
    this._record('air','source',this._listed('source'),tick); this.airIndex^=1;
    // reach scatters from the start bricks, then from what each axis reached (air.js reach)
    this._record('air','reach',this._listed('source'),tick,{substep:0}); this._publish('reachX',tick);
    this._record('air','reach',this._listed('reachX'),tick,{substep:1}); this._publish('reachY',tick);
    this._record('air','reach',this._listed('reachY'),tick,{substep:2}); this._publish('step',tick);
    for (let i=0;i<AIR.substeps;i++) { this._record('air','step',this._listed('step'),tick,{substep:i}); this.airIndex^=1; }
    this._record('air','windList',bricks,tick); this._publish('wind',tick);
    // Both gas stages return at once without wind, and the boundary one off void edges.
    if(wind) this._record('air','gas',this._listed('windCells'),tick);
    if(wind && edge===EDGE.VOID) this._record('air','gasBoundary',this._listed('windCells'),tick);
    this._record('blasts','couplePlan',this._listed('windCells'),tick,{mode:COUPLE_MODE}); this._coupleAllocate(tick);
    this._record('air','activity',this._listed('wind'),tick);
  }
  // _allocate's run for the couple plans, with pool preparation, allocation and children behind
  // the GPU's coupleGate: without a request or a live particle they would find a free pool, no
  // neutron parent and zero counts, and the gate writes the free and requested totals they would.
  // apply runs over the wind list whatever the gate says. tools/v2/allocation-check.mjs
  _coupleAllocate(tick) {
    const p={mode:COUPLE_MODE},args=offset=>({indirect:this.dispatchArgs,offset});
    this._record('blasts','count',Math.ceil(this.g.nbricks/64),tick,p);
    this._record('lists','coupleGate',1,tick,p);
    this._record('blasts','allocate',args(COUPLE_ARGS),tick,p);
    this._record('blasts','apply',this._listed('windCells'),tick,p); // fractures need no allocation
    this._record('blasts','children',args(COUPLE_ARGS+16),tick,p);
  }
  /** strength is already integrated: impulse delta-v m/s; pressure/vacuum Pa;
   * wind/cyclone delta-v m/s. No hidden per-frame or second dt multiplier. */
  applyToolImpulse(request) {
    if (!this.isReady || this.disposed) return {status:'rejected',reason:'native dynamics not ready'};
    const kind=request?.kind,position=finiteVector(request?.position),direction=finiteVector(request?.direction??[0,0,0]);
    const radius=request?.radius??0, strength=request?.strength??0;
    if (!IMPULSE_KINDS.includes(kind) || !this.supportsToolKind(kind) || !position || !direction || !safeDynamicNumber(radius) || radius<0 ||
      !safeDynamicNumber(strength)) return {status:'rejected',reason:'invalid native tool request'};
    if (this.sequence>=0xfffffffe) return {status:'rejected',reason:'native tool sequence exhausted'};
    const requestId=++this.sequence,tick=this.owner.tick;
    if (kind==='photon' || kind==='neutron') {
      const count=request.count??1;
      if (!Number.isInteger(count) || count<1 || count>PARTICLE_CAP) return {status:'rejected',reason:'ray count must be 1..65536'};
      let slot=0; while(this.rayRequests.has(slot)) slot++;
      if (slot>=RAY_REQUEST_CAP) return {status:'rejected',reason:'native ray request queue is full; retry explicitly'};
      const norm=Math.hypot(...direction),r={kind,position,direction:norm?direction.map(v=>v/norm):direction,radius,count,requestId,shape:request.shape?1:0};
      this.rayRequests.set(slot,r); this.gpu.write(this.control,(rayRequestBase(this.g)+slot)*4,new Uint32Array([count]));
      this._externalWork(); this._recordRay(slot,r,tick);
      return {status:'queued',requestId};
    }
    const mode={impulse:2,wind:3,pressure:4,vacuum:5,cyclone:6}[kind];
    const norm=Math.hypot(...direction),unit=norm?direction.map(v=>v/norm):direction;
    const params={mode,center:position,radius,strength,vector:unit.map(v=>v*(kind==='impulse'?strength:1)),sequence:requestId};
    this._externalWork();
    if (kind==='impulse') {
      this._record('blasts','toolPlan',Math.ceil(this.g.slots/64),tick,params); this._allocate(tick,params);
    } else { this._record('air','tool',Math.ceil(this.g.nbricks/64),tick,params); this.airIndex^=1; }
    return {status:'queued',requestId,fallback:'unallocated material remains on the grid; readActivity reports capacityFallbacks'};
  }
  /** Exact centre-based AABB used by POV bodies and filtered cloud coupling.
   * Geometry is in WORLD cells, velocities/push speeds are SI m/s, ahead/lift
   * are dimensionless direction shares. No legacy B write or import occurs. */
  applyBodyCoupling(request) {
    if(!this.isReady || this.disposed) return {status:'rejected',reason:'native dynamics not ready'};
    const lo=finiteVector(request?.lo),hi=finiteVector(request?.hi),velocity=finiteVector(request?.velocity);
    const pushFluid=request?.pushFluid??0,pushPowder=request?.pushPowder??0,lift=request?.lift??0,only=request?.only??-1;
    const ahead=Array.from(request?.ahead??[0,0]);
    if(!lo || !hi || !velocity || lo.some((x,a)=>x>hi[a]) || ![pushFluid,pushPowder,lift].every(safeDynamicNumber) ||
      pushFluid<0 || pushPowder<0 || ahead.length!==2 || !ahead.every(safeDynamicNumber) ||
      !Number.isInteger(only) || only< -1 || only>=ELEMENTS.length)
      return {status:'rejected',reason:'invalid native body coupling request'};
    const origin=vector(this.owner.sim.origin),dims=[this.g.nx,this.g.ny,this.g.nz];
    const start=lo.map((x,a)=>Math.max(0,Math.ceil(x-origin[a]-0.5)));
    const last=hi.map((x,a)=>Math.min(dims[a]-1,Math.floor(x-origin[a]-0.5)));
    if(start.some((x,a)=>x>last[a])) return {status:'rejected',reason:'body box has no active cell centres'};
    if(this.sequence>=0xfffffffe) return {status:'rejected',reason:'native tool sequence exhausted'};
    const size=last.map((x,a)=>x-start[a]+1),count=size.reduce((a,b)=>a*b,1),requestId=++this.sequence,tick=this.owner.tick;
    const params={mode:13,center:lo,boxMax:hi,vector:velocity,strength:pushFluid,bodyPushPowder:pushPowder,
      bodyAhead:ahead,bodyLift:lift,bodyOnly:only,boxStart:start,boxSize:size,sequence:requestId};
    this._externalWork();
    this._record('particles','bodyCouple',PARTICLE_CAP/64,tick,params);
    this._record('blasts','bodyPlan',Math.ceil(count/64),tick,params);this._allocate(tick,params);
    return {status:'queued',requestId,candidateCells:count,shape:'centre-based AABB',fallback:'unallocated sources remain exact on grid'};
  }
  /** Real held-clump controller. GMod-style COM attraction/damping is stepped
   * by the same60Hz clock as particles, not the presentation frame rate. */
  applyPhysgun(request) {
    if (!this.isReady || this.disposed) return {status:'rejected',reason:'native dynamics not ready'};
    const mode=request?.mode,position=finiteVector(request?.position),destination=finiteVector(request?.target??request?.position);
    const direction=finiteVector(request?.direction??[0,0,0]),radius=request?.radius??1,dt=request?.dt??1/60;
    const strength=request?.strength??12,carried=finiteVector(request?.velocity??[0,0,0]);
    if (!['hold','fling','punt'].includes(mode) || !position || !destination || !direction || !carried ||
      !safeDynamicNumber(radius) || radius<0 || !safeDynamicNumber(strength) || strength<0 || !safeDynamicNumber(dt) || dt<0 || dt>0.25)
      return {status:'rejected',reason:'invalid native physgun request'};
    if(this.sequence>=0xfffffffe) return {status:'rejected',reason:'native tool sequence exhausted'};
    this._externalWork(); const tick=this.owner.tick;
    if(mode==='hold') {
      if(!this.holdSession) {
        const token=++this.sequence;
        this.holdSession={token,position:[...position],target:[...destination],radius,strength,lastTick:tick};
        const params={mode:9,center:position,radius,vector:[0,0,0],strength:0,sequence:token};
        this._record('particles','holdSelect',PARTICLE_CAP/64,tick,params);
        this._record('blasts','toolPlan',Math.ceil(this.g.slots/64),tick,params);this._allocate(tick,params);
      }
      // velocity: the target's own (m/s), the spring's feed-forward (pov physgun: V1's carry, the hold point's motion)
      this.holdSession.target=[...destination];this.holdSession.strength=strength;this.holdSession.lastTick=tick;this.holdSession.velocity=carried;
      return {status:'queued',requestId:this.holdSession.token,controller:'critically-damped COM',clockHz:60};
    }
    const token=this.holdSession?.token??0,norm=Math.hypot(...direction),velocity=direction.map(v=>norm?v/norm*strength:0);
    const requestId=++this.sequence,params={mode:mode==='fling'?10:11,center:position,radius,vector:velocity,strength:0,sequence:token};
    this._record('particles','holdApply',PARTICLE_CAP/64,tick,params);
    if(!token) { this._record('blasts','toolPlan',Math.ceil(this.g.slots/64),tick,{...params,sequence:requestId});this._allocate(tick,{...params,sequence:requestId}); }
    this.holdSession=null;return {status:'queued',requestId};
  }
  _hold(tick) {
    const hold=this.holdSession;if(!hold) return;
    if(tick-hold.lastTick>8) { this.releasePhysgun();return; }
    const params={mode:9,sequence:hold.token,center:hold.target,strength:hold.strength,radius:1/60,vector:hold.velocity??[0,0,0]};
    this._record('particles','holdCOM',1,tick,params);
    this._record('particles','holdApply',PARTICLE_CAP/64,tick,params);
  }
  releasePhysgun() {
    if(!this.holdSession || this.disposed) return {status:'rejected',reason:'no held native clump'};
    const requestId=this.holdSession.token;
    this._record('particles','holdApply',PARTICLE_CAP/64,this.owner.tick,{mode:12,sequence:requestId});
    this.holdSession=null;this._externalWork();return {status:'queued',requestId};
  }
  /** Enqueue beside the owner's idle read, at the SAME recording boundary. */
  async readActivity() {
    this._check(); const serial=this.serial,epoch=this.owner.epoch;
    const first=this.gpu.readback.buffer(this.control,0,80);
    const externalEntries=[...this.externalBlasts];
    const externalPending=this.gpu.readback.buffer(this.control,externalBlastBase(this.g)*4,EXTERNAL_BLAST_CAP*4);
    const rayEntries=[...this.rayRequests];
    const pending=this.gpu.readback.buffer(this.control,rayRequestBase(this.g)*4,RAY_REQUEST_CAP*4);
    const [raw,requests,externalRaw]=await Promise.all([first,pending,externalPending]);
    const done=new Uint32Array(externalRaw);
    // A completed immutable request may be acknowledged while later ticks run.
    // Identity protects restore/slot reuse; a serial check would fill the queue
    // forever whenever GPU readback takes longer than one simulation tick.
    if(!this.disposed) for(const [slot,request] of externalEntries)
      if(done[slot] && this.externalBlasts.get(slot)===request) this.externalBlasts.delete(slot);
    const c=new Uint32Array(raw),r=new Uint32Array(requests);
    let queued=0; for (const [slot,request] of rayEntries) { queued+=r[slot]; if(!this.disposed && r[slot]===0 && this.rayRequests.get(slot)===request) this.rayRequests.delete(slot); }
    const stats={particles:c[0],air:c[1],events:c[2],queued,capacityFallbacks:c[7],
      externalBlasts:this.externalBlasts.size,outsideObligations:this.pendingOutside.size,blastBatch:this.blastBatch,outflowPackets:c[16],sweepRetries:c[19]};
    if (!this.disposed && serial===this.serial && epoch===this.owner.epoch) {
      this.stats=stats; this.isIdle=stats.particles===0 && stats.air===0 && stats.events===0 && queued===0 && !stats.outsideObligations && !stats.externalBlasts;
    }
    return stats;
  }
  /** Every GPU copy is queued before the first await, alongside core/bank reads
   * made by the owner's persistence boundary. Transient plans/claims are absent. */
  async snapshotDynamicState() {
    this._checkState(); const g=this.g,origin=[...this.origin],serial=this.serial;
    const metadata={version:1,dims:[g.nx,g.ny,g.nz],origin,sequence:this.sequence,blastBatch:this.blastBatch,isIdle:this.isIdle,
      holdSession:this.holdSession?structuredClone(this.holdSession):null,
      externalBlasts:[...this.externalBlasts].map(([slot,r])=>({slot,...cloneExternalBlast(r)})),
      requests:[...this.rayRequests].map(([slot,r])=>({slot,...cloneRequest(r)})),
      airArchive:[...this.airArchive].map(([worldCell,words])=>({worldCell:worldCell.split(',').map(Number),words:new Uint32Array(words)})),
      pendingEvents:[...this.pendingOutside].map(([worldCell,bits])=>({worldCell:worldCell.split(',').map(Number),bits}))};
    // a leaving slab still being read back is the archive's and the obligations' as of now (shiftWindow)
    const leaving=[...this.leaving];
    const reads=[this.particles,this.air[this.airIndex],this.control,this.owner.events].map(b=>this.gpu.readback.buffer(b,0,b.size));
    // the flying matter's decoration, beside its records (recorded with them, before any await)
    const paint=this.owner.particleDecoRange, decoRead=paint ? this.gpu.readback.buffer(paint.buffer,paint.offset,PARTICLE_CAP*4) : null;
    const [particles,air,control,events]=(await Promise.all(reads)).map(b=>new Uint32Array(b));
    const particleDeco=decoRead ? new Uint32Array(await decoRead) : undefined;
    const archived=new Set(metadata.airArchive.map(a=>key(a.worldCell)));
    for(const out of await Promise.all(leaving)) {
      for(const [k,words] of out.air) if(!archived.has(k)) { archived.add(k); metadata.airArchive.push({worldCell:k.split(',').map(Number),words:new Uint32Array(words)}); }
      for(const [k,bits] of out.events) metadata.pendingEvents.push({worldCell:k.split(',').map(Number),bits});
    }
    for(let s=0;s<g.slots;s++) if(events[s]) metadata.pendingEvents.push({worldCell:slotCell(g,s).map((v,a)=>v+origin[a]),bits:events[s]});
    const externalBlastDone=control.slice(externalBlastBase(g),externalBlastBase(g)+EXTERNAL_BLAST_CAP);
    const owned=new Set(metadata.externalBlasts.map(r=>r.slot));
    for(let i=0;i<externalBlastDone.length;i++) if(!owned.has(i)) externalBlastDone[i]=0;
    // a charge a hit set off in flight (particles.js dShockHit) keeps its mark until it lands: a save
    // between that tick and its landing holds it, or the restored charge would land without going off.
    // A mark is its slot's flying charge's id; one left by a slot's earlier packet is stale, dropped.
    const setOff=control.slice(setOffBase(g),setOffBase(g)+PARTICLE_CAP);
    for(let i=0;i<PARTICLE_CAP;i++) if(setOff[i]!==particles[i*12+3]) setOff[i]=0;
    return {...metadata,...(particleDeco?{particleDeco}:{}),externalBlastDone,setOff,particles,air,control:control.slice(0,32),held:control.slice(heldBase(g),heldBase(g)+PARTICLE_CAP),shocks:control.slice(shockBase(g),shockBase(g)+g.nbricks),rayRemaining:control.slice(rayRequestBase(g),rayRequestBase(g)+RAY_REQUEST_CAP),serial};
  }
  restoreDynamicState(snapshot) {
    this._checkState(); const g=this.g,s=snapshot;
    const { requests, archive, outside, events, external } = validateDynamicState(s, g);
    // All validation precedes all writes. Bad saves never partially replace state.
    this.gpu.write(this.particles,0,s.particles);
    const paint=this.owner.particleDecoRange;
    if(paint) { if(s.particleDeco) this.gpu.write(paint.buffer,paint.offset,s.particleDeco); else this.gpu.frame.clear(paint.buffer,paint.offset,PARTICLE_CAP*4); }
    for(const b of this.air) this.gpu.write(b,0,s.air);
    // Pool sweeps skip an empty pool, so the live count must match the records.
    const control=s.control.slice(); control[0]=0;
    for(let i=0;i<PARTICLE_CAP;i++) if(s.particles[i*12+3]) control[0]++;
    this.gpu.frame.clear(this.control); this.gpu.write(this.control,0,control);
    this.gpu.write(this.control,rayRequestBase(g)*4,s.rayRemaining);
    this.gpu.write(this.control,externalBlastBase(g)*4,external.done);this.externalBlasts=external.requests;
    this.gpu.write(this.control,heldBase(g)*4,s.held); this.gpu.write(this.control,shockBase(g)*4,s.shocks);
    if(s.setOff) this.gpu.write(this.control,setOffBase(g)*4,s.setOff);
    this.gpu.write(this.owner.events,0,events); this.gpu.frame.clear(this.flight); this.gpu.frame.clear(this.claims); this.gpu.frame.clear(this.plans);
    this.owner.noteAllCells?.({events:true}); // requests written behind noteEvents: every brick may hold one
    this.airIndex=0; this.origin=[...s.origin]; this.sequence=s.sequence; // (blastBatch is this engine's own: a save from before sources were bricks holds 8 charges, not a cap)
    this.rayRequests=requests; this.airArchive=archive; this.pendingOutside=outside;
    this.holdSession=s.holdSession?structuredClone(s.holdSession):null;
    this.windowEpoch++; // a leaving slab still being read back belongs to the replaced state
    this._externalWork(); this.stats=null; // establish idle only from an epoch-checked read
  }
  /** A World window move (V1 moves its cells in the frame: src/sim.js shift), recorded now and never
   * awaited: the world keeps stepping and its tools keep working through it. Particles keep their world
   * coordinates; requests, air and shocks move with the cells (shaders/v2/windowMove.js), the slab that
   * leaves going to the world-keyed archive and the outside obligations once its readback lands (settled).
   * Brick-aligned, any axes (one at a time). */
  shiftWindow(delta) {
    this._checkWindow(); const d=this._windowDelta(delta);
    for(let a=0;a<3;a++) if(d[a]) this.recordWindowShift(d.map((v,b)=>b===a?v:0)).commit();
    return {status:'preserved',particles:'unchanged world coordinates',archivedAir:this.airArchive.size,pendingOutside:this.pendingOutside.size,
      settled:Promise.all([...this.leaving]).then(()=>this)};
  }
  _windowDelta(delta) {
    const d=finiteVector(delta);
    if(!d || !d.every(v=>Number.isInteger(v)&&v%4===0)) throw new Error('Native air window shifts must be brick-aligned integer cells');
    return d;
  }
  // The move's work buffer, at least `words` long (made on the first move; a larger slab or request list
  // grows it, the old one kept to dispose: queued work may still read it), and its bind groups.
  _windowWork(words) {
    if(!this.work || this.work.size<words*4) {
      this.work=this.gpu.createBuffer({label:'v2 dynamics window work',size:Math.ceil(words/4)*16,
        usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
      this.buffers.push(this.work); this.workUse=undefined;
      this.groups.window=this.air.map(a=>this.bg(this.L.window,[this.owner.events,a,this.control,this.work,this.particles],'native window move'));
    }
    return this.work;
  }
  // An upload into work: unordered unless a move recorded in the open encoder still reads it (a tool's two
  // moves in one frame), as the World window's restore upload is (world/window.js restore).
  _writeWork(offset,data) {
    const flushes=this.gpu.stats?.flushes;
    this.gpu.write(this.work,offset,data,{ordered:flushes===undefined || this.workUse===flushes});
  }
  _recordWindow(group,threads,params) {
    this._checkWindow();
    const k=this.windowKernel;
    k.dispatch(this.gpu.frame,fold(Math.ceil(threads/64)),{bind:[this.owner.nativeDynamics.group,group],
      header:this.owner.sim.header?.(),params:this._params(this.owner.tick,{blastBounded:0,boxStart:[0,0,0],boxSize:[0,0,0],shift:[0,0,0],substep:0,...params})});
    this.owner.sim.onPass?.(k.name,{kind:'compute',gpuMs:null});
    this.workUse=this.gpu.stats?.flushes;
  }
  /** One axis of a window move, recorded into the frame. Before the cores move: the slab that leaves is
   * gathered and read back, and the moved requests, air, shocks and legacy words written into work.
   * commit(), after the cores' move (src/v2/integration.js shift: its restore clears the requests and
   * the activity), copies them in. legacy: the bricks' legacy words move with them (the integrated move:
   * V1's shift moves A/B with the cells, so only the uncovered bricks' projection is stale). */
  recordWindowShift(delta,{legacy=false}={}) {
    this._checkWindow(); const d=this._windowDelta(delta),g=this.g,dims=[g.nx,g.ny,g.nz];
    const axis=d.findIndex(v=>v!==0);
    if(axis<0) return {commit(){},landed:Promise.resolve()};
    if(d.some((v,a)=>v && a!==axis)) throw new Error('Native window moves are one axis at a time');
    const old=[...this.origin],next=old.map((v,a)=>v+d[a]),width=Math.min(Math.abs(d[axis]),dims[axis]);
    const bricks=dims.map((n,a)=>(a===axis?width:n)/4),n=bricks[0]*bricks[1]*bricks[2];
    const leaveLo=dims.map((m,a)=>a===axis && d[a]<0 ? m-width : 0),enterLo=dims.map((m,a)=>a===axis && d[a]>0 ? m-width : 0);
    const brickAt=(lo,e)=>[e%bricks[0],Math.floor(e/bricks[0])%bricks[1],Math.floor(e/(bricks[0]*bricks[1]))].map((v,a)=>lo[a]+v*4);
    // what comes in: the archived air of the uncovered bricks (quiet without an entry), in the slab's
    // order, and the outside obligations now inside
    const incoming=new Uint32Array(n*8);
    for(let e=0;e<n;e++) {
      const k=key(brickAt(enterLo,e).map((v,a)=>v+next[a])),words=this.airArchive.get(k);
      if(words) { incoming.set(words,e*8); this.airArchive.delete(k); } else incoming.set(QUIET_AIR,e*8);
    }
    const list=[];
    for(const [k,bits] of this.pendingOutside) {
      const p=k.split(',').map((v,a)=>Number(v)-next[a]);
      if(isInside(p,g)) { list.push(cellSlot(g,...p),bits); this.pendingOutside.delete(k); }
    }
    const W=this.windowLayout,slab=W.slab(n),work=this._windowWork(W.words(n,list.length/2));
    this._writeWork(slab.incoming*4,incoming);
    const group=this.groups.window[this.airIndex],p={shift:d,boxSize:bricks};
    this._recordWindow(group,n*64,{...p,mode:WINDOW_MODE.GATHER,boxStart:leaveLo});
    const epoch=this.windowEpoch,read=this.gpu.readback.buffer(work,slab.leaveEvents*4,n*72*4);
    this._recordWindow(group,g.slots,{...p,mode:WINDOW_MODE.SHIFT,boxStart:enterLo});
    // what left, once it lands: air that differs from quiet into the archive, requests outside
    const landed=Promise.resolve(read).then(buf=>{
      const w=new Uint32Array(buf),out={air:[],events:[]};
      for(let e=0;e<n;e++) {
        const words=w.slice(64*n+e*8,64*n+e*8+8);
        if(!quietAir(words)) out.air.push([key(brickAt(leaveLo,e).map((v,a)=>v+old[a])),words]);
      }
      for(let i=0;i<64*n;i++) if(w[i]) {
        const b=Math.floor(i/64),l=i%64,at=brickAt(leaveLo,b);
        out.events.push([key([at[0]+l%4,at[1]+Math.floor(l/4)%4,at[2]+Math.floor(l/16)].map((v,a)=>v+old[a])),w[i]]);
      }
      if(epoch===this.windowEpoch && !this.disposed) this._land(out);
      return out;
    });
    this.leaving.add(landed);
    landed.then(()=>this.leaving.delete(landed),()=>this.leaving.delete(landed));
    const commit=()=>{
      const f=this.gpu.frame,owner=this.owner;
      f.copy(work,W.events*4,owner.events,0,g.slots*4);
      for(const b of this.air) f.copy(work,W.air*4,b,0,g.nbricks*32);
      if(legacy && owner.act && owner.layout) f.copy(work,W.legacy*4,owner.act,owner.layout.legacy*4,g.nbricks*4);
      f.copy(work,W.shocks*4,this.control,shockBase(g)*4,g.nbricks*4);
      if(list.length) {
        this._writeWork(slab.list*4,Uint32Array.from(list));
        this._recordWindow(this.groups.window[0],list.length/2,{mode:WINDOW_MODE.EVENTS,boxSize:bricks,substep:list.length/2});
      }
      this._moved(next);
    };
    return {commit,landed};
  }
  // A leaving slab's readback merged into the archive and the outside obligations.
  // A cell back inside the window by then (never, while the window waits for its slab: world/window.js) is the grid's.
  _land(out,into=this) {
    const inside=k=>isInside(k.split(',').map((v,a)=>Number(v)-into.origin[a]),this.g);
    for(const [k,words] of out.air) if(!inside(k)) into.airArchive.set(k,words);
    for(const [k,bits] of out.events) if(!inside(k)) into.pendingOutside.set(k,(into.pendingOutside.get(k)??0)|bits);
  }
  // After a move's or a merge's copies: per-tick scratch starts over (restoreDynamicState's), the
  // derived brick caches are read again (the air source's faces, the event census).
  _moved(origin) {
    const f=this.gpu.frame;
    f.clear(this.flight); f.clear(this.claims); f.clear(this.plans);
    this.airIndex=0; this.origin=[...origin];
    this.owner.noteAllCells?.({events:true});
    this._externalWork(); this.stats=null;
  }
  /** An undo entry's dynamics (src/sim.js snapshot): GPU copies recorded beside the cores', no readback,
   * so a stroke's start costs what V1's A/B copy does and an undo right after waits for nothing. `t`: an
   * earlier entry's copies, reused. A leaving slab still being read back lands in the entry's archive too. */
  captureUndo(t=null) {
    this._checkState(); const g=this.g,f=this.gpu.frame,owner=this.owner,paint=owner.particleDecoRange;
    const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST;
    const mk=(label,size)=>this.gpu.createBuffer({label:`v2 undo ${label}`,size,usage});
    t??={particles:mk('particles',this.particles.size),air:mk('air',this.air[0].size),events:mk('events',owner.events.size),
      control:mk('control',this.control.size),deco:mk('particle deco',PARTICLE_CAP*4)};
    f.copy(this.particles,0,t.particles,0,this.particles.size);
    f.copy(this.air[this.airIndex],0,t.air,0,this.air[0].size);
    f.copy(owner.events,0,t.events,0,owner.events.size);
    f.copy(this.control,0,t.control,0,this.control.size);
    if(paint) f.copy(paint.buffer,paint.offset,t.deco,0,PARTICLE_CAP*4); else f.clear(t.deco);
    const meta=t.meta={origin:[...this.origin],sequence:this.sequence,blastBatch:this.blastBatch,
      holdSession:this.holdSession?structuredClone(this.holdSession):null,
      externalBlasts:new Map([...this.externalBlasts].map(([slot,r])=>[slot,cloneExternalBlast(r)])),
      rayRequests:new Map([...this.rayRequests].map(([slot,r])=>[slot,cloneRequest(r)])),
      // (archived words are never written in place: a move replaces or drops an entry)
      airArchive:new Map(this.airArchive),pendingOutside:new Map(this.pendingOutside),leaving:new Set(this.leaving)};
    for(const l of meta.leaving) l.then(out=>{ if(t.meta===meta) { this._land(out,meta); meta.leaving.delete(l); } },()=>{});
    t.buffers=[t.particles,t.air,t.events,t.control,t.deco];
    return t;
  }
  /** An undo entry taken where the window is now (src/sim.js undo): every dynamic word back. After the
   * cores' restore (it clears the requests). */
  restoreUndo(t) {
    this._checkState(); const f=this.gpu.frame,owner=this.owner,paint=owner.particleDecoRange,m=t.meta;
    f.copy(t.particles,0,this.particles,0,this.particles.size);
    for(const b of this.air) f.copy(t.air,0,b,0,this.air[0].size);
    f.copy(t.events,0,owner.events,0,owner.events.size);
    f.copy(t.control,0,this.control,0,this.control.size);
    if(paint) f.copy(t.deco,0,paint.buffer,paint.offset,PARTICLE_CAP*4);
    this.windowEpoch++;   // a leaving slab read since lands in the entry's archive, not over it
    this.sequence=m.sequence; this.blastBatch=m.blastBatch;
    this.holdSession=m.holdSession?structuredClone(m.holdSession):null;
    this.externalBlasts=new Map([...m.externalBlasts].map(([slot,r])=>[slot,cloneExternalBlast(r)]));
    this.rayRequests=new Map([...m.rayRequests].map(([slot,r])=>[slot,cloneRequest(r)]));
    this.airArchive=new Map(m.airArchive); this.pendingOutside=new Map(m.pendingOutside);
    const epoch=this.windowEpoch;
    for(const l of m.leaving) l.then(out=>{ if(epoch===this.windowEpoch && !this.disposed) this._land(out); },()=>{});
    this._moved(m.origin);
  }
  /** An undo entry taken before the window moved (src/sim.js undo, V1's undoShift): the cells its window
   * shares with this one take its requests, air and flying matter, every other cell keeps what it holds,
   * as V1 restores the shared cells and keeps the rest. shift: [dx, 0, dz], this origin less the entry's.
   * Recorded before the cores' merge; commit() after it (src/v2/integration.js undo). */
  recordUndoMerge(t,shift) {
    this._checkWindow(); const g=this.g,f=this.gpu.frame,owner=this.owner,W=this.windowLayout,paint=owner.particleDecoRange;
    const work=this._windowWork(W.words(0,0));
    // the current requests, air and legacy words where the entry's window holds nothing
    f.copy(owner.events,0,work,W.events*4,g.slots*4);
    f.copy(this.air[this.airIndex],0,work,W.air*4,g.nbricks*32);
    const legacy=owner.act && owner.layout;
    if(legacy) f.copy(owner.act,owner.layout.legacy*4,work,W.legacy*4,g.nbricks*4);
    const from=this.bg(this.L.window,[t.events,t.air,this.control,work,this.particles],'native undo merge');
    this._recordWindow(from,g.slots,{mode:WINDOW_MODE.SHIFT,shift,blastBounded:1});
    // the flying matter over the shared cells: the entry's records, set-off marks and decoration
    f.copy(t.particles,0,work,W.pool.particles*4,PARTICLE_CAP*48);
    f.copy(t.control,setOffBase(g)*4,work,W.pool.setOff*4,PARTICLE_CAP*4);
    f.copy(t.deco,0,work,W.pool.deco*4,PARTICLE_CAP*4);
    f.clear(this.control,0,4);   // (the live count, recounted by the merge)
    const o=this.origin,e=t.meta.origin,dims=[g.nx,g.ny,g.nz];
    this._recordWindow(this.groups.window[this.airIndex],PARTICLE_CAP,{mode:WINDOW_MODE.PARTICLES,
      blastLo:dims.map((_,a)=>Math.max(o[a],e[a])),blastHi:dims.map((n,a)=>Math.min(o[a],e[a])+n)});
    return {commit:()=>{
      f.copy(work,W.events*4,owner.events,0,g.slots*4);
      for(const b of this.air) f.copy(work,W.air*4,b,0,g.nbricks*32);
      if(legacy) f.copy(work,W.legacy*4,owner.act,owner.layout.legacy*4,g.nbricks*4);
      this._moved(this.origin);
    }};
  }
  shiftOrigin(delta) { return this.shiftWindow(delta); }
  dispose() {
    if(this.disposed) return; this.disposed=true; this.isReady=false; this.isIdle=false;
    this.drawAdapter?.dispose?.(); this.drawAdapter=null;
    for(const b of this.buffers) b.destroy(); this.buffers=[];
  }
}
