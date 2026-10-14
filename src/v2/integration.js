import { fold } from '../gpu/kernels.js';
import { marksLayout } from '../shaders/common.js';
import { NativeWindowParams, NATIVE_WINDOW_LAYOUT, nativeShiftWGSL, nativeGatherWGSL, nativeScatterWGSL } from '../shaders/v2/window.js';

import { encodeNativeBrick, decodeNativeBrick } from '../world/nativeStore.js';
export { encodeNativeBrick, decodeNativeBrick, NATIVE_BRICK_BYTES } from '../world/nativeStore.js';

// The application owns residency, not dynamics. The dynamics owner must shift
// its particles/air explicitly; a missing hook blocks native worlds, never v1 fallback.
export function nativeCapabilities(sim) {
  const owner = sim?.compactOwner, integration = sim?.nativeIntegration, d = owner?.nativeDynamics;
  const state = !!(owner?.isReady && !owner.disposed && !sim.disposed && owner.aux && integration?.owner === owner && integration.isReady);
  const tools = state && integration.dynamicsReady === true;
  const particles = tools && d?.rays?.ready === true && typeof d.rays.draw === 'function' && typeof d.rays.updateView === 'function';
  return {
    state,
    world: state && owner.capabilities?.contact === true && integration.dynamicsReady === true && (typeof d?.shiftWindow === 'function' || typeof d?.shiftOrigin === 'function'),
    pov: state && owner.capabilities?.contact === true && integration.dynamicsReady === true && typeof d?.applyToolImpulse === 'function',
    physgun: tools && d?.capabilities?.physgun === true && typeof d?.applyPhysgun === 'function',
    impulse: tools && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.impulse === true || d?.supportsToolKind?.('impulse') === true),
    photon: particles && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.photon === true || d?.supportsToolKind?.('photon') === true),
    neutron: particles && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.neutron === true || d?.supportsToolKind?.('neutron') === true),
  };
}

export class NativeIntegration {
  constructor(sim, owner) {
    if (!owner?.aux) throw new Error('native integration requires authoritative auxiliary banks');
    this.sim = sim; this.owner = owner; this.gpu = sim.gpu;
    const gpu = this.gpu;
    const dynamics = owner.nativeDynamics;
    if (dynamics?.ready) Promise.resolve(dynamics.ready).then(() => {
      if (owner.nativeDynamics === dynamics) { this.dynamicsReady = true; sim.wake(); }
    }, () => {});
    this.layout = gpu.layout('NATIVE_WINDOW', NATIVE_WINDOW_LAYOUT);
    this.kernels = Object.fromEntries([['shift', nativeShiftWGSL], ['gather', nativeGatherWGSL], ['scatter', nativeScatterWGSL]].map(([name, code]) =>
      [name, gpu.kernel({ name: `nativeWindow${name}`, code: code(sim.g), layouts: [sim.L.TABLES, gpu.L.EMPTY, this.layout], params: NativeWindowParams })]));
    this.ready = Promise.all(Object.values(this.kernels).map(k => k.ready)).then(() => { this.isReady = true; });
  }
  buffer(label, size) {
    return this.gpu.createBuffer({ label: `native ${label}`, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }
  group(core, bank, other, otherBank) {
    return this.gpu.bindGroup(this.layout, [core, bank, other, otherBank].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native window');
  }
  run(name, count, group, params) {
    if (!this.isReady) throw new Error('native window pipelines are not ready');
    const sim = this.sim;
    sim._dispatch(this.kernels[name], fold(Math.ceil(count / 64)), {
      bind: [sim.tables, this.gpu.emptyGroup, group], header: { ...sim.header(), capture: 0 }, params: { count, ...params },
    });
  }
  // Publish a native mutation without claiming any legacy coordinates. The
  // owner imports external edits BEFORE this call, never the lossy projection.
  changed() {
    const { owner: o, sim, gpu } = this, g = sim.g;
    const ones = new Uint32Array(g.nbricks).fill(1);
    for (const field of ['busy0', 'busy1', 'legacy']) gpu.write(o.act, o.layout[field] * 4, ones);
    o.importFull = o.importMarked = false;
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; sim.changedAll = true;
    o.seenVersion = sim.version; o.seenWhole = sim.wholeWrites;
    o.wake(); sim.wake();
  }
  shift(dx, dz) {
    const { owner: o, sim } = this;
    if (!nativeCapabilities(sim).world) throw new Error('native world dynamics shift is unavailable');
    o.sync();
    this.scratch ??= [this.buffer('shift cores', sim.g.slots * 16), this.buffer('shift banks', sim.g.slots * 4)];
    this.run('shift', sim.g.slots, this.group(o.cells, o.aux, ...this.scratch), { shift: [dx, 0, dz] });
    o.restore(...this.scratch);
    (o.nativeDynamics.shiftWindow ?? o.nativeDynamics.shiftOrigin).call(o.nativeDynamics, [dx, 0, dz]);
  }
  undo(core, bank, dx, dz) {
    const { owner: o, sim, gpu } = this;
    o.sync();
    this.scratch ??= [this.buffer('shift cores', sim.g.slots * 16), this.buffer('shift banks', sim.g.slots * 4)];
    gpu.frame.copy(o.cells, 0, this.scratch[0], 0, sim.g.slots * 16);
    gpu.frame.copy(o.aux, 0, this.scratch[1], 0, sim.g.slots * 4);
    let zero;
    if (!bank) { zero = this.buffer('old undo zero banks', sim.g.slots * 4); bank = zero; }
    this.run('shift', sim.g.slots, this.group(core, bank, ...this.scratch), { shift: [dx, 0, dz], preserve: 1 });
    o.restore(...this.scratch);
    if (zero) sim._retire(zero);
  }
  captureSlab(lo, bricks) {
    const { owner: o, gpu, sim } = this;
    o.sync();
    const n = bricks.reduce((a, b) => a * b, 1), count = n * 64;
    const core = this.buffer('leaving cores', count * 16), bank = this.buffer('leaving banks', count * 4);
    this.run('gather', count, this.group(o.cells, o.aux, core, bank), { lo, bricks });
    // Both copies are recorded before any move, and before the first await.
    const read = Promise.all([gpu.readback.buffer(core, 0, core.size), gpu.readback.buffer(bank, 0, bank.size)]);
    return read.then(([c, b]) => {
      const cores = new Uint32Array(c), banks = new Int32Array(b);
      return Array.from({ length: n }, (_, i) => encodeNativeBrick(cores, banks, i));
    }).finally(() => { sim._retire(core); sim._retire(bank); });
  }
  restoreBrick(lo, bytes) { this.restoreBricks(lo, [1, 1, 1], [{ index: 0, bytes }]); }
  restoreBricks(lo, bricks, entries) {
    if (!entries.length) return;
    const { owner: o, sim, gpu } = this;
    o.sync(); // consume bounded generator writes before overriding retained bricks
    const count = entries.length * 64;
    const cores = new Uint32Array(count * 4), banks = new Int32Array(count + entries.length);
    entries.forEach(({ index, bytes }, i) => {
      const data = decodeNativeBrick(bytes);
      cores.set(data.core, i * 256); banks.set(data.bank, i * 64); banks[count + i] = index;
    });
    const core = this.buffer('returning cores', cores.byteLength), bank = this.buffer('returning banks', banks.byteLength);
    gpu.write(core, 0, cores); gpu.write(bank, 0, banks);
    this.run('scatter', count, this.group(o.cells, o.aux, core, bank), { lo, bricks, preserve: 1 });
    this.changed();
    sim._retire(core); sim._retire(bank);
  }
  // Called after Simulation.shift advanced legacy bookkeeping. The projected
  // legacy shift is not an edit; discard its ownership bits, not native state.
  shifted() {
    const { owner: o, sim, gpu } = this, m = marksLayout(sim.g);
    gpu.frame.clear(sim.marks, m.owned * 4, Math.ceil(sim.g.slots / 32) * 4);
    o.seenWhole = sim.wholeWrites; o.seenVersion = sim.version;
    o.importFull = o.importMarked = false;
    this.changed();
  }
  dispose() { this.isReady = false; for (const b of this.scratch ?? []) this.sim._retire(b); }
}
