// Cache ownership, limits and checks: docs/world-lod.md.
//
// Render-only chunks: GPU scene cells and persisted edits meshed once in a
// worker (world/detail-worker.js), not simulated, replacing the coarse far
// field's geometry near the window. Not drawn on WebGPU yet (docs/webgpu.md
// G1, U10's hand-back): their meshes need a pipeline of ours in the scene pass
// (the far view's material over a vertex stage) and the depth they cut the
// far view's march at. Until then WorldDetail is this stand-in: the far view
// (world/far.js) marches the coarse field everywhere, and the window's hooks
// into it (reset, invalidate, stale) do nothing.
export const DETAIL_CHUNK = 32;

export class WorldDetail {
  constructor(far) {
    this.far = far;
    this.win = far.win;
    this.nx = Math.ceil(far.win.size[0] / DETAIL_CHUNK);
    this.nz = Math.ceil(far.win.size[2] / DETAIL_CHUNK);
    this.mask = new Uint8Array(this.nx * this.nz);   // (no chunk is ever detailed)
    this.entries = new Map();
    this.epoch = 0;
    this.bytes = 0;
    this.pending = null;
  }

  reset() { this.epoch++; }
  drop() {}
  invalidate() {}
  stale() {}
  view() {}
  tick() {}
  valid() { return false; }
  accept() {}
  full() { return false; }
  dispose() { this.epoch++; }
}
