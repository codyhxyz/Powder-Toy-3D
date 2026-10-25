// Which sign plates keep their text when several would overlap on screen.
//
// Label rule borrowed from map apps (Google Maps place labels) and Minecraft nametags:
// the nearest label wins its space, a label that would cover it collapses to its pin.
// Pure (no DOM) so it is checked from node: signsDeclutter.test.js.

// A plate that was readable last pass is tested with its rect shrunk by this fraction
// (per side), so two plates grazing each other don't trade places every frame.
export const KEEP_SHRINK = 0.08;

const overlaps = (a, b, gap) =>
  a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap;

const shrunk = (r, f) => {
  const dx = (r.x1 - r.x0) * f, dy = (r.y1 - r.y0) * f;
  return { x0: r.x0 + dx, x1: r.x1 - dx, y0: r.y0 + dy, y1: r.y1 - dy };
};

// rects: [{ x0, y0, x1, y1, dist, pinned, kept }] in screen pixels. pinned = always readable
// (being edited or hovered); kept = readable on the previous pass.
// Returns a Set of the rects that stay readable.
export function pickUncovered(rects, gap) {
  const order = rects.slice().sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (a.dist - b.dist));
  const won = [];
  const keep = new Set();
  for (const r of order) {
    const probe = r.kept && !r.pinned ? shrunk(r, KEEP_SHRINK) : r;
    if (r.pinned || !won.some((w) => overlaps(probe, w, gap))) { won.push(r); keep.add(r); }
  }
  return keep;
}
