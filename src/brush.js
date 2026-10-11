import { Color, Matrix4, Matrix3, Vector3, Quaternion } from 'three/webgpu';
import { frameBindings, RENDER_LAYOUT } from './shaders/bindings.js';
import { uniformStruct } from './gpu/params.js';
import { frameUniformsOf } from './gfx/uniforms.js';
import { SCENE_FORMATS } from './shaders/render.js';

// Brush cursor: a soft glass bubble (or box) with a bright rim, drawn on top
// of everything so it stays visible inside piles. A line or box being dragged
// with the editing tools shows the brush at both ends and swept between (TPT's
// Shift-drag and Ctrl-drag previews, GameView.cpp RenderLine, RenderRect).
//
// A pipeline of ours in the scene pass, drawn last (docs/webgpu.md F1): no
// depth test, premultiplied over. Its shapes are three's SphereGeometry(1, 48,
// 24), BoxGeometry(2, 2, 2) and the open CylinderGeometry(1, 1, 2, 48) of a
// line's body, built in the vertex stage from the vertex index in three's
// vertex order, front faces only, as the material's FrontSide drew them.
//
//   const brush = createBrushCursor(gpu);
//   brush.set({ visible, position, radius, shape, color });   // scene units
//   draw(rp) { …; brush.draw(rp); }                           // after FrameUniforms is written

const SPHERE_W = 48, SPHERE_H = 24;   // three's segments
const TUBE_SEGMENTS = 48;
export const BRUSH_SHAPES = { SPHERE: 0, BOX: 1, TUBE: 2 };
const VERTICES = [SPHERE_W * SPHERE_H * 6, 36, TUBE_SEGMENTS * 6];

export const BrushParams = uniformStruct('BrushParams', {
  model: 'mat4x4f',     // shape units → scene
  normal: 'mat3x3f',    // its normal matrix (inverse transpose)
  eye: 'vec3f',         // the camera, scene units
  cube: 'f32',          // 1: the box's bright edges (the cube brush)
  color: 'vec3f',       // linear rgb
  shape: 'u32',         // BRUSH_SHAPES
});

export const brushWGSL = () => /* wgsl */ `
${frameBindings()}
${BrushParams.wgsl}
@group(3) @binding(1) var<uniform> P: BrushParams;
const PI_B: f32 = 3.14159265;
struct BrushOut {
  @builtin(position) position: vec4f,
  @location(0) n: vec3f,       // normal, scene space
  @location(1) v: vec3f,       // toward the eye
  @location(2) local: vec3f,   // shape units (the box's edges)
}
// a quad's corner k (0..5) in three's index order: triangles (a, b, d), (b, c, d)
// with a = (x+1, y), b = (x, y), c = (x, y+1), d = (x+1, y+1)
fn quadCorner(k: u32) -> vec2u { return vec2u((0x25u >> k) & 1u, (0x34u >> k) & 1u); }
@vertex fn vs(@builtin(vertex_index) i: u32) -> BrushOut {
  var p: vec3f;
  var n: vec3f;
  let k = quadCorner(i % 6u);
  let q = i / 6u;
  if (P.shape == ${BRUSH_SHAPES.SPHERE}u) {
    // SphereGeometry(1, ${SPHERE_W}, ${SPHERE_H}): u around from -x, v down from the top (the poles' quads are half degenerate)
    let c = vec2u(q % ${SPHERE_W}u, q / ${SPHERE_W}u) + k;
    let u = f32(c.x) / ${SPHERE_W}.0 * 2.0 * PI_B;
    let v = f32(c.y) / ${SPHERE_H}.0 * PI_B;
    p = vec3f(-cos(u) * sin(v), cos(v), sin(u) * sin(v));
    n = p;
  } else if (P.shape == ${BRUSH_SHAPES.BOX}u) {
    // BoxGeometry(2, 2, 2): face q's outward normal along axis q / 2, between
    // tangents t and b with t × b = normal, its corners CCW from outside
    let a = q / 2u;
    let s = select(-1.0, 1.0, (q & 1u) == 0u);
    let c = vec2f(k) * 2.0 - 1.0;
    var nn = vec3f(0.0);
    nn[a] = s;
    var t = vec3f(0.0);
    t[(a + 1u) % 3u] = s;
    var b = vec3f(0.0);
    b[(a + 2u) % 3u] = 1.0;
    p = nn + c.y * t + c.x * b;
    n = nn;
  } else {
    // CylinderGeometry(1, 1, 2, ${TUBE_SEGMENTS}, 1, true): its side, x around, y down
    let c = vec2u(q, 0u) + k;
    let th = f32(c.x) / ${TUBE_SEGMENTS}.0 * 2.0 * PI_B;
    p = vec3f(sin(th), 1.0 - 2.0 * f32(c.y), cos(th));
    n = vec3f(sin(th), 0.0, cos(th));
  }
  let w = P.model * vec4f(p, 1.0);
  var o: BrushOut;
  o.position = FU.viewProj * w;
  o.n = normalize(P.normal * n);
  o.v = normalize(P.eye - w.xyz);
  o.local = p;
  return o;
}
@fragment fn fs(i: BrushOut) -> @location(0) vec4f {
  let rim = pow(1.0 - abs(dot(normalize(i.n), normalize(i.v))), 2.5);
  var a = 0.05 + 0.55 * rim;
  if (P.cube > 0.5) {
    // bright box edges
    let q = abs(i.local);
    let e = max(min(q.x, q.y), max(min(q.y, q.z), min(q.x, q.z)));
    a = 0.05 + 0.75 * smoothstep(0.9, 0.985, e);
  }
  return vec4f(mix(P.color, vec3f(1.0), 0.25) * a, a);
}`;

// premultiplied colour over what is there
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const PIPELINE = {
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] },
  primitive: { topology: 'triangle-list', cullMode: 'back' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
};

/** tools/check-wgsl.mjs (and the menu's warm-up, B5) */
export const WGSL_CHECK = [
  { name: 'brush', kind: 'render', grids: false, code: brushWGSL, layouts: () => [RENDER_LAYOUT.FRAME], layoutNames: ['FRAME'], params: BrushParams, ...PIPELINE },
];

/**
 * The brush cursor on `gpu`: set/setLine/setBox as before (scene units), and
 * draw(rp) into the scene pass after everything else.
 * @param {object} gpu
 */
export function createBrushCursor(gpu) {
  if (!gpu?.renderPipeline) throw new Error('createBrushCursor(gpu): the brush is a pipeline of ours now (docs/webgpu.md F1)');
  const fu = frameUniformsOf(gpu);
  const pipe = gpu.renderPipeline({ name: 'brush', code: brushWGSL(), layouts: [fu.layout], params: BrushParams, ...PIPELINE });
  // the parts: the brush (or a line's end), a line's start, and its body
  const part = () => ({ visible: false, shape: BRUSH_SHAPES.SPHERE, position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1) });
  const mesh = part(), start = part(), body = part();
  const color = new Color();
  let cube = 0;
  const up = new Vector3(0, 1, 0), dir = new Vector3();
  const show = (m, shape, at, radius) => {
    m.visible = true;
    m.shape = shape === 1 ? BRUSH_SHAPES.BOX : BRUSH_SHAPES.SPHERE;
    m.position.copy(at);
    m.quaternion.identity();
    m.scale.setScalar(radius);
  };
  // (as the WebGL material did: Color.set takes an sRGB colour to linear, and
  // convertSRGBToLinear converts it once more; kept for the same look)
  const paint = (shape, c) => {
    cube = shape === 1 ? 1 : 0;
    color.set(c).convertSRGBToLinear();
  };
  const model = new Matrix4(), normal = new Matrix3();

  return {
    ready: pipe.ready,
    /** The parts, for tools: { visible, shape, position, quaternion, scale } each. */
    parts: { mesh, start, body },
    /**
     * The brush (a line's end), as the three.js mesh was for its callers'
     * visibility toggles (app.js hides it for thumbnails): .visible works; it
     * is no Object3D, so nothing adds it to a scene.
     */
    get mesh() { return mesh; },
    get visible() { return mesh.visible || start.visible || body.visible; },
    set({ visible, position, radius, shape, color: c }) {
      mesh.visible = visible;
      start.visible = body.visible = false;
      if (!visible) return;
      show(mesh, shape, position, radius);
      paint(shape, c);
    },
    // a line being dragged (scene units): the brush at both ends and swept between
    setLine({ from, to, radius, shape, color: c }) {
      show(mesh, shape, to, radius);
      show(start, shape, from, radius);
      dir.subVectors(to, from);
      const len = dir.length();
      body.visible = len > 0;
      if (len > 0) {
        body.shape = shape === 1 ? BRUSH_SHAPES.BOX : BRUSH_SHAPES.TUBE;
        body.position.addVectors(from, to).multiplyScalar(0.5);
        body.quaternion.setFromUnitVectors(up, dir.divideScalar(len));
        body.scale.set(radius, len / 2, radius);
      }
      paint(shape, c);
    },
    // a box being dragged (TPT's Ctrl-drag preview, RenderRect): its centre and half size (scene units)
    setBox({ position, half, color: c }) {
      start.visible = body.visible = false;
      show(mesh, 1, position, 1);
      mesh.scale.copy(half);
      paint(1, c);
    },
    /**
     * Draws the visible parts into the scene pass (last: no depth test).
     * FrameUniforms must have been written this frame (its camera's eye is used).
     * @param {GPURenderPassEncoder} rp
     * @returns {boolean} false while the pipeline builds
     */
    draw(rp) {
      if (pipe.state !== 'ready') return false;
      for (const m of [mesh, start, body]) {
        if (!m.visible) continue;
        model.compose(m.position, m.quaternion, m.scale);
        normal.getNormalMatrix(model);
        pipe.draw(rp, {
          bind: [fu.group], count: VERTICES[m.shape],
          params: { model, normal: normal.elements, eye: fu.last.eye, cube, color: [color.r, color.g, color.b], shape: m.shape },
        });
      }
      return true;
    },
  };
}
