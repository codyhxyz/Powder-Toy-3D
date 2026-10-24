// The seamless world's march (docs/seamless-world.md, "M — the march"): the realistic view, and
// its detail variants (gfx/detail.js) and material styles, as one full-screen ray march in world
// cells over the world copy (W), the field clipmaps (F) and the lighting (L). Every map draws its
// realistic view through it, a small one (a world the size of its box) as a big one: there is no
// box-shaped draw and no distance pass behind it.
//
// What it pastes, unchanged: the realistic tracer (shaders/render.js realisticTraceWGSL) and the
// shading library (gfx/surface.js, liquid.js, liquidDetail.js, media.js, grains.js, deco.js,
// crystal.js, the mesh cut, the haze). What it puts under them in place of the window's readers
// (worldCoreWGSL below), under the same names, so none of that code changes:
//   GRID, MAX_STEPS        the world's size (W's WC.size: a run-time uniform, one module for every map)
//   fetchA                 W's wcA (the world copy holds what the picture needs; fetchB, physics' motion
//                          and air, reads zero: Same look (gas detail drift) below)
//   brickInfo, brickOcc    W's wcInfo (today's BRICK_INFO bits)
//   occMaskOf, occCellId   one wcA read per cell (the copy has no separate id bytes)
//   skipEmpty              W's occupancy levels: the 64³ node, else the 16³ node, else the brick
//   cellFlow, the foam's aeration, the deco paint
//                          physics' window only (P.physOrigin .. + window), zero elsewhere
// Level of detail: at every brick the march enters it sets F's gFieldLevel from the pixel's
// footprint there (fieldLevelFor(footprint(p)), surface.js's cells per pixel), so far ground reads
// the coarser clip level.
//
// The pass: a full-screen triangle into the scene target after three's opaque meshes, the sky
// already drawn behind it (app.js drawSkyFor: rays that leave the world show it and the edge sea);
// frag_depth is written at the first hit (TAA's motion), premultiplied colour over, and nothing
// is written where nothing was hit. It stops at the meshes' depth (gfx/meshCut.js) as the box did.
//
// Bindings (docs/seamless-world.md):
//   group 0  the tables, FrameUniforms (the world's copy, in world cells: gfx/worldView.js), the
//            meshes' depth, the decoration plane
//   group 1  W's world copy
//   group 2  F, L and M (shaders/world/bindings.js)
//   group 3  the header (origin 0: render kernels are in world cells) and MarchParams (P)
import { prelude, LAYOUT, SUPER, SUPER_CELLS } from '../common.js';
import { frameBindings, brickInfoWGSL, RENDER_LAYOUT } from '../bindings.js';
import { materialsGLSL } from '../../gfx/materials.js';
import { glslMod } from '../../gpu/wgsl.js';
import { coreGLSL, DDA_SPARE_STEPS } from '../gfx/core.js';
import { noiseGLSL } from '../gfx/noise.js';
import { crystalGLSL } from '../gfx/crystal.js';
import { sourceAppearanceFallbackWGSL } from '../gfx/sourceAppearance.js';
import { surfaceGLSL } from '../gfx/surface.js';
import { liquidGLSL } from '../gfx/liquid.js';
import { liquidDetailGLSL } from '../gfx/liquidDetail.js';
import { mediaGLSL } from '../gfx/media.js';
import { grainsGLSL } from '../gfx/grains.js';
import { decoViewGLSL, decoSurfGLSL, DECO_PLANE_ENTRY } from '../gfx/deco.js';
import { volumeHazeGLSL } from '../farShared.js';
import { MESH_CUT_FIELDS, MESH_DEPTH_ENTRY } from '../../gfx/meshCut.js';
import { ddaWalk } from '../dda.js';
import { uniformStruct } from '../../gpu/params.js';
import { tracerCommonWGSL, realisticTraceWGSL, SCENE_FORMATS, REALISTIC_LEVELS } from '../render.js';
import { materialStyleForView, isMaterialView } from '../../views.js';
import { worldGroup2, worldGroup2WGSL, worldGroup2Layout } from './bindings.js';
// The owners' modules. Until W, F and L land these are the stand-ins (shaders/world/stubs.js);
// the lead swaps this import for './copy.js', './fields.js' and './light.js' at integration.
import { worldLightWGSL, LIGHT_BINDINGS } from './light.js';
import { worldCopyWGSL, WORLD_COPY_LAYOUT as COPY_LAYOUT } from './copy.js';
import { worldFieldsWGSL, FIELDS_BINDINGS } from './fields.js';

/** The march's own values (group 3 binding 1): the box volume's (shaders/render.js VolumeParams) and physics' window. */
export const MarchParams = uniformStruct('MarchParams', {
  ...MESH_CUT_FIELDS,
  marchNear: 'f32',     // cells: nothing nearer the camera is drawn (first person's eye clip)
  aerCopy: 'u32',       // (gfx/liquidDetail.js gAerCopy; V2 reads the aeration from its cells)
  deco: 'u32',          // the decoration is drawn (src/deco.js decoShown)
  floorLines: 'u32',    // the floor's grid lines (a small map's: mapKind.boxFrame); a big map's world floor is its plain ground
  physOrigin: 'vec3i',  // physics' window in the world (sim.origin): flow, foam and paint are read inside it ...
  physSize: 'vec3i',    // ... its size in cells ...
  physSuper: 'vec3i',   // ... and in supertiles (shaders/common.js gridDims stx, sty, stz): its slot layout
});
/** MarchParams' physics-window fields for a simulation (physics' window, at its origin in the world). */
export const physParams = (sim) => {
  const o = sim.origin, g = sim.g;
  return {
    physOrigin: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0], physSize: [g.nx, g.ny, g.nz],
    physSuper: [g.nx / SUPER_CELLS.x, g.ny / SUPER_CELLS.y, g.nz / SUPER_CELLS.z],
  };
};
/**
 * JS twin of the march's physSlot (tools/world-march-cpu-check.mjs compares it with
 * shaders/common.js cellSlot): world cell c's slot in physics' window, from run-time values.
 */
export function physSlotOf({ physOrigin, physSuper }, c) {
  const p = c.map((v, i) => v - physOrigin[i]);
  const b = p.map((v) => v >> 2);
  const s = [Math.trunc(b[0] / SUPER.x), Math.trunc(b[1] / SUPER.y), Math.trunc(b[2] / SUPER.z)];
  const k = [b[0] - s[0] * SUPER.x, b[1] - s[1] * SUPER.y, b[2] - s[2] * SUPER.z];
  const st = s[0] + physSuper[0] * (s[2] + physSuper[2] * s[1]);
  const ly = p[1] & 3;
  return (Math.imul(st * 16 + k[0] + 4 * (k[2] + 2 * k[1]), 64) + (p[0] & 3) + 4 * (ly & 1) + 8 * ((p[2] & 3) + 4 * (ly >> 1))) >>> 0;
}

/** Group 2's list: F's, L's and M's bindings (shaders/world/bindings.js). */
export const WORLD_GROUP2 = () => worldGroup2(FIELDS_BINDINGS, LIGHT_BINDINGS);

// What the shading library reads of the grid and the state, over the world copy (see the header).
// It needs the prelude of physics' window grid (slotOf for the physics-indexed reads), the
// frame's bindings, brickInfoWGSL and W's module.
const BRICK_KEY_BITS = { x: 11, y: 10 };   // a brick's key: x | y << 11 | z << 21 (worlds to 8192 × 4096 × 8192 cells)
const worldCoreWGSL = () => {
  const dda = ddaWalk();
  const near = 'vec3i(NX, NY, NZ) - 1';
  if (!dda.includes(near)) throw new Error('march: shaders/dda.js ddaStart no longer clamps to the grid as expected');
  // the mesh cut's helper and its constant, today's (gfx/core.js)
  const core = coreGLSL({ nx: 4, ny: 4, nz: 4 }, { flow: false });
  const cut = core.slice(core.indexOf('// ---- the opaque meshes\' cut'));
  return /* wgsl */ `
// ---- the world's grid: W's WC.size, read from the uniform wherever the pasted code names the grid (RENAMES) ----
// Not a private var the entry writes: Tint keeps a module's private vars in one per-thread struct,
// and the march reads the grid in its hottest helpers (outside, the DDA's clamps, the step cap),
// so a uniform read is cheaper (GPU timing 2026-10-24, Island landDown: the grid as constants
// instead of private vars took the frame from 445 to 392 ms).
const MARCH_SPARE_STEPS: i32 = ${DDA_SPARE_STEPS};
fn marchMaxSteps() -> i32 { return WC.size.x + WC.size.y + WC.size.z + MARCH_SPARE_STEPS; }
var<private> gFragCoord: vec2f;
fn outside(c: vec3i) -> bool { return any(c < vec3i(0)) || any(c >= GRID); }
// World position of grid point p: render kernels are in world cells (H.origin is 0).
fn worldPos(p: vec3f) -> vec3f { return p + vec3f(H.origin); }
fn isCrisp(id: i32) -> bool { return id != E_EMPTY && SURFCH(id) < 0 && MEDIACH(id) < 0; }
${dda.replace(near, 'GRID - 1')}
fn boxHit(ro: vec3f, rd: vec3f) -> vec3f {
  let t0 = (vec3f(0.0) - ro) / rd;
  let t1 = (vec3f(GRID) - ro) / rd;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let n = max(max(tn.x, tn.y), tn.z);
  var axis = 2.0;
  if (tn.x >= tn.y && tn.x >= tn.z) { axis = 0.0; } else if (tn.y >= tn.z) { axis = 1.0; }
  return vec3f(n, min(min(tf.x, tf.y), tf.z), axis);
}
fn tClosest(c: vec3i, ro: vec3f, rd: vec3f, ta: f32, tb: f32) -> f32 {
  return clamp(dot(vec3f(c) + 0.5 - ro, rd), ta, tb);
}

// ---- physics' window (P.physOrigin, P.physSize), indexed at run time ----
// (its slot layout from P.physSuper, as the prelude's slotOf has it from its constants: the
// march's own reads bake in no window size)
fn inPhys(c: vec3i) -> bool {
  let q = c - P.physOrigin;
  return all(q >= vec3i(0)) && all(q < P.physSize);
}
fn physSlot(c: vec3i) -> u32 {
  let p = c - P.physOrigin;
  let b = p >> vec3u(2u);
  let s = b / SUPER_B;
  let k = b - s * SUPER_B;
  let st = s.x + P.physSuper.x * (s.z + P.physSuper.z * s.y);
  let l = p & vec3i(3);
  return u32(st * 16 + k.x + 4 * (k.z + 2 * k.y)) * 64u + u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1u)));
}
fn cellFlow(c: vec3i) -> vec3f {
  if (!inPhys(c)) { return vec3f(0.0); }
  let w = flow[physSlot(c)];
  return vec3f(unpack2x16float(w.x), unpack2x16float(w.y).x);
}
// a V2 liquid cell's aeration (shaders/common.js fetchNativeAeration), its core's x and y words
fn fetchNativeAeration(c: vec3i) -> vec3f {
  if (!inPhys(c)) { return vec3f(0.0); }
  let core = aeration[2u * physSlot(c)];
  if (KIND(i32(core.x & 255u)) != K_LIQUID || (core.y & 0xffffffu) == 0u) { return vec3f(0.0); }
  return vec3f(f32(core.x >> 24u) / 255.0, 1.0, 1.0);
}

// ---- the cells: the world copy ----
fn fetchA(p: vec3i) -> vec4f { return wcA(p); }
// Same look (gas detail drift, docs/seamless-world.md): physics' motion and air (B) are not in the
// world copy; the media's detail reads still air, on every map alike.
fn fetchB(p: vec3i) -> vec4f { return vec4f(0.0); }

// ---- bricks: W's info words, keyed by coordinate ----
fn wcBrickKey(b: vec3i) -> u32 { return u32(b.x) | (u32(b.y) << ${BRICK_KEY_BITS.x}u) | (u32(b.z) << ${BRICK_KEY_BITS.x + BRICK_KEY_BITS.y}u); }
fn wcBrickOfKey(k: u32) -> vec3i {
  return vec3i(i32(k & ${(1 << BRICK_KEY_BITS.x) - 1}u), i32((k >> ${BRICK_KEY_BITS.x}u) & ${(1 << BRICK_KEY_BITS.y) - 1}u), i32(k >> ${BRICK_KEY_BITS.x + BRICK_KEY_BITS.y}u));
}
fn brickOcc(bc: vec3i) -> u32 { return wcInfo(bc); }
fn brickInfo(bc: vec3i) -> u32 {
  let w = wcInfo(bc);
  return select(0u, w, brickMatter(w));
}
fn brickInfoOf(id: u32) -> u32 { return brickInfo(wcBrickOfKey(id)); }
fn brickHas(f: u32, bit: u32) -> bool { return (f & bit) != 0u; }
fn brickMedia(f: u32) -> bool { return brickHas(f, BRICK_MEDIA); }
fn brickSurf(f: u32) -> bool { return brickHas(f, BRICK_SURF); }
fn brickOpaque(f: u32) -> bool { return brickHas(f, BRICK_OPAQUE); }
fn brickThin(f: u32) -> bool { return brickHas(f, BRICK_THIN); }
fn brickMixed(f: u32) -> bool { return brickHas(f, BRICK_MIXED); }
// (the box's occupancy masks and id bytes: the world copy reads the cell itself)
fn occMaskOf(id: u32) -> vec2u { return vec2u(0xffffffffu); }
fn occCellId(m: vec2u, id: u32, c: vec3i) -> i32 { return eid(wcA(c)); }
fn liquidInterior(bc: vec3i) -> bool {
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0 && z == 0) { continue; }
        let q = clamp(bc + vec3i(x, y, z), vec3i(0), WC.bricks - 1);
        if ((wcInfo(q) & BRICK_LIQUID_INTERIOR) == 0u) { return false; }
      }
    }
  }
  return true;
}
// Jump the walk out of the empty region around empty brick bc: the largest of W's occupancy
// nodes holding it that is empty (64³, else 16³ cells), else the brick itself. Same contract as
// skipBrick (shaders/dda.js). Kept inside the world: a ray leaving it leaves through the face it
// really crosses (the floor below all, which the callers shade).
const OCC_NODE_1: i32 = 16;   // cells per side of W's occupancy level 1 ...
const OCC_NODE_2: i32 = 64;   // ... and level 2
fn skipEmpty(bc: vec3i, ro: vec3f, rd: vec3f, istp: vec3i,
             cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  let c = bc * BS;
  var n = BS;
  if (!wcOccupied(2u, c)) { n = OCC_NODE_2; } else if (!wcOccupied(1u, c)) { n = OCC_NODE_1; }
  let lo = (c / n) * n;
  let bmin = vec3f(max(lo, vec3i(0)));
  let bmax = vec3f(min(lo + n, GRID));
  return ddaJumpBox(bmin, bmax, ro, rd, istp, cell, tMax, tEnter);
}
// (the curved view's empty-space distance: not drawn by this module)
fn brickDistAt(b: vec3i) -> i32 { return 0; }

// ---- level of detail: F's clip level for the pixel's footprint at p (cells per pixel) ----
fn marchLod(p: vec3f) { gFieldLevel = fieldLevelFor(footprint(p)); }
${cut}`;
};

// Rewrites of the pasted code that reads physics' window by its own slots (the deco paint), so it
// reads it at its place in the world. Each must match, or the module would read the wrong cells.
function rewrite(code, pairs, what) {
  let out = code;
  for (const [a, b] of pairs) {
    if (!out.includes(a)) throw new Error(`march: ${what} no longer contains ${JSON.stringify(a)}`);
    out = out.replaceAll(a, b);
  }
  return out;
}
const decoWorld = () => rewrite(decoViewGLSL, [
  ['outside(c)) { return vec4f(0.0); }', '!inPhys(c)) { return vec4f(0.0); }'],
  ['decoPlane[slotOf(c)]', 'decoPlane[physSlot(c)]'],
], 'gfx/deco.js decoAt');
// The floor's grid lines are a small map's (mapKind.boxFrame); under a big map's sea the world's
// floor is plain ground (Same look as the box era: its floor lines were never drawn on a big map).
const floorWorld = (code) => rewrite(code, [
  ['return mix(GROUND_ALB, FLOOR_LINE_ALB, line);', 'return mix(GROUND_ALB, FLOOR_LINE_ALB, line * f32(P.floorLines));'],
], 'gfx/surface.js floorAlb');
// The tracer sets F's level at every brick it enters (and keys its bricks by coordinate).
const traceWorld = (detail, format) => rewrite(realisticTraceWGSL(detail, format), [
  ['      bid = brickId(bc);\n', '      bid = brickId(bc);\n      marchLod(ro + rd * tEnter);\n'],
], 'the realistic tracer');

// The full-screen triangle and the fragment entry: the pixel's ray from the eye through the far
// plane (P.meshInv: clip → world cells, the jittered camera's), its footprint (derivatives, at
// the top in uniform control flow), the world's box, the trace.
const entryWGSL = () => /* wgsl */ `
struct MarchVarying {
  @builtin(position) position: vec4f,
  @location(0) far: vec4f,   // the far plane's point, homogeneous world cells (divided per pixel)
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> MarchVarying {
  var o: MarchVarying;
  let ndc = vec2f(select(-1.0, 3.0, i == 2u), select(-1.0, 3.0, i == 1u));
  o.position = vec4f(ndc, 0.0, 1.0);
  o.far = P.meshInv * vec4f(ndc, 1.0, 1.0);
  return o;
}
struct MarchFrag {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(v: MarchVarying) -> MarchFrag {
  gFragCoord = v.position.xy;
  gAerCopy = P.aerCopy;
  let ro = FU.cam;
  let rd = safeDir(normalize(v.far.xyz / v.far.w - FU.cam));
  surfView(FU.cam, rd);   // pixel footprint for material LOD, the floor lines and F's level (uniform control flow)
  gCubicEye = gEye;
  gCubicPixAng = gPixAng;
  var o: MarchFrag;
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, P.marchNear);
  if (bh.y <= t0) { discard; return o; }
  let h = traceView(ro, rd, t0, bh);
  if (!h.hit) { discard; return o; }
  o.color = h.color;
  o.depth = meshCutDepth(h.depth);
  return o;
}`;

// Names the pasted code calls by their box-era spelling (the clouds' and media's repeat sampler
// is F's wrapLinear; bricks are keyed by coordinate). Not applied to the prelude or W's module,
// which index physics' window and W's own buffers.
const RENAMES = [[/(?<![\w.])brickId\(/g, 'wcBrickKey('], [/\blinearRepeat\b/g, 'wrapLinear'],
  [/\bGRID\b/g, 'WC.size'], [/\bMAX_STEPS\b/g, 'marchMaxSteps()']];
const renamed = (code) => RENAMES.reduce((s, [re, to]) => s.replace(re, to), code);

/**
 * The march's WGSL module: a vertex entry `vs` (a full-screen triangle) and a fragment entry
 * `fs` drawing material view `view` with the close-up detail `detail` (gfx/detail.js defines).
 * physGrid: physics' window (its nx, ny, nz: the prelude's grid, for the physics-indexed reads).
 * The world's size is a run-time uniform (WC.size): one module per (view, detail) serves every map.
 * @param {{ nx: number, ny: number, nz: number }} physGrid
 * @param {{ view?: string, detail?: object, fixedReadFormat?: 2 | 3 }} [opts]
 * @returns {string}
 */
export function worldMarchFrag(physGrid, { view = 'realistic', detail = {}, fixedReadFormat = 2 } = {}) {
  if (!isMaterialView(view)) throw new Error(`worldMarchFrag: ${view} is not a material view (the data views keep the box's march)`);
  const shading = [
    `// world march: ${view}, detail ${Object.keys(detail).filter((k) => detail[k]).sort().join(' ') || 'off'}`,
    glslMod,
    materialsGLSL(),
    worldCoreWGSL(),
    worldFieldsWGSL({ detail }),
    noiseGLSL,
    sourceAppearanceFallbackWGSL,
    worldLightWGSL(),
    crystalGLSL,
    tracerCommonWGSL(MarchParams),
    floorWorld(surfaceGLSL(detail, { sourceAppearance: false })), decoWorld(),
    liquidGLSL,
    decoSurfGLSL,
    liquidDetailGLSL(detail, { fixedReadFormat }),
    mediaGLSL(detail),
    grainsGLSL(detail),
    volumeHazeGLSL,
    traceWorld(detail, fixedReadFormat),
    entryWGSL(),
  ].join('\n');
  const code = [
    prelude(physGrid, { state: false }),
    frameBindings(),
    brickInfoWGSL,
    worldCopyWGSL(),
    worldGroup2WGSL(WORLD_GROUP2()),
    renamed(shading),
  ].join('\n');
  return code.replaceAll('FU.materialStyle', `${materialStyleForView(view) ?? 0}.0`);
}

/** The march's bind group layouts, groups 0-3 (group 1 is W's: its class's `layout` entries). */
export const WORLD_MARCH_LAYOUTS = (worldCopyLayout = WORLD_COPY_LAYOUT) => [
  [...RENDER_LAYOUT.FRAME, MESH_DEPTH_ENTRY, DECO_PLANE_ENTRY], worldCopyLayout, worldGroup2Layout(WORLD_GROUP2()), LAYOUT.PARAMS,
];
// W's group 1 layout entries (shaders/world/copy.js)
export const WORLD_COPY_LAYOUT = COPY_LAYOUT;

// premultiplied colour over what is there
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
/** The march's render pipeline description: a full-screen triangle, depth less-equal with frag_depth written. */
export const worldMarchPipeline = () => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
});
/** Vertices of the march's draw. */
export const WORLD_MARCH_VERTICES = 3;
/** The gpu.layout names the march's groups are made under (a warm-up making them alike finds its pipelines cached). */
export const WORLD_MARCH_LAYOUT_NAMES = ['WORLD_MARCH_FRAME', 'WORLD_COPY', 'WORLD_GROUP2'];

// ---- check-wgsl (and its operator gate, tools/check-wgsl-operators.mjs) ----
// The realistic view at the detail levels shaders/render.js checks, and the other material views
// at the cost tiers' defaults. warm: false until the menu's warm-up (src/preload.js) builds the
// world march in place of the box's realistic volume.
const marchCheck = (name, view, detail) => ({
  name, view, detail, kind: 'render', warm: false,
  code: (g) => worldMarchFrag(g, { view, detail }),
  layouts: () => WORLD_MARCH_LAYOUTS(),
  layoutNames: WORLD_MARCH_LAYOUT_NAMES,
  params: MarchParams,
  ...worldMarchPipeline(),
});
export const WGSL_CHECK = () => ['off', 'balanced', 'full'].map((k) => marchCheck(`world.realistic.${k}`, 'realistic', REALISTIC_LEVELS[k]()));

/**
 * The menu's warm-up entry (src/preload.js) for a session drawing material view `view` with the
 * drawable detail `detail` (the box volume's warm entry's): the march's pipeline as gfx/worldView.js
 * makes it, same name, code, layouts and params, so Start finds it built. Built on physics' grid.
 */
export const warmMarchCheck = (view, detail) => ({
  ...marchCheck(`world.${view}(${Object.keys(detail).filter((k) => detail[k]).sort().join(',') || 'off'})`, view, detail),
  physicsGrid: true,
});
