import { libChecks } from './lib.js';
import { ddaWalkWGSL } from '../dda.js';
import { CUBIC_FACET, CUBIC_PX_NONE, CUBIC_PX_FULL } from '../../gfx/detail.js';
import { glf as f } from '../../glsl.js';

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
fn brickInfo(bc: vec3i) -> u32 {
  let w = brickOcc(bc);
  return select(0u, w, brickMatter(w));
}
fn brickHas(f: u32, bit: u32) -> bool { return (f & bit) != 0u; }
fn brickMedia(f: u32) -> bool { return brickHas(f, BRICK_MEDIA); }
fn brickSurf(f: u32) -> bool { return brickHas(f, BRICK_SURF); }
fn brickOpaque(f: u32) -> bool { return brickHas(f, BRICK_OPAQUE); }   // crisp or opaque smooth matter
fn brickThin(f: u32) -> bool { return brickHas(f, BRICK_THIN); }       // thin cubic matter (drops, grains): read cubic
fn brickMixed(f: u32) -> bool { return brickHas(f, BRICK_MIXED); }     // more than one liquid

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
// Hadwiger's trick folds each pair of taps along an axis into one linear
// fetch: 2×2×2 trilinear fetches (the y-slice atlas needed 16). Taps are
// clamped to the edge cells' centres, i.e. the grid is extended by its edge.
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
  let za = g0.y * (g0.x * textureSampleLevel(t, linearClamp, vec3f(a.x, a.y, a.z), 0.0)
                 + g1.x * textureSampleLevel(t, linearClamp, vec3f(b.x, a.y, a.z), 0.0))
         + g1.y * (g0.x * textureSampleLevel(t, linearClamp, vec3f(a.x, b.y, a.z), 0.0)
                 + g1.x * textureSampleLevel(t, linearClamp, vec3f(b.x, b.y, a.z), 0.0));
  let zb = g0.y * (g0.x * textureSampleLevel(t, linearClamp, vec3f(a.x, a.y, b.z), 0.0)
                 + g1.x * textureSampleLevel(t, linearClamp, vec3f(b.x, a.y, b.z), 0.0))
         + g1.y * (g0.x * textureSampleLevel(t, linearClamp, vec3f(a.x, b.y, b.z), 0.0)
                 + g1.x * textureSampleLevel(t, linearClamp, vec3f(b.x, b.y, b.z), 0.0));
  return g0.z * za + g1.z * zb;
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
// Whether the brick being traced holds thin cubic matter (brickThin): set by
// the marches on entering each brick, so bulk matter never reads the mask.
var<private> gThin: bool = true;
// Up close: the view march sets the eye and its pixel's angular size
// (gfx/surface.js surfView); other passes leave it 0, and read no closer.
var<private> gCubicEye: vec3f = vec3f(0.0);
var<private> gCubicPixAng: f32 = 0.0;
${detail.DETAIL_CUBIC_CLOSE ? `
// cells per pixel at which a trilinear facet (CUBIC_FACET cells) spans gfx/detail.js CUBIC_PX_NONE / _FULL pixels
const CUBIC_FP_NONE: f32 = ${f(CUBIC_FACET)} / ${f(CUBIC_PX_NONE)};
const CUBIC_FP_FULL: f32 = ${f(CUBIC_FACET)} / ${f(CUBIC_PX_FULL)};
fn cubicClose(p: vec3f) -> f32 {
  if (gCubicPixAng > 0.0) { return 1.0 - smoothstep(CUBIC_FP_FULL, CUBIC_FP_NONE, distance(p, gCubicEye) * gCubicPixAng); }
  return 0.0;
}` : `
fn cubicClose(p: vec3f) -> f32 { return 0.0; }`}
// how much channel ch reads cubic at p: its thin mask, or being close
fn cubicShare(p: vec3f, ch: i32) -> f32 {
  if (CH_CUBIC[ch] <= 0.0) { return 0.0; }
  var t = 0.0;
  if (gThin) { t = fieldTex(tFT, p)[ch]; }
  return max(t, cubicClose(p));
}
// The surface fields as the tracer sees them: each cubic channel within the
// band blended toward its cubic reading by its share.
fn surfSample(p: vec3f) -> vec4f {
  let s = surfField(p);
  let band = CH_CUBIC * select(vec4f(0.0), vec4f(1.0), s > vec4f(CUBIC_LO)) * select(vec4f(0.0), vec4f(1.0), s < vec4f(CUBIC_HI));
  if (all(band == vec4f(0.0))) { return s; }
  var thin = vec4f(0.0);
  if (gThin) { thin = fieldTex(tFT, p); }
  let w = band * max(thin, vec4f(cubicClose(p)));
  if (all(w == vec4f(0.0))) { return s; }
  return mix(s, fieldCubic(tFS, p), w);
}
// One channel, at the surface (root finding, normals).
fn surfChannel(p: vec3f, ch: i32) -> f32 {
  let v = surfField(p)[ch];
  let w = cubicShare(p, ch);
  if (w > 0.0) { return mix(v, fieldCubic(tFS, p)[ch], w); }
  return v;
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

// Outward surface normal (−∇φ) of channel ch at p from a tetrahedral central
// difference; fallback where the gradient vanishes. The step is wide on
// purpose: trilinear fields have creased gradients at the cell-centre
// lattice, and a wide stencil irons them out. Where a channel reads cubic
// (thin features, up close) it is smooth, and the step only has to be small
// next to a drop's radius.
const NORMAL_STEP: f32 = 0.55;
const NORMAL_STEP_CUBIC: f32 = 0.25;
fn surfNormal(p: vec3f, ch: i32, fallback: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let h = mix(NORMAL_STEP, NORMAL_STEP_CUBIC, cubicShare(p, ch));
  let gr = k.xyy * surfChannel(p + k.xyy * h, ch) + k.yyx * surfChannel(p + k.yyx * h, ch)
         + k.yxy * surfChannel(p + k.yxy * h, ch) + k.xxx * surfChannel(p + k.xxx * h, ch);
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
const MAX_STEPS: i32 = ${g.maxSteps ?? g.nx + g.ny + g.nz + 8};   // DDA steps that cross the box corner to corner

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
${ddaWalkWGSL}
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
