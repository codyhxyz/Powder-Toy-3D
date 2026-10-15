import { cellSlot } from '../shaders/common.js';

export const HISTORY_BRICK = 4;
export const HISTORY_WORDS = 3 * 64;
export const brickKey = (p) => p.join(',');

// Sparse world-identity ownership. No physics-origin/atlas residency clock.
// Native copies preserve the three packed planes, including their slot order.
export class WorldFieldHistory {
  constructor(gpu, { pagesPerSlab = 512 } = {}) {
    if (!Number.isInteger(pagesPerSlab) || pagesPerSlab < 1 || pagesPerSlab * HISTORY_WORDS * 4 > 128 * 1024 ** 2) {
      throw new Error('Invalid field history slab size');
    }
    Object.assign(this, { gpu, pagesPerSlab });
    this.epoch = 0;
    this.owners = new Map();
    this.slabs = [];
    this.free = [];
    this.quarantined = new Set();
  }
  quarantine(pages, epoch = this.epoch) {
    for (const page of pages) this.quarantined.add(page);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const page of pages) {
        this.quarantined.delete(page);
        if (epoch === this.epoch) this.free.push(page);
      }
    };
  }
  allocate() {
    if (!this.free.length) {
      const buffer = this.gpu.createBuffer({ label: `world EMA epoch ${this.epoch}`, size: this.pagesPerSlab * HISTORY_WORDS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.slabs.push(buffer);
      for (let page = this.pagesPerSlab - 1; page >= 0; page--) this.free.push({ buffer, offset: page * HISTORY_WORDS * 4 });
    }
    return this.free.pop();
  }
  copy(frame, scratch, origin, owner, page, scatter = false) {
    const p = owner.map((b, i) => b * 4 - origin[i]);
    const slot = cellSlot(scratch.g, ...p);
    for (let plane = 0; plane < 3; plane++) {
      const localOffset = (plane * scratch.g.slots + slot) * 4, poolOffset = page.offset + plane * 64 * 4;
      if (scatter) frame.copy(scratch.ema, localOffset, page.buffer, poolOffset, 64 * 4);
      else frame.copy(page.buffer, poolOffset, scratch.ema, localOffset, 64 * 4);
    }
  }
  // Old encoded commands must never target current-epoch pages. Keep old slabs
  // alive until dispose (caller retires this adapter after queue completion).
  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) throw new Error('World field epoch must increase');
    this.epoch = epoch;
    this.owners.clear();
    this.free = [];
  }
  dispose() { for (const buffer of this.slabs) buffer.destroy(); this.slabs = []; this.free = []; this.quarantined.clear(); this.owners.clear(); }
}
