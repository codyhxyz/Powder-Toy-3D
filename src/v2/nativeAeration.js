import { prelude, STAGE } from '../shaders/common.js';
import { fold } from '../gpu/kernels.js';

// World's whitewater under Physics V2. Box draws V2's foam straight from the
// cores (shaders/common.js fetchNativeAeration: a liquid cell's age byte, read
// by liquidDetail.js aerTap under formats 2 and 3). World draws its own atlas,
// whose aeration channel came from V1's field (gfx/foam.js), which only V1's
// step advances: under V2 the World showed foam frozen from before the switch,
// or none. While V2 runs the box, World's live and leaving copies
// (world/renderSource.js liveSource) carry this instead: per slot, the same
// fetchNativeAeration, packed as V1's aeration record (vec2u of f16 pairs:
// aeration, liquid, fall, grounded), so worldAeration → aerTap gives what Box's
// aerTap gives, (age / 255, 1, 1). Different code, same foam (CLAUDE.md "Same
// features in every world"): the atlas's half floats round age / 255 to f16.

/** The record's group-2 layout: the packed aeration (one vec2u a slot). */
export const NATIVE_AERATION_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
const RECORD_BYTES = 8;   // vec2u: pack2x16float(aeration, liquid), pack2x16float(fall, grounded)

export const nativeAerationWGSL = (g) => /* wgsl */ `
${prelude(g, { state: 'read', fixedReadFormat: 2 })}
@group(2) @binding(0) var<storage, read_write> aer: array<vec2u>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  // (aeration, liquid weight, grounded share): Box's own reader, so the two can't drift
  let a = fetchNativeAeration(cellOf(s));
  aer[s] = select(vec2u(0u), vec2u(pack2x16float(vec2f(a.x, a.y)), pack2x16float(vec2f(0.0, a.z))), a.y > 0.5);
}
`;

/** CPU twin of one record (tools/v2/world-native-foam-check.mjs): what the kernel stores for a core. */
export function nativeAerationRecord(aeration) {
  const [x, y, z] = aeration;
  return y > 0.5 ? { aeration: x, liquid: y, fall: 0, grounded: z } : { aeration: 0, liquid: 0, fall: 0, grounded: 0 };
}

const bySim = new WeakMap();
/**
 * While V2 runs sim (sim.compact), its aeration for World's source: { buffer, generation,
 * record() } once the kernel is built, else null (the source then carries no aeration,
 * as V1's does until its field's kernels are built). Null under V1.
 */
export function nativeAerationFor(sim) {
  const owner = sim?.compact;
  if (!owner?.isReady || owner.disposed || sim.disposed) return null;
  let r = bySim.get(sim);
  if (r && r.g !== sim.g) { sim._retire?.(r.buffer); r = null; }
  if (!r) {
    const gpu = sim.gpu, g = sim.g;
    const layout = gpu.layout('NATIVE_AERATION', NATIVE_AERATION_LAYOUT);
    const buffer = gpu.createBuffer({ label: `sim${sim.id} native aeration`, size: g.slots * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const kernel = gpu.kernel({ name: 'nativeAeration', code: nativeAerationWGSL(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], workgroupSize: [64, 1, 1] });
    r = { g, buffer, kernel, group: gpu.bindGroup(layout, [{ binding: 0, resource: { buffer } }], 'native aeration'), recordedTick: -1 };
    bySim.set(sim, r);
  }
  if (r.kernel.state !== 'ready') return null;
  return {
    buffer: r.buffer,
    // V1's field counts its steps (gfx/foam.js generation); V2's foam changes only on a recorded tick
    generation: owner.tick,
    // Records the pack of V2's current cores into the open frame, before the copies that read it.
    record() {
      // (the cores themselves, as Box's format-2 volume binds them: Simulation.bindRO under V2)
      owner.sync();
      sim._dispatch(r.kernel, fold(Math.ceil(sim.g.slots / 64)), { bind: [sim.tables, owner.groups.read, r.group], header: { ...sim.header(), format: 2 } });
      r.recordedTick = owner.tick;
    },
  };
}
