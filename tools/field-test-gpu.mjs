// CPU fake command encoder. No browser/device/server imports.
import { dirtyLists, AGE, DIRTY } from '../src/shaders/fields.js';
import { slotCell, cellSlot, gridDims, Header } from '../src/shaders/common.js';
import { emaWords, jetAt, unpack2 } from './field-reference.mjs';

export class FieldTestGPU {
  constructor({ emulateEMA = false } = {}) {
    globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
    globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 };
    Object.assign(this, { emulateEMA, L: {}, trace: [], resources: [], kernels: [], testMode: true });
    this.L.EMPTY = this.layout('EMPTY', []);
    this.emptyGroup = this.bindGroup(this.L.EMPTY, [], 'empty');
    this.frame = { copy: (src, so, dst, to, size) => {
      if (src.destroyed || dst.destroyed) throw new Error('Copy of retired resource');
      new Uint8Array(dst.bytes, to, size).set(new Uint8Array(src.bytes, so, size));
      this.trace.push({ name: 'copy', src, dst, so, to, size });
    }, clear: (buffer, offset = 0, size = buffer.size - offset) => new Uint8Array(buffer.bytes, offset, size).fill(0) };
  }
  createBuffer(desc) {
    const r = { ...desc, bytes: new ArrayBuffer(desc.size), getMappedRange() { return this.bytes; }, unmap() {}, destroy() { this.destroyed = true; } };
    this.resources.push(r); return r;
  }
  createTexture(desc) {
    const r = { ...desc, createView() { return { texture: this }; }, destroy() { this.destroyed = true; } };
    this.resources.push(r); return r;
  }
  layout(name, entries) { return this.L[name] ??= { name, entries }; }
  bindGroup(layout, entries, name) { return { layout, entries, name }; }
  kernel(desc) {
    const k = { ...desc, state: 'ready', ready: Promise.resolve(), dispatch: (frame, size, opts = {}) => {
      desc.params?.pack(opts.params);
      Header.write(new DataView(new ArrayBuffer(Header.size)), 0, opts.header ?? {});
      this.trace.push({ name: desc.name, size, opts, kernel: k });
      this.onDispatch?.(k, opts);
      if (this.emulateEMA && desc.name === 'fieldEma') this._ema(desc, opts);
    } };
    this.kernels.push(k); return k;
  }
  _ema(desc, { bind, params: p, header }) {
    const match = desc.code.match(/const NX: i32 = (\d+)/);
    const ny = desc.code.match(/const NY: i32 = (\d+)/), nz = desc.code.match(/const NZ: i32 = (\d+)/);
    const g = gridDims({ nx: +match[1], ny: +ny[1], nz: +nz[1] }), d = dirtyLists(g);
    const buf = (group, binding) => group.entries.find((e) => e.binding === binding).resource.buffer;
    const list = new Uint32Array(buf(bind[2], 0).bytes), age = new Uint32Array(buf(bind[2], 1).bytes), ema = new Uint32Array(buf(bind[2], 2).bytes);
    const A = new Float32Array(buf(bind[1], 0).bytes), aer = new Uint32Array(buf(bind[2], 3).bytes);
    const inside = (c) => c.every((v, i) => p.worldMin ? v + p.scratchOrigin[i] >= p.worldMin[i] && v + p.scratchOrigin[i] < p.worldMax[i] : v >= 0 && v < [g.nx, g.ny, g.nz][i]);
    const aerAt = (c) => {
      if (!inside(c)) return [0, 0, 0, 0];
      const s = cellSlot(g, ...c) + (p.aer - 1) * g.slots;
      return [...unpack2(aer[s * 2]), ...unpack2(aer[s * 2 + 1])];
    };
    const owners = [];
    for (let e = 0; e < list[d.last + DIRTY.EMA]; e++) {
      const b = list[DIRTY.EMA * g.nbricks + e]; owners.push(slotCell(g, b * 64).map((v, i) => Math.floor((v + (p.scratchOrigin?.[i] ?? 0)) / 4)).join(','));
      for (let li = 0; li < 64; li++) {
        const s = b * 64 + li, c = slotCell(g, s);
        if (!inside(c) || (p.lo && c.some((v, i) => v < p.lo[i] || v >= p.hi[i]))) continue;
        const rawSlot = ((header?.src ?? 0) * g.slots + s) * 4;
        const previous = p.reset || (age[b] & AGE.FRESH) ? null : [ema[s], ema[g.slots + s], ema[2 * g.slots + s]];
        const words = emaWords(Array.from(A.subarray(rawSlot, rawSlot + 4)), jetAt(c, aerAt, p.aer !== 0), previous);
        for (let plane = 0; plane < 3; plane++) ema[plane * g.slots + s] = words[plane];
      }
    }
    this.trace.push({ name: 'emaOwners', owners });
  }
  flush() {}
}
