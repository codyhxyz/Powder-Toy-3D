// Coordinate transform only. No terrain, rooms, material substitutions, or repairs.
const TAU = 2 * Math.PI;
const wrap = (a) => a - Math.floor(a / TAU) * TAU;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const FOLD_OUTSIDE = 0, FOLD_SOURCE = 1, FOLD_CAP = 2;

export function createFold(config) {
  const { sourceMinX, sourceWidth, cellScale, angleStart, angleSpan,
    thickness, shellThickness, margin } = config;
  if (![sourceMinX, sourceWidth, cellScale, angleStart, angleSpan, thickness, shellThickness, margin].every(finite) ||
      !Number.isSafeInteger(sourceMinX) || !Number.isSafeInteger(sourceWidth) ||
      sourceWidth <= 0 || cellScale <= 0 || angleSpan <= 0 || angleSpan >= TAU ||
      thickness <= 0 || shellThickness < 1 || margin < shellThickness) {
    throw new Error('Invalid Noita fold configuration');
  }
  const radius = sourceWidth * cellScale / angleSpan, halfWidth = thickness / 2;
  if (radius <= halfWidth + shellThickness ||
      2 * radius * Math.sin((TAU - angleSpan) / 2) <= thickness + 2 * shellThickness) {
    throw new Error('Noita fold overlaps itself or collapses its inner edge');
  }
  const side = Math.ceil(2 * (radius + halfWidth + shellThickness + margin) / 16) * 16;
  const center = [side / 2, side / 2];
  const dimensions = (sourceHeight = 320) => [side, sourceHeight * cellScale, side];
  const band = (sourceTop, sourceHeight) => {
    if (!finite(sourceTop) || !finite(sourceHeight) || sourceHeight <= 0) throw new Error('Invalid source band');
  };
  const chart = (point, sourceTop, sourceHeight) => {
    band(sourceTop, sourceHeight);
    const [x, y, z] = point, dx = x - center[0], dz = z - center[1];
    const angle = wrap(Math.atan2(dz, dx) - angleStart);
    return {
      angle, depth: Math.hypot(dx, dz) - radius,
      source: [sourceMinX + angle * radius / cellScale,
        sourceTop + sourceHeight - y / cellScale, Math.hypot(dx, dz) - radius],
    };
  };
  const classifyCode = (point, sourceTop, sourceHeight) => {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(finite)) return FOLD_OUTSIDE;
    band(sourceTop, sourceHeight);
    if (point[1] < 0 || point[1] >= sourceHeight * cellScale) return FOLD_OUTSIDE;
    const { angle, depth } = chart(point, sourceTop, sourceHeight);
    const d = Math.abs(depth);
    if (angle < angleSpan) {
      if (d < halfWidth) return FOLD_SOURCE;
      if (d < halfWidth + shellThickness) return FOLD_CAP;
    } else if (d < halfWidth + shellThickness &&
      Math.min(angle - angleSpan, TAU - angle) * radius < shellThickness) return FOLD_CAP;
    return FOLD_OUTSIDE;
  };
  return {
    config: { ...config }, radius, center, size: dimensions(), dimensions,
    // Conservative empty-column proof. It includes caps and the whole circle,
    // so it cannot cut a source fiber or the arc ends out of the far field.
    mayContainCellsXZ(lo, hi, padding = 0) {
      const min = Math.hypot(...center.map((c, i) => Math.max(lo[i] - padding - c, 0, c - hi[i] - padding)));
      const max = Math.hypot(...center.map((c, i) => Math.max(Math.abs(lo[i] - padding - c), Math.abs(hi[i] + padding - c))));
      return min <= radius + halfWidth + shellThickness && max >= radius - halfWidth - shellThickness;
    },
    // Continuous SOURCE pixel coordinates, including fractional points.
    // Source Y increases down. World Y increases up.
    forward([sx, sy, depth = 0], sourceTop, sourceHeight) {
      band(sourceTop, sourceHeight);
      if (![sx, sy, depth].every(finite)) throw new Error('Non-finite source point');
      const angle = angleStart + (sx - sourceMinX) * cellScale / radius;
      return [center[0] + (radius + depth) * Math.cos(angle),
        (sourceTop + sourceHeight - sy) * cellScale,
        center[1] + (radius + depth) * Math.sin(angle)];
    },
    inverse(point, sourceTop, sourceHeight) {
      return classifyCode(point, sourceTop, sourceHeight) === FOLD_SOURCE
        ? chart(point, sourceTop, sourceHeight).source : null;
    },
    chart, classifyCode,
    classify(point, sourceTop, sourceHeight) {
      return ['outside', 'source', 'cap'][classifyCode(point, sourceTop, sourceHeight)];
    },
    // A/B/C are three vec4f uniforms. The WGSL below uses the same layout.
    uniforms(sourceTop, sourceHeight) {
      band(sourceTop, sourceHeight);
      return {
        a: [...center, radius, angleStart],
        b: [sourceMinX, cellScale, angleSpan, halfWidth],
        c: [sourceTop, sourceHeight, shellThickness, 0],
      };
    },
  };
}

// Pure functions: the caller owns uniform names and material sampling.
// A=(centerX,centerZ,radius,startAngle), B=(minSourceX,scale,span,halfWidth),
// C=(sourceTop,sourceHeight,shellThickness,unused).
export const foldWGSL = /* wgsl */ `
const FOLD_TAU: f32 = 6.283185307179586;
fn foldAngle(p: vec3f, a: vec4f) -> f32 {
  let delta = p.xz - a.xy;
  let angle = atan2(delta.y, delta.x) - a.w;
  return angle - floor(angle / FOLD_TAU) * FOLD_TAU;
}
fn foldChart(p: vec3f, a: vec4f, b: vec4f, c: vec4f) -> vec3f {
  let angle = foldAngle(p, a);
  return vec3f(b.x + angle * a.z / b.y, c.x + c.y - p.y / b.y,
    length(p.xz - a.xy) - a.z);
}
fn foldClassify(p: vec3f, a: vec4f, b: vec4f, c: vec4f) -> i32 {
  if (p.y < 0.0 || p.y >= c.y * b.y) { return 0; }
  let angle = foldAngle(p, a);
  let depth = abs(length(p.xz - a.xy) - a.z);
  if (angle < b.z) {
    if (depth < b.w) { return 1; }
    if (depth < b.w + c.z) { return 2; }
  } else if (depth < b.w + c.z && min(angle - b.z, FOLD_TAU - angle) * a.z < c.z) {
    return 2;
  }
  return 0;
}
`;
