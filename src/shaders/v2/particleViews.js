// V2's airborne matter in every view (R4): under V1 a flying grain or droplet is a grid
// cell, so each view draws it as it draws any cell of its element (the data views'
// false colours, Plain's flat blocks, Noita's pixel colours, the material views' lit
// surfaces). V2 flies it in its dynamics pool (v2/dynamics.js), drawn by
// gfx/nativeParticles.js, so the particle shader takes the same per-view look here:
// the same colormaps (src/views.js COLORMAPS, through render.js colormapWGSL), the same
// constants (render.js HEAT/PRESSURE/FLOW/XRAY and DATA_COMMON, blockPlainShared.js),
// T, P and velocity in V1's units. Not a deviation: the same look of the same matter,
// drawn by the owner that flies it. tools/v2/particle-views-check.mjs pins every
// constant to the volume module that defines it, so the two can't drift.
import { ELEMENTS, ELEMENT_FIELDS, E, K, R } from '../../elements.js';
import { COLORMAPS, VIEWS, xrayDensity } from '../../views.js';
import { colormapWGSL } from '../render.js';
import { blockLookConstantsWGSL, blockLookHelpersWGSL } from '../blockPlainShared.js';
import { NOITA_ELEMENT_LOOKS, noitaMean } from '../gfx/noita.js';
import { lifeScale } from '../../v2/layout.js';
import { LEGACY_PRESSURE_PA } from '../../v2/pressure.js';
import { LEGACY_STEP_HZ } from '../../v2/host.js';
import { CELL_M } from '../../scale.js';
import { glf } from '../../glsl.js';

// src/views.js ids of the views whose look differs from Realistic's.
export const PARTICLE_VIEW = Object.freeze(Object.fromEntries(['heat', 'pressure', 'flow', 'xray', 'plain']
  .map((key) => [key.toUpperCase(), VIEWS.find((v) => v.key === key).id])));
// Noita's artwork (src/views.js materialStyle 2: shaders/gfx/noita.js noitaMat).
export const NOITA_STYLE = VIEWS.find((v) => v.key === 'noita').materialStyle;

// The volume's data-view constants (shaders/render.js), by name: the particle's colour
// in a data view is the one the march gives a lone cell of its element (its corner AO
// open: nothing beside a flying cell). Pinned to render.js by particle-views-check.
export const DATA_CONSTANTS = Object.freeze({
  // DATA_COMMON
  DATA_GAMMA: 2.2, CLAY_AMBIENT: 0.45, CLAY_SUN: 0.41, CLAY_SKY: 0.21, CLAY_AO_MIN: 0.6, CLAY_AO_GAIN: 0.4,
  NEUTRAL_BASE: 0.05, NEUTRAL_GAIN: 0.2, GAS_VIEW_DENS: 0.4,
  // tracerWGSL's soft blob
  BLOB_R_IN: 0.1, BLOB_R_OUT: 0.95, BLOB_PEAK: 1.8,
  // HEAT
  HEAT_FIRE_K: 0.6, HEAT_GAS_K: 0.3, HEAT_GLASS_K: 0.5, HEAT_GLASS_GAIN: 0.85, HEAT_CLAY: 0.7,
  // PRESSURE
  PRESSURE_GAS_K: 0.06, PRESSURE_GLASS_K: 0.18, PRESSURE_LIQUID_K: 0.06, PRESSURE_CLEAR_GAIN: 0.8,
  PRESSURE_PAINT_LO: 0.2, PRESSURE_PAINT_HI: 0.6,
  // FLOW
  FLOW_MIN_VEL: 0.01, FLOW_GAS_K: 0.25, FLOW_GLASS_K: 0.18, FLOW_STILL_SAT: 0.35, FLOW_STILL_GAIN: 0.35,
  // XRAY
  XRAY_LIGHTNESS: 0.4, XRAY_LIFT: 0.6, XRAY_DEPTH_CUE: 0.004, XRAY_SHEET_OUTER: 0.05, XRAY_SHEET_MU: 16.0,
  XRAY_SHEET_MIN: 0.2, XRAY_SHEET_GAIN: 1.6, XRAY_SHEET_ABSORB: 0.5, XRAY_EMIT_GAIN: 1.15, XRAY_SOFT_CLIP: 1.25,
});
export const DATA_VEC3_CONSTANTS = Object.freeze({ PRESSURE_GAS_GREY: [0.12, 0.12, 0.12], FLOW_GAS_STILL: [0.03, 0.03, 0.03], FLOW_GLASS_GREY: [0.05, 0.05, 0.05] });
// shaders/gfx/noita.js noitaMat's matte pixels and their lit tops and darker undersides.
export const NOITA_CONSTANTS = Object.freeze({ NOITA_RIM: 1.12, NOITA_UNDER: 0.88, NOITA_RIM_N: 0.7, NOITA_ROUGH: 0.9, NOITA_F0: 0.04 });

// render.js xrayMu: attenuation per cell from density (its XRAY_MU_PER_DENSITY, _POW, _DECIMALS).
const XRAY_MU_PER_DENSITY = 0.035, XRAY_DENSITY_POW = 0.6, XRAY_MU_DECIMALS = 5;
export const xrayMuOf = (e) => +(XRAY_MU_PER_DENSITY * Math.pow(xrayDensity(e), XRAY_DENSITY_POW)).toFixed(XRAY_MU_DECIMALS);
// Each element's Noita look far smaller than a pixel (noita.js noitaMean of its NONE look), or none.
const noitaLookOf = (e) => NOITA_ELEMENT_LOOKS.find(([el, ap]) => el === e.key && ap === 'NONE')?.[2] ?? null;
// V1's units: a cell per V1 step (shaders/common.js fetchBs: m/s over 240·CELL_M), V1 pressure.
export const V1_CELLS_PER_STEP_MS = CELL_M * LEGACY_STEP_HZ;

const field = (name) => ELEMENT_FIELDS.find((f) => f.name === name).get;
const v3 = (a) => `vec3f(${a.map(glf).join(',')})`;
const table = (name, type, rows) => `const ${name} = array<${type}, ${rows.length}>(${rows.join(',')});`;

/** The per-view look's WGSL, after the particle module's own tables (LOOK_CLASS). */
export const particleViewsWGSL = () => /* wgsl */ `
${Object.entries(DATA_CONSTANTS).map(([k, x]) => `const ${k}: f32 = ${glf(x)};`).join('\n')}
${Object.entries(DATA_VEC3_CONSTANTS).map(([k, x]) => `const ${k}: vec3f = ${v3(x)};`).join('\n')}
${Object.entries(NOITA_CONSTANTS).map(([k, x]) => `const ${k}: f32 = ${glf(x)};`).join('\n')}
const VIEW_HEAT: i32 = ${PARTICLE_VIEW.HEAT};
const VIEW_PRESSURE: i32 = ${PARTICLE_VIEW.PRESSURE};
const VIEW_FLOW: i32 = ${PARTICLE_VIEW.FLOW};
const VIEW_XRAY: i32 = ${PARTICLE_VIEW.XRAY};
const VIEW_PLAIN: i32 = ${PARTICLE_VIEW.PLAIN};
const NOITA_STYLE: f32 = ${glf(NOITA_STYLE)};
const V1_CELLS_PER_STEP_MS: f32 = ${glf(V1_CELLS_PER_STEP_MS)};   // m/s of one cell per V1 step
const LEGACY_PRESSURE_PA: f32 = ${glf(LEGACY_PRESSURE_PA)};
${table('VIEW_COLOR', 'vec3f', ELEMENTS.map((e) => v3(field('color')(e))))}
${table('VIEW_COLORVAR', 'f32', ELEMENTS.map((e) => glf(field('colorVar')(e))))}
${table('VIEW_XRAY_MU', 'f32', ELEMENTS.map((e) => glf(xrayMuOf(e))))}
${table('VIEW_LIFE_SCALE', 'f32', ELEMENTS.map((e) => glf(lifeScale(e.id))))}
${table('VIEW_CONDUCTS', 'bool', ELEMENTS.map((e) => String(e.elec > 0)))}
${table('VIEW_NOITA', 'vec4f', ELEMENTS.map((e) => { const k = noitaLookOf(e); return k ? `vec4f(${v3(noitaMean(k))},1.0)` : 'vec4f(0.0)'; }))}
fn isDataView(v: i32) -> bool { return v == VIEW_HEAT || v == VIEW_PRESSURE || v == VIEW_FLOW || v == VIEW_XRAY; }
// Views that draw a cell as a cube: the data views' voxel march, Plain's blocks.
fn blockyView(v: i32) -> bool { return isDataView(v) || v == VIEW_PLAIN; }
fn toLinear(c: vec3f) -> vec3f { return pow(c, vec3f(DATA_GAMMA)); }
fn toSrgb(c: vec3f) -> vec3f { return pow(c, vec3f(1.0 / DATA_GAMMA)); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
${colormapWGSL('heat', COLORMAPS.heat)}
${colormapWGSL('pressure', COLORMAPS.pressure)}
${colormapWGSL('flowDir', COLORMAPS.flowDir)}
${colormapWGSL('flowSpeed', COLORMAPS.flowSpeed)}
// render.js clay with the corner AO open (a flying cell has no neighbours)
fn viewClay(n: vec3f) -> f32 {
  return (CLAY_AMBIENT + CLAY_SUN * max(dot(n, FU.sun), 0.0) + CLAY_SKY * (0.5 + 0.5 * n.y)) * (CLAY_AO_MIN + CLAY_AO_GAIN);
}
fn viewNeutral(id: u32) -> vec3f { return vec3f(NEUTRAL_BASE + NEUTRAL_GAIN * sqrt(luma(VIEW_COLOR[id]))); }
// render.js softBlob for the particle's cell (closest approach of the ray to its centre)
fn viewBlob(eye: vec3f, dir: vec3f, center: vec3f, t0: f32, t1: f32) -> f32 {
  let tm = clamp(dot(center - eye, dir), t0, t1);
  return smoothstep(BLOB_R_OUT, BLOB_R_IN, length(eye + dir * tm - center)) * BLOB_PEAK;
}
// render.js gasLife: a smoke cell's density fades with its life (compact.js compactA's life)
fn viewGasLife(id: u32, core: vec4u) -> f32 {
  if (i32(id) != E_SMOKE_ID) { return 1.0; }
  return clamp(f32(core.y & 65535u) / VIEW_LIFE_SCALE[id], 0.0, 1.0);
}
fn flowTint(still: vec3f, v: vec3f, w: f32) -> vec3f {
  let hue = flowDirSrgb(flowDirPos(v.y / max(length(v), 1e-6)));
  return toLinear(mix(toSrgb(still), hue, w));
}
fn xrayColor(id: u32) -> vec3f {
  let c = VIEW_COLOR[id];
  let L = luma(c);
  return c * (mix(L, XRAY_LIGHTNESS, XRAY_LIFT) / max(L, 1e-3));
}
// What a data view draws for a particle: colour (linear, written raw like the volume's
// data views) and coverage. n: the cube face's normal (grid), seg: the ray's chord through
// the cell, T: °C, P: V1 pressure, v: velocity in cells per V1 step, cue: X-ray's depth cue.
struct ViewLook { color: vec3f, alpha: f32 }
fn dataLook(view: i32, id: u32, core: vec4u, n: vec3f, seg: f32, blob: f32, T: f32, P: f32, v0: vec3f, cue: f32) -> ViewLook {
  let kind = LOOK_CLASS[id].x;
  let rclass = LOOK_CLASS[id].y;
  let glass = i32(id) == E_GLASS_ID;
  var o = ViewLook(vec3f(0.0), 1.0);
  if (view == VIEW_HEAT) {
    if (kind == ${K.GAS}u) {
      o.alpha = 1.0 - exp(-select(HEAT_GAS_K, HEAT_FIRE_K, i32(id) == E_FIRE_ID) * seg * blob * GAS_VIEW_DENS * viewGasLife(id, core));
      o.color = heatColor(T);
    } else if (glass) {
      o.alpha = 1.0 - exp(-HEAT_GLASS_K * seg);
      o.color = heatColor(T) * HEAT_GLASS_GAIN;
    } else { o.color = heatColor(T) * mix(1.0, viewClay(n), HEAT_CLAY); }
  } else if (view == VIEW_PRESSURE) {
    if (kind == ${K.GAS}u) {
      o.alpha = 1.0 - exp(-PRESSURE_GAS_K * seg * blob);
      o.color = PRESSURE_GAS_GREY;
    } else if (rclass == ${R.LIQUID}u || rclass == ${R.GLASS}u) {
      o.alpha = 1.0 - exp(-select(PRESSURE_LIQUID_K, PRESSURE_GLASS_K, glass) * seg);
      o.color = viewNeutral(id) * PRESSURE_CLEAR_GAIN;
    } else {
      // pressure-sensitive paint: the air pushing on it (the particle's brick)
      let sm = abs(pressurePos(P) - 0.5) * 2.0;
      o.color = mix(viewNeutral(id), pressureColor(P), smoothstep(PRESSURE_PAINT_LO, PRESSURE_PAINT_HI, sm)) * viewClay(n);
    }
  } else if (view == VIEW_FLOW) {
    // render.js mobileVel: a component under FLOW_MIN_VEL doesn't move it; nothing beside
    // a flying cell blocks the rest (canDisplace into air holds for every direction)
    let v = select(vec3f(0.0), v0, abs(v0) >= vec3f(FLOW_MIN_VEL));
    if (kind == ${K.GAS}u) {
      o.alpha = 1.0 - exp(-FLOW_GAS_K * seg * blob * GAS_VIEW_DENS * viewGasLife(id, core));
      o.color = flowTint(FLOW_GAS_STILL, v0, flowSpeedPos(length(v0)));
    } else if (glass) {
      o.alpha = 1.0 - exp(-FLOW_GLASS_K * seg);
      o.color = FLOW_GLASS_GREY;
    } else {
      let c = VIEW_COLOR[id];
      let still = mix(vec3f(luma(c)), c, FLOW_STILL_SAT) * FLOW_STILL_GAIN;
      o.color = flowTint(still, v, flowSpeedPos(length(v))) * viewClay(n);
    }
  } else {
    // X-ray: the outer sheet entering from air, its own absorption, the sheet leaving
    let mu = VIEW_XRAY_MU[id];
    let xc = xrayColor(id);
    let sheet = XRAY_SHEET_OUTER * clamp(mu * XRAY_SHEET_MU, XRAY_SHEET_MIN, 1.0);
    var col = sheet * xc * XRAY_SHEET_GAIN * cue;
    var trans = 1.0 - XRAY_SHEET_ABSORB * sheet;
    let al = 1.0 - exp(-mu * seg);
    col += trans * al * xc * XRAY_EMIT_GAIN * cue;
    trans *= 1.0 - al;
    col += trans * sheet * xc * XRAY_SHEET_GAIN * cue;
    trans *= 1.0 - XRAY_SHEET_ABSORB * sheet;
    o.alpha = 1.0 - trans;
    o.color = 1.0 - exp(-XRAY_SOFT_CLIP * col / max(o.alpha, 1e-5));
  }
  o.color = clamp(o.color, vec3f(0.0), vec3f(1.0));
  return o;
}
${blockLookConstantsWGSL}
${blockLookHelpersWGSL({ prefix: 'pp', input: 'PlainFace' })}
// Plain (shaders/blockPlainShared.js look) for a lone block: corner AO open, the face's
// Minecraft shade, TPT's colour jitter by the cell's seed; emit: the particle's own glow.
struct PlainFace { uv: vec2f, grid: vec3f }
fn plainLook(id: u32, side: u32, n: vec3f, T: f32, life: f32, seed: f32, emit: vec3f, face: PlainFace) -> ViewLook {
  let rclass = LOOK_CLASS[id].y;
  var alb = VIEW_COLOR[id] * (1.0 + VIEW_COLORVAR[id] * (seed * 2.0 - 1.0));
  if (rclass == ${R.FIRE}u) {
    // a flame: its blackbody glow and a little of its own colour (coverage-dithered: no additive pass here)
    let e = incandescence(max(T, BK_FIRE_MIN_T)) * BK_FIRE_GAIN * mix(0.5, 1.0, clamp(life, 0.0, 1.0));
    return ViewLook((e + alb * 0.05) / BK_FIRE_ALPHA, BK_FIRE_ALPHA);
  }
  if (i32(id) == E_LAVA_ID) { alb = BK_LAVA_ALB; }
  else { alb *= mix(1.0, BK_HOT_ALBEDO, smoothstep(BK_HOT_FROM, BK_HOT_TO, T)); }
  let ndl = max(dot(n, FU.sun), 0.0);
  let lit = FU.sunCol * ndl + ppskyLight(n) * ppfaceShade(side);
  let c = alb * lit + emit;
  if (rclass == ${R.OPAQUE}u) { return ViewLook(c, 1.0); }
  if (rclass == ${R.LIQUID}u) { return ViewLook(c * BK_LIQUID_SCATTER / BK_ALPHA_LIQUID, BK_ALPHA_LIQUID); }
  if (rclass == ${R.GLASS}u) { return ViewLook(c, BK_ALPHA_GLASS); }
  // (blocks' translucent faces multiply what is behind and add their light: one dithered layer here
  // keeps the coverage and the light, (1 - a)·behind + a·(e / a))
  var al = BK_ALPHA_GAS;
  if (i32(id) == E_SMOKE_ID) { al = BK_ALPHA_SMOKE * clamp(life, 0.2, 1.0); }
  else if (i32(id) == E_STEAM_ID || i32(id) == E_CLOUD_ID) { al = BK_ALPHA_STEAM; }
  al = clamp(al * ppgasSoft(face), 0.0, 1.0);
  let gl = FU.sunCol * BK_GAS_SUN + ppskyLight(vec3f(0.0, 1.0, 0.0)) * 0.75;
  return ViewLook(alb * gl + emit, al);
}
const E_SMOKE_ID: i32 = ${E.SMOKE};
const E_GLASS_ID: i32 = ${E.GLASS};
const E_FIRE_ID: i32 = ${E.FIRE};
const E_LAVA_ID: i32 = ${E.LAVA};
const E_STEAM_ID: i32 = ${E.STEAM};
const E_CLOUD_ID: i32 = ${E.CLOUD};
`;
