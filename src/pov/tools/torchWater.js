import { E } from '../../elements.js';
import { povGpu } from '../gpu.js';

// Like Noita's wet-fire interaction, water quenches the exposed flame, not the item.
// Reuse the hook's tiny cell probe; never read the whole world or block a frame.
export function torchWater(getSim) {
  let states = new WeakMap();
  return {
    wet(torch, at) {
      const sim = getSim();
      let s = states.get(torch);
      if (!s || s.sim !== sim) {
        s = { sim, wet: false, pending: false, next: 0 };
        states.set(torch, s);
      }
      const now = performance.now();
      if (!s.pending && now >= s.next) {
        const cells = [[Math.floor(at.x), Math.floor(at.y), Math.floor(at.z), 0]];
        const read = povGpu(sim).probe('povCells', { cells, count: 1 });
        if (read) {
          s.pending = true;
          s.next = now + 100;
          read.then((bytes) => {
            const id = Math.round(new Float32Array(bytes)[0]);
            s.wet = id === E.WATER || id === E.SALTWATER;
          }).catch(() => {}).finally(() => { s.pending = false; });
        }
      }
      return s.wet;
    },
    reset() { states = new WeakMap(); },
  };
}
