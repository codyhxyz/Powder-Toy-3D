// Distance ring for the WORLD renderer's light bounce (GI gathers, big maps
// only: Box, the small maps, computes every brick's GI SOURCE each frame,
// shaders/gi.js giSourceFrag over its whole grid, so its gathers always read
// full detail and nothing here applies to them; not a deviation, the light
// they converge to is the one a World gather reads inside its ring).
//
// Why: a World gather (shaders/gi.js giGatherFrag) reads a SOURCE it has no
// page for as nothing, asks for it, and walks on, so every probe's 32 rays
// asked for every brick to the world's edge (the sky's air included), and
// those far SOURCES then asked for their own sun tiles and casters. A load
// asked for 417k bricks from Island's start, 790k from its hill (283k of them
// the gathers' own) and 824k on Descent's first level; with this ring 249k,
// 446k and 220k (tools/world-demand-model.mjs, 2026-10-22; real Chrome ran out
// of GPU memory at 821k and never finished at 449k).
//
// So a gather asks for a missing SOURCE only within WORLD_GI_NEAR_RADIUS of
// the eye. Past it a gather reads the SOURCE that is resident (the light
// book's: every brick the view, a gather or a SOURCE's lighting already
// brought in), and where none is, the scene's ground twin, the same
// heightfield the coarse sun tiles are drawn from (world/worldSunRings.js):
// matter under its top, air over it. So a far ray still stops on terrain it
// cannot see (no light leaks under hills) and takes the ground's light there,
// as it takes the ground's past the world's edge (gi.js beyond()). Nothing
// past the ring ever enters the demand, and nothing past it is unlit.
// As the eye comes near, a probe's next gather asks for its reads inside the
// new ring through the normal demand, and its light eases from the
// heightfield's to full detail over the history's blend (GI_BLEND): no pop.
//
// This is Lumen's split (UE5 "Lumen Technical Details": full-detail traces
// near the camera, a coarse global representation of the far scene beyond)
// and how a DDGI volume (Majercik et al. 2019) is kept around the camera. A
// ray still runs to the world's edge (the user's decision of 2026-10-20 for
// both map sizes, gi.js giSteps); only what it reads past the ring changes.
//
// The radius is the gather's own step budget. A ray reads every brick for its
// first GI.NEAR_STEPS steps and every GI.FAR_STRIDE-th past them, since
// "distant blockers only need to be roughly right" (gi.js): past NEAR_STEPS
// bricks the GI already draws a stand-in for detail. So the light at the eye
// (the eye's own probe, which lights the player's body, hands and held tools:
// shaders/worldPoint.js) and on the ground at the player's feet is read at
// full detail exactly NEAR_STEPS bricks out, and the ring is that reach, plus
// half a brick's diagonal: a brick is near by its centre, and every brick the
// last near step can land in has its centre within that of the step.
// (NEAR_STEPS + √3/2)·BRICK = 27.5 cells, 8.2 m: a quarter of the sun's near
// ring (WORLD_SUN_NEAR_RADIUS, 110 cells), because light bounce is
// low-frequency: a shadow edge is a cell sharp, a probe's light is averaged
// over GI.RAYS cones and drawn through a filter one probe (BRICK cells) wide.
import { BRICK } from '../shaders/common.js';
import { GI } from '../shaders/gi.js';

export const WORLD_GI_NEAR_RADIUS = (GI.NEAR_STEPS + Math.sqrt(3) / 2) * BRICK;

// Is brick b (brick coordinates) inside the ring around eye (cells)? Decided
// by the brick's centre, so every ray of every probe agrees on a brick, as the
// shader does (worldGI.js worldGIRingNear). No ring (radius < 0, or no eye):
// every brick is near, as before rings.
export function worldGIBrickNear(eye, b, radius = WORLD_GI_NEAR_RADIUS) {
  if (!(radius >= 0) || !eye) return true;
  let s = 0;
  for (let k = 0; k < 3; k++) { const d = (b[k] + 0.5) * BRICK - eye[k]; s += d * d; }
  return s <= radius * radius;
}
// Cells per axis in worldGIReach's keys: past any World's bricks over a span.
const REACH_KEY = 1 << 16;
// The bricks whose SOURCE a load's gathers read at full detail: those inside
// the ring of the eye (where a gather asks for a missing one), and those
// within the same radius of a probe the load gathers: its burial test (its
// own brick and its six neighbours) and its rays' first GI.NEAR_STEPS steps,
// whose every brick has its centre within the radius of the probe's (the
// radius's own rule, above). Every other read is a ray's far stride past the
// ring, which takes a held SOURCE or the ground twin (worldGI.js
// worldGISourceRing). So only these are a load's SOURCE candidates
// (wire/worldRender.js worldSourceEligible): on Island a load's SOURCE stage
// computed every brick the view asked for out to the far shore, ~78k on each
// restart, and publishing them took 20-28 s (real Chrome, 2026-10-22).
// The probes are the ones the load declares (the eye's, the view's, the ones
// it owns); a later load's births, found by its SOURCE phase on bricks inside
// this reach, read past it as any far stride does.
// Returns a test of brick coordinates; no eye or no ring: every brick (as
// without rings). Probes are hashed by cells of a ring's span in bricks, so a
// test looks at the 27 cells around its brick.
export function worldGIReach(eye, probes = [], radius = WORLD_GI_NEAR_RADIUS) {
  if (!(radius >= 0) || !eye) return () => true;
  const span = Math.max(1, Math.ceil(radius / BRICK)), cells = new Map(), r2 = radius * radius;
  // a cell's key: its coordinates offset by one (a neighbour of cell 0 is -1)
  const key = (x, y, z) => ((z + 1) * REACH_KEY + (y + 1)) * REACH_KEY + (x + 1);
  for (const p of probes) {
    const k = key(Math.floor(p[0] / span), Math.floor(p[1] / span), Math.floor(p[2] / span));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  return (b) => {
    if (worldGIBrickNear(eye, b, radius)) return true;
    if (!cells.size) return false;
    const cx = Math.floor(b[0] / span), cy = Math.floor(b[1] / span), cz = Math.floor(b[2] / span);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = cells.get(key(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const p of list) {
        let s = 0;
        for (let k = 0; k < 3; k++) { const d = (b[k] - p[k]) * BRICK; s += d * d; }
        if (s <= r2) return true;
      }
    }
    return false;
  };
}
// The heightfield's stand-in SOURCE coverage of a brick at height y (bricks)
// in a column whose ground twin top is `top` (cells; worldCoarseCasters'
// heights): the share of its rows under the top, along x and z, and its whole
// face along y once any of it is (worldGI.js worldGIProxy; the forecast's own
// estimate, worldSunForecast.js forecastGatherSources).
export function worldGIProxyCoverage(top, y) {
  const fill = Math.min(1, Math.max(0, (top - y * BRICK) / BRICK));
  return [fill, fill > 0 ? 1 : 0, fill];
}
