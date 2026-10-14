import { ELEMENTS, K } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { FALL_HZ, FALL_GRAVITY, FALL_Q, fallTerminal } from '../../v2/fall.js';

// Standalone helpers also used by native forcing's common-state accessor.
export const fallWGSL = /* wgsl */ `
const FALL_TERMINAL = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${fallTerminal(e.id)}.0`).join(',')});
const FALL_POWDER = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.kind === K.POWDER)).join(',')});
fn fallVelocity(c: vec4u) -> f32 {
  if (!FALL_POWDER[c.x & 255u]) { return 0.0; }
  if ((c.z & 0x80000000u) != 0u) { return -bitcast<f32>(c.z); }
  return min(f32(c.x >> 24u) * ${FALL_GRAVITY / FALL_HZ}, FALL_TERMINAL[c.x & 255u]);
}
fn fallFraction(c: vec4u) -> f32 {
  if ((c.z & 0x80000000u) == 0u) { return bitcast<f32>(c.z); }
  return f32((c.x >> 24u) | ((c.y >> 25u) << 8u)) / ${FALL_Q}.0;
}
fn setFall(c: vec4u, velocity: f32, fraction: f32) -> vec4u {
  let q = min(${FALL_Q - 1}u, u32(floor(fraction * ${FALL_Q}.0)));
  return vec4u((c.x & 0xffffffu) | ((q & 255u) << 24u),
    (c.y & 0x1ffffffu) | ((q >> 8u) << 25u), bitcast<u32>(-velocity) | 0x80000000u, c.w);
}
fn nextFallVelocity(c: vec4u, gravity: f32) -> f32 {
  return min(fallVelocity(c) + gravity / ${FALL_HZ}.0, FALL_TERMINAL[c.x & 255u]);
}
fn fallDistance(c: vec4u, velocity: f32) -> f32 { return fallFraction(c) + velocity / ${CELL_M * FALL_HZ}; }
`;
