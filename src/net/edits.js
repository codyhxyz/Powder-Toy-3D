import { holdNativeRay, nativeRayKind } from '../v2/tools.js';

// Host-only routing after multiplayer's existing protocol validation. A guest
// sends an intent; only the host's current engine mutates authoritative state.
// This seam is CPU-testable without opening sockets, DOM or a GPU browser.
export function applyGuestStroke(sim, s, { wind = null, edits = {}, minRadius = 1, maxRadius = 24 } = {}) {
  const stroke = {
    center: { x: s.c[0], y: s.c[1], z: s.c[2] }, radius: Math.min(Math.max(s.r, minRadius), maxRadius),
    shape: s.shape, tool: s.tool, rate: s.rate, replace: !!s.replace, wind, ...edits,
  };
  // V2: a guest's particle brush is held and emitted per native tick, as the host's own is
  // (v2/tools.js holdNativeRay); painting it per frame would emit at the frame and network rate.
  if (sim.compact && nativeRayKind(stroke.tool)) return holdNativeRay(sim, `guest:${s.from ?? ''}`, stroke);
  return sim.paint(stroke);
}

// A stroke the host's engine can't take yet waits for it, as V1's paint waits in sim.ready: under V2 a
// tool's native kernel may still be building (its run refuses: false, or a kernel used before its
// pipeline throws) and a window shift holds every writer (sim.paint false). It is tried again each
// frame, before the strokes that came after it, for up to GUEST_STROKE_HOLD_MS: longer than a cold
// kernel build (docs/v2/native-startup.md), short enough that a stroke that can never paint goes.
export const GUEST_STROKE_HOLD_MS = 10000;
export const MAX_HELD_STROKES = 1024;   // ~17 s of a guest's 60 Hz strokes

// A frame's queued guest strokes, taken off the queue before any is painted.
// Those the host can't take yet go back on it, in order (above); a stroke still refused after its hold
// is that guest's lost dab: the rest still paint, and the host's frame, its stream and every later
// stroke go on. Returns how many were dropped.
export function applyGuestStrokes(sim, queue, { valid = () => true, options = () => ({}), now = Date.now(), holdMs = GUEST_STROKE_HOLD_MS } = {}) {
  let refused = 0;
  const waiting = [];
  for (const s of queue.splice(0)) {
    if (!valid(s)) continue;
    let taken, error = null;
    try { taken = applyGuestStroke(sim, s, options(s)); } catch (err) { taken = false; error = err; }
    if (taken !== false) continue;
    s.heldSince ??= now;
    if (now - s.heldSince < holdMs && waiting.length < MAX_HELD_STROKES) { waiting.push(s); continue; }
    refused++;
    console.warn('multiplayer: the host refused a guest\'s stroke', error ?? 'its engine could not take it');
  }
  queue.push(...waiting);
  return refused;
}
