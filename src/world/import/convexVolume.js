// SAT data derived from the actual authored convex trigger vertices. Bounds
// remain a broadphase only: arch corners must not become rectangular triggers.
const dot = (a, b) => a.reduce((n, v, k) => n + v * b[k], 0);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const EPS = 1e-7;
export function convexProjectionAxes(points) {
  if (points.length < 4 || !points.every((p) => p.length === 3 && p.every(Number.isFinite))) throw new Error('Invalid convex vertices');
  const axes = [], seen = new Set(), boxAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const add = (axis) => {
    const length = Math.hypot(...axis); if (length < EPS) return;
    let normal = axis.map((v) => v / length);
    if (normal.find((v) => Math.abs(v) > EPS) < 0) normal = normal.map((v) => -v);
    normal = normal.map((v) => v === 0 ? 0 : v); // JSON-stable positive zero.
    const key = normal.map((v) => Math.round(v * 1e7)).join(','); if (seen.has(key)) return;
    seen.add(key); const values = points.map((p) => dot(p, normal));
    axes.push({ normal, min: Math.min(...values), max: Math.max(...values) });
  };
  boxAxes.forEach(add);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const edge = sub(points[j], points[i]);
    // All point-pair directions contain the true convex hull edges. Extra
    // valid projection axes cannot separate genuinely overlapping bodies.
    for (const axis of boxAxes) add(cross(edge, axis));
    for (let k = j + 1; k < points.length; k++) {
      const normal = cross(edge, sub(points[k], points[i])), length = Math.hypot(...normal);
      if (length < EPS) continue;
      const distances = points.map((p) => dot(sub(p, points[i]), normal) / length);
      if (Math.min(...distances) >= -EPS || Math.max(...distances) <= EPS) add(normal);
    }
  }
  return axes;
}
export function convexOverlapsBox(axes, center, halfSize) {
  return axes.every(({ normal, min, max }) => {
    const middle = dot(normal, center), radius = normal.reduce((r, v, k) => r + Math.abs(v) * halfSize[k], 0);
    return middle + radius >= min - EPS && middle - radius <= max + EPS;
  });
}
