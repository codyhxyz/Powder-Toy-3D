import { prelude, STATE_OPTS, STAGE } from '../common.js';
import { brickInfoWGSL } from '../bindings.js';
import { AIR_FLAG } from '../passes.js';
import { nativeMotionWGSL } from './viewRead.js';

// The brick map's air flags (AIR_PRESSURE, AIR_FLOW: the Pressure view's cloud, the Flow view's
// strokes and haze) under Physics V2. V1's brick kernel (shaders/passes.js brickFrag) sets them
// from B over each brick's 2×2×2 core, over the bricks whose cells changed; V1's air lives in B,
// so a gust changes cells. V2's air lives per brick outside the cells (docs/v2.md §4.3) and moves
// without them, and the generic brick kernel's format-2 B is empty, so this pass sets the two
// flags after it, every derived frame, over every brick, from V1's B as V2 holds it
// (shaders/v2/viewRead.js: the air, a grain's fall, a liquid's flux), with brickFrag's sample and
// thresholds. Not a deviation: the same flags of the same quantities. (AIR_HOT stays the brick
// kernel's: V2's cells carry T.) A thread per brick; the read group (sim.bindRO under V2:
// v2/physics.js readGroup) binds the cells and the current air.
export const NATIVE_BRICK_AIR_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
export const nativeBrickAirWGSL = (g) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RO, fixedReadFormat: 2 })}
${brickInfoWGSL}
@group(2) @binding(0) var<storage, read_write> brick: array<BrickInfo>;
${nativeMotionWGSL}
const AIR_FLAG_P: f32 = ${AIR_FLAG.P};
const AIR_FLAG_V: f32 = ${AIR_FLAG.V};
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let air = nativeAirB(b * 64u);
  var pressure = 0.0;
  var speed2 = 0.0;
  for (var k = 0; k < 8; k++) {
    // brickFrag's sample: the core's cells (local 1..2 on each axis)
    let s = slotOf(brickCoord(b) * BS + vec3i(k & 1, (k >> 1u) & 1, (k >> 2u) & 1) + 1);
    let bv = nativeMotionB(A[s], air);
    pressure = max(pressure, abs(bv.w));
    speed2 = max(speed2, dot(bv.xyz, bv.xyz));
  }
  var flags = 0u;
  if (pressure > AIR_FLAG_P) { flags |= AIR_PRESSURE; }
  if (speed2 > AIR_FLAG_V * AIR_FLAG_V) { flags |= AIR_FLOW; }
  let mask = (AIR_PRESSURE | AIR_FLOW) << BRICK_AIR_SHIFT;
  brick[b].info = (brick[b].info & ~mask) | (flags << BRICK_AIR_SHIFT);
}`;
