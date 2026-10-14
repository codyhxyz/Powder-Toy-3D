// Conservative realistic face prototype. Only unobstructed crisp rays qualify:
// smooth/media bricks and any intervening occupied cell stay entirely on the
// original tracer (including coloured transmission and bent liquid rays).
import { FACE_WGSL, CORNER_WGSL } from './blocks.js';
import { volumeFrag, VOLUME_LAYOUTS, VolumeParams, SCENE_FORMATS } from './render.js';
import { STAGE } from '../gpu/kernels.js';

export const OPAQUE_LAYOUTS = () => {
  const layouts = VOLUME_LAYOUTS();
  layouts[0] = [...layouts[0], { binding: 4, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } }];
  return layouts;
};
export const opaquePipeline = () => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color }] },
  primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
});
const entries = /* wgsl */ `
${FACE_WGSL}
${CORNER_WGSL}
@group(0) @binding(4) var<storage, read> rasterFaces: array<Face>;
struct RasterVarying {
  @builtin(position) position: vec4f,
  @location(0) grid: vec3f,
  @location(1) @interpolate(flat) cell: vec3u,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RasterVarying {
  let f = rasterFaces[ii];
  let p = faceCorner(f, vi).grid;
  var o: RasterVarying;
  o.position = FU.viewProj * FU.model * vec4f(p, 1.0);
  o.grid = p;
  o.cell = vec3u(f.pos & 1023u, (f.pos >> 10u) & 1023u, (f.pos >> 20u) & 1023u);
  return o;
}
struct RasterFrag {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(v: RasterVarying) -> RasterFrag {
  gFragCoord = v.position.xy;
  gAerCopy = P.aerCopy;
  let ro = FU.cam;
  let rd = safeDir(normalize(v.grid - ro));
  surfView(ro, rd);
  gCubicEye = gEye;
  gCubicPixAng = gPixAng;
  var o: RasterFrag;
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, P.marchNear);
  if (bh.y <= t0 || length(v.grid - ro) < P.marchNear) { discard; return o; }
  var cell: vec3i;
  var step: vec3i;
  var delta: vec3f;
  var tm: vec3f;
  ddaStart(ro, rd, t0, &step, &delta, &cell, &tm);
  var t = t0;
  var ax = i32(bh.z);
  var lastB = vec3i(-1);
  var bid = 0u;
  var mask = vec2u(0u);
  var flags = 0u;
  // Compact occupancy only. No full state reads until the accepted surface.
  for (var i = 0; i < MAX_STEPS; i++) {
    if (outside(cell)) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) {
      lastB = bc;
      bid = brickId(bc);
      flags = brickInfoOf(bid);
      if ((flags & (BRICK_SURF | BRICK_MEDIA)) != 0u) { break; }
      if (flags != 0u) { mask = occMaskOf(bid); }
    }
    if (flags == 0u) {
      ax = skipEmpty(bc, ro, rd, step, &cell, &tm, &t);
      continue;
    }
    let id = occCellId(mask, bid, cell);
    let end = min(tm.x, min(tm.y, tm.z));
    if (all(cell == vec3i(v.cell))) {
      if (!isCrisp(id) || RCLASS(id) != R_OPAQUE || id == E_CRYSTAL) { break; }
      // Near-clipped/immersed cells need the tracer's eye-facing cut.
      if (t == t0 && t0 > bh.x) { break; }
      var n = vec3f(0.0);
      n[ax] = -f32(step[ax]);
      var hit = t;
      if (!crispHit(cell, id, ro, rd, t, end, &hit, &n)) { break; }
      let hp = ro + rd * hit;
      var s = crispSurf(cell, id, fetchA(cell), hp, n);
      decoSurf(&s);
      o.color = vec4f(shadeSurf(s, rd), 1.0);
      o.depth = volumeDepth(hp);
      return o;
    }
    // Even a missed bevel ahead stays on the reference path. This deliberately
    // favours correctness over coverage, including absent/overflow mesh faces.
    if (id != E_EMPTY) { break; }
    t = end;
    ax = ddaStep(step, delta, &cell, &tm);
  }
  discard;
  return o;
}
`;
export const opaqueWGSL = (g, detail = {}) => volumeFrag(g, { detail, entries: [entries] });
export const WGSL_CHECK = () => [{
  name: 'opaqueRaster', kind: 'render', code: (g) => opaqueWGSL(g), layouts: OPAQUE_LAYOUTS,
  layoutNames: ['OPAQUE_FRAME', 'STATE_RO', 'LIGHTING'], params: VolumeParams, warm: false, ...opaquePipeline(),
}];
