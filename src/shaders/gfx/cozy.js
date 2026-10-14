// Animal Crossing-inspired surface artwork, not a fullscreen colour filter.
// Like Minecraft's material textures, markings stay attached to world surfaces.
// Coordinates/footprints enter in cells; all pattern sizes below are metres.
export const cozySurfaceWGSL = /* wgsl */ `
const COZY_PI: f32 = 6.2831853;
fn cozyFade(size: f32, fp: f32) -> f32 { return 1.0 - smoothstep(0.12, 0.45, fp / size); }
fn cozyStroke(d: f32, width: f32, aa: f32) -> f32 { return 1.0 - smoothstep(width - aa, width + aa, abs(d)); }
fn cozySupported(id: i32) -> bool {
  return RCLASS(id) == R_OPAQUE && (id == E_WOOD || id == E_PLANT || id == E_SAND || id == E_STONE || id == E_WALL
      || id == E_BRICK || id == E_RUBBLE || id == E_CERAMIC || id == E_CLAY || id == E_MUD
      || id == E_ASH || id == E_SNOW || id == E_SAWDUST || SURF(id) == SURF_CRAG
      || SURF(id) == SURF_BRUSHED || SURF(id) == SURF_POLISHED);
}
fn cozyWood(uv: vec2f, fp: f32) -> vec3f {
  let q = uv / vec2f(1.0, 1.8);
  let cell = floor(q);
  let h = hash33(vec3f(cell, 13.7));
  let r = (fract(q) - (vec2f(0.35) + h.xy * 0.3)) / vec2f(0.15, 0.22);
  let radius = length(r);
  let aa = max(0.012, fp / 0.22);
  let knots = max(cozyStroke(radius - 0.85, 0.07, aa), cozyStroke(radius - 0.46, 0.06, aa));
  let bend = 0.24 * sin(uv.y * 3.7) + 0.1 * sin(uv.y * 7.1) + 0.22 * r.x * exp(-dot(r, r));
  let grain = cozyStroke(sin((uv.x / 0.38 + bend) * COZY_PI), 0.16, max(0.01, fp * 16.5));
  let ink = (0.42 * grain + 0.32 * knots) * cozyFade(0.38, fp);
  return vec3f(1.09 - ink) * vec3f(1.12, 1.0, 0.9);
}
fn cozyRings(uv: vec2f, fp: f32) -> vec3f {
  let q = uv / 1.6;
  let cell = floor(q);
  var radius = 10.0;
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let c = cell + vec2f(f32(x), f32(z));
      let pith = c + 0.3 + hash33(vec3f(c, 41.3)).xy * 0.4;
      radius = min(radius, length(q - pith) * 1.6);
    }
  }
  let phase = radius / 0.28 + 0.06 * sin(uv.x * 7.0) * sin(uv.y * 5.0);
  let rings = cozyStroke(sin(phase * COZY_PI), 0.42, max(0.01, fp * 22.5));
  return vec3f(2.4, 2.0, 1.5) * (1.07 - 0.37 * rings * cozyFade(0.28, fp));
}
fn cozyPlant(uv: vec2f, fp: f32, grass: bool) -> vec3f {
  let size = select(0.48, 0.62, grass);
  let q = uv / size;
  let c = floor(q);
  let h = hash33(vec3f(c, 5.9));
  var r = fract(q) - vec2f(0.5);
  let angle = (h.x - 0.5) * 1.4;
  r = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle)) * r;
  let aa = max(0.005, fp / size);
  var d: f32;
  if (grass) { d = max(abs(r.x) * 0.85 + r.y * 0.5 - 0.08, -0.14 - r.y); }
  else { d = max(length(r - vec2f(0.13, 0.0)), length(r + vec2f(0.13, 0.0))) - 0.37; }
  let mark = 1.0 - smoothstep(-aa, aa, d);
  let vein = cozyStroke(r.y, 0.014, aa) * mark;
  let fade = cozyFade(size, fp);
  let tone = select(0.91 + 0.27 * mark - 0.13 * vein, 0.99 + 0.28 * mark, grass);
  return mix(vec3f(1.0), vec3f(tone) * mix(vec3f(0.96, 1.02, 0.9), vec3f(1.16, 1.08, 0.72), mark), fade);
}
fn cozyRock(uv: vec2f, fp: f32) -> vec3f {
  let q = uv / 1.1;
  let c = floor(q);
  let h = hash13(vec3f(c, 19.1));
  let r = fract(q);
  let patches = smoothstep(0.38, 0.62, vnoise(vec3f(q * 1.4, 8.3)));
  let bend = 0.09 * sin(r.y * 8.0 + h * 4.0);
  let crack = cozyStroke(r.x - 0.5 - bend, 0.012, max(0.003, fp / 1.1))
      * smoothstep(0.12, 0.22, r.y) * (1.0 - smoothstep(0.62, 0.78, r.y)) * select(0.0, 1.0, h > 0.65);
  return vec3f(1.0 + cozyFade(1.1, fp) * (0.25 * (patches - 0.5) - 0.28 * crack));
}
fn cozyDots(uv: vec2f, fp: f32) -> vec3f {
  let size = 0.32;
  let q = uv / size;
  let h = hash33(vec3f(floor(q), 31.7));
  let r = fract(q) - (vec2f(0.3) + h.xy * 0.4);
  let dots = (1.0 - smoothstep(0.05 - max(0.003, fp / size), 0.05 + max(0.003, fp / size), length(r))) * select(0.0, 1.0, h.z > 0.65);
  let drift = vnoise(vec3f(uv / 1.8, 3.9)) - 0.5;
  return vec3f(1.0 + 0.1 * drift * cozyFade(1.8, fp) - 0.27 * dots * cozyFade(size, fp));
}
fn cozyMasonry(uv: vec2f, fp: f32, tile: bool) -> vec3f {
  let size = select(vec2f(0.65, 0.27), vec2f(0.5), tile);
  var q = uv / size;
  if (!tile) { q.x += 0.5 * (floor(q.y) - 2.0 * floor(q.y * 0.5)); }
  let c = floor(q);
  let h = hash13(vec3f(c, 23.7));
  let r = min(fract(q), 1.0 - fract(q)) * size;
  let edge = min(r.x, r.y);
  let seam = 1.0 - smoothstep(0.012 - max(0.001, fp), 0.012 + max(0.001, fp), edge);
  let body = vec3f(0.96 + 0.08 * h);
  let mortar = select(vec3f(1.8, 2.7, 3.8), vec3f(0.55), tile);
  return mix(vec3f(1.0), mix(body, mortar, seam), cozyFade(min(size.x, size.y), fp));
}
fn cozyPattern(id: i32, uv: vec2f, fp: f32, grass: bool) -> vec3f {
  if (id == E_PLANT) { return cozyPlant(uv, fp, grass); }
  if (id == E_SAND || id == E_SAWDUST || id == E_ASH) { return cozyDots(uv, fp); }
  if (id == E_BRICK || id == E_CERAMIC) { return cozyMasonry(uv, fp, id == E_CERAMIC); }
  if (id == E_SNOW) { return vec3f(1.0 + 0.07 * (vnoise(vec3f(uv / 0.9, 4.3)) - 0.5) * cozyFade(0.9, fp)); }
  if (SURF(id) == SURF_BRUSHED || SURF(id) == SURF_POLISHED) { return vec3f(1.0); }
  if (id == E_CLAY || id == E_MUD) { return cozyDots(uv, fp) * (1.0 + 0.12 * (vnoise(vec3f(uv / 1.2, 7.1)) - 0.5) * cozyFade(1.2, fp)); }
  return cozyRock(uv, fp);
}
fn cozyMat(id: i32, p: vec3f, n: vec3f, T: f32, ctype: f32, fp: f32) -> Mat {
  var m = matBase(id);
  let wp = p * CELL_M;
  let pixel = fp * CELL_M;
  let an = abs(n);
  let w = an * an / max(dot(an, an), 1e-5);
  if (id == E_WOOD) {
    // shortcut: E_WOOD has no plank/log axis metadata; keep the existing horizontal-face end-grain rule until authored material tags exist.
    let side = (cozyWood(wp.zy, pixel) * w.x + cozyWood(wp.xy, pixel) * w.z) / max(w.x + w.z, 1e-5);
    let end = woodEndGrain(n);
    m.alb *= mix(side, cozyRings(wp.xz, pixel), end);
  } else {
    // shortcut: all vegetation is E_PLANT; orientation separates ground triangles from leafy side faces until vegetation tags exist.
    let grass = n.y > 0.7;
    m.alb *= cozyPattern(id, wp.zy, pixel, false) * w.x + cozyPattern(id, wp.xz, pixel, grass) * w.y + cozyPattern(id, wp.xy, pixel, false) * w.z;
  }
  m.glint = 0.0;
  m.rough = max(m.rough, select(0.72, 0.38, m.metal > 0.5));
  if (id == E_PLANT) { m.trans = 0.25; }
  // Painted albedo must not change the thermal skin/oxide emission model.
  m.emit = cellEmission(id, T, ctype) + sparkEmit(id, ctype);
  return m;
}
`;

// The same painted strokes and scallops in the volume and the far sea.
// shore is opaque-geometry proximity supplied by each renderer, not noise.
export const cozyWaterWGSL = /* wgsl */ `
fn cozyWater(id: i32) -> bool { return id == E_WATER || id == E_SALTWATER; }
fn cozyWaterPaint(p: vec3f, fp: f32, shore: f32) -> vec4f {
  let wp = p.xz * CELL_M;
  let pixel = fp * CELL_M;
  let t = FU.time;
  let q = (wp + vec2f(t * 0.07, t * 0.035)) / vec2f(1.6, 0.65);
  let crest = sin(q.y * COZY_PI + 0.9 * sin(q.x * 2.7));
  let stroke = cozyStroke(crest, 0.09, max(0.012, pixel * 9.7)) * smoothstep(0.25, 0.7, sin(q.x * 3.4 + floor(q.y) * 2.1)) * cozyFade(0.65, pixel);
  let scallop = 0.53 + 0.14 * sin(t * 1.4 + sin(wp.x * 2.1) + sin(wp.y * 1.7));
  let edge = max(0.03, pixel * 0.25);
  let foam = shore * smoothstep(scallop - 0.18 - edge, scallop + 0.18 + edge, shore) * cozyFade(0.8, pixel);
  let ink = max(stroke * 0.62, foam * 0.9);
  let alpha = 0.14 + 0.72 * ink;
  let tint = mix(vec3f(0.055, 0.32, 0.36), vec3f(0.85, 0.88, 0.72), ink);
  return vec4f(tint, alpha);
}
`;
