// Animal Crossing-inspired surface artwork, not a fullscreen colour filter.
// Like Minecraft's material textures, markings stay attached to world surfaces.
// Coordinates/footprints enter in cells; all pattern sizes below are metres.
export const cozySurfaceWGSL = /* wgsl */ `
const COZY_TAU: f32 = 6.2831853;
fn cozyFade(size: f32, fp: f32) -> f32 { return 1.0 - smoothstep(0.12, 0.45, fp / size); }
fn cozyStroke(d: f32, width: f32, aa: f32) -> f32 { return 1.0 - smoothstep(width - aa, width + aa, abs(d)); }
fn cozyBand(phase: f32, width: f32, aa: f32) -> f32 {
  return cozyStroke(fract(phase + 0.5) - 0.5, width, aa);
}
// Nearest jittered patch: local coordinates, seed, and distance from its edge.
// Checking neighbors keeps painted patches continuous across cell boundaries.
fn cozyCell(uv: vec2f, size: f32, salt: f32) -> vec4f {
  let q = uv / size;
  let cell = floor(q);
  var first = 10.0;
  var second = 10.0;
  var local = vec2f(0.0);
  var seed = 0.0;
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let c = cell + vec2f(f32(x), f32(z));
      let h = hash33(vec3f(c, salt));
      let r = q - c - (0.28 + h.xy * 0.44);
      let d = dot(r, r);
      if (d < first) { second = first; first = d; local = r; seed = h.z; }
      else { second = min(second, d); }
    }
  }
  return vec4f(local, seed, second - first);
}
fn cozySupported(id: i32, ctype: f32) -> bool {
  return RCLASS(id) == R_OPAQUE && (id == E_WOOD || id == E_PLANT || (id == E_MOSS && appearanceOf(id, ctype) == AP_LEAVES) || id == E_SAND || id == E_STONE || id == E_WALL
      || id == E_BRICK || id == E_RUBBLE || id == E_CERAMIC || id == E_CLAY || id == E_MUD
      || id == E_ASH || id == E_SNOW || id == E_SAWDUST || SURF(id) == SURF_CRAG
      || SURF(id) == SURF_BRUSHED || SURF(id) == SURF_POLISHED);
}
fn cozyWood(uv: vec2f, fp: f32) -> vec3f {
  // Animal Crossing's bark reads as a few flowing ribbons, not fine cracks.
  let q = uv / vec2f(1.45, 2.3);
  let h = hash33(vec3f(floor(q), 13.7));
  let r = (fract(q) - (vec2f(0.42) + h.xy * 0.16)) / vec2f(0.16, 0.22);
  let radius = length(r);
  let aa = max(0.012, fp / 0.22);
  let oval = max(cozyStroke(radius - 0.93, 0.11, aa), cozyStroke(radius - 0.51, 0.10, aa));
  let core = 1.0 - smoothstep(0.15 - aa, 0.21 + aa, radius);
  let knot = max(oval, core * 0.9);
  let knotBody = 1.0 - smoothstep(1.08, 1.35, radius);
  let bend = 0.15 * sin(uv.y * 2.1) + 0.055 * sin(uv.y * 5.3)
           + 0.35 * r.x * exp(-dot(r, r)) * (1.0 - smoothstep(1.6, 1.85, radius));
  let phase = uv.x / 0.52 + bend;
  let grainAA = max(0.006, fp / 0.52);
  let taper = 0.76 + 0.24 * sin(uv.y * 1.7 + uv.x * 0.73);
  let grain = cozyBand(phase, 0.062 * taper, grainAA) * (1.0 - knotBody);
  let lightEdge = cozyBand(phase - 0.10, 0.045, grainAA) * (1.0 - knotBody);
  let ribbons = smoothstep(0.16, 0.38, fract(phase)) * (1.0 - smoothstep(0.66, 0.90, fract(phase)));
  let tone = 1.02 + 0.10 * ribbons * cozyFade(0.52, fp)
           + (0.12 * lightEdge - 0.43 * grain - 0.48 * knot) * cozyFade(0.38, fp);
  return mix(vec3f(1.0), vec3f(1.22, 1.02, 0.84) * tone, cozyFade(1.45, fp));
}
fn cozyRings(uv: vec2f, fp: f32) -> vec3f {
  let fade = cozyFade(0.46, fp);
  if (fade == 0.0) { return vec3f(2.75, 2.16, 1.46) * 1.02; }
  let cell = cozyCell(uv, 1.65, 41.3);
  let r = cell.xy * vec2f(1.65, 1.50);
  let radius = length(r);
  // One turn per ring makes a continuous spiral, including atan2's wrap.
  var angle = 0.0;
  if (radius > 1e-5) { angle = atan2(r.y, r.x); }
  let phase = radius / 0.23 - angle / COZY_TAU
            + 0.07 * sin(r.x * 5.2 + cell.z * 6.0) * sin(r.y * 4.1);
  let aa = max(0.006, fp / 0.23);
  let rings = cozyBand(phase, 0.11, aa);
  let raised = cozyBand(phase - 0.19, 0.055, aa);
  let pith = 1.0 - smoothstep(0.035 - fp, 0.07 + fp, radius);
  let join = smoothstep(0.01, 0.16, cell.w);
  return vec3f(2.75, 2.16, 1.46) * (1.02 + (0.11 * raised - 0.42 * rings - 0.24 * pith) * join * fade);
}
fn cozyLeaf(r0: vec2f, angle: f32, size: vec2f, aa: f32) -> vec4f {
  let r = (mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle)) * r0) / size;
  let d = length(vec2f(r.x, abs(r.y) + 0.28)) - 0.55;
  let fill = 1.0 - smoothstep(-aa, aa, d);
  let rim = cozyStroke(d + 0.024, 0.025, aa);
  let vein = cozyStroke(r.y + 0.035 * sin(r.x * 4.5), 0.025, aa) * (1.0 - smoothstep(0.31, 0.44, abs(r.x)));
  let tip = smoothstep(-0.1, 0.4, r.x);
  let colour = vec3f(1.12, 1.23, 0.75) * (0.95 + 0.15 * tip - 0.24 * rim + 0.16 * vein);
  return vec4f(colour, fill);
}
fn cozyPlant(uv: vec2f, fp: f32, grass: bool) -> vec3f {
  if (cozyFade(select(0.84, 2.7, grass), fp) == 0.0) { return vec3f(1.0); }
  let size = select(0.84, 0.68, grass);
  var q = uv / size;
  q.x += 0.5 * (floor(q.y) - 2.0 * floor(q.y * 0.5));
  let h = hash33(vec3f(floor(q), 5.9));
  let r = fract(q) - vec2f(0.5) - (h.xy - 0.5) * 0.08;
  let aa = max(0.005, fp / size);
  if (grass) {
    let angle = (h.z - 0.5) * 2.4;
    let v = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle)) * r;
    let d = max(abs(v.x) * 0.9 + v.y * 0.55 - 0.085, -0.16 - v.y);
    let mark = 1.0 - smoothstep(-aa, aa, d);
    let mottling = vnoise(vec3f(uv / 2.7, 6.2)) - 0.5;
    let body = vec3f(0.93, 1.01, 0.77) * (1.0 + 0.12 * mottling * cozyFade(2.7, fp));
    let ink = select(vec3f(0.75, 0.84, 0.65), vec3f(1.40, 1.23, 0.76), h.z > 0.36);
    return mix(vec3f(1.0), mix(body, ink, mark * cozyFade(size, fp)), cozyFade(2.7, fp));
  }
  // Paired pointed leaves, with a dark rim and curved vein, not polka dots.
  let back = cozyLeaf(r + vec2f(0.16, 0.05), -0.65 + h.z * 0.35, vec2f(0.50, 0.52), aa * 1.8);
  let front = cozyLeaf(r - vec2f(0.13, 0.06), 0.35 + h.z * 0.45, vec2f(0.54, 0.55), aa * 1.8);
  var colour = vec3f(0.82, 0.94, 0.73);
  colour = mix(colour, back.rgb * vec3f(0.86, 0.89, 0.90), back.a);
  colour = mix(colour, front.rgb, front.a);
  return mix(vec3f(1.0), colour, cozyFade(size, fp));
}
fn cozyRock(uv: vec2f, fp: f32) -> vec3f {
  let fade = cozyFade(1.18, fp);
  if (fade == 0.0) { return vec3f(1.0); }
  let cell = cozyCell(uv, 1.18, 19.1);
  let r = cell.xy;
  let aa = max(0.004, fp / 1.18);
  let face = 1.0 - smoothstep(0.27, 0.57, length(r * vec2f(0.9, 1.15)));
  let seam = 1.0 - smoothstep(0.012 - aa, 0.036 + aa, cell.w);
  let bend = 0.065 * sin(r.y * 7.0 + cell.z * 5.0);
  let crack = cozyStroke(r.x - bend, 0.022, aa) * (1.0 - smoothstep(0.2, 0.36, abs(r.y)))
            * select(0.0, 1.0, cell.z > 0.67);
  let tone = 0.97 + 0.17 * face + 0.19 * (cell.z - 0.5) - 0.12 * seam - 0.29 * crack;
  return mix(vec3f(1.0), vec3f(1.02, 1.01, 0.96) * tone, fade);
}
fn cozyDots(uv: vec2f, fp: f32) -> vec3f {
  let size = 0.36;
  let q = uv / size;
  let h = hash33(vec3f(floor(q), 31.7));
  let r = (fract(q) - (vec2f(0.25) + h.xy * 0.5)) * vec2f(1.0, 1.45);
  let aa = max(0.004, fp / size);
  let dots = (1.0 - smoothstep(0.05 - aa, 0.065 + aa, length(r))) * select(0.0, 1.0, h.z > 0.55);
  let phase = uv.y / 0.80 + 0.10 * sin(uv.x * 2.3) + 0.035 * sin(uv.x * 5.1);
  let ripple = cozyBand(phase, 0.035, max(0.004, fp / 0.80))
             * smoothstep(-0.15, 0.65, sin(uv.x * 1.5 + floor(phase + 0.5) * 2.7));
  let drift = vnoise(vec3f(uv / 2.4, 3.9)) - 0.5;
  let tone = 1.01 + 0.10 * drift * cozyFade(2.4, fp) - 0.09 * ripple * cozyFade(0.80, fp)
           - 0.29 * dots * cozyFade(size, fp);
  return mix(vec3f(1.0), vec3f(1.04, 1.01, 0.92) * tone, cozyFade(2.4, fp));
}
fn cozySoil(uv: vec2f, fp: f32) -> vec3f {
  let mottling = smoothstep(0.30, 0.68, vnoise(vec3f(uv / 1.65, 7.1)));
  let q = uv / 0.56;
  let h = hash33(vec3f(floor(q), 11.3));
  let r = (fract(q) - vec2f(0.5)) / vec2f(0.13, 0.08);
  let pebble = (1.0 - smoothstep(0.75, 1.05 + fp * 8.0, length(r))) * select(0.0, 1.0, h.z > 0.77) * cozyFade(0.56, fp);
  let earth = mix(vec3f(0.88, 0.91, 0.84), vec3f(1.15, 1.06, 0.87), mottling);
  return mix(vec3f(1.0), mix(earth, vec3f(1.35, 1.28, 1.12), pebble), cozyFade(1.65, fp));
}
fn cozySnow(uv: vec2f, fp: f32) -> vec3f {
  let drift = smoothstep(0.34, 0.67, vnoise(vec3f(uv / 1.8, 4.3)));
  return mix(vec3f(1.0), mix(vec3f(0.87, 0.96, 1.10), vec3f(1.03, 1.03, 1.0), drift), cozyFade(1.8, fp));
}
fn cozyMasonry(uv: vec2f, fp: f32, tile: bool) -> vec3f {
  let size = select(vec2f(0.72, 0.32), vec2f(0.54), tile);
  var q = uv / size;
  if (!tile) { q.x += 0.5 * (floor(q.y) - 2.0 * floor(q.y * 0.5)); }
  let h = hash33(vec3f(floor(q), 23.7));
  let r = (fract(q) - 0.5) * size;
  let aa = max(0.001, fp);
  let radius = 0.035;
  // Leave a pixel-wide shared border so neighboring brick seeds cannot make
  // an antialiased grout seam jump when the footprint grows.
  let box = abs(r) - (size * 0.5 - vec2f(max(0.019, aa) + radius));
  let d = length(max(box, vec2f(0.0))) + min(max(box.x, box.y), 0.0) - radius;
  let fill = 1.0 - smoothstep(-aa, aa, d);
  let rim = cozyStroke(d + 0.016, 0.018, aa);
  let raised = cozyStroke(d + 0.037, 0.016, aa) * smoothstep(-0.08, 0.08, r.y);
  var body = vec3f(0.89 + 0.22 * h.z) * (1.0 - 0.14 * rim + 0.12 * raised);
  if (tile) {
    let diamond = 1.0 - smoothstep(0.068 - aa, 0.068 + aa, abs(r.x) + abs(r.y));
    body = mix(body * vec3f(1.03, 1.01, 0.96), vec3f(0.40, 0.71, 0.98), diamond);
  }
  let mortar = select(vec3f(1.62, 2.12, 2.70), vec3f(0.68, 0.73, 0.78), tile);
  return mix(vec3f(1.0), mix(mortar, body, fill), cozyFade(min(size.x, size.y), fp));
}
fn cozyPattern(id: i32, uv: vec2f, fp: f32, grass: bool) -> vec3f {
  if (id == E_PLANT) { return cozyPlant(uv, fp, grass); }
  if (id == E_SAND || id == E_SAWDUST || id == E_ASH) { return cozyDots(uv, fp); }
  if (id == E_BRICK || id == E_CERAMIC) { return cozyMasonry(uv, fp, id == E_CERAMIC); }
  if (id == E_SNOW) { return cozySnow(uv, fp); }
  if (SURF(id) == SURF_BRUSHED || SURF(id) == SURF_POLISHED) { return vec3f(1.0); }
  if (id == E_CLAY || id == E_MUD) { return cozySoil(uv, fp); }
  return cozyRock(uv, fp);
}
// Animal Crossing's furniture uses readable boards, not the tree's bark.
// These seams and slender grain follow an authored timber axis in cozyMat.
fn cozyPlanks(uv: vec2f, fp: f32) -> vec3f {
  let width = 0.46;
  if (cozyFade(width, fp) <= 0.0) { return vec3f(1.0); }
  let board = floor(uv.x / width);
  let h = hash33(vec3f(board, 43.0, 19.0));
  let along = uv.y + h.x * 2.8;
  let local = vec2f(fract(uv.x / width) - 0.5, fract(along / 2.8) - 0.5);
  let aa = max(fp * 1.3, 0.001);
  let seamWidth = max(0.012, aa);
  let jointWidth = max(0.009, aa);
  let seam = 1.0 - smoothstep(seamWidth - aa, seamWidth + aa, (0.5 - abs(local.x)) * width);
  let joint = 1.0 - smoothstep(jointWidth - aa, jointWidth + aa, (0.5 - abs(local.y)) * 2.8);
  let r = (local - (h.yz - 0.5) * vec2f(0.35, 0.45)) / vec2f(0.16, 0.10);
  let bend = 0.11 * sin(along * 2.2 + h.y * COZY_TAU) + 0.16 * r.x * exp(-dot(r, r));
  let grain = cozyStroke(sin((uv.x / 0.11 + bend) * COZY_TAU), 0.13, max(fp * 60.0, 0.015));
  let knot = cozyStroke(length(r) - 0.7, 0.09, max(fp * 22.0, 0.02)) * smoothstep(0.48, 0.65, h.z);
  let tone = 1.0 + (h.y - 0.5) * 0.18 - grain * 0.13 - knot * 0.19;
  let body = vec3f(1.55, 1.35, 1.14) * tone;
  let paint = mix(body, vec3f(0.57, 0.53, 0.48), max(seam, joint));
  return mix(vec3f(1.0), paint, cozyFade(width, fp));
}
fn cozyTimberPattern(uv: vec2f, fp: f32, plank: bool) -> vec3f {
  if (plank) { return cozyPlanks(uv, fp); }
  return cozyWood(uv, fp);
}
fn cozyAuthoredPattern(id: i32, uv: vec2f, fp: f32, grass: bool, foliage: bool) -> vec3f {
  if (foliage) { return cozyPlant(uv, fp, false); }
  return cozyPattern(id, uv, fp, grass);
}
fn cozyMat(id: i32, p: vec3f, n: vec3f, T: f32, ctype: f32, fp: f32) -> Mat {
  var m = matBase(id);
  let wp = p * CELL_M;
  let pixel = fp * CELL_M;
  let an = abs(n);
  let w = an * an / max(dot(an, an), 1e-5);
  let appearance = appearanceOf(id, ctype);
  if (appearance == AP_PLAIN) {
    m.emit = cellEmission(id, T, ctype) + sparkEmit(id, ctype);
    return m;
  }
  if (id == E_WOOD) {
    var q = wp;
    var qn = n;
    if (appearance == AP_LOG_X || appearance == AP_PLANK_X) { q = wp.yxz; qn = n.yxz; }
    if (appearance == AP_LOG_Z || appearance == AP_PLANK_Z) { q = wp.xzy; qn = n.xzy; }
    let aw = abs(qn) * abs(qn);
    let tw = aw / max(dot(abs(qn), abs(qn)), 1e-5);
    let plank = appearance >= AP_PLANK_X && appearance <= AP_PLANK_Z;
    if (plank || appearance == AP_BARK) {
      var paint = vec3f(0.0);
      if (tw.x > 0.0) { paint += cozyTimberPattern(q.zy, pixel, plank) * tw.x; }
      if (tw.y > 0.0) { paint += cozyTimberPattern(q.xz, pixel, plank) * tw.y; }
      if (tw.z > 0.0) { paint += cozyTimberPattern(q.xy, pixel, plank) * tw.z; }
      m.alb *= paint;
    } else {
      // Unknown cells keep the old upward-end convention; labelled logs have
      // rings on both ends of their explicit X/Y/Z axis.
      let end = select(woodEndGrain(qn), woodEndGrain(abs(qn)), appearance != AP_NONE);
      var paint = vec3f(0.0);
      if (end < 1.0) {
        var side = vec3f(0.0);
        if (tw.x > 0.0) { side += cozyWood(q.zy, pixel) * tw.x; }
        if (tw.z > 0.0) { side += cozyWood(q.xy, pixel) * tw.z; }
        paint += side / max(tw.x + tw.z, 1e-5) * (1.0 - end);
      }
      if (end > 0.0) { paint += cozyRings(q.xz, pixel) * end; }
      m.alb *= paint;
    }
  } else {
    // Labels decide identity; normals only project the selected artwork.
    // Unknown legacy/imported plants keep their old rendering fallback.
    let grass = appearance == AP_GRASS;
    let foliage = appearance == AP_LEAVES;
    let oldGrass = appearance == AP_NONE && n.y > 0.7;
    var paint = vec3f(0.0);
    if (w.x > 0.0) { paint += cozyAuthoredPattern(id, wp.zy, pixel, grass, foliage) * w.x; }
    if (w.y > 0.0) { paint += cozyAuthoredPattern(id, wp.xz, pixel, grass || oldGrass, foliage) * w.y; }
    if (w.z > 0.0) { paint += cozyAuthoredPattern(id, wp.xy, pixel, grass, foliage) * w.z; }
    m.alb *= paint;
  }
  m.glint = 0.0;
  m.rough = max(m.rough, select(0.72, 0.38, m.metal > 0.5));
  if (id == E_CERAMIC) { m.rough = 0.43; }
  if (id == E_PLANT || appearance == AP_LEAVES) { m.trans = 0.25; }
  // Painted albedo must not change the thermal skin/oxide emission model.
  m.emit = cellEmission(id, T, ctype) + sparkEmit(id, ctype);
  return m;
}
`;

// The same painted strokes and scallops in the volume and the far sea.
// shore is opaque-geometry proximity supplied by each renderer, not noise.
export const cozyWaterWGSL = /* wgsl */ `
const COZY_WATER_ROUGH: f32 = 0.30;
const COZY_WATER_REFLECT: f32 = 0.26;
fn cozyWater(id: i32) -> bool { return id == E_WATER || id == E_SALTWATER; }
fn cozyWaterNormal(p: vec3f, geometric: vec3f, fp: f32) -> vec3f {
  let wp = p.xz * CELL_M;
  let t = FU.time;
  let fade = cozyFade(1.4, fp * CELL_M);
  let dx = 0.025 * cos(wp.x * 1.7 + wp.y * 0.6 + t * 0.65);
  let dz = 0.035 * cos(wp.y * 2.1 - wp.x * 0.4 + t * 0.8);
  return normalize(geometric + vec3f(dx, 0.0, dz) * fade);
}
fn cozyWaterPaint(p: vec3f, fp: f32, shore: f32) -> vec4f {
  let wp = p.xz * CELL_M;
  let pixel = fp * CELL_M;
  let t = FU.time;
  let drift = wp + vec2f(t * 0.075, t * 0.04);
  let phase = drift.y / 0.95 + 0.18 * sin(drift.x * 1.6) + 0.055 * sin(drift.x * 3.9);
  let aa = max(0.008, pixel / 0.95);
  let segment = smoothstep(-0.1, 0.7, sin(drift.x * 2.0 + floor(phase + 0.5) * 2.7));
  let stroke = cozyBand(phase, 0.043, aa) * segment * cozyFade(0.95, pixel);
  let wake = cozyBand(phase - 0.15, 0.065, aa) * cozyFade(0.95, pixel);
  // Painted caustic cells move below the foam; no extra geometry/depth reads.
  var caustic = 0.0;
  if (shore > 0.02 && shore < 0.8 && pixel < 0.29) {
    let flow = drift + 0.12 * sin(drift.yx * 2.2 + vec2f(t * 0.35, -t * 0.28));
    let cells = cozyCell(flow, 0.78, 37.8);
    let cellAA = max(0.01, pixel / 0.78);
    caustic = (1.0 - smoothstep(0.03 - cellAA, 0.12 + cellAA, cells.w)) * cozyFade(0.78, pixel)
            * smoothstep(0.02, 0.65, shore);
  }
  let scallop = 0.46 + 0.12 * sin(t * 1.05 + sin(wp.x * 2.1) + sin(wp.y * 1.7));
  let edge = max(0.025, pixel * 0.35);
  let foam = shore * smoothstep(scallop - 0.14 - edge, scallop + 0.14 + edge, shore) * cozyFade(0.95, pixel);
  let lace = cozyStroke(shore - scallop, 0.05, edge) * cozyFade(0.95, pixel);
  let ink = max(stroke * 0.78, max(foam * 0.93, lace * 0.65));
  let alpha = 0.14 + 0.69 * ink;
  var body = mix(vec3f(0.025, 0.25, 0.39), vec3f(0.065, 0.46, 0.43), smoothstep(0.0, 0.70, shore));
  body += vec3f(0.015, 0.055, 0.06) * caustic - vec3f(0.012, 0.024, 0.015) * wake;
  let tint = mix(body, vec3f(0.88, 0.91, 0.78), ink);
  return vec4f(tint, alpha);
}
`;
