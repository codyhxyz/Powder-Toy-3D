import { prelude, STATE_OPTS } from '../shaders/common.js';
import { rectToAtlasFrag } from '../shaders/passes.js';
import { fallWGSL } from '../shaders/v2/fall.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from './nativeWeather.js';

// The console's reads under V2 (sim.readStateRect, console/gpu.js): V1's rectangle of the atlas
// (passes.js rectToAtlasFrag, its texel-to-cell mapping verbatim) read from the native cells,
// with B the motion V2 really holds, in V1's units (cells/step, V1 pressure), the same view the
// native force evaluators give V1's rules (nativeWeather.js evaluate): a grain's fall velocity, a
// liquid's face flux, and elsewhere the brick's air (its wind and pressure). V1's own B is not
// kept under V2, so a script's vx/vy/vz/pressure read from it would be 0.
const RECT_PRELUDE = { state: 'read', flags: true };
const RECT_READ_B = 'b = bitcast<vec4u>(fetchBs(s));';
export function nativeRectToAtlasWGSL(g) {
  const v1 = rectToAtlasFrag(g), head = prelude(g, RECT_PRELUDE);
  if (!v1.includes(head) || !v1.includes(RECT_READ_B)) throw new Error('passes.js rectToAtlasFrag no longer reads as expected');
  return v1.replace(head, `${prelude(g, STATE_OPTS.STATE_RO)}
${fallWGSL}
fn nativeB(p: vec3i, s: u32) -> vec4f {
  let air = fetchBs(s);   // (the physical readers' B: the brick's air in V1 units)
  let id = eid(fetchAs(s));
  if (KIND(id) == K_POWDER) { return vec4f(0.0, -fallVelocity(fetchNativeCore(p)) / ${WEATHER_SPEED_SI}, 0.0, air.w); }
  if (KIND(id) == K_LIQUID) {
    let c = fetchNativeCore(p);
    return vec4f(vec3f(unpack2x16float(c.z), unpack2x16float(c.w & 65535u).x) / ${WEATHER_SPEED_FLUX}, air.w);
  }
  if (KIND(id) == K_SOLID) { return vec4f(0.0, 0.0, 0.0, air.w); }
  return air;
}`).replace(RECT_READ_B, 'b = bitcast<vec4u>(nativeB(p, s));');
}
