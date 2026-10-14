import { ELEMENTS, K } from '../elements.js';
import { nativeTransferWGSL, NATIVE_TRANSFER_LAYOUT } from '../shaders/v2/transfer.js';
import { TransferParams, TRANSFER_SLOTS } from '../shaders/transfer.js';

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
    const group = gpu.bindGroup(this.layout, [o.cells, o.aux, out, buf].map((buffer, binding) => ({ binding, resource: { buffer } })), 'native transfer');
    sim._dispatch(this.kernel, [1, 1, 1], { bind: [sim.tables, gpu.emptyGroup, group], header: { ...sim.header(), capture: 0 },
      params: { ...values, items: values.items?.map(c => c.slice(0, 4)) ?? [], slot: 0 } });
    sim.nativeIntegration.changed();
    return gpu.readback.buffer(out, 0, values.count * 9 * 4).then(bytes => decodeNativeTransfer(bytes, values.count))
      .finally(() => { sim._retire(buf); sim._retire(out); });
  }
}
