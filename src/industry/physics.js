import { E, K } from '../elements.js';
import { INDUSTRY_LIMIT, DEVICE_TYPES, FILTER_IDS, baseMaterial, deviceCell, deviceDirection } from './catalog.js';
import { INDUSTRY_EDIT, INDUSTRY_KIND } from '../shaders/industry.js';
import { createTransfer, Load } from '../pov/tools/transfer.js';
import { povGpu } from '../pov/gpu.js';

// Ports are integer local cells, rotated exactly like construction geometry.
export const controlCell = d => deviceCell(d, -1, 0, 1);
export const machineGuard = d => ({ base: [d.x, d.y, d.z], material: baseMaterial(d.type), port: controlCell(d), powered: !!d.powered });
const region = (d, x0, x1, y0, y1, z0, z1) => {
  const cells = [];
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push(deviceCell(d, x, y, z));
  return cells;
};
export const machinePorts = d => ({
  inlet: region(d, 0, 3, 1, 2, -1, -1),
  outlet: region(d, 0, 3, 5, 6, 4, 4),
  mouth: region(d, 0, 3, 1, 1, 0, 3),
});
export function machineBox(d) {
  const ends = d.type === 'miner' ? [deviceCell(d, 0, 1, 4), deviceCell(d, 3, 3, 7)]
    : [deviceCell(d, 0, 1, 0), deviceCell(d, 3, d.type === 'heater' ? 3 : 1, 3)];
  return { lo: ends[0].map((n, i) => Math.min(n, ends[1][i])), hi: ends[0].map((n, i) => Math.max(n, ends[1][i])) };
}
const signature = d => [d.id, d.type, d.x, d.y, d.z, d.rotation].join(':');
export function validMachine(d, g) {
  return d && typeof d.id === 'string' && Object.hasOwn(DEVICE_TYPES, d.type)
    && [d.x, d.y, d.z, d.rotation].every(Number.isInteger) && d.rotation >= 0 && d.rotation < 4
    && d.x >= 0 && d.y >= 0 && d.z >= 0 && d.x + 4 <= g.nx && d.y + 1 < g.ny && d.z + 4 <= g.nz;
}

/** Call step ONLY alongside native simulation advancement. No timers, no
 * writes from promise callbacks. reset is for WORLD REPLACEMENT, not pause or
 * save. pending includes buffered pump matter: never snapshot/reset while it
 * is nonzero (pause capture by stepping with [] to drain, then save). A blocked
 * drain can remain pending indefinitely; do not silently lose its cargo.
 */
export function createIndustryPhysics({ getSim, onShip = () => {}, onError = console.error }) {
  let sim = null, kernel = null, transfer = null, epoch = 0, disposed = false;
  let ready = Promise.resolve(), built = false, cursor = 0;
  const states = new Map();
  function reset() {
    epoch++;
    states.clear(); // detached Load objects may finish; no stale callback earns credit
    sim = null; kernel = null; transfer = null; built = false;
    ready = Promise.resolve();
  }
  function bind() {
    if (disposed) return;
    const next = getSim();
    if (next === sim) return;
    reset();
    if (!next) return;
    sim = next;
    const generation = epoch;
    try {
      kernel = sim.editKernel('industry', INDUSTRY_EDIT);
      const bound = sim;
      transfer = createTransfer({ getSim: () => bound });
      // Only compile the exact transfer family, not the entire POV toolbelt.
      ready = Promise.all([kernel.ready, povGpu(sim)._transferKernel().ready]).then(() => {
        if (generation === epoch && !disposed) built = true;
      });
      ready.catch(err => { if (generation === epoch && !disposed) onError(err); });
    } catch (err) {
      ready = Promise.reject(err);
      ready.catch(() => {});
      onError(err);
    }
  }
  function track(s, promise, done = () => {}) {
    if (!promise) return false;
    s.busy = true;
    const generation = epoch, bound = sim;
    promise.then(value => {
      if (generation !== epoch || disposed || getSim() !== bound) return;
      s.busy = false;
      done(value);
    }).catch(err => {
      if (generation !== epoch || disposed || getSim() !== bound) return;
      s.busy = false;
      onError(err);
    });
    return true;
  }
  function ship(s, d) {
    const id = s.metal ? E.METAL : E.NUGGETS;
    const p = transfer.take(s.load, { cells: machinePorts(d).mouth, kinds: [K.POWDER, K.SOLID],
      want: id, maxTemperature: id === E.METAL ? 90 : 1e30, guard: machineGuard(d), limit: 16 });
    if (track(s, p, got => {
      // Credit only the actual atomically removed cells, never an estimate or
      // a pre-read. Preserve exact per-cell temperature for progression.
      s.load.cells.length = 0;
      s.load.version++;
      for (const c of got) onShip({ id: c[0], count: 1, temperature: c[1] });
    })) { s.metal = !s.metal; s.clock = 0; }
  }
  function pump(s, active) {
    const d = s.device, ports = machinePorts(d);
    if (s.load.count) {
      // Blocked/off/destroyed pumps eventually return cargo to the inlet.
      // Dismantled pumps spill on subsequent steps, without base/control guard.
      // No overwrite: blocked return also stays in the conserved Load.
      const spill = !active || s.blocked >= 1;
      const cells = spill ? region(d, -1, 4, 1, 3, -2, 3) : ports.outlet;
      const p = transfer.put(s.load, { cells, max: 8, guard: spill ? null : machineGuard(d), vel: [0, 0, 0] });
      if (track(s, p, n => { if (n) s.blocked = 0; })) s.clock = 0;
    } else if (active) {
      const p = transfer.take(s.load, { cells: ports.inlet, kinds: [K.LIQUID], guard: machineGuard(d), limit: 8 });
      if (track(s, p, () => { s.blocked = 0; })) s.clock = 0;
    }
  }
  function step(dt, devices) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    bind();
    if (!sim || !built) return;
    dt = Math.min(dt, 0.1);
    const seen = new Set(), active = [];
    for (const d of (Array.isArray(devices) ? devices : []).slice(0, INDUSTRY_LIMIT)) {
      if (!validMachine(d, sim.g) || seen.has(d.id)) continue;
      seen.add(d.id);
      const key = signature(d);
      let s = states.get(key);
      if (!s && states.size < INDUSTRY_LIMIT) {
        s = { device: { ...d }, load: new Load(16), clock: 0, drillClock: 0, blocked: 0, busy: false, metal: false };
        states.set(key, s);
      }
      if (!s) continue;
      s.device = { ...d };
      active.push(key);
    }
    const live = new Set(active);
    // Rotation of dispatch priority avoids starving device 9+ at the shared
    // transfer engine's eight-readback limit. One operation/device at a time.
    const entries = [...states.entries()];
    if (entries.length) cursor = (cursor + 1) % entries.length;
    for (let i = 0; i < entries.length; i++) {
      const [key, s] = entries[(i + cursor) % entries.length];
      const d = s.device, present = live.has(key);
      s.clock += dt; s.drillClock += dt;
      if (s.load.count) s.blocked += dt;
      if (!present && !s.busy && !s.load.count) { states.delete(key); continue; }
      if (d.type === 'pump' || d.type === 'ship') {
        if (s.busy || s.clock < 0.125) continue;
        if (d.type === 'pump') pump(s, present);
        else if (present) ship(s, d);
        continue;
      }
      if (!present) continue;
      const guard = machineGuard(d), forward = deviceDirection(d), right = [forward[2], 0, -forward[0]];
      const drill = s.drillClock >= 0.35;
      if (d.type === 'miner' && !drill) continue;
      sim.edit(kernel, machineBox(d), {
        guardBase: guard.base, guardMaterial: guard.material, guardPort: guard.port, guardPowered: +guard.powered,
        corner: deviceCell(d, 0, 0, 0), forward, right, kind: INDUSTRY_KIND[d.type],
        selectedId: FILTER_IDS.includes(d.filter) ? d.filter : E.NUGGETS, dt, drill: +drill,
      });
      if (drill) s.drillClock = 0;
    }
  }
  bind();
  return {
    get ready() { bind(); return ready; }, step,
    get pending() { return [...states.values()].reduce((n, s) => n + +s.busy + s.load.count, 0); },
    reset,
    dispose() { reset(); disposed = true; },
  };
}
