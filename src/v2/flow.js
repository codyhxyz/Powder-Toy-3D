import { prelude, STAGE, LAYOUT } from '../shaders/common.js';
import { fallWGSL } from '../shaders/v2/fall.js';
import { v2ActLayout, CNT, V2_LAYOUT } from '../shaders/v2.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from './nativeWeather.js';
import { ELEMENTS, K } from '../elements.js';

// The renderer's flow field (Simulation.flow: three half floats a slot, cells per V1 step) while V2 runs
// the box. Its readers are the flowing grains' flow maps (shaders/gfx/surface.js gatherSurf, cellFlow),
// in Box and, through the live copies' aux (world/renderSource.js), in World. V1's move writes it
// (shaders/move.js blendFlow); V2 never ran that kernel, so under V2 the field held zeros after a load
// and V1's last motion after a runtime switch: sand pouring from a hole didn't carry its texture, or a
// pile V1 had left sliding kept sliding.
//
// V2 writes it here from the motion its cells hold, the same reading of them V2 already gives V1's
// readers (v2/nativeRead.js nativeB, the console's B; nativeWeather.js evaluate): a grain's fall
// velocity (v2/fall.js, m/s down) and a liquid's face flux (columns.js lanes), in V1's units
// (WEATHER_SPEED_SI, WEATHER_SPEED_FLUX), 0 for everything else. Once a tick, after every pass that
// moves cells, over the awake bricks (a brick sleeps only after a full quiet cycle, docs/v2.md 5.6, so
// the motion that stops is written as 0 before its brick sleeps).
//
// V1 blends each step's displacement into the field (FLOW_BLEND, about 20 steps) because its grains
// hop a whole cell on some steps and not others: the blend turns hops into a speed. A V2 grain's fall
// velocity is that speed already (gravity added a tick at a time, zeroed the tick it lands: "motion
// that happened", a resting pile reads 0, as move.js says of V1's), so it is written as it is.
// Different code that looks and plays the same: the texture moves at the grains' speed in both.
// Build cost (2026-10-20, naga MSL timed cold on the M5's Metal compiler, warm process): 16 ms, as
// v2invalidate's 15 ms, the cheapest V2 kernel; built idle, outside V2's readiness.
export const FLOW_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];

export function v2FlowWGSL(g) {
  const a = v2ActLayout(g);
  return /* wgsl */ `
${prelude(g, { state: false })}
${fallWGSL}
@group(1) @binding(0) var<storage, read_write> flow: array<vec2u>;   // Simulation.flow: per slot 3 × f16 + 0
@group(2) @binding(0) var<storage, read_write> cells: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> act2: array<atomic<u32>>;
const FLOW_LIST: u32 = ${a.list}u;                                  // the awake bricks (v2ActLayout list)
const FLOW_USE_AWAKE: u32 = ${a.count + CNT.USE_AWAKE}u;  // ... and how many this tick's passes use
const FLOW_LIQUID = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.kind === K.LIQUID)).join(',')});
const FLOW_POWDER = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.kind === K.POWDER)).join(',')});   // only grains topple
const FLOW_SPEED_SI: f32 = ${WEATHER_SPEED_SI};     // m/s per cell per V1 step
const FLOW_SPEED_FLUX: f32 = ${WEATHER_SPEED_FLUX};  // face flux per cell per V1 step
const FLOW_TOPPLE_MARK: f32 = 1.0;                   // a topple's record (shaders/v2.js, the block pass)
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = foldId(wg, nwg);
  if (e >= atomicLoad(&act2[FLOW_USE_AWAKE])) { return; }
  let s = atomicLoad(&act2[FLOW_LIST + e]) * 64u + li;
  let c = cells[s];
  let liquid = FLOW_LIQUID[c.x & 255u] && (c.y & 0xffffffu) != 0u;
  let flux = vec3f(unpack2x16float(c.z), unpack2x16float(c.w & 65535u).x) / FLOW_SPEED_FLUX;
  let v = select(vec3f(0.0, 0.0 - fallVelocity(c) / FLOW_SPEED_SI, 0.0), flux, liquid);   // fallVelocity: 0 but for a powder (0 - 0 is +0: still reads as the cleared field)
  var w = vec2u(pack2x16float(v.xy), pack2x16float(vec2f(v.z, 0.0)));
  // a grain the block pass toppled here this tick (shaders/v2.js FLOW_TOPPLE_MARK): its jump, for this tick
  let old = flow[s];
  let oldZ = unpack2x16float(old[1]);
  if (FLOW_POWDER[c.x & 255u] && oldZ.y == FLOW_TOPPLE_MARK) { w = vec2u(old[0], pack2x16float(vec2f(oldZ.x, 0.0))); }
  if (any(flow[s] != w)) { flow[s] = w; }
}
`;
}

/** V2's writer of the renderer's flow field (above): one small kernel, dispatched once a tick. */
export class NativeFlow {
  /** @param {import('./physics.js').PhysicsV2} owner @param {GPUBindGroupLayout} v2Layout its group 2 (V2_LAYOUT) */
  constructor(owner, v2Layout) {
    this.owner = owner; this.isReady = false; this.disposed = false;
    const { gpu, sim } = owner;
    const layout = gpu.layout('V2_FLOW', FLOW_LAYOUT);
    this.group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: sim.flow } }], 'v2 flow field');
    this.buffer = sim.flow;
    // (idle: presentation only; V2's readiness doesn't wait on it)
    this.kernel = gpu.kernel({ name: 'v2flow', build: 'idle', code: v2FlowWGSL(owner.g), layouts: [sim.L.TABLES, layout, v2Layout] });
    this.ready = this.kernel.ready.then(() => { if (!this.disposed) this.isReady = true; return this; });
    this.ready.catch(() => {});
    this.takeOver();
  }
  /** V2 takes the box (built, or activated after V1 ran it): what the field holds is V1's motion, not V2's.
   * Cleared, as a load clears it (Simulation.stillFlow); the awake bricks then write V2's from the next tick. */
  takeOver() { if (!this.disposed) this.owner.gpu.frame.clear(this.owner.sim.flow); }
  /** After the tick's moves: the awake bricks' cells' motion into the field (size: ARGS2.BRICKS indirect). */
  record(size) {
    if (!this.isReady || this.disposed) return false;
    const o = this.owner, sim = o.sim;
    if (sim.flow !== this.buffer) throw new Error('v2 flow: the simulation replaced its flow field');
    this.kernel.dispatch(o.gpu.frame, size, { bind: [sim.tables, this.group, o.groups.v2], header: sim.header() });
    sim.onPass?.('v2flow', { kind: 'compute', gpuMs: null });
    return true;
  }
  dispose() { this.disposed = true; this.isReady = false; }
}

/** tools/check-wgsl.mjs, tools/check-sampler-budget.mjs (src/gpu/checks.js): built with the native owner. */
export const WGSL_CHECK = [{ name: 'v2flow', kind: 'compute', code: v2FlowWGSL, layouts: () => [LAYOUT.TABLES, FLOW_LAYOUT, V2_LAYOUT], tool: true }];
