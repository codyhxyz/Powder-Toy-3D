import { fold } from '../gpu/kernels.js';
import { marksLayout } from '../shaders/common.js';
import { NativeWindowParams, NATIVE_WINDOW_LAYOUT, nativeShiftWGSL, nativeGatherWGSL, nativeScatterWGSL, nativeActShiftWGSL, nativeMovedRuns } from '../shaders/v2/window.js';

import { encodeNativeBrick, decodeNativeBrick } from '../world/nativeStore.js';
export { encodeNativeBrick, decodeNativeBrick, NATIVE_BRICK_BYTES } from '../world/nativeStore.js';

// The application owns residency, not dynamics. The dynamics owner must shift
// its particles/air explicitly; a missing hook blocks native worlds, never v1 fallback.
export function nativeCapabilities(sim) {
  const owner = sim?.compactOwner, integration = sim?.nativeIntegration, d = owner?.dynamics;
  const state = !!(owner?.isReady && !owner.disposed && !sim.disposed && owner.aux && integration?.owner === owner && integration.isReady);
  const tools = state && d?.capabilities?.physicsReady === true && d.isReady === true;
  // Photons and neutrons are physics: they fly, heat and split whether or not
  // their sprites have built yet (gfx/nativeParticles.js draws them once ready).
  const particles = tools;
  return {
    state,
    // The window follows on the buffers and the move's own kernel (built with the grid), so it moves while
    // the rest of the dynamics still build and the grid steps (src/v2/dynamics.js windowReady); nothing
    // held for their build may be waiting, since those requests are in window cells (sim.nativePending).
    world: state && owner.contactReady === true && d?.windowReady === true && !d.disposed && !sim.nativePending?.length && typeof d?.recordWindowShift === 'function',
    pov: state && owner.contactReady === true && tools && typeof d?.applyToolImpulse === 'function',
    physgun: tools && d?.capabilities?.physgun === true && typeof d?.applyPhysgun === 'function',
    impulse: tools && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.impulse === true || d?.supportsToolKind?.('impulse') === true),
    photon: particles && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.photon === true || d?.supportsToolKind?.('photon') === true),
    neutron: particles && typeof d?.applyToolImpulse === 'function' && (d?.capabilities?.neutron === true || d?.supportsToolKind?.('neutron') === true),
    // the writers sim.deferNative holds while the dynamics build: an external blast, a force kernel's launch
    externalBlast: tools && typeof d?.applyExternalBlast === 'function',
    force: tools,
  };
}

export class NativeIntegration {
  constructor(sim, owner) {
    if (!owner?.aux) throw new Error('native integration requires authoritative auxiliary banks');
    this.sim = sim; this.owner = owner; this.gpu = sim.gpu;
    const gpu = this.gpu;
    const dynamics = owner.dynamics;
    if (dynamics?.ready) Promise.resolve(dynamics.ready).then(() => {
      if (owner.dynamics === dynamics) { this.dynamicsReady = true; sim.wake(); }
    }, () => {});
    this.layout = gpu.layout('NATIVE_WINDOW', NATIVE_WINDOW_LAYOUT);
    this.kernels = Object.fromEntries([['shift', nativeShiftWGSL], ['gather', nativeGatherWGSL], ['scatter', nativeScatterWGSL], ['actShift', nativeActShiftWGSL]].map(([name, code]) =>
      [name, gpu.kernel({ name: `nativeWindow${name}`, code: code(sim.g), layouts: [sim.L.TABLES, gpu.L.EMPTY, this.layout], params: NativeWindowParams })]));
    this.ready = Promise.all(Object.values(this.kernels).map(k => k.ready)).then(() => { this.isReady = true; });
  }
  buffer(label, size) {
    return this.gpu.createBuffer({ label: `native ${label}`, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }
  group(core, bank, other, otherBank) {
    return this.gpu.bindGroup(this.layout, [core, bank, other, otherBank, this.owner.act].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native window');
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
  // all: every brick's activity and legacy word is noted (a writer that does not note its own bricks);
  // otherwise the writer noted them (the scatter, a restore's copy). derived: the derived passes re-age
  // every brick (a shift's are moved by whole bricks instead: src/sim.js shift).
  changed({ all = true, derived = true } = {}) {
    const { owner: o, sim, gpu } = this, g = sim.g;
    if (all) {
      const ones = new Uint32Array(g.nbricks).fill(1);
      for (const field of ['busy0', 'busy1', 'legacy']) gpu.write(o.act, o.layout[field] * 4, ones);
      o.noteAllCells?.(); // the scatter wrote cores behind noteState
    }
    o.importFull = o.importMarked = false;
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; if (derived) sim.changedAll = true;
    o.seenVersion = sim.version; o.seenWhole = sim.wholeWrites;
    o.wake(); sim.wake();
  }
  // A World window move, recorded into the frame as V1's is (src/sim.js shift), never awaited: no tick,
  // tool or stroke waits on it. The cores and banks move out of place; the dynamics' requests, air and
  // shocks and the bricks' legacy words move with them (NativeDynamics.recordWindowShift), so only the
  // bricks the move uncovers are converted again; their activity and air cache too (moveActivity), so
  // only those and the face the move bares wake, and only they are reported to World's renderer: a move
  // costs its slab, not the window. Returns the leaving slab's landing (the window holds its next move
  // until it has: world/window.js).
  shift(dx, dz) {
    const { owner: o, sim } = this, shift = [dx, 0, dz];
    if (!nativeCapabilities(sim).world) throw new Error('native world dynamics shift is unavailable');
    o.sync();
    this.scratch ??= [this.buffer('shift cores', sim.g.slots * 16), this.buffer('shift banks', sim.g.slots * 4)];
    this.run('shift', sim.g.slots, this.group(o.cells, o.aux, ...this.scratch), { shift });
    const moved = o.dynamics.recordWindowShift(shift, { legacy: true, activity: true });
    o.restore(...this.scratch, { moved: true });
    this.moveActivity(shift);
    moved.commit();
    return (this.landing = moved.landed);
  }
  // The move's activity and the air source's cache, after the restore (which copied the cores' scratch
  // back, so it holds them now: nativeMovedRuns' runs) and before the dynamics' commit (the legacy words):
  // each brick that stays takes its own words where it lands, the rest of the activity starts over as a
  // restore's does (shaders/v2/window.js nativeActShiftWGSL). It used to start over whole: every brick
  // busy, its cells and air noted, so each move woke the whole grid for an offset cycle and its air
  // reported every brick changed, a relight of the whole window (2026-10-23 perf audit).
  moveActivity(shift) {
    const { owner: o, sim, gpu } = this, f = gpu.frame, nb = sim.g.nbricks, faces = o.dynamics.faces;
    const runs = (this.movedRuns ??= nativeMovedRuns(sim.g)), [moved, spare] = this.scratch;
    if (runs.words * 4 > moved.size) throw new Error('native window move: the moved activity outgrows its scratch');
    for (const r of runs.act) f.copy(o.act, r.offset * 4, moved, r.at * 4, r.words * nb * 4);
    for (const r of runs.faces) f.copy(faces, r.offset * 4, moved, r.at * 4, r.words * nb * 4);
    f.clear(o.act);
    // (bindings 1 and 3 unread: any buffer of their own, no writable alias)
    this.run('actShift', nb, this.group(faces, spare, moved, o.aux), { shift });
  }
  // An undo entry across a move (src/sim.js undo, V1's undoShift): the shared cells take the entry's
  // words, the rest keep theirs; with the entry's dynamics (NativeDynamics.captureUndo), its requests,
  // air and flying matter over them too.
  undo(core, bank, dx, dz, dynamic = null) {
    const { owner: o, sim, gpu } = this;
    o.sync();
    this.scratch ??= [this.buffer('shift cores', sim.g.slots * 16), this.buffer('shift banks', sim.g.slots * 4)];
    gpu.frame.copy(o.cells, 0, this.scratch[0], 0, sim.g.slots * 16);
    gpu.frame.copy(o.aux, 0, this.scratch[1], 0, sim.g.slots * 4);
    let zero;
    if (!bank) { zero = this.buffer('old undo zero banks', sim.g.slots * 4); bank = zero; }
    this.run('shift', sim.g.slots, this.group(core, bank, ...this.scratch), { shift: [dx, 0, dz], preserve: 1 });
    const merge = dynamic && o.dynamics?.windowReady ? o.dynamics.recordUndoMerge(dynamic, [dx, 0, dz]) : null;
    o.restore(...this.scratch);
    merge?.commit();
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
  // The leaving slab's exact cells raw (cores, banks: brick i's 64 cells at i·64), unencoded: the physics
  // region codes only the bricks it keeps, a slice at a time outside the frame (world/window.js readBack).
  captureSlabRaw(lo, bricks) {
    const { owner: o, gpu, sim } = this;
    o.sync();
    const n = bricks.reduce((a, b) => a * b, 1), count = n * 64;
    const core = this.buffer('leaving cores', count * 16), bank = this.buffer('leaving banks', count * 4);
    this.run('gather', count, this.group(o.cells, o.aux, core, bank), { lo, bricks });
    const read = Promise.all([gpu.readback.buffer(core, 0, core.size), gpu.readback.buffer(bank, 0, bank.size)]);
    return read.then(([c, b]) => ({ n, cores: new Uint32Array(c), banks: new Int32Array(b) }))
      .finally(() => { sim._retire(core); sim._retire(bank); });
  }
  restoreBrick(lo, bytes) { this.restoreBricks(lo, [1, 1, 1], [{ index: 0, bytes }]); }
  // derived: false on a physics-only move (world/physicsRegion.js): the derived passes don't re-age.
  restoreBricks(lo, bricks, entries, { derived = true } = {}) {
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
    this.changed({ all: false, derived }); // (the scatter noted the bricks it wrote: shaders/v2/window.js)
    sim._retire(core); sim._retire(bank);
  }
  // Called after Simulation.shift advanced legacy bookkeeping. The projected
  // legacy shift is not an edit; discard its ownership bits, not native state.
  // The move noted its bricks (shift: moveActivity notes the uncovered ones and the bared face, the
  // legacy words moved with them).
  shifted() {
    const { sim, gpu } = this, m = marksLayout(sim.g);
    gpu.frame.clear(sim.marks, m.owned * 4, Math.ceil(sim.g.slots / 32) * 4);
    this.changed({ all: false, derived: false });
  }
  dispose() { this.isReady = false; for (const b of this.scratch ?? []) this.sim._retire(b); }
}
