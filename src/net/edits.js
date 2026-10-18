// Host-only routing after multiplayer's existing protocol validation. A guest
// sends an intent; only the host's current engine mutates authoritative state.
// This seam is CPU-testable without opening sockets, DOM or a GPU browser.
export function applyGuestStroke(sim, s, { wind = null, edits = {}, minRadius = 1, maxRadius = 24 } = {}) {
  return sim.paint({
    center: { x: s.c[0], y: s.c[1], z: s.c[2] }, radius: Math.min(Math.max(s.r, minRadius), maxRadius),
    shape: s.shape, tool: s.tool, rate: s.rate, replace: !!s.replace, wind, ...edits,
  });
}

// A frame's queued guest strokes, taken off the queue before any is painted.
// A stroke the host's engine refuses (V2 throws for a native tool it can't run
// yet) is that guest's lost dab: the rest still paint, and the host's frame,
// its stream and every later stroke go on. Returns how many were refused.
export function applyGuestStrokes(sim, queue, { valid = () => true, options = () => ({}) } = {}) {
  let refused = 0;
  for (const s of queue.splice(0)) {
    if (!valid(s)) continue;
    try { applyGuestStroke(sim, s, options(s)); } catch (err) {
      refused++;
      console.warn('multiplayer: the host refused a guest\'s stroke', err);
    }
  }
  return refused;
}
