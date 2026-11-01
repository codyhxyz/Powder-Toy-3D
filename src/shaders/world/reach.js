import { glf } from '../../glsl.js';
import { WC_BRICK } from './cellWord.js';

// A big map's full detail (docs/seamless-world.md, "work parity"): a box about physics' window's size (CUT_INSET
// less), centred on the focus itself (world/window.js cutBox: unsnapped, so it slides with you and never jumps
// the 16 cells the window moves by). The world march draws a pixel's ray only inside it, and the far view (shaders/far.js
// farFrag, world/far.js) outside its inner box (the box less CUT_BAND cells on each face inside the world).
// Across the band between the two both draw, and a pixel keeps the world march's hit with the share cutNear
// gives (1 at the inner box, 0 at the outer), dithered per pixel and frame (ign) and resolved by TAA: Losasso &
// Hoppe's transition band (2004, "Geometry Clipmaps"), the dissolve Far Cry 5 and UE's LOD dither use, so the
// change from full detail to the distant land is a fade, not a line. Both passes take the ray's span through a
// box from windowSpan and the share from cutNear, so they cut it with the same arithmetic.
// Intentional (small maps): a world the size of its box has no far view; its march draws all of it, as
// live's box did (MarchParams.boxed 0).

// Cells over which full detail fades into the distant land, inside the box's faces. Wide enough that the
// differences left between the two (shape at the distant land's resolution, its light) spread over a few
// metres instead of a line: 16 cells, 4.8 m, the distance the old box jumped by.
export const CUT_BAND = 16;

// Cells the box keeps inside physics' window's size on each side along x and z. F's level 0 (shaders/world/
// fields.js fieldClipFor: the window and FIELD_FILTER_MARGIN past it, a brick ring) is centred on the box
// (gfx/worldView.js update) but placed in whole bricks, up to a brick off the focus, so the box is a brick
// smaller each side than what level 0 holds: it never reads a coarser level at its faces.
export const CUT_INSET = WC_BRICK;

// Needs nothing but WGSL builtins.
export const reachWGSL = /* wgsl */ `
// ---- the window's span (shaders/world/reach.js): world march inside it, far view outside it ----
// The ray ro + rd t through the box [lo, hi): (tNear, tFar, the axis it enters across); tNear > tFar: a miss.
fn windowSpan(ro: vec3f, rd: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
  let t0 = (lo - ro) / rd;
  let t1 = (hi - ro) / rd;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  var axis = 2.0;
  if (tn.x >= tn.y && tn.x >= tn.z) { axis = 0.0; } else if (tn.y >= tn.z) { axis = 1.0; }
  return vec3f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z), axis);
}
// ---- the transition band (CUT_BAND) ----
const CUT_BAND: f32 = ${glf(CUT_BAND)};
const CUT_FAR: f32 = 1e9;   // a face on the world's edge: nothing lies past it, so no band
// The full-detail box [lo, hi) less the band on each face inside the world [0, world): where the far view starts.
fn cutInnerLo(lo: vec3f) -> vec3f { return select(lo, lo + CUT_BAND, lo > vec3f(0.0)); }
fn cutInnerHi(hi: vec3f, world: vec3f) -> vec3f { return select(hi, hi - CUT_BAND, hi < world); }
// The world march's share at world point p: 1 at the inner box and in it, 0 at the box's faces and past them.
fn cutNear(p: vec3f, lo: vec3f, hi: vec3f, world: vec3f) -> f32 {
  let dl = select(vec3f(CUT_FAR), p - lo, lo > vec3f(0.0));
  let dh = select(vec3f(CUT_FAR), hi - p, hi < world);
  let d = min(dl, dh);
  return saturate(min(min(d.x, d.y), d.z) / CUT_BAND);
}
`;
