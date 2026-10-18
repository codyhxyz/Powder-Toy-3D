// Host-only routing after multiplayer's existing protocol validation. A guest
// sends an intent; only the host's current engine mutates authoritative state.
// This seam is CPU-testable without opening sockets, DOM or a GPU browser.
export function applyGuestStroke(sim, s, { wind = null, edits = {}, minRadius = 1, maxRadius = 24 } = {}) {
  return sim.paint({
    center: { x: s.c[0], y: s.c[1], z: s.c[2] }, radius: Math.min(Math.max(s.r, minRadius), maxRadius),
    shape: s.shape, tool: s.tool, rate: s.rate, replace: !!s.replace, wind, ...edits,
  });
}
