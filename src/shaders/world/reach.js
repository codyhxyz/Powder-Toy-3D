// A big map's reach (docs/seamless-world.md, "work parity"): the world march draws full detail out to it
// and the far view (shaders/far.js farFrag, world/far.js) past it, live's own distance march over live's own
// far summary. REACH_CELLS is live's box half-width, the old window's reach from its centre. The switch is
// dithered per pixel across REACH_BAND of it with spatiotemporal blue noise (gfx/noise.js stbn1), which TAA
// blends, the dithered LOD transition of game engines (Unreal Engine's "Dithered LOD Transition"), so no line
// shows. Both passes call reachAt with the same pixel, frame and cells: they agree per pixel per frame, and
// the nearer surface wins by depth where they meet.
// Intentional (small maps): a world the size of its box has no far view; its reach is REACH_NONE (cells 0),
// the march draws all of it, as live's box did.
import { glf } from '../../glsl.js';

/** Cells from the camera the world march draws a big map out to (before the dither). */
export const REACH_CELLS = 64;
/** The dither's band, a share of REACH_CELLS: a pixel's reach is in [REACH_CELLS, REACH_CELLS · (1 + REACH_BAND)). */
export const REACH_BAND = 0.25;
/** The dither's blue-noise stream (stbn1's k: apart from the march's own streams). */
export const REACH_NOISE_K = 7;
/** A reach that never ends (cells 0: a small map, or a frame the far view doesn't draw). */
export const REACH_NONE = 1e30;

// Needs gfx/noise.js (stbn1).
export const reachWGSL = /* wgsl */ `
// ---- the reach (shaders/world/reach.js): world march to it, far view past it ----
const REACH_BAND: f32 = ${glf(REACH_BAND)};
const REACH_NOISE_K: f32 = ${glf(REACH_NOISE_K)};
const REACH_NONE: f32 = ${glf(REACH_NONE)};
// This pixel's reach along its unit eye ray (cells; cells <= 0: REACH_NONE). frame: FU.frame, as stbn1 takes it.
fn reachAt(px: vec2f, frame: f32, cells: f32) -> f32 {
  if (cells <= 0.0) { return REACH_NONE; }
  return cells * (1.0 + REACH_BAND * stbn1(px, frame, REACH_NOISE_K));
}
`;
