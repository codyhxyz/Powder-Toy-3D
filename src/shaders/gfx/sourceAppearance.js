import { APPEARANCE_TRIANGLE_WORDS, APPEARANCE_MATERIAL_WORDS, APPEARANCE_LIGHT_WORDS,
  APPEARANCE_FLAGS as F, APPEARANCE_MODES as M, APPEARANCE_HEADER as H, APPEARANCE_ENVIRONMENT as E } from '../../world/import/appearanceFormat.js';

// Renderer adapter for the versioned importer ABI, shared by the live volume
// and distant cell meshes. No appearance is inferred from an element name.
export const sourceAppearanceWGSL = (far = true) => /* wgsl */ `
fn sourceEnabled() -> bool { return ${far ? 'FU.sourceStyle != 0u && FU.sourceAppearance.y >= 64u' : 'false'}; }
fn sourceWord(i: u32) -> u32 {
  ${far ? `if (i >= FU.sourceAppearance.y) { return 0u; }
  let t = i / 2u;
  let x = FU.sourceAppearance.z;
  let z = FU.sourceAppearance.w;
  let p = vec3u(t % x, FU.sourceAppearance.x + t / (x * z), (t / x) % z);
  let v = textureLoad(tFarGrid, vec3i(p), 0);
  return select(v.x | (v.y << 16u), v.z | (v.w << 16u), (i & 1u) != 0u);` : 'return 0u;'}
}
fn sourceFloat(i: u32) -> f32 { return bitcast<f32>(sourceWord(i)); }
fn sourceVec4(i: u32) -> vec4f {
  return vec4f(sourceFloat(i), sourceFloat(i + 1u), sourceFloat(i + 2u), sourceFloat(i + 3u));
}
fn sourceLinear(c: vec3f) -> vec3f {
  return select(c / 12.92, pow(max((c + 0.055) / 1.055, vec3f(0.0)), vec3f(2.4)), c > vec3f(0.04045));
}
fn sourcePixel(at: u32, size: vec2u, p0: vec2i, flags: u32) -> vec4f {
  var p = clamp(p0, vec2i(0), vec2i(size) - 1);
  if ((flags & ${F.repeat}u) != 0u) { p = ((p0 % vec2i(size)) + vec2i(size)) % vec2i(size); }
  let v = sourceWord(at + u32(p.x) + size.x * u32(p.y));
  var c = vec4f(f32(v & 255u), f32((v >> 8u) & 255u), f32((v >> 16u) & 255u), f32(v >> 24u)) / 255.0;
  if ((flags & ${F.srgb}u) != 0u) { c = vec4f(sourceLinear(c.rgb), c.a); }
  return c;
}
fn sourceTexture(at: u32, size: vec2u, uv: vec2f, flags: u32) -> vec4f {
  if (at == 0u || any(size == vec2u(0))) { return vec4f(1.0); }
  let q = uv * vec2f(size);
  if ((flags & ${F.filter}u) == 0u) { return sourcePixel(at, size, vec2i(floor(q)), flags); }
  let p = vec2i(floor(q - 0.5));
  let f = fract(q - 0.5);
  return mix(mix(sourcePixel(at, size, p, flags), sourcePixel(at, size, p + vec2i(1, 0), flags), f.x),
    mix(sourcePixel(at, size, p + vec2i(0, 1), flags), sourcePixel(at, size, p + vec2i(1), flags), f.x), f.y);
}
struct SourceMaterial {
  albedo: vec3f, alpha: f32, normal: vec3f, kind: u32,
  emission: vec3f, roughness: f32, metallic: f32, f0: f32, flags: u32,
}
fn sourceMaterial(id: i32, p: vec3f, n: vec3f) -> SourceMaterial {
  var result: SourceMaterial;
  if (!sourceEnabled()) { return result; }
  let dims = vec3u(sourceWord(${H.brickDims}u), sourceWord(${H.brickDims + 1}u), sourceWord(${H.brickDims + 2}u));
  let directory = sourceWord(${H.directoryAt}u);
  let triangles = sourceWord(${H.trianglesAt}u);
  let materials = sourceWord(${H.materialsAt}u);
  var best = 1.5;
  var chosen = 0u;
  var found = false;
  var previousBrick = 0xffffffffu;
  // Surface nets can move a voxel face to either side of its authored plane.
  // Inspect that face's two adjacent bricks as well as the hit's own brick.
  for (var side = -1; side <= 1; side++) {
    let b = vec3i(floor((p + n * f32(side) * 0.75) / 8.0));
    if (any(b < vec3i(0)) || any(b >= vec3i(dims))) { continue; }
    let k = u32(b.x) + dims.x * (u32(b.y) + dims.y * u32(b.z));
    if (k == previousBrick) { continue; }
    previousBrick = k;
    let list = sourceWord(directory + k);
    if (list == 0u) { continue; }
    let count = sourceWord(list);
    for (var j = 0u; j < count; j++) {
      let t = triangles + sourceWord(list + 1u + j) * ${APPEARANCE_TRIANGLE_WORDS}u;
      let m = materials + sourceWord(t + 3u) * ${APPEARANCE_MATERIAL_WORDS}u;
      if (sourceWord(m + 15u) != u32(id)) { continue; }
      let plane = sourceVec4(t + 12u);
      let alignment = abs(dot(plane.xyz, n));
      let distance = abs(dot(plane.xyz, p) - plane.w);
      if (alignment < 0.45 || distance > 1.05) { continue; }
      let bu = sourceVec4(t + 16u);
      let bv = sourceVec4(t + 20u);
      let u = dot(bu.xyz, p) + bu.w;
      let v = dot(bv.xyz, p) + bv.w;
      if (u < -length(bu.xyz) * 0.75 || v < -length(bv.xyz) * 0.75 || u + v > 1.0 + length(bu.xyz + bv.xyz) * 0.75) { continue; }
      let score = distance + (1.0 - alignment) * 0.25;
      if (score <= best) { best = score; chosen = t; found = true; }
    }
  }
  if (!found) { return result; }
  let m = materials + sourceWord(chosen + 3u) * ${APPEARANCE_MATERIAL_WORDS}u;
  let gu = sourceVec4(chosen + 4u);
  let gv = sourceVec4(chosen + 8u);
  var uv = vec2f(dot(gu.xyz, p) + gu.w, dot(gv.xyz, p) + gv.w);
  let mode = sourceWord(m + 19u);
  // Literal fragment-coordinate transforms from the audited source shaders.
  if (mode == ${M.water}u) {
    uv *= vec2f(cos(uv.y * 10.0 + FU.time) * 0.01 + 1.0, sin(uv.x * 10.0 + FU.time) * 0.02 + 1.0);
  } else if (mode == ${M.flesh}u) {
    uv *= clamp(vec2f(cos(uv.y * 10.0 + tan(FU.time * 5.0)), sin(uv.x * 10.0 + tan(FU.time * 5.0))) * 0.0005 + 1.0, vec2f(1.0), vec2f(1.5));
  } else if (mode == ${M.swampWater}u) {
    uv *= vec2f(cos(10.0 + FU.time * 0.5) * 0.0025 + 1.0, sin(10.0 + FU.time * 0.5) * 0.005 + 1.0);
  } else if (mode == ${M.scroll}u) { uv = uv * 2.0 - vec2f(0.0, FU.time * 0.2); }
  let flags = sourceWord(m + 3u);
  let size = vec2u(sourceWord(m + 1u), sourceWord(m + 2u));
  let frames = max(sourceWord(m + 16u), 1u);
  let frame = u32(max(floor(FU.time * sourceFloat(m + 17u)), 0.0)) % frames;
  let texel = sourceTexture(sourceWord(m) + frame * sourceWord(m + 18u), size, uv, flags);
  let tint = sourceVec4(m + 4u);
  result.albedo = texel.rgb * sourceLinear(tint.rgb);
  result.alpha = texel.a * tint.a;
  if (mode == ${M.water}u) { result.alpha = clamp((result.albedo.g + result.albedo.r) * 2.0, 0.0, 1.0); }
  let plane = sourceVec4(chosen + 12u);
  result.normal = plane.xyz * select(-1.0, 1.0, dot(plane.xyz, n) >= 0.0);
  result.emission = sourceLinear(sourceVec4(m + 8u).rgb) * sourceFloat(m + 11u);
  result.roughness = sourceFloat(m + 12u);
  result.metallic = sourceFloat(m + 13u);
  if (sourceWord(m + 22u) != 0u) {
    let r = sourceTexture(sourceWord(m + 22u), vec2u(sourceWord(m + 23u), sourceWord(m + 24u)), uv, flags & ~${F.srgb}u);
    let channel = sourceWord(m + 25u);
    result.roughness *= select(r[min(channel, 3u)], dot(r.rgb, vec3f(0.33333333)), channel == 4u);
  }
  if (sourceWord(m + 26u) != 0u) {
    let r = sourceTexture(sourceWord(m + 26u), vec2u(sourceWord(m + 27u), sourceWord(m + 28u)), uv, flags & ~${F.srgb}u);
    let channel = sourceWord(m + 29u);
    result.metallic *= select(r[min(channel, 3u)], dot(r.rgb, vec3f(0.33333333)), channel == 4u);
  }
  result.f0 = 0.16 * pow(sourceFloat(m + 14u), 2.0); // Godot 3 SpatialMaterial specular -> F0
  result.kind = select(1u, 2u, (flags & ${F.unshaded}u) != 0u);
  result.flags = flags;
  return result;
}
// Godot SpatialMaterial blend enum. In particular, the original green panes
// SUBTRACT green from the room; replacing this with green tint is incorrect.
fn sourceBlend(rgb: vec3f, alpha: f32, flags: u32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let blend = (flags >> ${F.blendShift}u) & 7u;
  if (blend == 2u) { *col -= *trans * rgb * alpha; }
  else if (blend == 1u) { *col += *trans * rgb * alpha; }
  else if (blend == 3u) { *trans *= mix(vec3f(1.0), rgb, alpha); }
  else {
    *col += *trans * rgb * select(alpha, 1.0, blend == 4u);
    *trans *= 1.0 - alpha;
  }
}
fn sourceEnvironment() -> u32 { return sourceWord(${H.environmentAt}u); }
fn sourceFog(col: vec3f, distance: f32) -> vec3f {
  let e = sourceEnvironment();
  if (sourceWord(e + ${E.fogEnabled}u) == 0u || sourceWord(e + ${E.fogDepthEnabled}u) == 0u) { return col; }
  let start = sourceFloat(e + ${E.fogBegin}u);
  let end = sourceFloat(e + ${E.fogEnd}u);
  let weight = pow(clamp((distance - start) / max(end - start, 0.001), 0.0, 1.0), sourceFloat(e + ${E.fogCurve}u));
  return mix(col, sourceLinear(sourceVec4(e + ${E.fog}u).rgb), weight);
}
fn sourceSky(d0: vec3f) -> vec3f {
  let e = sourceEnvironment();
  let at = sourceWord(e + ${E.panoramaAt}u);
  if (at == 0u) { return vec3f(0.0); }
  let basis = mat3x3f(sourceVec4(e + ${E.orientation}u).xyz,
    sourceVec4(e + ${E.orientation + 3}u).xyz, sourceVec4(e + ${E.orientation + 6}u).xyz);
  // Levels/sky_rotator.gd: the misleading 'z' flag selects X, otherwise Y.
  let angle = FU.time * sourceFloat(e + ${E.rotationSpeed}u);
  let c = cos(angle); let s = sin(angle);
  var d = d0;
  if (sourceWord(e + ${E.rotationAxis}u) == 1u) { d = vec3f(d.x, c * d.y + s * d.z, -s * d.y + c * d.z); }
  else { d = vec3f(c * d.x - s * d.z, d.y, s * d.x + c * d.z); }
  d = transpose(basis) * d;
  let uv = vec2f(atan2(d.x, -d.z) / 6.28318530718 + 0.5, acos(clamp(d.y, -1.0, 1.0)) / 3.14159265359);
  return sourceTexture(at, vec2u(sourceWord(e + ${E.panoramaWidth}u), sourceWord(e + ${E.panoramaHeight}u)), uv,
    ${F.repeat | F.filter | F.srgb}u).rgb * sourceFloat(e + ${E.backgroundEnergy}u);
}
`;

// Godot 3.5's scene.glsl light_compute diffuse modes (MIT), translated to
// WGSL. https://github.com/godotengine/godot/blob/3.5/drivers/gles3/shaders/scene.glsl
// The existing GGX helper supplies specular, not a new engine implementation.
export const sourceShadeWGSL = /* wgsl */ `
fn sourceDiffuse(alb: vec3f, n: vec3f, l: vec3f, v: vec3f, rough: f32, mode: u32) -> vec3f {
  let nl = dot(n, l); let nv = dot(n, v);
  let cl = max(nl, 0.0); let cv = max(nv, 0.0);
  if (mode == 1u) { return alb * cl; }
  if (mode == 2u) { return alb * max(0.0, (nl + rough) / pow(1.0 + rough, 2.0)); }
  if (mode == 4u) { return alb * smoothstep(-rough, max(rough, 0.01), nl); }
  if (mode == 3u) {
    let s = dot(l, v) - nl * nv;
    let t = select(1.0, max(max(nl, nv), 0.0001), s >= 0.0);
    let sigma = rough * rough;
    let a = vec3f(1.0) + sigma * (-0.5 / (sigma + 0.33) + 0.17 * alb / (sigma + 0.13));
    let b = 0.45 * sigma / (sigma + 0.09);
    return alb * cl * (a + b * s / t);
  }
  let halfVector = normalize(l + v + vec3f(0.0000001));
  let lh = max(dot(l, halfVector), 0.0);
  let fd90minus1 = 2.0 * lh * lh * rough - 0.5;
  return alb * cl * (1.0 + fd90minus1 * pow(1.0 - cv, 5.0)) * (1.0 + fd90minus1 * pow(1.0 - cl, 5.0));
}
fn sourceShade(p: vec3f, n: vec3f, rd: vec3f, alb: vec3f, rough: f32, metal: f32, f0: f32, kind: u32, flags: u32) -> vec3f {
  if (kind == 2u) { return alb; }
  let env = sourceEnvironment();
  let ambient = sourceLinear(sourceVec4(env).rgb) * sourceFloat(env + ${E.ambientEnergy}u);
  let view = -rd;
  let nv = max(dot(n, view), 0.001);
  let F0 = mix(vec3f(f0), alb, metal);
  let diffuse = alb * (1.0 - metal);
  var result = diffuse * ambient;
  let lights = sourceWord(${H.lightsAt}u);
  let count = sourceWord(${H.lightCount}u);
  for (var i = 0u; i < count; i++) {
    let a = lights + i * ${APPEARANCE_LIGHT_WORDS}u;
    let lightType = sourceWord(a + 3u);
    let color = sourceLinear(sourceVec4(a + 4u).rgb) * sourceFloat(a + 7u);
    var direction = -sourceVec4(a + 8u).xyz;
    var power = 1.0;
    if (lightType != 1u) {
      let dv = sourceVec4(a).xyz - p;
      let distance = length(dv);
      let range = sourceFloat(a + 11u);
      if (distance >= range || distance <= 0.0001) { continue; }
      direction = dv / distance;
      power = pow(max(1.0 - distance / range, 0.0), sourceFloat(a + 12u));
      if (lightType == 2u) {
        let edge = cos(sourceFloat(a + 13u) * 0.01745329252);
        let spot = max(dot(-direction, sourceVec4(a + 8u).xyz), 0.0);
        power *= 1.0 - pow(clamp((1.0 - spot) / max(1.0 - edge, 0.001), 0.0, 1.0), sourceFloat(a + 14u));
      }
    }
    let nl = max(dot(n, direction), 0.0);
    var spec = vec3f(0.0);
    let specularMode = (flags >> ${F.specularShift}u) & 7u;
    if (rough > 0.0) {
      if (specularMode == 0u) { spec = ggxSpec(n, view, direction, max(rough, 0.04), F0) * nl * 3.14159265359; }
      else if (specularMode == 1u || specularMode == 2u) {
        let shine = exp2(15.0 * (1.0 - rough) + 1.0) * 0.25;
        let halfVector = normalize(view + direction + vec3f(0.0000001));
        let cosine = select(max(dot(n, halfVector), 0.0), max(dot(-reflect(direction, n), view), 0.0), specularMode == 2u);
        spec = alb * sqrt(max(f0 / 0.16, 0.0)) * pow(cosine, shine) * (shine + select(2.0, 1.0, specularMode == 2u)) / 8.0;
      } else if (specularMode == 3u) {
        let mid = pow(1.0 - rough, 2.0);
        spec = vec3f(smoothstep(mid - rough * 0.5, mid + rough * 0.5, dot(-reflect(direction, n), view)) * mid);
      }
    }
    result += color * power * (sourceDiffuse(diffuse, n, direction, view, rough, (flags >> ${F.diffuseShift}u) & 7u) + spec);
  }
  return result;
}
`;
