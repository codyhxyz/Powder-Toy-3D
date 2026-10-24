// Which loaded bricks a big map forgets (World only: Box, the small maps,
// holds its whole window and loads nothing).
//
// Why: a big map kept every brick it had ever loaded. Each one's lighting row
// (worldLightingRecords.js) joined every later load's demand (wire/worldRender.js
// attempt), and the GPU page budget may only drop the bricks a load asks for
// now, never an old row's (worldBudgetPass held). So once the rows filled the
// budget, every new load dropped the ground on screen instead and read it as
// air: Island from God view, live 2026-10-23, half the island a flat grey
// hole, and every load re-checking ~300k old rows was the slowness with it.
//
// So, the rule of virtual texturing's page cache (id Tech 5 MegaTexture, UE5
// virtual textures, NVIDIA's "A Texture Streaming Pipeline for Real-Time GPU
// Ray Tracing"): a fixed share of the budget, least recently used out first,
// and what the view needs now is never what goes. A brick is used when a load
// asks for it, and kept while it lies in the camera's frustum or near ring; a
// forgotten one is loaded again, as new, the next time the view asks for it.
// The order is lru-cache's (npm), not ours.
import { LRUCache } from 'lru-cache';
import { Box3, Frustum, Matrix4, Vector3 } from 'three';
import { BRICK } from '../shaders/common.js';
import { WORLD_VIEW_NEAR_RADIUS } from './worldViewRing.js';
import { WORLD_SLICE_COST as COST } from './worldSlices.js';

// The share of the CELL page budget old rows may hold: past it the least
// recently used go. The rest is the room a load's new view demand has before
// the budget drops anything (a God-view turn asks for ~100k new bricks on Island).
export const WORLD_RESIDENT_SHARE = 0.5;
// Cells a brick's box grows by for the frustum test: the camera moves on while
// a load runs (the live view draws each frame from the camera as it is), and
// the presentation's curve bends far rays a little off the straight frustum.
export const WORLD_RESIDENT_VIEW_MARGIN = 2 * BRICK;

// The tracker: touch(i) when a load uses brick i; forgetSteps picks the rows to forget.
export function createWorldResidency({ capacity }) {
  // Rows the cache itself pushed out past its capacity: forgotten at the next pick.
  const evicted = new Set();
  const lru = new LRUCache({ max: Math.max(1, capacity), dispose: (_v, i, reason) => { if (reason === 'evict') evicted.add(i); } });
  return {
    touch(i) { lru.set(i, true); evicted.delete(i); },
    clear() { lru.clear(); evicted.clear(); },
    get size() { return lru.size; },
    // Rows the caller forgot by its own rule (wire/worldRender.js forgetUnused's farthest pass).
    untrack(list) { for (const i of list) { lru.delete(i); evicted.delete(i); } },
    // Up to `count` rows to forget, least recently used first: never one held(i)
    // (a load's ask, an owned light record, a glow region) or seen(i) (in the
    // view now, which counts as a use). Returns the indices, already untracked.
    *forgetSteps({ count, held, seen }, full = () => false) {
      const out = [], keep = [];
      for (const i of evicted) { if (out.length >= count) break; if (!held(i) && !seen(i)) out.push(i); if (full(COST.member)) yield; }
      for (const i of out) evicted.delete(i);
      if (out.length < count) for (const i of lru.rkeys()) {
        if (held(i) || seen(i)) keep.push(i); else out.push(i);
        if (out.length >= count) break;
        if (full(COST.rank)) yield;
      }
      for (const i of keep) { lru.set(i, true); if (full(COST.member)) yield; }
      for (const i of out) { lru.delete(i); if (full(COST.member)) yield; }
      return out;
    },
  };
}

// Is brick b (brick coordinates) in the view: inside the near ring of eye
// (cells), or its box, grown by WORLD_RESIDENT_VIEW_MARGIN, in the frustum of
// viewProj × model (values: a frame's captured FrameUniform values, cells to clip).
export function worldResidentView(values) {
  const eye = values?.cam ? Array.from(values.cam) : null;
  if (!eye || eye.length !== 3 || !eye.every(Number.isFinite) || !values.viewProj || !values.model) return null;
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().fromArray(Array.from(values.viewProj)).multiply(new Matrix4().fromArray(Array.from(values.model))));
  const box = new Box3(), lo = new Vector3(), hi = new Vector3(), r2 = WORLD_VIEW_NEAR_RADIUS ** 2, m = WORLD_RESIDENT_VIEW_MARGIN;
  return (b) => {
    let d = 0;
    for (let k = 0; k < 3; k++) { const c = (b[k] + 0.5) * BRICK - eye[k]; d += c * c; }
    if (d <= r2) return true;
    lo.set(b[0] * BRICK - m, b[1] * BRICK - m, b[2] * BRICK - m); hi.set((b[0] + 1) * BRICK + m, (b[1] + 1) * BRICK + m, (b[2] + 1) * BRICK + m);
    return frustum.intersectsBox(box.set(lo, hi));
  };
}
