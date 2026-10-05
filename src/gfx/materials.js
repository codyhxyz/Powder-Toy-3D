// Render looks: how each element is *drawn*, independent of how it behaves.
// The simulation stays a blocky cellular automaton; the renderer rebuilds
// continuous surfaces and volumes from it. Like elements.js, this table is
// baked into the render shaders as GLSL const arrays.
//
//   ch     smooth-surface channel. Cells in a channel are drawn as one
//          continuous surface (the 0.5 isosurface of a blurred, normalised
//          occupancy field). Elements without a channel are "crisp": drawn
//          as (bevelled) voxels.
//   media  participating-medium channel (drawn as a density volume)
//   rough  GGX roughness
//   metal  metalness
//   ior    index of refraction (transparent elements)

import { ELEMENTS } from '../elements.js';

// Smooth-surface channels. sigma = blur radius in cells (how much the
// blockiness is smoothed away), ema = per-frame blend toward the new state
// (temporal smoothing; 1 = none). Liquids smooth the most, built structures not at all.
export const CHANNELS = [
  { key: 'LIQUID', sigma: 1.0, ema: 0.35, transparent: true },
  { key: 'MOLTEN', sigma: 0.85, ema: 0.5 },
  { key: 'GRANULAR', sigma: 0.75, ema: 0.6 },
  { key: 'ORGANIC', sigma: 0.6, ema: 1.0 },   // natural solids: wood, plant, rock
];
// Media channels share the liquid blur kernel. The 4th component is heat
// (normalised temperature excess) of everything that isn't a crisp solid.
export const MEDIA = [
  { key: 'SMOKE', ema: 0.5 },
  { key: 'STEAM', ema: 0.5 },
  { key: 'FIRE', ema: 0.6 },
  { key: 'HEAT', ema: 0.5 },
];
// Temperature range packed into the heat channel: T = AMBIENT + heat * HEAT_RANGE.
export const HEAT_RANGE = 2500;

// Opaque materials (gfx/surface.js turns these into textured PBR surfaces):
//   alb    albedo: measured-ish real-world reflectance, as sRGB hex, or a
//          linear [r, g, b] (for metals this is F0, the normal-incidence
//          reflectance). Falls back to the element's UI colour.
//   sss    wrap / subsurface amount (0 = Lambert): light bleeding past the
//          terminator in porous or translucent stuff (snow, ash, leaves)
//   glint  fraction of the sun's specular that arrives as discrete sparkles
//          from individual grain facets (sand, snow, gunpowder)
// Albedo sources (approximate, visible band): dry quartz sand 0.35-0.55, fresh
// snow 0.85-0.95, concrete 0.25-0.4, wood ash 0.3-0.4, black powder ~0.04,
// bark 0.05-0.15, leaves ~0.05/0.15/0.03, basalt 0.08-0.15. Metal F0 from
// measured complex IORs (iron/steel 0.56-0.58, gold 1.0/0.77/0.34).
const LOOKS = {
  WALL: { rough: 0.85, alb: '#8f8c87' },
  SAND: { ch: 'GRANULAR', rough: 0.9, ior: 1.54, alb: '#c4a77c', glint: 0.55 },
  STONE: { ch: 'GRANULAR', rough: 0.75, alb: '#7f7c77' },
  SNOW: { ch: 'GRANULAR', rough: 0.55, ior: 1.31, alb: '#f3f6fb', sss: 0.55, glint: 0.8 },
  GUNPOWDER: { ch: 'GRANULAR', rough: 0.45, alb: '#38383d', glint: 0.7 },
  ASH: { ch: 'GRANULAR', rough: 0.98, alb: '#a29e97', sss: 0.3 },
  WATER: { ch: 'LIQUID', ior: 1.333, rough: 0.02 },
  OIL: { ch: 'LIQUID', ior: 1.47, rough: 0.03 },
  ACID: { ch: 'LIQUID', ior: 1.36, rough: 0.03 },
  LAVA: { ch: 'MOLTEN', rough: 0.35, alb: '#2a2522' },
  STEAM: { media: 'STEAM' },
  SMOKE: { media: 'SMOKE' },
  FIRE: { media: 'FIRE' },
  WOOD: { ch: 'ORGANIC', rough: 0.8, alb: '#5c4231' },
  PLANT: { ch: 'ORGANIC', rough: 0.5, alb: '#4b7a2f', sss: 0.25 },
  METAL: { rough: 0.32, metal: 1, alb: [0.56, 0.57, 0.58] },
  GLASS: { ior: 1.5, rough: 0.02 },
  // Ice shares the liquid surface: ice in water is nearly invisible in real
  // life too (n = 1.31 vs 1.33).
  ICE: { ch: 'LIQUID', ior: 1.31, rough: 0.06 },
  CLONE: { rough: 0.28, metal: 1, alb: [1.0, 0.766, 0.336] },
  // natural rock (terrain): weathered basalt, part of the natural-solids surface
  ROCK: { ch: 'ORGANIC', rough: 0.8, alb: '#6a6560' },
};

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
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
    ch: chIndex(l.ch), media: mediaIndex(l.media), rough: l.rough ?? 0.7, metal: l.metal ?? 0, ior: l.ior ?? 1.5,
    alb: linearOf(l.alb ?? e.color).map((v) => +v.toFixed(4)), sss: l.sss ?? 0, glint: l.glint ?? 0,
  };
});

// 5-tap Gaussian weights (offsets -2..2), normalised.
export function gauss5(sigma) {
  const w = [-2, -1, 0, 1, 2].map((k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export function materialsGLSL() {
  const ints = (name, key) => `const int ${name}[NE] = int[NE](${LOOK.map((l) => l[key]).join(', ')});`;
  const floats = (name, key) => `const float ${name}[NE] = float[NE](${LOOK.map((l) => f(l[key])).join(', ')});`;
  return [
    ...CHANNELS.map((c, i) => `#define CH_${c.key} ${i}`),
    ...MEDIA.map((m, i) => `#define MD_${m.key} ${i}`),
    `#define HEAT_RANGE ${f(HEAT_RANGE)}`,
    ints('SURFCH', 'ch'),
    ints('MEDIACH', 'media'),
    floats('ROUGH', 'rough'),
    floats('METAL', 'metal'),
    floats('IOR', 'ior'),
    floats('SSS', 'sss'),
    floats('GLINT', 'glint'),
    `const vec3 ALBEDO[NE] = vec3[NE](${LOOK.map((l) => `vec3(${l.alb.map(f).join(', ')})`).join(', ')});`,
  ].join('\n');
}
