import { E } from '../../elements.js';
import { WORLD_SIZE } from '../../shaders/farShared.js';
import { helpersGLSL, definesGLSL, definesTypes, jsConstants, compileShared, memoTwin } from './themedShared.js';
import { toWgsl } from './subsetWgsl.js';
import { sceneStruct, sceneHeadWGSL } from './sceneGpu.js';
import { ISLAND_VIEW_XZ } from './island.js';

// The giant volcano: one stratovolcano filling its world, 105 m tall in the
// sea, built the way Volcano isles builds its volcanoes (volcanoWorld.js:
// wobbled outline, roughness, a crater), and grown
// what a mountain this size has and a box can't:
//   - an outline and flanks wobbled by noise, so no two sides are alike, on
//     the concave profile of a stratovolcano (steepest under the summit,
//     easing to a gentle apron where the sea laps it);
//   - radial gullies down the flanks: the barrancos rain cuts into every
//     stratovolcano (Teide's, Mayon's). They run along the zero lines of
//     noise sampled on rings round the summit, so they wander and branch as
//     they widen downhill, deepest on the mid flanks;
//   - a summit crater, its floor ash, and on its rim on the god view's side
//     the active vent: a spatter cone (a hornito) with the endless lava source
//     on its point and the conduit's lava standing over it, so it spills at
//     once, all round: into the crater, which it slowly fills, and down
//     - a collapse scar from the rim to the sea, a broad chute between steep
//     walls: Stromboli's Sciara del Fuoco, under the vents on its crater
//     terrace. A channel down its floor holds a tongue of lava partway down:
//     what the far field shows glowing, and what runs when the window gets
//     there;
//   - a big flank cone high on one side, its own summit and crater breaking
//     the skyline (Fuji's Hōei, Etna's shoulders);
//   - old lava flows: ribbons of basalt standing proud of the flanks, from the
//     rim down into the forest, widening toward their toes (Etna's flanks are
//     made of them);
//   - side cones: small cinder cones on the lower flanks, dark basalt cinder,
//     each with a little crater of its own (Etna has hundreds);
//   - a snow line, snow where it lies still and glacier ice where it is too
//     steep for powder, on rock frozen under it, reaching lower down the
//     gullies, as snow lingers in a mountain's ravines; none round the hot crater;
//   - patchy forest on the lower flanks, round trees low and pines higher up
//     to a tree line under the snow, none on the bare lava flows;
//   - a rolling sea floor round it.
// Its world is three times as tall as the other scenes' (VOLC_SIZE: 384 cells,
// 115 m; the window spans it), so the cone keeps the box's steepness. Across,
// its foot is the box volcano's (presets.js 'volcano': R 54) times the world's
// width in boxes (1024 / 128 = 8).
//
// Lessons kept from the cone it replaces (measured on the GPU):
//   - Buried lava is expensive: the conduit and the magma chamber keep the box
//     volcano's layout at 2 cells per box cell (CHAMBER_*, CONDUIT_R), not 8.
//   - A lava source must sit on a point. In a crater, or under a lava lake
//     (tried: a breached crater lake, as Volcano isles' are), the lava pooled,
//     its crust froze into stone powder over the source and the eruption
//     stopped within 500 steps. On the hornito's point the stone it cools
//     into rolls off, so the source stays open.
//
// Every cell is a pure function of its world position and the seed. The
// geometry is written once (SRC) in the shared GLSL subset (themedShared.js):
// the GPU runs it, the CPU its JS twin (ground, start, tools/scene-themed-preview.mjs).

const VOLC_WORLD_Y = 384;         // cells: its world's height (the other scenes' is WORLD_SIZE's, 128)
export const VOLC_SIZE = [WORLD_SIZE[0], VOLC_WORLD_Y, WORLD_SIZE[2]];
const VOLC_HEADROOM = 24;         // cells of open air over the highest generated matter: room for the lava's fountain, steam and smoke
const DEG = Math.PI / 180;

const G = {
  ints: {
    FLOOR: 4,               // rock under the whole sea: one brick, so the far field reads it as solid
    SEA: 20,                // sea level (the box volcano's 8, at 2 cells per box cell, over the floor)
    SKY: VOLC_WORLD_Y - VOLC_HEADROOM,   // nothing generated stands this high
    RIM: 336,               // the crater rim's height
    CRATER_DEPTH: 24,       // its floor, under the rim
    ASH_DEPTH: 2,           // ash on the crater's floor...
    ASH_RISE: 2,            // ...where the ground stands at most this far over the floor's lowest
    VENT_RISE: 4,           // the hornito's point stands this far over the rim...
    CLONE_HALF: 4,          // the lava source on it is 2 × this cells square (the box volcano's 4, at 2 cells per box cell)...
    CLONE_BELOW: 2,         // ...from this far under the point...
    CLONE_ABOVE: 6,         // ...to this far over it, over the conduit's lava (the old giant's; at 3 the stone it
                            // makes capped it within 500 steps, and only its sides still erupted)
    CONDUIT_OVER: 4,        // the conduit's lava stands this far over the point (the box's 2, × 2)
    ACTIVE_DEPTH: 2,        // the lava tongue in the channel
    CHAMBER_TOP: 32,        // the magma chamber: the conduit's lowest part, up to here (the box's 14, × 2, over the floor)...
    SNOW_LINE: 225,         // snow on ground from this height up (give or take SNOW_JITTER; lower in the gullies)
    SNOW_DEPTH: 3,          // the snow layer
    SNOW_DROP: 3,           // snow where no neighbouring column stands more than this lower (its top grains slide a little, then rest), glacier ice where one does
    FROST_DEPTH: 6,         // rock is frozen to the snow's temperature from this far under the lowest snow up...
    FROST_SPAN: 8,          // ...and warms to ambient over this many cells under that
    FLOW_ROOT: 1,           // an old flow's basalt reaches this far under its own thickness
    CINDER_DEPTH: 2,        // a side cone's cinder: the top this many cells of it, basalt (where it rises CINDER_RISE)
    CONES: 4,               // side cones
    FLOWS: 5,               // old lava flows
    ROW: 3,                 // neighbouring columns and tree cells: ROW × ROW
    SLOTS: 9,               // ...ROW², x fastest
    SELF: 4,                // ...the middle one
    TREE_CELL: 9,           // one tree candidate per this many cells square (more than 2 × CROWN_R)
    TREE_MARGIN: 1,         // a trunk keeps this far inside its tree cell
    CROWN_R: 4,             // a crown's reach from its trunk, at most...
    CROWN_R2: 17,           // ...a round crown's cells are closer than √this to its centre...
    CROWN_UP: 3,            // ...centred this far over the trunk's top cell
    PINE_SKIRT: 3,          // a pine's cone of leaves starts this far up its trunk...
    PINE_TIP: 4,            // ...and ends this far over its top
    TRUNK_MIN: 9,           // trunk heights (Volcano isles' 5-9, half as big again: a bigger mountain's)
    TRUNK_MAX: 15,
    TREE_REACH: 28,         // cells over a column's ground a tree may reach: a crown's top, 21 over its trunk's foot,
                            // the foot up to 5 higher on a 46° flank a crown's reach away
    TREE_ABOVE_SEA: 6,      // trunks stand this far over the sea (leaves clear of the spray)...
    TREE_SNOW_GAP: 20,      // ...and this far under the lowest snow (whose meltwater their leaves would grow into)
    PINE_LINE: 110,         // trees standing this high or higher are pines
    // parameter streams of a cone's, a flow's and a tree cell's hash (thKey)
    K_A: 1, K_T: 2, K_R: 3, K_H: 4, K_LEN: 5, K_W: 6, K_X: 7, K_Z: 8, K_TRUNK: 9,
  },
  floats: {
    CX: VOLC_SIZE[0] / 2,   // the summit's column: the world's centre
    CZ: VOLC_SIZE[2] / 2,
    R: 432.0,               // the cone's radius at its foot (the box's 54 × 8)
    BASE: 4.0,              // its foot's height: the floor, so it rises out of the sea floor
    EXP: 1.3,               // its profile, (1 - d / R)^this: concave, steepest under the summit (46°)
    CRATER_R: 36.0,         // the crater's rim radius (8% of the foot's, as Stromboli's summit is of its island)
    CRATER_EXP: 4.0,        // its bowl rises as (d / rim radius)^this: a flat floor, steep walls (Volcano isles')
    ASH_SHARE: 0.6,         // the ash floor reaches this share of the crater's radius
    VENT_SLOPE: 2.0,        // the hornito's sides fall this much a cell (63°: it stays a point, and its skirt keeps out of the crater)
    SEABED: 9.0,            // the sea floor's mean height...
    SEABED_AMP: 4.0,        // ...rolling this much up and down...
    SEABED_WAVE: 90.0,      // ...over this many cells
    WOBBLE_AMP: 0.16,       // distances from the summit are stretched by up to this share (noise)...
    WOBBLE_WAVE: 380.0,     // ...over this many cells: a few big lobes round the coast...
    WOBBLE_FINE: 0.35,      // ...this share of it by a finer octave...
    WOBBLE_FINE_WAVE: 80.0, // ...over this many
    ROUGH_AMP: 3.0,         // surface roughness, cells...
    ROUGH_WAVE: 34.0,       // ...over this many cells...
    ROUGH_FINE: 0.5,        // ...plus this share of it...
    ROUGH_FINE_WAVE: 11.0,  // ...over this many
    ROUGH_CLEAR: 1.4,       // the crater and its rim stay clean of roughness and gullies out to this many crater radii
    GULLY_DEPTH: 10.0,      // the gullies: cut this deep at most (3 m)...
    GULLY_W: 0.22,          // ...where the ring noise is within this of zero (~8 cells wide on the mid flanks)...
    GULLY_RING: 7.0,        // ...the noise sampled on a ring this big at the summit (~45 gullies round it)...
    GULLY_LEN: 140.0,       // ...growing by 1 every this many cells down (they branch as they widen apart)...
    GULLY_IN0: 0.12,        // ...fading in between these shares of the radius...
    GULLY_IN1: 0.3,
    GULLY_OUT0: 0.7,        // ...and out between these (the apron is smooth)
    GULLY_OUT1: 0.95,
    BREACH_TURN: 40.0,      // degrees: the vent and its scar face this far round from the god view's side, so they are in view, side on
    CHANNEL_HALF: 4.5,      // the channel down the scar from the vent: half its width...
    CHANNEL_DEPTH: 4.0,     // ...this deep in the scar's floor...
    ACTIVE_LEN: 195.0,      // ...out to this far from the summit, about half way down (the lava tongue in it ends there)
    MEANDER: 14.0,          // the channel wanders this far, at most...
    MEANDER_IN: 40.0,       // ...fading in over this many cells past the rim...
    MEANDER_WAVE: 60.0,     // ...over this many cells along
    FLOW_MEANDER: 22.0,     // the old flows wander this far...
    FLOW_MEANDER_WAVE: 90.0,// ...over this many cells along
    MEANDER_ROW: 0.5,       // the channel's row of the meander noise (flow k's: FLOW_DECOR × (k + 1))
    FLOW_DECOR: 17.3,       // rows apart in the meander noise, so no two flows wander alike
    FLOW_THICK: 6.0,        // an old flow stands this thick over the flank at its middle (1.8 m: aa flows run 2-5 m)...
    FLOW_W_MIN: 9.0,        // ...its toe this wide each way, between these...
    FLOW_W_MAX: 18.0,
    FLOW_W_TOP: 0.4,        // ...narrowing to this share of that at the rim
    FLOW_LEN_MIN: 0.45,     // ...reaching down to between these shares of the radius...
    FLOW_LEN_MAX: 0.85,
    FLOW_START_MAX: 0.3,    // ...from the rim or a fissure down the flank, up to this share of the radius past it
    SECTOR_CLEAR: 60.0,     // degrees: flows and side cones keep this far round from the vent's side (off the scar)...
    FLOW_JITTER: 0.7,       // ...each in its sector, off the sector's centre by up to this share of it (flows)...
    CONE_JITTER: 0.5,       // ...and this (side cones)
    FLOW_ROUGH: 0.3,        // a flow's top carries this share of the flank's roughness
    CONE_T_MIN: 0.45,       // side cones stand between these shares of the radius...
    CONE_T_MAX: 0.72,
    CONE_R_MIN: 30.0,       // ...their foot's radius between these...
    CONE_R_MAX: 55.0,
    CONE_H_MIN: 18.0,       // ...rising this much over the flank...
    CONE_H_MAX: 36.0,
    CONE_EXP: 1.1,          // ...on a nearly straight profile (cinder at its angle of repose)...
    CONE_CRATER_SHARE: 0.3, // ...a crater this share of their radius...
    CONE_CRATER_DEPTH: 6.0, // ...this deep
    CINDER_RISE: 8.0,       // side cones' cinder (CINDER_DEPTH) where they rise this much over the flank (their skirts are the flank's rock)
    SCAR_W_TOP: 34.0,       // the scar: this wide each way under the rim...
    SCAR_W_FOOT: 130.0,     // ...widening to this at the cone's foot...
    SCAR_DEPTH: 70.0,       // ...its floor this far under the flank (21 m)...
    SCAR_IN: 30.0,          // ...reached this far past the rim...
    SCAR_WALL: 16.0,        // ...up walls this wide (steep, ~75°)...
    SCAR_OUT0: 0.95,        // ...fading out between these shares of the radius, a bay at the shore
    SCAR_OUT1: 1.1,
    SCAR_ROUGH: 0.4,        // ...its floor carrying this share of the flank's roughness (a smooth chute of loose rock)
    SHOULDER_TURN: -130.0,  // degrees: the flank cone stands this far round from the vent's side (the god view's left skyline)...
    SHOULDER_T: 0.32,       // ...this share of the radius out...
    SHOULDER_R: 110.0,      // ...its foot this wide...
    SHOULDER_H: 80.0,       // ...rising this much over the flank...
    SHOULDER_EXP: 1.2,
    SHOULDER_CRATER_SHARE: 0.22,   // ...its crater this share of its radius...
    SHOULDER_CRATER_DEPTH: 9.0,    // ...this deep
    SNOW_JITTER: 8.0,       // the snow line's wobble...
    SNOW_WAVE: 40.0,        // ...over this many cells
    GULLY_SNOW: 25.0,       // the snow line reaches this much lower in a gully's floor
    SNOW_CRATER_GAP: 1.6,   // no snow within this many crater radii of the summit (it would melt at once), and the rock is warm there...
    WARM_EDGE: 0.75,        // ...warming from frozen from this share of that radius in
    FOREST_WAVE: 60.0,      // forest patches: their noise's wavelength...
    FOREST_EDGE: -0.25,     // ...clearings where it is under this...
    FOREST_SOFT: 0.6,       // ...thickening to full over this much more
    CONDUIT_R: 7.0,         // the conduit over the chamber (the box's 3.5, × 2)
    CHAMBER_BULGE: 24.0,    // the chamber's radius at its foot over its neck's (the box's 12, × 2)...
    CHAMBER_FADE: 32.0,     // ...narrowing over this height (the box's 16, × 2)...
    CHAMBER_NECK: 8.0,      // ...to this radius (the box's 4, × 2)
    MAGMA_T: 1900.0,        // °C: the chamber's, conduit's, lake's and tongue's lava (the box's)
    TAU: 2 * Math.PI,
  },
  salts: {
    WOBBLE: 0x9a10, WOBBLE_FINE: 0x9a20, ROUGH: 0x9a30, ROUGH_FINE: 0x9a40, GULLY: 0x9a50,
    SEABED: 0x9a60, SNOW: 0x9a70, FOREST: 0x9a80, FLOW: 0x9a90, CONE: 0x9aa0, MEANDER: 0x9ab0,
    TREE: 0x9ac0, CELL: 0x9ad0,
  },
  picks: {
    TREE: [['YES', 0.75], ['NO', 0.25]],     // a tree cell has a tree (in the thick of a forest)
  },
};
// Derived: the apex the profile would reach with no crater, so its rim stands at RIM;
// the crater floor, the vent's heights; the directions of the vent (and scar) and the flank cone.
const F = G.floats, I = G.ints;
F.RISE = (I.RIM - F.BASE) / (1 - F.CRATER_R / F.R) ** F.EXP;
I.FLOOR_TOP = I.RIM - I.CRATER_DEPTH;
I.VENT_TOP = I.RIM + I.VENT_RISE;
I.CLONE_TOP = I.VENT_TOP + I.CLONE_ABOVE;          // the layout's highest point
I.CONDUIT_TOP = I.VENT_TOP + I.CONDUIT_OVER;
F.BREACH_A = Math.atan2(ISLAND_VIEW_XZ[1], ISLAND_VIEW_XZ[0]) + F.BREACH_TURN * DEG;
F.SHOULDER_A = F.BREACH_A + F.SHOULDER_TURN * DEG;
F.SECTOR_CLEAR_A = F.SECTOR_CLEAR * DEG;
F.VENT_X = F.CX + F.CRATER_R * Math.cos(F.BREACH_A);   // the vent's column: on the rim, toward the scar
F.VENT_Z = F.CZ + F.CRATER_R * Math.sin(F.BREACH_A);
const P_ = 'GV';
// A side cone's crater stays a dip in it, not a hole in the flank; trees
// stand above the sea's spray and under the snow.
if (F.CONE_CRATER_DEPTH >= F.CONE_H_MIN * (1 - F.CONE_CRATER_SHARE) ** F.CONE_EXP
    || F.SHOULDER_CRATER_DEPTH >= F.SHOULDER_H * (1 - F.SHOULDER_CRATER_SHARE) ** F.SHOULDER_EXP) throw new Error('giant volcano: cone craters cut into the flank');
if (I.CLONE_TOP > I.SKY) throw new Error('giant volcano: the source reaches into the headroom');
if (I.TREE_CELL <= 2 * I.CROWN_R) throw new Error('giant volcano: crowns reach past the tree cells round theirs');

// The geometry, in the shared GLSL subset.
const SRC = /* glsl */ `
// gradient noise at (x, z) over wave cells, in stream salt: about ±1
float gvNoise(float x, float z, float wave, uint salt) { return thNoised(thFdiv(x, wave), thFdiv(z, wave), thStream(salt, 0)); }
// how much distances from the summit are stretched at column centre (x, z)
float gvWobble(float x, float z) {
  float n = gvNoise(x, z, GV_WOBBLE_WAVE, GV_SALT_WOBBLE) + GV_WOBBLE_FINE * gvNoise(x, z, GV_WOBBLE_FINE_WAVE, GV_SALT_WOBBLE_FINE);
  return 1.0 + GV_WOBBLE_AMP * clamp(n, -1.0, 1.0);
}
// the smooth cone's height at wobbled distance d from the summit: no crater, gullies or roughness
float gvCone(float d) {
  float t = thFdiv(d, GV_R);
  return t >= 1.0 ? GV_BASE : GV_BASE + GV_RISE * pow(1.0 - t, GV_EXP);
}
// How deep a gully cuts at offset (dx, dz) from the summit, r away, t its
// wobbled share of the radius: 0 to 1 of GULLY_DEPTH. Along the zero lines of
// noise sampled on a ring round the summit that grows downhill.
float gvGully(float dx, float dz, float r, float t) {
  float env = smoothstep(GV_GULLY_IN0, GV_GULLY_IN1, t) * (1.0 - smoothstep(GV_GULLY_OUT0, GV_GULLY_OUT1, t));
  if (env <= 0.0) return 0.0;
  float ring = GV_GULLY_RING + thFdiv(r, GV_GULLY_LEN);
  float n = thNoised(thFdiv(dx, r) * ring, thFdiv(dz, r) * ring, thStream(GV_SALT_GULLY, 0));
  return env * (1.0 - smoothstep(0.0, GV_GULLY_W, abs(n)));
}
// how far a line from the summit wanders sideways at distance along: amp at most, over wave cells along, in noise row row
float gvMeander(float along, float amp, float wave, float row) {
  return amp * smoothstep(GV_CRATER_R, GV_CRATER_R + GV_MEANDER_IN, along)
    * thNoised(thFdiv(along, wave), row, thStream(GV_SALT_MEANDER, 0));
}
// the angle round the summit of sector s of n spread over the flanks off the scar, off the sector's centre by jitter (hash h)
float gvSector(float s, float n, float jitter, uint h) {
  float share = thFdiv(s + 0.5 + jitter * (thUnit(thKey(h, GV_K_A)) - 0.5), n);
  return GV_BREACH_A + GV_SECTOR_CLEAR_A + (GV_TAU - 2.0 * GV_SECTOR_CLEAR_A) * share;
}
// A cone's rise at (ex, ez) from its centre (0 off it): foot radius R, height
// H on profile exponent p, with a crater this share of its radius, this deep.
float gvBump(float ex, float ez, float R, float H, float p, float share, float depth) {
  float e2 = ex * ex + ez * ez;
  if (e2 >= R * R) return 0.0;
  float e = sqrt(e2), cr = R * share;
  if (e < cr) return H * pow(1.0 - share, p) - depth * (1.0 - pow(thFdiv(e, cr), GV_CRATER_EXP));
  return H * pow(1.0 - thFdiv(e, R), p);
}
// side cone k's rise over the flank at offset (dx, dz) from the summit
float gvSideCone(float dx, float dz, int k) {
  uint h = thHash2(k, 0, GV_SALT_CONE);
  float a = gvSector(float(k), float(GV_CONES), GV_CONE_JITTER, h);
  float rc = GV_R * mix(GV_CONE_T_MIN, GV_CONE_T_MAX, thUnit(thKey(h, GV_K_T)));
  return gvBump(dx - rc * cos(a), dz - rc * sin(a), mix(GV_CONE_R_MIN, GV_CONE_R_MAX, thUnit(thKey(h, GV_K_R))),
    mix(GV_CONE_H_MIN, GV_CONE_H_MAX, thUnit(thKey(h, GV_K_H))), GV_CONE_EXP, GV_CONE_CRATER_SHARE, GV_CONE_CRATER_DEPTH);
}
float gvSideCones(float dx, float dz) {
  float c = 0.0;
  for (int k = 0; k < GV_CONES; k++) c = max(c, gvSideCone(dx, dz, k));
  return c;
}
// the flank cone's rise at offset (dx, dz) from the summit
float gvShoulder(float dx, float dz) {
  float rc = GV_SHOULDER_T * GV_R;
  return gvBump(dx - rc * cos(GV_SHOULDER_A), dz - rc * sin(GV_SHOULDER_A), GV_SHOULDER_R, GV_SHOULDER_H, GV_SHOULDER_EXP,
    GV_SHOULDER_CRATER_SHARE, GV_SHOULDER_CRATER_DEPTH);
}
// The scar's cut under the flank (0 outside it), at distance along the
// vent's direction and across it: a chute from under the rim to the sea,
// widening downhill between steep walls.
float gvScar(float along, float across) {
  if (along <= GV_CRATER_R) return 0.0;
  float s = thFdiv(along, GV_R);
  float w = mix(GV_SCAR_W_TOP, GV_SCAR_W_FOOT, s);
  if (abs(across) >= w) return 0.0;
  float depth = GV_SCAR_DEPTH * smoothstep(GV_CRATER_R, GV_CRATER_R + GV_SCAR_IN, along) * (1.0 - smoothstep(GV_SCAR_OUT0, GV_SCAR_OUT1, s));
  return depth * (1.0 - smoothstep(w - GV_SCAR_WALL, w, abs(across)));
}
float gvAlong(float dx, float dz) { return dx * cos(GV_BREACH_A) + dz * sin(GV_BREACH_A); }
float gvAcross(float dx, float dz) { return dz * cos(GV_BREACH_A) - dx * sin(GV_BREACH_A); }
// Old flow k's thickness at offset (dx, dz) from the summit (0 off it): from
// the rim down to its toe, widening as it goes, rounded across and at the toe.
float gvFlow(float dx, float dz, int k) {
  uint h = thHash2(k, 0, GV_SALT_FLOW);
  float a = gvSector(float(k), float(GV_FLOWS), GV_FLOW_JITTER, h);
  float along = dx * cos(a) + dz * sin(a), across = dz * cos(a) - dx * sin(a);
  float len = GV_R * mix(GV_FLOW_LEN_MIN, GV_FLOW_LEN_MAX, thUnit(thKey(h, GV_K_LEN)));
  float start = GV_CRATER_R + GV_R * GV_FLOW_START_MAX * thUnit(thKey(h, GV_K_T));
  float toe = mix(GV_FLOW_W_MIN, GV_FLOW_W_MAX, thUnit(thKey(h, GV_K_W)));
  if (along < start || along > len + toe || abs(across) > toe + GV_FLOW_MEANDER) return 0.0;
  float w = toe * mix(GV_FLOW_W_TOP, 1.0, min(thFdiv(along - start, len - start), 1.0));
  float m = across - gvMeander(along, GV_FLOW_MEANDER, GV_FLOW_MEANDER_WAVE, GV_FLOW_DECOR * float(k + 1));
  float past = max(along - len, 0.0);
  float q = thFdiv(m * m + past * past, w * w);
  return q < 1.0 ? GV_FLOW_THICK * sqrt(1.0 - q) : 0.0;
}
// the thickest old flow at offset (dx, dz) from the summit
float gvFlows(float dx, float dz) {
  float f = 0.0;
  for (int k = 0; k < GV_FLOWS; k++) f = max(f, gvFlow(dx, dz, k));
  return f;
}
// Is the column at distance along the vent's direction and across it in the
// channel down the scar?
bool gvInChannel(float along, float across) {
  if (along <= GV_CRATER_R || along >= GV_ACTIVE_LEN || abs(across) >= GV_CHANNEL_HALF + GV_MEANDER) return false;
  return abs(across - gvMeander(along, GV_MEANDER, GV_MEANDER_WAVE, GV_MEANDER_ROW)) < GV_CHANNEL_HALF;
}

// the sea floor's height at column centre (x, z)
float gvSeabed(float x, float z) { return max(float(GV_FLOOR), GV_SEABED + GV_SEABED_AMP * gvNoise(x, z, GV_SEABED_WAVE, GV_SALT_SEABED)); }

// The top of world column (x, z)'s ground: cells y < it are ground.
int gvTop(int x, int z) {
  float fx = float(x) + 0.5, fz = float(z) + 0.5;
  float dx = fx - GV_CX, dz = fz - GV_CZ;
  float r = sqrt(dx * dx + dz * dz);
  float d = r * gvWobble(fx, fz);
  if (d >= GV_R) return thRound(gvSeabed(fx, fz));
  float flank = gvCone(d);
  float g = flank;
  // the crater: a bowl from the rim down to its floor
  if (d < GV_CRATER_R) g = float(GV_RIM) - float(GV_CRATER_DEPTH) * (1.0 - pow(thFdiv(d, GV_CRATER_R), GV_CRATER_EXP));
  // roughness and gullies, clear of the crater; the cones (gullies stop at them)
  float clear = clamp(thFdiv(d, GV_CRATER_R) - GV_ROUGH_CLEAR, 0.0, 1.0);
  float rough = 0.0, cone = 0.0;
  if (clear > 0.0) {
    rough = GV_ROUGH_AMP * (gvNoise(fx, fz, GV_ROUGH_WAVE, GV_SALT_ROUGH) + GV_ROUGH_FINE * gvNoise(fx, fz, GV_ROUGH_FINE_WAVE, GV_SALT_ROUGH_FINE));
    cone = max(gvSideCones(dx, dz), gvShoulder(dx, dz));
    float gully = gvGully(dx, dz, r, thFdiv(d, GV_R)) * clamp(1.0 - thFdiv(cone, GV_CONE_H_MIN), 0.0, 1.0);
    g += clear * (rough - GV_GULLY_DEPTH * gully) + cone;
  }
  // old flows, paved over the gullies, standing proud
  float flow = gvFlows(dx, dz);
  if (flow > 0.0) g = flank + cone + GV_FLOW_ROUGH * clear * rough + flow;
  // the scar, a smooth chute under the vent, and the channel down its floor
  float along = gvAlong(dx, dz), across = gvAcross(dx, dz);
  float floorH = flank - gvScar(along, across);
  if (floorH < flank) g = min(g, floorH + GV_SCAR_ROUGH * clear * rough);
  if (gvInChannel(along, across)) g = min(g, floorH - GV_CHANNEL_DEPTH);
  // the hornito on the rim, over all of it
  float vx = fx - GV_VENT_X, vz = fz - GV_VENT_Z;
  g = max(g, float(GV_VENT_TOP) - GV_VENT_SLOPE * sqrt(vx * vx + vz * vz));
  // (the sea floor shows only round the cone's foot)
  return thRound(g < GV_SEABED + GV_SEABED_AMP ? max(g, gvSeabed(fx, fz)) : g);
}

// Rock's frost at cell (x, y, z): 0 warm, 1 frozen to the snow's temperature
// (the island's ramp with height, Volcano isles'), warm again round the summit.
float gvFrost(int x, int y, int z) {
  float lowest = float(GV_SNOW_LINE) - GV_SNOW_JITTER - GV_GULLY_SNOW;
  float dx = float(x) + 0.5 - GV_CX, dz = float(z) + 0.5 - GV_CZ, gap = GV_SNOW_CRATER_GAP * GV_CRATER_R;
  return clamp(thFdiv(float(y) - lowest + float(GV_FROST_DEPTH + GV_FROST_SPAN), float(GV_FROST_SPAN)), 0.0, 1.0)
    * smoothstep(GV_WARM_EDGE * gap, gap, sqrt(dx * dx + dz * dz));
}

// What the vent puts at cell (x, y, z): its lava source, or the lava of its
// conduit, standing over the hornito's point, and of the magma chamber at the
// conduit's root (the box volcano's, under the vent); E_WALL (never
// generated) for none of these.
int gvVent(int x, int y, int z) {
  if (y >= GV_CLONE_TOP) return E_WALL;
  float dx = float(x) + 0.5 - GV_VENT_X, dz = float(z) + 0.5 - GV_VENT_Z;
  float r2 = dx * dx + dz * dz, reach = GV_CHAMBER_BULGE + GV_CHAMBER_NECK;
  if (r2 >= reach * reach) return E_WALL;
  float hw = float(GV_CLONE_HALF);
  if (dx >= -hw && dx < hw && dz >= -hw && dz < hw && y >= GV_VENT_TOP - GV_CLONE_BELOW) return E_CLONE;
  float cr = GV_CONDUIT_R;
  if (y < GV_CHAMBER_TOP) cr = GV_CHAMBER_BULGE * (1.0 - thFdiv(float(y - GV_FLOOR), GV_CHAMBER_FADE)) + GV_CHAMBER_NECK;
  return r2 < cr * cr && y >= GV_FLOOR && y < GV_CONDUIT_TOP ? E_LAVA : E_WALL;
}

// Do all eight columns round (x, z) have ground up to at least lo?
bool gvSteady(int x, int z, int lo) {
  for (int k = 0; k < GV_SLOTS; k++) {
    if (k == GV_SELF) continue;
    if (gvTop(x + thMod(k, GV_ROW) - 1, z + thDiv(k, GV_ROW) - 1) < lo) return false;
  }
  return true;
}
// the snow line at column (x, z): wobbled, and lower in the gullies
int gvSnowLine(int x, int z) {
  float fx = float(x) + 0.5, fz = float(z) + 0.5, dx = fx - GV_CX, dz = fz - GV_CZ;
  float r = sqrt(dx * dx + dz * dz);
  float gully = r > 0.0 ? gvGully(dx, dz, r, thFdiv(r * gvWobble(fx, fz), GV_R)) : 0.0;
  return GV_SNOW_LINE + thRound(GV_SNOW_JITTER * gvNoise(fx, fz, GV_SNOW_WAVE, GV_SALT_SNOW) - GV_GULLY_SNOW * gully);
}

// A ground cell's element: snow on high ground where it lies still, glacier
// ice where it wouldn't; an old flow's basalt; else rock.
int gvGround(int x, int y, int z, int top) {
  int depth = top - 1 - y;   // 0: the top ground cell
  if (depth >= GV_SNOW_DEPTH && depth >= thRound(GV_FLOW_THICK) + GV_FLOW_ROOT && depth >= GV_CINDER_DEPTH && depth >= GV_ASH_DEPTH) return E_ROCK;
  float dx = float(x) + 0.5 - GV_CX, dz = float(z) + 0.5 - GV_CZ;
  if (depth < GV_SNOW_DEPTH && top >= GV_SNOW_LINE - thRound(GV_SNOW_JITTER + GV_GULLY_SNOW)
      && dx * dx + dz * dz > GV_SNOW_CRATER_GAP * GV_SNOW_CRATER_GAP * GV_CRATER_R * GV_CRATER_R && top >= gvSnowLine(x, z)) {
    return gvSteady(x, z, top - GV_SNOW_DROP) ? E_SNOW : E_ICE;
  }
  if (depth < GV_ASH_DEPTH && top <= GV_FLOOR_TOP + GV_ASH_RISE
      && dx * dx + dz * dz < GV_ASH_SHARE * GV_ASH_SHARE * GV_CRATER_R * GV_CRATER_R) return E_ASH;
  float flow = gvFlows(dx, dz);
  if (flow > 0.0 && float(depth) < flow + float(GV_FLOW_ROOT)) return E_BASALT;
  if (depth < GV_CINDER_DEPTH && gvSideCones(dx, dz) > GV_CINDER_RISE) return E_BASALT;
  return E_ROCK;
}

// What tree cell (cx, cz)'s tree puts at air cell (x, y, z): wood (its
// trunk), plant (its crown) or nothing. Its trunk stands on its column's
// ground, if that is in the forest band (over the sea's spray, under the
// snow, off the lava flows and the scar) and the forest's patch noise has
// a tree there (Volcano isles' trees, half as big again).
int gvTreePartMaterial(int x, int y, int z, int cx, int cz) {
  uint h = thHash2(cx, cz, GV_SALT_TREE);
  int tx = cx * GV_TREE_CELL + thRange(thKey(h, GV_K_X), GV_TREE_MARGIN, GV_TREE_CELL - 1 - GV_TREE_MARGIN);
  int tz = cz * GV_TREE_CELL + thRange(thKey(h, GV_K_Z), GV_TREE_MARGIN, GV_TREE_CELL - 1 - GV_TREE_MARGIN);
  int dx = x - tx, dz = z - tz;
  if (abs(dx) > GV_CROWN_R || abs(dz) > GV_CROWN_R) return E_EMPTY;
  float forest = clamp(thFdiv(gvNoise(float(tx) + 0.5, float(tz) + 0.5, GV_FOREST_WAVE, GV_SALT_FOREST) - GV_FOREST_EDGE, GV_FOREST_SOFT), 0.0, 1.0);
  if (float(thShare(h)) >= float(GV_TREE_YES_CUT) * forest) return E_EMPTY;
  int base = gvTop(tx, tz);
  if (base < GV_SEA + GV_TREE_ABOVE_SEA || base > GV_SNOW_LINE - thRound(GV_SNOW_JITTER + GV_GULLY_SNOW) - GV_TREE_SNOW_GAP) return E_EMPTY;
  float ox = float(tx) + 0.5 - GV_CX, oz = float(tz) + 0.5 - GV_CZ;
  if (gvFlows(ox, oz) > 0.0 || gvScar(gvAlong(ox, oz), gvAcross(ox, oz)) > 0.0) return E_EMPTY;
  int trunk = thRange(thKey(h, GV_K_TRUNK), GV_TRUNK_MIN, GV_TRUNK_MAX);
  if (dx == 0 && dz == 0 && y >= base && y < base + trunk) return materialWord(E_WOOD, AP_LOG_Y);
  int r2 = dx * dx + dz * dz;
  if (base >= GV_PINE_LINE) {
    // a pine: a cone of leaves, CROWN_R across at its skirt, narrowing to its tip
    int ch = trunk + GV_PINE_TIP - GV_PINE_SKIRT, u = y - base - GV_PINE_SKIRT;
    int w = GV_CROWN_R * (ch - u);
    return u >= 0 && u < ch && r2 * ch * ch < w * w ? materialWord(E_PLANT, AP_LEAVES) : E_EMPTY;
  }
  // a round crown (the box volcano's)
  int cy = y - (base + trunk - 1 + GV_CROWN_UP);
  return r2 + cy * cy < GV_CROWN_R2 ? materialWord(E_PLANT, AP_LEAVES) : E_EMPTY;
}
int gvTreePart(int x, int y, int z, int cx, int cz) { return materialId(gvTreePartMaterial(x, y, z, cx, cz)); }
// An air cell's element: part of a tree (a crown reaches no farther than a
// tree cell, so the ROW × ROW tree cells round are all that can reach it;
// trunks before leaves) or air.
int gvTreeMaterial(int x, int y, int z, int top) {
  if (y > top + GV_TREE_REACH || top < GV_SEA) return E_EMPTY;
  int cx = thDiv(x, GV_TREE_CELL), cz = thDiv(z, GV_TREE_CELL);
  int found = E_EMPTY;
  for (int k = 0; k < GV_SLOTS; k++) {
    int part = gvTreePartMaterial(x, y, z, cx + thMod(k, GV_ROW) - 1, cz + thDiv(k, GV_ROW) - 1);
    if (materialId(part) == E_WOOD) return part;
    if (materialId(part) == E_PLANT) found = part;
  }
  return found;
}
int gvTree(int x, int y, int z, int top) { return materialId(gvTreeMaterial(x, y, z, top)); }

// The element at world cell (x, y, z), its column's ground topping out at top (gvTop).
int gvCellInMaterial(int x, int y, int z, int top) {
  if (y < GV_FLOOR) return E_ROCK;
  if (y >= GV_SKY) return E_EMPTY;
  int vent = gvVent(x, y, z);
  if (vent != E_WALL) return vent;
  if (y < top) return gvGround(x, y, z, top);
  if (y < GV_SEA) return E_WATER;
  float dx = float(x) + 0.5 - GV_CX, dz = float(z) + 0.5 - GV_CZ;
  // the lava tongue in the channel, from the vent down the scar
  if (y < top + GV_ACTIVE_DEPTH && gvInChannel(gvAlong(dx, dz), gvAcross(dx, dz))) return E_LAVA;
  return gvTreeMaterial(x, y, z, top);
}
int gvCellIn(int x, int y, int z, int top) { return materialId(gvCellInMaterial(x, y, z, top)); }
int gvCellMaterial(int x, int y, int z) { return y >= GV_SKY ? E_EMPTY : gvCellInMaterial(x, y, z, gvTop(x, z)); }
int gvCell(int x, int y, int z) { return materialId(gvCellMaterial(x, y, z)); }
`;

const twin = memoTwin((P) => P.seed, (P) => compileShared(SRC, P.seed, jsConstants(P_, G)));   // the JS twin per world seed
export const GIANT = { ...G.ints, ...G.floats };
export const giantTwin = twin;   // (tools/scene-themed-preview.mjs)

// It starts on the shore the god view looks from (island.js ISLAND_VIEW_XZ:
// from +x +z), with the summit and its lava ahead: the window's centre this
// share of its width inland from the waterline, so it holds the sea, the
// shore and the lowest trees.
const START_INLAND = 0.25;
// The god view's home (index.js view): from low over the sea and far back, so
// the whole cone stands in view over the shore the window starts on.
const VIEW_ELEVATION = 12;        // degrees the camera looks down from
const VIEW_DIST = 576;            // cells from the orbit target
const VIEW_LIFT = 150;            // cells the orbit target hangs over the shore (the camera looks up the cone)
// Far field chunks a frame while it builds (world/far.js). At far.js's one a
// frame, its 256 chunks took 256 of this tall window's slow frames, and the
// cone filled in outward from the window as a round, flat-sided slab: a
// cylinder for half a minute or more. Its whole build costs ~1.5–1.7× the
// island's (M5, all chunks at once: 1.4 s against 0.73–0.95 s; three times as
// tall, its cells a cheap formula), so this many make each frame of the build
// cost what the island's 64 do: the cone is whole within 7 frames of load.
const FAR_CHUNKS_PER_FRAME = 40;

// The scene's WGSL (scenes/sceneGpu.js): constants, the helpers, the geometry
// (from the subset: scenes/subsetWgsl.js) and sceneCell.
const GV_U = sceneStruct();
let srcWgsl = null;
const gvWgsl = () => /* wgsl */ `
${sceneHeadWGSL(GV_U)}
${definesGLSL(P_, G)}
${helpersGLSL}
${srcWgsl ??= toWgsl(SRC, { consts: definesTypes(P_, G), uniforms: GV_U.sceneTypes })}
fn sceneCell(w: vec3i) -> SceneCell {
  let word = gvCellMaterial(w.x, w.y, w.z);
  let id = materialId(word);
  var T = SPAWNT(id);
  var ctype = 0.0;
  if (id == E_ROCK || id == E_BASALT) { T = mix(SPAWNT(id), SPAWNT(E_SNOW), gvFrost(w.x, w.y, w.z)); }   // frozen under the snow
  if (id == E_LAVA) { T = GV_MAGMA_T; ctype = f32(E_STONE); }   // hotter than spawned lava, setting to stone powder that rolls off the source
  if (id == E_CLONE) { ctype = f32(E_LAVA); }                   // the endless lava source
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, GV_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), T, SPAWNLIFE(id), appearanceCtype(id, ctype, materialAppearance(word)) + seed), vec4f(0.0));
}
`;

export const giantVolcano = {
  key: 'giantVolcano',
  label: 'Giant volcano',
  size: VOLC_SIZE,
  view: {
    dir: [ISLAND_VIEW_XZ[0], Math.tan(VIEW_ELEVATION * DEG) * Math.hypot(...ISLAND_VIEW_XZ), ISLAND_VIEW_XZ[1]],
    dist: VIEW_DIST,
    lift: VIEW_LIFT,
  },
  params: ({ size, seed }) => ({ size, seed: seed >>> 0, sea: I.SEA, floor: I.FLOOR }),
  glsl: () => gvWgsl(),
  uniformStruct: GV_U,
  uniforms: (P) => ({ uSceneSeed: P.seed }),
  start(P, win) {
    const T = twin(P), len = Math.hypot(...ISLAND_VIEW_XZ), dir = ISLAND_VIEW_XZ.map((v) => v / len);
    const at = (r) => [F.CX + dir[0] * r, F.CZ + dir[1] * r];
    let r = 0;
    while (r < F.R && T.gvTop(...at(r).map(Math.floor)) >= I.SEA) r++;
    return at(r - START_INLAND * Math.max(...win));
  },
  // the top of the topmost matter in the column (the sea's, off the shore)
  ground(x, z, P) {
    const T = twin(P), xi = Math.floor(x), zi = Math.floor(z), top = T.gvTop(xi, zi);
    // (the vent's lava and its source stand over the hornito's point)
    const vent = Math.hypot(xi + 0.5 - F.VENT_X, zi + 0.5 - F.VENT_Z) < F.CONDUIT_R + I.CLONE_HALF;
    for (let y = Math.min(Math.max(top + I.TREE_REACH, vent ? I.CLONE_TOP : 0), I.SKY - 1); y >= 0; y--) {
      if (T.gvCellIn(xi, y, zi, top) !== E.EMPTY) return y + 1;
    }
    return 0;
  },
  farChunksPerFrame: FAR_CHUNKS_PER_FRAME,
};
