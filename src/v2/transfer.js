import { ELEMENTS, K } from '../elements.js';
import { nativeTransferWGSL, NATIVE_TRANSFER_LAYOUT } from '../shaders/v2/transfer.js';
import { TransferParams, TRANSFER_SLOTS, TRANSFER_PUT } from '../shaders/transfer.js';
import { NATIVE_LAUNCH_MODE } from './nativeForcing.js';

// Carried cells keep their four legacy display fields followed by five raw
// native words. JSON arrays preserve uint32s exactly (including bank bits).
export function nativeCargo(cell) {
  return Array.isArray(cell) && cell.length === 9 && cell.slice(4).every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
    && (cell[4] & 255) === cell[0] && cell[0] > 0 && !!ELEMENTS[cell[0]]
    && (ELEMENTS[cell[0]].kind !== K.LIQUID || (cell[5] & 0xffffff) > 0);
}
export function decodeNativeTransfer(bytes, count) {
  const raw = new Uint32Array(bytes), floats = new Float32Array(bytes);
  const out = new Float32Array(count * 4);
  out.native = new Uint32Array(count * 5);
  for (let i = 0; i < count; i++) {
    out.set(floats.subarray(i * 9, i * 9 + 4), i * 4);
    out.native.set(raw.subarray(i * 9 + 4, i * 9 + 9), i * 5);
  }
  return out;
}
export class NativeTransfer {
  constructor(sim) {
    this.sim = sim; const gpu = sim.gpu;
    this.layout = gpu.layout('NATIVE_TRANSFER', NATIVE_TRANSFER_LAYOUT);
    this.kernel = gpu.kernel({ name: 'nativeTransfer', code: nativeTransferWGSL(sim.g), params: TransferParams,
      layouts: [sim.L.TABLES, gpu.L.EMPTY, this.layout], workgroupSize: [256, 1, 1] });
  }
  run(values) {
    const sim = this.sim, o = sim.compact, gpu = sim.gpu;
    if (sim.nativeTransition || sim.nativeTransitionError || !o || !sim.nativeIntegration?.isReady || this.kernel.state !== 'ready') return null;
    o.sync();
    const upload = new Uint32Array(TRANSFER_SLOTS * 8);
    (values.items ?? []).forEach((cell, i) => {
      if (cell.length > 4 && !nativeCargo(cell)) throw new Error('Malformed native cargo');
      if (nativeCargo(cell)) { upload.set(cell.slice(4, 8), i * 8); upload[i * 8 + 4] = cell[8]; upload[i * 8 + 5] = 1; }
    });
    const buf = sim.nativeIntegration.buffer('transfer items', upload.byteLength);
    const out = sim.nativeIntegration.buffer('transfer result', TRANSFER_SLOTS * 9 * 4);
    gpu.write(buf, 0, upload);
    // A throw (a put with V1's vel, cells/step: the shovel, bucket, flask, hook, gibs, a wand's
    // place) launches what lands as V2 particles carrying the whole cell, as Factory machines do
    // (v2/industry.js): the plans start clear, the kernel plans each placed cell, then one
    // allocation at absolute velocity (blasts.js apply, mode NATIVE_LAUNCH_MODE). A take keeps a
    // pending launch (its kernel clears its own cells' plans) for the caller to flush after it.
    const d = o.dynamics, throws = values.mode === TRANSFER_PUT && !!d?.plans && (values.vel ?? []).some(v => v !== 0);
    const plans = d?.plans ?? (this.noPlans ??= gpu.createBuffer({ label: 'native transfer no plans', size: TRANSFER_SLOTS * 16, usage: GPUBufferUsage.STORAGE }));
    if (throws) { d.flushLaunch?.(); gpu.frame.clear(plans); }
    const group = gpu.bindGroup(this.layout, [o.cells, o.aux, out, buf, plans].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native transfer');
    sim._dispatch(this.kernel, [1, 1, 1], { bind: [sim.tables, gpu.emptyGroup, group], header: { ...sim.header(), capture: 0 },
      params: { ...values, items: values.items?.map(c => c.slice(0, 4)) ?? [], slot: 0 } });
    if (throws) { d._allocate(o.tick + 1, { mode: NATIVE_LAUNCH_MODE }); d._externalWork?.(); }
    sim.nativeIntegration.changed();
    // World's source: the slots' cells (each acting slot writes its own: shaders/transfer.js), in world cells.
    // Its kernel writes them behind the tick's change notes (v2/physics.js _reportChanges), so it says so here.
    const cells = (values.cells ?? []).slice(0, values.count ?? 0).map(c => [0, 1, 2].map(k => Math.floor(c[k] + 0.5)));
    if (cells.length) {
      const at = [sim.origin.x, sim.origin.y, sim.origin.z];
      sim.worldRenderSource?.noteContentChange({ lo: [0, 1, 2].map(k => Math.min(...cells.map(c => c[k])) + at[k]),
        hi: [0, 1, 2].map(k => Math.max(...cells.map(c => c[k])) + 1 + at[k]) });
    }
    return gpu.readback.buffer(out, 0, values.count * 9 * 4).then(bytes => decodeNativeTransfer(bytes, values.count))
      .finally(() => { sim._retire(buf); sim._retire(out); });
  }
}
