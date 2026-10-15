import { E, K, ELEMENTS } from '../elements.js';
import { INDUSTRY_LIMIT, DEVICE_TYPES, FILTER_IDS, CASTING_TEMPERATURE, baseMaterial, deviceCell, deviceDirection } from './catalog.js';
import { INDUSTRY_EDIT, INDUSTRY_KIND } from '../shaders/industry.js';
import { createTransfer, Load } from '../pov/tools/transfer.js';
import { povGpu } from '../pov/gpu.js';
import { deviceHeight } from './validation.js';
import { NOMINAL_STEP_RATE } from '../physics.js';

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
  // The collector's open gantry includes grains that freeze above its floor;
  // TPT's cooled metal is static, so it does not fall like an inventory item.
  mouth: region(d, 0, 3, 1, 3, 0, 3),
});
export function machineBox(d) {
  const ends = d.type === 'miner' ? [deviceCell(d, 0, 1, 0), deviceCell(d, 3, 3, 7)]
    : [deviceCell(d, 0, ['heater', 'hearth'].includes(d.type) ? 0 : 1, 0), deviceCell(d, 3, ['heater', 'hearth'].includes(d.type) ? 3 : 1, 3)];
  return { lo: ends[0].map((n, i) => Math.min(n, ends[1][i])), hi: ends[0].map((n, i) => Math.max(n, ends[1][i])) };
}
const signature = d => [d.id, d.type, d.x, d.y, d.z, d.rotation].join(':');
export function validMachine(d, g) {
  return d && typeof d.id === 'string' && Object.hasOwn(DEVICE_TYPES, d.type)
    && [d.x, d.y, d.z, d.rotation].every(Number.isInteger) && d.rotation >= 0 && d.rotation < 4
    && d.x >= 0 && d.y >= 0 && d.z >= 0 && d.x + 4 <= g.nx && d.y + deviceHeight(d) <= g.ny && d.z + 4 <= g.nz;
}

// Callers loading a world pass its header dimensions before changing terrain.
// Standalone cargo validation uses the maximum supported save bounds.
const SAVE_BOUNDS = { nx: 4096, ny: 4096, nz: 4096 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function savedDevice(d, bounds) {
  if (!record(d) || typeof d.type !== 'string' || !validMachine(d, SAVE_BOUNDS) || !/^[a-zA-Z0-9_-]{1,64}$/.test(d.id)
      || (d.powered !== undefined && typeof d.powered !== 'boolean')
      || (d.filter !== undefined && !FILTER_IDS.includes(d.filter))) throw new Error('Invalid industry cargo device');
  if (!validMachine(d, bounds)) throw new Error('Industry cargo is outside the simulation');
  const out = { id: d.id, type: d.type, x: d.x, y: d.y, z: d.z, rotation: d.rotation };
  if (d.filter !== undefined) out.filter = d.filter;
  if (d.powered !== undefined) out.powered = d.powered;
  return out;
}

/** Validate without mutation; throw on invalid input, otherwise return a deep-
 * owned canonical {version:1,pumps:[{id,device,cells}]} snapshot. An absent id is
 * a dismantled pump: retain its device coordinates so its cargo can spill.
 * An id still in devices must have exactly the same pump geometry/identity.
 */
export function validateIndustryPhysics(data, devices, bounds = SAVE_BOUNDS) {
  if (!record(data) || data.version !== 1 || !Array.isArray(data.pumps) || data.pumps.length > INDUSTRY_LIMIT
      || !Array.isArray(devices) || devices.length > INDUSTRY_LIMIT) throw new Error('Invalid industry cargo snapshot');
  const current = new Map();
  for (const spec of devices) {
    const d = savedDevice(spec, bounds);
    if (current.has(d.id)) throw new Error('Duplicate industry device id');
    current.set(d.id, d);
  }
  const seen = new Set(), pumps = [];
  for (const entry of data.pumps) {
    if (!record(entry)) throw new Error('Invalid industry pump cargo');
    const d = savedDevice(entry.device, bounds), key = signature(d), active = current.get(d.id);
    if (d.type !== 'pump' || entry.id !== d.id || seen.has(d.id)
        || (active && signature(active) !== key)) throw new Error('Invalid industry pump identity');
    if (!Array.isArray(entry.cells) || !entry.cells.length || entry.cells.length > 16) throw new Error('Invalid industry cargo capacity');
    const cells = [];
    for (const cell of entry.cells) {
      if (!Array.isArray(cell) || cell.length !== 4 || !Number.isInteger(cell[0])
          || ELEMENTS[cell[0]]?.kind !== K.LIQUID
          || ![cell[1], cell[2], cell[3]].every(n => Number.isFinite(n) && Number.isFinite(Math.fround(n)))) {
        throw new Error('Invalid industry liquid cargo');
      }
      cells.push([...cell]);
    }
    seen.add(d.id);
    pumps.push({ id: d.id, device: d, cells });
  }
  return { version: 1, pumps };
}
const machineState = device => ({ device: { ...device }, load: new Load(16), clock: 0, drillClock: 0, blocked: 0, busy: false, metal: false, shipTarget: null });

/** Call step ONLY alongside native simulation advancement. No timers or writes
 * from promise callbacks. pending counts in-flight transactions (including
 * reserved takes/puts); buffered counts only owned cargo, not matter already
 * put into the world. Pause stepping, wait for pending === 0, then synchronously
 * capture toJSON together with terrain. Blocked/running pumps need not drain.
 * fromJSON(snapshot, devices) replaces owned cargo only, never terrain; restore
 * the matching terrain snapshot separately. Neither operation accepts pending
 * transfers. reset is for WORLD REPLACEMENT, not pause, mode toggles or save.
 */
export function createIndustryPhysics({ getSim, onShip = () => {}, onTransfer = () => {}, onError = console.error }) {
  let sim = null, kernel = null, transfer = null, epoch = 0, disposed = false;
  let ready = Promise.resolve(), built = false, cursor = 0;
  let nativeFrame = null;
  const states = new Map();
  function confirmedTransfer(device, event) {
    try { onTransfer({ device: { ...device }, confirmed: true, ...event }); }
    catch (error) { onError(error); }
  }
  function reset() {
    epoch++;
    states.clear(); // detached Load objects may finish; no stale callback earns credit
    sim = null; kernel = null; transfer = null; built = false;
    nativeFrame = null;
    ready = Promise.resolve();
  }
  function bind() {
    if (disposed) return;
    const next = getSim();
    if (next === sim) return;
    reset();
    if (!next) return;
    sim = next;
    nativeFrame = Number.isFinite(sim.frame) ? sim.frame : null;
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
    s.shipTarget = id;
    const p = transfer.take(s.load, { cells: machinePorts(d).mouth, kinds: [K.POWDER, K.SOLID],
      want: id, maxTemperature: id === E.METAL ? CASTING_TEMPERATURE : 1e30, guard: machineGuard(d), limit: 16 });
    if (track(s, p, got => {
      // Credit and diagnostic evidence use only the actual atomically removed
      // cells, never an estimate or a pre-read. Preserve each cell's temperature.
      s.load.cells.length = 0;
      s.load.version++;
      for (const c of got) {
        const shipment = { id: c[0], count: 1, temperature: c[1] };
        onShip(shipment);
        confirmedTransfer(d, { operation: 'ship', ...shipment });
      }
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
      // Noita-inspired liquid spray: use the existing belt's 0.6 launch speed
      // to clear the raised spout, then let native drag/gravity handle the flow.
      // Returns remain still; they are not nozzle discharge.
      const vel = spill ? [0, 0, 0] : deviceDirection(d).map(n => n * 0.6);
      const p = transfer.put(s.load, { cells, max: 8, guard: spill ? null : machineGuard(d), vel });
      if (track(s, p, n => {
        if (n) { s.blocked = 0; confirmedTransfer(d, { operation: spill ? 'pump-return' : 'pump-output', count: n }); }
      })) s.clock = 0;
    } else if (active) {
      const p = transfer.take(s.load, { cells: ports.inlet, kinds: [K.LIQUID], guard: machineGuard(d), limit: 8 });
      if (track(s, p, got => {
        s.blocked = 0;
        if (got.length) confirmedTransfer(d, { operation: 'pump-input', count: got.length });
      })) s.clock = 0;
    }
  }
  function step(dt, devices) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    bind();
    const frame = sim && Number.isFinite(sim.frame) ? sim.frame : null;
    const nativeTicks = frame !== null && nativeFrame !== null ? Math.max(0, frame - nativeFrame) : 0;
    nativeFrame = frame;
    if (!sim || !built) return;
    dt = Math.min(dt, 0.1);
    const seen = new Set(), active = [];
    for (const d of (Array.isArray(devices) ? devices : []).slice(0, INDUSTRY_LIMIT)) {
      // Structural decks are ordinary matter, never a default kind-0 conveyor.
      if (['foundation', 'gate'].includes(d?.type) || !validMachine(d, sim.g) || seen.has(d.id)) continue;
      seen.add(d.id);
      const key = signature(d);
      let s = states.get(key);
      if (!s && states.size < INDUSTRY_LIMIT) {
        s = machineState(d);
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
      if (d.type === 'hearth' && nativeTicks <= 0) continue;
      const guard = machineGuard(d), forward = deviceDirection(d), right = [forward[2], 0, -forward[0]];
      const drill = s.drillClock >= 0.35;
      sim.edit(kernel, machineBox(d), {
        guardBase: guard.base, guardMaterial: guard.material, guardPort: guard.port, guardPowered: +guard.powered,
        corner: deviceCell(d, 0, 0, 0), forward, right, kind: INDUSTRY_KIND[d.type],
        selectedId: FILTER_IDS.includes(d.filter) ? d.filter : E.NUGGETS,
        dt: d.type === 'hearth' ? nativeTicks / NOMINAL_STEP_RATE : dt, drill: +drill,
      });
      if (drill) s.drillClock = 0;
    }
  }
  const pending = () => [...states.values()].reduce((n, s) => n + +(s.busy || s.load.busy), 0);
  function toJSON() {
    if (disposed) throw new Error('Industry physics is disposed');
    if (pending()) throw new Error('Industry transfers are pending');
    if (sim && sim !== getSim()) throw new Error('Industry simulation changed before snapshot');
    return validateIndustryPhysics({ version: 1, pumps: [...states.values()]
      .filter(s => s.device.type === 'pump' && s.load.cells.length)
      .map(s => ({ id: s.device.id, device: s.device, cells: s.load.cells })) }, []);
  }
  function fromJSON(data, devices) {
    if (disposed) throw new Error('Industry physics is disposed');
    if (pending()) throw new Error('Industry transfers are pending');
    const next = getSim();
    if (!next) throw new Error('Industry cargo is outside the simulation');
    const saved = validateIndustryPhysics(data, devices, next.g);
    const restored = saved.pumps.map(p => {
      const state = machineState(p.device);
      state.load.cells = p.cells; // canonical validation returned deep-owned data
      return [signature(p.device), state];
    });
    // All validation/allocation precedes mutation. bind only prepares kernels
    // for a replaced sim; it does not edit or clear terrain.
    bind();
    states.clear();
    cursor = 0;
    for (const [key, state] of restored) states.set(key, state);
  }
  bind();
  return {
    get ready() { bind(); return ready; }, step,
    get pending() { return pending(); },
    // Read-only target for the currently inspected intake; mutable alternation
    // state remains private to the native transfer dispatcher.
    expectedShipId(id) {
      const state = [...states.values()].find(s => s.device.type === 'ship' && s.device.id === id);
      if (!state) return E.NUGGETS;
      return state.busy && state.shipTarget !== null ? state.shipTarget : state.metal ? E.METAL : E.NUGGETS;
    },
    get buffered() { return [...states.values()].reduce((n, s) => n + s.load.cells.length, 0); },
    toJSON, fromJSON,
    reset,
    dispose() { reset(); disposed = true; },
  };
}
