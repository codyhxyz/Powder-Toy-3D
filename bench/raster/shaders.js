// The raster bench's WGSL: v2's frame (docs/v2.md 3.1, 3.3, 3.4, 3.5) as
// close as a bench gets, in four render modules and one compute module:
//
//   shadow   depth-only faces from the sun
//   scene    sky + ground, then the opaque faces; an MSAA variant (colour and
//            linear depth) and a TAAU variant (the same, plus motion)
//   trans    liquid and glass faces at 1×, over the resolved colour and depth
//   post     the tone map to the canvas, and the TAAU resolve (reprojection,
//            neighbourhood clamp, upscale) with the same tone map
//   light    the per-cell sky and block light grid, filled once at load
//
// `nonce` goes into every module and into a comparison every entry point
// makes against a uniform that never holds it. A new nonce is new shader
// text all the way down to the Metal source, so no pipeline cache (the
// browser's or the system's) has seen it: ?cold=1's cold compile.

const COMMON = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,       // this frame's (jittered in TAAU)
  viewProjNoJit: mat4x4f,  // unjittered, for motion
  prevViewProj: mat4x4f,   // last frame's, unjittered
  invViewProj: mat4x4f,    // inverse of viewProj, for the sky's rays
  sunViewProj: mat4x4f,
  camPos: vec4f,           // xyz cells, w seconds
  sunDir: vec4f,           // toward the sun, w its strength
  size: vec4f,             // this pass's target: w, h, 1/w, 1/h
  jitter: vec4f,           // xy: this frame's jitter in NDC
  grid: vec4f,             // nx, ny, nz, -1 (never NONCE)
  post: vec4f,             // exposure, TAA blend, ground pattern layer, fog per cell
}
struct Mat {
  tones: array<vec4f, 4>,  // linear rgb; a cell picks one by a hash of its coordinate
  emit: vec4f,             // linear HDR emission, w: class (0 air 1 opaque 2 liquid 3 translucent 4 gas 5 emissive)
  sigma: vec4f,            // extinction per cell, w: pattern layer
  surf: vec4f,             // roughness, F0, metal, sparkle
}
const SUN = vec3f(1.0, 0.92, 0.8) * 3.2;
const FAR = 60000.0;       // the linear depth of the sky (r16float holds up to 65504)

fn unitAxis(i: u32) -> vec3f { return vec3f(f32(i == 0u), f32(i == 1u), f32(i == 2u)); }
fn dirNormal(d: u32) -> vec3f { return unitAxis(d >> 1u) * select(1.0, -1.0, (d & 1u) == 1u); }
fn dirU(d: u32) -> vec3f { return unitAxis(((d >> 1u) + select(1u, 2u, (d & 1u) == 1u)) % 3u); }
fn hashCell(c: vec3u) -> u32 {
  var h = (c.x * 73856093u) ^ (c.y * 19349663u) ^ (c.z * 83492791u);
  h ^= h >> 13u; h *= 0x5bd1e995u; h ^= h >> 15u;
  return h;
}
// the one sky (docs/v2.md 3.4): a gradient, a ground colour below the horizon, the sun's disc and glow
fn skyRad(d: vec3f) -> vec3f {
  let t = clamp(d.y, -1.0, 1.0);
  let zen = vec3f(0.16, 0.34, 0.78);
  let hor = vec3f(0.6, 0.72, 0.9);
  let gnd = vec3f(0.27, 0.26, 0.24);
  var c = select(mix(hor, gnd, min(-t * 4.0, 1.0)), mix(hor, zen, sqrt(max(t, 0.0))), t >= 0.0);
  let s = max(dot(d, F.sunDir.xyz), 0.0);
  c += SUN * (pow(s, 1500.0) * 30.0 + pow(s, 10.0) * 0.06);
  return c;
}
fn skyIrr(n: vec3f) -> vec3f { return mix(vec3f(0.3, 0.29, 0.27), vec3f(0.42, 0.56, 0.86), n.y * 0.5 + 0.5); }
fn mcCurve(f: vec4f) -> vec4f { return f / (4.0 - 3.0 * f); }   // Minecraft's light curve, f / (4 − 3f)
fn ggx(nh: f32, r: f32) -> f32 { let a2 = r * r * r * r; let d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (3.14159 * d * d); }
fn shadowCoord(world: vec3f) -> vec3f {
  let c = F.sunViewProj * vec4f(world, 1.0);
  return vec3f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5, c.z);
}
fn motionOf(p: vec3f) -> vec2f {
  let c = F.viewProjNoJit * vec4f(p, 1.0);
  let q = F.prevViewProj * vec4f(p, 1.0);
  return (c.xy / c.w - q.xy / q.w) * vec2f(0.5, -0.5);
}
fn nonceHit() -> bool { return F.grid.w == NONCE; }
`;

// group 0 of the shadow, scene and translucent pipelines
const SCENE_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> faces: array<vec2u>;
@group(0) @binding(2) var<storage, read> mats: array<Mat>;
@group(0) @binding(3) var patterns: texture_2d_array<f32>;
@group(0) @binding(4) var patSampler: sampler;
@group(0) @binding(5) var shadowMap: texture_depth_2d;
@group(0) @binding(6) var shadowCmp: sampler_comparison;
@group(0) @binding(7) var lightTex: texture_3d<f32>;
@group(0) @binding(8) var linSampler: sampler;
`;

// a face's vertex: 6 per face (two triangles), the face from vertex_index / 6
const FACE_VERTEX = /* wgsl */ `
struct FaceVert { world: vec3f, uv: vec2f, ao: f32, info: vec4u }
fn faceVertex(vi: u32) -> FaceVert {
  let f = faces[vi / 6u];
  let cell = vec3u(f.x & 255u, (f.x >> 8u) & 255u, (f.x >> 16u) & 255u);
  let dir = (f.x >> 24u) & 7u;
  let axis = dir >> 1u;
  let neg = (dir & 1u) == 1u;
  let n = dirNormal(dir);
  let u = unitAxis((axis + select(1u, 2u, neg)) % 3u);
  let v = unitAxis((axis + select(2u, 1u, neg)) % 3u);
  let ao4 = (f.y >> 8u) & 255u;
  // split the quad along the brighter diagonal (0fps.net's fix for AO anisotropy)
  let flip = (ao4 & 3u) + ((ao4 >> 4u) & 3u) < ((ao4 >> 2u) & 3u) + ((ao4 >> 6u) & 3u);
  let order = select(0x320210u, 0x031321u, flip);
  let k = (order >> ((vi % 6u) * 4u)) & 15u;
  let a = f32(k == 1u || k == 2u);
  let b = f32(k >= 2u);
  var o: FaceVert;
  o.world = vec3f(cell) + select(vec3f(0.0), n, !neg) + u * a + v * b;
  o.uv = vec2f(a, b);
  o.ao = f32((ao4 >> (2u * k)) & 3u);
  o.info = vec4u(f.y & 255u, dir, hashCell(cell), 0u);
  return o;
}
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) ao: f32,
  @location(3) @interpolate(flat) info: vec4u,
  @location(4) shadow: vec3f,
}
@vertex fn vsFace(@builtin(vertex_index) vi: u32) -> VOut {
  let f = faceVertex(vi);
  var o: VOut;
  o.pos = F.viewProj * vec4f(f.world, 1.0);
  o.world = f.world;
  o.uv = f.uv;
  o.ao = f.ao;
  o.info = f.info;
  o.shadow = shadowCoord(f.world + dirNormal(f.info.y) * 0.04);
  return o;
}
`;

const SHADOW = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> faces: array<vec2u>;
@vertex fn vsShadow(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let f = faceVertex(vi);
  var p = F.sunViewProj * vec4f(f.world, 1.0);
  if (nonceHit()) { p.z += 1e-7; }
  return p;
}
`;

const SCENE = /* wgsl */ `
// The material and light functions (docs/v2.md 3.3, 3.4) for one opaque face pixel.
fn shade(world: vec3f, uv: vec2f, ao: f32, info: vec4u, shadow: vec3f) -> vec3f {
  let m = mats[info.x];
  let n0 = dirNormal(info.y);
  let tone = m.tones[info.z & 3u].rgb;
  let pat = textureSample(patterns, patSampler, uv, i32(m.sigma.w));
  let albedo = tone * (0.55 + 0.9 * pat.r);
  let n = normalize(n0 + dirU(info.y) * (pat.g - 0.5) * 0.5);   // pattern.G: a small bend
  let ndl = max(dot(n, F.sunDir.xyz), 0.0);
  let sh = textureSampleCompareLevel(shadowMap, shadowCmp, shadow.xy, shadow.z);
  let lg = mcCurve(textureSampleLevel(lightTex, linSampler, (world + 0.5 * n0) / F.grid.xyz, 0.0));
  let occ = mix(0.35, 1.0, ao / 3.0);
  var L = albedo * (SUN * F.sunDir.w * ndl * sh + (skyIrr(n) * lg.a + lg.rgb * 3.0) * occ);
  L += m.emit.rgb * pat.a;
  let v = normalize(F.camPos.xyz - world);
  let h = normalize(v + F.sunDir.xyz);
  let nh = max(dot(n, h), 0.0);
  let f0 = mix(vec3f(m.surf.y), albedo, m.surf.z);
  L += f0 * ggx(nh, m.surf.x) * ndl * sh * SUN * 0.25;
  L += pat.b * m.surf.w * pow(nh, 64.0) * sh * SUN;   // pattern.B: sparkle, anchored to texels
  let dist = length(world - F.camPos.xyz);
  return mix(skyRad(-v), L, exp(-dist * F.post.w));
}

// The sky and the ground plane (box mode stands on one, docs/v2.md 3.4), as one full-screen triangle.
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.5, 1.0);
}
struct SkyHit { color: vec3f, dist: f32, world: vec3f }
fn skyAt(px: vec2f) -> SkyHit {
  let ndc = vec2f(px.x * F.size.z * 2.0 - 1.0, 1.0 - px.y * F.size.w * 2.0);
  let a = F.invViewProj * vec4f(ndc, 0.0, 1.0);
  let b = F.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = F.camPos.xyz;
  let rd = normalize(b.xyz / b.w - a.xyz / a.w);
  let ground = rd.y < -1e-4 && ro.y > 0.0;
  let t = select(FAR, -ro.y / rd.y, ground);
  let gp = ro + rd * min(t, 1e4);
  let pat = textureSample(patterns, patSampler, gp.xz, i32(F.post.z));
  let inBox = all(gp.xz >= vec2f(0.0)) && all(gp.xz <= F.grid.xz);
  let lg = select(vec4f(0.0, 0.0, 0.0, 1.0),
    mcCurve(textureSampleLevel(lightTex, linSampler, vec3f(gp.x, 0.5, gp.z) / F.grid.xyz, 0.0)), inBox);
  let sh = textureSampleCompareLevel(shadowMap, shadowCmp, shadowCoord(gp + vec3f(0.0, 0.04, 0.0)).xy, shadowCoord(gp).z);
  let albedo = vec3f(0.2, 0.3, 0.12) * (0.55 + 0.9 * pat.r);
  var g = albedo * (SUN * F.sunDir.w * max(F.sunDir.y, 0.0) * sh + skyIrr(vec3f(0.0, 1.0, 0.0)) * lg.a + lg.rgb * 3.0);
  g = mix(skyRad(rd), g, exp(-t * F.post.w));
  var o: SkyHit;
  o.color = select(skyRad(rd), g, ground);
  o.dist = t;
  o.world = select(ro + rd * 1e4, gp, ground);
  return o;
}

struct MsaaOut { @location(0) color: vec4f, @location(1) depth: f32 }
struct TaaOut { @location(0) color: vec4f, @location(1) depth: f32, @location(2) motion: vec2f }

@fragment fn fsSky(@builtin(position) pos: vec4f) -> MsaaOut {
  let s = skyAt(pos.xy);
  var o: MsaaOut;
  o.color = vec4f(s.color, 1.0);
  o.depth = s.dist;
  if (nonceHit()) { o.color.r += 1e-6; }
  return o;
}
@fragment fn fsSkyTaa(@builtin(position) pos: vec4f) -> TaaOut {
  let s = skyAt(pos.xy);
  var o: TaaOut;
  o.color = vec4f(s.color, 1.0);
  o.depth = s.dist;
  o.motion = motionOf(s.world);
  if (nonceHit()) { o.color.r += 1e-6; }
  return o;
}

@fragment fn fsOpaque(in: VOut) -> MsaaOut {
  var o: MsaaOut;
  o.color = vec4f(shade(in.world, in.uv, in.ao, in.info, in.shadow), 1.0);
  o.depth = length(in.world - F.camPos.xyz);
  if (nonceHit()) { o.color.r += 1e-6; }
  return o;
}

// TAAU: the same face, carrying its unjittered clip positions now and last frame for motion
struct VOutTaa {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) ao: f32,
  @location(3) @interpolate(flat) info: vec4u,
  @location(4) shadow: vec3f,
  @location(5) cur: vec4f,
  @location(6) prev: vec4f,
}
@vertex fn vsFaceTaa(@builtin(vertex_index) vi: u32) -> VOutTaa {
  let f = faceVertex(vi);
  var o: VOutTaa;
  o.pos = F.viewProj * vec4f(f.world, 1.0);
  o.world = f.world;
  o.uv = f.uv;
  o.ao = f.ao;
  o.info = f.info;
  o.shadow = shadowCoord(f.world + dirNormal(f.info.y) * 0.04);
  o.cur = F.viewProjNoJit * vec4f(f.world, 1.0);
  o.prev = F.prevViewProj * vec4f(f.world, 1.0);
  return o;
}
@fragment fn fsOpaqueTaa(in: VOutTaa) -> TaaOut {
  var o: TaaOut;
  o.color = vec4f(shade(in.world, in.uv, in.ao, in.info, in.shadow), 1.0);
  o.depth = length(in.world - F.camPos.xyz);
  o.motion = (in.cur.xy / in.cur.w - in.prev.xy / in.prev.w) * vec2f(0.5, -0.5);
  if (nonceHit()) { o.color.r += 1e-6; }
  return o;
}
`;

const TRANS = /* wgsl */ `
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneDepth: texture_2d<f32>;
@group(1) @binding(2) var idVol: texture_3d<u32>;

// Liquid and glass faces at 1× after the resolve (docs/v2.md 3.5): a manual
// depth test against the resolved linear depth; liquids walk the cells to
// what is behind (≤ 16 steps) for RGB Beer–Lambert, refract the resolved
// colour (rejected where that lands on something nearer), and take Fresnel
// against the one sky plus the sun's glint. Output is premultiplied: the
// tone map composites resolved × (1 − a) + rgb.
@fragment fn fsTrans(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let sceneD = textureLoad(sceneDepth, px, 0).r;
  let d = length(in.world - F.camPos.xyz);
  if (d > sceneD + 0.05) { discard; }
  let m = mats[in.info.x];
  let n = dirNormal(in.info.y);
  let v = (in.world - F.camPos.xyz) / d;
  let sh = textureSampleCompareLevel(shadowMap, shadowCmp, in.shadow.xy, in.shadow.z);
  let lg = mcCurve(textureSampleLevel(lightTex, linSampler, (in.world + 0.5 * n) / F.grid.xyz, 0.0));
  let ndl = max(dot(n, F.sunDir.xyz), 0.0);
  let lit = SUN * F.sunDir.w * ndl * sh + skyIrr(n) * lg.a + lg.rgb * 3.0;
  let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, -v), 0.0), 5.0);
  let refl = skyRad(reflect(v, n)) * max(lg.a, 0.1);
  let h = normalize(F.sunDir.xyz - v);
  let glint = SUN * ggx(max(dot(n, h), 0.0), 0.1) * sh * ndl * 0.25;
  let tone = m.tones[in.info.z & 3u].rgb;
  var out: vec4f;
  if (u32(m.emit.w) != 2u) {
    // glass and ice: a thin tinted sheet over what is behind
    let a = 0.08 + 0.6 * fres;
    out = vec4f(tone * lit * 0.08 + refl * fres + glint, a);
  } else {
    let thick = clamp(sceneD - d, 0.0, 48.0);
    let steps = min(16u, u32(ceil(thick)));
    let dt = thick / f32(max(steps, 1u));
    let dims = vec3i(F.grid.xyz);
    var tau = vec3f(0.0);
    var p = in.world + v * (0.5 * dt);
    for (var i = 0u; i < steps; i++) {
      let mm = mats[textureLoad(idVol, clamp(vec3i(floor(p)), vec3i(0), dims - 1), 0).r];
      tau += select(vec3f(0.0), mm.sigma.rgb, u32(mm.emit.w) == 2u) * dt;
      p += v * dt;
    }
    let T = exp(-tau);
    let uv0 = in.pos.xy * F.size.zw;
    let ripple = vec2f(sin(in.world.x * 1.7 + F.camPos.w * 2.0), cos(in.world.z * 1.9 + F.camPos.w * 1.6));
    let uvR = uv0 + ripple * min(thick, 8.0) * 0.75 * F.size.zw;   // up to 6 px
    let dR = textureSampleLevel(sceneDepth, linSampler, uvR, 0.0).r;
    let bg = textureSampleLevel(sceneColor, linSampler, select(uv0, uvR, dR > d), 0.0).rgb;
    var c = bg * T + tone * lit * 0.3 * (vec3f(1.0) - T);
    c = mix(c, refl, fres) + glint;
    out = vec4f(mix(skyRad(v), c, exp(-d * F.post.w)), 1.0);
  }
  if (nonceHit()) { out.a = 0.5; }
  return out;
}
`;

const TONE_FUNCS = /* wgsl */ `
// AgX with Benjamin Wrensch's contrast fit (iolite-engine.com, 2023), the sigmoid today's post uses
// (src/gfx/post.js) without its Rec.2020 wrap and Punchy look
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f) -> vec3f {
  let m = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                  0.0784335999999992, 0.878468636469772, 0.0784336,
                  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                   -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                   -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let lo = -12.47393;
  let hi = 4.026069;
  var v = clamp(log2(max(m * c, vec3f(1e-10))), vec3f(lo), vec3f(hi));
  v = agxContrast((v - lo) / (hi - lo));
  return pow(max(mi * v, vec3f(0.0)), vec3f(2.2));
}
fn toSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.5, 1.0);
}
`;

const TONE = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var transLayer: texture_2d<f32>;
@fragment fn fsTone(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2i(pos.xy);
  let t = textureLoad(transLayer, px, 0);
  let hdr = textureLoad(sceneColor, px, 0).rgb * (1.0 - t.a) + t.rgb;
  var o = vec4f(toSrgb(agx(hdr * F.post.x)), 1.0);
  if (nonceHit()) { o.r = 0.0; }
  return o;
}
`;

const TAA = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var colorLo: texture_2d<f32>;
@group(0) @binding(2) var transLo: texture_2d<f32>;
@group(0) @binding(3) var motionLo: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
@group(0) @binding(5) var linSampler: sampler;
fn composite(c: vec4f, t: vec4f) -> vec3f { return c.rgb * (1.0 - t.a) + t.rgb; }
struct ResolveOut { @location(0) history: vec4f, @location(1) canvas: vec4f }
// TAAU's resolve at the output size: the current (low-resolution, jittered)
// colour where its samples were taken, last frame's history reprojected by
// the motion and clamped to the current 3×3 neighbourhood, blended, kept as
// the next history, and tone mapped to the canvas in the same pass.
@fragment fn fsResolve(@builtin(position) pos: vec4f) -> ResolveOut {
  let uv = pos.xy * F.size.zw;
  let loSize = vec2i(textureDimensions(colorLo));
  let uvc = uv + F.jitter.xy * vec2f(0.5, -0.5);
  let base = clamp(vec2i(uvc * vec2f(loSize)), vec2i(0), loSize - 1);
  var mn = vec3f(1e9);
  var mx = vec3f(-1e9);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = clamp(base + vec2i(i, j), vec2i(0), loSize - 1);
      let c = composite(textureLoad(colorLo, q, 0), textureLoad(transLo, q, 0));
      mn = min(mn, c);
      mx = max(mx, c);
    }
  }
  let cur = composite(textureSampleLevel(colorLo, linSampler, uvc, 0.0), textureSampleLevel(transLo, linSampler, uvc, 0.0));
  let prevUv = uv - textureLoad(motionLo, base, 0).xy;
  let inside = all(prevUv >= vec2f(0.0)) && all(prevUv <= vec2f(1.0));
  let hist = clamp(textureSampleLevel(history, linSampler, prevUv, 0.0).rgb, mn, mx);
  let res = mix(hist, cur, select(1.0, F.post.y, inside));
  var o: ResolveOut;
  o.history = vec4f(res, 1.0);
  o.canvas = vec4f(toSrgb(agx(res * F.post.x)), 1.0);
  if (nonceHit()) { o.canvas.r = 0.0; }
  return o;
}
`;

const LIGHT = /* wgsl */ `
struct LightParams { dims: vec4u, key: vec4f }
struct Mat { tones: array<vec4f, 4>, emit: vec4f, sigma: vec4f, surf: vec4f }
@group(0) @binding(0) var<uniform> P: LightParams;
@group(0) @binding(1) var idVol: texture_3d<u32>;
@group(0) @binding(2) var<storage, read> mats: array<Mat>;
@group(0) @binding(3) var<storage, read> heights: array<u32>;
@group(0) @binding(4) var<storage, read> src: array<u32>;
@group(0) @binding(5) var<storage, read_write> dst: array<u32>;
@group(0) @binding(6) var outTex: texture_storage_3d<rgba8unorm, write>;

// The per-cell sky and block light (docs/v2.md 3.4, Minecraft's model):
// L = max(E, maxₙ(Lₙ − wₙ)) over the 26 neighbours, in 1/16-level units
// (15 levels = 240), costs 16 face, 23 edge, 28 corner, doubled in liquid;
// opaque cells hold 0, emitters their emission, cells above their column's
// highest opaque cell the full sky. 16 Jacobi iterations reach the answer.
const FULL = 240u;
fn cellIndex(c: vec3u) -> u32 { return c.x + P.dims.x * (c.y + P.dims.y * c.z); }
fn unpack(v: u32) -> vec4u { return vec4u(v & 255u, (v >> 8u) & 255u, (v >> 16u) & 255u, v >> 24u); }
fn pack(v: vec4u) -> u32 { return v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u); }
fn source(c: vec3u, m: Mat) -> vec4u {
  let k = u32(m.emit.w);
  if (k == 5u) { return vec4u(min(vec3u(m.emit.rgb * 60.0), vec3u(FULL)), 0u); }
  if (k != 1u && c.y >= heights[c.x + P.dims.x * c.z]) { return vec4u(0u, 0u, 0u, FULL); }
  return vec4u(0u);
}
@compute @workgroup_size(4, 4, 4) fn lightInit(@builtin(global_invocation_id) g: vec3u) {
  if (any(g >= P.dims.xyz)) { return; }
  var l = source(g, mats[textureLoad(idVol, g, 0).r]);
  if (P.key.x == NONCE) { l.x = 1u; }
  dst[cellIndex(g)] = pack(l);
}
@compute @workgroup_size(4, 4, 4) fn lightStep(@builtin(global_invocation_id) g: vec3u) {
  if (any(g >= P.dims.xyz)) { return; }
  let m = mats[textureLoad(idVol, g, 0).r];
  let k = u32(m.emit.w);
  var l = source(g, m);
  if (k != 1u && k != 5u) {
    let scale = select(1u, 2u, k == 2u);
    let c = vec3i(g);
    for (var dz = -1; dz <= 1; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let n = abs(dx) + abs(dy) + abs(dz);
          if (n == 0) { continue; }
          let w = vec4u(select(select(28u, 23u, n == 2), 16u, n == 1) * scale);
          let q = c + vec3i(dx, dy, dz);
          var v = vec4u(0u);
          if (any(q < vec3i(0)) || any(q >= vec3i(P.dims.xyz))) {
            // outside the box: open sky above the ground
            v = select(vec4u(0u), vec4u(0u, 0u, 0u, FULL), q.y >= 0);
          } else {
            v = unpack(src[cellIndex(vec3u(q))]);
          }
          l = max(l, max(v, w) - w);
        }
      }
    }
  }
  if (P.key.x == NONCE) { l.x = 1u; }
  dst[cellIndex(g)] = pack(l);
}
@compute @workgroup_size(4, 4, 4) fn lightStore(@builtin(global_invocation_id) g: vec3u) {
  if (any(g >= P.dims.xyz)) { return; }
  var v = vec4f(unpack(src[cellIndex(g)])) / f32(FULL);
  if (P.key.x == NONCE) { v.x = 0.0; }
  textureStore(outTex, g, v);
}
`;

/** The modules' sources for one nonce. */
export function shaderSources(nonce) {
  const head = `const NONCE: f32 = ${nonce.toFixed(9)};\n`;
  return {
    shadow: head + COMMON + SHADOW_FACE + SHADOW,
    scene: head + COMMON + SCENE_BINDINGS + FACE_VERTEX + SCENE,
    trans: head + COMMON + SCENE_BINDINGS + FACE_VERTEX + TRANS,
    tone: head + COMMON_POST + TONE_FUNCS + TONE,
    taa: head + COMMON_POST + TONE_FUNCS + TAA,
    light: head + LIGHT,
  };
}

// The shadow module binds only the frame and the faces (the shadow map is its target).
const SHADOW_FACE = FACE_VERTEX.replace(/struct VOut[\s\S]*$/, '');
// The post modules need the Frame struct, not the scene's helpers.
const COMMON_POST = COMMON.replace(/const SUN[\s\S]*$/, 'fn nonceHit() -> bool { return F.grid.w == NONCE; }\n');
