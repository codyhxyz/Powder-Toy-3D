import { BRICK } from '../shaders/common.js';
import { BrickStore } from './store.js';
import { NativeBrickStore } from './nativeStore.js';

// Compressed changed bricks only. Global up-Y = band-local Y - band bottom.
// Replacing a COMPLETE band snapshot also deletes absent (baseline) bricks;
// merging changed entries alone would resurrect old damage in overlaps.
//
// Physics V2 owns exact cells the legacy projection can't carry (liquid fill,
// fall state, flux, energy banks), so a native window also hands over its
// native store (world/nativeStore.js): every brick it holds, exact. Those go
// in `native`, keyed by global brick (x, global y, z) as one number, with the
// same band replacement. A legacy-only snapshot of a band clears that band's
// native bricks, so an older exact brick never overrides newer damage.
const NATIVE_Y_BIAS = 1 << 16;   // global brick y offset that keeps native keys non-negative
export class TerrainEditCache {
  constructor() { this.reset(); }
  reset() { this.map = new Map(); this.native = new Map(); this.nativeDims = null; }

  band(region, cellScale = 1) {
    const offset = (region.sourceTop + region.sourceHeight) * cellScale / BRICK;
    const height = region.sourceHeight * cellScale / BRICK;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(height) || height <= 0) throw new Error('Terrain bands must align with edit bricks');
    return { offset, height };
  }

  nativeKey(x, globalY, z) {
    const [nx, nz] = this.nativeDims;
    return ((globalY + NATIVE_Y_BIAS) * nz + z) * nx + x;
  }
  nativeBrick(key) {
    const [nx, nz] = this.nativeDims;
    return [key % nx, Math.floor(key / (nx * nz)) - NATIVE_Y_BIAS, Math.floor(key / nx) % nz];
  }
  _nativeDims(bricks) {
    const dims = [bricks[0], bricks[2]];
    if (!this.nativeDims) this.nativeDims = dims;
    else if (dims.some((n, i) => n !== this.nativeDims[i])) throw new Error('Terrain bands must share the world footprint');
  }

  // native: the window's NativeBrickStore when Physics V2 owned it, else null
  capture(region, store, cellScale = 1, native = null) {
    const { offset, height } = this.band(region, cellScale), [nx, ny] = store.bricks;
    if (ny !== height) throw new Error('Terrain snapshot has the wrong height');
    if (native && native.bricks.some((n, i) => n !== store.bricks[i])) throw new Error('Terrain native snapshot has the wrong size');
    const next = new Map();
    for (const [key, bytes] of this.map) {
      const y = Number(key.split(',')[1]);
      if (y < -offset || y >= height-offset) next.set(key,bytes);
    }
    for (const [key, bytes] of store.map) {
      const x=key%nx, y=Math.floor(key/nx)%ny, z=Math.floor(key/(nx*ny));
      next.set(`${x},${y-offset},${z}`,bytes.slice());
    }
    if (this.native.size || native) {
      this._nativeDims(store.bricks);
      const nextNative = new Map();
      for (const [key, bytes] of this.native) {
        const y = this.nativeBrick(key)[1];
        if (y < -offset || y >= height-offset) nextNative.set(key, bytes);
      }
      // (native bytes are immutable once stored: shared, not copied)
      for (const [key, bytes] of native?.map ?? []) {
        const x=key%nx, y=Math.floor(key/nx)%ny, z=Math.floor(key/(nx*ny));
        nextNative.set(this.nativeKey(x, y-offset, z), bytes);
      }
      this.native = nextNative;
    }
    this.map = next;
  }

  seed(region, bricks, cellScale = 1) {
    const { offset, height } = this.band(region, cellScale), store = new BrickStore(bricks);
    if (bricks[1] !== height) throw new Error('Terrain destination has the wrong height');
    for (const [key,bytes] of this.map) {
      const [x,globalY,z]=key.split(',').map(Number), y=globalY+offset;
      if (y>=0 && y<height) store.put(store.key(x,y,z),bytes.slice());
    }
    return store;
  }

  // The band's exact native bricks, for a window Physics V2 owns.
  seedNative(region, bricks, cellScale = 1) {
    const { offset, height } = this.band(region, cellScale), store = new NativeBrickStore(bricks);
    if (bricks[1] !== height) throw new Error('Terrain destination has the wrong height');
    if (!this.native.size) return store;
    this._nativeDims(bricks);
    for (const [key, bytes] of this.native) {
      const [x, globalY, z] = this.nativeBrick(key), y = globalY + offset;
      if (y >= 0 && y < height) store.put(store.key(x, y, z), bytes);
    }
    return store;
  }
}
