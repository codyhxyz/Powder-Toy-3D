import { BRICK } from '../shaders/common.js';
import { BrickStore } from './store.js';

// Compressed changed bricks only. Global up-Y = band-local Y - band bottom.
// Replacing a COMPLETE band snapshot also deletes absent (baseline) bricks;
// merging changed entries alone would resurrect old damage in overlaps.
export class TerrainEditCache {
  constructor() { this.reset(); }
  reset() { this.map = new Map(); }

  band(region, cellScale = 1) {
    const offset = (region.sourceTop + region.sourceHeight) * cellScale / BRICK;
    const height = region.sourceHeight * cellScale / BRICK;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(height) || height <= 0) throw new Error('Terrain bands must align with edit bricks');
    return { offset, height };
  }

  capture(region, store, cellScale = 1) {
    const { offset, height } = this.band(region, cellScale), [nx, ny] = store.bricks;
    if (ny !== height) throw new Error('Terrain snapshot has the wrong height');
    const next = new Map();
    for (const [key, bytes] of this.map) {
      const y = Number(key.split(',')[1]);
      if (y < -offset || y >= height-offset) next.set(key,bytes);
    }
    for (const [key, bytes] of store.map) {
      const x=key%nx, y=Math.floor(key/nx)%ny, z=Math.floor(key/(nx*ny));
      next.set(`${x},${y-offset},${z}`,bytes.slice());
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
}
