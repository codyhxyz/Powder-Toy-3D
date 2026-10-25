// The world copy's cell word and brick-table entry (docs/seamless-world.md, "World copy").
// One u32 per cell, the look the picture needs, never physics' exact state:
//   bits 0-7    element id
//   bits 8-15   ctype (& 255: a conductor's spark ctype past 255 is physics-only)
//   bits 16-23  temperature code (wcTempCode: 1 °C steps from -60 to 99 °C, then log steps to 6000 °C)
//   bits 24-30  aux, 0-127: a liquid's fill (127 = a whole cell), else matter's life fraction
//   bit 31      always 0 (the brick table's MIXED flag)
// A brick-table entry is a uniform brick's cell word itself (bit 31 clear), or MIXED | its pool slot,
// whose 64 words are cells x + 4 (y + 4 z) of the brick.
import { glf } from '../../glsl.js';

export const WC_BRICK = 4;                  // cells a brick spans per axis (shaders/common.js BRICK)
export const WC_BRICK_CELLS = 64;           // words a pool slot holds
export const WC_MIXED = 0x80000000;         // a table entry's flag: the low 31 bits are a pool slot
export const WC_AUX_MAX = 127;
const T_LIN_LO = -60;                       // °C at code 0
const T_LIN_CODES = 160;                    // codes 0-159: 1 °C each, -60..99 °C
const T_LOG_LO = 100;                       // °C at the first log code (160)
const T_LOG_HI = 6000;                      // °C at code 255
const T_LOG_CODES = 255 - T_LIN_CODES;      // 95 log steps (about 4.4 % each)

export function wcTempCode(t) {
  if (!(t >= T_LIN_LO)) return 0;
  if (t < T_LOG_LO - 0.5) return Math.round(t - T_LIN_LO);
  const c = T_LIN_CODES + Math.round(Math.log(Math.min(t, T_LOG_HI) / T_LOG_LO) / Math.log(T_LOG_HI / T_LOG_LO) * T_LOG_CODES);
  return Math.min(255, c);
}
export function wcTempOf(code) {
  return code < T_LIN_CODES ? code + T_LIN_LO : T_LOG_LO * Math.pow(T_LOG_HI / T_LOG_LO, (code - T_LIN_CODES) / T_LOG_CODES);
}
/** A cell word: id, ctype, temperature (°C), aux (0..1: a liquid's fill, else matter's life fraction). */
export function wcWord(id, ctype, t, aux) {
  const a = Math.max(0, Math.min(WC_AUX_MAX, Math.round(aux * WC_AUX_MAX)));
  return ((id & 255) | ((ctype & 255) << 8) | (wcTempCode(t) << 16) | (a << 24)) >>> 0;
}
export const wcUnword = (w) => ({
  id: w & 255, ctype: (w >>> 8) & 255, t: wcTempOf((w >>> 16) & 255), aux: ((w >>> 24) & 127) / WC_AUX_MAX,
});

// The decoders every reader shares (the march, the fields, the lighting, physics' slab fill).
export const cellWordWGSL = /* wgsl */ `
const WC_MIXED: u32 = 0x80000000u;
const WC_BRICK_CELLS: u32 = ${WC_BRICK_CELLS}u;
fn wcId(w: u32) -> i32 { return i32(w & 255u); }
fn wcCtype(w: u32) -> u32 { return (w >> 8u) & 255u; }
fn wcTemp(w: u32) -> f32 {
  let c = f32((w >> 16u) & 255u);
  if (c < ${glf(T_LIN_CODES)}) { return c + ${glf(T_LIN_LO)}; }
  return ${glf(T_LOG_LO)} * pow(${glf(T_LOG_HI / T_LOG_LO)}, (c - ${glf(T_LIN_CODES)}) / ${glf(T_LOG_CODES)});
}
fn wcAux(w: u32) -> f32 { return f32((w >> 24u) & 127u) / ${glf(WC_AUX_MAX)}; }
fn wcTempCode(t: f32) -> u32 {
  if (!(t >= ${glf(T_LIN_LO)})) { return 0u; }
  if (t < ${glf(T_LOG_LO - 0.5)}) { return u32(round(t - ${glf(T_LIN_LO)})); }
  let c = ${glf(T_LIN_CODES)} + round(log(min(t, ${glf(T_LOG_HI)}) / ${glf(T_LOG_LO)}) / ${glf(Math.log(T_LOG_HI / T_LOG_LO))} * ${glf(T_LOG_CODES)});
  return u32(min(255.0, c));
}
fn wcWord(id: i32, ctype: u32, t: f32, aux: f32) -> u32 {
  let a = u32(clamp(round(aux * ${glf(WC_AUX_MAX)}), 0.0, ${glf(WC_AUX_MAX)}));
  return (u32(id) & 255u) | ((ctype & 255u) << 8u) | (wcTempCode(t) << 16u) | (a << 24u);
}
// a brick's pool word for cell l (0-3 per axis) of the brick
fn wcLocal(l: vec3i) -> u32 { return u32(l.x + ${WC_BRICK} * (l.y + ${WC_BRICK} * l.z)); }
`;
