import { lib, libLayouts } from './gfx/lib.js';
import { farGIGLSL, farLayout, WORLD_SIZE } from './farShared.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

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
 * map is bound; the WebGL GI's uShadows).
 */
export const GiParams = uniformStruct('GiParams', { parity: 'i32', count: 'u32', blend: 'f32', shadows: 'bool' });

/** The probes the gather traces at a parity (-1: every brick's; else half of them: BX is even). */
export const giProbeCount = (g, parity) => (parity < 0 ? g.nbricks : g.nbricks / 2);
/** giSource's dispatch: a workgroup per brick. */
export const giSourceDispatch = (g) => fold(g.nbricks);
/** The gather's dispatch at a parity: PER_GROUP probes a workgroup. */
export const giGatherDispatch = (g, parity) => fold(Math.ceil(giProbeCount(g, parity) / GI.PER_GROUP));

const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// What giSource leaves per brick for the gather, in one vec4u: one 16-byte
// load per ray step (the GLSL fetched three half-float texels):
//   x, y  rad.rg, then rad.b and cov.x, as half floats (the GLSL's RGBA16F)
//   z     cov.yz, as half floats
//   w     dir, 10 bits a component: -1..1 in steps of 1/DIR_STEPS (a half
//         float in the GLSL; it only weighs the light by facing, GI_FACING)
// Values past a half float's range saturate (the GLSL's targets made them
// infinite), and so do the probes' (giHalf2 in giBlend).
const giSrcWGSL = /* wgsl */ `
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
export const giSourceFrag = (g) => /* wgsl */ `
${lib(g, { variant: 'LIGHTING_GISRC', far: false, aeration: false })}
${giSrcWGSL}
${paramsWGSL}

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
// translucent cells' extinction (f32 bits), read back by every thread at once.
var<workgroup> wOr: array<atomic<u32>, 5>;
var<workgroup> wHead: array<u32, 6>;
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
  let id = foldId(wg, nwg);
  if (id >= NBRICKS) { return; }
  let bc = brickCoord(id);
  gFragCoord = vec2f(f32(id) + 0.5, 0.5);   // (nothing GI calls reads it: no per-pixel jitter here)
  // a brick without matter blocks nothing and sends nothing (the brick map is
  // read-only, so this is the same for the whole workgroup)
  if (!brickMatter(brickOcc(bc))) {
    if (li == 0u) { giSrc[id] = giSrcPack(vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
    return;
  }
  let l = vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  let c = bc * BS + l;

  // pass 1: which cells are opaque, and the extinction of the translucent ones
  let a = fetchA(c);
  let cid = eid(a);
  let opaque = cid != E_EMPTY && RCLASS(cid) == R_OPAQUE;
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
  }
  let head = workgroupUniformLoad(&wHead);
  let m = vec2u(head[0], head[1]);
  let cov = vec3f(f32(countOneBits(head[2])), f32(countOneBits(head[3])), f32(countOneBits(head[4]))) / f32(FACE_CELLS);
  // translucent matter: mean extinction per cell times the brick's width
  let trans = exp(-bitcast<f32>(head[5]) * f32(BS) / f32(BRICK_CELLS));
  let covOut = 1.0 - (1.0 - cov) * trans;
  if (all(m == vec2u(0u))) {
    if (li == 0u) { giSrc[id] = giSrcPack(vec3f(0.0), covOut, vec3f(0.0)); }
    return;
  }

  // pass 2: light leaving the exposed faces (neighbours inside the brick come
  // from the mask). Last frame's light here: sky and bounce on the faces.
  let pr = Probe(textureLoad(tGI0, bc, 0), textureLoad(tGI1, bc, 0), textureLoad(tGI2, bc, 0), textureLoad(tGI3, bc, 0));
  var rad = vec3f(0.0);
  var dir = vec3f(0.0);
  var nf = 0.0;
  if (opaque) {
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
      if (!looked) {
        looked = true;
        alb = ALBEDO(cid) * (1.0 - METAL(cid) * (1.0 - GI_METAL_DIFFUSE));
        em = cellEmission(cid, a.y) + sparkEmit(cid, floor(a.w));   // a live conductor, a lit lamp
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
    giSrc[id] = giSrcPack(radOut, covOut, dirOut);
  }
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
export const giGatherFrag = (g, { world = WORLD_SIZE } = {}) => (gatherShape(), /* wgsl */ `
${lib(g, { variant: 'LIGHTING_GI', far: true, aeration: false })}
${farGIGLSL(farLayout(world))}
${giSrcWGSL}
${paramsWGSL}

const GI_RAYS: i32 = ${GI.RAYS};   // a power of two (gatherShape)
const GI_STEPS: i32 = ${GI.STEPS};
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
fn giBlend(k: u32, id: u32, sh: vec4f) -> vec4f {
  let i = k * NBRICKS + id;
  let h = giHist[i];
  let v = mix(vec4f(unpack2x16float(h.x), unpack2x16float(h.y)), sh, P.blend);
  let w = vec2u(giHalf2(v.xy), giHalf2(v.zw));
  giHist[i] = w;
  return vec4f(unpack2x16float(w.x), unpack2x16float(w.y));
}

// Each thread's ray, projected (bands 0, 1x, 1y, 1z: rgb radiance, a sky
// visibility), then summed over the probe's rays by halves.
var<workgroup> wSH: array<array<vec4f, 4>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let probe = foldId(wg, nwg) * GI_PER_GROUP + li / u32(GI_RAYS);
  let ray = li % u32(GI_RAYS);
  let live = probe < P.count;   // (past the end on the last workgroup: it still reaches the barriers)
  var bc = vec3i(0);
  if (live) { bc = giProbe(probe); }
  gFragCoord = vec2f(f32(brickId(bc)) + 0.5, 0.5);   // (nothing GI calls reads it: no per-pixel jitter here)
  let bmax = vec3i(BX, BY, BZ);
  var blk = 1.0;
  for (var k = 0; k < 7; k++) {
    var b = bc;
    if (k > 0) { b[(k - 1) >> 1u] += select(-1, 1, (k & 1) == 1); }
    if (any(b < vec3i(0)) || any(b >= bmax)) { blk = 0.0; break; }
    let cv = giSrcCov(giSrc[brickId(b)]);
    blk = min(blk, min(cv.x, min(cv.y, cv.z)));
  }
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
      let s = giSrc[brickId(b)];
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
      if (FU.far != 0u) { L += T * farBeyond(pc * f32(BS), q * f32(BS), d, &open); } else { L += T * beyond(pc * f32(BS), d); }
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
    let id = brickId(bc);
    textureStore(tGI0, bc, giBlend(0u, id, wSH[li][0] * w));
    textureStore(tGI1, bc, giBlend(1u, id, wSH[li][1] * w));
    textureStore(tGI2, bc, giBlend(2u, id, wSH[li][2] * w));
    textureStore(tGI3, bc, giBlend(3u, id, wSH[li][3] * w));
  }
}
`);

// The gpu.layout names of each kernel's groups 0-2 (src/derived.js makes its
// layouts under them, so a warm-up under the same names builds the very
// pipelines it then finds in the cache, B5).
export const GI_LAYOUT_NAMES = {
  giSource: ['FRAME', 'STATE_RO', 'LIGHTING_GISRC'],
  giGather: ['FRAME', 'STATE_RO', 'LIGHTING_GI'],
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
    dispatch: (g) => giSourceDispatch(g), warm: ({ view }) => view === 'realistic',
  },
  {
    name: 'giGather', kind: 'compute', code: (g, { world } = {}) => giGatherFrag(g, { world }), layouts: () => libLayouts('LIGHTING_GI'),
    layoutNames: GI_LAYOUT_NAMES.giGather, params: GiParams, workgroupSize: [64, 1, 1],
    dispatch: (g) => [giGatherDispatch(g, -1), giGatherDispatch(g, 0)], warm: ({ view }) => view === 'realistic',
  },
];
