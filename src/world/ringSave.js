// A save's native words across ring addressing (shaders/common.js ringOf; world/physicsRegion.js). Physics
// V2's saved cores, banks and per-brick dynamics are its buffers' raw words, in the slot order of the grid
// that saved them, and a ringed grid's slot order is rotated by its ring (bricks). The save header records
// the ring it was taken under (slotRing; absent: 0, a save from before rings or from an unringed grid), so
// a grid at the same origin under the same ring restores the words as they are, bit for bit, and any other
// (a save from before the ring, or a ring switched since) rotates them here first.
// Intentional (P3, 2026-10-24): across a change of ring the saved activity isn't carried. Its per-brick
// runs are mixed with lists of brick numbers and counts; it starts over as an undo's restore starts it
// (v2/physics.js restore: every brick busy, its projection stale, its cells noted), so every brick wakes
// and settles again. Only a save of another layout pays that; a ringed save loaded ringed keeps its own.
import { decodeV2State, encodeV2State } from '../v2/state.js';
import { v2ActLayout, LEGACY_WORD } from '../shaders/v2.js';

/** Rotate a per-brick array (`words` u32 a brick, nb bricks) by `delta` bricks: brick b's words land at b + delta (mod nb). */
export function rotateBricks(arr, words, nb, delta) {
  const d = ((delta % nb) + nb) % nb;
  if (!d) return arr;
  const out = new arr.constructor(arr.length), span = words * nb;
  out.set(arr.subarray(0, span - d * words), d * words);
  out.set(arr.subarray(span - d * words, span), 0);
  if (arr.length > span) out.set(arr.subarray(span), span);   // (anything past the bricks' runs is not theirs)
  return out;
}

/** The ring delta (bricks) from a save's layout to the grid's: 0 when its words restore as they are. */
export const ringDelta = (header, g) => {
  const nb = g.nbricks ?? (g.nx * g.ny * g.nz) / 64, d = ((g.ring ?? 0) - (header?.slotRing ?? 0)) % nb;
  return d < 0 ? d + nb : d;
};

/** V2's saved state (v2/state.js bytes) re-laid by `delta` bricks: cores and banks rotated, the activity started over. */
export function relayoutV2State(bytes, dims, delta) {
  const s = decodeV2State(bytes, dims), g = { nx: dims[0], ny: dims[1], nz: dims[2] }, nb = (g.nx * g.ny * g.nz) / 64;
  if (!delta) return bytes;
  const a = v2ActLayout(g), activity = new Uint32Array(s.activity.length);
  activity.fill(1, a.busy0, a.busy0 + nb); activity.fill(1, a.busy1, a.busy1 + nb);
  activity.fill(LEGACY_WORD.STALE, a.legacy, a.legacy + nb);
  const { cells, aux, activity: _, ...meta } = s;
  delete meta.version; delete meta.hasAux; delete meta.energyLedger;
  return encodeV2State({ ...meta, cells: rotateBricks(cells, 256, nb, delta), activity, args: s.args,
    ...(aux ? { aux: rotateBricks(aux, 64, nb, delta) } : {}) });
}

/** A dynamics snapshot (v2/dynamicState.js) re-laid by `delta` bricks: its per-brick air and shocks rotated. */
export function relayoutDynamics(snapshot, nb, delta) {
  if (!delta) return snapshot;
  return { ...snapshot, air: rotateBricks(snapshot.air, 8, nb, delta), shocks: rotateBricks(snapshot.shocks, 1, nb, delta) };
}
