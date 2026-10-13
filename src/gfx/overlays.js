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
//   const overlays = createOverlays(gpu);
//   draw(rp) { overlays.drawGrid(rp, { model, opacity }); volume.draw(rp, …); overlays.drawEdges(rp, { size, opacity }); }
import { Color } from 'three/webgpu';
import { frameBindings, RENDER_LAYOUT } from '../shaders/bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { frameUniformsOf } from './uniforms.js';
import { SCENE_FORMATS } from '../shaders/render.js';

// The floor grid: three's GridHelper(FLOOR_SPAN, FLOOR_SPAN, …), a line every
// scene unit, the centre lines brighter; a world's is stretched over its footprint.
export const FLOOR_SPAN = 80;
export const FLOOR_Y = -0.002;   // scene units: just under the box's floor
export const FLOOR_COLOR_CENTER = 0x2b3240;
export const FLOOR_COLOR_LINE = 0x1b2029;
// The box's edges.
export const EDGE_COLOR = 0x56607a;
export const EDGE_OPACITY = 0.55;

const linear = (hex) => new Color(hex).toArray();   // three's colour management: sRGB hex → linear

export const GridParams = uniformStruct('GridParams', {
  model: 'mat4x4f',     // grid units → scene (GridHelper's position and scale)
  center: 'vec4f',      // linear rgb, opacity
  line: 'vec4f',
  half: 'f32',          // half the span, grid units
  step: 'f32',          // between lines
  divisions: 'u32',
});
export const EdgeParams = uniformStruct('EdgeParams', {
  color: 'vec4f',       // linear rgb, opacity
  size: 'vec3f',        // the box, grid cells (FrameUniforms.model places it)
});

const LINES_WGSL = /* wgsl */ `
${frameBindings()}
struct LineOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,   // premultiplied
}
@fragment fn fs(v: LineOut) -> @location(0) vec4f { return v.color; }`;

export const gridWGSL = () => /* wgsl */ `
${LINES_WGSL}
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
  var o: LineOut;
  o.position = FU.viewProj * P.model * vec4f(p, 1.0);
  o.color = vec4f(c.rgb * c.a, c.a);
  return o;
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

/** tools/check-wgsl.mjs (and the menu's warm-up, B5) */
export const WGSL_CHECK = [
  { name: 'floorGrid', kind: 'render', grids: false, code: gridWGSL, layouts: LAYOUTS, layoutNames: ['FRAME'], params: GridParams, ...lines(false) },
  { name: 'boxEdges', kind: 'render', grids: false, code: edgesWGSL, layouts: LAYOUTS, layoutNames: ['FRAME'], params: EdgeParams, ...lines(true) },
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
  const [grid, edges] = WGSL_CHECK.map(pipe);
  const center = linear(FLOOR_COLOR_CENTER), line = linear(FLOOR_COLOR_LINE), edge = linear(EDGE_COLOR);
  return {
    ready: Promise.all([grid.ready, edges.ready]),
    /**
     * The floor grid (before the volume). model: grid units → scene, 16
     * numbers column-major or a three Matrix4 (GridHelper's position and
     * scale: under a box, y = FLOOR_Y; a world's spans its footprint); opacity:
     * the render scale (lines are one rendered pixel wide).
     */
    drawGrid(rp, { model, opacity = 1, span = FLOOR_SPAN, divisions = FLOOR_SPAN }) {
      if (grid.state !== 'ready') return false;
      grid.draw(rp, {
        bind: [fu.group], count: GRID_VERTICES(divisions),
        params: { model, center: [...center, opacity], line: [...line, opacity], half: span / 2, step: span / divisions, divisions },
      });
      return true;
    },
    /**
     * The box's edges (after the volume): the grid's box [0, size] in cells,
     * placed by FrameUniforms.model. opacity: EDGE_OPACITY × the render scale.
     */
    drawEdges(rp, { size, opacity = EDGE_OPACITY }) {
      if (edges.state !== 'ready') return false;
      edges.draw(rp, { bind: [fu.group], count: EDGE_VERTICES, params: { color: [...edge, opacity], size } });
      return true;
    },
  };
}
