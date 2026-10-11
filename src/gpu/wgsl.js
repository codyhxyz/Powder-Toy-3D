// WGSL snippets every family shares that aren't the simulation's (docs/webgpu.md
// B1): GLSL's mod, luminance, and the full-screen triangle image passes draw.
// The sim's helpers (u32ToF32, pcg, the layout functions) live in the prelude,
// src/shaders/common.js.
//
// Each export is WGSL text to paste into a module once. WGSL has no overloads,
// so a GLSL function used on several types gets a type suffix (H1.12).

/**
 * GLSL's mod, x − y·floor(x/y): WGSL's float `%` truncates instead (H1.2), so
 * with a negative argument the two differ. Use these wherever the GLSL had
 * mod(). glslMod2/3/4 take a vector divisor: `glslMod3(p, vec3f(s))` for a scalar one.
 */
export const glslMod = /* wgsl */ `
fn glslMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn glslMod2(x: vec2f, y: vec2f) -> vec2f { return x - y * floor(x / y); }
fn glslMod3(x: vec3f, y: vec3f) -> vec3f { return x - y * floor(x / y); }
fn glslMod4(x: vec4f, y: vec4f) -> vec4f { return x - y * floor(x / y); }
`;

/**
 * Empty on purpose: saturate(x) = clamp(x, 0, 1) is a WGSL builtin (Tint in
 * Chrome 141 and Safari 26 have it), so ported code calls it directly. The
 * export stays so a module can list it with the others without a special case.
 */
export const saturate = '';

/** Rec.709 luminance of linear sRGB (post.js LUMA_709, lighting.js LUMA). */
export const luma = /* wgsl */ `
const LUMA_709: vec3f = vec3f(0.2126, 0.7152, 0.0722);
fn luma(c: vec3f) -> f32 { return dot(c, LUMA_709); }
`;

/**
 * The full-screen triangle: a vertex entry `entry` (default `vs`) that needs
 * no vertex buffer (draw 3 vertices), and the `FullScreen` struct it passes
 * on. `uv` follows WebGPU's top-left convention (F4): uv = (pixel + 0.5) / size,
 * so uv.y = 0.5 − 0.5·ndc.y, and textureSampleLevel(t, s, in.uv, 0.0) reads the
 * texel under the pixel.
 * @param {string} [entry]
 * @returns {string}
 */
export const fullscreenVert = (entry = 'vs') => /* wgsl */ `
struct FullScreen {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn ${entry}(@builtin(vertex_index) i: u32) -> FullScreen {
  // (-1, -1), (3, -1), (-1, 3): one triangle covering the screen
  let ndc = vec2f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1));
  var out: FullScreen;
  out.position = vec4f(ndc, 0.0, 1.0);
  out.uv = vec2f(0.5 + 0.5 * ndc.x, 0.5 - 0.5 * ndc.y);
  return out;
}
`;
