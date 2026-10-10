// Render looks: how each element is *drawn*, independent of how it behaves.
// The simulation stays a blocky cellular automaton; the renderer rebuilds
// continuous surfaces and volumes from it. Like elements.js, this table is
// baked into the render shaders as GLSL const arrays.
//
//   ch     smooth-surface channel. Cells in a channel are drawn as one
//          continuous surface (the 0.5 isosurface of a blurred, normalised
//          occupancy field). Elements without a channel are "crisp": drawn
//          as (bevelled) voxels.
//   media  participating-medium channel (drawn as a density volume). A gas
//          needs one: without a channel it would be drawn as crisp voxels
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
//          edges are rounded by (default 1; crystal's cleavage edges are sharp)
//   emit   light it gives off by itself at any temperature (luminescence), as
//          linear RGB radiance in the incandescence's scene units (sunlit
//          white ≈ 1.2): what a body of it shows. It adds to the thermal glow
//          wherever matter's light is used (emission(), below).

import { ELEMENTS } from '../elements.js';
import { bandGlow } from './incandescence.js';

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

// Smooth-surface channels. sigma = blur radius in cells (how much the
// blockiness is smoothed away), ema = per-frame blend toward the new state
// (temporal smoothing; 1 = none). Liquids smooth the most, built structures not at all.
// cubic: thin features of the channel (drops, streams, films) are read as a
// cubic B-spline instead of trilinearly (shaders/gfx/core.js surfSample), so
// they come out round instead of faceted.
export const CHANNELS = [
  { key: 'LIQUID', sigma: 1.0, ema: 0.35, transparent: true, cubic: true },
  { key: 'MOLTEN', sigma: 0.85, ema: 0.5 },
  { key: 'GRANULAR', sigma: 0.75, ema: 0.6 },
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
//          its parameters (CRAG_PARAMS), each a multiple of ROCK's basalt
// Albedo sources (approximate, visible band): dry quartz sand 0.35-0.55, fresh
// snow 0.85-0.95, concrete 0.25-0.4, wood ash 0.3-0.4, black powder ~0.04,
// bark 0.05-0.15, leaves ~0.05/0.15/0.03, basalt 0.08-0.15, tan sandstone
// 0.3-0.4 (redder toward the red end), limestone 0.4-0.6, coal 0.04-0.05
// (USGS spectral library, Clark et al. 2007). Metal F0 from measured complex
// IORs (iron/steel 0.56-0.58, gold 1.0/0.77/0.34).
const LOOKS = {
  WALL: { rough: 0.85, alb: '#8f8c87' },
  SAND: { ch: 'GRANULAR', rough: 0.9, ior: 1.54, alb: '#c4a77c', glint: 0.55 },
  STONE: { ch: 'GRANULAR', rough: 0.75, alb: '#7f7c77' },
  SNOW: { ch: 'GRANULAR', rough: 0.55, ior: 1.31, alb: '#f3f6fb', sss: 0.55, glint: 0.8 },
  GUNPOWDER: { ch: 'GRANULAR', rough: 0.6, alb: '#38383d', glint: 0.7 },   // graphite glaze: a soft sheen, many glints
  ASH: { ch: 'GRANULAR', rough: 0.98, alb: '#a29e97', sss: 0.3 },
  // Liquids. Clean water absorbs red most (real ratios ~1 : 0.2 : 0.1 with a
  // little dissolved matter) and scatters a little, mostly blue: clear when
  // shallow, blue-green with depth. Both are exaggerated several-fold over
  // real water so a tank-sized body still shows them. Oil is amber (absorbs
  // blue hardest), dark when thick. Acid is a clear, slightly milky green.
  WATER: { ch: 'LIQUID', ior: 1.333, rough: 0.02, scatter: [0.002, 0.003, 0.004] },
  OIL: { ch: 'LIQUID', ior: 1.47, rough: 0.03, scatter: [0.012, 0.008, 0.003] },
  ACID: { ch: 'LIQUID', ior: 1.36, rough: 0.03, scatter: [0.02, 0.03, 0.02] },
  LAVA: { ch: 'MOLTEN', rough: 0.35, alb: '#2a2522' },
  STEAM: { media: 'STEAM' },
  CLOUD: { media: 'STEAM' },   // the same water droplets (what you see of steam is condensed mist)
  SMOKE: { media: 'SMOKE' },
  FIRE: { media: 'FIRE' },
  WOOD: { ch: 'ORGANIC', rough: 0.8, alb: '#5a4637' },
  PLANT: { ch: 'ORGANIC', rough: 0.5, alb: '#4b7a2f', sss: 0.25 },
  METAL: { rough: 0.32, metal: 1, alb: [0.56, 0.57, 0.58] },
  GLASS: { ior: 1.5, rough: 0.02, scatter: [0.005, 0.003, 0.004] },
  // Ice shares the liquid surface: a clear surface between ice and water is
  // nearly invisible in real life too (n = 1.31 vs 1.33). Frozen ice is
  // cloudy (trapped air), so it scatters white and stays visible.
  ICE: { ch: 'LIQUID', ior: 1.31, rough: 0.06, scatter: [0.025, 0.025, 0.025] },
  CLONE: { rough: 0.25, metal: 1, alb: [1.0, 0.766, 0.336] },   // polished gold
  // natural rock (terrain): weathered basalt, part of the natural-solids surface
  ROCK: { ch: 'ORGANIC', rough: 0.85, alb: '#4e4b48', surf: 'CRAG' },
  // The other rocks share it (and its texture: surf CRAG, crag below).
  // Sandstone: quartz grains (n = 1.54, they glint like sand's) in a tan,
  // iron-stained cement, linear albedo ~0.45/0.33/0.2. Limestone: calcite
  // (n ~1.6), pale grey-buff ~0.5/0.48/0.43. Coal: albedo ~0.045 with a
  // sheen. Polished vitrinite has n ~1.7-1.8, but a natural face reflects only
  // the measured 0.04-0.05 in all, so its specular is no more than any
  // rock's (n 1.5, the default): its sheen is a smoother face than rock's.
  // (Glossier, it outshone the basalt beside it under a low sun.) Broken coal
  // shows the same faces fresh, glinting where they catch the sun.
  SANDSTONE: { ch: 'ORGANIC', rough: 0.9, ior: 1.54, alb: '#b39c7c', glint: 0.25, surf: 'CRAG',
    crag: { relief: 0.6, pits: 0, bands: 2.5, stain: 1.5 } },   // rounded by weathering, bedded, iron-stained
  LIMESTONE: { ch: 'ORGANIC', rough: 0.8, ior: 1.6, alb: '#bcb8af', surf: 'CRAG',
    crag: { relief: 1, pits: 0.4, bands: 1.5, stain: 0.4 } },   // sharp solution runnels and pits, bedded
  COAL: { ch: 'ORGANIC', rough: 0.75, alb: '#3c3c3d', surf: 'CRAG',
    crag: { relief: 0.5, pits: 0, bands: 2, stain: 0 } },       // blocky cleat, bright and dull bands
  BROKENCOAL: { ch: 'GRANULAR', rough: 0.75, alb: '#3c3c3d', glint: 0.5 },
  // Fluorite (elements.js CRYSTAL): n = 1.434, a vitreous luster from flat
  // growth and cleavage faces (polished glass-smooth: GGX roughness at the
  // floor), sharp cleavage edges. Its body colour and glow are worked out per
  // crystal in shaders/gfx/surface.js (crystalLook); alb is the mean. Its
  // dust is pale, as any crushed coloured crystal is (scattering at the grain
  // faces swamps the absorption), and keeps the glow (powdered phosphors do).
  CRYSTAL: { rough: 0.04, ior: 1.434, alb: '#4a3478', sss: 0.3, bevel: 0.2, emit: FLUORITE_GLOW },
  CRYSTAL_DUST: { ch: 'GRANULAR', rough: 0.6, ior: 1.434, alb: '#b7a2d2', sss: 0.3, glint: 0.4, emit: FLUORITE_GLOW },
  // Electronics (elements.js). A battery's printed steel can; silicon is
  // grey and mirror-like (n ≈ 3.9 in the visible: F0 ≈ 0.35), tinted as TPT
  // draws P and N; the switch a dark green relay; the insulator a pale,
  // chalky aerogel blue; the sensor TPT's magenta.
  BATTERY: { rough: 0.45, alb: '#6f6d1c' },
  PSCN: { rough: 0.15, ior: 3.9, alb: '#5c4646' },
  NSCN: { rough: 0.15, ior: 3.9, alb: '#46465c' },
  SWITCH: { rough: 0.4, alb: '#1d4a1f' },
  INSULATOR: { rough: 0.95, alb: '#a7aec2', sss: 0.3 },
  TSNS: { rough: 0.5, alb: '#c21aa6' },
  PCLN: { rough: 0.35, metal: 1, alb: [0.45, 0.36, 0.14] },   // Clone's gold, tarnished: TPT draws it dark olive
  // Radioactive metals as powders: a metal powder is dark, since light is
  // trapped between the grains, with bright glints off the facets. Uranium
  // tarnishes to a dark grey-black oxide (UO₂ is black); plutonium's oxide
  // skin is dull olive-grey.
  URANIUM: { ch: 'GRANULAR', rough: 0.55, alb: '#3f413b', glint: 0.5 },
  PLUTONIUM: { ch: 'GRANULAR', rough: 0.6, alb: '#45493a', glint: 0.4 },
  // Batch 3 (elements.js, el-mat). Void: matte black, a hole in the world.
  VOID: { rough: 1, alb: '#0d0809' },
  // Red brick reflects ~0.25 in the red, ~0.1 in the green and ~0.06 in the
  // blue (USGS spectral library, fired clay); built, so crisp like Wall.
  // Crushed, it is paler: the broken faces scatter more.
  BRICK: { rough: 0.9, alb: [0.25, 0.1, 0.06] },
  RUBBLE: { ch: 'GRANULAR', rough: 0.95, alb: [0.3, 0.14, 0.09] },
  // Metals: F0 from measured complex indices (n, k at 450/550/650 nm;
  // refractiveindex.info): titanium (0.54, 0.50, 0.45), tungsten ~0.5 grey,
  // gold as Clone's, mercury ~0.75 flat (a liquid mirror).
  TITANIUM: { rough: 0.35, metal: 1, alb: [0.542, 0.497, 0.449] },
  TUNGSTEN: { rough: 0.3, metal: 1, alb: [0.5, 0.49, 0.46] },
  GOLD: { rough: 0.3, metal: 1, alb: [1.0, 0.766, 0.336] },
  NUGGETS: { ch: 'GRANULAR', rough: 0.45, metal: 1, alb: [1.0, 0.766, 0.336], glint: 0.6 },
  // Liquid metal: an opaque mirror, smoothed like a melt (it shares lava's
  // channel; the two never meet, since mercury boils at 357 °C)
  MERCURY: { ch: 'MOLTEN', rough: 0.04, metal: 1, alb: [0.75, 0.75, 0.74] },
  SOLID_MERCURY: { rough: 0.35, metal: 1, alb: [0.75, 0.75, 0.74] },
  // Mercury vapour is invisible; what shows where it meets cool air is a mist
  // of condensed droplets, like steam's
  MERCURY_VAPOR: { media: 'STEAM' },
  // Plasma draws as flame (its light, by the flame's temperature channel)
  PLASMA: { media: 'FIRE' },
  // Diamond: n = 2.417, so it sparkles far more than glass (n 1.5); a
  // colourless stone barely absorbs or scatters
  DIAMOND: { ior: 2.417, rough: 0.01, scatter: [0.0005, 0.0005, 0.0005] },
  // Batch 2, chemistry and cold (elements.js). Liquid nitrogen is clear and
  // colourless, n = 1.199 (CRC); its boiling fills it with bubbles that
  // scatter a little. Saturated brine is water with n = 1.378 (CRC, 26 % NaCl).
  LIQUID_NITROGEN: { ch: 'LIQUID', ior: 1.199, rough: 0.03, scatter: [0.004, 0.004, 0.004] },
  SALTWATER: { ch: 'LIQUID', ior: 1.378, rough: 0.02, scatter: [0.002, 0.003, 0.004] },
  // Salt: clear halite cubes (n = 1.544) crushed white, albedo ~0.8, light
  // wrapping into the grains and glinting off their cube faces.
  SALT: { ch: 'GRANULAR', rough: 0.55, ior: 1.544, alb: '#e2e0da', sss: 0.35, glint: 0.7 },
  // Dry ice: pressed CO₂ snow, white and porous (n ~1.4), light bleeding into it.
  DRY_ICE: { rough: 0.8, ior: 1.4, alb: '#e4e8ec', sss: 0.5 },
  // Lithium is silvery cut, but dulls in air within minutes (nitride, hydroxide):
  // a grey, rough metal.
  LITHIUM: { ch: 'GRANULAR', rough: 0.55, metal: 1, alb: [0.55, 0.55, 0.56] },
  // Clear gases (CO₂, hydrogen, oxygen) are invisible: a faint haze shows where
  // they are. Hydrogen chloride fumes in moist air, pulling the water vapour
  // out as a mist of acid droplets (real), so it shows more.
  CO2: { media: 'STEAM', haze: 0.06 },
  HYDROGEN: { media: 'STEAM', haze: 0.04 },
  OXYGEN: { media: 'STEAM', haze: 0.05 },
  CAUSTIC_GAS: { media: 'STEAM', haze: 0.3 },
  // Batch 4. Flour reflects ~0.8, matte, and light bleeds into a loose heap.
  // Kaolin is as white (ISO brightness 80-90%); mud is darker, as any wet
  // soil is (water in the pores cuts the scattering: about half the
  // reflectance; Lekner & Dorf, Appl. Opt. 27, 1988) and wet-glossy, drawn
  // with lava's opaque-liquid surface. Ceramic is matte white bisque.
  // Antimatter is a game substance: a pale lilac powder with a sheen, so it
  // reads apart from the other powders. The singularity reflects nothing.
  DUST: { ch: 'GRANULAR', rough: 0.95, alb: '#ebe2cc', sss: 0.35 },
  CLAY: { ch: 'GRANULAR', rough: 0.95, alb: '#e2dccf', sss: 0.2 },
  MUD: { ch: 'MOLTEN', rough: 0.3, alb: '#a49b8a' },
  CERAMIC: { rough: 0.6, alb: '#efeae0' },
  ANTIMATTER: { ch: 'GRANULAR', rough: 0.4, alb: '#b9b0d9', glint: 0.6 },
  SINGULARITY: { rough: 1, alb: '#000000' },
  // Explosives (elements.js). C-4 is an off-white putty, moulded smooth, a
  // little waxy (light wraps into its edges). Nitroglycerin is a clear, pale
  // yellow oil, n = 1.479. Cast TNT is pale yellow-brown, dull and crystalline.
  // Thermite is rust-red iron oxide with flecks of aluminium that glint. A
  // safety fuse is a tarred cord. Propane is invisible: it borrows steam's
  // haze so you can see where it pools (a liberty).
  C4: { ch: 'ORGANIC', rough: 0.55, alb: '#d6d0bf', sss: 0.2 },
  NITRO: { ch: 'LIQUID', ior: 1.479, rough: 0.03, scatter: [0.004, 0.004, 0.004] },
  TNT: { rough: 0.7, alb: '#b9975a' },
  THERMITE: { ch: 'GRANULAR', rough: 0.8, alb: '#6f4436', glint: 0.35 },
  PROPANE: { media: 'STEAM' },
  FUSE: { ch: 'ORGANIC', rough: 0.6, alb: '#2a4424' },
};

// Shared texture families (LOOKS surf). NONE: an element's own (or none).
export const SURFS = ['NONE', 'CRAG'];
// CRAG parameters, as multiples of ROCK's weathered basalt (the defaults):
//   relief  height of the crags and creases (and of their carving up close)
//   pits    gas vesicles in basalt; small solution pits in limestone
//   bands   lava-flow banding in basalt; bedding in sedimentary rock
//   stain   rusty iron-oxide patches
const CRAG_PARAMS = ['relief', 'pits', 'bands', 'stain'];
const CRAG_DEFAULT = { relief: 1, pits: 1, bands: 1, stain: 1 };

// Defaults for elements LOOKS leaves out (the rest default to 0: none).
const DEFAULT_ROUGH = 0.7;
const DEFAULT_IOR = 1.5;
// Decimal places the baked material values are rounded to.
const GLSL_DIGITS = 4;

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

const chIndex = (k) => (k ? CHANNELS.findIndex((c) => c.key === k) : -1);
const mediaIndex = (k) => (k ? MEDIA.findIndex((m) => m.key === k) : -1);

export const LOOK = ELEMENTS.map((e) => {
  const l = LOOKS[e.key] ?? {};
  return {
    ch: chIndex(l.ch), media: mediaIndex(l.media), haze: l.haze ?? 1, rough: l.rough ?? DEFAULT_ROUGH, metal: l.metal ?? 0, ior: l.ior ?? DEFAULT_IOR,
    alb: linearOf(l.alb ?? e.color).map((v) => +v.toFixed(GLSL_DIGITS)), sss: l.sss ?? 0, glint: l.glint ?? 0,
    bevel: l.bevel ?? 1,
    emit: (l.emit ?? [0, 0, 0]).map((v) => +v.toFixed(GLSL_DIGITS)),
    surf: SURFS.indexOf(l.surf ?? 'NONE'),
    crag: l.surf === 'CRAG' ? CRAG_PARAMS.map((k) => (l.crag ?? CRAG_DEFAULT)[k] ?? CRAG_DEFAULT[k]) : CRAG_PARAMS.map(() => 0),
    // single-scattering albedo: the scattered share of the extinction
    scatAlb: (l.scatter ?? [0, 0, 0]).map((s, i) => +(e.sigma[i] > 0 ? Math.min(1, s / e.sigma[i]) : 0).toFixed(GLSL_DIGITS)),
  };
});

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

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// The light matter gives off, as radiance: the thermal glow of its visible skin
// at Ts (°C; emissivity: the share it emits of a blackbody's, Kirchhoff) plus
// its own luminescence (EMIT). The one place the two meet: surfaces,
// transparent bodies, the glow volume (and so the glow lights, the light it
// sheds on gas and bodies) and the far field all draw matter's light from it.
// Elements that luminesce: passes that skip cold matter still visit these.
const LUMINOUS = ELEMENTS.filter((e) => LOOK[e.id].emit.some((v) => v > 0));
const EMISSION_GLSL = /* glsl */ `
vec3 emission(int id, float Ts, float emissivity) { return emissivity * incandescence(Ts) + EMIT[id]; }
vec3 emission(int id, float Ts) { return emission(id, Ts, 1.0); }
// The open skin of hot matter runs INCAND_SKIN_DROP below its bulk T (metals,
// conducting well, keep none): what an exposed cell of it gives off.
float skinT(int id, float T) { return T - (id == E_METAL ? 0.0 : INCAND_SKIN_DROP); }
vec3 cellEmission(int id, float T) { return emission(id, skinT(id, T)); }
// a live conductor's spark (ctype: the cell's, floor of state A's w)
vec3 sparkEmit(int id, float ctype) { return sparkLive(id, ctype) ? SPARK_GLOW : vec3(0.0); }`;

export function materialsGLSL() {
  const ints = (name, key) => `const int ${name}[NE] = int[NE](${LOOK.map((l) => l[key]).join(', ')});`;
  const floats = (name, key) => `const float ${name}[NE] = float[NE](${LOOK.map((l) => f(l[key])).join(', ')});`;
  return [
    ...CHANNELS.map((c, i) => `#define CH_${c.key} ${i}`),
    ...MEDIA.map((m, i) => `#define MD_${m.key} ${i}`),
    ...SURFS.map((k, i) => `#define SURF_${k} ${i}`),
    `#define HEAT_RANGE ${f(HEAT_RANGE)}`,
    `#define FIRE_BASE ${f(FIRE_BASE)}`,
    `#define MEDIA_FLOOR ${f(MEDIA_FLOOR)}`,
    `#define MEDIA_NOISE_CELLS ${f(MEDIA_NOISE_CELLS)}`,
    // per gas (smoke, steam, fire)
    ...['ext', 'albedo', 'g', 'rise'].map((k) =>
      `const vec3 MD_${k.toUpperCase()} = vec3(${MEDIA.slice(0, N_GASES).map((m) => f(m[k])).join(', ')});`),
    `#define THIN_MIN_PEAK ${f(THIN_MIN_PEAK)}`,
    `#define THIN_MASK_LO ${f(THIN_MASK_LO)}`,
    `#define THIN_MASK_HI ${f(THIN_MASK_HI)}`,
    ints('SURFCH', 'ch'),
    ints('MEDIACH', 'media'),
    floats('HAZE', 'haze'),
    floats('ROUGH', 'rough'),
    floats('METAL', 'metal'),
    floats('IOR', 'ior'),
    floats('SSS', 'sss'),
    floats('GLINT', 'glint'),
    floats('BEVEL', 'bevel'),
    `const vec3 ALBEDO[NE] = vec3[NE](${LOOK.map((l) => `vec3(${l.alb.map(f).join(', ')})`).join(', ')});`,
    `const vec3 SCATALB[NE] = vec3[NE](${LOOK.map((l) => `vec3(${l.scatAlb.map(f).join(', ')})`).join(', ')});`,
    `const vec3 EMIT[NE] = vec3[NE](${LOOK.map((l) => `vec3(${l.emit.map(f).join(', ')})`).join(', ')});`,
    `const vec3 SPARK_GLOW = vec3(${SPARK_GLOW.map((v) => f(+v.toFixed(GLSL_DIGITS))).join(', ')});`,
    `bool luminous(int id) { return ${LUMINOUS.map((e) => `id == E_${e.key}`).join(' || ') || 'false'}; }`,
    EMISSION_GLSL,
    ints('SURF', 'surf'),
    `const vec4 CRAG[NE] = vec4[NE](${LOOK.map((l) => `vec4(${l.crag.map(f).join(', ')})`).join(', ')});`,
  ].join('\n');
}

