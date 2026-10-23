import { fold } from '../gpu/kernels.js';
import { jetsWGSL, JETS_LAYOUT, JET_STAGES, DynamicParams } from '../shaders/v2/jets.js';
import { COUPLE_ARGS, LIST_ARGS } from '../shaders/v2/blasts.js';

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
      workgroupSize: stage === 'allocate' || stage === 'gate' ? [1, 1, 1] : [64, 1, 1], layouts: [owner.nativeDynamics.layout, layout],
    })]));
    this.ready = Promise.all(Object.values(this.kernels).map(k => k.ready)).then(() => { if (!this.disposed) this.isReady = true; return this; });
    this.ready.catch(() => {});
  }
  /** Once a tick, after the pair stages: count every brick's marks; the gate; then, only when something
   * launches, the pool's preparation and the allocation (indirect, as the couple run's); spawn a
   * workgroup a brick of count's list of flagged bricks (publishCouple publishes it). */
  advance(tick) {
    if (!this.isReady || this.disposed) throw new Error('NativeJets not ready');
    const o = this.owner, d = o.dynamics, perBrick = fold(Math.ceil(o.g.nbricks / 64));
    const gated = { indirect: d.dispatchArgs, offset: COUPLE_ARGS }, listed = { indirect: d.dispatchArgs, offset: LIST_ARGS.jetCells };
    for (const stage of JET_STAGES) {
      const count = stage === 'gate' ? [1, 1, 1] : stage === 'allocate' ? gated : stage === 'count' ? perBrick : listed;
      if (stage === 'allocate') {
        d._record('lists', 'publishCouple', 1, tick); // the gate's words into the args: no copy
        d._prepareAllocation(tick, {}, gated);
      }
      const k = this.kernels[stage];
      k.dispatch(o.gpu.frame, count, { bind: [o.nativeDynamics.group, this.group], header: o.sim.header(), params: d._params(tick) });
      o.sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    }
    // (no d._work(): jets start from awake cells, which keep the box awake themselves: dynamics.js advanceParticles)
  }
  dispose() { this.disposed = true; this.isReady = false; }
}
