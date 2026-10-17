import { RAYS } from '../rays.js';
import { validateMaterialCore } from './materialValidation.js';
import { EXTERNAL_BLAST_CAP, validExternalBlast, validateExternalBlasts, cloneExternalBlast } from './externalBlast.js';
import { fold } from '../gpu/kernels.js';
import { ELEMENTS, K } from '../elements.js';
import { nativeModes } from './modes.js';
import { cellSlot, slotCell, brickCoordOf } from '../shaders/common.js';
import { DynamicParams, particlesWGSL, PARTICLE_STAGES, PARTICLES_LAYOUT, heldBase, shockBase } from '../shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES, BLASTS_LAYOUT, controlWords, rayRequestBase, RAY_REQUEST_CAP, externalBlastBase, externalMaskBase, ALLOCATION_STAGES, COUPLE_MODE } from '../shaders/v2/blasts.js';
import { AIR as AIR_MODE, EDGE } from '../simModes.js';
import { airWGSL, AIR_STAGES, AIR_LAYOUT } from '../shaders/v2/air.js';
import { PARTICLE_CAP, PARTICLE_BYTES, AIR, CELL_M } from './dynamics-reference.js';

export const DYNAMICS_ABI = Object.freeze({ version: 1, particleBytes: PARTICLE_BYTES, capacity: PARTICLE_CAP,
  position: 'world cells', velocity: 'm/s', particleIdOffset: 12, coreOffsets: [28,32,36,40], bankOffset: 44,
  airBytes: 32, airOrder: 'native brick-major', airVelocity: 'm/s', airPressure: 'Pa',
  group0: ['cells','aux','activity'], particleGroup1: ['particles','flight','claims','air(read)','control'],
  blastGroup1: ['events','particles','air','control','plans'], airGroup1: ['airIn(read)','airOut','events','control','faces'],
  maxStorageBuffers: 8, blastBatchDefault: 8, blastBatchMax: 64 });
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
    !Number.isInteger(s.blastBatch) || s.blastBatch<1 || s.blastBatch>64) throw new Error('Invalid native dynamics snapshot');
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
      !Number.isInteger(r.requestId) || r.requestId<1 || r.requestId>s.sequence || s.rayRemaining[r.slot]>r.count) throw new Error('Invalid queued native ray');
    requests.set(r.slot,cloneRequest(r));
  }
  for(let slot=0;slot<RAY_REQUEST_CAP;slot++) if(s.rayRemaining[slot] && !requests.has(slot)) throw new Error('Unowned native ray obligation');
  for (const e of s.pendingEvents) {
    if (!finiteVector(e.worldCell) || !e.worldCell.every(Number.isInteger) || !Number.isInteger(e.bits) || e.bits<1 || (e.bits&~7)!==0) throw new Error('Invalid pending native event');
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
  constructor(owner, { blastBatch=8 }={}) {
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
    this.faces=make('faces',g.nbricks*16);
    this.control=make('control',controlWords(g)*4);
    this.dispatchArgs=make('dispatch args',64,GPUBufferUsage.INDIRECT);
    const args=new Uint32Array(16);args[13]=PARTICLE_CAP/64;args[14]=1;gpu.queue.writeBuffer(this.dispatchArgs,0,args);
    this.plans=make('plans',g.slots*16);
    const initial=new Float32Array(g.nbricks*8); for (let b=0;b<g.nbricks;b++) initial[b*8+6]=AIR.quietTicks;
    for (const b of this.air) gpu.queue.writeBuffer(b,0,initial);
    const L={ particles:gpu.layout('V2_PARTICLES',PARTICLES_LAYOUT), blasts:gpu.layout('V2_BLASTS',BLASTS_LAYOUT), air:gpu.layout('V2_AIR',AIR_LAYOUT) };
    const bg=(layout,buffers,label) => gpu.bindGroup(layout,buffers.map((buffer,binding)=>({binding,resource:{buffer}})),label);
    this.groups={
      particles:this.air.map(a=>bg(L.particles,[this.particles,this.flight,this.claims,a,this.control],'native particles')),
      blasts:this.air.map(a=>bg(L.blasts,[owner.events,this.particles,a,this.control,this.plans],'native blasts')),
      air:this.air.map((a,i)=>bg(L.air,[a,this.air[1-i],owner.events,this.control,this.faces],'native air')),
    };
    this.kernels={};
    for (const [family,generate,stages] of [['particles',particlesWGSL,PARTICLE_STAGES],['blasts',blastsWGSL,BLAST_STAGES],['air',airWGSL,AIR_STAGES]]) {
      for (const stage of stages) {
        const single=(family==='blasts' && ['reset','normalize','allocate','freeScan','finish','rayEmit','workArgs','externalBegin','externalGate'].includes(stage)) || (family==='particles' && ['clear','holdCOM'].includes(stage));
        const name=`v2${family}_${stage}`;
        this.kernels[`${family}/${stage}`]=gpu.kernel({name,build:'idle',code:generate(g,owner.nativeDynamics.head,stage),
          params:DynamicParams,workgroupSize:single?[1,1,1]:[64,1,1],layouts:[owner.nativeDynamics.layout,L[family]]});
      }
    }
    this.ready=Promise.all(Object.values(this.kernels).map(k=>k.ready)).then(()=>{ if(!this.disposed) this.isReady=true; return this; });
    this.ready.catch(()=>{});
  }
  get capabilities() {
    const ready=this.isReady&&!this.disposed;
    return { impulse:ready, photon:ready, neutron:ready, wind:ready, pressure:ready, vacuum:ready, cyclone:ready,
      externalBlast:ready, physicsReady:ready, drawReady:ready&&this.drawAdapter?.isReady===true, physgun:ready, bodyCoupling:ready };
  }
  supportsToolKind(kind) { return [...IMPULSE_KINDS,'physgun'].includes(kind) && this.capabilities[kind]===true; }
  get renderState() { return { ...DYNAMICS_ABI, particles:this.particles, control:this.control, liveCountOffset:0,
    ready:this.isReady&&!this.disposed, interpolationSeconds:1/60, origin:[...this.origin] }; }
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
  _prepareAllocation(tick,params={},count) {
    this._check();
    // Match the kernel descriptor protocol: vectors are direct dispatches.
    const indirect=!Array.isArray(count) && count?.indirect;
    if(indirect && (indirect!==this.dispatchArgs || count.offset!==32)) throw new Error('Unsupported native allocation dispatch');
    // Existing ray args are [hasWork ? 1 : 0, CAP/64, 1]; dThread folds
    // their two dimensions into exactly the same canonical pool slots.
    for(const stage of ALLOCATION_STAGES) {
      const size=indirect?(stage==='freeScan'?count:{indirect:this.dispatchArgs,offset:48}):
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
  _rays(tick) { for (const [slot,r] of this.rayRequests) this._recordRay(slot,r,tick); }
  _recordRay(slot,r,tick) {
    this._record('blasts','rayEmit',1,tick,{mode:r.kind==='photon'?7:8,center:r.position,
      vector:r.direction.map(v=>v*36),radius:r.radius,strength:r.count,sequence:r.requestId,substep:slot});
  }
  advanceParticles(tick) {
    // Rays spawn before clear samples the live count; hold neither spawns nor counts.
    this._work(); this._rays(tick);
    this._record('particles','clear',1,tick); this._hold(tick);
    for (const stage of ['integrate','elect','impact','deposit']) this._record('particles',stage,PARTICLE_CAP/64,tick);
  }
  applyExternalBlast(request) {
    if(!this.isReady || this.disposed || !validExternalBlast(request,this.g)) return {status:'rejected',reason:'invalid or unavailable external blast'};
    if(this.sequence>=0xfffffffe) return {status:'rejected',reason:'native tool sequence exhausted'};
    let slot=0;while(this.externalBlasts.has(slot)) slot++;
    if(slot>=EXTERNAL_BLAST_CAP) return {status:'rejected',reason:'external blast queue full; retry explicitly'};
    const r=cloneExternalBlast({position:request.position,energy:request.energy,radius:request.radius,requestId:++this.sequence,...(request.selection?{selection:request.selection}:{})});
    this.externalBlasts.set(slot,r);this.gpu.write(this.control,(externalBlastBase(this.g)+slot)*4,new Uint32Array([0]));
    this._externalWork();this._recordExternalBlast(slot,r,this.owner.tick);
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
    this._record('blasts','workArgs',1,tick,p);
    this.gpu.frame.copy(this.control,20*4,this.dispatchArgs,0,48);
    this.gpu.frame.copy(this.control,28*4,this.dispatchArgs,48,4);
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
    // Deterministic bounded batches, not an unbounded GPU event loop. At the
    // default the service rate is 480 charges/s; remaining sources stay intact
    // and busy. Dense chains are explicitly latency-limited, not called parity.
    const size=offset=>({indirect:this.dispatchArgs,offset});
    this._record('blasts','reset',1,tick);
    for (let n=0;n<this.blastBatch;n++) {
      // After a batch without work nothing has changed, so selecting again
      // finds exactly what it found. Later batches select through the last
      // batch's grid args (zero without work); that finish reset the selection.
      this._record('blasts','select',n?size(0):Math.ceil(this.g.slots/64),tick);
      this._record('blasts','workArgs',1,tick);
      // Separate INDIRECT buffer: never bind a read_write storage buffer as
      // the indirect source of that same dispatch (WebGPU usage conflict).
      this.gpu.frame.copy(this.control,20*4,this.dispatchArgs,0,48);
      this.gpu.frame.copy(this.control,28*4,this.dispatchArgs,48,4);
      this._record('blasts','plan',size(0),tick);
      this._record('blasts','sum',size(16),tick);
      this._record('blasts','normalize',size(32),tick);
      this._record('blasts','damagePlan',size(0),tick);
      this._allocate(tick,{},true);
      this._record('blasts','finish',size(32),tick,{substep:this.blastBatch-1-n}); // batches still to select
    }
  }
  advanceAir(tick) {
    const bricks=Math.ceil(this.g.nbricks/64),cells=Math.ceil(this.g.slots/64);
    const {airMode,edge}=nativeModes(this.owner.sim),wind=AIR_VELOCITY_MODES.includes(airMode);
    this.gpu.frame.clear(this.control,4,8); // source recounts durable events, activity air; not live particles
    this._record('air','source',bricks,tick); this.airIndex^=1;
    for (let axis=0;axis<3;axis++) this._record('air','reach',bricks,tick,{substep:axis});
    for (let i=0;i<AIR.substeps;i++) { this._record('air','step',bricks,tick,{substep:i}); this.airIndex^=1; }
    // Both gas stages return at once without wind, and the boundary one off void edges.
    if(wind) this._record('air','gas',cells,tick);
    if(wind && edge===EDGE.VOID) this._record('air','gasBoundary',cells,tick);
    this._record('blasts','couplePlan',cells,tick,{mode:COUPLE_MODE}); this._allocate(tick,{mode:COUPLE_MODE});
    this._record('air','activity',bricks,tick);
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
      const norm=Math.hypot(...direction),r={kind,position,direction:norm?direction.map(v=>v/norm):direction,radius,count,requestId};
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
    const strength=request?.strength??12;
    if (!['hold','fling','punt'].includes(mode) || !position || !destination || !direction ||
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
      this.holdSession.target=[...destination];this.holdSession.strength=strength;this.holdSession.lastTick=tick;
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
    const params={mode:9,sequence:hold.token,center:hold.target,strength:hold.strength,radius:1/60};
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
    this._check(); const g=this.g,origin=[...this.origin],serial=this.serial;
    const metadata={version:1,dims:[g.nx,g.ny,g.nz],origin,sequence:this.sequence,blastBatch:this.blastBatch,isIdle:this.isIdle,
      holdSession:this.holdSession?structuredClone(this.holdSession):null,
      externalBlasts:[...this.externalBlasts].map(([slot,r])=>({slot,...cloneExternalBlast(r)})),
      requests:[...this.rayRequests].map(([slot,r])=>({slot,...cloneRequest(r)})),
      airArchive:[...this.airArchive].map(([worldCell,words])=>({worldCell:worldCell.split(',').map(Number),words:new Uint32Array(words)})),
      pendingEvents:[...this.pendingOutside].map(([worldCell,bits])=>({worldCell:worldCell.split(',').map(Number),bits}))};
    const reads=[this.particles,this.air[this.airIndex],this.control,this.owner.events].map(b=>this.gpu.readback.buffer(b,0,b.size));
    const [particles,air,control,events]=(await Promise.all(reads)).map(b=>new Uint32Array(b));
    for(let s=0;s<g.slots;s++) if(events[s]) metadata.pendingEvents.push({worldCell:slotCell(g,s).map((v,a)=>v+origin[a]),bits:events[s]});
    const externalBlastDone=control.slice(externalBlastBase(g),externalBlastBase(g)+EXTERNAL_BLAST_CAP);
    const owned=new Set(metadata.externalBlasts.map(r=>r.slot));
    for(let i=0;i<externalBlastDone.length;i++) if(!owned.has(i)) externalBlastDone[i]=0;
    return {...metadata,externalBlastDone,particles,air,control:control.slice(0,32),held:control.slice(heldBase(g),heldBase(g)+PARTICLE_CAP),shocks:control.slice(shockBase(g),shockBase(g)+g.nbricks),rayRemaining:control.slice(rayRequestBase(g),rayRequestBase(g)+RAY_REQUEST_CAP),serial};
  }
  restoreDynamicState(snapshot) {
    this._check(); const g=this.g,s=snapshot;
    const { requests, archive, outside, events, external } = validateDynamicState(s, g);
    // All validation precedes all writes. Bad saves never partially replace state.
    this.gpu.write(this.particles,0,s.particles);
    for(const b of this.air) this.gpu.write(b,0,s.air);
    // Pool sweeps skip an empty pool, so the live count must match the records.
    const control=s.control.slice(); control[0]=0;
    for(let i=0;i<PARTICLE_CAP;i++) if(s.particles[i*12+3]) control[0]++;
    this.gpu.frame.clear(this.control); this.gpu.write(this.control,0,control);
    this.gpu.write(this.control,rayRequestBase(g)*4,s.rayRemaining);
    this.gpu.write(this.control,externalBlastBase(g)*4,external.done);this.externalBlasts=external.requests;
    this.gpu.write(this.control,heldBase(g)*4,s.held); this.gpu.write(this.control,shockBase(g)*4,s.shocks);
    this.gpu.write(this.owner.events,0,events); this.gpu.frame.clear(this.flight); this.gpu.frame.clear(this.claims); this.gpu.frame.clear(this.plans);
    this.airIndex=0; this.origin=[...s.origin]; this.sequence=s.sequence; this.blastBatch=s.blastBatch;
    this.rayRequests=requests; this.airArchive=archive; this.pendingOutside=outside;
    this.holdSession=s.holdSession?structuredClone(s.holdSession):null;
    this._externalWork(); this.stats=null; // establish idle only from an epoch-checked read
  }
  /** Explicit world/persistence boundary; brick-aligned windows preserve exact
   * air words in a sparse world-coordinate archive. No particle coordinate is
   * rewritten. Call/await with the app paused, before resuming the new window. */
  async shiftWindow(delta) {
    this._check(); delta=finiteVector(delta);
    if(!delta || !delta.every(v=>Number.isInteger(v)&&v%4===0)) throw new Error('Native air window shifts must be brick-aligned integer cells');
    const old=[...this.origin],next=old.map((v,a)=>v+delta[a]);
    const snapshot=await this.snapshotDynamicState(),g=this.g;
    const archive=new Map(this.airArchive);
    for(let b=0;b<g.nbricks;b++) archive.set(key(brickCoordOf(g,b).map((v,a)=>old[a]+v*4)),snapshot.air.slice(b*8,b*8+8));
    const air=new Uint32Array(g.nbricks*8),floats=new Float32Array(air.buffer);
    for(let b=0;b<g.nbricks;b++) {
      const k=key(brickCoordOf(g,b).map((v,a)=>next[a]+v*4)); const words=archive.get(k);
      if(words) { air.set(words,b*8); archive.delete(k); } else floats[b*8+6]=AIR.quietTicks;
    }
    snapshot.origin=next; snapshot.air=air;
    snapshot.airArchive=[...archive].map(([worldCell,words])=>({worldCell:worldCell.split(',').map(Number),words}));
    this.restoreDynamicState(snapshot);
    return {status:'preserved',particles:'unchanged world coordinates',archivedAir:archive.size,pendingOutside:this.pendingOutside.size};
  }
  shiftOrigin(delta) { return this.shiftWindow(delta); }
  dispose() {
    if(this.disposed) return; this.disposed=true; this.isReady=false; this.isIdle=false;
    this.drawAdapter?.dispose?.(); this.drawAdapter=null;
    for(const b of this.buffers) b.destroy(); this.buffers=[];
  }
}
