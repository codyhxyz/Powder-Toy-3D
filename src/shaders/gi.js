import { lib, libLayouts } from './gfx/lib.js';
import { farGIGLSL, farLayout, WORLD_SIZE } from './farShared.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { glf } from '../glsl.js';
import { prelude, gridDims } from './common.js';
import { frameBindings, brickInfoWGSL, RENDER_LAYOUT, LAMP_MAX } from './bindings.js';
import { dirtyListsWGSL } from './fields.js';
import { DERIVED_LAYOUT, appendWGSL, foldArgsWGSL } from './passes.js';
import { isMaterialView } from '../views.js';

// Coarse global illumination for the realistic view: one light probe per
// 4×4×4 brick, rebuilt every frame in two small compute passes at brick
// resolution (docs/webgpu.md E). WGSL; the names are the GLSL version's (W2).
//
// giSourceFrag: what each brick does to light. How much of the light crossing
//   it along x, y and z it blocks (the projected coverage of its opaque cells,
//   so a one-cell plate still blocks the light crossing it, plus the optical
//   depth of liquid, glass and smoke), and the light its exposed faces send
//   back out: albedo × (sunlight from the shadow map + the hand lamps' and
//   wall torches' light by traced shadow rays + last frame's probe light at
//   that brick), plus what they give off themselves (emission():
//   lava, hot metal, luminous crystal, a live wire, a lit lamp). Feeding the
//   probes back makes bounces add up over frames, so a glowing thing lights a
//   room by bounce too. A workgroup per brick, a thread per cell.
// giGatherFrag: from each brick centre, march GI_RAYS fixed directions through
//   those bricks, collecting the light of what each ray hits and the sky or
//   ground beyond, and project it onto L1 spherical harmonics (rgb = radiance,
//   a = sky visibility). Half the probes per frame, a checkerboard that
//   alternates; the result is blended into the probe history over a few
//   frames (GI_BLEND, src/sim.js), which hides cells popping between bricks.
//   A thread per ray, two probes to a workgroup.
//
// Which bricks and probes a frame updates (src/derived.js updateGI; the
// lists below, giSelect): light only changes where something did, so the
// passes run over lists, at two rates (docs/scaling.md D9's idea, carried to
// the GI; Noita's dirty rectangles):
//   near   a brick within GI_NEAR_DILATE of one that changed within
//          GI_RECENT derived frames (shaders/fields.js GI_NEAR), or within reach
//          of a hand lamp or wall torch that moved, flickered, lit or went out:
//          its source every frame, its probe on the checkerboard (every other
//          frame, GI_BLEND), as every brick was before
//   far    the rest: a matter brick's source every GI_SRC_EVERY frames and
//          its probe every GI_BG_EVERY, blended by GI_BG_BLEND, the share
//          GI_BLEND's updates would have moved it over as many frames, so
//          the light settles over the same time
// and a brick whose state changed this frame always gets its source (the
// gather reads its coverage). Everything at the full rate (global) for
// GI_SETTLE frames after the light changes everywhere: the sun or the sky
// moves, the shadows or a far field switch, the probes start over (a reset,
// resetGI), a derived frame went without the GI, sim.incremental is off.
// giKey notes those (the inputs against what the last frame stored), giSelect
// builds the lists, giArgs their indirect arguments.
//
// Where it all lives (src/derived.js allocates it, updateGI records it):
//   giSrc     a vec4u per brick, giSource's output (giSrcWGSL below)
//   giHist    the probes' history: 4 bands of rgba as two pack2x16float words,
//             band k of brick id at k·NBRICKS + id; the gather blends into it
//   gi0..gi3  the same bands as rgba16float 3D textures, BX×BY×BZ, which the
//             volume and the figures sample with hardware trilinear filtering.
//             The gather stores the very halves it wrote to giHist, so the two
//             always agree. (rgba16float can't be read and written as a
//             storage texture in core WebGPU, hence the buffer.)
// giSource reads the bands as textures (last frame's light at its brick); the
// gather writes them: the L.LIGHTING_GISRC and L.LIGHTING_GI layouts
// (shaders/bindings.js), so no texture is sampled and written in one dispatch.
//
// The GI's own uniforms of the WebGL build are params (GiParams): which probes
// (parity), how much of the new light (blend) and whether the sun is shadowed
// (shadows). The rest comes from FrameUniforms, written on the tick that
// records the GI, with literal zeros where the WebGL GI left uCaustics, uTime
// and uFrame unset (lib's GI variants, docs/webgpu.md E).

export const GI = {
  METAL_DIFFUSE: 0.5,   // metals reflect specularly; this share of their F0 is counted as diffuse bounce
  SUN_LIFT: 0.9,        // cells toward the sun from an exposed cell's centre that its sunlight is looked up
  RAYS: 32,
  // Steps a ray marches before it takes whatever lies beyond as open sky or
  // ground: one brick each for the first NEAR_STEPS, then FAR_STRIDE bricks
  // (distant blockers only need to be roughly right).
  STEPS: 12,
  NEAR_STEPS: 6,
  FAR_STRIDE: 2,
  // A probe whose own and six neighbouring bricks all block more than this
  // along every axis is buried: no surface reads it, so it isn't traced.
  BURIED: 0.99,
  T_MIN: 0.02,          // a ray stops once this little of its light can still get through
  // How strongly a brick's light favours the side its lit faces point to
  // (0 = the same seen from anywhere; 1 = nothing from behind its lit faces).
  FACING: 1.0,
  PER_GROUP: 2,         // probes a gather workgroup traces: 64 threads, a ray each
  DIR_STEPS: 511,       // giSrc's light direction: steps per unit (10 bits a component, giSrcWGSL)
};
export const GI_RAYS = GI.RAYS;

// The gather's workgroup is PER_GROUP probes of RAYS threads, summed over a
// probe's rays by halves: 64 threads (W22) and a power-of-two ray count, or
// the reduction leaves rays out. Checked where the kernel is generated, so a
// retuned GI fails there and not in a mis-traced probe.
function gatherShape() {
  const { RAYS, PER_GROUP } = GI;
  if (!(Number.isInteger(RAYS) && RAYS > 0 && (RAYS & (RAYS - 1)) === 0 && RAYS * PER_GROUP === 64)) {
    throw new Error(`shaders/gi.js: GI.RAYS (${RAYS}) must be a power of two with GI.RAYS × GI.PER_GROUP (${PER_GROUP}) = 64`);
  }
}
gatherShape();

/**
 * The GI's params (group 3 binding 1 of both kernels): parity, the probes the
 * gather traces (-1: all, after a reset; else those with x + y + z + parity
 * odd), count, how many that is (giProbeCount), blend, the share of the new
 * light (GI_BLEND, 1 after a reset), shadows, the sun is shadowed (the shadow
 * map is bound; the WebGL GI's uShadows). list: both kernels take their
 * bricks from giSelect's lists instead (parity and count unread), and the
 * gather blends a far probe by blendBg (GI_BG_BLEND).
 */
export const GiParams = uniformStruct('GiParams', { parity: 'i32', count: 'u32', blend: 'f32', shadows: 'bool', list: 'bool', blendBg: 'f32' });

// The two rates (the header): far probes every GI_BG_EVERY frames, far
// sources every GI_SRC_EVERY; the full rate for GI_SETTLE frames after a
// global change (past the derived passes' settle, app.js, and the frames a
// reset's probes take to converge to 1e-3: 0.6^14).
export const GI_BG_EVERY = 8;
export const GI_SRC_EVERY = 4;
export const GI_SETTLE = 32;
/** A far probe's blend: what `blend` every other frame adds up to over GI_BG_EVERY frames. */
export const giBgBlend = (blend) => 1 - (1 - blend) ** (GI_BG_EVERY / 2);
const LAMP_MARGIN = 2;   // cells past a lamp's range a brick still counts as lit by it

// The lists, in giSrc's buffer after its NBRICKS vec4u (u32 words): the
// sources' and probes' append counters and lengths (their indirect
// arguments are in the lists buffer: shaders/fields.js dirtyLists gi), the
// frames left at the full rate, the spheres of the lamps
// that changed this frame (count, then a vec4f each: centre, radius; cells),
// the inputs giKey compares (KEY_WORDS) and the lamps as they were (count,
// then LAMP_MAX × pos, col, shape), then the lists: a source's entry is its
// brick number; a probe's too, with bit 31 set for a far probe.
const KEY_WORDS = 22;
export function giLists(g) {
  const n = gridDims(g).nbricks, at = 4 * n;
  const spheres = at + 16, key = spheres + 4 * 2 * LAMP_MAX, lamps = key + KEY_WORDS, src = lamps + 4 + 12 * LAMP_MAX;
  return {
    srcCount: at, prbCount: at + 1, srcLast: at + 2, prbLast: at + 3, settle: at + 12,
    sphereCount: at + 13, spheres, key, lamps, src, prb: src + n, words: src + 2 * n,
  };
}
const giListsWGSL = (g) => {
  const d = giLists(g);
  return /* wgsl */ `
// ---- giSelect's lists, in giSrc's buffer (shaders/gi.js giLists) ----
const GS_SRC_LAST: u32 = ${d.srcLast}u;
const GS_PRB_LAST: u32 = ${d.prbLast}u;
const GS_SRC: u32 = ${d.src}u;
const GS_PRB: u32 = ${d.prb}u;
const GS_FAR: u32 = 0x80000000u;   // a probe's entry: a far one's (GI_BG_BLEND)
fn gsWord(w: u32) -> u32 { return giSrc[w >> 2u][w & 3u]; }`;
};

/** The probes the gather traces at a parity (-1: every brick's; else half of them: BX is even). */
export const giProbeCount = (g, parity) => (parity < 0 ? g.nbricks : g.nbricks / 2);
/** giSource's dispatch: a workgroup per brick. */
export const giSourceDispatch = (g) => fold(g.nbricks);
/** The gather's dispatch at a parity: PER_GROUP probes a workgroup. */
export const giGatherDispatch = (g, parity) => fold(Math.ceil(giProbeCount(g, parity) / GI.PER_GROUP));

// What giSource leaves per brick for the gather, in one vec4u: one 16-byte
// load per ray step (the GLSL fetched three half-float texels):
//   x, y  rad.rg, then rad.b and cov.x, as half floats (the GLSL's RGBA16F)
//   z     cov.yz, as half floats
//   w     dir, 10 bits a component: -1..1 in steps of 1/DIR_STEPS (a half
//         float in the GLSL; it only weighs the light by facing, GI_FACING)
// Values past a half float's range saturate (the GLSL's targets made them
// infinite), and so do the probes' (giHalf2 in giBlend).
export const giSrcWGSL = /* wgsl */ `
const GI_HALF_MAX: f32 = 65504.0;
const GI_DIR_STEPS: f32 = ${glf(GI.DIR_STEPS)};
fn giHalf2(v: vec2f) -> u32 { return pack2x16float(clamp(v, vec2f(-GI_HALF_MAX), vec2f(GI_HALF_MAX))); }
fn giSrcPack(rad: vec3f, cov: vec3f, dir: vec3f) -> vec4u {
  let q = vec3u(floor(clamp(dir, vec3f(-1.0), vec3f(1.0)) * GI_DIR_STEPS + GI_DIR_STEPS + 0.5));
  return vec4u(giHalf2(rad.xy), giHalf2(vec2f(rad.z, cov.x)), giHalf2(cov.yz), q.x | (q.y << 10u) | (q.z << 20u));
}
fn giSrcRad(s: vec4u) -> vec3f { return vec3f(unpack2x16float(s.x), unpack2x16float(s.y).x); }
fn giSrcCov(s: vec4u) -> vec3f { return vec3f(unpack2x16float(s.y).y, unpack2x16float(s.z)); }
fn giSrcDir(s: vec4u) -> vec3f {
  return (vec3f(vec3u(s.w, s.w >> 10u, s.w >> 20u) & vec3u(1023u)) - GI_DIR_STEPS) / GI_DIR_STEPS;
}
`;

const paramsWGSL = `${GiParams.wgsl}@group(3) @binding(1) var<uniform> P: GiParams;`;

/**
 * GI source for grid g: a 64-thread workgroup per brick (thread = cell, x
 * fastest, then y, z: its index is the cell's bit in the opaque mask), over
 * every brick (giSourceDispatch). Bricks without matter write zeros at once.
 * The per-brick sums are reduced in workgroup memory by halves, a fixed order
 * (the GLSL's one fragment summed the cells in turn).
 * @param {{ nx: number, ny: number, nz: number }} g
 */
export const giSourceFrag = (g, { backend = 'box', worldWGSL = '' } = {}) => /* wgsl */ `
${lib(g, { variant: 'LIGHTING_GISRC', far: false, aeration: false, backend })}
${giSrcWGSL}
${backend === 'world' ? worldWGSL : paramsWGSL}
${backend === 'world' ? '' : giListsWGSL(g)}
var<workgroup> wEntry: u32;   // P.list: the list's entry, the same for the whole workgroup

const GI_METAL_DIFFUSE: f32 = ${glf(GI.METAL_DIFFUSE)};
const GI_SUN_LIFT: f32 = ${glf(GI.SUN_LIFT)};
const BRICK_CELLS: i32 = BS * BS * BS;
const FACE_CELLS: i32 = BS * BS;

fn giOpaque(c: vec3i) -> bool {
  if (c.y < 0) { return true; }
  if (outside(c)) { return false; }
  return RCLASS(eid(fetchA(c))) == R_OPAQUE;
}

// Bit of local cell l in a brick's 64-bit opaque mask (x fastest, then y, z).
fn cellBit(l: vec3i) -> u32 { return u32(l.x + BS * l.y + FACE_CELLS * l.z); }
fn maskHas(m: vec2u, b: u32) -> bool { return ((select(m.y, m.x, b < 32u) >> (b & 31u)) & 1u) != 0u; }

// The workgroup's opaque mask (2 words) and its projections along x, y, z
// (16 bits each), ORed in by the cells; then the same words and the
// translucent cells' extinction (f32 bits) and a crystal-emitter flag, read
// back by every thread at once without adding crystals to the opaque mask.
var<workgroup> wOr: array<atomic<u32>, 6>;   // word 5: a translucent crystal emits here
var<workgroup> wHead: array<u32, 7>;
// Per-cell parts of the brick's sums, reduced into [0]: pass 1 the extinction
// (wA.w); pass 2 the light leaving the exposed faces and their count (wA), and
// the light-weighted normals (wB).
var<workgroup> wA: array<vec4f, 64>;
var<workgroup> wB: array<vec4f, 64>;

fn giReduce(li: u32) {
  for (var s = 32u; s > 0u; s >>= 1u) {
    workgroupBarrier();
    if (li < s) {
      wA[li] += wA[li + s];
      wB[li] += wB[li + s];
    }
  }
  workgroupBarrier();
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  ${backend === 'world' ? `let job = foldId(wg, nwg);
  if (job >= WGI.counts.x) { return; }
  worldBeginQuery();
  let id = worldGIJobs[job].x;
  if (WGI.config.x != WA.world.w || id >= NBRICKS) { worldIncomplete = true; worldGIReport(job); return; }` : `var id = foldId(wg, nwg);
  if (P.list != 0u) {
    if (li == 0u) { wEntry = select(NBRICKS, gsWord(GS_SRC + id), id < gsWord(GS_SRC_LAST)); }
    id = workgroupUniformLoad(&wEntry);
  }
  if (id >= NBRICKS) { return; }`}
  let bc = brickCoord(id);
  gFragCoord = vec2f(f32(id) + 0.5, 0.5);   // (nothing GI calls reads it: no per-pixel jitter here)
  // a brick without matter blocks nothing and sends nothing (the brick map is
  // read-only, so this is the same for the whole workgroup)
  if (!brickMatter(brickOcc(bc))) {
    if (li == 0u) { ${backend === 'world' ? 'worldGISources[job]' : 'giSrc[id]'} = giSrcPack(vec3f(0.0), vec3f(0.0), vec3f(0.0)); }${backend === 'world' ? '\n    worldGIReport(job);' : ''}
    return;
  }
  let l = vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  let c = bc * BS + l;

  // pass 1: which cells are opaque, and the extinction of the translucent ones
  let a = fetchA(c);
  let cid = eid(a);
  let opaque = cid != E_EMPTY && RCLASS(cid) == R_OPAQUE;
  if (cid == E_CRYSTAL) { atomicOr(&wOr[5], 1u); }
  var tau = 0.0;
  if (cid != E_EMPTY && !opaque) { tau = dot(SIGMA(cid), vec3f(1.0 / 3.0)) * select(1.0, clamp(a.z, 0.0, 1.0), cid == E_SMOKE); }
  if (opaque) {
    atomicOr(&wOr[li >> 5u], 1u << (li & 31u));
    atomicOr(&wOr[2], 1u << u32(l.y + BS * l.z));   // projected along x
    atomicOr(&wOr[3], 1u << u32(l.x + BS * l.z));   // along y
    atomicOr(&wOr[4], 1u << u32(l.x + BS * l.y));   // along z
  }
  wA[li] = vec4f(0.0, 0.0, 0.0, tau);
  wB[li] = vec4f(0.0);
  giReduce(li);
  if (li == 0u) {
    for (var k = 0u; k < 5u; k++) { wHead[k] = atomicLoad(&wOr[k]); }
    wHead[5] = bitcast<u32>(wA[0].w);
    wHead[6] = atomicLoad(&wOr[5]);
  }
  let head = workgroupUniformLoad(&wHead);
  let m = vec2u(head[0], head[1]);
  let cov = vec3f(f32(countOneBits(head[2])), f32(countOneBits(head[3])), f32(countOneBits(head[4]))) / f32(FACE_CELLS);
  // translucent matter: mean extinction per cell times the brick's width
  let trans = exp(-bitcast<f32>(head[5]) * f32(BS) / f32(BRICK_CELLS));
  let covOut = 1.0 - (1.0 - cov) * trans;
  if (all(m == vec2u(0u)) && head[6] == 0u) {
    if (li == 0u) { ${backend === 'world' ? 'worldGISources[job]' : 'giSrc[id]'} = giSrcPack(vec3f(0.0), covOut, vec3f(0.0)); }${backend === 'world' ? '\n    worldGIReport(job);' : ''}
    return;
  }

  // pass 2: light leaving the exposed faces (neighbours inside the brick come
  // from the mask). Last frame's light here: sky and bounce on the faces.
  ${backend === 'world' ? 'let pr = worldGIPreviousProbe(job, bc);' : 'let pr = Probe(textureLoad(tGI0, bc, 0), textureLoad(tGI1, bc, 0), textureLoad(tGI2, bc, 0), textureLoad(tGI3, bc, 0));'}
  var rad = vec3f(0.0);
  var dir = vec3f(0.0);
  var nf = 0.0;
  // Emitters need not be opaque: crystals still light the cave through glass.
  if (opaque || cid == E_CRYSTAL) {
    var looked = false;      // albedo and emission: looked up once, if a face is exposed
    var alb = vec3f(0.0);
    var em = vec3f(0.0);     // what the cell gives off
    var sunVis = -1.0;       // likewise
    for (var f = 0; f < 6; f++) {
      var nv = vec3i(0);
      nv[f >> 1u] = select(-1, 1, (f & 1) == 0);
      let ln = l + nv;
      var covered: bool;
      if (all(ln >= vec3i(0)) && all(ln < vec3i(BS))) { covered = maskHas(m, cellBit(ln)); } else { covered = giOpaque(c + nv); }
      if (covered) { continue; }
      if (cid == E_CRYSTAL && !outside(c + nv) && eid(fetchA(c + nv)) == E_CRYSTAL) { continue; }
      if (!looked) {
        looked = true;
        alb = ALBEDO(cid) * (1.0 - METAL(cid) * (1.0 - GI_METAL_DIFFUSE));
        if (cid == E_CRYSTAL) { alb = vec3f(0.0); }   // keep its emission, not opaque diffuse paint
        em = cellEmission(cid, a.y, floor(a.w)) + sparkEmit(cid, floor(a.w));   // a live conductor, a lit lamp
      }
      let nrm = vec3f(nv);
      var e = giIrradiance(pr, nrm);
      let nl = dot(nrm, FU.sun);
      if (nl > 0.0) {
        if (sunVis < 0.0) {
          sunVis = 1.0;
          if (P.shadows != 0u) { sunVis = dot(sunShadowAt(vec3f(c) + 0.5 + FU.sun * GI_SUN_LIFT), vec3f(1.0 / 3.0)); }
        }
        e += FU.sunCol * nl * sunVis;
      }
      // and the lamps' (the torch, the lantern, the wall torches), shadowed as the sun is: so their
      // light bounces into their own shadows the way the sun's does (lighting.js lampSum)
      if (FU.lampCount > 0) { e += lampSum(vec3f(c) + 0.5 + nrm * 0.5, nrm, nrm, false); }
      let L = alb * e + em;
      rad += L;
      dir += nrm * dot(L, vec3f(1.0 / 3.0));
      nf += 1.0;
    }
  }
  wA[li] = vec4f(rad, nf);
  wB[li] = vec4f(dir, 0.0);
  giReduce(li);
  if (li == 0u) {
    let s = wA[0];
    var radOut = vec3f(0.0);
    var dirOut = vec3f(0.0);
    if (s.w > 0.0) {
      radOut = s.xyz / s.w;
      let lum = dot(s.xyz, vec3f(1.0 / 3.0));
      if (lum > 0.0) { dirOut = wB[0].xyz / lum; }
    }
    ${backend === 'world' ? 'worldGISources[job]' : 'giSrc[id]'} = giSrcPack(radOut, covOut, dirOut);
  }${backend === 'world' ? '\n  worldGIReport(job);' : ''}
}
`;

/**
 * GI gather for grid g. world: the size of the world the grid is a window of
 * (sim.world), whose far field a ray reads past its end while FrameUniforms.far
 * is on (farBeyond, shaders/farShared.js); a box takes WORLD_SIZE's, off, so a
 * box and a world share the pipeline (docs/webgpu.md E). A thread per ray,
 * PER_GROUP probes a workgroup, over giProbeCount(g, parity) probes
 * (giGatherDispatch); the probes off this frame's checkerboard aren't
 * dispatched at all, and keep their history and textures.
 * @param {{ nx: number, ny: number, nz: number }} g
 * @param {{ world?: number[] }} [opts]
 */
export const giGatherFrag = (g, { world = WORLD_SIZE, backend = 'box', worldWGSL = '' } = {}) => (gatherShape(), /* wgsl */ `
${lib(g, { variant: 'LIGHTING_GI', far: backend !== 'world', aeration: false, backend })}
${backend === 'world' ? '' : farGIGLSL(farLayout(world))}
${giSrcWGSL}
${backend === 'world' ? worldWGSL : paramsWGSL}
${backend === 'world' ? '' : giListsWGSL(g)}

const GI_RAYS: i32 = ${GI.RAYS};   // a power of two (gatherShape)
const GI_STEPS: i32 = ${backend === 'world' ? Math.ceil((g.nx + g.ny + g.nz) / 4) + 8 : GI.STEPS};
const GI_NEAR_STEPS: i32 = ${GI.NEAR_STEPS};
const GI_FAR_STRIDE: f32 = ${glf(GI.FAR_STRIDE)};
const GI_BURIED: f32 = ${glf(GI.BURIED)};
const GI_T_MIN: f32 = ${glf(GI.T_MIN)};
const GI_FACING: f32 = ${glf(GI.FACING)};
const GI_PER_GROUP: u32 = ${GI.PER_GROUP}u;   // GI_RAYS × GI_PER_GROUP = 64, the workgroup

// Ray i of GI_RAYS spread evenly over the sphere (Fibonacci lattice, y up).
fn giDir(i: i32) -> vec3f {
  let y = 1.0 - (2.0 * f32(i) + 1.0) / f32(GI_RAYS);
  let r = sqrt(max(1.0 - y * y, 0.0));
  let a = f32(i) * GOLDEN_ANGLE;
  return vec3f(r * cos(a), y, r * sin(a));
}

// What a ray from p (cells) toward d sees once it has left the bricks: the
// sky, or below the horizon the floor (in the box, with its sun shadow) and
// the ground around it.
fn beyond(p: vec3f, d: vec3f) -> vec3f {
  if (d.y >= 0.0) { return skyColor(d); }
  let pf = p + d * (-p.y / d.y);
  let grid = vec3f(GRID);
  let onFloor = pf.x >= 0.0 && pf.z >= 0.0 && pf.x < grid.x && pf.z < grid.z;
  var sun = 1.0;
  if (P.shadows != 0u && onFloor) { sun = dot(sunShadowAt(vec3f(pf.x, 0.0, pf.z)), vec3f(1.0 / 3.0)); }
  return GROUND_ALB * (FU.sunCol * max(FU.sun.y, 0.0) * sun + FU.skyUp);
}

// The brick of this frame's i-th probe: every brick in turn after a reset,
// else those with x + y + z + parity odd (half of each row along x: BX is even).
fn giProbe(i: u32) -> vec3i {
  if (P.parity < 0) { return vec3i(i32(i % u32(BX)), i32((i / u32(BX)) % u32(BY)), i32(i / u32(BX * BY))); }
  let hx = u32(BX / 2);
  let y = i32((i / hx) % u32(BY));
  let z = i32(i / (hx * u32(BY)));
  return vec3i(2 * i32(i % hx) + ((1 + P.parity + y + z) & 1), y, z);
}

// The new light blended into band k of probe id (in f32, as the WebGL
// build's blend did): into the history, and the halves it now holds are what
// the band's texture gets.
fn giBlend(k: u32, id: u32, sh: vec4f, blend: f32) -> vec4f {
  let i = k * ${backend === 'world' ? 'WGI.counts.y' : 'NBRICKS'} + id;
  let h = ${backend === 'world' ? 'worldGIHistory' : 'giHist'}[i];
  let v = mix(vec4f(unpack2x16float(h.x), unpack2x16float(h.y)), sh, blend);
  let w = vec2u(giHalf2(v.xy), giHalf2(v.zw));
  ${backend === 'world' ? 'worldGIHistory' : 'giHist'}[i] = w;
  return vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
}

// Each thread's ray, projected (bands 0, 1x, 1y, 1z: rgb radiance, a sky
// visibility), then summed over the probe's rays by halves.
var<workgroup> wSH: array<array<vec4f, 4>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let probe = foldId(wg, nwg) * GI_PER_GROUP + li / u32(GI_RAYS);
  let ray = li % u32(GI_RAYS);
  // (past the end on the last workgroup: it still reaches the barriers)
  var live = false;
  var bc = vec3i(0);
  var blend = P.blend;
  ${backend === 'world' ? `worldBeginQuery();
  live = probe < WGI.counts.y;
  if (live) {
    let entry = worldGIJobs[WGI.counts.x + probe];
    bc = brickCoord(entry.x);
    if ((entry.y & 1u) != 0u) { blend = P.blendBg; }
    blend = worldGIJobBlend(blend, entry.y);
    if (entry.x >= NBRICKS || WGI.config.x != WA.world.w) { worldIncomplete = true; }
  }` : `if (P.list != 0u) {
    live = probe < gsWord(GS_PRB_LAST);
    if (live) {
      let w = gsWord(GS_PRB + probe);
      bc = brickCoord(w & ~GS_FAR);
      if ((w & GS_FAR) != 0u) { blend = P.blendBg; }
    }
  } else {
    live = probe < P.count;
    if (live) { bc = giProbe(probe); }
  }`}
  gFragCoord = vec2f(f32(brickId(bc)) + 0.5, 0.5);   // (nothing GI calls reads it: no per-pixel jitter here)
  let bmax = vec3i(BX, BY, BZ);
  var blk = 1.0;
  ${backend === 'world' ? 'if (live) { ' : ''}for (var k = 0; k < 7; k++) {
    var b = bc;
    if (k > 0) { b[(k - 1) >> 1u] += select(-1, 1, (k & 1) == 1); }
    if (any(b < vec3i(0)) || any(b >= bmax)) { blk = 0.0; break; }
    let cv = giSrcCov(${backend === 'world' ? 'worldGISourceStaged(b)' : 'giSrc[brickId(b)]'});
    blk = min(blk, min(cv.x, min(cv.y, cv.z)));
  }${backend === 'world' ? ' }' : ''}
  var sh = array<vec4f, 4>(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  // a buried probe gathers nothing: its light fades out of the history
  if (live && blk <= GI_BURIED) {
    let pc = vec3f(bc) + 0.5;   // probe, in bricks
    let d = giDir(i32(ray));
    let d2 = d * d;
    var T = 1.0;
    var L = vec3f(0.0);
    var q = pc;
    // the probe's own brick is skipped: surfaces read the probes from in front of them
    for (var k = 0; k < GI_STEPS; k++) {
      if (k < GI_NEAR_STEPS) { q += d; } else { q += d * GI_FAR_STRIDE; }
      let b = vec3i(floor(q));
      if (any(b < vec3i(0)) || any(b >= bmax)) { break; }
      let s = ${backend === 'world' ? 'worldGISourceStaged(b)' : 'giSrc[brickId(b)]'};
      var a = dot(giSrcCov(s), d2);
      if (a <= 0.0) { continue; }
      let nd = giSrcDir(s);
      if (k >= GI_NEAR_STEPS) { a = 1.0 - pow(1.0 - a, GI_FAR_STRIDE); }   // the stride crosses that many such bricks
      L += T * a * giSrcRad(s) * max(1.0 - GI_FACING * dot(nd, d), 0.0);
      T *= 1.0 - a;
      if (T < GI_T_MIN) { break; }
    }
    var open = 1.0;
    if (T >= GI_T_MIN) {
      ${backend === 'world' ? `if (all(q >= vec3f(0.0)) && all(q < vec3f(bmax))) { worldIncomplete = true; }
      else { L += T * beyond(pc * f32(BS), d); }` : 'if (FU.far != 0u) { L += T * farBeyond(pc * f32(BS), q * f32(BS), d, &open); } else { L += T * beyond(pc * f32(BS), d); }'}
    }
    var vis = 0.0;
    if (d.y > 0.0) { vis = T * open; }
    let y = vec4f(SH_Y0, SH_Y1 * d);
    sh = array<vec4f, 4>(vec4f(L * y.x, vis * y.x), vec4f(L * y.y, vis * y.y), vec4f(L * y.z, vis * y.z), vec4f(L * y.w, vis * y.w));
  }
  wSH[li] = sh;
  for (var s = u32(GI_RAYS) / 2u; s > 0u; s >>= 1u) {
    workgroupBarrier();
    if (ray < s) { for (var k = 0; k < 4; k++) { wSH[li][k] += wSH[li + s][k]; } }
  }
  if (ray == 0u && live) {
    let w = 4.0 * PI_L / f32(GI_RAYS);   // Monte Carlo weight: sphere area per ray
    let id = ${backend === 'world' ? 'probe' : 'brickId(bc)'};
    ${backend === 'world' ? `giBlend(0u, id, wSH[li][0] * w, blend);
    giBlend(1u, id, wSH[li][1] * w, blend);
    giBlend(2u, id, wSH[li][2] * w, blend);
    giBlend(3u, id, wSH[li][3] * w, blend);` : `textureStore(tGI0, bc, giBlend(0u, id, wSH[li][0] * w, blend));
    textureStore(tGI1, bc, giBlend(1u, id, wSH[li][1] * w, blend));
    textureStore(tGI2, bc, giBlend(2u, id, wSH[li][2] * w, blend));
    textureStore(tGI3, bc, giBlend(3u, id, wSH[li][3] * w, blend));`}
  }${backend === 'world' ? '\n  if (live) { worldGIReport(WGI.counts.x + probe); }' : ''}
}
`);

// ---- the lists (the header; src/derived.js updateGI) ----
// mode: 0 the two rates (unless giKey found a global change within
// GI_SETTLE frames), 1 everything at the full rate (src/derived.js: a derived
// frame went without the GI, the probes started over, sim.incremental off),
// 2 a reset (every source and every probe, replaced); parity: this frame's
// checkerboard; phase: the far probes' turn (frame % GI_BG_EVERY), srcPhase
// the far sources' (frame % GI_SRC_EVERY); shadows: as GiParams'; allSrc:
// every brick's source (giSrc didn't move with a window shift: the probes did).
export const GiSelectParams = uniformStruct('GiSelectParams', { mode: 'u32', parity: 'u32', phase: 'u32', srcPhase: 'u32', shadows: 'bool', allSrc: 'bool' });
const giBookWGSL = (g) => {
  const d = giLists(g);
  return /* wgsl */ `
${prelude(g, { state: false })}
${frameBindings()}
${brickInfoWGSL}
${dirtyListsWGSL(g)}
${GiSelectParams.wgsl}
@group(3) @binding(1) var<uniform> P: GiSelectParams;
@group(2) @binding(0) var<storage, read> age: array<u32>;
@group(2) @binding(1) var<storage, read> brick: array<u32>;   // the brick map: 4 words a brick, the info word last
@group(2) @binding(2) var<storage, read_write> gs: array<atomic<u32>>;   // giSrc's buffer
@group(2) @binding(3) var<storage, read_write> dlist: array<atomic<u32>>;   // GI_NEAR; the indirect arguments (DL_GI)
const GS_SRC_COUNT: u32 = ${d.srcCount}u;
const GS_PRB_COUNT: u32 = ${d.prbCount}u;
const GS_SRC_LAST: u32 = ${d.srcLast}u;
const GS_PRB_LAST: u32 = ${d.prbLast}u;
const GS_SETTLE: u32 = ${d.settle}u;
const GS_SPHERE_COUNT: u32 = ${d.sphereCount}u;
const GS_SPHERES: u32 = ${d.spheres}u;
const GS_KEY: u32 = ${d.key}u;
const GS_LAMPS: u32 = ${d.lamps}u;
const GS_SRC: u32 = ${d.src}u;
const GS_PRB: u32 = ${d.prb}u;
const GS_FAR: u32 = 0x80000000u;
const GI_SETTLE: u32 = ${GI_SETTLE}u;
const GI_PER_GROUP: u32 = ${GI.PER_GROUP}u;
const LAMP_MARGIN: f32 = ${glf(LAMP_MARGIN)};
fn gsLoad(w: u32) -> u32 { return atomicLoad(&gs[w]); }
fn gsStore(w: u32, v: u32) { atomicStore(&gs[w], v); }`;
};
// giKey: one thread. The inputs that light every brick (the sun, the sky,
// the ground, the key light, a cave's ambient, the far field's switch, the
// shadows, the map's size, the cloud deck's switch) against the last frame's:
// a change, or mode != 0, starts GI_SETTLE frames at the full rate. The
// clouds' drift isn't one: it moves every frame, slowly (the far rate takes
// it). And the lamps (FrameUniforms' lamps against the last frame's): each one
// that moved, changed colour or size (a flame's flicker), lit or went out puts
// its sphere of light as it was and as it is on the list giSelect reads.
export const giKeyFrag = (g) => /* wgsl */ `
${giBookWGSL(g)}
@compute @workgroup_size(1)
fn main() {
  var key = array<u32, ${KEY_WORDS}>(
    bitcast<u32>(FU.sun.x), bitcast<u32>(FU.sun.y), bitcast<u32>(FU.sun.z),
    bitcast<u32>(FU.sunCol.x), bitcast<u32>(FU.sunCol.y), bitcast<u32>(FU.sunCol.z),
    bitcast<u32>(FU.skyUp.x), bitcast<u32>(FU.skyUp.y), bitcast<u32>(FU.skyUp.z),
    bitcast<u32>(FU.ground.x), bitcast<u32>(FU.ground.y), bitcast<u32>(FU.ground.z),
    bitcast<u32>(FU.keyLight.x), bitcast<u32>(FU.keyLight.y), bitcast<u32>(FU.keyLight.z),
    bitcast<u32>(FU.caveAmbient.x), bitcast<u32>(FU.caveAmbient.y), bitcast<u32>(FU.caveAmbient.z),
    FU.far, P.shadows, u32(FU.shadowRes), FU.clouds);
  var changed = P.mode != 0u;
  for (var k = 0u; k < ${KEY_WORDS}u; k++) {
    if (gsLoad(GS_KEY + k) != key[k]) { changed = true; }
    gsStore(GS_KEY + k, key[k]);
  }
  if (changed) { gsStore(GS_SETTLE, GI_SETTLE); }
  let was = gsLoad(GS_LAMPS);
  let now = u32(clamp(FU.lampCount, 0, LAMP_MAX));
  var n = 0u;
  for (var i = 0u; i < u32(LAMP_MAX); i++) {
    let at = GS_LAMPS + 4u + 12u * i;
    var cur = array<vec4u, 3>(bitcast<vec4u>(FU.lampPos[i]), bitcast<vec4u>(FU.lampCol[i]), bitcast<vec4u>(FU.lampShape[i]));
    var old: array<vec4u, 3>;
    var same = (i < was) == (i < now);
    for (var c = 0u; c < 3u; c++) {
      for (var j = 0u; j < 4u; j++) {
        old[c][j] = gsLoad(at + 4u * c + j);
        gsStore(at + 4u * c + j, cur[c][j]);
      }
      if (i < now && any(old[c] != cur[c])) { same = false; }
    }
    if (same) { continue; }
    for (var side = 0u; side < 2u; side++) {
      if ((side == 0u && i < was) || (side == 1u && i < now)) {
        var pos = bitcast<vec4f>(cur[0]);
        var shape = bitcast<vec4f>(cur[2]);
        if (side == 0u) {
          pos = bitcast<vec4f>(old[0]);
          shape = bitcast<vec4f>(old[2]);
        }
        let r = pos.w + shape.x + 0.5 * shape.y + LAMP_MARGIN;   // its range, from its tube's surface
        let s = GS_SPHERES + 4u * n;
        gsStore(s, bitcast<u32>(pos.x));
        gsStore(s + 1u, bitcast<u32>(pos.y));
        gsStore(s + 2u, bitcast<u32>(pos.z));
        gsStore(s + 3u, bitcast<u32>(r));
        n++;
      }
    }
  }
  gsStore(GS_LAMPS, now);
  gsStore(GS_SPHERE_COUNT, n);
}
`;
// giSelect: a thread per brick. Its source and its probe onto the lists, as
// the header's rates say: the brick is near (GI_NEAR, or in a changed lamp's
// sphere) or far; a source also when the brick's state changed this frame.
export const giSelectFrag = (g) => /* wgsl */ `
${giBookWGSL(g)}
${appendWGSL('appendSrc', 'gs', 'GS_SRC_COUNT', 'GS_SRC')}
${appendWGSL('appendPrb', 'gs', 'GS_PRB_COUNT', 'GS_PRB')}
// in the sphere of a lamp that changed (giKey)?
fn lampNear(bc: vec3i) -> bool {
  let lo = vec3f(bc * BS);
  let hi = lo + f32(BS);
  let n = gsLoad(GS_SPHERE_COUNT);
  for (var i = 0u; i < n; i++) {
    let s = GS_SPHERES + 4u * i;
    let c = vec3f(bitcast<f32>(gsLoad(s)), bitcast<f32>(gsLoad(s + 1u)), bitcast<f32>(gsLoad(s + 2u)));
    let r = bitcast<f32>(gsLoad(s + 3u));
    let d = c - clamp(c, lo, hi);
    if (dot(d, d) <= r * r) { return true; }
  }
  return false;
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  var src = false;
  var prb = false;
  var far = false;
  if (b < NBRICKS) {
    let bc = brickCoord(b);
    let board = ((bc.x + bc.y + bc.z + i32(P.parity)) & 1) == 1;   // the gather's checkerboard (giProbe)
    if (P.mode == 2u) {
      src = true;
      prb = true;
    } else if (P.mode != 0u || gsLoad(GS_SETTLE) != 0u) {
      src = true;
      prb = board;
    } else {
      let near = (atomicLoad(&dlist[DL_EMASK + b]) & GI_NEAR) != 0u || lampNear(bc);
      let changed = (age[b] & AGE_MASK) == 0u;
      let matter = brickMatter(brick[4u * b + 3u]);
      src = changed || (matter && (near || u32((bc.x & 1) | ((bc.z & 1) << 1u)) == P.srcPhase));
      if (near) {
        prb = board;
      } else {
        prb = u32((bc.x & 1) | ((bc.y & 1) << 1u) | ((bc.z & 1) << 2u)) == P.phase;
        far = true;
      }
    }
  }
  appendSrc(src || (P.allSrc != 0u && b < NBRICKS), b, li);
  appendPrb(prb, b | select(0u, GS_FAR, far), li);
}
`;
// giArgs: one thread. The lists' lengths, and their indirect arguments in
// the lists buffer (DL_GI: giSource a workgroup per entry, the gather
// GI.PER_GROUP entries a workgroup), the counters back to 0, a frame off the
// full rate's.
export const giArgsFrag = (g) => /* wgsl */ `
${giBookWGSL(g)}
${foldArgsWGSL}
fn putArgs(at: u32, a: vec3u) {
  atomicStore(&dlist[at], a.x);
  atomicStore(&dlist[at + 1u], a.y);
  atomicStore(&dlist[at + 2u], a.z);
}
@compute @workgroup_size(1)
fn main() {
  let s = gsLoad(GS_SRC_COUNT);
  let p = gsLoad(GS_PRB_COUNT);
  gsStore(GS_SRC_LAST, s);
  gsStore(GS_PRB_LAST, p);
  gsStore(GS_SRC_COUNT, 0u);
  gsStore(GS_PRB_COUNT, 0u);
  putArgs(DL_GI, foldArgs(s));
  putArgs(DL_GI + 4u, foldArgs((p + GI_PER_GROUP - 1u) / GI_PER_GROUP));
  let left = gsLoad(GS_SETTLE);
  if (left > 0u) { gsStore(GS_SETTLE, left - 1u); }
}
`;

// The gpu.layout names of each kernel's groups 0-2 (src/derived.js makes its
// layouts under them, so a warm-up under the same names builds the very
// pipelines it then finds in the cache, B5).
export const GI_LAYOUT_NAMES = {
  giSource: ['FRAME', 'STATE_RO', 'LIGHTING_GISRC'],
  giGather: ['FRAME', 'STATE_RO', 'LIGHTING_GI'],
  giKey: ['FRAME', null, 'DERIVED_GI_SELECT'],
  giSelect: ['FRAME', null, 'DERIVED_GI_SELECT'],
  giArgs: ['FRAME', null, 'DERIVED_GI_SELECT'],
};

/**
 * tools/check-wgsl.mjs, and the menu's warm-up (B5): both kernels, for a
 * session in the realistic view (the only one with GI, as the WebGL app ran it;
 * warm() says so). The gather's code(g, { world }) takes the world the grid is
 * a window of, as derived.giKernels() builds it (a box: WORLD_SIZE's), so a
 * warm-up for a world session builds the very module the session then asks for.
 */
export const WGSL_CHECK = () => [
  {
    name: 'giSource', kind: 'compute', code: (g) => giSourceFrag(g), layouts: () => libLayouts('LIGHTING_GISRC'),
    layoutNames: GI_LAYOUT_NAMES.giSource, params: GiParams, workgroupSize: [64, 1, 1],
    dispatch: (g) => giSourceDispatch(g), warm: ({ view }) => isMaterialView(view),
  },
  {
    name: 'giGather', kind: 'compute', code: (g, { world } = {}) => giGatherFrag(g, { world }), layouts: () => libLayouts('LIGHTING_GI'),
    layoutNames: GI_LAYOUT_NAMES.giGather, params: GiParams, workgroupSize: [64, 1, 1],
    dispatch: (g) => [giGatherDispatch(g, -1), giGatherDispatch(g, 0)], warm: ({ view }) => isMaterialView(view),
  },
  ...[['giKey', giKeyFrag, [1, 1, 1], 1], ['giSelect', giSelectFrag, (g) => fold(Math.ceil(gridDims(g).nbricks / 64)), 64],
    ['giArgs', giArgsFrag, [1, 1, 1], 1]].map(([name, code, dispatch, size]) => ({
    name, kind: 'compute', code, layouts: () => [RENDER_LAYOUT.FRAME, 'EMPTY', DERIVED_LAYOUT.GI_SELECT],
    layoutNames: GI_LAYOUT_NAMES[name], params: GiSelectParams, workgroupSize: [size, 1, 1],
    dispatch: typeof dispatch === 'function' ? dispatch : () => dispatch, warm: ({ view }) => isMaterialView(view),
  })),
];
