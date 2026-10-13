// The blocks renderer's WGSL (the ?blocks flag; gfx/blocks.js runs it): the
// world drawn as the visible faces of its cells, the way Minecraft draws its
// chunks, instead of the per-pixel march (shaders/render.js).
//
//   mesh    compute, one thread per cell (a workgroup per brick): each side of
//           a cell of visible matter whose neighbour doesn't hide it becomes a
//           face, appended to the opaque or the translucent half of the face
//           buffer (one atomic per workgroup and class, the threads' places
//           from a workgroup counter). A face packs its cell, side, element,
//           per-cell tint byte, four corner ambient-occlusion levels
//           (Minecraft's smooth lighting: the two edge cells and the corner
//           cell beside each vertex, Lysenko 2013, "Ambient occlusion for
//           Minecraft-like worlds"), its temperature and life (f16 each).
//   finish  one thread: the two counts into drawIndirect's args (clamped to
//           the halves' capacities), the raw counts into a readback slot (the
//           host warns on overflow), the counters back to 0 for the next mesh.
//   draw    instanced quads from the face buffer, 6 vertices a face: the
//           opaque half (depth written, back faces culled), the floor quad of
//           a box, then the translucent half (premultiplied over, depth tested
//           not written, both sides).
//
// Classes (the element's render class, elements.js R): opaque cells hide
// each other; a liquid shows faces against air, gas, fire and glass; glass
// against anything not opaque and not glass; smoke and steam against air;
// fire against air and gas. Shading: the element's colour with TPT's
// per-particle colour jitter (COLORVAR, the seed in state A's w), the sun by
// n·l, the sky by how much the face looks up times Minecraft's per-face shade
// (ClientLevel.getShade: up 1, north/south 0.8, east/west 0.6, down 0.5),
// darkened by the corner AO; hot matter glows (gfx/incandescence.js), lamps
// and live sparks too. The heat view colours faces by temperature (the
// game's colormap, src/views.js) under the data views' clay light.
import { STATE_OPTS, LAYOUT, prelude, STAGE } from './common.js';
import { frameBindings, RENDER_LAYOUT } from './bindings.js';
import { materialsGLSL } from '../gfx/materials.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { COLORMAPS } from '../views.js';
import { colormapWGSL, SCENE_FORMATS } from './render.js';

/** Bytes a face takes in the face buffer (struct Face: pos, info, heat). */
export const FACE_BYTES = 12;
/** Workgroup of the mesher: a brick's 64 cells. */
export const MESH_WORKGROUP = 64;
/** The mesher's readback slot: the raw opaque and translucent counts (u32 × 4). */
export const MESH_RESULT_BYTES = 16;
/** Vertices a face draws: two triangles. */
export const FACE_VERTICES = 6;

/**
 * Face capacity for grid g: the opaque half holds half a face per cell (at
 * least 2^18, at most 2^21: a 128³ world's terrain and caves come to a few
 * hundred thousand), the translucent half half that, both within the device's
 * storage binding size.
 * @param {{ slots: number }} g
 * @param {number} [maxBinding] the device's maxStorageBufferBindingSize
 * @returns {{ o: number, t: number }}
 */
export function faceCapacity(g, maxBinding = 128 * 1024 * 1024) {
  let o = Math.min(1 << 21, Math.max(1 << 18, Math.ceil(g.slots / 2)));
  let t = o >> 1;
  const fit = Math.floor(maxBinding / FACE_BYTES);
  if (o + t > fit) { o = Math.floor((fit * 2) / 3); t = fit - o; }
  return { o, t };
}

export const MeshParams = uniformStruct('MeshParams', {
  capO: 'u32',   // faces the opaque half holds
  capT: 'u32',   // ... and the translucent half (it starts at capO)
  edge: 'u32',   // 1: a world's window (beyond its x and z sides is more ground: no faces there); 0: a box (air)
  slot: 'u32',   // finish: the readback ring's slot for the raw counts
});
export const BlockDrawParams = uniformStruct('BlockDrawParams', {
  base: 'u32',        // the half drawn: its first face (0, or capO)
  mode: 'u32',        // 0: the normal colours; 1: the heat view
  marchNear: 'f32',   // cells: nothing nearer the eye is drawn (first person's eye clip, pov/index.js EYE_CLIP)
});

// The mesher's group 2: the faces, the counters, drawIndirect's args (both halves), the readback ring.
export const MESH_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 3, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
// The draw's group 1: the faces, read by the vertex stage.
export const FACES_LAYOUT = [{ binding: 0, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } }];
export const MESH_LAYOUTS = () => [LAYOUT.TABLES, LAYOUT.STATE_RO, MESH_LAYOUT];
export const DRAW_LAYOUTS = () => [RENDER_LAYOUT.FRAME, FACES_LAYOUT];
export const LAYOUT_NAMES = { mesh: ['TABLES', 'STATE_RO', 'BLOCK_MESH'], draw: ['FRAME', 'BLOCK_FACES'] };

const FACE_WGSL = /* wgsl */ `
struct Face {
  pos: u32,    // x | y << 10 | z << 20 (grid cells)
  info: u32,   // side (0-5: -x +x -y +y -z +z) | id << 3 | ao << 11 (4 corners × 2 bits, 3: open) | tint << 19 | glow << 27 (1: live spark, 2: lit lamp)
  heat: u32,   // pack2x16float(°C, life)
}`;

const CLASSES_WGSL = /* wgsl */ `
const CL_NONE: u32 = 0u;
const CL_OPAQUE: u32 = 1u;
const CL_LIQUID: u32 = 2u;
const CL_GLASS: u32 = 3u;
const CL_GAS: u32 = 4u;
const CL_FIRE: u32 = 5u;
fn classOf(id: i32) -> u32 {
  if (id == E_EMPTY) { return CL_NONE; }
  let r = RCLASS(id);
  if (r == R_OPAQUE) { return CL_OPAQUE; }
  if (r == R_LIQUID) { return CL_LIQUID; }
  if (r == R_GLASS) { return CL_GLASS; }
  if (r == R_GAS) { return CL_GAS; }
  if (r == R_FIRE) { return CL_FIRE; }
  return CL_NONE;
}`;

/** The mesher (entry main) and its finish (entry finish) for grid g. */
export const meshWGSL = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${MeshParams.wgsl}
@group(3) @binding(1) var<uniform> P: MeshParams;
${FACE_WGSL}
@group(2) @binding(0) var<storage, read_write> faces: array<Face>;
@group(2) @binding(1) var<storage, read_write> counts: array<atomic<u32>, 4>;
@group(2) @binding(2) var<storage, read_write> args: array<u32, 8>;
@group(2) @binding(3) var<storage, read_write> ring: array<u32>;
${CLASSES_WGSL}

// The class at cell c, the grid's surroundings included: the floor under a
// box (and a world's bedrock) is opaque, the sky above is air, beyond a box's
// sides is air and beyond a world window's is more ground.
fn classAt(c: vec3i) -> u32 {
  if (c.y < 0) { return CL_OPAQUE; }
  if (c.y >= NY) { return CL_NONE; }
  if (c.x < 0 || c.z < 0 || c.x >= NX || c.z >= NZ) { return select(CL_NONE, CL_OPAQUE, P.edge != 0u); }
  return classOf(eid(fetchA(c)));
}
fn occ(c: vec3i) -> u32 { return select(0u, 1u, classAt(c) == CL_OPAQUE); }
// Whether a cell of class me shows its side to a neighbour of class nb.
fn shows(me: u32, nb: u32) -> bool {
  switch me {
    case 1u: { return nb != CL_OPAQUE; }
    case 2u: { return nb == CL_NONE || nb == CL_GAS || nb == CL_FIRE || nb == CL_GLASS; }
    case 3u: { return nb != CL_OPAQUE && nb != CL_GLASS; }
    case 4u: { return nb == CL_NONE; }
    case 5u: { return nb == CL_NONE || nb == CL_GAS; }
    default: { return false; }
  }
}
// A vertex's AO level from its two edge neighbours and its corner neighbour
// (0: boxed in, 3: open), Lysenko 2013: both edges closed close the corner.
fn cornerAO(s1: u32, s2: u32, c: u32) -> u32 {
  if (s1 == 1u && s2 == 1u) { return 0u; }
  return 3u - s1 - s2 - c;
}

var<workgroup> wgCount: array<atomic<u32>, 2>;
var<workgroup> wgBase: array<u32, 2>;

@compute @workgroup_size(${MESH_WORKGROUP}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
                                       @builtin(local_invocation_index) li: u32) {
  if (li < 2u) { atomicStore(&wgCount[li], 0u); }
  workgroupBarrier();
  let s = foldThread(wg, nwg, li);
  var n = 0u;                  // faces this cell shows
  var k = 0u;                  // its half: 0 opaque, 1 translucent
  var pos = 0u;
  var heat = 0u;
  var info: array<u32, 6>;
  if (s < SLOTS) {
    let a = fetchAs(s);
    let id = eid(a);
    let me = classOf(id);
    if (me != CL_NONE) {
      let p = cellOf(s);
      k = select(1u, 0u, me == CL_OPAQUE);
      pos = u32(p.x) | (u32(p.y) << 10u) | (u32(p.z) << 20u);
      heat = pack2x16float(vec2f(a.y, a.z));
      let tint = u32(clamp(fract(a.w), 0.0, 0.999) * 256.0);
      let ctype = floor(a.w);
      var glow = 0u;
      if (sparkLive(id, ctype)) { glow = 1u; }
      if (id == E_LAMP && sparkLevel(ctype) > 0) { glow = 2u; }
      let head = (u32(id) << 3u) | (tint << 19u) | (glow << 27u);
      let shaded = me == CL_OPAQUE || me == CL_LIQUID;
      for (var side = 0u; side < 6u; side++) {
        let axis = side >> 1u;
        var d = vec3i(0);
        d[axis] = select(-1, 1, (side & 1u) == 1u);
        let q = p + d;
        if (!shows(me, classAt(q))) { continue; }
        var ao = 255u;
        if (shaded) {
          // the face's plane is in q; its corners' neighbours are q's in that plane
          var eu = vec3i(0);
          eu[(axis + 1u) % 3u] = 1;
          var ev = vec3i(0);
          ev[(axis + 2u) % 3u] = 1;
          let u0 = occ(q - eu);
          let u1 = occ(q + eu);
          let v0 = occ(q - ev);
          let v1 = occ(q + ev);
          ao = cornerAO(u0, v0, occ(q - eu - ev)) | (cornerAO(u1, v0, occ(q + eu - ev)) << 2u)
             | (cornerAO(u0, v1, occ(q - eu + ev)) << 4u) | (cornerAO(u1, v1, occ(q + eu + ev)) << 6u);
        }
        info[n] = head | side | (ao << 11u);
        n++;
      }
    }
  }
  var off = 0u;
  if (n > 0u) { off = atomicAdd(&wgCount[k], n); }
  workgroupBarrier();
  if (li < 2u) {
    let c = atomicLoad(&wgCount[li]);
    var b = 0u;
    if (c > 0u) { b = atomicAdd(&counts[li], c); }
    wgBase[li] = b;
  }
  workgroupBarrier();
  let cap = select(P.capO, P.capT, k == 1u);
  let region = select(0u, P.capO, k == 1u);
  let base = wgBase[k] + off;
  for (var j = 0u; j < n; j++) {
    if (base + j < cap) { faces[region + base + j] = Face(pos, info[j], heat); }
  }
}

// After the mesher: the draws' args from the counts, the counts for the host, the counters cleared.
@compute @workgroup_size(1) fn finish() {
  let o = atomicLoad(&counts[0]);
  let t = atomicLoad(&counts[1]);
  args[0] = ${FACE_VERTICES}u;
  args[1] = min(o, P.capO);
  args[2] = 0u;
  args[3] = 0u;
  args[4] = ${FACE_VERTICES}u;
  args[5] = min(t, P.capT);
  args[6] = 0u;
  args[7] = 0u;
  ring[P.slot * 4u] = o;
  ring[P.slot * 4u + 1u] = t;
  ring[P.slot * 4u + 2u] = P.capO;
  ring[P.slot * 4u + 3u] = P.capT;
  atomicStore(&counts[0], 0u);
  atomicStore(&counts[1], 0u);
}
`;

/** The faces' draw (vs + fs: opaque; vs + fsT: translucent; vsFloor + fsFloor: a box's floor) for grid g. */
export const drawWGSL = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${frameBindings()}
${materialsGLSL()}
${BlockDrawParams.wgsl}
@group(3) @binding(1) var<uniform> P: BlockDrawParams;
${FACE_WGSL}
@group(1) @binding(0) var<storage, read> faces: array<Face>;
${CLASSES_WGSL}

// the heat view's colormap (src/views.js), interpolated in sRGB as the legend is
const BK_DATA_GAMMA: f32 = 2.2;
fn toLinear(c: vec3f) -> vec3f { return pow(c, vec3f(BK_DATA_GAMMA)); }
${colormapWGSL('heat', COLORMAPS.heat)}

const BK_AO_FLOOR: f32 = 0.35;           // brightness at a fully boxed-in corner (AO level 0 of 3)
const BK_SUN_AO: f32 = 0.5;              // share of the AO the sun's light takes (the rest: the sky's alone)
const BK_HOT_FROM: f32 = 350.0;          // °C: hot surfaces lose reflected light from here ...
const BK_HOT_TO: f32 = 1000.0;           // ... to here, where their glow takes over (shaders/gfx/plain.js)
const BK_HOT_ALBEDO: f32 = 0.2;
const BK_LAVA_ALB: vec3f = vec3f(0.05, 0.03, 0.02);   // lava's crust, lit mostly by its own glow (plain.js)
const BK_ALPHA_LIQUID: f32 = 0.6;        // TPT's liquids read as coloured, see-through sheets
const BK_ALPHA_GLASS: f32 = 0.22;
const BK_ALPHA_SMOKE: f32 = 0.55;
const BK_ALPHA_STEAM: f32 = 0.3;
const BK_ALPHA_GAS: f32 = 0.12;          // the clear gases (hydrogen, CO2, ...): a faint hint
const BK_FIRE_MIN_T: f32 = 900.0;        // °C: a flame glows at least as this hot
const BK_FIRE_GAIN: f32 = 1.5;
const BK_FIRE_ALPHA: f32 = 0.25;
const BK_FLOOR_GRID: f32 = 8.0;          // cells per floor square
const BK_FLOOR_LINE: f32 = 0.7;          // the floor's lines: its brightness times this
// the data views' clay light (shaders/render.js clay)
const BK_CLAY_AMBIENT: f32 = 0.45;
const BK_CLAY_SUN: f32 = 0.41;
const BK_CLAY_SKY: f32 = 0.21;
const BK_CLAY_AO_MIN: f32 = 0.6;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,                         // the face's corner frame (u, v), for the AO
  @location(1) grid: vec3f,                       // grid cells
  @location(2) @interpolate(flat) info: u32,
  @location(3) @interpolate(flat) heat: u32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let f = faces[P.base + ii];
  let cell = vec3f(f32(f.pos & 1023u), f32((f.pos >> 10u) & 1023u), f32((f.pos >> 20u) & 1023u));
  let side = f.info & 7u;
  let axis = side >> 1u;
  let plus = (side & 1u) == 1u;
  // corners 0 (0,0), 1 (1,0), 2 (1,1), 3 (0,1) as triangles (0,1,2) (0,2,3):
  // counter-clockwise seen from outside a face toward +axis (u, v, axis
  // right-handed); a face toward -axis is the same square with u and v swapped
  let c = select(vi, select(vi - 2u, 0u, vi == 3u), vi >= 3u);
  let cu = select(0.0, 1.0, c == 1u || c == 2u);
  let cv = select(0.0, 1.0, c >= 2u);
  let tu = select(cv, cu, plus);
  let tv = select(cu, cv, plus);
  var gp = cell;
  gp[axis] += select(0.0, 1.0, plus);
  gp[(axis + 1u) % 3u] += tu;
  gp[(axis + 2u) % 3u] += tv;
  var o: VOut;
  o.position = FU.viewProj * FU.model * vec4f(gp, 1.0);
  o.uv = vec2f(tu, tv);
  o.grid = gp;
  o.info = f.info;
  o.heat = f.heat;
  return o;
}

fn sideNormal(side: u32) -> vec3f {
  var n = vec3f(0.0);
  n[side >> 1u] = select(-1.0, 1.0, (side & 1u) == 1u);
  return n;
}
// Minecraft's per-face shade of the sky light (ClientLevel.getShade): up 1,
// down 0.5, north and south (z) 0.8, east and west (x) 0.6.
fn faceShade(side: u32) -> f32 {
  switch side >> 1u {
    case 0u: { return 0.6; }
    case 1u: { return select(0.5, 1.0, (side & 1u) == 1u); }
    default: { return 0.8; }
  }
}
// the corner AO at uv, 0..1 (1: open)
fn faceAO(info: u32, uv: vec2f) -> f32 {
  let a = (info >> 11u) & 255u;
  let lo = mix(f32(a & 3u), f32((a >> 2u) & 3u), uv.x);
  let hi = mix(f32((a >> 4u) & 3u), f32((a >> 6u) & 3u), uv.x);
  return mix(lo, hi, uv.y) / 3.0;
}
// the sky's irradiance on a face looking along n (shaders/gfx/lighting.js skyIrradiance's split)
fn skyLight(n: vec3f) -> vec3f {
  let up = n.y * 0.5 + 0.5;
  return up * FU.skyUp + (1.0 - up) * FU.ground + FU.caveAmbient;
}
fn clayLight(n: vec3f, ao: f32) -> f32 {
  let ndl = max(dot(n, FU.sun), 0.0);
  return (BK_CLAY_AMBIENT + BK_CLAY_SUN * ndl + BK_CLAY_SKY * (0.5 + 0.5 * n.y)) * mix(BK_CLAY_AO_MIN, 1.0, ao);
}
fn nearClip(v: VOut) {
  if (P.marchNear > 0.0 && distance(v.grid, FU.cam) < P.marchNear) { discard; }
}

// A face's premultiplied colour. back: seen from behind (translucent faces draw both sides).
fn shade(v: VOut, back: bool) -> vec4f {
  let info = v.info;
  let side = info & 7u;
  let id = i32((info >> 3u) & 255u);
  let cls = classOf(id);
  let ht = unpack2x16float(v.heat);
  let T = ht.x;
  let life = ht.y;
  var n = sideNormal(side);
  if (back) { n = -n; }
  let ao = faceAO(info, v.uv);
  if (P.mode == 1u) {
    // the heat view: the colormap under clay light; see-through classes as thin panes
    let c = heatColor(T) * clayLight(n, ao);
    var al = 1.0;
    if (cls == CL_LIQUID) { al = BK_ALPHA_LIQUID; }
    else if (cls == CL_GLASS) { al = 0.35; }
    else if (cls == CL_GAS || cls == CL_FIRE) { al = 0.3; }
    return vec4f(c * al, al);
  }
  let tint = f32((info >> 19u) & 255u) / 255.0;
  var alb = COLOR(id) * (1.0 + COLORVAR(id) * (tint * 2.0 - 1.0));   // TPT's per-particle colour jitter
  var emit = vec3f(0.0);
  if (cls == CL_FIRE) {
    // a flame: its blackbody glow over a little of its own colour
    emit = incandescence(max(T, BK_FIRE_MIN_T)) * BK_FIRE_GAIN * mix(0.5, 1.0, clamp(life, 0.0, 1.0));
    return vec4f(emit + alb * BK_FIRE_ALPHA * 0.2, BK_FIRE_ALPHA);
  }
  if (id == E_LAVA) { alb = BK_LAVA_ALB; }
  else { alb *= mix(1.0, BK_HOT_ALBEDO, smoothstep(BK_HOT_FROM, BK_HOT_TO, T)); }
  if (cls == CL_OPAQUE) { emit = cellEmission(id, T); }
  let glow = info >> 27u;
  if (glow == 1u) { emit += SPARK_GLOW; }
  if (glow == 2u) { emit += LAMP_GLOW; }
  let ndl = max(dot(n, FU.sun), 0.0);
  let aoL = mix(BK_AO_FLOOR, 1.0, ao);
  let lit = FU.sunCol * ndl * mix(1.0, aoL, BK_SUN_AO) + skyLight(n) * faceShade(side) * aoL;
  let c = alb * lit + emit;
  var al = 1.0;
  if (cls == CL_LIQUID) { al = BK_ALPHA_LIQUID; }
  else if (cls == CL_GLASS) { al = BK_ALPHA_GLASS; }
  else if (cls == CL_GAS) {
    if (id == E_SMOKE) { al = BK_ALPHA_SMOKE * clamp(life, 0.2, 1.0); }
    else if (id == E_STEAM || id == E_CLOUD) { al = BK_ALPHA_STEAM; }
    else { al = BK_ALPHA_GAS; }
  }
  return vec4f(c * al, al);
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  nearClip(v);
  return vec4f(shade(v, false).rgb, 1.0);
}
@fragment fn fsT(v: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  nearClip(v);
  return shade(v, !front);
}

// ---- a box's floor: the ground's radiance (FrameUniforms.ground), a line every BK_FLOOR_GRID cells ----
struct FloorOut {
  @builtin(position) position: vec4f,
  @location(0) grid: vec3f,
}
@vertex fn vsFloor(@builtin(vertex_index) vi: u32) -> FloorOut {
  let c = select(vi, select(vi - 2u, 0u, vi == 3u), vi >= 3u);
  let gp = vec3f(select(0.0, f32(NX), c == 1u || c == 2u), 0.0, select(0.0, f32(NZ), c >= 2u));
  var o: FloorOut;
  o.position = FU.viewProj * FU.model * vec4f(gp, 1.0);
  o.grid = gp;
  return o;
}
@fragment fn fsFloor(v: FloorOut) -> @location(0) vec4f {
  let q = v.grid.xz / BK_FLOOR_GRID;
  let w = max(fwidth(q), vec2f(1e-4));
  let gq = abs(fract(q - 0.5) - 0.5) / w;
  let line = 1.0 - min(min(gq.x, gq.y), 1.0);
  var c = FU.ground;
  if (P.mode == 1u) { c = heatColor(airT()) * 0.3; }
  return vec4f(c * mix(1.0, BK_FLOOR_LINE, line), 1.0);
}
`;

// ---- pipelines (gfx/blocks.js builds them; check-wgsl and the sampler budget check them) ----
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
export const blockPipelines = () => ({
  opaque: {
    vertex: { entry: 'vs' },
    fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
  },
  translucent: {
    vertex: { entry: 'vs' },
    fragment: { entry: 'fsT', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'less-equal' },
  },
  floor: {
    vertex: { entry: 'vsFloor' },
    fragment: { entry: 'fsFloor', targets: [{ format: SCENE_FORMATS.color }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
  },
});

/** tools/check-wgsl.mjs and tools/check-sampler-budget.mjs (never warmed on the menu: the renderer is opt-in) */
export const WGSL_CHECK = () => {
  const p = blockPipelines();
  const mesh = { kind: 'compute', code: (g) => meshWGSL(g), layouts: () => MESH_LAYOUTS(), layoutNames: LAYOUT_NAMES.mesh, params: MeshParams, warm: false };
  const draw = (name, desc) => ({ name, kind: 'render', code: (g) => drawWGSL(g), layouts: () => DRAW_LAYOUTS(), layoutNames: LAYOUT_NAMES.draw, params: BlockDrawParams, warm: false, ...desc });
  return [
    { name: 'blocks.mesh', ...mesh, workgroupSize: [MESH_WORKGROUP, 1, 1], dispatch: (g) => fold(g.nbricks) },
    { name: 'blocks.finish', ...mesh, entry: 'finish', workgroupSize: [1, 1, 1], dispatch: () => [1, 1, 1] },
    draw('blocks.opaque', p.opaque),
    draw('blocks.translucent', p.translucent),
    draw('blocks.floor', p.floor),
  ];
};
