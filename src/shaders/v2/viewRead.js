import { fallWGSL } from './fall.js';
import { nativeSlotAccessWGSL } from '../common.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../v2/nativeWeather.js';
import { LEGACY_PRESSURE_PA } from '../../v2/pressure.js';

// What the views read of Physics V2's cells as V1's state B: a cell's own motion and its air, in
// V1's units (cells per V1 step, V1 pressure). V1 keeps B per cell: a grain's or a liquid's
// velocity, the air's velocity and pressure elsewhere. V2 keeps a grain's fall velocity and a
// liquid's face flux in the core, and the air per 4³ brick (docs/v2.md §4.3), so B here is built
// from both, as the console's reads build it (v2/nativeRead.js: the same rule, the same units).
// Not a deviation: the same quantities each read where V2 keeps them. Its readers: the Box's draw
// (shaders/render.js volumeB: the Flow view's matter, its air strokes and haze, the Pressure view,
// "Smoke follows the flow"), the brick map's air flags (shaders/v2/viewAir.js) and World's B
// (shaders/renderSource.js nativeAirWGSL).
//
// nativeAirB(s): slot s's brick's air, as the read groups bind it in B (v2/physics.js readGroup and
// sim.bindPhysicalRO: dynamics' current coarse air, two vec4f per brick: velocity m/s, pressure Pa
// gauge), in V1's units; the physical readers' fetchBs (shaders/common.js, format 3) reads the same.
// nativeMotionB(c, air): V1's B of the cell with core c in a brick whose air is air.
export const nativeMotionWGSL = /* wgsl */ `
${fallWGSL}${nativeSlotAccessWGSL}
fn nativeAirB(s: u32) -> vec4f {
  let air = fetchNativeAirS(s);
  return vec4f(air.xyz / ${WEATHER_SPEED_SI}, air.w / ${LEGACY_PRESSURE_PA});
}
fn nativeMotionB(c: vec4u, air: vec4f) -> vec4f {
  let k = KIND(i32(c.x & 255u));
  if (k == K_POWDER) { return vec4f(0.0, -fallVelocity(c) / ${WEATHER_SPEED_SI}, 0.0, air.w); }
  if (k == K_LIQUID && (c.y & 0xffffffu) != 0u) {
    return vec4f(vec3f(unpack2x16float(c.z), unpack2x16float(c.w & 65535u).x) / ${WEATHER_SPEED_FLUX}, air.w);
  }
  if (k == K_SOLID) { return vec4f(0.0, 0.0, 0.0, air.w); }
  return air;
}`;
