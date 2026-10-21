// The scene's own overlays (docs/webgpu.md F1, W1): the floor grid under a
// box (or across a world's footprint) and the box's edges, small pipelines of
// ours drawn in the scene pass, so a box-mode frame needs nothing from three.js.
// They keep the WebGL build's look and order: the grid before the volume
// (depth-tested, writing no depth: the volume's march stops at the depth the
// meshes leave, gfx/meshCut.js, and the grid isn't one), the edges after it
// (depth-tested and written, as three's lines did). Lines are one rendered
// pixel wide, as GL's were: under TAAU that is 1/scale output pixels, so the
// caller fades them by the render scale to keep their weight (app.js did).
// Colours are three's for the same hex values (sRGB → linear), blended
// premultiplied over the scene target.
//
// In the realistic view a box stands under the sky that lights it (drawSky,
// first): the clear sky of gfx/sky.js with the sun's (or moon's) disc, the open
// ground below the horizon, as a world's far view draws it (shaders/far.js
// farSky), so what water, glass and metal mirror is what is on screen; the
// grid's lines are then the floor's own seams continued over that ground.
//
//   const overlays = createOverlays(gpu);
//   draw(rp) { overlays.drawSky(rp); overlays.drawGrid(rp, { model, opacity, lit }); volume.draw(rp, …); overlays.drawEdges(rp, { size, opacity }); }
import { Color } from 'three/webgpu';
import { frameBindings, RENDER_LAYOUT } from '../shaders/bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { frameUniformsOf } from './uniforms.js';
import { SCENE_FORMATS } from '../shaders/render.js';
import { SKY, skyGLSL, skyViewGLSL, SUN_TAN_RADIUS, SUN_DISC, SUN_DISC_EDGE, glf } from './sky.js';
import { LOOK } from './materials.js';
import { E } from '../elements.js';
import { EDGE_SEA_SAMPLES, EDGE_SEA_VEC4 } from './edgeSea.js';

// The floor grid: three's GridHelper(FLOOR_SPAN, FLOOR_SPAN, …), a line every
// scene unit, the centre lines brighter; a world's is stretched over its footprint.
export const FLOOR_SPAN = 80;
export const FLOOR_Y = -0.002;   // scene units: just under the box's floor
export const FLOOR_COLOR_CENTER = 0x2b3240;
export const FLOOR_COLOR_LINE = 0x1b2029;
// The box's edges.
export const EDGE_COLOR = 0x56607a;
export const EDGE_OPACITY = 0.55;
// Under the daylight sky (drawSky) a pale line vanishes against the sunlit
// ground, so the edges are dark ink there, as Minecraft draws its block outline
// (black, 0.4 alpha). Heavier than its 0.4: ours are one scene pixel wide and
// fade with the render scale, Minecraft's are 2 screen pixels.
export const EDGE_LIT_COLOR = 0x000000;
export const EDGE_LIT_OPACITY = 0.7;

const linear = (hex) => new Color(hex).toArray();   // three's colour management: sRGB hex → linear

export const GridParams = uniformStruct('GridParams', {
  model: 'mat4x4f',     // grid units → scene (GridHelper's position and scale)
  center: 'vec4f',      // linear rgb, opacity
  line: 'vec4f',
  half: 'f32',          // half the span, grid units
  step: 'f32',          // between lines
  divisions: 'u32',
  lit: 'u32',           // 1: under the sky (drawSky): the floor's seams over the open ground, not three's colours
});
export const EdgeParams = uniformStruct('EdgeParams', {
  color: 'vec4f',       // linear rgb, opacity
  size: 'vec3f',        // the box, grid cells (FrameUniforms.model places it)
});

// The sea past a world's edge (gfx/edgeSea.js), in the sky pass: its
// surface, the world's footprint, and the edge stretches its water reaches.
export const SkyParams = uniformStruct('SkyParams', {
  foot: 'vec4f',        // the world's footprint, grid cells (FrameUniforms' grid: a World's window): x0, z0, x1, z1
  seaY: 'f32',          // the sea's surface, grid cells
  sea: 'u32',           // 1: draw the sea past the edge where the mask says
  mask: `array<vec4u, ${EDGE_SEA_VEC4}>`,   // edgeSeaMask's words
});
// Water's own look (gfx/materials.js LOOK): its reflectance face on, from its
// index of refraction ((n - 1) / (n + 1))², and its single-scattering albedo,
// the light its body sends back.
const WATER_LOOK = LOOK[E.WATER];
const SEA_F0 = ((WATER_LOOK.ior - 1) / (WATER_LOOK.ior + 1)) ** 2;

const LINES_WGSL = /* wgsl */ `
${frameBindings()}
struct LineOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,   // premultiplied
}
@fragment fn fs(v: LineOut) -> @location(0) vec4f { return v.color; }`;

export const gridWGSL = () => /* wgsl */ `
${LINES_WGSL}
// the floor's seams over the open ground (FLOOR_LINE_ALB / GROUND_ALB, gfx/sky.js)
const FLOOR_SEAM: vec3f = vec3f(${SKY.floorLineAlb.map((a, k) => glf(+(a / SKY.groundAlb[k]).toFixed(4))).join(', ')});
${GridParams.wgsl}
@group(3) @binding(1) var<uniform> P: GridParams;
// GridHelper's vertices: for each i in 0..divisions, a line along x at
// z = k and one along z at x = k (k = -half + i·step); the middle i is the
// centre colour.
@vertex fn vs(@builtin(vertex_index) i: u32) -> LineOut {
  let line = i / 4u;
  let e = i & 3u;
  let k = -P.half + f32(line) * P.step;
  var p = vec3f(k, 0.0, select(-P.half, P.half, e == 3u));
  if (e < 2u) { p = vec3f(select(-P.half, P.half, e == 1u), 0.0, k); }
  var c = P.line;
  if (line == P.divisions / 2u) { c = P.center; }
  if (P.lit != 0u) { c = vec4f(FU.ground * FLOOR_SEAM, c.a); }
  var o: LineOut;
  o.position = FU.viewProj * P.model * vec4f(p, 1.0);
  o.color = vec4f(c.rgb * c.a, c.a);
  return o;
}`;

// The box's backdrop: the sky toward the pixel's ray, the ground below the
// horizon (skyColor), and the key light's disc, opaque, under everything.
// In a world, the sea continues past the edge where the world's water reaches
// it (gfx/edgeSea.js).
export const skyWGSL = () => /* wgsl */ `
${frameBindings()}
${SkyParams.wgsl}
@group(3) @binding(1) var<uniform> P: SkyParams;
const PI_L: f32 = 3.14159265;
${skyGLSL()}
${skyViewGLSL()}
const SUN_TAN_RADIUS: f32 = ${glf(SUN_TAN_RADIUS)};
const SKY_SUN_DISC: f32 = ${glf(SUN_DISC)};
const SKY_SUN_DISC_EDGE: f32 = ${glf(SUN_DISC_EDGE)};
const SKY_RAY_Z: f32 = 0.5;   // clip depth of the second point the pixel's ray is taken through (the first is on the near plane)
const EDGE_SEA_SAMPLES: u32 = ${EDGE_SEA_SAMPLES}u;
const SEA_F0: f32 = ${glf(+SEA_F0.toFixed(4))};
const SEA_BODY: vec3f = vec3f(${WATER_LOOK.scatAlb.map(glf).join(', ')});
// Whether the edge point nearest grid point h, which lies outside the
// footprint, is one the world's sea reaches: the mask bit of the side h is
// furthest past, at h's place along it (gfx/edgeSea.js edgeSeaIndex, its JS twin).
fn edgeSea(h: vec2f) -> bool {
  let lo = P.foot.xy;
  let hi = P.foot.zw;
  let past = max(lo - h, h - hi);
  var side = select(1u, 3u, h.x < lo.x);
  var u = (h.y - lo.y) / (hi.y - lo.y);
  if (past.y >= past.x) { side = select(2u, 0u, h.y < lo.y); u = (h.x - lo.x) / (hi.x - lo.x); }
  let i = side * EDGE_SEA_SAMPLES + min(u32(clamp(u, 0.0, 1.0) * f32(EDGE_SEA_SAMPLES)), EDGE_SEA_SAMPLES - 1u);
  let w = i >> 5u;
  return ((P.mask[w >> 2u][w & 3u] >> (i & 31u)) & 1u) != 0u;
}
// The open sea toward unit d (going down). It mirrors the sky by Fresnel
// (Schlick), and its body is lit by the sky, as the far field's sea was
// (shaders/farShared.js farSea).
fn seaColor(d: vec3f) -> vec3f {
  let F = SEA_F0 + (1.0 - SEA_F0) * pow(1.0 - clamp(-d.y, 0.0, 1.0), 5.0);
  return F * skyColor(reflect(d, vec3f(0.0, 1.0, 0.0))) + (1.0 - F) * SEA_BODY * FU.skyUp;
}
struct SkyOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyOut {
  let ndc = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;   // a full-screen triangle
  var o: SkyOut;
  o.position = vec4f(ndc, 1.0, 1.0);
  o.ndc = ndc;
  return o;
}
@fragment fn fs(v: SkyOut) -> @location(0) vec4f {
  let a = FU.invViewProj * vec4f(v.ndc, 0.0, 1.0);
  let b = FU.invViewProj * vec4f(v.ndc, SKY_RAY_Z, 1.0);
  let rd = normalize(b.xyz / b.w - a.xyz / a.w);
  let r = SUN_TAN_RADIUS;
  let disc = smoothstep(cos(r * (1.0 + SKY_SUN_DISC_EDGE)), cos(r * (1.0 - SKY_SUN_DISC_EDGE)), dot(rd, FU.sun));
  var c = skyColor(rd) + disc * FU.sunCol * SKY_SUN_DISC * step(0.0, rd.y);
  // The sea past the edge, where the ray meets its surface outside the
  // footprint. The eye is FrameUniforms' cam (grid cells), and the ray keeps
  // its direction in the grid: FrameUniforms.model is a uniform scale and an
  // offset (app.js volume).
  if (P.sea != 0u && rd.y < 0.0) {
    let t = (P.seaY - FU.cam.y) / rd.y;
    let h = FU.cam.xz + rd.xz * t;
    if (t > 0.0 && (any(h < P.foot.xy) || any(h > P.foot.zw)) && edgeSea(h)) { c = seaColor(rd); }
  }
  return vec4f(c, 1.0);
}`;

export const edgesWGSL = () => /* wgsl */ `
${LINES_WGSL}
${EdgeParams.wgsl}
@group(3) @binding(1) var<uniform> P: EdgeParams;
// The box's 12 edges, two vertices each: edge e runs along axis e / 4 at the
// corner (e & 1, e >> 1 & 1) of the other two axes.
@vertex fn vs(@builtin(vertex_index) i: u32) -> LineOut {
  let e = i / 2u;
  let axis = e / 4u;
  let k = e & 3u;
  var c = vec3f(0.0);
  c[axis] = f32(i & 1u);
  c[(axis + 1u) % 3u] = f32(k & 1u);
  c[(axis + 2u) % 3u] = f32(k >> 1u);
  var o: LineOut;
  o.position = FU.viewProj * FU.model * vec4f(c * P.size, 1.0);
  o.color = vec4f(P.color.rgb * P.color.a, P.color.a);
  return o;
}`;
export const GRID_VERTICES = (divisions) => (divisions + 1) * 4;
export const EDGE_VERTICES = 24;

// premultiplied colour over what is there
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const lines = (depthWriteEnabled) => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] },
  primitive: { topology: 'line-list' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled, depthCompare: 'less-equal' },
});
const LAYOUTS = () => [RENDER_LAYOUT.FRAME];
// Drawn after opaque meshes: far-plane sky must not overwrite their colors.
const SKY_PIPE = {
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color }] },
  primitive: { topology: 'triangle-list' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'less-equal' },
};

/** tools/check-wgsl.mjs (and the menu's warm-up, B5) */
export const WGSL_CHECK = [
  { name: 'floorGrid', kind: 'render', grids: false, code: gridWGSL, layouts: LAYOUTS, layoutNames: ['FRAME'], params: GridParams, ...lines(false) },
  { name: 'boxEdges', kind: 'render', grids: false, code: edgesWGSL, layouts: LAYOUTS, layoutNames: ['FRAME'], params: EdgeParams, ...lines(true) },
  { name: 'boxSky', kind: 'render', grids: false, code: skyWGSL, layouts: LAYOUTS, layoutNames: ['FRAME'], params: SkyParams, ...SKY_PIPE },
];

/**
 * The floor grid and the box's edges on `gpu` (built at once: boot draws them).
 * @param {object} gpu
 */
export function createOverlays(gpu) {
  const fu = frameUniformsOf(gpu);
  const pipe = (e) => gpu.renderPipeline({
    name: e.name, code: e.code(), layouts: [fu.layout], params: e.params,
    vertex: e.vertex, fragment: e.fragment, primitive: e.primitive, depthStencil: e.depthStencil,
  });
  const [grid, edges, sky] = WGSL_CHECK.map(pipe);
  const center = linear(FLOOR_COLOR_CENTER), line = linear(FLOOR_COLOR_LINE), edge = linear(EDGE_COLOR), edgeLit = linear(EDGE_LIT_COLOR);
  return {
    ready: Promise.all([grid.ready, edges.ready, sky.ready]),
    /**
     * The box's backdrop (first, realistic view): the sky that lights it.
     * sea: a world's sea past its edge, { foot, seaY, mask } (app.js
     * worldSea, gfx/edgeSea.js), or none.
     */
    drawSky(rp, sea = null) {
      if (sky.state !== 'ready') return false;
      const params = sea ? { foot: sea.foot, seaY: sea.seaY, sea: 1, mask: sea.mask } : { sea: 0 };
      sky.draw(rp, { bind: [fu.group], count: 3, params });
      return true;
    },
    /**
     * The floor grid (before the volume). model: grid units → scene, 16
     * numbers column-major or a three Matrix4 (GridHelper's position and
     * scale: under a box, y = FLOOR_Y; a world's spans its footprint); opacity:
     * the render scale (lines are one rendered pixel wide).
     */
    drawGrid(rp, { model, opacity = 1, span = FLOOR_SPAN, divisions = FLOOR_SPAN, lit = false }) {
      if (grid.state !== 'ready') return false;
      grid.draw(rp, {
        bind: [fu.group], count: GRID_VERTICES(divisions),
        params: { model, center: [...center, opacity], line: [...line, opacity], half: span / 2, step: span / divisions, divisions, lit: lit ? 1 : 0 },
      });
      return true;
    },
    /**
     * The box's edges (after the volume): the grid's box [0, size] in cells,
     * placed by FrameUniforms.model. scale: the render scale (lines are one
     * rendered pixel wide); lit: under the sky (drawSky), dark ink instead.
     */
    drawEdges(rp, { size, scale = 1, lit = false }) {
      if (edges.state !== 'ready') return false;
      const color = lit ? [...edgeLit, EDGE_LIT_OPACITY * scale] : [...edge, EDGE_OPACITY * scale];
      edges.draw(rp, { bind: [fu.group], count: EDGE_VERTICES, params: { color, size } });
      return true;
    },
  };
}
