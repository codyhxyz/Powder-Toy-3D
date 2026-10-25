import { libChecks } from './lib.js';
import { ddaWalk } from '../dda.js';
import { CUBIC_ERR, CUBIC_ERR_PX_NONE, CUBIC_ERR_PX_FULL } from '../../gfx/detail.js';
import { glf as f } from '../../glsl.js';
import { occupancyReadWGSL } from '../occupancy.js';

/** DDA steps past the corner-to-corner count (NX + NY + NZ) a march may take (MAX_STEPS). */
export const DDA_SPARE_STEPS = 8;

// Shared render core: brick and field access, the DDA helpers and the
// smooth-surface machinery (sampling, root finding, normals), in WGSL (the
// names are the GLSL version's, docs/webgpu.md W2). The state is read with
// the prelude's fetchA/fetchB (shaders/common.js, STATE_OPTS.STATE_RO); the
// brick map, the fields and the flow come from the lighting group
// (shaders/bindings.js lightingBindings), the per-frame values from
// FrameUniforms (FU: what were uView, uShadows, uTime, uLightGain, uFrame,
// uSimClock and uPixScale, the output pixel's size in rendered pixels).
// shaders/gfx/lib.js assembles it after those. Its binding-free part (the
// grid, cells and the DDA's ray helpers) is ddaGLSL below, for kernels that
// walk the state without the lighting group.
//
// Volumes are 3D textures (docs/webgpu.md E, W14): texel (x, y, z) of the
// fields is cell (x, y, z); of the light and the GI probes, brick (x, y, z).
// Every read is a textureSampleLevel at level 0 (nothing has mips; implicit
// derivatives aren't allowed in the marches' non-uniform control flow, H1.18),
// through linearClamp, after the coordinate is clamped to the edge texels'
// centres as the atlases clamped it.
//
// opts.flow: declare cellFlow (it reads the flow buffer, binding 18, which
// the GI gather's writer layout drops). opts.detail: the close-up detail's
// defines (gfx/detail.js, as shaders/gfx/surface.js takes them); this module
// reads DETAIL_CUBIC_CLOSE (cubicClose), a template switch as #ifdef was
// (docs/webgpu.md F2).
//
// The GLSL's BRICK_DIST_IN_LIGHT (the realistic view read its bricks'
// empty-space distance from the light volume's alpha, to free a texture unit
// for gfx/meshCut.js) has no WGSL side: brickDist is a storage buffer here
// (binding 17, brickDistAt), not one of the 16 sampled textures, and the
// light blur copied the same integer, so skipEmpty reads it from brickDist in
// every view.
export const coreGLSL = (g, { flow = true, detail = {} } = {}) => /* wgsl */ `
${ddaGLSL(g)}
// The pixel whose noise a function draws (ign, pixRand, the glow candidates,
// the clouds' jitter): what gl_FragCoord.xy was. Every entry point sets it
// first: a fragment shader to @builtin(position).xy (pixel centres, top-left
// origin), a compute kernel to its own texel's centre.
var<private> gFragCoord: vec2f;
${flow ? `
// How fast matter has been moving through cell c (cells/step; c in the grid):
// the move's flow field, one vec2u per slot holding x, y and z as f16
// (pack2x16float) and a zero (docs/webgpu.md C1).
fn cellFlow(c: vec3i) -> vec3f {
  let w = flow[slotOf(c)];
  return vec3f(unpack2x16float(w.x), unpack2x16float(w.y).x);
}` : ''}
// ---- bricks (the brick map: shaders/bindings.js BrickInfo) ----
// Brick bc's info word: 0 empty; with BRICK_MATTER (brickMatter) it holds
// matter (brickBits, brickGas); without, it holds only air the data views
// draw (brickAir). bc in the grid.
fn brickOcc(bc: vec3i) -> u32 { return brickAt(bc).info; }
// The realistic view's test: 0 = skip the brick (empty or air only), else its
// info word, for the brick* predicates below.
fn brickInfo(bc: vec3i) -> u32 { return brickInfoOf(brickId(bc)); }
// The same by brick number (brickId), for a march that keeps it for the
// brick's occupancy too (occMaskOf, occIdOf).
fn brickInfoOf(id: u32) -> u32 {
  let w = brick[id].info;
  return select(0u, w, brickMatter(w));
}
fn brickHas(f: u32, bit: u32) -> bool { return (f & bit) != 0u; }
fn brickMedia(f: u32) -> bool { return brickHas(f, BRICK_MEDIA); }
fn brickSurf(f: u32) -> bool { return brickHas(f, BRICK_SURF); }
fn brickOpaque(f: u32) -> bool { return brickHas(f, BRICK_OPAQUE); }   // crisp or opaque smooth matter
fn brickThin(f: u32) -> bool { return brickHas(f, BRICK_THIN); }       // thin cubic matter (drops, grains): read cubic
fn brickMixed(f: u32) -> bool { return brickHas(f, BRICK_MIXED); }     // more than one liquid
fn brickFilm(f: u32) -> bool { return brickHas(f, BRICK_FILM); }       // a film here or beside (gfx/film.js filmHit)
${occupancyReadWGSL}

// Certify the entire brick's sampling support, not just its cells. At a brick
// face, trilinear reaches one neighbouring texel; cubic B-splines reach two.
// Both are convex combinations, as is their thin/close blend. The 3³ brick
// neighbourhood covers all these taps (including edge-clamped samples).
// Read once per entered brick, only when its own texels are certified. Reading
// neighbours here avoids stale halo certificates after a dirty update/shift.
fn liquidInterior(bc: vec3i) -> bool {
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0 && z == 0) { continue; }
        let q = clamp(bc + vec3i(x, y, z), vec3i(0), vec3i(BX, BY, BZ) - 1);
        if ((brickOcc(q) & BRICK_LIQUID_INTERIOR) == 0u) { return false; }
      }
    }
  }
  return true;
}

// ---- brick skipping (the brick map and brickDist; skipBrick: shaders/dda.js) ----
// Jump the DDA out of the empty region around empty brick bc: every brick
// within (distance - 1) of it is empty (brickDistAt, built by the derived
// passes), so the ray crosses that whole cube in one step. Same contract as
// skipBrick. Only for walks that treat a brick without matter as empty (not
// the data views, which also visit flagged air).
fn skipEmpty(bc: vec3i, ro: vec3f, rd: vec3f, istp: vec3i,
             cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  let r = max(brickDistAt(bc), 0);
  // kept inside the box: a ray leaving it must leave through the face it
  // really crosses (the floor below all, which the callers shade)
  let bmin = vec3f(max(bc - r, vec3i(0)) * BS);
  let bmax = vec3f(min(bc + r + 1, vec3i(BX, BY, BZ)) * BS);
  return ddaJumpBox(bmin, bmax, ro, rd, istp, cell, tMax, tEnter);
}

// ---- continuous fields ----
// A smooth surface is where its field crosses this level (shaders/fields.js
// builds them so: inside > SURF_ISO > outside).
const SURF_ISO: f32 = 0.5;
// Field t at grid point p, hardware trilinear (one tap; the 2D atlas took two
// and a lerp). p is held to the edge cells' centres: the grid extends by its edge.
fn fieldTex(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let q = clamp(p, vec3f(0.5), vec3f(GRID) - 0.5);
  return textureSampleLevel(t, linearClamp, q / vec3f(GRID), 0.0);
}
fn surfField(p: vec3f) -> vec4f { return fieldTex(tFS, p); }    // the smooth-surface fields, by channel (CH_*)
fn mediaField(p: vec3f) -> vec4f { return fieldTex(tFM, p); }   // the media fields

// Cubic B-spline sample of field t at p (cell values are its control points).
// Trilinear interpolation of a lone peak has octahedral isosurfaces, so drops
// drawn from it are faceted gems; the B-spline's kernel is smooth (C²) and
// nearly radial, so they come out round and their normals smooth. Sigg &
// Hadwiger's trick (GPU Gems 2 ch. 20, "Fast Third-Order Texture Filtering")
// folds each pair of taps along an axis into one linear fetch: 2×2×2
// trilinear fetches (the y-slice atlas needed 16). Taps are clamped to the
// edge cells' centres, i.e. the grid is extended by its edge.
// cubicFetch8 is the fold's 8 fetches: along each axis the fetch at a (weight
// ga) and at b (weight gb), texel coordinates already normalised.
fn cubicFetch8(t: texture_3d<f32>, a: vec3f, b: vec3f, ga: vec3f, gb: vec3f) -> vec4f {
  let za = ga.y * (ga.x * textureSampleLevel(t, linearClamp, vec3f(a.x, a.y, a.z), 0.0)
                 + gb.x * textureSampleLevel(t, linearClamp, vec3f(b.x, a.y, a.z), 0.0))
         + gb.y * (ga.x * textureSampleLevel(t, linearClamp, vec3f(a.x, b.y, a.z), 0.0)
                 + gb.x * textureSampleLevel(t, linearClamp, vec3f(b.x, b.y, a.z), 0.0));
  let zb = ga.y * (ga.x * textureSampleLevel(t, linearClamp, vec3f(a.x, a.y, b.z), 0.0)
                 + gb.x * textureSampleLevel(t, linearClamp, vec3f(b.x, a.y, b.z), 0.0))
         + gb.y * (ga.x * textureSampleLevel(t, linearClamp, vec3f(a.x, b.y, b.z), 0.0)
                 + gb.x * textureSampleLevel(t, linearClamp, vec3f(b.x, b.y, b.z), 0.0));
  return ga.z * za + gb.z * zb;
}
fn fieldCubic(t: texture_3d<f32>, p: vec3f) -> vec4f {
  let c = clamp(p, vec3f(0.5), vec3f(GRID) - 0.5) - 0.5;   // cell centres at integers
  let i = floor(c);
  let f = c - i;
  let f2 = f * f;
  let f3 = f2 * f;
  // weights of the control points at i-1, i, i+1, i+2
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  // per axis, two linear taps: between i-1|i and i+1|i+2 (texel units, then normalised)
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let lo = vec3f(0.5);
  let hi = vec3f(GRID) - 0.5;
  let a = clamp(i - 0.5 + w1 / g0, lo, hi) / vec3f(GRID);
  let b = clamp(i + 1.5 + w3 / g1, lo, hi) / vec3f(GRID);
  return cubicFetch8(t, a, b, g0, g1);
}
// The B-spline's gradient (d/dx, d/dy, d/dz of fieldCubic) for channel ch,
// analytically from the derivative kernel: the same fold works because the
// derivative's weights at i-1, i are both <= 0 and at i+1, i+2 both >= 0
// (Sigg & Hadwiger 2005, section 20.5; Hadwiger et al. 2005 shade their
// isosurfaces' normals this way). Per component 8 fetches, derivative weights
// along that axis and the value's along the others: 24 fetches, where central
// differences of fieldCubic took 48 (the liquid's 6 samples) or 32 (4).
fn fieldCubicGrad(t: texture_3d<f32>, p: vec3f, ch: i32) -> vec3f {
  let c = clamp(p, vec3f(0.5), vec3f(GRID) - 0.5) - 0.5;
  let i = floor(c);
  let f = c - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  // derivative weights: w0' = -(1 - f)²/2, w1' = 3f²/2 - 2f, w2' = -3f²/2 + f + 1/2,
  // w3' = f²/2; their pair sums are dg and -dg (|dg| in [0.5, 0.75], never 0)
  let d1 = 1.5 * f2 - 2.0 * f;
  let d3 = 0.5 * f2;
  let dg = f2 - f - 0.5;
  let lo = vec3f(0.5);
  let hi = vec3f(GRID) - 0.5;
  let a = clamp(i - 0.5 + w1 / g0, lo, hi) / vec3f(GRID);
  let b = clamp(i + 1.5 + w3 / g1, lo, hi) / vec3f(GRID);
  let da = clamp(i - 0.5 + d1 / dg, lo, hi) / vec3f(GRID);
  let db = clamp(i + 1.5 - d3 / dg, lo, hi) / vec3f(GRID);
  let gx = cubicFetch8(t, vec3f(da.x, a.yz), vec3f(db.x, b.yz), vec3f(dg.x, g0.yz), vec3f(-dg.x, g1.yz));
  let gy = cubicFetch8(t, vec3f(a.x, da.y, a.z), vec3f(b.x, db.y, b.z), vec3f(g0.x, dg.y, g0.z), vec3f(g1.x, -dg.y, g1.z));
  let gz = cubicFetch8(t, vec3f(a.xy, da.z), vec3f(b.xy, db.z), vec3f(g0.xy, dg.z), vec3f(g1.xy, -dg.z));
  return vec3f(gx[ch], gy[ch], gz[ch]);
}

// The cubic channels (gfx/materials.js CHANNELS cubic: liquids, powders) read
// cubic for thin features, blended in by the thin mask; bulk surfaces (pools,
// piles) read the same either way and stay trilinear. Up close they read cubic
// everywhere (DETAIL_CUBIC_CLOSE): there a trilinear surface's facets span
// many pixels, and a clump of sand falling past the eye is a cut gem. In the
// tracer's march they only read cubic near the surface: where the trilinear
// value is outside this band, both readings fall on the same side of it
// (checked for grains, drops, streams, clumps, films, slabs, edges and
// corners at the liquid's and the powders' blur; the closest call is ~0.73, a
// lone grain), so the cheap one decides.
const CUBIC_LO: f32 = 0.3;
const CUBIC_HI: f32 = 0.85;
// The march's hint for extra midpoint probes, not a surface-sampling gate:
// interpolation can reach thin texels outside the current brick.
var<private> gThin: bool = true;
// Up close: the view march sets the eye and its pixel's angular size
// (gfx/surface.js surfView); other passes leave it 0, and read no closer.
var<private> gCubicEye: vec3f = vec3f(0.0);
var<private> gCubicPixAng: f32 = 0.0;
${detail.DETAIL_CUBIC_CLOSE ? `
// cells per pixel at which the trilinear reading's shape error (CUBIC_ERR
// cells) spans gfx/detail.js CUBIC_ERR_PX_NONE / _FULL pixels on screen
const CUBIC_FP_NONE: f32 = ${f(CUBIC_ERR)} / ${f(CUBIC_ERR_PX_NONE)};
const CUBIC_FP_FULL: f32 = ${f(CUBIC_ERR)} / ${f(CUBIC_ERR_PX_FULL)};
fn cubicClose(p: vec3f) -> f32 {
  if (gCubicPixAng > 0.0) { return 1.0 - smoothstep(CUBIC_FP_FULL, CUBIC_FP_NONE, distance(p, gCubicEye) * gCubicPixAng); }
  return 0.0;
}` : `
fn cubicClose(p: vec3f) -> f32 { return 0.0; }`}
// how much channel ch reads cubic at p: its thin mask, or being close
fn cubicShare(p: vec3f, ch: i32) -> f32 {
  if (CH_CUBIC[ch] <= 0.0) { return 0.0; }
  let close = cubicClose(p);
  // fieldPeakFrag writes the thin mask in [0, 1]: it cannot raise full close weight.
  if (close == 1.0) { return 1.0; }
  let t = fieldTex(tFT, p)[ch];
  return max(t, close);
}
// The surface fields as the tracer sees them: each cubic channel within the
// band blended toward its cubic reading by its share.
fn surfSample(p: vec3f) -> vec4f {
  let s = surfField(p);
  let band = CH_CUBIC * select(vec4f(0.0), vec4f(1.0), s > vec4f(CUBIC_LO)) * select(vec4f(0.0), vec4f(1.0), s < vec4f(CUBIC_HI));
  if (all(band == vec4f(0.0))) { return s; }
  // fully close, the thin mask (in [0, 1]) can't raise the share: skip its read
  let close = cubicClose(p);
  var w = band * close;
  if (close < 1.0) { w = band * max(fieldTex(tFT, p), vec4f(close)); }
  if (all(w == vec4f(0.0))) { return s; }
  return mix(s, fieldCubic(tFS, p), w);
}
// One channel, at the surface (root finding). Each reading has one call site:
// Metal inlines every call, so the two that the
// full-weight and blended branches held were two copies of it. Surface fields
// are finite (fields.js: floored normalisation and peak denominators), so at
// full weight mix(0, cubic, 1) is the cubic reading exactly and needs no
// trilinear one; at zero weight mix(v, v, 0) is v. surfSample still needs
// that value for its band gate, even at full weight.
fn surfChannel(p: vec3f, ch: i32) -> f32 {
  let w = cubicShare(p, ch);
  var v = 0.0;
  if (w < 1.0) { v = surfField(p)[ch]; }
  var c = v;
  if (w > 0.0) { c = fieldCubic(tFS, p)[ch]; }
  return mix(v, c, w);
}

// Root of φ_ch(t) = SURF_ISO bracketed by [ta, tb] (fa, fb = φ - SURF_ISO at
// the ends, opposite signs). Clamped regula falsi: the field is smooth, so a
// few steps do. Each step's split is kept this far (share of the bracket)
// from either end, so a lopsided bracket still shrinks from both sides.
const SURF_ROOT_STEPS: i32 = 5;
const SURF_ROOT_SPLIT_LO: f32 = 0.15;
const SURF_ROOT_SPLIT_HI: f32 = 0.85;
fn surfRoot(ro: vec3f, rd: vec3f, ch: i32, ta0: f32, tb0: f32, fa0: f32, fb0: f32) -> f32 {
  var ta = ta0;
  var tb = tb0;
  var fa = fa0;
  var fb = fb0;
  for (var k = 0; k < SURF_ROOT_STEPS; k++) {
    let tm = mix(ta, tb, clamp(fa / (fa - fb), SURF_ROOT_SPLIT_LO, SURF_ROOT_SPLIT_HI));
    let fm = surfChannel(ro + rd * tm, ch) - SURF_ISO;
    if ((fm < 0.0) == (fa < 0.0)) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp(fa / (fa - fb), 0.0, 1.0));
}

// What a crossing test returns when there is none.
const NO_HIT: f32 = 1e9;

// Where along [ta, tb] the ray first crosses channel ch's surface, going into
// the material (into = true) or out of it; NO_HIT if it doesn't. The field is
// sampled at both ends and at tm, where the ray passes closest to a cell
// centre: a lone droplet or grain can sit entirely between the ends. With no
// middle sample, pass tm = tb and phiM = phiB.
fn surfCross(ro: vec3f, rd: vec3f, ch: i32, into: bool, ta: f32, tm: f32, tb: f32,
             phiA: f32, phiM: f32, phiB: f32) -> f32 {
  let a = phiA - SURF_ISO;
  let m = phiM - SURF_ISO;
  let b = phiB - SURF_ISO;
  var first: bool;
  var second: bool;
  if (into) { first = a < 0.0 && m >= 0.0; second = m < 0.0 && b >= 0.0; }
  else { first = a >= 0.0 && m < 0.0; second = m >= 0.0 && b < 0.0; }
  if (!first && !(tm < tb && second)) { return NO_HIT; }
  // one surfRoot call on whichever half holds the crossing (each call is inlined)
  return surfRoot(ro, rd, ch, select(tm, ta, first), select(tb, tm, first), select(m, a, first), select(b, m, first));
}

// Outward surface normal (−∇φ). The trilinear reading's gradient comes from
// differences over a wide step that irons out its lattice creases: liquid
// uses opposite axis pairs (a tetrahedral stencil leaks mixed derivatives into
// other axes: an xy slope gets a false z normal, turning continuous water into
// lumpy reflections/refractions), opaque channels four tetrahedral taps. The
// cubic reading's is analytic (fieldCubicGrad: the B-spline is C², so its
// exact gradient is smooth, and costs one reading where differences took four
// or six), and a channel's share blends the two gradients. (Differences of the
// blended field would add (cubic - trilinear)·∇share: the thin mask's slope
// across a blending feature's surface, which leans its normal no more than the
// wide step's own smoothing does.)
const NORMAL_STEP: f32 = 0.55;
// differences over ±h (cells): both stencils' sums are 4h·∇φ
const NORMAL_DIFF_SCALE: f32 = 1.0 / (4.0 * NORMAL_STEP);
fn surfNormal(p: vec3f, ch: i32, fallback: vec3f) -> vec3f {
  let w = cubicShare(p, ch);
  var gr = vec3f(0.0);
  if (w < 1.0) {
    let h = NORMAL_STEP;
    if (ch == CH_LIQUID) {
      let e = vec2f(1.0, 0.0);
      gr = 2.0 * vec3f(surfField(p + e.xyy * h)[ch] - surfField(p - e.xyy * h)[ch],
                       surfField(p + e.yxy * h)[ch] - surfField(p - e.yxy * h)[ch],
                       surfField(p + e.yyx * h)[ch] - surfField(p - e.yyx * h)[ch]);
    } else {
      let k = vec2f(1.0, -1.0);
      gr = k.xyy * surfField(p + k.xyy * h)[ch] + k.yyx * surfField(p + k.yyx * h)[ch]
         + k.yxy * surfField(p + k.yxy * h)[ch] + k.xxx * surfField(p + k.xxx * h)[ch];
    }
    gr *= NORMAL_DIFF_SCALE;
  }
  if (w > 0.0) { gr = mix(gr, fieldCubicGrad(tFS, p, ch), w); }
  let l = length(gr);
  if (l > 1e-5) { return -gr / l; }
  return fallback;
}

// ---- the opaque meshes' cut (gfx/meshCut.js; docs/webgpu.md Sync log S1) ----
// three.js draws the opaque meshes into the scene target before the volume,
// and the march stops at their depth, so the water in front of a body tints it
// instead of painting over it. This is the WebGPU half of the GLSL's meshCutT:
// d is the scene target's depth at this pixel (gFragCoord), in [0, 1] with 1
// the clear (docs/webgpu.md F4); clipToGrid is inverse(viewProj · model) of
// the volume's own (jittered) matrices; res the target's size in pixels.
// Returns the distance along the unit eye ray rd (grid cells, from FU.cam) to
// that mesh point, MESH_CUT_NONE where there is none. Reading the depth and
// those values is the volume's (shaders/render.js).
const MESH_CUT_NONE: f32 = 1e30;
fn meshCutAt(d: f32, clipToGrid: mat4x4f, res: vec2f, rd: vec3f) -> f32 {
  if (d >= 1.0) { return MESH_CUT_NONE; }
  let uv = gFragCoord / res;   // y down: ndc y is 1 at the top row
  let p = clipToGrid * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return dot(p.xyz / p.w - FU.cam, rd);
}
`;

// The binding-free part of the core: the grid's extent, cells, world
// positions and the DDA's ray helpers. It needs only the prelude (NX, NY, NZ,
// the header's origin, the element tables) and, for isCrisp, the materials'
// table accessors, so a kernel that walks the state alone (pick, the POV
// trace: docs/webgpu.md F5, G2) pastes prelude(g) + materialsGLSL() +
// ddaGLSL(g) and binds no lighting group. coreGLSL includes it.
export const ddaGLSL = (g) => /* wgsl */ `
const GRID: vec3i = vec3i(NX, NY, NZ);
const MAX_STEPS: i32 = ${g.maxSteps ?? g.nx + g.ny + g.nz + DDA_SPARE_STEPS};   // DDA steps that cross the box corner to corner

// Whether cell c lies outside the grid.
fn outside(c: vec3i) -> bool { return any(c < vec3i(0)) || any(c >= GRID); }

// World position of grid point p (docs/scaling.md D11). The look is anchored
// to it (surface textures, glints, ripples, gas detail, floor lines), so moving
// the window doesn't move the textures; everything that samples the grid's own
// textures (fields, bricks, probes, the shadow map) stays in grid space. In a
// box the header's origin is 0. (Always compiled, so a box and a world share
// every pipeline.)
fn worldPos(p: vec3f) -> vec3f { return p + vec3f(H.origin); }

// Crisp elements are drawn as voxels; everything else is a field.
fn isCrisp(id: i32) -> bool { return id != E_EMPTY && SURFCH(id) < 0 && MEDIACH(id) < 0; }

// ---- the DDA (shaders/dda.js: safeDir, argmin3, the walk's steps) ----
${ddaWalk()}
// Ray (ro, rd) against the box [0, GRID]: (tNear, tFar, entry axis 0..2). A miss has tFar <= tNear.
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
// Where in [ta, tb] the ray passes closest to the centre of cell c.
fn tClosest(c: vec3i, ro: vec3f, rd: vec3f, ta: f32, tb: f32) -> f32 {
  return clamp(dot(vec3f(c) + 0.5 - ro, rd), ta, tb);
}
`;

/** tools/check-wgsl.mjs: a probe kernel calling every function above (shaders/gfx/lib.js libChecks) */
export const WGSL_CHECK = () => libChecks('core');
