// A big map's lighting tick does its per-brick JS in slices, yielding to the
// page between them: the CELL stage's pattern (wire/worldRender.js
// worldClassify). Each step over every brick it holds ran in one go: 10-100 ms
// apiece per tick on Island and Descent (tools/world-tick-incremental-cpu-check.mjs
// --scale), behind 0.3-1.5 s freezes with the steps around them (real Chrome
// with the user's settings, 2026-10-22).
//
// A step is a generator that yields once it has done a slice's work.
// worldRunSync drives it straight through, worldRunSliced with a pause at each
// yield: the same code, so the same results either way. A slice is counted in
// work units, not time, so where the slices fall never depends on the machine.
// One unit is one brick's Map or Set operation (~40-80 ns of V8 on the user's
// Mac); a loop whose brick costs more counts it at its WORLD_SLICE_COST.
export const WORLD_SLICE_UNITS = 1 << 16;
// Units per brick, by loop (each about its measured ns per brick over a
// Map/Set operation's, tools/world-tick-incremental-cpu-check.mjs --scale).
export const WORLD_SLICE_COST = Object.freeze({
  member: 1,     // a Set/Map add, has or get
  record: 4,     // a metadata row read into a frozen GI record, or one built for the selector
  select: 8,     // the selector's rule for one record (giSelect), its checks and its sets
  lease: 16,     // a restore lease or light page: frozen provenance, validation, registration
});
export const worldPause = () => new Promise((resolve) => setTimeout(resolve, 0));
// A meter over one step: full(cost) counts cost units, and is true (and starts
// a new slice) once a slice's worth is done. limit 0: never full.
// (full.limit: the slice's units, for a step that sizes a batch to one)
export function worldSliceMeter(limit = WORLD_SLICE_UNITS) {
  let n = 0;
  const full = limit > 0 ? (cost) => { n += cost; if (n < limit) return false; n = 0; return true; } : () => false;
  full.limit = limit > 0 ? limit : 0;
  return full;
}
export function worldRunSync(steps) {
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}
// live(): called after each pause; false (or a throw) when the work's owner
// is gone, which closes the step (its finally blocks run): the run then
// resolves to undefined (or rejects).
export async function worldRunSliced(steps, { pause = worldPause, live = null } = {}) {
  for (;;) {
    const r = steps.next();   // (a throw here has closed the step already)
    if (r.done) return r.value;
    try { await pause(); if (live && live() === false) { steps.return(); return undefined; } }
    catch (e) { steps.return(); throw e; }
  }
}
