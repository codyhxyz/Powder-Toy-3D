import { E } from '../elements.js';
import { prelude, STATE_OPTS, LAYOUT } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { RING_LAYOUT, ringWGSL } from '../shaders/povBody.js';
import { INDUSTRY_LIMIT, deviceCell } from './catalog.js';

// TPT WALL has no life field semantics. Keep this exact f32 integer in A.z;
// ownership always requires both WALL and this marker, never element ID alone.
export const GATE_OWNER_MARKER = 1048573;
export const GATE_APERTURE_CELLS = 12;
export const GATE_RETRY_SECONDS = 0.25;
export const GATE_SIGNAL_POLL_SECONDS = 0.1;
export const GATE_CLOSED_AUDIT_SECONDS = 1;
export const GATE_STATUS = Object.freeze({
  OPEN: 'OPEN', CLOSED: 'CLOSED', BLOCKED: 'BLOCKED', DAMAGED: 'DAMAGED',
});

const MODES = Object.freeze({ open: 0, closed: 1, signal: 2 });
const CODE_STATUS = Object.freeze({ 1: GATE_STATUS.OPEN, 2: GATE_STATUS.CLOSED, 3: GATE_STATUS.BLOCKED, 4: GATE_STATUS.DAMAGED });
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const signature = d => [d.id, d.x, d.y, d.z, d.rotation].join(':');
const inside = (p, g) => p[0] >= 0 && p[0] < g.nx && p[1] >= 0 && p[1] < g.ny && p[2] >= 0 && p[2] < g.nz;

function gridSize(bounds) {
  const g = Array.isArray(bounds) ? { nx: bounds[0], ny: bounds[1], nz: bounds[2] } : bounds;
  if (!record(g) || ![g.nx, g.ny, g.nz].every(n => Number.isInteger(n) && n > 0)) {
    throw new TypeError('Invalid gate simulation bounds');
  }
  return g;
}

/** Rotated 4x4x4 gate geometry: base y=0; 12-cell leaf x=0..3,y=1..3,z=2. */
export function gateGeometry(device, bounds) {
  const g = gridSize(bounds);
  if (!record(device) || device.type !== 'gate' || typeof device.id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(device.id)
      || ![device.x, device.y, device.z, device.rotation].every(Number.isInteger)
      || device.rotation < 0 || device.rotation > 3) throw new TypeError('Invalid gate geometry');
  if (device.x < 0 || device.y < 0 || device.z < 0 || device.x + 4 > g.nx || device.y + 4 > g.ny || device.z + 4 > g.nz) {
    throw new RangeError('Gate must fit inside the simulation');
  }
  const aperture = [];
  for (let y = 1; y <= 3; y++) for (let x = 0; x < 4; x++) aperture.push(deviceCell(device, x, y, 2));
  const base = [];
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) base.push(deviceCell(device, x, 0, z));
  const port = deviceCell(device, -1, 0, 1);
  if (![...base, ...aperture].every(p => inside(p, g)) || !inside(port, g)) {
    throw new RangeError('Gate aperture and native control port must fit inside the simulation');
  }
  const at = deviceCell(device, 0, 1, 2);
  const next = deviceCell(device, 1, 1, 2);
  return { base, aperture, at, across: next.map((n, i) => n - at[i]), port };
}

/** Canonicalize controller fields; newly placed/old-save gates default open. */
export function validateGateDevice(device, bounds) {
  const geometry = gateGeometry(device, bounds);
  const gateMode = device.gateMode === undefined ? 'open' : device.gateMode;
  const gateClosed = device.gateClosed === undefined ? false : device.gateClosed;
  if (!Object.hasOwn(MODES, gateMode) || typeof gateClosed !== 'boolean') throw new TypeError('Invalid gate mode or closure state');
  return { id: device.id, type: 'gate', x: device.x, y: device.y, z: device.z, rotation: device.rotation,
    gateMode, gateClosed, geometry };
}

/** TPT energized-open signal rule at the established Industry control port. */
export function gateRequestsClosed(gateMode, energized = false) {
  if (!Object.hasOwn(MODES, gateMode)) throw new TypeError('Invalid gate mode');
  return gateMode === 'closed' || (gateMode === 'signal' && !energized);
}

/** CPU reference transition table. Aperture entries are owned, empty, or foreign. */
export function resolveGateTransition({ mode = 'open', energized = false, expectedClosed = false, aperture, remove = false }) {
  if (!Array.isArray(aperture) || aperture.length !== GATE_APERTURE_CELLS
      || !aperture.every(v => v === 'owned' || v === 'empty' || v === 'foreign')) throw new TypeError('Invalid gate aperture state');
  if (typeof expectedClosed !== 'boolean') throw new TypeError('Invalid expected gate state');
  if (!remove && !Object.hasOwn(MODES, mode)) throw new TypeError('Invalid gate mode');
  const owned = aperture.filter(v => v === 'owned').length;
  const allOwned = owned === GATE_APERTURE_CELLS;
  const allEmpty = aperture.every(v => v === 'empty');
  if (remove) return { status: GATE_STATUS.OPEN, gateClosed: false, desiredClosed: false, write: 'erase-owned', changed: owned > 0 };
  const desiredClosed = gateRequestsClosed(mode, energized);
  if (desiredClosed) {
    if (allOwned) return { status: GATE_STATUS.CLOSED, gateClosed: true, desiredClosed, write: 'none', changed: false };
    if (owned > 0 || expectedClosed) return { status: GATE_STATUS.DAMAGED, gateClosed: expectedClosed, desiredClosed, write: 'none', changed: false };
    if (allEmpty) return { status: GATE_STATUS.CLOSED, gateClosed: true, desiredClosed, write: 'place-owned', changed: true };
    return { status: GATE_STATUS.BLOCKED, gateClosed: false, desiredClosed, write: 'none', changed: false };
  }
  if (allOwned) return { status: GATE_STATUS.OPEN, gateClosed: false, desiredClosed, write: 'erase-owned', changed: true };
  if (owned > 0 || expectedClosed) return { status: GATE_STATUS.DAMAGED, gateClosed: expectedClosed, desiredClosed, write: 'none', changed: false };
  return { status: GATE_STATUS.OPEN, gateClosed: false, desiredClosed, write: 'none', changed: false };
}

const GateParams = uniformStruct('IndustryGate', {
  at: 'vec3i', across: 'vec3i', port: 'vec3i', gateMode: 'u32', expectedClosed: 'u32', operation: 'u32', slot: 'u32',
});

/** One-invocation preflight-and-write kernel. The leaf is an actuator, never cargo. */
export const gateWGSL = g => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${GateParams.wgsl}
@group(3) @binding(1) var<uniform> P: IndustryGate;
${ringWGSL()}
const INDUSTRY_GATE_OWNER_TAG: f32 = ${GATE_OWNER_MARKER}.0;
const INDUSTRY_GATE_OPEN: u32 = 1u;
const INDUSTRY_GATE_CLOSED: u32 = 2u;
const INDUSTRY_GATE_BLOCKED: u32 = 3u;
const INDUSTRY_GATE_DAMAGED: u32 = 4u;

fn gateOwned(a: vec4f) -> bool { return eid(a) == E_WALL && a.z == INDUSTRY_GATE_OWNER_TAG; }
fn gateSignal(port: vec3i) -> bool {
  if (!inGrid(port)) { return false; }
  let a = fetchA(port);
  let id = eid(a);
  if (id == E_BATTERY) { return true; }
  if (id == E_SWITCH) { return a.z == SWITCH_ON; }
  return sparkLive(id, floor(a.w));
}
fn gateCell(x: i32, y: i32) -> vec3i { return P.at + P.across * x + vec3i(0, y, 0); }
fn markGateNeighbours(p: vec3i) {
  let offsets = array<vec3i, 6>(vec3i(1,0,0), vec3i(-1,0,0), vec3i(0,1,0), vec3i(0,-1,0), vec3i(0,0,1), vec3i(0,0,-1));
  for (var i = 0u; i < 6u; i++) {
    let q = p + offsets[i];
    if (inGrid(q)) { markBrick(brickId(q >> vec3u(2u))); }
  }
}
fn writeGateCell(p: vec3i, close: bool) {
  let a = fetchA(p); let b = fetchB(p);
  var outA = vec4f(f32(E_EMPTY), airT(), 0.0, fract(a.w));
  if (close) { outA = vec4f(f32(E_WALL), a.y, INDUSTRY_GATE_OWNER_TAG, fract(a.w)); }
  if (writeCell(p, a, b, fetchF(p), outA, vec4f(0.0, 0.0, 0.0, b.w))) {
    markBrick(brickId(p >> vec3u(2u)));
    markGateNeighbours(p);
  }
}

@compute @workgroup_size(1)
fn main() {
  var inBounds = true;
  var allEmpty = true;
  var ownedCount = 0;
  for (var y = 0; y < 3; y++) { for (var x = 0; x < 4; x++) {
    let p = gateCell(x, y);
    if (!inGrid(p)) { inBounds = false; }
    else {
      let a = fetchA(p);
      if (gateOwned(a)) { ownedCount++; }
      else if (eid(a) != E_EMPTY) { allEmpty = false; }
    }
  } }

  var status = INDUSTRY_GATE_DAMAGED;
  var physicallyClosed = P.expectedClosed != 0u;
  var changed = false;
  var desiredClosed = false;
  if (P.operation == 1u) {
    if (inBounds) {
      for (var y = 0; y < 3; y++) { for (var x = 0; x < 4; x++) {
        let p = gateCell(x, y);
        let a = fetchA(p);
        if (gateOwned(a)) { writeGateCell(p, false); changed = true; }
      } }
      status = INDUSTRY_GATE_OPEN;
      physicallyClosed = false;
    }
  } else if (inBounds) {
    // TPT's native battery/SWCH/spark signal is energized-open; absent signal closes.
    desiredClosed = P.gateMode == 1u || (P.gateMode == 2u && !gateSignal(P.port));
    if (desiredClosed) {
      if (ownedCount == 12) {
        status = INDUSTRY_GATE_CLOSED;
        physicallyClosed = true;
      } else if (ownedCount > 0 || P.expectedClosed != 0u) {
        status = INDUSTRY_GATE_DAMAGED;
      } else if (allEmpty) {
        for (var y = 0; y < 3; y++) { for (var x = 0; x < 4; x++) { writeGateCell(gateCell(x, y), true); } }
        status = INDUSTRY_GATE_CLOSED;
        physicallyClosed = true;
        changed = true;
      } else {
        status = INDUSTRY_GATE_BLOCKED;
        physicallyClosed = false;
      }
    } else {
      if (ownedCount == 12) {
        for (var y = 0; y < 3; y++) { for (var x = 0; x < 4; x++) { writeGateCell(gateCell(x, y), false); } }
        status = INDUSTRY_GATE_OPEN;
        physicallyClosed = false;
        changed = true;
      } else if (ownedCount > 0 || P.expectedClosed != 0u) {
        status = INDUSTRY_GATE_DAMAGED;
      } else {
        status = INDUSTRY_GATE_OPEN;
        physicallyClosed = false;
      }
    }
  }
  ringOut[P.slot] = vec4f(f32(status), f32(physicallyClosed), select(0.0, 1.0, changed), select(0.0, 1.0, desiredClosed));
}`;

export const WGSL_CHECK = [{ name: 'industryGate', kind: 'compute', code: gateWGSL,
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, RING_LAYOUT], dispatch: () => [1, 1, 1] }];

function decodeResult(bytes, operation, id, mode = null) {
  const [code, closed, changed, desired] = new Float32Array(bytes, 0, 4);
  const status = CODE_STATUS[Math.trunc(code)] ?? GATE_STATUS.DAMAGED;
  return { id, status, gateClosed: !!closed, desiredClosed: !!desired, changed: !!changed,
    ...(operation === 'remove' ? { removed: true } : {}), ...(mode ? { gateMode: mode } : {}) };
}

/**
 * Owns only tagged WALL cells at each registered gate's rotated aperture.
 * Call step beside native simulation advancement. Save/removal must wait until
 * pending is zero; dismantle must await remove(device) before dropping device state.
 */
export function createGatePhysics({ getSim, onError = console.error, onState = () => {} }) {
  if (typeof getSim !== 'function') throw new TypeError('createGatePhysics requires getSim');
  let sim = null, context = null, epoch = 0, disposed = false, cursor = 0;
  let transactionQueue = Promise.resolve(), pendingCount = 0, removeReservations = 0;
  const states = new Map();

  function reportError(error) { try { onError?.(error); } catch {} }
  function invalidate() {
    epoch++;
    states.clear();
    sim = null; context = null; cursor = 0;
  }
  function bind() {
    if (disposed) return;
    let next;
    try { next = getSim(); } catch (error) { reportError(error); return; }
    if (next === sim) return;
    invalidate();
    if (!next || next.disposed) return;
    try {
      const gpu = next.gpu, layout = gpu.layout('industry gate result', RING_LAYOUT);
      const ring = gpu.readback.ring('industry gate', 16, 16);
      const group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: ring.buffer } }], 'industry gate result');
      const kernel = gpu.kernel({ name: 'industryGate', code: gateWGSL(next.g), params: GateParams,
        layouts: [next.L.TABLES, next.L.STATE_RW, layout], workgroupSize: [1, 1, 1] });
      const generation = epoch;
      const ready = kernel.ready;
      ready.catch(err => { if (generation === epoch && !disposed) reportError(err); });
      sim = next;
      context = { sim: next, gpu, ring, group, kernel, ready, generation };
    } catch (error) {
      reportError(error);
      sim = null; context = null;
    }
  }
  const isCurrent = ctx => !disposed && ctx.generation === epoch && ctx.sim === sim && ctx === context
    && !ctx.sim.disposed && getSim() === ctx.sim;
  function enqueue(task) {
    const job = transactionQueue.then(task, task);
    transactionQueue = job.catch(() => {});
    return job;
  }
  function dispatch(ctx, d, operation = 'step') {
    const geom = d.geometry;
    const slot = ctx.ring.next();
    ctx.sim._dispatch(ctx.kernel, [1, 1, 1], { bind: [ctx.sim.tables, ctx.sim.bindRW, ctx.group], header: ctx.sim.header(),
      params: { at: geom.at, across: geom.across, port: geom.port,
        gateMode: operation === 'remove' ? 0 : MODES[d.gateMode], expectedClosed: +(operation === 'remove' ? false : d.gateClosed),
        operation: +(operation === 'remove'), slot } });
    const result = ctx.ring.read(slot);
    ctx.gpu.flush('industry gate');
    return result;
  }
  function publish(state, result, ctx) {
    if (!isCurrent(ctx) || states.get(state.device.id) !== state || !state.active || state.removing || state.signature !== signature(state.device)) return;
    const previous = state.result;
    state.result = result;
    if (result.status === GATE_STATUS.DAMAGED) state.damaged = true;
    if (!previous || previous.status !== result.status || previous.gateClosed !== result.gateClosed || result.changed) {
      try { onState(state.device.id, { ...result }); } catch (error) { reportError(error); }
    }
  }
  function schedule(state, device, ctx) {
    if (state.busy || state.removing || state.damaged) return;
    state.busy = true;
    state.force = false;
    state.clock = 0;
    pendingCount++;
    const job = enqueue(async () => {
      try {
        await ctx.ready;
        if (!isCurrent(ctx) || states.get(state.device.id) !== state || state.removing || !state.active) return null;
        const bytes = await dispatch(ctx, device);
        if (!isCurrent(ctx) || states.get(state.device.id) !== state || state.removing || !state.active) return null;
        const result = decodeResult(bytes, 'step', device.id, device.gateMode);
        if (result.changed) {
          ctx.sim.version++;
          ctx.sim.wake();
        }
        return result;
      } catch (error) {
        reportError(error);
        return null;
      }
    });
    state.job = job;
    job.then(result => { if (result) publish(state, result, ctx); })
      .catch(reportError)
      .finally(() => {
        state.busy = false;
        pendingCount--;
      });
  }

  function step(dt, devices) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    bind();
    const ctx = context;
    if (!ctx || ctx.sim.disposed) return;
    const gates = [], seen = new Set();
    for (const raw of (Array.isArray(devices) ? devices : []).slice(0, INDUSTRY_LIMIT)) {
      if (raw?.type !== 'gate') continue;
      try {
        const d = validateGateDevice(raw, ctx.sim.g);
        if (seen.has(d.id)) throw new TypeError('Duplicate gate id');
        seen.add(d.id);
        gates.push(d);
      } catch (error) { reportError(error); }
    }
    for (const [id, state] of states) if (!seen.has(id) && !state.removing) state.active = false;
    for (const d of gates) {
      let state = states.get(d.id);
      if (state && state.signature !== signature(d)) {
        // Geometry identity changed: fence callbacks; only explicit remove may erase the old shutter.
        state.active = false;
        continue;
      }
      if (!state) {
        state = { device: d, signature: signature(d), active: true, busy: false, removing: false,
          result: null, damaged: false, clock: 0, force: true, lastMode: d.gateMode, lastExpected: d.gateClosed, job: null };
        states.set(d.id, state);
      } else {
        if (state.lastMode !== d.gateMode || state.lastExpected !== d.gateClosed) state.force = true;
        state.lastMode = d.gateMode; state.lastExpected = d.gateClosed;
        state.device = d; state.active = true;
      }
      state.clock += Math.min(dt, 0.1);
    }
    if (pendingCount + removeReservations > 0) return;
    const candidates = gates.map(d => states.get(d.id)).filter(state => {
      if (!state || !state.active || state.busy || state.removing || state.damaged) return false;
      if (state.force || !state.result) return true;
      if (state.device.gateMode === 'signal') return state.clock >= GATE_SIGNAL_POLL_SECONDS;
      if (state.result.status === GATE_STATUS.BLOCKED) return state.clock >= GATE_RETRY_SECONDS;
      if (state.device.gateMode === 'closed' && state.result.status === GATE_STATUS.CLOSED) return state.clock >= GATE_CLOSED_AUDIT_SECONDS;
      return false;
    });
    if (candidates.length) {
      const state = candidates[cursor++ % candidates.length];
      schedule(state, state.device, ctx);
    }
  }

  function remove(device) {
    if (disposed) return Promise.resolve({ ok: false, status: GATE_STATUS.DAMAGED, reason: 'Gate physics is disposed' });
    bind();
    const ctx = context;
    if (!ctx) return Promise.resolve({ ok: false, status: GATE_STATUS.DAMAGED, reason: 'No active simulation' });
    let d;
    try {
      const geometry = gateGeometry(device, ctx.sim.g);
      d = { id: device.id, type: 'gate', x: device.x, y: device.y, z: device.z, rotation: device.rotation,
        gateMode: 'open', gateClosed: false, geometry };
    } catch (error) { return Promise.resolve({ ok: false, status: GATE_STATUS.DAMAGED, reason: error.message }); }
    let state = states.get(d.id);
    if (state && state.signature !== signature(d)) {
      return Promise.resolve({ ok: false, id: d.id, status: GATE_STATUS.DAMAGED, reason: 'Gate identity does not match its active geometry' });
    }
    if (!state) {
      state = { device: d, signature: signature(d), active: false, busy: false, removing: false,
        result: null, damaged: false, clock: 0, force: false, lastMode: d.gateMode, lastExpected: d.gateClosed, job: null };
      states.set(d.id, state);
    }
    if (state.removal) return state.removal;
    state.removing = true; state.active = false;
    removeReservations++;
    const prior = state.job ?? Promise.resolve();
    const removal = prior.catch(() => {}).then(() => enqueue(async () => {
      try {
        await ctx.ready;
        if (!isCurrent(ctx)) return { ok: false, id: d.id, status: GATE_STATUS.DAMAGED, reason: 'Simulation changed before gate removal' };
        const bytes = await dispatch(ctx, d, 'remove');
        if (!isCurrent(ctx)) return { ok: false, id: d.id, status: GATE_STATUS.DAMAGED, reason: 'Simulation changed during gate removal' };
        const result = decodeResult(bytes, 'remove', d.id);
        if (result.changed) { ctx.sim.version++; ctx.sim.wake(); }
        return { ok: true, ...result };
      } catch (error) {
        reportError(error);
        return { ok: false, id: d.id, status: GATE_STATUS.DAMAGED, reason: error?.message ?? 'Gate removal failed' };
      }
    })).finally(() => {
      removeReservations--;
      if (states.get(d.id) === state) states.delete(d.id);
    });
    state.removal = removal;
    return removal;
  }

  bind();
  return {
    get ready() { bind(); return context?.ready ?? Promise.resolve(); },
    step,
    remove,
    get pending() { return pendingCount + removeReservations; },
    status(id) { const value = states.get(id)?.result; return value ? { ...value } : null; },
    reset() { if (!disposed) invalidate(); },
    dispose() { if (disposed) return; disposed = true; invalidate(); },
  };
}
