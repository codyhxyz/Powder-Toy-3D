// Whether the view needs its film code (shaders/gfx/film.js: thin water on a
// floor). That code costs every pixel registers whether a film is on screen or
// not (about 4 % of a frame with none in the grid, 2026-10-24), so the view
// compiles without it (gfx/volume.js) until a scan of the brick map
// (shaders/filmScan.js) sees a film brick, and goes back once none has been
// seen for FILM_HOLD_MS. A scan runs every FILM_SCAN_MS, its answer read back
// a few frames later (B7); nothing waits for it.
//
//   const films = filmScan(gpu, sim, derived, onChange);   // onChange(): `wanted` moved
//   films.tick(now);   // from the frame's compute hook
//   films.wanted       // true while the grid holds a film (or held one within FILM_HOLD_MS)
//   films.dispose();
import { filmScanWGSL, FilmScanParams, FILM_SCAN_LAYOUT, filmScanDispatch } from '../shaders/filmScan.js';

export const FILM_SCAN_MS = 250;      // between scans: a film shows within about this (plus the variant's first build)
export const FILM_HOLD_MS = 10000;    // the film code stays this long after the last film went (no rebuild churn as a puddle dries)
const RING_SLOTS = 8;                 // scans in flight (a few frames' readback latency at most)
const WORD_BYTES = 4;

/**
 * @param {object} gpu
 * @param {object} sim a Simulation (its tables and layouts)
 * @param {object} derived its derived passes (src/derived.js: the brick map)
 * @param {() => void} onChange called when `wanted` changes
 */
export function filmScan(gpu, sim, derived, onChange = () => {}) {
  const layout = gpu.layout('film scan', FILM_SCAN_LAYOUT);
  const kernel = gpu.kernel({
    name: 'filmScan', code: filmScanWGSL(sim.g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout],
    params: FilmScanParams, workgroupSize: [64, 1, 1], build: 'now',
  });
  const ring = gpu.readback.ring(`sim${sim.id} film scan`, WORD_BYTES, RING_SLOTS);
  const size = filmScanDispatch(sim.g);
  let group = null, groupBrick = null;
  let stamp = 0;
  let last = -Infinity;      // when the last scan was recorded
  let clearSince = null;    // when scans started finding no film (null: the last one found one)
  let wanted = false;
  let disposed = false;

  // (the app draws on demand: a frame once the scan can run, so a still grid gets scanned too)
  kernel.ready.then(() => { if (!disposed) onChange(); }, () => {});
  function set(w) {
    if (w === wanted) return;
    wanted = w;
    onChange();
  }
  return {
    get wanted() { return wanted; },
    /** The scan's kernel is built (tests: a film can be seen). */
    get ready() { return kernel.state === 'ready'; },
    /** Records a scan into the open frame if one is due, and lets the film code go once films have been gone long enough. */
    tick(now = performance.now()) {
      if (disposed) return;
      if (kernel.state !== 'ready' || now - last < FILM_SCAN_MS || !derived?.brick) return;
      const read = sim.compact ? sim.bindPhysicalRO : sim.bindRO;
      if (!read) return;
      if (groupBrick !== derived.brick) {
        groupBrick = derived.brick;
        group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: derived.brick } }, { binding: 1, resource: { buffer: ring.buffer } }], `sim${sim.id} film scan`);
      }
      last = now;
      const s = stamp = (stamp + 1) >>> 0 || 1;
      const slot = ring.next();
      kernel.dispatch(gpu.frame, size, { bind: [sim.tables, read, group], header: sim.readHeader({ physical: true }), params: { stamp: s, slot } });
      ring.read(slot).then((bytes) => {
        if (disposed) return;
        const t = performance.now();
        if (new Uint32Array(bytes)[0] === s) { clearSince = null; set(true); return; }
        clearSince ??= t;
        if (t - clearSince > FILM_HOLD_MS) set(false);   // (scans, not a still page's silence, say the films are gone)
      }, () => {});
    },
    dispose() {
      disposed = true;
      ring.close();
    },
  };
}
