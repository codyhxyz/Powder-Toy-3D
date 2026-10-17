import { fold } from '../gpu/kernels.js';
import { jetsWGSL, JETS_LAYOUT, JET_STAGES, DynamicParams } from '../shaders/v2/jets.js';
import { ARGS2 } from '../shaders/v2.js';

/** Exact accepted-face diversion. Shares native48B records and canonical free
 * slots with NativeDynamics; owns no particle pool or legacy conversion. */
export class NativeJets {
  constructor(owner) {
    this.owner=owner; this.isReady=false; this.disposed=false;
    const gpu=owner.gpu, dynamics=owner.dynamics;
    const layout=gpu.layout('V2_JETS',JETS_LAYOUT);
    this.group=gpu.bindGroup(layout,[owner.liquidScratch,owner.jetMask,dynamics.particles,dynamics.control]
      .map((buffer,binding)=>({binding,resource:{buffer}})),'native liquid jets');
    this.kernels=Object.fromEntries(JET_STAGES.map(stage=>[stage,gpu.kernel({
      name:`v2jets_${stage}`,build:'idle',code:jetsWGSL(owner.g,stage),params:DynamicParams,
      workgroupSize:stage==='allocate'?[1,1,1]:[64,1,1],layouts:[owner.nativeDynamics.layout,layout],
    })]));
    this.ready=Promise.all(Object.values(this.kernels).map(k=>k.ready)).then(()=>{if(!this.disposed)this.isReady=true;return this;});
    this.ready.catch(()=>{});
  }
  advance(tick,substep) {
    if(!this.isReady || this.disposed) throw new Error('NativeJets not ready');
    const o=this.owner;
    // Candidates and spawns: the cells of the liquid list's bricks. Counts keep every brick's prefix.
    for(const stage of JET_STAGES) {
      const count=stage==='allocate'?[1,1,1]:stage==='count'?fold(Math.ceil(o.g.nbricks/64)):{indirect:o.args,offset:ARGS2.LIQUID*4};
      if(stage==='allocate') o.dynamics._prepareAllocation(tick,{substep});
      const k=this.kernels[stage];
      k.dispatch(o.gpu.frame,count,{bind:[o.nativeDynamics.group,this.group],header:o.sim.header(),params:o.dynamics._params(tick,{substep})});
      o.sim.onPass?.(k.name,{kind:'compute',gpuMs:null});
    }
    o.dynamics._work();
  }
  dispose() { this.disposed=true;this.isReady=false; }
}
