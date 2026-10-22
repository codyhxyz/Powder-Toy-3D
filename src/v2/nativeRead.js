import { prelude, STATE_OPTS } from '../shaders/common.js';
import { rectToAtlasFrag, atlasIndexWGSL } from '../shaders/passes.js';
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
// drawn: A as the drawn projection (compactA: a partial liquid dithered to whole cells, its volume
// kept on average), B the motion V2 holds as above: a save's `cells` for builds that read only V1's
// cells (sim.readSaveState), as V2's export gave them, without the export.
const RECT_READ_A = 'a = bitcast<vec4u>(fetchAs(s));';
export function nativeRectToAtlasWGSL(g, { drawn = false } = {}) {
  const v1 = rectToAtlasFrag(g), head = prelude(g, RECT_PRELUDE);
  if (!v1.includes(head) || !v1.includes(RECT_READ_B) || !v1.includes(RECT_READ_A)) throw new Error('passes.js rectToAtlasFrag no longer reads as expected');
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
}`).replace(RECT_READ_B, 'b = bitcast<vec4u>(nativeB(p, s));').replace(RECT_READ_A, drawn ? 'a = bitcast<vec4u>(compactA(p, A[s]));' : RECT_READ_A);
}

// Each atlas texel's element id, a byte a texel, four to a word (sim.readNativeIds): what the flood
// fill (editing.js runFill) and the city bus's arrival check (pov/village/bus.js) read, from the native
// cells in the physical view (format 3: a quantum of liquid is liquid, as the native brush's evaluate
// reads a cell, so a fill's region and its brush's filter agree). V1 read its whole state back for
// them (readState: 32 bytes a texel and, under V2, an export of V1's projection first); this reads
// the id alone. A thread a row of a brick: its four cells x = 0..3 are four texels in a row
// (passes.js atlasIndex: (p.x & 3) is the texel's low column bits), one word. Texels no cell owns
// (the atlas's padding) read 0, air.
export const NATIVE_ID_ROWS = 16;   // rows of four cells in a 4³ brick
export function nativeIdsWGSL(g) {
  return `${prelude(g, STATE_OPTS.STATE_RO)}
${atlasIndexWGSL(g)}
@group(2) @binding(0) var<storage, read_write> ids: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let r = foldThread(wg, nwg, li);
  if (r >= ${g.nbricks * NATIVE_ID_ROWS}u) { return; }
  let o = cellOf((r / ${NATIVE_ID_ROWS}u) * 64u) & vec3i(~3);
  let row = r % ${NATIVE_ID_ROWS}u;
  let p = o + vec3i(0, i32(row & 3u), i32(row >> 2u));
  var w = 0u;
  for (var x = 0; x < 4; x++) {
    let q = p + vec3i(x, 0, 0);
    if (inGrid(q)) { w |= (u32(clamp(eid(fetchA(q)), 0, 255)) << (8u * u32(x))); }
  }
  ids[atlasIndex(p) >> 2u] = w;
}`;
}
