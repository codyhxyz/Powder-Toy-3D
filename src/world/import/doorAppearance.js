import { doorPose, transformDoorPoint, transformDoorVector } from './doorMotion.js';
import { APPEARANCE_HEADER as H, APPEARANCE_TRIANGLE_WORDS as TW } from './appearanceFormat.js';

// Cache only a leaf's immutable source records, on its first pose change.
export function createDoorAppearance(map, words, changed = () => {}) {
  const originals = new Map();
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  function ranges(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      const start = sorted[i++]; let end = start + TW;
      while (sorted[i] === end) { end += TW; i++; }
      changed(start, words.subarray(start, end));
    }
  }
  return {
    pose(door, progress) {
      if (!door.motion) return;
      const matrix = doorPose(door.motion, progress), t = matrix.slice(9), touched = [];
      for (const index of door.appearanceTriangleIndices ?? []) {
        const at = words[H.trianglesAt] + index * TW;
        if (!originals.has(at)) originals.set(at, words.slice(at, at + TW));
        const original = originals.get(at), f = new Float32Array(original.buffer);
        words.set(original, at);
        floats.set(transformDoorPoint(matrix, [...f.subarray(0, 3)]), at);
        for (const offset of [4, 8, 12, 16, 20]) {
          const g = transformDoorVector(matrix, [...f.subarray(offset, offset + 3)]);
          floats.set(g, at + offset);
          const dot = g.reduce((n, v, k) => n + v * t[k], 0);
          floats[at + offset + 3] = f[offset + 3] + (offset === 12 ? dot : -dot);
        }
        touched.push(at);
      }
      ranges(touched);
    },
    reset() {
      const touched = [...originals.keys()];
      for (const [at, original] of originals) words.set(original, at);
      originals.clear(); ranges(touched);
    },
  };
}
