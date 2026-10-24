// Which elements a simulation's grid holds, for the scanned textures
// (gfx/materialTextures.js): a map downloads only the photos of what is in it,
// and an element that turns up later (the spawn menu, a reaction, the window
// moving onto new ground) gets its photo once a census sees it.
//
// A census is one small kernel (shaders/materialCensus.js) over a sparse
// lattice of the grid, its answer a bit per element read back through a result
// ring a few frames later (B7); nothing waits for it. The first sweep reads
// every phase of the lattice in one go, so a map's own materials are asked
// for as soon as the view is drawn; after that one phase runs every
// CENSUS_PERIOD_MS, so the whole grid is read again every
// CENSUS_PHASES × CENSUS_PERIOD_MS (8 s) at an eighth of a grid's reads a
// second.
//
//   const census = materialCensus(gpu, sim, (ids) => …);   // ids: element ids seen for the first time
//   census.tick(now);   // from the view's draw (gfx/volume.js), while it draws scanned looks
//   census.dispose();
import { censusFrag, CensusParams, CENSUS_STRIDE, CENSUS_PHASES, CENSUS_WG, CENSUS_BITS, CENSUS_WORDS, CENSUS_BYTES, censusDispatch } from '../shaders/materialCensus.js';
import { RING_LAYOUT } from '../shaders/povBody.js';

const CENSUS_PERIOD_MS = 1000;
// Ring slots: one census per period, read back within a few frames; the first
// sweep takes CENSUS_PHASES at once.
const CENSUS_RING_SLOTS = 2 * CENSUS_PHASES;

const phaseOf = (k) => [k % CENSUS_STRIDE, Math.floor(k / CENSUS_STRIDE) % CENSUS_STRIDE, Math.floor(k / (CENSUS_STRIDE * CENSUS_STRIDE)) % CENSUS_STRIDE, 0];

/**
 * @param {object} gpu
 * @param {object} sim a Simulation (its grid, layouts and state)
 * @param {(ids: number[]) => void} onSeen called with the element ids seen for the first time
 */
export function materialCensus(gpu, sim, onSeen) {
  const L = sim.L;
  const ringLayout = gpu.layout('census ring', RING_LAYOUT);
  const kernel = gpu.kernel({
    name: 'materialCensus', code: censusFrag(sim.g), layouts: [L.TABLES, L.STATE_RO, ringLayout],
    params: CensusParams, workgroupSize: [CENSUS_WG, CENSUS_WG, CENSUS_WG], build: 'idle',
  });
  const ring = gpu.readback.ring(`sim${sim.id} census`, CENSUS_BYTES, CENSUS_RING_SLOTS);
  const group = gpu.bindGroup(ringLayout, [{ binding: 0, resource: { buffer: ring.buffer } }], `sim${sim.id} census`);
  const known = new Uint32Array(CENSUS_WORDS);
  const size = censusDispatch(sim.g);
  let next = 0;          // the next phase
  let last = -Infinity;  // when the last census was recorded
  let swept = false;     // the first full sweep is recorded
  let disposed = false;

  function take(bytes) {
    if (disposed) return;
    const words = new Uint32Array(bytes);
    const ids = [];
    for (let w = 0; w < CENSUS_WORDS; w++) {
      const fresh = words[w] & ~known[w];
      if (!fresh) continue;
      known[w] |= fresh;
      for (let b = 0; b < CENSUS_BITS; b++) if (fresh & (1 << b)) ids.push(w * CENSUS_BITS + b);
    }
    if (ids.length) onSeen(ids);
  }

  function record(phase) {
    const read = sim.compact ? sim.bindPhysicalRO : sim.bindRO;
    if (!read) return false;
    const slot = ring.next();
    kernel.dispatch(gpu.frame, size, { bind: [sim.tables, read, group], header: sim.readHeader({ physical: true }), params: { phase: phaseOf(phase), slot } });
    ring.read(slot).then(take, () => {});
    return true;
  }

  return {
    /** Records a census into the open frame if one is due (the first call sweeps every phase). */
    tick(now = performance.now()) {
      if (disposed || kernel.state !== 'ready' || now - last < CENSUS_PERIOD_MS) return;
      last = now;
      if (!swept) {
        for (let k = 0; k < CENSUS_PHASES; k++) if (!record(k)) return;
        swept = true;
        return;
      }
      if (record(next)) next = (next + 1) % CENSUS_PHASES;
    },
    dispose() {
      disposed = true;
      ring.close();
    },
  };
}
