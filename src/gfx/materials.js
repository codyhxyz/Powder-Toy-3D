// Render looks: how each element is *drawn*, independent of how it behaves.
// The simulation stays a blocky cellular automaton; the renderer rebuilds
// continuous surfaces and volumes from it. Like elements.js, this table goes
// to the GPU in the element tables' buffer (MATERIAL_FIELDS below; read in
// WGSL through accessors named as the GLSL arrays were: ROUGH(id), ALBEDO(id)).
//
//   ch     smooth-surface channel. Cells in a channel are drawn as one
//          continuous surface (the 0.5 isosurface of a blurred, normalised
//          occupancy field). Elements without a channel are "crisp": drawn
//          as (bevelled) voxels. Omitted, it is the element's kind's
//          (KIND_LOOK): only solids are crisp unless they say otherwise.
//          null opts out (a crisp powder, deliberately).
//   media  participating-medium channel (drawn as a density volume). A gas
//          needs one: without a channel it would be drawn as crisp voxels
//          (KIND_LOOK gives it one)
//   haze   the share of a full cell's density a cell of it adds to its
//          media channel (default 1). Steam and cloud are water droplets,
//          1; a clear gas a faint haze, a liberty so you can see where it is
//   rough  GGX roughness
//   metal  metalness
//   ior    index of refraction (transparent elements)
//   scatter  transparent elements: the scattering part of their extinction
//          (elements.js sigma) per cell, RGB; the rest is absorbed. Ratios to
//          sigma give the colour a deep body of it glows with.
//   bevel  crisp voxels: share of the global edge radius (gfx.bevel) its
//          edges are rounded by (default 1)
//   shed   × its emit in the light it casts round it (the glow volume; default 1):
//          small light sources' (see TORCH_SHED)
//   emit   light it gives off by itself at any temperature (luminescence), as
//          linear RGB radiance in the incandescence's scene units (sunlit
//          white ≈ 1.2): what a body of it shows. It adds to the thermal glow
//          wherever matter's light is used (emission(), below).

import { ELEMENTS, K, WATER_SCATTER, SALT_SCATTER_GAIN } from '../elements.js';
import { bandGlow, LUMA_709 } from './incandescence.js';
import { FLAME_COLOR } from './lamps.js';
import { accessorsWGSL } from '../shaders/hostStruct.js';
import { glf as f } from '../glsl.js';
import { CELL_M } from '../scale.js';
import { TEXTURE_SET } from './textureSet.js';

// sRGB decoding (IEC 61966-2-1)
const SRGB_LINEAR_MAX = 0.04045;   // encoded value where the linear segment ends
const SRGB_LINEAR_SLOPE = 12.92;   // slope of that segment
const SRGB_OFFSET = 0.055;         // offset of the power segment
const SRGB_GAMMA = 2.4;            // its exponent
const srgbToLinear = (c) => (c <= SRGB_LINEAR_MAX ? c / SRGB_LINEAR_SLOPE
  : Math.pow((c + SRGB_OFFSET) / (1 + SRGB_OFFSET), SRGB_GAMMA));
const linearOf = (c) => {
  if (Array.isArray(c)) return c;
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
};

// Fluorite's blue-violet fluorescence: the Eu²⁺ band at 424 nm, ~25 nm wide
// (CaF₂:Eu²⁺; "fluorescence" is named after fluorite). Under a UV lamp it is
// a few cd/m², which the incandescence's brightness curve would put near 0.03.
// A game liberty: it glows without the lamp, as bright as steel at ~850 °C:
// in daylight its own colour and luster still show through the glow, and in a
// dark cave the eyes adjust to it (gfx/post.js ADAPT).
const FLUORITE_BAND = { peak: 424, fwhm: 25, lum: 0.05 };
const FLUORITE_GLOW = bandGlow(FLUORITE_BAND.peak, FLUORITE_BAND.fwhm, FLUORITE_BAND.lum);
// A live conductor's light (src/electricity.js): an electric discharge in
// air glows blue-violet-white, from nitrogen's second positive bands
// (337-400 nm, running into the violet) and atomic lines across the visible.
// Drawn as one band centred in the blue, broad enough to read blue-white
// (linear ≈ 0.39, 0.65, 0.77), and twelve times fluorite's glow: it reads in
// daylight and lights a dark room.
const SPARK_BAND = { peak: 460, fwhm: 300, lum: 0.6 };
export const SPARK_GLOW = bandGlow(SPARK_BAND.peak, SPARK_BAND.fwhm, SPARK_BAND.lum);
// A lit lamp (elements.js LAMP): a warm-white incandescent bulb, 2700 K
// (sRGB ≈ #ffa957, Charity's blackbody table). A frosted bulb is far brighter
// than a sunlit wall (~10⁵ against ~10⁴ cd/m²); drawn at under twice sunlit
// white (≈ 1.2, above) so it stays a lamp, not a sun, and lights a room.
const LAMP_TINT = '#ffa957';
const LAMP_LUM = 2;
// ...and the light it sheds on the room, through the glow volume
// (shaders/passes.js brickFrag), is this many times what that radiance gives.
// A game liberty, as Halo's and Source's lit interiors are: a cell-sized bulb
// at that radiance lights the floor 3 m below to under 1% of sunlight (real
// rooms are ~1% of daylight, and real eyes adapt further than ADAPT's 4
// stops), so this brings it to ~10%, with a bright patch on the ceiling round it.
export const LAMP_ROOM_GAIN = 12;
// Foxfire (elements.js FUNGUS): fungal luciferin's green band, peaking at
// 520-530 nm and ~80 nm wide (Kotlobay et al. 2018, PNAS; Oliveira et al.
// 2015). Real foxfire is faint, ~10⁻³ cd/m², seen only by dark-adapted eyes;
// drawn at half fluorite's glow, so a patch reads in a dark cave (the eyes
// adjust: gfx/post.js ADAPT) and fades into its pale body in daylight. A game
// liberty, like fluorite's.
const FOXFIRE_BAND = { peak: 525, fwhm: 80, lum: 0.025 };
const FOXFIRE_GLOW = bandGlow(FOXFIRE_BAND.peak, FOXFIRE_BAND.fwhm, FOXFIRE_BAND.lum);
// Noita's glowing liquids (the magical ones and toxic sludge) shine faintly
// in their own colour: game magic. Luminance in the incandescence's scene
// units: a fifth of fluorite's, enough to pick a pool out of a dark cave.
const MAGIC_GLOW_LUM = 0.01;
const TOXIC_GLOW_LUM = 0.01;
// Noita's acid glows a touch too (its pools read in a dark cave): half again
// sludge's, in acid's lime, so it stays a glow and not a lamp.
const ACID_GLOW_LUM = 0.015;
const ACID_GLOW_TINT = '#55ff00';     // Noita's acid green (elements.js ACID colour)
// Sludge's glow is murkier, a yellow-olive, so it never reads as acid.
const TOXIC_GLOW_TINT = '#8fa832';
// A glow with the chromaticity of colour hex at luminance lum.
const tintGlow = (hex, lum) => {
  const c = linearOf(hex), y = c.reduce((t, v, i) => t + v * LUMA_709[i], 0);
  return c.map((v) => (v / y) * lum);
};
export const LAMP_GLOW = tintGlow(LAMP_TINT, LAMP_LUM);
// A wall torch (elements.js WALL_TORCH): a pitch flame's ~1,900 K orange (the
// hand torch's colour, pov/tools/torch.tool.js), its glow lighting the gallery
// round it through the glow volume. Noita's torches light a warm pool a few
// metres round them and leave the rest of the cave dark.
const TORCH_LUM = 0.06;   // a body of flame seen in the dark: orange once the eyes adjust, not a white box
const TORCH_GLOW = FLAME_COLOR.map((c) => c * TORCH_LUM);   // its blackbody colour (gfx/lamps.js)
// Embers (elements.js EMBER): coal glowing at ~800-900 °C, a dull orange
// (Charity's blackbody table, ≈ #ff7a30 at 900 °C: the deeper red of 800 °C
// washed the Coal Pits murky red). A clump of them lights the rock round it.
const EMBER_TINT = '#ff7a30';
const EMBER_LUM = 0.04;
const EMBER_GLOW = tintGlow(EMBER_TINT, EMBER_LUM);

// Light shed on the surroundings (LOOK shed): the glow volume (shaders/passes.js
// brickFrag) averages each 4³ brick and blurs it over ~±2 bricks, so a light
// one cell across is spread over hundreds of cells: a lone torch lit nothing
// round it (~1/1700 of its radiance at its own brick), while a lava pool's
// many cells add up. Small light sources therefore shed this many times their
// radiance, as LAMP_ROOM_GAIN does for a lamp: a game liberty, as Noita's
// torches and glowing ores light the rock round them. Tuned in the Descent's
// caves (a warm pool ~6-10 cells across round a torch, darkness between).
const TORCH_SHED = 20;      // a torch: a faint warm glow round it (world/torchLights.js lights the nearest as lamps)
const EMBER_SHED = 10;      // a clump of embers (many cells): a dull glow round it, not a wash
const CRYSTAL_SHED = 0.6;   // fluorite: the cold light of a cluster, modest (it flooded the Snowy Depths violet)

// Smooth-surface channels. sigma = blur radius in cells (how much the
// blockiness is smoothed away), ema = per-frame blend toward the new state
// (temporal smoothing; 1 = none). Liquids smooth the most, built structures not at all.
// cubic: thin features of the channel (drops, streams, lone grains) are read
// as a cubic B-spline instead of trilinearly (shaders/gfx/core.js surfSample),
// so they come out round instead of faceted, and so is all of it up close
// (gfx/detail.js cubicClose): falling sand and splashes.
export const CHANNELS = [
  { key: 'LIQUID', sigma: 1.0, ema: 0.35, transparent: true, cubic: true },
  { key: 'MOLTEN', sigma: 0.85, ema: 0.5 },
  { key: 'GRANULAR', sigma: 0.75, ema: 0.6, cubic: true },
  { key: 'ORGANIC', sigma: 0.6, ema: 1.0 },   // natural solids: wood, plant, rock
];
// Media channels share the liquid blur kernel. The first three are gases with
// optical properties (shaders/gfx/media.js), per cell at full density (field 1):
//   ext     extinction σt (1/cell). Fire: soot absorption, which also sets
//           its emission (Kirchhoff)
//   albedo  single-scattering albedo σs/σt, grey (no tint). Water droplets
//           ~1; wood smoke 0.5-0.9; soot ~0.2
//   g       Henyey–Greenstein anisotropy of the forward lobe (Mie: cloud and
//           fog droplets ~0.85, smoke ~0.6)
//   rise    drift of the sub-cell detail (cells/step): the gas rises and its
//           wisps ride along. Keep it a multiple of 1/256: then the drift at
//           the clock wrap (gfx/uniforms.js) is a whole number of noise tiles
// The 4th channel is the flame temperature weighted by fire density, so
// blurring averages the temperature of the burning gas, not of the air around
// it: T = AMBIENT + (w / fire) * HEAT_RANGE. It shares fire's EMA.
export const MEDIA = [
  { key: 'SMOKE', ema: 0.5, ext: 0.75, albedo: 0.35, g: 0.6, rise: 0.0625 },
  { key: 'STEAM', ema: 0.5, ext: 0.8, albedo: 0.98, g: 0.8, rise: 0.0625 },
  { key: 'FIRE', ema: 0.6, ext: 0.12, albedo: 0, g: 0, rise: 0.25 },
  { key: 'FLAME_T', ema: 0.6 },
];
const N_GASES = 3;   // MEDIA entries that are gases with optical properties (the first three)
// A fire cell's density: FIRE_BASE at the end of its life, 1 when fresh.
export const FIRE_BASE = 0.4;
// Temperature range packed into the flame-temperature channel.
export const HEAT_RANGE = 2500;
// Gas density (field value) below which a brick counts as holding no media.
// The renderer subtracts it, so the gas is exactly 0 where bricks get skipped.
export const MEDIA_FLOOR = 0.02;
// World cells per tile of the media detail noise (gfx/mediaNoise.js). A power
// of two, so the clock wrap stays seamless.
export const MEDIA_NOISE_CELLS = 64;

// Opaque materials (gfx/surface.js turns these into textured PBR surfaces):
//   alb    albedo: measured-ish real-world reflectance, as sRGB hex, or a
//          linear [r, g, b] (for metals this is F0, the normal-incidence
//          reflectance). Falls back to the element's UI colour.
//   sss    wrap / subsurface amount (0 = Lambert): light bleeding past the
//          terminator in porous or translucent stuff (snow, ash, leaves)
//   glint  fraction of the sun's specular that arrives as discrete sparkles
//          from individual grain facets (sand, snow, gunpowder)
//   surf   a texture family several elements share (SURFS), with its
//          parameters per element: 'CRAG' = natural rock (shaders/gfx/surface.js
//          rockCrags and its matOf branch): lumps, crags and creases, carved as
//          relief up close, with grit, stains, banding and pits; crag holds
//          its parameters (CRAG_PARAMS), each a multiple of ROCK's basalt;
//          'BRUSHED' = worked metal (brushed streaks, smudges, anisotropic
//          highlight, mill scale when hot), with brushed (BRUSHED_PARAMS);
//          'POLISHED' = polished soft metal (waviness, haze), with polished
//          (POLISHED_PARAMS)
//   macro  the shared play-distance variation every opaque material gets
//          (shaders/gfx/surface.js matMacro): { tone, hue, rough, size }:
//          albedo swing, warm/cool hue swing, roughness swing (each per unit
//          of a centred noise, p5..p95 about ±0.8) and the size of its patches as a
//          multiple of MACRO_M there. Defaults by kind: MACRO_DEFAULT
//   tex    a scanned texture (gfx/textureSet.js TEXTURE_SET id; Poly Haven,
//          public/textures/CREDITS.md): the realistic view draws the photo
//          (albedo, normal map, roughness), projected triplanar in the world,
//          in place of the element's procedural pattern (shaders/gfx/surface.js
//          matTextured), once the textures have loaded (gfx/materialTextures.js;
//          until then, the procedural look). The photo is scaled so its mean is
//          alb, the look's albedo (what the far view, GI and reflections draw
//          the element with), and its roughness so its mean is rough; with no
//          alb, alb is the photo's own mean.
//   texM   metres one tile of the texture covers (default: the scan's real size)
//   texN   the normal map's strength (default 1: as scanned)
//   texHue the share of the photo's own hue kept (default 0: recoloured to alb
//          channel by channel; 1: only its brightness is scaled to alb's).
//          For a photo whose colours are the point (grass: dry and green
//          blades), which a per-channel recolour turns into flat turf; the
//          far view and GI keep drawing alb, so keep it small (scrap: 1, so
//          its rust stays orange and its steel grey; its photo's alpha is
//          a metal mask, tools/bake-material-textures.mjs METAL_MASK, that
//          makes the rust a dielectric)
//   texVary  break up the tile's repeat (shaders/gfx/surface.js matTextured:
//          a second, offset read blended in by a low-frequency noise, Quilez's
//          "texture repetition"): for what covers big surfaces, where a 1-2 m
//          tile repeats visibly across a slope or up a trunk. Costs two more
//          reads per projection, so only those that need it
// A textured look's photo downloads once the element is in the map (the
// census: gfx/materialCensus.js), not with the page; until then the
// procedural look stands in.
// Albedo sources (approximate, visible band): dry quartz sand 0.35-0.55, fresh
// snow 0.85-0.95, concrete 0.25-0.4, wood ash 0.3-0.4, black powder ~0.04,
// bark 0.05-0.15, leaves ~0.05/0.15/0.03, basalt 0.08-0.15, tan sandstone
// 0.3-0.4 (redder toward the red end), limestone 0.4-0.6, coal 0.04-0.05
// (USGS spectral library, Clark et al. 2007). Metal F0 from measured complex
// IORs (iron/steel 0.56-0.58, gold 1.0/0.77/0.34).
const STEEL_F0 = [0.56, 0.57, 0.58];
const SCRAP_ALB = [0.3, 0.27, 0.24];   // scrap's mean: scuffed steel and rust (SCRAP below)
// Snow's photo keeps old footprints and tracks in its relief; fresh snow shows
// them faintly at most (its albedo is flattened at the bake for the same reason).
const SNOW_TEX_N = 0.5;
// The meadow grass keeps a little of its photo's own hue (dry blades among the
// green): at 0.6 its mean drifted to a pale olive (0.15, 0.17, 0.05 against
// PLANT's 0.07, 0.19, 0.03) and parted from the far view's and GI's green; at
// this it stays within ~0.02 of it.
const GRASS_TEX_HUE = 0.15;
// Sawdust is finer than the wood chips in its photo: the tile drawn at half its
// scanned 2 m, so the chips are a few millimetres.
const SAWDUST_TEX_M = 1;
// The fuse's woven cord: its threads' relief drawn deeper than the scan's (its
// albedo's contrast is raised 2.5x at the bake: ALBEDO_FLATTEN) and the tar a little
// glossy, so the weave reads on so dark a cord.
const FUSE_TEX_N = 2.5;
const FUSE_ROUGH = 0.45;
// An element's UI colour (elements.js color), for a textured look that keeps
// it as its albedo (a textured look without alb takes its photo's mean).
const uiColour = (key) => ELEMENTS.find((e) => e.key === key).color;
// Play-distance variation (macro, above). Nothing was authored at the 0.3-4 m
// the player looks at, so past a few metres every opaque material read as one
// flat albedo (docs/v2/evidence/audit-render.md 2.1-2.3). The rule is
// Noita's: every material carries a world-space texture, so a wall of it is
// never one flat colour; and Teardown's: each voxel's colour comes from its
// material's palette with a little spread (TPT's per-particle jitter, COLORVAR,
// does the voxel scale: surface.js matMacro). Amplitudes are eyeballed against
// the touchstones: natural ground drifts ~±15-30% in tone over a few metres
// (sun-bleached, damp, shaded, sorted), worked metal mostly in gloss (smudges,
// wear) and little in colour.
const MACRO_DEFAULT = {
  [K.SOLID]: { tone: 0.12, hue: 0.04, rough: 0.08, size: 1 },
  [K.POWDER]: { tone: 0.15, hue: 0.06, rough: 0.06, size: 1 },
  [K.LIQUID]: { tone: 0.05, hue: 0.02, rough: 0.04, size: 1 },   // the opaque melts (mud, mercury) that matOf shades
};
const MACRO_METAL = { tone: 0.05, hue: 0, rough: 0.12, size: 0.35 };   // smudges and wear: gloss, not colour, at hand scale
const MACRO_ROCK = { tone: 0.12, hue: 0.06, rough: 0.06, size: 1.5 };  // the CRAG rocks carry their own stains: broad patches only
const MACRO_NONE = { tone: 0, hue: 0, rough: 0, size: 1 };            // lava, crystal, void: their look is their own
const MACRO_PARAMS = ['tone', 'hue', 'rough', 'size'];
const LOOKS = {
  WALL: { rough: 0.85, alb: '#8f8c87', tex: 'concrete_wall_008' },
  SAND: { rough: 0.9, ior: 1.54, alb: '#c4a77c', glint: 0.55, macro: { tone: 0.16, hue: 0.12, rough: 0.06, size: 1 }, tex: 'dense_sand', texVary: true },
  STONE: { rough: 0.75, alb: '#7f7c77', macro: { tone: 0.2, hue: 0.06, rough: 0.08, size: 1 }, tex: 'gray_rocks' },
  SNOW: { rough: 0.55, ior: 1.31, alb: '#f3f6fb', sss: 0.55, glint: 0.8, macro: { tone: 0.04, hue: 0, rough: 0.12, size: 1 }, tex: 'snow_02', texVary: true, texN: SNOW_TEX_N },   // wind crust and drifts: gloss varies more than colour
  GUNPOWDER: { rough: 0.6, alb: '#38383d', glint: 0.7, tex: 'dense_sand' },   // graphite glaze: a soft sheen, many glints (sand's grains, darkened)
  ASH: { rough: 0.98, alb: '#a29e97', sss: 0.3, tex: 'moon_dusted_04', texVary: true },
  // Liquids. Clean water absorbs red most and scatters a little, mostly
  // blue: clear when shallow, blue-green with depth, at its measured strength
  // (elements.js WATER_ABSORB_M, WATER_SCATTER_M); brine scatters a little
  // more (SALT_SCATTER_GAIN) and absorbs the same. Oil is amber (absorbs
  // blue hardest), dark when thick. Acid is Noita's (elements.js ACID): it
  // scatters nearly all the green it stops (albedo ~0.95) and almost none of
  // the red and blue, so a body of it is a saturated, near-opaque lime; a
  // little rougher than water, so its sheen is broader and less of a mirror.
  WATER: { ior: 1.333, rough: 0.02, scatter: WATER_SCATTER },
  OIL: { ior: 1.47, rough: 0.03, scatter: [0.012, 0.008, 0.003] },
  ACID: { ior: 1.36, rough: 0.1, scatter: [0.09, 0.47, 0.02], emit: tintGlow(ACID_GLOW_TINT, ACID_GLOW_LUM) },
  LAVA: { ch: 'MOLTEN', rough: 0.35, alb: '#2a2522', macro: MACRO_NONE },   // its crust and glow are its own
  SMOKE: { media: 'SMOKE' },
  FIRE: { media: 'FIRE' },
  WOOD: { ch: 'ORGANIC', rough: 0.8, alb: '#5a4637', macro: { tone: 0.2, hue: 0.1, rough: 0.08, size: 0.6 }, tex: 'bark_brown_02', texVary: true },   // bark (end grain stays procedural)
  // Sawn softwood boards, a little weathered (planed pine ~0.35-0.45 reflectance; aged boards darker):
  // the scanned boards (Poly Haven brown_planks_04) where the photo has loaded, else shaders/gfx/surface.js matOf's planks branch
  PLANKS: { ch: 'ORGANIC', rough: 0.7, alb: '#8c6f54', macro: { tone: 0.15, hue: 0.08, rough: 0.08, size: 0.6 }, tex: 'brown_planks_04' },
  // (its photo is the meadows' grass alone, appearance GRASS: foliage stays procedural)
  PLANT: { ch: 'ORGANIC', rough: 0.5, alb: '#4b7a2f', sss: 0.25, macro: { tone: 0.3, hue: 0.45, rough: 0.1, size: 1 }, tex: 'leafy_grass', texVary: true, texHue: GRASS_TEX_HUE },   // lush .. sun-dried patches
  // Steel diamond plate (its scan's paint and rust greyed at the bake, so it
  // reads as bare steel), keeping the brushed highlight (surf BRUSHED)
  METAL: { rough: 0.32, metal: 1, alb: STEEL_F0, surf: 'BRUSHED', tex: 'metal_plate' },
  GLASS: { ior: 1.5, rough: 0.02, scatter: [0.005, 0.003, 0.004] },
  // Debris (elements.js breakInto): heaps of fragments, powders as TPT's BGLA,
  // SAWD and BRMT are. Crushed glass is near-white, as crushed ice is snow and
  // crushed halite salt: the fracture faces scatter far more than the glass
  // absorbs, leaving a faint green-blue where light runs through an edge
  // (soda-lime glass's iron). Its conchoidal faces are glass-smooth, so it
  // glints harder than salt. Sawdust is the pale inner wood (its UI colour),
  // fibrous and matte, light wrapping into the thin chips as into leaves.
  // Scrap is the same steel, torn and scuffed, glinting off its torn edges.
  SHARDS: { rough: 0.4, ior: 1.5, alb: '#dce8e6', sss: 0.45, glint: 0.9 },
  SAWDUST: { rough: 0.95, sss: 0.25, alb: uiColour('SAWDUST'), tex: 'wood_chips', texM: SAWDUST_TEX_M },
  // Its photo is rust-spotted steel: the rust is no metal (the photo's metal
  // mask) and keeps its own colour (texHue 1), so alb is the heap's mean, dull
  // steel and rust together (rust's ~0.2 drags it under bare steel's 0.56).
  SCRAP: { rough: 0.5, metal: 1, alb: SCRAP_ALB, glint: 0.6, surf: 'BRUSHED',
    brushed: { aniso: 0.35, scale: 1, wear: 2.5 }, macro: { tone: 0.12, hue: 0.03, rough: 0.2, size: 0.25 }, tex: 'rusty_metal_02', texHue: 1 },   // torn and scuffed: the brushing broken up, dull patches
  // Ice shares the liquid surface: a clear surface between ice and water is
  // nearly invisible in real life too (n = 1.31 vs 1.33). Frozen ice is
  // cloudy (trapped air), so it scatters white and stays visible.
  ICE: { ch: 'LIQUID', ior: 1.31, rough: 0.06, scatter: [0.025, 0.025, 0.025] },
  CLONE: { rough: 0.25, metal: 1, alb: [1.0, 0.766, 0.336], surf: 'POLISHED' },   // polished gold
  // natural rock (terrain): weathered basalt, part of the natural-solids surface
  // The rocks' photos (tex) replace the CRAG pattern once loaded, as bark's does.
  ROCK: { ch: 'ORGANIC', rough: 0.85, alb: '#4e4b48', surf: 'CRAG', macro: MACRO_ROCK, tex: 'dark_rock_02', texVary: true },
  // The other rocks share it (and its texture: surf CRAG, crag below).
  // Sandstone: quartz grains (n = 1.54, they glint like sand's) in a tan,
  // iron-stained cement, linear albedo ~0.45/0.33/0.2. Limestone: calcite
  // (n ~1.6), pale grey-buff ~0.5/0.48/0.43. Coal: albedo ~0.045 with a
  // sheen. Polished vitrinite has n ~1.7-1.8, but a natural face reflects only
  // the measured 0.04-0.05 in all, so its specular is no more than any
  // rock's (n 1.5, the default): its sheen is a smoother face than rock's.
  // (Glossier, it outshone the basalt beside it under a low sun.) Broken coal
  // shows the same faces fresh, glinting where they catch the sun.
  SANDSTONE: { ch: 'ORGANIC', macro: MACRO_ROCK, rough: 0.9, ior: 1.54, alb: '#b39c7c', glint: 0.25, surf: 'CRAG',
    crag: { relief: 0.6, pits: 0, bands: 2.5, stain: 1.5 }, tex: 'sandstone_cracks', texVary: true },   // rounded by weathering, bedded, iron-stained
  // Basalt: fresh lava rock, darker than ROCK's weathered face, its gas
  // bubbles frozen in as pits (vesicles), clinkery and unbedded (fresh flows
  // ~0.03-0.05 albedo, below the weathered 0.08-0.15).
  BASALT: { ch: 'ORGANIC', macro: MACRO_ROCK, rough: 0.9, alb: '#353331', surf: 'CRAG',
    crag: { relief: 1, pits: 1, bands: 0, stain: 0.2 }, tex: 'dark_rock', texVary: true },
  LIMESTONE: { ch: 'ORGANIC', macro: MACRO_ROCK, rough: 0.8, ior: 1.6, alb: '#bcb8af', surf: 'CRAG',
    crag: { relief: 1, pits: 0.4, bands: 1.5, stain: 0.4 }, tex: 'marble_rock_01', texVary: true },   // sharp solution runnels and pits, bedded
  COAL: { ch: 'ORGANIC', macro: MACRO_ROCK, rough: 0.75, alb: '#3c3c3d', surf: 'CRAG',
    crag: { relief: 0.5, pits: 0, bands: 2, stain: 0 }, tex: 'rock_face_04' },       // blocky cleat, bright and dull bands
  BROKENCOAL: { rough: 0.75, alb: '#3c3c3d', glint: 0.5, tex: 'rock_face_04' },   // coal's own face, broken
  // Fluorite (elements.js CRYSTAL): n = 1.434, a vitreous luster from flat
  // growth faces (polished glass with faint growth marks). A cell
  // is drawn as a cluster of pointed prisms (shaders/gfx/crystal.js); their
  // transmission and glow are worked out per prism in shaders/gfx/liquid.js
  // (crystalInterface); alb is the fallback surface's mean. Its
  // dust is pale, as any crushed coloured crystal is (scattering at the grain
  // faces swamps the absorption), and keeps the glow (powdered phosphors do).
  CRYSTAL: { rough: 0.065, ior: 1.434, alb: '#4a3478', scatter: [0.035, 0.018, 0.045], sss: 0.08, emit: FLUORITE_GLOW, shed: CRYSTAL_SHED, macro: MACRO_NONE },
  WALL_TORCH: { rough: 0.9, alb: '#d0702a', emit: TORCH_GLOW, shed: TORCH_SHED },   // a burning pitch head: deep orange, not a pale box once the eyes adjust
  EMBER: { rough: 0.8, alb: '#3a1c12', glint: 0.3, emit: EMBER_GLOW, shed: EMBER_SHED },
  CRYSTAL_DUST: { rough: 0.6, ior: 1.434, alb: '#b7a2d2', sss: 0.3, glint: 0.4, emit: FLUORITE_GLOW, shed: CRYSTAL_SHED },
  // Electronics (elements.js). A battery's printed steel can; silicon is
  // grey and mirror-like (n ≈ 3.9 in the visible: F0 ≈ 0.35), tinted as TPT
  // draws P and N; the switch a dark green relay; the insulator a pale,
  // chalky aerogel blue; the sensor TPT's magenta. The battery, switch and
  // sensor are painted steel: one greyed scan of painted panels, painted each
  // one's colour (the paint is no metal, so their metalness stays 0).
  BATTERY: { rough: 0.45, alb: '#6f6d1c', tex: 'blue_metal_plate' },
  PSCN: { rough: 0.15, ior: 3.9, alb: '#5c4646' },
  NSCN: { rough: 0.15, ior: 3.9, alb: '#46465c' },
  SWITCH: { rough: 0.4, alb: '#1d4a1f', tex: 'blue_metal_plate' },
  BUTTON: { rough: 0.4, alb: '#8a482b', tex: 'blue_metal_plate' },
  CONTACTOR: { rough: 0.4, alb: '#394f68', tex: 'blue_metal_plate' },
  INSULATOR: { rough: 0.95, alb: '#a7aec2', sss: 0.3 },
  TSNS: { rough: 0.5, alb: '#c21aa6', tex: 'blue_metal_plate' },
  LAMP: { rough: 0.5, ior: 1.5, alb: '#f4e6c4', sss: 0.5 },   // frosted bulb glass: its light is sparkEmit's (lampLit)
  PCLN: { rough: 0.35, metal: 1, alb: [0.45, 0.36, 0.14], surf: 'POLISHED', polished: { wave: 1, haze: 2 } },   // Clone's gold, tarnished: TPT draws it dark olive
  // Radioactive metals as powders: a metal powder is dark, since light is
  // trapped between the grains, with bright glints off the facets. Uranium
  // tarnishes to a dark grey-black oxide (UO₂ is black); plutonium's oxide
  // skin is dull olive-grey.
  // Both draw sand's grains (dense_sand), darkened to their oxides.
  URANIUM: { rough: 0.55, alb: '#3f413b', glint: 0.5, tex: 'dense_sand' },
  PLUTONIUM: { rough: 0.6, alb: '#45493a', glint: 0.4, tex: 'dense_sand' },
  // Batch 3 (elements.js, el-mat). Void: matte black, a hole in the world.
  VOID: { rough: 1, alb: '#0d0809', macro: MACRO_NONE },
  // Red brick reflects ~0.25 in the red, ~0.1 in the green and ~0.06 in the
  // blue (USGS spectral library, fired clay); built, so crisp like Wall.
  // Crushed, it is paler: the broken faces scatter more.
  BRICK: { rough: 0.9, alb: [0.25, 0.1, 0.06], macro: { tone: 0.18, hue: 0.1, rough: 0.06, size: 1 }, tex: 'red_brick' },   // weathered, sooted walls
  RUBBLE: { rough: 0.95, alb: [0.3, 0.14, 0.09], tex: 'brick_gravel' },
  // Metals: F0 from measured complex indices (n, k at 450/550/650 nm;
  // refractiveindex.info): titanium (0.54, 0.50, 0.45), tungsten ~0.5 grey,
  // gold as Clone's, mercury ~0.75 flat (a liquid mirror).
  // Worked metals are brushed like Metal's steel (surf BRUSHED; only steel
  // grows black mill scale when hot: titanium's and tungsten's oxides are
  // thin films); gold has Clone's polish (surf POLISHED). Untextured, they
  // read as plastic beside Metal and Clone (audit-render.md B10). Nuggets are
  // water-worn lumps: a coarse, hammered waviness and a hazier gloss.
  TITANIUM: { rough: 0.35, metal: 1, alb: [0.542, 0.497, 0.449], surf: 'BRUSHED', brushed: { aniso: 1, scale: 0, wear: 1 } },
  TUNGSTEN: { rough: 0.3, metal: 1, alb: [0.5, 0.49, 0.46], surf: 'BRUSHED', brushed: { aniso: 1, scale: 0, wear: 1 } },
  GOLD: { rough: 0.3, metal: 1, alb: [1.0, 0.766, 0.336], surf: 'POLISHED' },
  NUGGETS: { rough: 0.45, metal: 1, alb: [1.0, 0.766, 0.336], glint: 0.6, surf: 'POLISHED', polished: { wave: 6, haze: 2 } },
  // Liquid metal: an opaque mirror, smoothed like a melt (it shares lava's
  // channel; the two never meet, since mercury boils at 357 °C)
  MERCURY: { ch: 'MOLTEN', rough: 0.04, metal: 1, alb: [0.75, 0.75, 0.74] },
  SOLID_MERCURY: { rough: 0.35, metal: 1, alb: [0.75, 0.75, 0.74], surf: 'POLISHED' },
  // Plasma draws as flame (its light, by the flame's temperature channel)
  PLASMA: { media: 'FIRE' },
  // Diamond: n = 2.417, so it sparkles far more than glass (n 1.5); a
  // colourless stone barely absorbs or scatters
  DIAMOND: { ior: 2.417, rough: 0.01, scatter: [0.0005, 0.0005, 0.0005] },
  // Batch 2, chemistry and cold (elements.js). Liquid nitrogen is clear and
  // colourless, n = 1.199 (CRC); its boiling fills it with bubbles that
  // scatter a little. Saturated brine is water with n = 1.378 (CRC, 26 % NaCl).
  LIQUID_NITROGEN: { ior: 1.199, rough: 0.03, scatter: [0.004, 0.004, 0.004] },
  SALTWATER: { ior: 1.378, rough: 0.02, scatter: WATER_SCATTER.map((b) => +(b * SALT_SCATTER_GAIN).toPrecision(3)) },
  // Salt: clear halite cubes (n = 1.544) crushed white, albedo ~0.8, light
  // wrapping into the grains and glinting off their cube faces.
  // The white powders (salt, dry ice, dust) draw snow's crust, as white and as fine.
  SALT: { rough: 0.55, ior: 1.544, alb: '#e2e0da', sss: 0.35, glint: 0.7, tex: 'snow_02', texN: SNOW_TEX_N },
  // Dry ice: pressed CO₂ snow, white and porous (n ~1.4), light bleeding into it.
  DRY_ICE: { rough: 0.8, ior: 1.4, alb: '#e4e8ec', sss: 0.5, tex: 'snow_02', texN: SNOW_TEX_N },
  // Lithium is silvery cut, but dulls in air within minutes (nitride, hydroxide):
  // a grey, rough metal.
  LITHIUM: { rough: 0.55, metal: 1, alb: [0.55, 0.55, 0.56], surf: 'BRUSHED', brushed: { aniso: 0.3, scale: 0, wear: 2 } },
  // Clear gases (CO₂, hydrogen, oxygen) are invisible: a faint haze shows where
  // they are. Hydrogen chloride fumes in moist air, pulling the water vapour
  // out as a mist of acid droplets (real), so it shows more.
  CO2: { haze: 0.06 },
  HYDROGEN: { haze: 0.04 },
  OXYGEN: { haze: 0.05 },
  CAUSTIC_GAS: { haze: 0.3 },
  // Batch 4. Flour reflects ~0.8, matte, and light bleeds into a loose heap.
  // Kaolin is as white (ISO brightness 80-90%); mud is darker, as any wet
  // soil is (water in the pores cuts the scattering: about half the
  // reflectance; Lekner & Dorf, Appl. Opt. 27, 1988) and wet-glossy, drawn
  // with lava's opaque-liquid surface. Ceramic is fired and glazed: white tiles
  // (its photo), glossy where a bisque would be matte.
  // Antimatter is a game substance: a pale lilac powder with a sheen, so it
  // reads apart from the other powders. The singularity reflects nothing.
  DUST: { rough: 0.95, alb: '#ebe2cc', sss: 0.35, tex: 'snow_02', texN: SNOW_TEX_N },
  CLAY: { rough: 0.95, alb: '#e2dccf', sss: 0.2, macro: { tone: 0.12, hue: 0.1, rough: 0.06, size: 1 }, tex: 'clay_plaster' },
  MUD: { ch: 'MOLTEN', rough: 0.3, alb: '#a49b8a', macro: { tone: 0.15, hue: 0.08, rough: 0.2, size: 0.6 }, tex: 'brown_mud_02' },   // wetter: darker and glossier patches
  CERAMIC: { rough: 0.3, alb: '#efeae0', tex: 'long_white_tiles' },
  ANTIMATTER: { rough: 0.4, alb: '#b9b0d9', glint: 0.6 },
  SINGULARITY: { rough: 1, alb: '#000000', macro: MACRO_NONE },
  // Explosives (elements.js). C-4 is an off-white putty, moulded smooth, a
  // little waxy (light wraps into its edges). Nitroglycerin is a clear, pale
  // yellow oil, n = 1.479. Cast TNT is pale yellow-brown, dull and crystalline.
  // Thermite is rust-red iron oxide with flecks of aluminium that glint. A
  // safety fuse is a tarred cord. Propane is invisible: it borrows steam's
  // haze so you can see where it pools (a liberty). The putty and cast TNT
  // draw clay's smooth plaster; thermite coarse rust; the fuse woven jute.
  C4: { ch: 'ORGANIC', rough: 0.55, alb: '#d6d0bf', sss: 0.2, tex: 'clay_plaster' },
  NITRO: { ior: 1.479, rough: 0.03, scatter: [0.004, 0.004, 0.004] },
  TNT: { rough: 0.7, alb: '#b9975a', tex: 'clay_plaster' },
  THERMITE: { rough: 0.8, alb: '#6f4436', glint: 0.35, tex: 'rust_coarse_01' },
  FUSE: { ch: 'ORGANIC', rough: FUSE_ROUGH, alb: '#2a4424', tex: 'hessian_230', texN: FUSE_TEX_N },
  // Noita's liquids (elements.js), each tinted by its sigma and scatter: the
  // scattered share sets the colour a deep body shows. Blood is near opaque
  // (haemoglobin absorbs blue and green within a millimetre; red cells
  // scatter red): n ~1.35 (plasma). Sludge is a murky yellow-olive suspension
  // (dull: it scatters a quarter of what it stops; acid, the vivid lime, ~all); slime a
  // pink-purple gel, glossy but not mirror-smooth; whiskey a clear amber
  // (n = 1.356 for 40 % ethanol). The potions are clear tinctures (n ~1.34).
  BLOOD: { ior: 1.35, rough: 0.04, scatter: [0.7, 0.04, 0.04] },
  TOXIC: { ior: 1.36, rough: 0.12, scatter: [0.24, 0.25, 0.04], emit: tintGlow(TOXIC_GLOW_TINT, TOXIC_GLOW_LUM) },
  SLIME: { ior: 1.34, rough: 0.12, scatter: [0.12, 0.05, 0.12] },
  WHISKEY: { ior: 1.356, rough: 0.02, scatter: [0.002, 0.002, 0.002] },
  TELEPORTATIUM: { ior: 1.34, rough: 0.02, scatter: [0.004, 0.012, 0.014], emit: tintGlow('#3cc6e8', MAGIC_GLOW_LUM) },
  LEVITATIUM: { ior: 1.34, rough: 0.02, scatter: [0.02, 0.025, 0.012], emit: tintGlow('#a7ad7a', MAGIC_GLOW_LUM) },
  HEALTHIUM: { ior: 1.34, rough: 0.02, scatter: [0.02, 0.04, 0.008], emit: tintGlow('#c8f26a', MAGIC_GLOW_LUM) },
  BERSERKIUM: { ior: 1.34, rough: 0.02, scatter: [0.012, 0.006, 0.002], emit: tintGlow('#ef5a26', MAGIC_GLOW_LUM) },
  POLYMORPHINE: { ior: 1.34, rough: 0.02, scatter: [0.015, 0.006, 0.012], emit: tintGlow('#ee6fcf', MAGIC_GLOW_LUM) },
  PHEROMONE: { ior: 1.34, rough: 0.02, scatter: [0.015, 0.004, 0.006], emit: tintGlow('#ff3d62', MAGIC_GLOW_LUM) },
  // Moss: a dark, matte green mat (moss reflects ~0.05-0.1 in the visible,
  // greenest near 550 nm); light wraps into its leaves. Its photo is moss
  // clumps over a forest floor. Fungus: pale buff mycelium over the wood,
  // glowing green (foxfire).
  MOSS: { ch: 'ORGANIC', rough: 0.95, alb: '#3e5a24', sss: 0.3, macro: { tone: 0.3, hue: 0.35, rough: 0.05, size: 0.5 }, tex: 'forest_leaves_02', texVary: true },
  FUNGUS: { ch: 'ORGANIC', rough: 0.75, alb: '#c9c3a0', sss: 0.35, emit: FOXFIRE_GLOW, macro: { tone: 0.2, hue: 0.15, rough: 0.08, size: 0.4 } },
  // Meat (elements.js MEAT, COOKED_MEAT): raw lean muscle is wet (a glossy
  // surface, water's n = 1.33) and translucent, red with myoglobin (light
  // wraps into it as into skin); cooking browns and dries it (the Maillard
  // crust) and denatures the proteins, which scatter: matte, opaque, brown.
  // Saturated past the measured values, as the Castle Crashers look wants.
  MEAT: { rough: 0.35, ior: 1.33, alb: '#b8424a', sss: 0.5 },
  COOKED_MEAT: { rough: 0.7, alb: '#6e4126', sss: 0.15 },
  // Noita's terrain (elements.js NOITA_*) in the realistic view, each its
  // UI colour (the mean of Noita's own texture): the rock scans, and the
  // jungle's lush soil the moss's forest floor. The Noita view keeps its own
  // pixel art (shaders/gfx/noita.js), which returns before any of this.
  NOITA_SNOWROCK: { alb: uiColour('NOITA_SNOWROCK'), tex: 'marble_rock_01', texVary: true },
  NOITA_VAULT: { alb: uiColour('NOITA_VAULT'), tex: 'dark_rock', texVary: true },
  NOITA_TEMPLE: { alb: uiColour('NOITA_TEMPLE'), tex: 'sandstone_cracks', texVary: true },
  NOITA_LUSH: { alb: uiColour('NOITA_LUSH'), tex: 'forest_leaves_02', texVary: true },
};

// Shared texture families (LOOKS surf). NONE: an element's own (or none).
export const SURFS = ['NONE', 'CRAG', 'BRUSHED', 'POLISHED'];
// CRAG parameters, as multiples of ROCK's weathered basalt (the defaults):
//   relief  height of the crags and creases (and of their carving up close)
//   pits    gas vesicles in basalt; small solution pits in limestone
//   bands   lava-flow banding in basalt; bedding in sedimentary rock
//   stain   rusty iron-oxide patches
const CRAG_PARAMS = ['relief', 'pits', 'bands', 'stain'];
const CRAG_DEFAULT = { relief: 1, pits: 1, bands: 1, stain: 1 };
// BRUSHED parameters, as multiples of Metal's steel (the defaults):
//   aniso  the brushed highlight's anisotropy (torn scrap: little)
//   scale  black mill scale when hot (steel's; 0 where the oxide is a thin film)
//   wear   smudges and scuffs (their albedo and roughness swing)
const BRUSHED_PARAMS = ['aniso', 'scale', 'wear'];
const BRUSHED_DEFAULT = { aniso: 1, scale: 1, wear: 1 };
// POLISHED parameters, as multiples of Clone's polished gold:
//   wave   height of the polishing waviness (water-worn nuggets: hammered lumps)
//   haze   the haze in the gloss
const POLISHED_PARAMS = ['wave', 'haze'];
const POLISHED_DEFAULT = { wave: 1, haze: 1 };
// A family's parameters, packed into the material's surfP (a vec4, zero-padded)
const FAMILY_PARAMS = {
  CRAG: { key: 'crag', names: CRAG_PARAMS, def: CRAG_DEFAULT },
  BRUSHED: { key: 'brushed', names: BRUSHED_PARAMS, def: BRUSHED_DEFAULT },
  POLISHED: { key: 'polished', names: POLISHED_PARAMS, def: POLISHED_DEFAULT },
};
const SURF_P_LEN = 4;
const familyParams = (l) => {
  const f = FAMILY_PARAMS[l.surf];
  const v = f ? f.names.map((k) => (l[f.key] ?? f.def)[k] ?? f.def[k]) : [];
  return [...v, ...Array(SURF_P_LEN - v.length).fill(0)];
};
// A look's scanned texture (LOOKS tex): texMap (its first layer in the texture
// array, or NO_TEX while its photo isn't there; tiles per cell; the photo's
// mean roughness; the normal map's strength) and texTint (what scales the
// photo's albedo to the look's mean, rgb; w: 1 to break up the repeat,
// texVary). TEX_LAYERS: array layers per texture (albedo, surface:
// gfx/materialTextures.js). The layer is the only value that changes after
// the page loads: gfx/materialTextures.js places a photo when its element
// shows up, then sets it here (setTexLayer, so tables built later carry it)
// and in the element tables on the GPU.
export const TEX_LAYERS = 2;
export const NO_TEX = -1;
const DEFAULT_TEX_NORMAL = 1;
const luma = (c) => c.reduce((s, v, k) => s + v * LUMA_709[k], 0);
const mix = (a, b, t) => a + (b - a) * t;
const texOf = (key) => {
  const i = TEXTURE_SET.findIndex((t) => t.id === key);
  if (i < 0) throw new Error(`LOOKS tex: no texture ${key} (gfx/textureSet.js)`);
  return { i, t: TEXTURE_SET[i] };
};
const texFields = (l, alb) => {
  if (!l.tex) return { texAsset: NO_TEX, texMap: [NO_TEX, 0, 0, 0], texTint: [1, 1, 1, 0] };
  const { i, t } = texOf(l.tex);
  return {
    texAsset: i,
    texMap: [NO_TEX, +(CELL_M / (l.texM ?? t.tileM)).toFixed(ROUND_DIGITS), t.roughMean, l.texN ?? DEFAULT_TEX_NORMAL],
    texTint: [...alb.map((v, k) => +(mix(v / t.mean[k], luma(alb) / luma(t.mean), l.texHue ?? 0)).toFixed(ROUND_DIGITS)), l.texVary ? 1 : 0],
  };
};
const macroOf = (e, l) => {
  const m = l.macro ?? (l.metal ? MACRO_METAL : MACRO_DEFAULT[e.kind] ?? MACRO_NONE);
  return MACRO_PARAMS.map((k) => m[k] ?? MACRO_NONE[k]);
};

// The surface an element's kind gets where LOOKS gives it none: a powder is a
// granular heap, a liquid the liquid surface, a gas steam's mist (steam and
// cloud are water droplets; mercury vapour shows as the droplets it condenses
// into in cool air; propane borrows it so you can see where it pools). Without
// it a new powder (the debris a solid breaks into, say) drew as a pile of cubes.
const KIND_LOOK = { [K.POWDER]: { ch: 'GRANULAR' }, [K.LIQUID]: { ch: 'LIQUID' }, [K.GAS]: { media: 'STEAM' } };
// Defaults for elements LOOKS leaves out (the rest default to 0: none).
const DEFAULT_ROUGH = 0.7;
const DEFAULT_IOR = 1.5;
// Decimal places the baked material values are rounded to (as the GLSL
// literals were).
const ROUND_DIGITS = 4;

const chIndex = (k) => (k ? CHANNELS.findIndex((c) => c.key === k) : -1);
const mediaIndex = (k) => (k ? MEDIA.findIndex((m) => m.key === k) : -1);

export const LOOK = ELEMENTS.map((e) => {
  const l = { ...KIND_LOOK[e.kind], ...LOOKS[e.key] };
  // a textured look without its own albedo takes the photo's mean
  const alb = linearOf(l.alb ?? (l.tex ? texOf(l.tex).t.mean : e.color)).map((v) => +v.toFixed(ROUND_DIGITS));
  return {
    ...texFields(l, alb),
    ch: chIndex(l.ch), media: mediaIndex(l.media), haze: l.haze ?? 1, rough: l.rough ?? DEFAULT_ROUGH, metal: l.metal ?? 0, ior: l.ior ?? DEFAULT_IOR,
    alb, sss: l.sss ?? 0, glint: l.glint ?? 0,
    bevel: l.bevel ?? 1,
    emit: (l.emit ?? [0, 0, 0]).map((v) => +v.toFixed(ROUND_DIGITS)),
    shed: l.shed ?? 1,
    surf: SURFS.indexOf(l.surf ?? 'NONE'),
    surfP: familyParams(l),
    macro: macroOf(e, l),
    // single-scattering albedo: the scattered share of the extinction
    scatAlb: (l.scatter ?? [0, 0, 0]).map((s, i) => +(e.sigma[i] > 0 ? Math.min(1, s / e.sigma[i]) : 0).toFixed(ROUND_DIGITS)),
  };
});

// The small maps' floor (shaders/gfx/surface.js floorAlb), a scanned look that
// is no element's: plain sealed concrete, scuffed, a lab or workshop floor, scaled
// in the shader to the floor's albedo (gfx/sky.js groundAlb, which GI and the
// open ground around the box keep drawing). tiles: tiles per cell (the scan's
// real size); mean: the photo's mean albedo; layer: its first layer in the
// texture array, NO_TEX until it loads (the frame uniforms' floorTex:
// gfx/uniforms.js), the flat floor until then. Wanted once a small map's view
// draws scanned looks (gfx/volume.js recordCensus).
const FLOOR_TEX_ID = 'concrete_floor_worn_001';
export const FLOOR_TEX = (() => {
  const { i, t } = texOf(FLOOR_TEX_ID);
  return { asset: i, layer: NO_TEX, tiles: +(CELL_M / t.tileM).toFixed(ROUND_DIGITS), mean: t.mean };
})();

// The texture asset (gfx/textureSet.js index) element id draws from, or NO_TEX.
export const texAssetOf = (id) => LOOK[id]?.texAsset ?? NO_TEX;
// Asset `asset`'s photo now sits from array layer `layer` on (NO_TEX: gone):
// every look drawing from it takes the layer. Returns the elements changed.
export function setTexLayer(asset, layer) {
  const ids = [];
  LOOK.forEach((l, id) => { if (l.texAsset === asset) { l.texMap[0] = layer; ids.push(id); } });
  if (asset === FLOOR_TEX.asset) FLOOR_TEX.layer = layer;
  return ids;
}

// 5-tap Gaussian weights (offsets -2..2), normalised.
export function gauss5(sigma) {
  const w = [-2, -1, 0, 1, 2].map((k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

// Field value of the drawn surface (the isosurface level).
export const ISO = 0.5;

// Thin features (a lone grain or droplet, a one-cell trunk, a film, a falling
// stream) blur below the isosurface and would vanish. Next to cells that hold
// the channel right now, a feature whose local peak is under the channel's
// bulk peak is scaled up so its surface sits THIN_RADIUS cells from the cell
// centre (shaders/fields.js, boost passes).
export const THIN_RADIUS = 0.5;     // cells
// Peaks below this are never scaled (keeps the divide sane); a cell's first
// frame under the slowest EMA is still well above it.
export const THIN_MIN_PEAK = 0.01;
// The thin mask (fields.js; where the tracer reads cubic channels cubic)
// rises from 0 to 1 between these boost factors. Trilinear only fails badly
// on features thin in two or three axes: a lone drop is boosted ~13x and a
// one-cell stream ~4.5x (sigma 1), while a one-cell film (~1.6x) reads within
// ~0.05 cells of its cubic surface anyway, so shallow water stays cheap.
export const THIN_MASK_LO = 1.8;
export const THIN_MASK_HI = 3.0;

// Liquid features as big as the water they hold (shaders/fields.js). V2
// keeps each liquid cell's exact fill, so the boost sizes a thin liquid
// feature by the most any cell of its 3³ holds instead of blowing every one
// up to THIN_RADIUS: a cell in the air with fill f is a drop of its own
// volume, radius cbrt(3f / 4π) cells (a lone full cell 0.62, capped at
// THIN_RADIUS; a 1 % parcel 0.13 cells, 4 cm), and one resting on something
// (the floor, matter, other liquid) is a film whose top sits f above its
// cell's base, f - 1/2 from its centre (a signed radius: under the centre the
// boost's peak goes below ISO). Over a floor the field reads at most ~1.09x
// a film's centre (the box's edge clamps it, a crisp bed counts neither way),
// so the fields draw resting water from FILM_MIN_CELLS up; a film thinner
// than that, on a floor, is left out of them and drawn by the tracer at its
// true thickness (shaders/gfx/film.js).
export const DROP_RADIUS_K = Math.cbrt(3 / (4 * Math.PI));   // cells per cube root of fill: a sphere of the fill's volume
export const FILM_MIN_CELLS = 0.7;   // cells (21 cm): the thinnest film the field shows over a floor (at 0.5 its peak sits on ISO)
export const FILL_EPS = 1 / 255;

// The local peak at or above which a feature needs no boost, for a blur with
// 5-tap weights w. Along an axis the trilinear field falls from a lone cell's
// peak to fall·peak at the next cell centre, so it crosses THIN_RADIUS at
// (1 - THIN_RADIUS·(1 - fall))·peak: put ISO there.
export function bulkPeak(w) {
  const fall = w[3] / w[2];
  return Math.min(1, ISO / (1 - THIN_RADIUS * (1 - fall)));
}

// Uniform cubic B-spline kernel (support ±2 cells).
function bspline3(x) {
  const a = Math.abs(x);
  if (a < 1) return (4 - 6 * a * a + 3 * a * a * a) / 6;
  return a < 2 ? (2 - a) ** 3 / 6 : 0;
}
// What a cubic B-spline sample reads at a cell centre: the field smoothed by
// these lattice weights (offsets -1, 0, 1). The boost measures cubic
// channels' peaks on that smoothed field (shaders/fields.js).
export const CUBIC_LATTICE = [-1, 0, 1].map(bspline3);

// bulkPeak for a channel read as a cubic B-spline, with the peak measured on
// the lattice-smoothed field. Along an axis through a thin feature's peak the
// sample falls by B(x)/B(0), where B is the B-spline of a lone cell's blurred
// profile; that ratio is the same for drops, streams and films (the other axes'
// factors cancel), so one peak puts all their surfaces THIN_RADIUS out.
export function bulkPeakCubic(w) {
  const B = (x) => w.reduce((s, wk, i) => s + (wk / w[2]) * bspline3(x - (i - 2)), 0);
  return Math.min(1, (ISO * B(0)) / B(THIN_RADIUS));
}

// Liquids whose churn aerates into whitewater (gfx/foam.js): the liquids whose
// surface tension the liquid detail models (shaders/gfx/liquidDetail.js
// LIQ_PROPS, whose aeration pass foams exactly these). On the GPU it is the
// element tables' FOAMS(id), which the react pass also reads to list the
// bricks the aeration pass visits (docs/webgpu.md C6, D3, G4).
// tools/tables-check.mjs fails if the two lists part.
export const FOAMS = ['WATER', 'OIL', 'ACID'];
export const FOAMS_FIELD = { name: 'foams', type: 'u32', fn: 'FOAMS', ret: 'bool', get: (e) => +FOAMS.includes(e.key) };

// The looks as the GPU holds them: one struct Material per element in the
// element tables (shaders/common.js tablesWGSL), read through these accessors
// (shaders/hostStruct.js; the order is the packing). Values are LOOK's, already
// rounded to ROUND_DIGITS where the GLSL literals were.
const look = (e) => {
  if (!LOOK[e.id]) throw new Error(`${e.key}: no look (LOOK is built from ELEMENTS when this module loads)`);
  return LOOK[e.id];
};
export const MATERIAL_FIELDS = [
  { name: 'surfP', type: 'vec4f', fn: 'SURFP', get: (e) => look(e).surfP },   // the texture family's parameters (FAMILY_PARAMS)
  { name: 'macroVar', type: 'vec4f', fn: 'MACRO', get: (e) => look(e).macro },   // play-distance variation (tone, hue, rough, size)
  { name: 'texMap', type: 'vec4f', fn: 'TEXMAP', get: (e) => look(e).texMap },   // scanned texture: first layer (-1: none), tiles per cell, mean roughness, normal strength
  { name: 'texTint', type: 'vec4f', fn: 'TEXTINT', get: (e) => look(e).texTint },   // ...its albedo scale to the look's mean (rgb)
  { name: 'albedo', type: 'vec3f', fn: 'ALBEDO', get: (e) => look(e).alb },
  { name: 'surfCh', type: 'i32', fn: 'SURFCH', get: (e) => look(e).ch },
  { name: 'scatAlb', type: 'vec3f', fn: 'SCATALB', get: (e) => look(e).scatAlb },
  { name: 'mediaCh', type: 'i32', fn: 'MEDIACH', get: (e) => look(e).media },
  { name: 'emit', type: 'vec3f', fn: 'EMIT', get: (e) => look(e).emit },
  { name: 'haze', type: 'f32', fn: 'HAZE', get: (e) => look(e).haze },
  { name: 'rough', type: 'f32', fn: 'ROUGH', get: (e) => look(e).rough },
  { name: 'metal', type: 'f32', fn: 'METAL', get: (e) => look(e).metal },
  { name: 'ior', type: 'f32', fn: 'IOR', get: (e) => look(e).ior },
  { name: 'sss', type: 'f32', fn: 'SSS', get: (e) => look(e).sss },
  { name: 'glint', type: 'f32', fn: 'GLINT', get: (e) => look(e).glint },
  { name: 'bevel', type: 'f32', fn: 'BEVEL', get: (e) => look(e).bevel },
  { name: 'surf', type: 'i32', fn: 'SURF', get: (e) => look(e).surf },
  { name: 'shed', type: 'f32', fn: 'SHED', get: (e) => look(e).shed },
];
// Their accessors, and FOAMS(id), for the shared prelude (shaders/common.js):
// the Material struct sits in the prelude's Tables, so its accessors do too.
export const materialAccessorsWGSL = () => `${accessorsWGSL('TB.mat', MATERIAL_FIELDS)}\n${accessorsWGSL('TB.elem', [FOAMS_FIELD])}`;

const vec3 = (a) => `vec3f(${a.map(f).join(', ')})`;

// The light matter gives off, as radiance: the thermal glow of its visible skin
// at Ts (°C; emissivity: the share it emits of a blackbody's, Kirchhoff) plus
// its own luminescence (EMIT). The one place the two meet: surfaces,
// transparent bodies, the glow volume (and so the glow lights, the light it
// sheds on gas and bodies) and the far field all draw matter's light from it.
// (WGSL has no overloads: the GLSL's three-argument emission is emissionWith.)
// Elements that luminesce: passes that skip cold matter still visit these.
const LUMINOUS = ELEMENTS.filter((e) => LOOK[e.id].emit.some((v) => v > 0));
const EMISSION_GLSL = /* wgsl */ `
fn emissionWith(id: i32, Ts: f32, emissivity: f32) -> vec3f { return emissivity * incandescence(Ts) + EMIT(id); }
// A body's own glow, emissivity 1: what a participating medium (a liquid's or
// glass's interior, paint in it) gives off per unit of (1 - transmittance), its
// absorptivity being its emissivity (Kirchhoff's law for a volume).
fn emission(id: i32, Ts: f32) -> vec3f { return emissionWith(id, Ts, 1.0); }

// ---- the glow of an opaque surface: ONE model, everywhere it is seen ----
// The view (gfx/surface.js matOf: hotEmit, lava, steel) and everything that sees
// a surface second-hand (reflections, liquid.js reflShade; the near-field
// bounce, lighting.js nearField; the GI's sources, gi.js; the glow volume,
// passes.js) use the same skin temperature and the same emissivity, so hot
// matter glows as brightly in a pool as it does in direct view.
// Kirchhoff (1860): a surface emits what it doesn't reflect, emissivity =
// 1 - its reflectance (luminance-weighted, ITU-R BT.709): pale rock glows less
// than black crust, polished gold hardly at all.
const EMIT_LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);
fn kirchhoff(alb: vec3f, f0: f32, metal: f32) -> f32 {
  let refl = mix(f0 + (1.0 - f0) * alb, alb, metal);
  return 1.0 - clamp(dot(refl, EMIT_LUMA), 0.0, 1.0);
}
// Hot steel's mill scale (E_METAL; surface.js draws its patches): above ~570 °C
// wüstite (FeO, stable above 570 °C in the Fe–O diagram) forms: a black, porous dielectric
const OXIDE_T0: f32 = 400.0;     // °C: scale starts to darken the steel…
const OXIDE_T1: f32 = 650.0;     // …and covers it
const OXIDE_ALB: vec3f = vec3f(0.03, 0.027, 0.025);   // black, a touch of rust brown
const OXIDE_F0: f32 = 0.05;      // porous, dull: little sky in it, even at grazing angles
fn oxideCover(T: f32) -> f32 { return smoothstep(OXIDE_T0, OXIDE_T1, T); }
// Element id's emissivity at T (°C) from its table look (ALBEDO, IOR, METAL;
// steel under its scale): the texture-free mean of what matOf's glowAt finds.
fn emissivityOf(id: i32, T: f32) -> f32 {
  var f0 = (IOR(id) - 1.0) / (IOR(id) + 1.0);
  f0 *= f0;
  var alb = ALBEDO(id);
  var metal = METAL(id);
  if (id == E_METAL) {
    let ox = oxideCover(T);
    alb = mix(alb, OXIDE_ALB, ox);
    metal *= 1.0 - ox;
    f0 = mix(f0, OXIDE_F0, ox);
  }
  return kirchhoff(alb, f0, metal);
}
// The open skin of hot matter runs INCAND_SKIN_DROP below its bulk T (metals,
// conducting well, keep none): what an exposed cell of it gives off.
fn skinT(id: i32, T: f32) -> f32 { return T - select(INCAND_SKIN_DROP, 0.0, id == E_METAL); }
// Lava (surface.js matOf draws its plates and cracks): molten well above the
// solidus; nearer it a crust skins over, radiating far below the bulk T, and
// breaks into plates with the melt showing in the cracks between them.
// Lava freezes back into its ctype at MELT - LAVA_FREEZE_BELOW (src/physics.js).
const LAVA_MELT_RANGE: f32 = 450.0;  // °C above the solidus where it is fully molten
const LAVA_CRUST_X0: f32 = 0.2;      // crust starts to break up (fraction of that range)…
const LAVA_CRUST_X1: f32 = 0.8;      // …and is gone
const LAVA_CRACK_OPEN: f32 = 1.0;    // crack half-width once the crust has broken up (no plates left)…
const LAVA_CRACK_SHUT: f32 = 0.04;   // …and once it has set (cellular-noise units)
const LAVA_CRACK_AREA: f32 = 1.6;    // area share of cracks per unit half-width (past the cracks' LOD)
const LAVA_CRUST_T: f32 = 450.0;     // °C: top of a crust right at the solidus…
const LAVA_CRUST_K: f32 = 0.8;       // …rising this much per °C of melt above it
fn solidusOf(ctype: f32) -> f32 {
  var ct = i32(ctype);
  if (ct <= 0 || ct >= NE || MELT(ct) <= 0.0) { ct = E_STONE; }
  return MELT(ct) - LAVA_FREEZE_BELOW;
}
// crust cover at x (0 = at the solidus, 1 = fully molten)
fn lavaCrust(x: f32) -> f32 { return 1.0 - smoothstep(LAVA_CRUST_X0, LAVA_CRUST_X1, x); }
// the cracks' half-width: hairlines once the crust has set, wide enough to swallow the plates once it has broken up
fn lavaCrackW(crust: f32) -> f32 { return mix(LAVA_CRACK_SHUT, LAVA_CRACK_OPEN, (1.0 - crust) * (1.0 - crust)); }
// the crust's top: young crust is thin and still glows; old crust is cold on top
fn lavaCrustT(T: f32, Ts: f32, crust: f32) -> f32 { return mix(T, min(T, LAVA_CRUST_T + LAVA_CRUST_K * (T - Ts)), crust); }
// What an exposed cell of element id at bulk T (°C) gives off (ctype: lava's
// rock, the floor of state A's w): its skin's glow at its emissivity; lava's
// averaged over its plates and cracks, as matOf draws it past the cracks' LOD.
fn cellEmission(id: i32, T: f32, ctype: f32) -> vec3f {
  let e = emissivityOf(id, T);
  if (id == E_LAVA) {
    let Ts = solidusOf(ctype);
    let crust = lavaCrust((T - Ts) / LAVA_MELT_RANGE);
    let crk = min(LAVA_CRACK_AREA * lavaCrackW(crust), 1.0);
    return mix(emissionWith(id, lavaCrustT(T, Ts, crust), e), emissionWith(id, T, e), crk);
  }
  return emissionWith(id, skinT(id, T), e);
}
// Mechanical contact geometry, not an emissive claim of electrical supply.
fn contactFaceAlbedo(id: i32, closed: bool, uv: vec2f) -> vec3f {
  let frame = ALBEDO(id) * 0.55;
  let inset = all(uv > vec2f(0.15)) && all(uv < vec2f(0.85));
  let rail = abs(uv.y - 0.5) < 0.12;
  let gap = abs(uv.x - 0.5) < select(0.12, 0.025, closed);
  let copper = vec3f(0.55, 0.28, 0.12);
  return select(frame, copper, inset && rail && !gap);
}
// a lit lamp (src/electricity.js LAMP_HOLD: its spark level holds while it is lit)
fn lampLit(id: i32, ctype: f32) -> bool { return id == E_LAMP && sparkLevel(ctype) > 0; }
// a live conductor's spark (ctype: the cell's, floor of state A's w), or a lit lamp's light
fn sparkEmit(id: i32, ctype: f32) -> vec3f {
  if (lampLit(id, ctype)) { return LAMP_GLOW; }
  return select(vec3f(0.0), SPARK_GLOW, sparkLive(id, ctype));
}`;

// WGSL for the render library (after the prelude, which holds the per-element
// accessors; the name is the GLSL version's, docs/webgpu.md W2): the channel,
// medium and texture-family ids, the media's optics, and matter's emission.
export function materialsGLSL() {
  const ids = (prefix, keys) => keys.map((k, i) => `const ${prefix}${k}: i32 = ${i};`);
  return [
    ...ids('CH_', CHANNELS.map((c) => c.key)),
    `const CH_CUBIC: vec4f = vec4f(${CHANNELS.map((c) => (c.cubic ? '1.0' : '0.0')).join(', ')});   // 1: the channel reads cubic (CHANNELS cubic)`,
    ...ids('MD_', MEDIA.map((m) => m.key)),
    ...ids('SURF_', SURFS),
    `const HEAT_RANGE: f32 = ${f(HEAT_RANGE)};`,
    `const FIRE_BASE: f32 = ${f(FIRE_BASE)};`,
    `const MEDIA_FLOOR: f32 = ${f(MEDIA_FLOOR)};`,
    `const MEDIA_NOISE_CELLS: f32 = ${f(MEDIA_NOISE_CELLS)};`,
    // per gas (smoke, steam, fire)
    ...['ext', 'albedo', 'g', 'rise'].map((k) =>
      `const MD_${k.toUpperCase()}: vec3f = ${vec3(MEDIA.slice(0, N_GASES).map((m) => m[k]))};`),
    `const THIN_MIN_PEAK: f32 = ${f(THIN_MIN_PEAK)};`,
    `const THIN_MASK_LO: f32 = ${f(THIN_MASK_LO)};`,
    `const THIN_MASK_HI: f32 = ${f(THIN_MASK_HI)};`,
    `const ISO_LEVEL: f32 = ${f(ISO)};`,
    `const THIN_RADIUS: f32 = ${f(THIN_RADIUS)};`,
    `const DROP_RADIUS_K: f32 = ${f(DROP_RADIUS_K)};`,
    `const FILM_MIN_CELLS: f32 = ${f(FILM_MIN_CELLS)};`,
    `const FILL_EPS: f32 = ${f(FILL_EPS)};`,
    `const SPARK_GLOW: vec3f = ${vec3(SPARK_GLOW.map((v) => +v.toFixed(ROUND_DIGITS)))};`,
    `const LAMP_ROOM_GAIN: f32 = ${f(LAMP_ROOM_GAIN)};`,
    `const LAMP_GLOW: vec3f = ${vec3(LAMP_GLOW.map((v) => +v.toFixed(ROUND_DIGITS)))};`,
    `fn luminous(id: i32) -> bool { return ${LUMINOUS.map((e) => `id == E_${e.key}`).join(' || ') || 'false'}; }`,
    EMISSION_GLSL,
  ].join('\n');
}
