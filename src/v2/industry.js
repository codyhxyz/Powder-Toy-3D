import { fold, STAGE } from '../gpu/kernels.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL } from './nativeWeather.js';
import { nativeForceCommitWGSL, FORCE_COMMIT_LAYOUT } from './nativeForcing.js';
import { nativeModes } from './modes.js';
import { GRAVITY } from './dynamics-reference.js';
import { SIM_GRAVITY } from '../physics.js';
import { CELL_M } from '../scale.js';
import { INDUSTRY_EDIT } from '../shaders/industry.js';

// Factory machines on V2's own cells. The machine rules are V1's, unchanged:
// shaders/industry.js update() (belt, separator, lift, miner, furnace, hearth)
// evaluates against the frozen native grid, exactly as the POV kick does
// (nativeForcing.js). Its writes commit natively: heat as energy, fuel life
// and ctype as payload, a fracture as V2's energy-exact rename, and motion as
// a V2 particle that carries the whole cell (a liquid's fill, a grain's fall
// state, the heat bank). No legacy B, projection or import is involved.
//
// Units. The rules author speeds in cells per V1 step, under V1's gravity of
// SIM_GRAVITY cells/step² (physics.js). V2 falls at GRAVITY m/s² (docs/v2.md
// §5.1). Converting with the speed that keeps the same trajectory in cells,
// v·√(GRAVITY·CELL_M/SIM_GRAVITY), keeps every machine's geometry: a lift
// still throws its grains V1's 20 cells up (1²/(2·0.025)) into the catch you
// built, and a belt's grains clear the same 5 cells per cell of drop. Time
// follows V2's slower 2 g clock, like every other fall. (The 240 Hz
// conversion tools use, 72 m/s, would throw a lift's grains ~250 cells.)
export const MACHINE_SPEED_SI = Math.sqrt(GRAVITY * CELL_M / SIM_GRAVITY);
export const NATIVE_INDUSTRY_SPEC = { ...INDUSTRY_EDIT, nativeForcing: true, speedSI: MACHINE_SPEED_SI };
export const NATIVE_INDUSTRY_COMMIT = { speedSI: MACHINE_SPEED_SI, life: true, sparse: true };
const RESULT_BYTES = 64;   // nativeWeather.js WeatherResult: four vec4s a cell
const binding = (n, read = false) => ({ binding: n, visibility: STAGE.COMPUTE, buffer: { type: read ? 'read-only-storage' : 'storage' } });
export const nativeIndustryParams = () => nativeWeatherParams('industry', { ...NATIVE_INDUSTRY_SPEC,
  params: { ...Object.fromEntries(INDUSTRY_EDIT.params.fields.map(f => [f.name, f.type])), origin: 'vec3i' } });
export const nativeIndustryEvaluateWGSL = (g, params = nativeIndustryParams()) => nativeWeatherEvaluateWGSL(g, NATIVE_INDUSTRY_SPEC, params);
export const nativeIndustryPlanWGSL = (g, params = nativeIndustryParams()) => nativeForceCommitWGSL(g, params, 'plan', NATIVE_INDUSTRY_COMMIT);

export class NativeIndustry {
  constructor(sim) {
    const o = sim.compactOwner, d = o?.dynamics, gpu = sim.gpu;
    if (!o?.nativeDynamics || !d) throw new Error('Native Factory machines need the native dynamics adapter');
    this.sim = sim; this.owner = o; this.dynamics = d; this.gpu = gpu;
    const params = this.params = nativeIndustryParams();
    this.evalLayout = gpu.layout('industryNativeEvaluate', [binding(1)]);
    this.commitLayout = gpu.layout('NATIVE_FORCE_COMMIT', FORCE_COMMIT_LAYOUT);
    this.evaluate = gpu.kernel({ name: 'industryNativeEvaluate', params, code: nativeIndustryEvaluateWGSL(sim.g, params),
      layouts: [sim.L.TABLES, sim.L.STATE_RO, this.evalLayout] });
    this.plan = gpu.kernel({ name: 'industryNativePlan', params, code: nativeIndustryPlanWGSL(sim.g, params),
      layouts: [o.nativeDynamics.layout, this.commitLayout] });
    this.ready = Promise.all([this.evaluate.ready, this.plan.ready, d.ready]);
    this.ready.catch(() => {});
    this.scratch = null; this.groups = null;
  }
  get isReady() {
    return this.evaluate.state === 'ready' && this.plan.state === 'ready' && this.dynamics.isReady
      && !this.sim.disposed && !this.owner.disposed && this.sim.compactOwner === this.owner && this.sim.compact === this.owner;
  }
  // One results scratch, reused by every box of a batch: the dispatches run in
  // call order, so each machine evaluates the grid its predecessors committed.
  _scratch(count) {
    const bytes = Math.max(1, count) * RESULT_BYTES;
    if (!this.scratch || this.scratch.size < bytes) {
      if (this.scratch) this.sim._retire(this.scratch);
      this.scratch = this.gpu.createBuffer({ label: 'industry native results', size: bytes, usage: GPUBufferUsage.STORAGE });
      this.groups = null;
    }
    const d = this.dynamics, air = d.air[d.airIndex];
    if (this.groups?.air !== air) {
      const entries = buffers => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      this.groups = { air,
        evaluate: this.gpu.bindGroup(this.evalLayout, [{ binding: 1, resource: { buffer: this.scratch } }], 'industry native evaluate'),
        commit: this.gpu.bindGroup(this.commitLayout, entries([this.scratch, air, d.plans, d.particles]), 'industry native commit') };
    }
    return this.groups;
  }
  /** One batch of machine edits ({ box: {lo, hi} inclusive cells, values: IndustryParams' fields }).
   * launch: the batch may move matter, so plans are cleared first and ONE native allocation
   * after the last box turns every planned cell into a particle (or leaves it exact on the grid). */
  run(edits, { launch = true } = {}) {
    const sim = this.sim, o = this.owner, d = this.dynamics;
    if (!this.isReady || sim.nativeTransition || sim.nativeTransitionError) return false;
    const dims = [sim.g.nx, sim.g.ny, sim.g.nz], boxes = [];
    for (const { box, values } of edits) {
      const lo = box.lo.map(v => Math.max(0, Math.ceil(v))), hi = box.hi.map((v, a) => Math.min(dims[a] - 1, Math.floor(v)));
      if (lo.some((v, a) => v > hi[a])) continue;
      boxes.push({ lo, hi, values, count: hi.reduce((n, v, a) => n * (v - lo[a] + 1), 1) });
    }
    if (!boxes.length) return false;
    o.sync();
    const groups = this._scratch(Math.max(...boxes.map(b => b.count)));
    const origin = [sim.origin.x, sim.origin.y, sim.origin.z], tick = o.tick + 1;
    const dispatch = (k, n, bind, header, b) => {
      k.dispatch(this.gpu.frame, fold(Math.ceil(n / 64)), { bind, header,
        params: { ...nativeModes(sim), ...b.values, editLo: b.lo, editHi: b.hi, tick, origin } });
      sim.onPass?.(k.name, { kind: 'compute', gpuMs: null });
    };
    if (launch) this.gpu.frame.clear(d.plans);
    for (const b of boxes) {
      dispatch(this.evaluate, b.count, [sim.tables, sim.bindPhysicalRO, groups.evaluate], sim.readHeader({ physical: true }), b);
      dispatch(this.plan, b.count, [o.nativeDynamics.group, groups.commit], sim.header(), b);
    }
    if (launch) d._allocate(tick, { mode: 15 });
    // As the native tick does: storeMaterial noted every changed brick, so a frame of
    // running machines never forces whole-grid derived passes (no changedAll).
    o.legacyPending = o.writtenSinceTick = true;
    sim.version++; o.seenVersion = sim.version;
    d._externalWork(); sim.wake();
    return true;
  }
  dispose() { if (this.scratch) this.sim._retire(this.scratch); this.scratch = null; this.groups = null; }
}

const natives = new WeakMap();   // sim → { owner, kernel }: one per native owner, like the POV force kernels
export function nativeIndustry(sim) {
  const o = sim?.compactOwner;
  if (!sim?.compact || sim.compact !== o || !o.dynamics || !o.nativeDynamics) return null;
  let entry = natives.get(sim);
  if (!entry || entry.owner !== o) {
    entry?.kernel.dispose();
    entry = { owner: o, kernel: new NativeIndustry(sim) };
    natives.set(sim, entry);
  }
  return entry.kernel;
}
