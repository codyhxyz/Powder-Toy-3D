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
import { prelude, LAYOUT, SUPER, SUPER_CELLS, STAGE } from '../common.js';
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
import { grainsGLSL, GRAINS_ANY } from '../gfx/grains.js';
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
import { worldCopyWGSL, WORLD_COPY_LAYOUT as COPY_LAYOUT, WC_OWN } from './copy.js';
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
  physSuper: 'vec3i',   // ... and in supertiles (shaders/common.js gridDims stx, sty, stz): its slot layout ...
  physRing: 'u32',      // ... rotated by its ring, in bricks (shaders/common.js ringOf; sim.g.ring, 0 unringed)
});
/** MarchParams' physics-window fields for a simulation (physics' window, at its origin in the world). */
export const physParams = (sim) => {
  const o = sim.origin, g = sim.g;
  return {
    physOrigin: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0], physSize: [g.nx, g.ny, g.nz],
    physSuper: [g.nx / SUPER_CELLS.x, g.ny / SUPER_CELLS.y, g.nz / SUPER_CELLS.z], physRing: g.ring ?? 0,
  };
};
/**
 * JS twin of the march's physSlot (tools/world-march-cpu-check.mjs compares it with
 * shaders/common.js cellSlot): world cell c's slot in physics' window, from run-time values.
 */
export function physSlotOf({ physOrigin, physSuper, physRing = 0 }, c) {
  const p = c.map((v, i) => v - physOrigin[i]);
  const b = p.map((v) => v >> 2);
  const s = [Math.trunc(b[0] / SUPER.x), Math.trunc(b[1] / SUPER.y), Math.trunc(b[2] / SUPER.z)];
  const k = [b[0] - s[0] * SUPER.x, b[1] - s[1] * SUPER.y, b[2] - s[2] * SUPER.z];
  const st = s[0] + physSuper[0] * (s[2] + physSuper[2] * s[1]);
  const ly = p[1] & 3;
  const n = 16 * physSuper[0] * physSuper[1] * physSuper[2], id = st * 16 + k[0] + 4 * (k[2] + 2 * k[1]);
  return (Math.imul(physRing ? (id + physRing) % n : id, 64) + (p[0] & 3) + 4 * (ly & 1) + 8 * ((p[2] & 3) + 4 * (ly >> 1))) >>> 0;
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
  // (a ringed window's brick numbers rotate by its ring: shaders/common.js brickId)
  let n = u32(16 * P.physSuper.x * P.physSuper.y * P.physSuper.z);
  let id = (u32(st * 16 + k.x + 4 * (k.z + 2 * k.y)) + P.physRing) % n;
  return id * 64u + u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1u)));
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
fn marchLod(p: vec3f) { gFieldLevel = fieldLevelFor(footprint(p)); fieldPickAt(p); }

// ---- the heightfield skip: above W's maximum mipmap of the column tops (wcHfTop, levels 1-3: 4², 16², 64²
// columns, each padded past every field's reach) every cell is air and nothing is drawn, so the walk jumps to
// where the ray leaves the coarsest region it is above, or comes down to that region's top (Tevs, Ihrke &
// Seidel 2008, "Maximum mipmaps for fast, accurate, and scalable dynamic height field rendering"; the
// maximum quadtree of Oh et al. 2006). Below every level's top the brick and cell walk takes over: the picture
// is the walk's. Returns (where the walk resumes, the axis it crosses there: 0 or 2 a region's side, 1 its
// top, the level that held); no jump: (t0, -1, 0).
// ---- distance blocks: past NEAR_CELLS from the eye the walk crosses a brick at a time, as the old distance
// view drew everything past its window as 1.2 m (4-cell) bricks (world/far.js, the far field), the mip-mapped
// DDA of sparse voxel octree tracing (Laine & Karras 2010, "Efficient Sparse Voxel Octrees"). In a brick with
// matter: a crisp cell the ray meets (W's own CRISP bit says to look) is hit at its face; smooth matter is
// found on F's 4-cell level (FAR_FIELD_LEVEL), FAR_STEP cells a step and root-found as near (surfRoot); a
// liquid surface, a medium or a thin liquid hands the brick back to the cell walk (refraction, gas, drops are
// the walk's). Nothing within NEAR_CELLS changes. The switch is dithered per pixel across FAR_BAND of
// NEAR_CELLS (spatiotemporal blue noise; TAA blends it), the dithered LOD transition of game engines (e.g.
// Unreal Engine's "Dithered LOD Transition"), so no line shows.
const NEAR_CELLS: f32 = 128.0;   // cells (about 38 m): full detail within it, the old physics window's reach
const FAR_BAND: f32 = 0.25;      // the switch's band: NEAR_CELLS to NEAR_CELLS · (1 + FAR_BAND), dithered
const FAR_NOISE_K: f32 = 7.0;    // the dither's blue-noise stream (stbn1's k: apart from the march's own)
const FAR_FIELD_LEVEL: u32 = 2u; // F's level a far brick reads at least: 4-cell texels, the old view's bricks
const FAR_STEP: f32 = 2.0;       // cells between a far brick's field samples: half a 4-cell texel
const FAR_CRISP_STEPS: i32 = 10; // cells a ray can cross in a brick (3 · BS - 2)
const MARCH_OWN_CRISP: u32 = ${WC_OWN.CRISP}u;
const FAR_FINE: u32 = 0u;     // the cell walk takes the brick from t
const FAR_PASS: u32 = 1u;     // nothing in the brick: the walk resumes past its face (axis ax)
const FAR_CRISP: u32 = 2u;    // a crisp cell (cell, id) hit at t, across its face ax
const FAR_SMOOTH: u32 = 3u;   // smooth surface of channel ch at t
struct FarHit { kind: u32, t: f32, ax: i32, ch: i32, cell: vec3i, id: i32 }
fn farAt() -> f32 { return NEAR_CELLS * (1.0 + FAR_BAND * stbn1(gFragCoord, f32(FU.frame), FAR_NOISE_K)); }
fn farStep(bc: vec3i, flags: u32, ro: vec3f, rd: vec3f, t0: f32, ax0: i32) -> FarHit {
  var o = FarHit(FAR_FINE, t0, ax0, -1, vec3i(0), E_EMPTY);
  let bmin = vec3f(bc * BS);
  let tb3 = (mix(bmin, bmin + f32(BS), step(vec3f(0.0), rd)) - ro) / rd;
  let axo = argmin3(tb3);
  let tb = tb3[axo];
  let open = (flags & (BRICK_MEDIA | BRICK_THIN)) == 0u;   // (a medium or thin liquid: the walk's)
  if (open && (flags & MARCH_OWN_CRISP) != 0u) {
    // the first cell with anything in it along the ray: a crisp one is the hit, anything else is left to the field
    let lo = bc * BS;
    var c = clamp(vec3i(floor(ro + rd * (t0 + DDA_START_NUDGE))), lo, lo + BS - 1);
    var istp: vec3i;
    var tDelta: vec3f;
    var tMax: vec3f;
    ddaInit(ro, rd, c, &istp, &tDelta, &tMax);
    var tc = t0;
    var ax = ax0;
    for (var k = 0; k < FAR_CRISP_STEPS; k++) {
      if (any(c < lo) || any(c >= lo + BS)) { break; }
      let id = wcId(wcCell(c));
      if (id != E_EMPTY) {
        if (isCrisp(id)) { o = FarHit(FAR_CRISP, tc, ax, -1, c, id); }
        break;
      }
      tc = min(tMax.x, min(tMax.y, tMax.z));
      ax = ddaStep(istp, tDelta, &c, &tMax);
    }
  }
  if (open && o.kind == FAR_FINE) {
    var ta = t0;
    var fa = surfField(ro + rd * t0) - SURF_ISO;
    if (all(fa < vec4f(0.0))) {   // (already inside at the face: the walk's, as it entered)
      o = FarHit(FAR_PASS, tb, axo, -1, vec3i(0), E_EMPTY);
      var tn = t0;
      loop {
        if (tn >= tb) { break; }
        tn = min(tn + FAR_STEP, tb);
        let fb = surfField(ro + rd * tn) - SURF_ISO;
        if (any(fb >= vec4f(0.0))) {
          // the first channel up: a liquid's surface is the walk's (it refracts); an opaque one is root-found here
          var ch = -1;
          for (var c = 1; c < 4; c++) { if (fb[c] >= 0.0 && ch < 0) { ch = c; } }
          if (fb.x >= 0.0 || ch < 0) { o = FarHit(FAR_FINE, ta, ax0, -1, vec3i(0), E_EMPTY); }
          else { o = FarHit(FAR_SMOOTH, surfRoot(ro, rd, ch, ta, tn, fa[ch], fb[ch]), -1, ch, vec3i(0), E_EMPTY); }
          break;
        }
        ta = tn;
        fa = fb;
      }
    }
  }
  return o;
}

const HF_LEVEL_TOP: u32 = 3u;   // the coarsest level tried first (64 × 64 columns)
const HF_MIN_JUMP: f32 = 1e-3;  // cells: a shorter jump is the walk's (a ray at a region's top or side by rounding)
fn hfSkip(ro: vec3f, rd: vec3f, t0: f32, tCut: f32) -> vec3f {
  var r = vec3f(t0, -1.0, 0.0);
  let p = ro + rd * t0;
  for (var k = HF_LEVEL_TOP; k >= 1u; k--) {
    let s = f32(1u << (2u * k));
    let c = vec2i(floor(p.xz / s));
    let top = f32(wcHfTop(k, c));
    if (p.y >= top) {
      let lo = vec2f(c) * s;
      let txz = (select(lo, lo + s, rd.xz > vec2f(0.0)) - p.xz) / rd.xz;
      var t = min(txz.x, txz.y);
      var ax = select(2.0, 0.0, txz.x <= txz.y);
      if (rd.y < 0.0) {
        let ty = (top - p.y) / rd.y;
        if (ty < t) { t = ty; ax = 1.0; }
      }
      r = select(vec3f(t0 + t, ax, f32(k)), vec3f(tCut, -1.0, f32(k)), t0 + t >= tCut);
      break;
    }
  }
  return r;
}
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
// At a brick's first step (the walk entering a brick, before its info is read), the heightfield skip
// (hfSkip): a jump resumes the walk past the region's side or at its top, the brick's state read again there.
const HF_STEP_WGSL = (grains) => `      let hs = hfSkip(ro, rd, tEnter, tCut);
      if (hs.x > tEnter + HF_MIN_JUMP${grains ? ' && !gPebInside' : ''}) {
        tEnter = hs.x;
        cell = vec3i(floor(ro + rd * (tEnter + DDA_START_NUDGE)));
        if (hs.y >= 0.0) { ax = i32(hs.y); } else { ax = 1; }
        tMax = ddaNext(ro, rd, cell);
        prevCrisp = E_EMPTY;
        phiStale = true;
        continue;
      }
`;
// Past the dithered switch (farAt), out of liquid, a brick with matter is taken whole (farStep): a hit
// ends the walk through the tail's one shading site as any hit does; else the walk resumes past the brick
// or, for what only the cell walk draws, in it. F's level there is at least the 4-cell one.
const FAR_STEP_WGSL = (grains) => `    if (farBrick && flags != 0u${grains ? ' && !gPebInside' : ''}) {
      farBrick = false;
      let fh = farStep(bc, flags, ro, rd, tEnter, ax);
      if (fh.kind == FAR_CRISP || fh.kind == FAR_SMOOTH) {
        if (fh.t >= tCut) { cut = true; break; }
        let hp = ro + rd * fh.t;
        if (!anyHit) { anyHit = true; hitPos = hp; }
        stop = true;
        hitP = hp;
        if (fh.kind == FAR_CRISP) {
          var nh = vec3f(0.0);
          nh[fh.ax] = -f32(istp[fh.ax]);
          hitK = HIT_CRISP; hitN = nh; hitCell = fh.cell; hitId = fh.id; hitA = fetchA(fh.cell);
        } else {
          hitK = HIT_SMOOTH; hitN = vec3f(0.0); hitCh = fh.ch;
        }
        break;
      }
      if (fh.t > tEnter) {
        tEnter = fh.t;
        cell = vec3i(floor(ro + rd * (tEnter + DDA_START_NUDGE)));
        if (fh.kind == FAR_PASS) { ax = fh.ax; } else { ax = 1; }
        tMax = ddaNext(ro, rd, cell);
        prevCrisp = E_EMPTY;
        phiStale = true;
        continue;
      }
    }
`;
const traceWorld = (detail, format) => rewrite(realisticTraceWGSL(detail, format), [
  ['      bid = brickId(bc);\n', `      bid = brickId(bc);\n      marchLod(ro + rd * tEnter);\n      farBrick = liq == E_EMPTY && distance(ro + rd * tEnter, gEye) > farLimit;\n      if (farBrick) { gFieldLevel = max(gFieldLevel, FAR_FIELD_LEVEL); gFieldBlend = 0.0; fieldPickAt(ro + rd * tEnter); }\n`],
  ['  var lastB = vec3i(-1);\n', '  var lastB = vec3i(-1);\n  var farBrick = false;          // the walk is at a far brick\'s first step (farStep)\n  let farLimit = farAt();        // this pixel\'s dithered switch to distance blocks\n'],
  ['    if (flags == 0u) {\n      ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);', `${FAR_STEP_WGSL(GRAINS_ANY(detail))}    if (flags == 0u) {\n      ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);`],
  ['    if (any(bc != lastB)) {\n      lastB = bc;\n', `    if (any(bc != lastB)) {\n${HF_STEP_WGSL(GRAINS_ANY(detail))}      lastB = bc;\n`],
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

// ==== The split march: three stages, each its own GPU pass ====
// One module that marches, reflects and shades every pixel is too big for the GPU: removing a heavy
// branch it never takes made it much faster (GPU timing 2026-10-24, Island: 71 ms default, 311 ms
// straight down, against the box's 5-6), the register-pressure and occupancy cliff of an
// über-shader. So the tracer is cut where it already funnels into one place, after the march loop
// (its one shading call site), the way deferred renderers cut geometry from lighting (Deering et
// al. 1988, "The triangle processor and normal vector shader"; Killzone 2's G-buffer, Valient 2007):
//   'world march'    the loop: the ray through the world, what it gathers along the way (liquid,
//                    media, glass: col, trans) and the hit that ends it, into the G-buffer
//   'world reflect'  the pixel's one deferred reflection trace (gfx/liquid.js reflectResolve)
//   'world shade'    matOf / shadeHit / sun / probes / near field of the hit (the tail of the
//                    tracer, unchanged), over the gathered colour, haze, depth
// then the scene pass composites the result over the sky (compositeWGSL), as the whole march drew.
// What crosses, per pixel (all rgba32uint unless noted; see gbufWGSL for the bits):
//   G0  march → shade            hitP (or the floor's point) xyz, the first hit's t on the eye ray
//   G1  march → reflect, shade   col and trans as 6 × f16, the flags word (kind, ids, levels)
//   G2  march → reflect, shade   hitN and the bent ray (octahedral), F's level blends, gSkyIn
//   R0  march → reflect          the reflection's origin xyz and direction (octahedral)
//   R1  march → reflect          its env (f16 × 3), weight K (f16 × 3), wf
//   O   reflect → shade          what the colour owes the reflection (rgba16float)
//   S,D shade → scene pass       premultiplied colour (rgba16float), depth (r32float, -1: no hit)
// Intentional (grains): the grain switches' hand-off band keeps a second shading path in flight
// across the cut (gfx/grains.js gAlt*), so those detail variants draw as one pass ('whole').
export const MARCH_STAGES = ['march', 'reflect', 'shade'];
/** Whether a detail variant draws through the split stages (not the grain variants: see above). */
export const marchSplits = (detail = {}) => !GRAINS_ANY(detail);
const SPLIT_AT = "  // ---- the pixel's traced reflection, marched once";
const TRACE_SIG = 'fn traceView(ro0: vec3f, rd0: vec3f, t0: f32, bh: vec3f) -> VolumeHit {';
// the tracer cut at its one shading call site: everything before traceView, the march, the tail
function splitTrace(detail, format) {
  const code = traceWorld(detail, format);
  const at = code.indexOf(SPLIT_AT), fn = code.indexOf(TRACE_SIG);
  if (at < 0 || fn < 0 || fn > at) throw new Error('march: the realistic tracer no longer has its post-march shading section where the split cuts it');
  return { before: code.slice(0, fn), march: code.slice(fn, at), tail: code.slice(at) };
}
// G-buffer formats, their textures' bytes per pixel (the report's memory column)
export const GBUF = {
  G0: 'rgba32uint', G1: 'rgba32uint', G2: 'rgba32uint', R0: 'rgba32uint', R1: 'rgba32uint', O: 'rgba16float', S: 'rgba16float', D: 'r32float',
};
export const GBUF_BYTES_PER_PIXEL = Object.values(GBUF).reduce((n, f) => n + ({ rgba32uint: 16, rgba16float: 8, r32float: 4 })[f], 0);
// group 0 of each stage after the frame's four (tables, FrameUniforms, mesh depth, deco plane)
const GB_BASE = 4;
const STAGE_EXTRA = {
  march: [['gbG2', 'G2', 'write'], ['gbR0', 'R0', 'write'], ['gbR1', 'R1', 'write']],
  reflect: [['gbG1', 'G1'], ['gbG2', 'G2'], ['gbR0', 'R0'], ['gbR1', 'R1']],
  shade: [['gbG0', 'G0'], ['gbG1', 'G1'], ['gbG2', 'G2'], ['gbO', 'O']],
};
/** The G-buffer textures a stage's group 0 binds after the frame's four: [binding, texture key, write?]. */
export const stageTextures = (stage) => (STAGE_EXTRA[stage] ?? []).map(([, k, w], i) => [GB_BASE + i, k, !!w]);
const sampleTypeOf = (format) => (format.endsWith('uint') ? 'uint' : 'unfilterable-float');
const gbDecls = (stage) => STAGE_EXTRA[stage].map(([name, k, w], i) => (w
  ? `@group(0) @binding(${GB_BASE + i}) var ${name}: texture_storage_2d<${GBUF[k]}, write>;`
  : `@group(0) @binding(${GB_BASE + i}) var ${name}: texture_2d<${GBUF[k].endsWith('uint') ? 'u32' : 'f32'}>;`)).join('\n');
const gbLayout = (stage) => STAGE_EXTRA[stage].map(([, k, w], i) => (w
  ? { binding: GB_BASE + i, visibility: STAGE.FRAGMENT, storageTexture: { access: 'write-only', format: GBUF[k], viewDimension: '2d' } }
  : { binding: GB_BASE + i, visibility: STAGE.FRAGMENT, texture: { sampleType: sampleTypeOf(GBUF[k]), viewDimension: '2d' } }));

// The G-buffer's words. G1.w, the flags: bits 0-1 hitK, then one bit each (GB_*), then a crisp
// hit's id (8 bits) and its cell's offset from floor(hitP) (3 × 2 bits), or a smooth hit's
// channel + 1 (3 bits); then F's level and its pick (fields.js gFieldLevel, gPickL: 4 bits each).
const gbufWGSL = (stage) => /* wgsl */ `
${gbDecls(stage)}
const GB_STOP: u32 = 4u;      // a surface ended the ray (stop)
const GB_FLOOR: u32 = 8u;     // the ray reached the floor (G0's point is the floor's)
const GB_HIT: u32 = 16u;      // anything was hit (else the pass draws nothing here)
const GB_THIN: u32 = 32u;     // gThin at the march's end
const GB_REFL: u32 = 64u;     // a reflection is owed (R0, R1 hold it; O its value)
const GB_BENT: u32 = 128u;    // the ray bent (G2.y is its last direction; else the eye ray's)
const GB_N0: u32 = 256u;      // hitN is zero (the field's normal is taken)
const GB_ID_SHIFT: u32 = 9u;      // a crisp hit's id (8 bits) or a smooth one's channel + 1 (3 bits)
const GB_OFF_SHIFT: u32 = 17u;    // a crisp hit's cell - floor(hitP) + 1, 2 bits an axis
const GB_LEVEL_SHIFT: u32 = 23u;  // gFieldLevel (4 bits), then gPickL (4 bits)
// Octahedral unit vectors in a u32, 16 bits an axis (Cigolle et al. 2014, "A Survey of Efficient
// Representations for Independent Unit Vectors"; JCGT 3(2)): about 1e-4 rad.
fn gbSignNZ(v: vec2f) -> vec2f { return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0)); }
fn gbOctEnc(n0: vec3f) -> u32 {
  let n = n0 / (abs(n0.x) + abs(n0.y) + abs(n0.z));
  var p = n.xy;
  if (n.z < 0.0) { p = (1.0 - abs(n.yx)) * gbSignNZ(n.xy); }
  return pack2x16unorm(p * 0.5 + 0.5);
}
fn gbOctDec(w: u32) -> vec3f {
  let p = unpack2x16unorm(w) * 2.0 - 1.0;
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x -= t * select(-1.0, 1.0, n.x >= 0.0);
  n.y -= t * select(-1.0, 1.0, n.y >= 0.0);
  return normalize(n);
}
fn gbPix() -> vec2i { return vec2i(floor(gFragCoord)); }
// F's level, its pick, gThin and gSkyIn as the march left them (the shading and the reflection
// read the fields at the level of the brick the ray ended in, as they did after the loop)
fn gbRestore(f: u32, g2: vec4u) {
  gFieldLevel = (f >> GB_LEVEL_SHIFT) & 15u;
  gPickL = (f >> (GB_LEVEL_SHIFT + 4u)) & 15u;
  let b = unpack2x16unorm(g2.z);
  gFieldBlend = b.x;
  gPickA = b.y;
  gSkyIn = unpack2x16float(g2.w).x;
  gThin = (f & GB_THIN) != 0u;
}`;

// The march stage's end, in place of the tracer's tail: the floor's test and the thin gas's keep
// rule as the tail has them (neither reads what the shading adds), then the G-buffer.
const marchEpilogueWGSL = /* wgsl */ `
  // ---- the split march's end (shaders/world/march.js): the terminal state into the G-buffer ----
  var floorLit = false;
  if (!stop && !cut && max(trans.x, max(trans.y, trans.z)) >= RAY_MIN_TRANS && cell.y < 0 && rd.y < 0.0) {
    let tf = -ro.y / rd.y;
    hitP = ro + rd * tf;   // (the floor's point, in the hit's slot: a pixel on the floor has no other hit)
    if (!anyHit) { anyHit = true; hitPos = hitP; }
    floorLit = true;
  }
  // (what the shading adds needs a hit, and an owed reflection a surface: anyHit is final here)
  if (!anyHit && (mOp > MEDIA_KEEP_ALPHA || dot(col, vec3f(1.0)) > MEDIA_KEEP_RADIANCE)) { anyHit = true; }
  var g: GBuf;
  if (!anyHit) { return g; }
  // the first hit lies on the eye ray (nothing bends a ray before something is hit)
  let rdE = safeDir(rd0);
  let tHit = dot(hitPos - ro0, rdE) / dot(rdE, rdE);
  let bent = any(rd != rdE);
  var f = u32(hitK) | select(0u, GB_STOP, stop) | select(0u, GB_FLOOR, floorLit) | GB_HIT | select(0u, GB_THIN, gThin)
        | select(0u, GB_REFL, gReflPend) | select(0u, GB_BENT, bent) | select(0u, GB_N0, dot(hitN, hitN) == 0.0);
  if (hitK == HIT_CRISP) {
    let off = vec3u(clamp(hitCell - vec3i(floor(hitP)) + 1, vec3i(0), vec3i(2)));
    f |= ((u32(hitId) & 255u) << GB_ID_SHIFT) | (off.x << GB_OFF_SHIFT) | (off.y << (GB_OFF_SHIFT + 2u)) | (off.z << (GB_OFF_SHIFT + 4u));
  } else {
    f |= u32(clamp(hitCh + 1, 0, 7)) << GB_ID_SHIFT;
  }
  f |= (min(gFieldLevel, 15u) << GB_LEVEL_SHIFT) | (min(gPickL, 15u) << (GB_LEVEL_SHIFT + 4u));
  g.g0 = vec4u(bitcast<vec3u>(hitP), bitcast<u32>(tHit));
  g.g1 = vec4u(pack2x16float(col.xy), pack2x16float(vec2f(col.z, trans.x)), pack2x16float(trans.yz), f);
  let px = gbPix();
  var nw = 0u;
  if (dot(hitN, hitN) > 0.0) { nw = gbOctEnc(hitN); }
  var rw = 0u;
  if (bent) { rw = gbOctEnc(rd); }
  textureStore(gbG2, px, vec4u(nw, rw, pack2x16unorm(vec2f(gFieldBlend, gPickA)), pack2x16float(vec2f(gSkyIn, 0.0))));
  if (gReflPend) {
    textureStore(gbR0, px, vec4u(bitcast<vec3u>(gReflRo), gbOctEnc(gReflRd)));
    textureStore(gbR1, px, vec4u(pack2x16float(gReflEnv.xy), pack2x16float(vec2f(gReflEnv.z, gReflK.x)), pack2x16float(gReflK.yz), bitcast<u32>(gReflWf)));
  }
  return g;
}`;

// The shade stage's prologue: the tail's inputs, named as the tail names them, from the G-buffer.
const shadePrologueWGSL = /* wgsl */ `
fn shadeView(ro0: vec3f, rd0: vec3f, px: vec2i) -> VolumeHit {
  let g0 = textureLoad(gbG0, px, 0);
  let g1 = textureLoad(gbG1, px, 0);
  let g2 = textureLoad(gbG2, px, 0);
  let gf = g1.w;
  gbRestore(gf, g2);
  let rdE = safeDir(rd0);
  let c01 = unpack2x16float(g1.y);
  var col = vec3f(unpack2x16float(g1.x), c01.x);
  var trans = vec3f(c01.y, unpack2x16float(g1.z));
  var anyHit = true;
  var hitPos = ro0 + rdE * bitcast<f32>(g0.w);
  let mOp = 0.0;   // (the keep rule ran in the march)
  let hitK = i32(gf & 3u);
  let stop = (gf & GB_STOP) != 0u;
  let gbFloor = (gf & GB_FLOOR) != 0u;
  let hitP = bitcast<vec3f>(g0.xyz);
  var hitN = vec3f(0.0);
  if ((gf & GB_N0) == 0u) { hitN = gbOctDec(g2.x); }
  var rd = rdE;
  if ((gf & GB_BENT) != 0u) { rd = gbOctDec(g2.y); }
  var hitId = E_EMPTY;
  var hitCh = -1;
  var hitCell = vec3i(0);
  var hitA = vec4f(0.0);
  if (hitK == HIT_CRISP) {
    hitId = i32((gf >> GB_ID_SHIFT) & 255u);
    let off = vec3i(vec3u(gf >> GB_OFF_SHIFT, gf >> (GB_OFF_SHIFT + 2u), gf >> (GB_OFF_SHIFT + 4u)) & vec3u(3u));
    hitCell = vec3i(floor(hitP)) + off - 1;
    hitA = fetchA(hitCell);
  } else {
    hitCh = i32((gf >> GB_ID_SHIFT) & 7u) - 1;
  }
  let cut = false;   // (a cut ray has no floor: the march's test, gbFloor)
  let ro = ro0;
`;
// The tail itself, three names changed: the owed reflection is the reflect stage's (O), and the
// floor's test and point are the march's (GB_FLOOR, G0).
const shadeTail = (tail) => rewrite(tail, [
  ['let owed = reflectResolve();', 'var owed = vec3f(0.0);\n  if ((gf & GB_REFL) != 0u) { owed = textureLoad(gbO, px, 0).xyz; }'],
  ['cell.y < 0 && rd.y < 0.0', 'gbFloor'],
  ['floorHp = ro + rd * tf;', 'floorHp = hitP;'],
], 'the realistic tracer\'s shading tail');

// The reflect stage: the reflection the march deferred, at the level and thinness it left.
const reflectWGSL = /* wgsl */ `
fn reflectView(px: vec2i, f: u32) -> vec3f {
  gbRestore(f, textureLoad(gbG2, px, 0));
  let r0 = textureLoad(gbR0, px, 0);
  let r1 = textureLoad(gbR1, px, 0);
  let e = unpack2x16float(r1.y);
  gReflPend = true;
  gReflRo = bitcast<vec3f>(r0.xyz);
  gReflRd = gbOctDec(r0.w);
  gReflEnv = vec3f(unpack2x16float(r1.x), e.x);
  gReflK = vec3f(e.y, unpack2x16float(r1.z));
  gReflWf = bitcast<f32>(r1.w);
  return reflectResolve();
}`;

// Each stage's entry: the whole march's preamble (the pixel's ray, its footprint in uniform
// control flow, the cubic's eye), then the stage's work.
const preambleWGSL = /* wgsl */ `
  gFragCoord = v.position.xy;
  gAerCopy = P.aerCopy;
  let ro = FU.cam;
  let rd = safeDir(normalize(v.far.xyz / v.far.w - FU.cam));
  surfView(FU.cam, rd);   // pixel footprint for material LOD, the floor lines and F's level (uniform control flow)
  gCubicEye = gEye;
  gCubicPixAng = gPixAng;`;
const vertexWGSL = entryWGSL().slice(0, entryWGSL().indexOf('struct MarchFrag'));
const stageEntryWGSL = {
  march: () => /* wgsl */ `
struct GBuf { g0: vec4u, g1: vec4u }
${vertexWGSL}
struct MarchOut {
  @location(0) g0: vec4u,
  @location(1) g1: vec4u,
}
@fragment fn fs(v: MarchVarying) -> MarchOut {${preambleWGSL}
  var o: MarchOut;
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, P.marchNear);
  if (bh.y <= t0) { discard; return o; }
  let g = traceView(ro, rd, t0, bh);
  if ((g.g1.w & GB_HIT) == 0u) { discard; return o; }
  o.g0 = g.g0;
  o.g1 = g.g1;
  return o;
}`,
  reflect: () => /* wgsl */ `
${vertexWGSL}
@fragment fn fs(v: MarchVarying) -> @location(0) vec4f {${preambleWGSL}
  let px = gbPix();
  let f = textureLoad(gbG1, px, 0).w;
  if ((f & GB_REFL) == 0u) { discard; return vec4f(0.0); }
  return vec4f(reflectView(px, f), 0.0);
}`,
  shade: () => /* wgsl */ `
${vertexWGSL}
struct ShadeOut {
  @location(0) color: vec4f,
  @location(1) depth: f32,
}
@fragment fn fs(v: MarchVarying) -> ShadeOut {${preambleWGSL}
  var o: ShadeOut;
  let px = gbPix();
  if ((textureLoad(gbG1, px, 0).w & GB_HIT) == 0u) { discard; return o; }
  let h = shadeView(ro, rd, px);
  o.color = h.color;
  o.depth = meshCutDepth(h.depth);
  return o;
}`,
};
// What each stage takes of the tracer
const stageTrace = (stage, detail, format) => {
  const t = splitTrace(detail, format);
  if (stage === 'march') return `${t.before}${t.march.replace(TRACE_SIG, 'fn traceView(ro0: vec3f, rd0: vec3f, t0: f32, bh: vec3f) -> GBuf {')}${marchEpilogueWGSL}`;
  if (stage === 'reflect') return `${t.before}${reflectWGSL}`;
  return `${t.before}${shadePrologueWGSL}${shadeTail(t.tail)}`;
};

/** The scene pass's composite of the shade stage's colour and depth (S, D): over, at its depth, nothing where -1. */
export const compositeWGSL = () => /* wgsl */ `
// world composite (shaders/world/march.js): the split march's picture over the sky
@group(0) @binding(0) var tWorldS: texture_2d<f32>;
@group(0) @binding(1) var tWorldD: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(select(-1.0, 3.0, i == 2u), select(-1.0, 3.0, i == 1u), 0.0, 1.0);
}
struct CompositeOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(@builtin(position) pos: vec4f) -> CompositeOut {
  var o: CompositeOut;
  let px = vec2i(floor(pos.xy));
  let d = textureLoad(tWorldD, px, 0).x;
  if (d < 0.0) { discard; return o; }
  o.color = textureLoad(tWorldS, px, 0);
  o.depth = d;
  return o;
}`;
export const COMPOSITE_LAYOUT = [
  { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
];
/** The D target's clear: no hit. */
export const GBUF_NO_DEPTH = -1;

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
 * stage: 'whole' (the one-pass march), or one of MARCH_STAGES (the split march, above).
 * @param {{ view?: string, detail?: object, fixedReadFormat?: 2 | 3, stage?: string }} [opts]
 * @returns {string}
 */
export function worldMarchFrag(physGrid, { view = 'realistic', detail = {}, fixedReadFormat = 2, stage = 'whole' } = {}) {
  if (!isMaterialView(view)) throw new Error(`worldMarchFrag: ${view} is not a material view (the data views keep the box's march)`);
  if (stage !== 'whole' && (!MARCH_STAGES.includes(stage) || !marchSplits(detail))) throw new Error(`worldMarchFrag: no split stage ${stage} for this detail`);
  const whole = stage === 'whole';
  const shading = [
    `// world ${whole ? 'march' : stage}: ${view}, detail ${Object.keys(detail).filter((k) => detail[k]).sort().join(' ') || 'off'}`,
    glslMod,
    materialsGLSL(),
    worldCoreWGSL(),
    worldFieldsWGSL({ detail, cachedPick: true }),
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
    ...(whole ? [traceWorld(detail, fixedReadFormat), entryWGSL()]
      : [gbufWGSL(stage), stageTrace(stage, detail, fixedReadFormat), stageEntryWGSL[stage]()]),
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

/** The march's bind group layouts, groups 0-3 (group 1 is W's: its class's `layout` entries); a split stage's group 0 adds its G-buffer textures. */
export const WORLD_MARCH_LAYOUTS = (worldCopyLayout = WORLD_COPY_LAYOUT, stage = 'whole') => [
  [...RENDER_LAYOUT.FRAME, MESH_DEPTH_ENTRY, DECO_PLANE_ENTRY, ...(stage === 'whole' ? [] : gbLayout(stage))],
  worldCopyLayout, worldGroup2Layout(WORLD_GROUP2()), LAYOUT.PARAMS,
];
// W's group 1 layout entries (shaders/world/copy.js)
export const WORLD_COPY_LAYOUT = COPY_LAYOUT;

// premultiplied colour over what is there
const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
/**
 * The march's render pipeline description: a full-screen triangle, depth less-equal with frag_depth
 * written (the whole march and the split's composite, into the scene pass); a split stage's into its
 * own G-buffer targets, no depth.
 */
export const worldMarchPipeline = (stage = 'whole') => {
  const primitive = { topology: 'triangle-list', cullMode: 'none' };
  if (stage === 'whole' || stage === 'composite') {
    return {
      vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets: [{ format: SCENE_FORMATS.color, blend: OVER }] }, primitive,
      depthStencil: { format: SCENE_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'less-equal' },
    };
  }
  const targets = { march: [GBUF.G0, GBUF.G1], reflect: [GBUF.O], shade: [GBUF.S, GBUF.D] }[stage].map((format) => ({ format }));
  return { vertex: { entry: 'vs' }, fragment: { entry: 'fs', targets }, primitive };
};
/** The color targets each split stage renders into (GBUF keys, in location order). */
export const STAGE_TARGETS = { march: ['G0', 'G1'], reflect: ['O'], shade: ['S', 'D'] };
/** Vertices of the march's draw. */
export const WORLD_MARCH_VERTICES = 3;
/** The gpu.layout names the march's groups are made under (a warm-up making them alike finds its pipelines cached). */
export const WORLD_MARCH_LAYOUT_NAMES = ['WORLD_MARCH_FRAME', 'WORLD_COPY', 'WORLD_GROUP2'];
/** The same for a split stage (its own group 0). */
export const worldMarchLayoutNames = (stage = 'whole') => (stage === 'whole' ? WORLD_MARCH_LAYOUT_NAMES
  : [`WORLD_SPLIT_${stage.toUpperCase()}_FRAME`, ...WORLD_MARCH_LAYOUT_NAMES.slice(1)]);

// ---- check-wgsl (and its operator gate, tools/check-wgsl-operators.mjs) ----
// The realistic view at the detail levels shaders/render.js checks, and the other material views
// at the cost tiers' defaults. warm: false until the menu's warm-up (src/preload.js) builds the
// world march in place of the box's realistic volume.
const marchCheck = (name, view, detail, stage = 'whole') => ({
  name, view, detail, kind: 'render', warm: false,
  code: (g) => worldMarchFrag(g, { view, detail, stage }),
  layouts: () => WORLD_MARCH_LAYOUTS(undefined, stage),
  layoutNames: worldMarchLayoutNames(stage),
  params: MarchParams,
  ...worldMarchPipeline(stage),
});
/** The split's composite pipeline (gfx/worldView.js makes it under these names). */
export const COMPOSITE_NAME = 'world.composite';
export const COMPOSITE_LAYOUT_NAMES = ['WORLD_COMPOSITE', 'EMPTY', 'EMPTY'];
const compositeCheck = () => ({
  name: COMPOSITE_NAME, kind: 'render', warm: false, code: () => compositeWGSL(),
  layouts: () => [COMPOSITE_LAYOUT, 'EMPTY', 'EMPTY', LAYOUT.PARAMS], layoutNames: COMPOSITE_LAYOUT_NAMES,
  params: MarchParams, ...worldMarchPipeline('composite'),
});
const detailName = (detail) => Object.keys(detail).filter((k) => detail[k]).sort().join(',') || 'off';
/** A split stage's pipeline name (gfx/worldView.js and the warm-up agree on it). */
export const stagePipeName = (view, detail, stage) => `world.${view}(${detailName(detail)})${stage === 'whole' ? '' : `.${stage}`}`;
export const WGSL_CHECK = () => [
  ...['off', 'balanced', 'full'].map((k) => marchCheck(`world.realistic.${k}`, 'realistic', REALISTIC_LEVELS[k]())),
  ...['off', 'balanced'].flatMap((k) => MARCH_STAGES.map((st) => marchCheck(`world.realistic.${k}.${st}`, 'realistic', REALISTIC_LEVELS[k](), st))),
  compositeCheck(),
];

/**
 * The menu's warm-up entry (src/preload.js) for a session drawing material view `view` with the
 * drawable detail `detail` (the box volume's warm entry's): the march's pipeline as gfx/worldView.js
 * makes it, same name, code, layouts and params, so Start finds it built. Built on physics' grid.
 */
export const warmMarchCheck = (view, detail) => ({
  ...marchCheck(stagePipeName(view, detail, 'whole'), view, detail),
  physicsGrid: true,
});
/** The same, as the frame draws it: the split stages and the composite, or the whole march (warmMarchCheck). */
export const warmMarchChecks = (view, detail) => (marchSplits(detail)
  ? [...MARCH_STAGES.map((st) => ({ ...marchCheck(stagePipeName(view, detail, st), view, detail, st), physicsGrid: true })), compositeCheck()]
  : [warmMarchCheck(view, detail)]);
