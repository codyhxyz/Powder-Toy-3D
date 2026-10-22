import { ELEMENTS, K } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { FALL_HZ, FALL_Q, FALL_KEEP, FALL_G_PER_MS2, LEGACY_FALL_GRAVITY, fallTerminal } from '../../v2/fall.js';
import { STEPS_PER_TICK, V1_STEP_MS } from '../../v2/gravity.js';
const lit = x => (Number.isInteger(x) ? `${x}.0` : String(x));

// Standalone helpers also used by native forcing's common-state accessor.
export const fallWGSL = /* wgsl */ `
const FALL_TERMINAL = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => lit(fallTerminal(e.id))).join(',')});
const FALL_POWDER = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.kind === K.POWDER)).join(',')});
const FALL_KEEP = array<f32, ${ELEMENTS.length}>(${FALL_KEEP.map(lit).join(',')});
fn fallVelocity(c: vec4u) -> f32 {
  if (!FALL_POWDER[c.x & 255u]) { return 0.0; }
  if ((c.z & 0x80000000u) != 0u) { return -bitcast<f32>(c.z); }
  return min(f32(c.x >> 24u) * ${LEGACY_FALL_GRAVITY / FALL_HZ}, FALL_TERMINAL[c.x & 255u]);
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
// a tick of V1's grain fall (v2/fall.js fallSteps): (its speed after, m/s; the cells it has moved, its fraction in)
fn fallStep(c: vec4u, gravity: f32) -> vec2f {
  let keep = FALL_KEEP[c.x & 255u];
  let g = gravity * ${FALL_G_PER_MS2};
  var u = fallVelocity(c) / ${lit(V1_STEP_MS)};
  var d = fallFraction(c);
  for (var k = 0; k < ${STEPS_PER_TICK}; k++) {
    let p = min(u, ${lit(PHYS.V_MAX)});
    d = d + p / (2.0 - p);
    u = min((u + g) * keep, ${lit(PHYS.V_MAX)});
  }
  if (g == 0.0 && u < ${PHYS.REST_V}) { u = 0.0; }
  return vec2f(u * ${lit(V1_STEP_MS)}, d);
}
`;
