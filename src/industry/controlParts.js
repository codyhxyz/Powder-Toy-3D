import { E, ELEMENTS } from '../elements.js';
import { PHYS } from '../physics.js';
import { prelude, STATE_OPTS, LAYOUT } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { RING_LAYOUT, ringWGSL } from '../shaders/povBody.js';

// Existing TPT materials only: Industry charges credits in its controller after
// a confirmed placement; purchases are physical and irreversible.
export const CONTROL_PARTS = Object.freeze({
  TSNS: Object.freeze({ key: 'TSNS', material: E.TSNS, cost: 3, name: 'Temperature sensor',
    description: 'Fires when touching matter hotter than its native temperature threshold.', threshold: true, defaultThreshold: 200 }),
  SWITCH: Object.freeze({ key: 'SWITCH', material: E.SWITCH, cost: 2, name: 'Switch',
    description: 'A native SWCH relay; toggle this real cell on or off.' }),
  BATTERY: Object.freeze({ key: 'BATTERY', material: E.BATTERY, cost: 5, name: 'Battery',
    description: 'A native battery that energizes touching conductors.' }),
  METAL: Object.freeze({ key: 'METAL', material: E.METAL, cost: 1, name: 'Metal conductor',
    description: 'Existing metal cell; carries native sparks and melts normally.' }),
  PSCN: Object.freeze({ key: 'PSCN', material: E.PSCN, cost: 1, name: 'P-type silicon',
    description: 'Native P-type conductor for switching and signal wiring.' }),
  NSCN: Object.freeze({ key: 'NSCN', material: E.NSCN, cost: 1, name: 'N-type silicon',
    description: 'Native N-type conductor for switching and signal wiring.' }),
  INSULATOR: Object.freeze({ key: 'INSULATOR', material: E.INSULATOR, cost: 1, name: 'Insulator',
    description: 'Native electrical insulator; blocks current and reacts normally.' }),
});
export const CONTROL_PART_KEYS = Object.freeze(Object.keys(CONTROL_PARTS));
export const CONTROL_PART_THRESHOLD_BOUNDS = Object.freeze([PHYS.CELL_TEMP_MIN, PHYS.CELL_TEMP_MAX]);

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function dimensions(bounds) {
  const g = Array.isArray(bounds) ? { nx: bounds[0], ny: bounds[1], nz: bounds[2] } : bounds;
  if (!record(g) || ![g.nx, g.ny, g.nz].every(n => Number.isInteger(n) && n > 0)) throw new TypeError('Invalid control-part grid bounds');
  return g;
}

/** Return a deep-owned canonical one-cell build spec or throw without mutation. */
export function validateControlPartSpec(spec, bounds) {
  const g = dimensions(bounds);
  if (!record(spec) || typeof spec.key !== 'string' || !Object.hasOwn(CONTROL_PARTS, spec.key)) throw new TypeError('Choose a permitted native control part');
  if (![spec.x, spec.y, spec.z].every(Number.isInteger)
      || spec.x < 0 || spec.y < 0 || spec.z < 0 || spec.x >= g.nx || spec.y >= g.ny || spec.z >= g.nz) {
    throw new RangeError('Control part must be placed at an in-bounds cell');
  }
  const part = CONTROL_PARTS[spec.key];
  const hasThreshold = Object.hasOwn(spec, 'threshold');
  if (!part.threshold && hasThreshold) throw new TypeError('Only TSNS accepts a temperature threshold');
  const out = { key: part.key, material: part.material, cost: part.cost, x: spec.x, y: spec.y, z: spec.z };
  if (part.threshold) {
    const threshold = hasThreshold ? spec.threshold : part.defaultThreshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || !Number.isFinite(Math.fround(threshold))
        || threshold < PHYS.CELL_TEMP_MIN || threshold > PHYS.CELL_TEMP_MAX) {
      throw new RangeError(`TSNS threshold must be finite and between ${PHYS.CELL_TEMP_MIN} and ${PHYS.CELL_TEMP_MAX}°C`);
    }
    out.threshold = Math.fround(threshold);
  }
  return out;
}

const PartParams = uniformStruct('FactoryControlPart', {
  at: 'vec3i', material: 'i32', temperature: 'f32', mode: 'u32', slot: 'u32',
});

/** One workgroup writes one empty cell or toggles one real native SWITCH. */
export const controlPartsWGSL = g => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${PartParams.wgsl}
@group(3) @binding(1) var<uniform> P: FactoryControlPart;
${ringWGSL()}
const FACTORY_PART_PLACE: u32 = 0u;
const FACTORY_PART_TOGGLE: u32 = 1u;
const FACTORY_PART_OK: f32 = 1.0;
const FACTORY_PART_REJECTED: f32 = 2.0;
const FACTORY_PART_OUT_OF_BOUNDS: f32 = 3.0;
fn markControlNeighbours(p: vec3i) {
  let offsets = array<vec3i, 6>(vec3i(1,0,0), vec3i(-1,0,0), vec3i(0,1,0), vec3i(0,-1,0), vec3i(0,0,1), vec3i(0,0,-1));
  for (var i = 0u; i < 6u; i++) {
    let q = p + offsets[i];
    if (inGrid(q)) { markBrick(brickId(q >> vec3u(2u))); }
  }
}

@compute @workgroup_size(1)
fn main() {
  var result = vec4f(FACTORY_PART_OUT_OF_BOUNDS, 0.0, 0.0, 0.0);
  if (inGrid(P.at)) {
    let a = fetchA(P.at); let b = fetchB(P.at);
    if (P.mode == FACTORY_PART_PLACE) {
      if (eid(a) == E_EMPTY) {
        let outA = vec4f(f32(P.material), P.temperature, SPAWNLIFE(P.material), fract(a.w));
        if (writeCell(P.at, a, b, fetchF(P.at), outA, vec4f(0.0, 0.0, 0.0, b.w))) {
          markBrick(brickId(P.at >> vec3u(2u)));
          markControlNeighbours(P.at);
          result = vec4f(FACTORY_PART_OK, f32(P.material), outA.y, outA.z);
        }
      } else {
        result = vec4f(FACTORY_PART_REJECTED, f32(eid(a)), a.y, a.z);
      }
    } else if (P.mode == FACTORY_PART_TOGGLE && eid(a) == E_SWITCH) {
      var outA = a;
      // TPT shutdown countdown spreads OFF through a touching switch bank.
      outA.z = select(SWITCH_ON, SWITCH_ON - 1.0, a.z == SWITCH_ON);
      if (writeCell(P.at, a, b, fetchF(P.at), outA, b)) {
        markBrick(brickId(P.at >> vec3u(2u)));
        markControlNeighbours(P.at);
        result = vec4f(FACTORY_PART_OK, f32(E_SWITCH), outA.y, outA.z);
      }
    } else {
      result = vec4f(FACTORY_PART_REJECTED, f32(eid(a)), a.y, a.z);
    }
  }
  ringOut[P.slot] = result;
}`;

export const WGSL_CHECK = [{ name: 'industryFactoryControlParts', kind: 'compute', code: controlPartsWGSL,
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, RING_LAYOUT], dispatch: () => [1, 1, 1] }];

function failure(reason, spec = {}) { return { ok: false, reason, ...spec }; }
function recordResult(bytes) { return new Float32Array(bytes, 0, 4); }

/**
 * Places existing physical control materials atomically into empty cells and
 * toggles only a SWCH at the requested position. Never changes credits.
 */
export function createFactoryControlParts({ getSim }) {
  if (typeof getSim !== 'function') throw new TypeError('createFactoryControlParts requires getSim');
  let sim = null, context = null, epoch = 0, disposed = false, pendingCount = 0;
  let queue = Promise.resolve(), bindFailure = '';
  function bind() {
    if (disposed) return null;
    let next;
    try { next = getSim(); } catch (error) { bindFailure = error?.message ?? 'Could not read the active simulation'; return null; }
    if (next === sim) return context;
    epoch++;
    sim = next && !next.disposed ? next : null;
    context = null;
    bindFailure = '';
    if (!sim) return null;
    try {
      const gpu = sim.gpu, layout = gpu.layout('industry factory control-part result', RING_LAYOUT);
      const ring = gpu.readback.ring('industry factory control parts', 16, 16);
      const group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: ring.buffer } }], 'industry factory control-part result');
      const kernel = gpu.kernel({ name: 'industryFactoryControlParts', code: controlPartsWGSL(sim.g), params: PartParams,
        layouts: [sim.L.TABLES, sim.L.STATE_RW, layout], workgroupSize: [1, 1, 1] });
      const ready = kernel.ready;
      ready.catch(() => {});
      context = { sim, gpu, ring, group, kernel, ready, epoch };
      return context;
    } catch (error) {
      bindFailure = error?.message ?? 'Could not initialize control-part GPU backend';
      sim = null;
      context = null;
      return null;
    }
  }
  const current = ctx => !disposed && context === ctx && sim === ctx.sim && epoch === ctx.epoch
    && !ctx.sim.disposed && getSim() === ctx.sim;
  function enqueue(ctx, spec, mode) {
    pendingCount++;
    const operation = async () => {
      try {
        if (!current(ctx)) return failure('Simulation changed before the control-part operation');
        await ctx.ready;
        if (!current(ctx)) return failure('Simulation changed before the control-part operation');
        const slot = ctx.ring.next();
        const material = mode === 0 ? spec.material : E.SWITCH;
        const temperature = mode === 0 ? (spec.threshold ?? ELEMENTS[spec.material].temp) : 0;
        ctx.sim._dispatch(ctx.kernel, [1, 1, 1], { bind: [ctx.sim.tables, ctx.sim.bindRW, ctx.group], header: ctx.sim.header(),
          params: { at: [spec.x, spec.y, spec.z], material, temperature, mode, slot } });
        const result = ctx.ring.read(slot);
        ctx.gpu.flush('industry factory control part');
        const [code, foundMaterial, temperatureOut, stateOut] = recordResult(await result);
        if (!current(ctx)) return failure('Simulation changed during the control-part operation');
        if (code !== 1) {
          const reason = code === 3 ? 'Control-part cell is outside the simulation' : mode === 0
            ? 'Control parts may only be placed in an empty cell' : 'A real SWCH is not at the requested cell';
          return failure(reason, { key: spec.key ?? 'SWITCH', x: spec.x, y: spec.y, z: spec.z });
        }
        ctx.sim.version++;
        ctx.sim.wake();
        if (mode === 0) return { ok: true, reason: '', key: spec.key, material: Math.trunc(foundMaterial), cost: spec.cost,
          x: spec.x, y: spec.y, z: spec.z, ...(spec.threshold === undefined ? {} : { threshold: temperatureOut }) };
        return { ok: true, reason: '', key: 'SWITCH', material: E.SWITCH, x: spec.x, y: spec.y, z: spec.z, on: stateOut === 10 };
      } catch (error) {
        return failure(error?.message ?? 'Control-part operation failed');
      }
    };
    const job = queue.then(operation, operation);
    queue = job.catch(() => {});
    return job.finally(() => { pendingCount--; });
  }
  function place(spec) {
    if (disposed) return Promise.resolve(failure('Factory control parts are disposed'));
    const ctx = bind();
    if (!ctx) return Promise.resolve(failure(bindFailure || 'No active simulation'));
    let canonical;
    try { canonical = validateControlPartSpec(spec, ctx.sim.g); }
    catch (error) { return Promise.resolve(failure(error.message)); }
    return enqueue(ctx, canonical, 0);
  }
  function toggle(spec) {
    if (disposed) return Promise.resolve(failure('Factory control parts are disposed'));
    const ctx = bind();
    if (!ctx) return Promise.resolve(failure(bindFailure || 'No active simulation'));
    if (!record(spec) || ![spec.x, spec.y, spec.z].every(Number.isInteger)
        || spec.x < 0 || spec.y < 0 || spec.z < 0 || spec.x >= ctx.sim.g.nx || spec.y >= ctx.sim.g.ny || spec.z >= ctx.sim.g.nz) {
      return Promise.resolve(failure('Switch position must be an in-bounds cell'));
    }
    return enqueue(ctx, { key: 'SWITCH', x: spec.x, y: spec.y, z: spec.z }, 1);
  }
  return {
    place,
    toggle,
    get pending() { return pendingCount; },
    dispose() { if (disposed) return; disposed = true; epoch++; sim = null; context = null; },
  };
}
