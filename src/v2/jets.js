import { fold } from '../gpu/kernels.js';
import { jetsWGSL, JETS_LAYOUT, JET_STAGES, DynamicParams } from '../shaders/v2/jets.js';

/** R14 jets on column runs (src/shaders/v2/jets.js): launches the cells the pair stages marked. Shares
 * the native 48 B records and the canonical free slots with NativeDynamics; owns no particle pool. */
export class NativeJets {
  constructor(owner) {
    this.owner = owner; this.isReady = false; this.disposed = false;
    const gpu = owner.gpu, dynamics = owner.dynamics;
    const layout = gpu.layout('V2_JETS', JETS_LAYOUT);
    this.group = gpu.bindGroup(layout, [dynamics.particles, dynamics.control].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native liquid jets');
    this.kernels = Object.fromEntries(JET_STAGES.map(stage => [stage, gpu.kernel({
      name: `v2jets_${stage}`, build: 'idle', code: jetsWGSL(owner.g, stage), params: DynamicParams,
      workgroupSize: stage === 'allocate' ? [1, 1, 1] : [64, 1, 1], layouts: [owner.nativeDynamics.layout, layout],
    })]));
    this.ready = Promise.all(Object.values(this.kernels).map(k => k.ready)).then(() => { if (!this.disposed) this.isReady = true; return this; });
    this.ready.catch(() => {});
  }
  /** Once a tick, after the pair stages: count every brick's marks, allocate, spawn a workgroup a brick. */
  advance(tick) {
    if (!this.isReady || this.disposed) throw new Error('NativeJets not ready');
    const o = this.owner, perBrick = fold(Math.ceil(o.g.nbricks / 64)), brickGroups = fold(o.g.nbricks);
    for (const stage of JET_STAGES) {
      const count = stage === 'allocate' ? [1, 1, 1] : stage === 'count' ? perBrick : brickGroups;
      if (stage === 'allocate') o.dynamics._prepareAllocation(tick);
      const k = this.kernels[stage];
      k.dispatch(o.gpu.frame, count, { bind: [o.nativeDynamics.group, this.group], header: o.sim.header(), params: o.dynamics._params(tick) });
      o.sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    }
    o.dynamics._work();
  }
  dispose() { this.disposed = true; this.isReady = false; }
}
