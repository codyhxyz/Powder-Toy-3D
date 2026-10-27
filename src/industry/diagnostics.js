import { E, K, ELEMENTS } from '../elements.js';
import {
  DEVICE_TYPES, FILTER_IDS, CASTING_TEMPERATURE, baseMaterial, deviceCell, deviceDirection,
} from './catalog.js';
import { controlCell, machineGuard, machinePorts, validMachine } from './physics.js';
import { hearthRegions, HEARTH_FUEL_IDS } from './hearth.js';
import {
  INDUSTRY_DIAGNOSTICS, INDUSTRY_DIAGNOSTICS_LAYOUT, IndustryDiagnosticsParams, industryDiagnosticsWGSL,
} from '../shaders/industryDiagnostics.js';

const RESULT_BYTES = INDUSTRY_DIAGNOSTICS.RESULT_VECS * 16;
const MAX_BASE_CELLS = INDUSTRY_DIAGNOSTICS.MAX_BASE_CELLS;
const MAX_SAMPLES = INDUSTRY_DIAGNOSTICS.MAX_SAMPLES;
const MAX_REGIONS = INDUSTRY_DIAGNOSTICS.MAX_REGIONS;
const MAX_TEMP = 1e30;
const RULE_SUPPORT = 1;
const RULE_BREAKABLE_CLEAR = 2;
const RULE_TEMP_EXCLUSIVE = 4;
const RULE_POSITIVE_LIFE = 8;
const RULE_TEMP_EXEMPT_IDS = 16;
const UNKNOWN = 'unknown';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const vec3i = value => Array.isArray(value) && value.length === 3 && value.every(Number.isInteger);
const inGrid = (p, g) => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < g.nx && p[1] < g.ny && p[2] < g.nz;
const regionCells = (d, x0, x1, y0, y1, z0, z1) => {
  const out = [];
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(deviceCell(d, x, y, z));
  return out;
};
const bitKinds = kinds => kinds.reduce((mask, kind) => mask | (1 << kind), 0);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const stable = value => JSON.stringify(canonical(value));
const clone = value => value == null ? value : structuredClone(value);

/** The identity includes every setting which changes Industry's guard or routing. */
export function industryDiagnosticSignature(device) {
  if (!device || typeof device.id !== 'string') return '';
  return stable({
    id: device.id, type: device.type, x: device.x, y: device.y, z: device.z,
    rotation: device.rotation, filter: device.filter ?? null, powered: !!device.powered,
    ...(device.type === 'gate' ? { gateMode: device.gateMode ?? 'open' } : {}),
  });
}

/** Pure status reduction; `ready` describes current eligible matter, not throughput. */
export function industryDiagnosticStatus({ base, control, regions = {}, policy } = {}) {
  if (!base?.configured || !base.complete) return UNKNOWN;
  if (!base.intact) return 'base damaged';
  if (control?.required && control.active === false) return 'control off';
  if (control?.required && control.active !== true) return UNKNOWN;
  if (!policy || !Array.isArray(policy.primaryRegions) || !policy.primaryRegions.length) return UNKNOWN;
  if (policy.blockedRegion) {
    const outlet = regions[policy.blockedRegion];
    if (!outlet || outlet.complete === false || outlet.sampled <= 0) return UNKNOWN;
    if (outlet.available === 0) return 'outlet occupied';
  }
  let eligible = 0;
  for (const name of policy.primaryRegions) {
    const region = regions[name];
    if (!region || region.complete === false) return UNKNOWN;
    eligible += region.eligible;
  }
  if (!eligible) return 'empty inlet';
  if (policy.requireExactInput && !policy.exactInputKnown) return UNKNOWN;
  return 'ready';
}

/** A terse UI projection which explicitly avoids presenting readiness as running. */
export function presentIndustryDiagnostic(snapshot) {
  const labels = {
    ready: 'Ready — transfer not confirmed',
    'empty inlet': 'No eligible input observed',
    'outlet occupied': 'Outlet has no open cells',
    'control off': 'Powered control is inactive',
    'base damaged': 'Base is damaged',
    pending: 'Observation pending',
    unknown: 'Status unknown',
  };
  return {
    status: snapshot?.status ?? UNKNOWN,
    freshness: snapshot?.freshness ?? UNKNOWN,
    label: labels[snapshot?.status] ?? labels[UNKNOWN],
    running: snapshot?.running ?? 'unconfirmed',
    pending: !!snapshot?.pending,
  };
}

function defaultBase(device, overrides) {
  const supplied = overrides.base;
  const material = record(supplied) && supplied.material !== undefined ? supplied.material
    : overrides.baseMaterial !== undefined ? overrides.baseMaterial
      : device.type === 'hearth' ? E.TUNGSTEN
          : Object.hasOwn(DEVICE_TYPES, device.type) ? baseMaterial(device.type) : null;
  const cells = record(supplied) && supplied.cells !== undefined ? supplied.cells
    : regionCells(device, 0, 3, 0, 0, 0, 3);
  return { material, cells };
}

function defaultRegions(device, overrides) {
  const regions = {};
  const add = (name, cells, rule = {}) => { regions[name] = { cells, ...rule }; };
  if (Object.hasOwn(DEVICE_TYPES, device.type) && device.type !== 'foundation') {
    if (device.type === 'pump') {
      const ports = machinePorts(device);
      add('inlet', ports.inlet, { kinds: [K.LIQUID] });
      add('outlet', ports.outlet);
    } else if (device.type === 'ship') {
      const expected = overrides.expectedShipId;
      const knownId = expected === E.NUGGETS || expected === E.METAL;
      add('inlet', machinePorts(device).mouth, knownId
        ? { kinds: [ELEMENTS[expected].kind], ids: [expected], maxTemperature: expected === E.METAL ? CASTING_TEMPERATURE : MAX_TEMP }
        : { kinds: [K.POWDER, K.SOLID], ids: [E.NUGGETS, E.METAL], maxTemperatures: [MAX_TEMP, CASTING_TEMPERATURE] });
    } else if (['belt', 'separator', 'lift'].includes(device.type)) {
      const cells = regionCells(device, 0, 3, 1, 1, 0, 3);
      add('work', cells, { kinds: [K.POWDER], requiresSupport: true });
      if (device.type === 'separator') {
        const selected = FILTER_IDS.includes(device.filter) ? device.filter : E.NUGGETS;
        add('selectedRoute', cells, { kinds: [K.POWDER], ids: [selected], requiresSupport: true });
        add('otherRoute', cells, { kinds: [K.POWDER], excludeId: selected, requiresSupport: true });
      }
    } else if (device.type === 'miner') {
      const work = regionCells(device, 0, 3, 1, 1, 0, 3);
      const targets = regionCells(device, 0, 3, 1, 3, 4, 7);
      add('work', work, { kinds: [K.POWDER], requiresSupport: true });
      add('target', targets, { kinds: [K.SOLID], breakableClear: true });
    } else if (device.type === 'hearth') {
      const cells = hearthRegions(device);
      add('fuel', cells.firebox, { ids: HEARTH_FUEL_IDS, requiresPositiveLife: true });
      add('charge', cells.charge);
      add('outlet', cells.outlet);
    } else if (device.type === 'heater') {
      // Like TPT's heat tool, heating stops at its cap; the legacy heater still
      // guides already-molten lava forward, so hot lava remains eligible here.
      add('work', regionCells(device, 0, 3, 1, 3, 0, 3), {
        maxTemperature: 2200, exclusiveTemperature: true, temperatureExemptIds: [E.LAVA],
      });
    }
  }
  if (record(overrides.regions)) {
    for (const [name, spec] of Object.entries(overrides.regions)) regions[name] = spec;
  }
  return regions;
}

function defaultGuard(device, overrides) {
  if (Object.hasOwn(overrides, 'guard')) return overrides.guard;
  if (device.type === 'gate') return { ...machineGuard(device), powered: device.gateMode === 'signal' };
  if (device.type === 'hearth') return {
    base: [device.x, device.y, device.z], material: E.TUNGSTEN,
    port: controlCell(device), powered: !!device.powered,
  };
  if (Object.hasOwn(DEVICE_TYPES, device.type) && device.type !== 'foundation') return machineGuard(device);
  return null;
}

function normalizeRequest(device, overrides, sim) {
  const g = sim?.g;
  if (!record(device) || typeof device.id !== 'string' || !device.id || typeof device.type !== 'string'
      || ![device.x, device.y, device.z, device.rotation].every(Number.isInteger)
      || device.rotation < 0 || device.rotation > 3 || !g) return { error: 'invalid device' };
  const known = Object.hasOwn(DEVICE_TYPES, device.type), customGeometry = ['hearth', 'gate'].includes(device.type);
  if (device.type === 'ship' && overrides.expectedShipId !== undefined
      && overrides.expectedShipId !== E.NUGGETS && overrides.expectedShipId !== E.METAL) {
    return { error: 'ship target must be a physics-confirmed nugget or cooled-metal cycle' };
  }
  if (!customGeometry && known) {
    if (device.type === 'foundation' || !validMachine(device, g)) return { error: 'not an inspectable machine in this simulation' };
  } else if (!customGeometry && !overrides.base && !overrides.regions) {
    return { error: 'unknown machine type requires explicit diagnostic overrides' };
  } else if (device.type === 'gate'
      ? device.x < 0 || device.y < 0 || device.z < 0 || device.x >= g.nx || device.y >= g.ny || device.z >= g.nz
      : device.x < 0 || device.y < 0 || device.z < 0 || device.x + 4 > g.nx || device.y + 4 > g.ny || device.z + 4 > g.nz) {
    return { error: 'device is outside the simulation' };
  }

  const base = defaultBase(device, overrides);
  const baseConfigured = Number.isInteger(base.material) && base.material > 0 && base.material < ELEMENTS.length
    && Array.isArray(base.cells) && base.cells.length > 0 && base.cells.length <= MAX_BASE_CELLS
    && base.cells.every(vec3i);
  if (base.cells && (!Array.isArray(base.cells) || base.cells.length > MAX_BASE_CELLS || base.cells.some(p => !vec3i(p)))) {
    return { error: 'invalid base observation geometry' };
  }
  const baseInBounds = baseConfigured && base.cells.every(p => inGrid(p, g));
  const regions = defaultRegions(device, overrides);
  const names = Object.keys(regions);
  if (names.length > MAX_REGIONS) return { error: `at most ${MAX_REGIONS} observed regions are supported` };
  const entries = [];
  const regionInfo = {};
  for (const [index, name] of names.entries()) {
    const spec = regions[name];
    if (!record(spec) || !Array.isArray(spec.cells) || !spec.cells.length || spec.cells.length > MAX_SAMPLES
        || spec.cells.some(p => !vec3i(p))) return { error: `invalid or unbounded ${name} region` };
    const uniq = new Map(spec.cells.map(p => [p.join(','), p]));
    const cells = [...uniq.values()];
    const inside = cells.filter(p => inGrid(p, g));
    const kinds = spec.kinds ?? [];
    const ids = spec.ids ?? [];
    const temperatureExemptIds = spec.temperatureExemptIds ?? [];
    const maxTemperatures = spec.maxTemperatures ?? [];
    if (!Array.isArray(kinds) || kinds.some(k => !Number.isInteger(k) || k < K.EMPTY || k > K.GAS)
        || !Array.isArray(ids) || ids.length > 2 || ids.some(id => !Number.isInteger(id) || id < 0 || id >= ELEMENTS.length)
        || !Array.isArray(temperatureExemptIds) || temperatureExemptIds.length > 2
        || temperatureExemptIds.some(id => !Number.isInteger(id) || id < 0 || id >= ELEMENTS.length)
        || (temperatureExemptIds.length > 0 && ids.length > 0)
        || !Array.isArray(maxTemperatures) || (maxTemperatures.length && maxTemperatures.length !== ids.length)
        || maxTemperatures.some(t => !Number.isFinite(t) || !Number.isFinite(Math.fround(t)))
        || (spec.maxTemperature !== undefined && (!Number.isFinite(spec.maxTemperature) || !Number.isFinite(Math.fround(spec.maxTemperature))))
        || (spec.excludeId !== undefined && (!Number.isInteger(spec.excludeId) || spec.excludeId < 0 || spec.excludeId >= ELEMENTS.length))
        || ['requiresSupport', 'breakableClear', 'exclusiveTemperature', 'requiresPositiveLife'].some(key => spec[key] !== undefined && typeof spec[key] !== 'boolean')) {
      return { error: `invalid ${name} eligibility rule` };
    }
    const maxAny = spec.maxTemperature ?? MAX_TEMP;
    const ruleIds = temperatureExemptIds.length ? temperatureExemptIds : ids;
    const max0 = temperatureExemptIds.length ? MAX_TEMP : ids.length ? (maxTemperatures[0] ?? maxAny) : maxAny;
    const max1 = temperatureExemptIds.length ? MAX_TEMP : ids.length > 1 ? (maxTemperatures[1] ?? maxAny) : maxAny;
    const flags = (spec.requiresSupport ? RULE_SUPPORT : 0) | (spec.breakableClear ? RULE_BREAKABLE_CLEAR : 0)
      | (spec.exclusiveTemperature ? RULE_TEMP_EXCLUSIVE : 0)
      | (spec.requiresPositiveLife ? RULE_POSITIVE_LIFE : 0)
      | (temperatureExemptIds.length ? RULE_TEMP_EXEMPT_IDS : 0);
    entries.push({
      cells: inside,
      rule: [bitKinds(kinds), ruleIds[0] ?? -1, ruleIds[1] ?? -1, spec.excludeId ?? -1],
      limits: [max0, max1, maxAny, flags],
    });
    regionInfo[name] = { requested: cells.length, sampled: inside.length, clipped: cells.length - inside.length };
  }
  const sampleCount = entries.reduce((n, e) => n + e.cells.length, 0);
  if (sampleCount > MAX_SAMPLES) return { error: `observation exceeds ${MAX_SAMPLES} bounded region cells` };
  const guard = defaultGuard(device, overrides);
  if (guard && (!record(guard) || !vec3i(guard.base) || !Number.isInteger(guard.material)
      || !vec3i(guard.port) || typeof guard.powered !== 'boolean')) return { error: 'invalid native machine guard' };
  const policy = overrides.statusPolicy ?? (device.type === 'pump'
    ? { primaryRegions: ['inlet'], blockedRegion: 'outlet' }
    : device.type === 'ship'
      ? { primaryRegions: ['inlet'], requireExactInput: true, exactInputKnown: Number.isInteger(overrides.expectedShipId) }
      : ['belt', 'separator', 'lift'].includes(device.type) ? { primaryRegions: ['work'] }
        : device.type === 'miner' ? { primaryRegions: ['work', 'target'] }
          : device.type === 'heater' ? { primaryRegions: ['work'] }
            : device.type === 'hearth' ? { primaryRegions: ['fuel'], blockedRegion: 'outlet' } : null);
  if (policy !== null && (!record(policy) || !Array.isArray(policy.primaryRegions)
      || policy.primaryRegions.some(name => typeof name !== 'string')
      || (policy.blockedRegion !== undefined && typeof policy.blockedRegion !== 'string'))) return { error: 'invalid status policy' };
  const baseCells = baseConfigured && baseInBounds ? base.cells.map(p => [...p, 0]) : [];
  const samples = [], rules = [], limits = [];
  for (const [index, entry] of entries.entries()) {
    rules.push(entry.rule); limits.push(entry.limits);
    for (const p of entry.cells) samples.push([...p, index]);
  }
  const forward = deviceDirection(device), right = [forward[2], 0, -forward[0]];
  const guardFields = guard ?? { base: [0, 0, 0], material: -1, port: [0, 0, 0], powered: false };
  const deviceSignature = industryDiagnosticSignature(device);
  const key = stable({
    device: deviceSignature, base: baseConfigured ? { material: base.material, cells: base.cells } : null,
    guard: guard ?? null, regions: names.map((name, i) => [name, regions[name], entries[i].cells]), policy,
  });
  return {
    device: { id: device.id, type: device.type, x: device.x, y: device.y, z: device.z, rotation: device.rotation,
      filter: device.filter ?? null, powered: !!device.powered,
      ...(device.type === 'gate' ? { gateMode: device.gateMode ?? 'open' } : {}) },
    deviceSignature, key, base: { configured: baseConfigured, material: base.material, cells: base.cells,
      expected: base.cells?.length ?? 0, complete: baseConfigured && baseInBounds },
    names, regionInfo, entries, rules, limits, samples, policy, guard: guard ? { ...guardFields } : null,
    guardFields: { guardBase: guardFields.base, guardMaterial: guardFields.material, guardPort: guardFields.port,
      guardPowered: guardFields.powered ? 1 : 0, guardEnabled: guard ? 1 : 0 },
    corner: deviceCell(device, 0, 0, 0), forward, right,
  };
}

function packParams(request, slot) {
  const baseCells = request.base.configured && request.base.complete
    ? request.base.cells.map(p => [...p, 0]) : [];
  return {
    ...request.guardFields,
    baseMaterial: request.base.configured ? request.base.material : -1,
    baseCount: baseCells.length, sampleCount: request.samples.length, slot,
    baseCells: [...baseCells, ...Array.from({ length: MAX_BASE_CELLS - baseCells.length }, () => [0, 0, 0, 0])],
    samples: [...request.samples, ...Array.from({ length: MAX_SAMPLES - request.samples.length }, () => [0, 0, 0, 0])],
    rules: [...request.rules, ...Array.from({ length: MAX_REGIONS - request.rules.length }, () => [0, -1, -1, -1])],
    limits: [...request.limits, ...Array.from({ length: MAX_REGIONS - request.limits.length }, () => [MAX_TEMP, MAX_TEMP, MAX_TEMP, 0])],
    corner: request.corner, forward: request.forward, right: request.right,
  };
}

function decode(request, bytes, startedAt, completedAt) {
  const f = bytes instanceof ArrayBuffer ? new Float32Array(bytes) : new Float32Array(bytes.buffer, bytes.byteOffset ?? 0, Math.floor(bytes.byteLength / 4));
  if (f.length < INDUSTRY_DIAGNOSTICS.RESULT_VECS * 4) throw new Error('Industry diagnostics returned a short observation');
  const meta = f.subarray(0, 4);
  const baseMatched = Math.round(meta[0]), baseExpected = request.base.configured ? request.base.expected : 0;
  const controlRequired = meta[3] > 0;
  const regions = {};
  request.names.forEach((name, index) => {
    const v = f.subarray((index + 1) * 4, (index + 2) * 4);
    const source = request.regionInfo[name];
    const occupied = Math.round(v[0]), eligible = Math.round(v[1]);
    regions[name] = {
      cells: source.requested, sampled: source.sampled, clipped: source.clipped,
      occupied, eligible, available: Math.max(0, source.sampled - occupied),
      complete: source.clipped === 0,
      meanTemperatureC: occupied ? v[2] / occupied : null,
      maxTemperatureC: occupied ? v[3] : null,
    };
  });
  const base = {
    configured: request.base.configured, expected: baseExpected, matched: baseMatched,
    complete: request.base.complete,
    intact: request.base.configured && request.base.complete && baseMatched === baseExpected,
    material: request.base.material,
  };
  const v = f.subarray((1 + MAX_REGIONS) * 4, (2 + MAX_REGIONS) * 4);
  const sample = request.guard && [...v].every(Number.isFinite)
    && Number.isInteger(v[0]) && v[0] >= 0 && v[0] < ELEMENTS.length
    && Number.isSafeInteger(v[3]) && v[3] >= 0
    ? { material: v[0], temperatureC: v[1], life: v[2], ctype: v[3] } : null;
  const control = {
    required: controlRequired,
    active: request.guard ? meta[2] > 0 : null,
    port: request.guard?.port ?? null,
    sample,
  };
  const status = industryDiagnosticStatus({ base, control, regions, policy: request.policy });
  return {
    id: request.device.id, type: request.device.type, identity: clone(request.device), signature: request.deviceSignature,
    status, freshness: 'fresh', pending: false, reason: status === UNKNOWN ? 'insufficient confirmed observation or status policy' : null,
    sampledAt: startedAt, completedAt, running: 'unconfirmed',
    evidence: { base, control, regions },
  };
}

function lifecycleSnapshot(identity, { status = UNKNOWN, freshness = UNKNOWN, reason = 'not sampled', pending = false } = {}) {
  return {
    id: identity?.id ?? null, type: identity?.type ?? null,
    identity: identity ? clone(identity) : null, signature: identity ? industryDiagnosticSignature(identity) : '',
    status, freshness, pending, reason, sampledAt: null, completedAt: null,
    running: 'unconfirmed', transferHistory: null, confirmed: null, evidence: null,
  };
}

function withFreshness(cached, now, staleMs, pending = false) {
  const out = clone(cached);
  const age = Math.max(0, now - cached.sampledAt);
  out.freshness = age > staleMs ? 'stale' : 'fresh';
  out.pending = pending;
  return out;
}

/**
 * Targeted, read-only Industry observation. The shader samples only the selected
 * device's base, native control port, and named machine regions (never the grid).
 * `inspect(device, overrides)` accepts explicit `base`, `guard`, `regions`, and
 * `statusPolicy` for new machines. Region rules accept `kinds`, up to two `ids`,
 * optional `maxTemperature`/`maxTemperatures`, `temperatureExemptIds`, `excludeId`,
 * `requiresSupport`, `requiresPositiveLife`, and `breakableClear`; cells are
 * absolute [x,y,z] coordinates from the owning hearth/gate geometry helper.
 * Hearth regions use the shared physical geometry by default. Fuel eligibility
 * requires positive remaining life. Region results include observed temperatures.
 *
 * Standard port/transport regions mirror industry physics and its WGSL. Ship's
 * alternating nugget/metal target is private: until the parent supplies the
 * actual `expectedShipId` from physics, an occupied mouth remains `unknown`.
 * `recordTransfer` and `recordConfirmation` accept only caller-marked confirmed
 * outcomes, so a ready terrain sample is never described as throughput.
 */
export function createIndustryDiagnostics({ getSim, throttleMs = 250, staleMs = 1000, now = () => Date.now(), onError = () => {} } = {}) {
  if (typeof getSim !== 'function') throw new TypeError('Industry diagnostics requires getSim');
  throttleMs = Math.max(100, Number.isFinite(throttleMs) ? throttleMs : 250);
  staleMs = Math.max(throttleMs, Number.isFinite(staleMs) ? staleMs : 1000);
  let sim = null, kernelState = null, active = null, generation = 0, disposed = false;
  const cache = new Map(), latestById = new Map(), invalidatedById = new Map(), transfers = new Map(), confirmations = new Map();
  const boundedSet = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > 128) map.delete(map.keys().next().value);
  };

  function rememberInvalidated(reason) {
    for (const [id, request] of latestById) boundedSet(invalidatedById, id, { signature: request.deviceSignature, reason });
  }
  let simDisposed = false;
  function invalidateForSimulation(next) {
    const nextDisposed = !!next?.disposed;
    if (next === sim && nextDisposed === simDisposed) return;
    rememberInvalidated(nextDisposed ? 'simulation disposed; old observation invalidated' : 'simulation changed; old observation invalidated');
    generation++;
    if (active) active.cancelled = true;
    sim = next;
    simDisposed = nextDisposed;
    kernelState = null;
    cache.clear(); latestById.clear(); transfers.clear(); confirmations.clear();
  }
  function currentSim() {
    let next = null;
    try { next = getSim() ?? null; } catch { /* a missing world is unknown, not a probe failure */ }
    invalidateForSimulation(next);
    return next;
  }
  function prepare(bound) {
    if (!bound || bound.disposed || !bound.gpu) throw new Error('Industry simulation is unavailable');
    if (kernelState?.sim === bound) return kernelState;
    const gpu = bound.gpu;
    const layout = gpu.layout('industry diagnostics result', INDUSTRY_DIAGNOSTICS_LAYOUT);
    const ring = gpu.readback.ring('industry diagnostics', RESULT_BYTES, 4);
    const group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: ring.buffer } }], 'industry diagnostics result');
    const kernel = gpu.kernel({ name: 'industryDiagnostics', code: industryDiagnosticsWGSL(bound.g),
      layouts: [bound.L.TABLES, bound.L.STATE_RO, layout], params: IndustryDiagnosticsParams, workgroupSize: [1, 1, 1] });
    kernelState = { sim: bound, ring, group, kernel, ready: Promise.resolve(kernel.ready) };
    kernelState.ready.catch(() => {});
    return kernelState;
  }
  function attachEvidence(snapshot) {
    const key = snapshot.signature;
    const transfer = transfers.get(key) ?? null;
    const confirmed = confirmations.get(key) ?? null;
    return { ...snapshot, running: transfer ? 'confirmed-transfer-observed' : 'unconfirmed',
      transferHistory: clone(transfer), confirmed: clone(confirmed) };
  }
  function unknownFor(request, reason, freshness = UNKNOWN, pending = false) {
    const out = lifecycleSnapshot(request?.device, { reason, freshness, pending, status: pending ? 'pending' : UNKNOWN });
    if (request) {
      out.signature = request.deviceSignature;
      return attachEvidence(out);
    }
    return out;
  }
  function snapshot(device) {
    if (disposed) return lifecycleSnapshot(device, { reason: 'diagnostics disposed' });
    currentSim();
    const identity = device && { id: device.id, type: device.type, x: device.x, y: device.y, z: device.z,
      rotation: device.rotation, filter: device.filter ?? null, powered: !!device.powered,
      ...(device.type === 'gate' ? { gateMode: device.gateMode ?? 'open' } : {}) };
    if (!identity || typeof identity.id !== 'string') return lifecycleSnapshot(null, { reason: 'invalid device identity' });
    const signature = industryDiagnosticSignature(identity);
    const latest = latestById.get(identity.id);
    if (!latest) {
      const invalidated = invalidatedById.get(identity.id);
      if (invalidated) return attachEvidence(lifecycleSnapshot(identity, {
        reason: invalidated.signature === signature ? invalidated.reason : 'device identity changed after invalidation', freshness: 'stale',
      }));
      return attachEvidence(lifecycleSnapshot(identity, { reason: 'not sampled' }));
    }
    if (latest.deviceSignature !== signature) {
      if (active?.deviceId === identity.id) active.cancelled = true;
      return attachEvidence(lifecycleSnapshot(identity, { reason: 'device identity changed; old observation invalidated', freshness: 'stale' }));
    }
    const cached = cache.get(latest.key);
    if (cached) return attachEvidence(withFreshness(cached, now(), staleMs, active?.key === latest.key));
    if (active?.key === latest.key) return unknownFor(latest, 'observation pending', 'pending', true);
    if (active) return unknownFor(latest, 'another inspected machine is pending', 'pending', true);
    return unknownFor(latest, 'observation unavailable', UNKNOWN);
  }

  function ownsRequest(job) {
    const latest = latestById.get(job.deviceId);
    return active === job && !job.cancelled && job.generation === generation
      && latest?.key === job.key && latest.deviceSignature === job.deviceSignature;
  }

  async function run(request, job) {
    try {
      const prepared = prepare(job.sim);
      await prepared.ready;
      if (disposed || job.cancelled || job.generation !== generation || getSim() !== job.sim || job.sim.disposed) {
        return unknownFor(request, 'stale observation discarded', 'stale');
      }
      // V2: read the canonical native core as physical readers do (format 3), never the
      // legacy-format header over compact words. V1's header and group are unchanged.
      const native = !!job.sim.compact;
      const state = native ? job.sim.bindPhysicalRO : job.sim.bindRO;
      if (!state) return unknownFor(request, 'native state not ready', UNKNOWN);
      const slot = prepared.ring.next();
      job.startedAt = now();
      job.sim._dispatch(prepared.kernel, [1, 1, 1], {
        bind: [job.sim.tables, state, prepared.group], header: native ? job.sim.readHeader({ physical: true }) : job.sim.header(),
        params: packParams(request, slot),
      });
      job.sim.gpu.flush?.('industry diagnostics');
      const bytes = await prepared.ring.read(slot);
      const completedAt = now();
      if (disposed || !ownsRequest(job) || getSim() !== job.sim || job.sim.disposed) {
        return unknownFor(request, 'stale observation discarded', 'stale');
      }
      const observed = withFreshness(decode(request, bytes, job.startedAt, completedAt), completedAt, staleMs);
      // A superseded readback may finish after a cache hit or identity change;
      // it no longer owns this device's result and must not evict/publish data.
      if (disposed || !ownsRequest(job) || getSim() !== job.sim || job.sim.disposed) {
        return unknownFor(request, 'stale observation discarded', 'stale');
      }
      for (const [key, entry] of cache) if (entry.id === request.device.id && key !== request.key) cache.delete(key);
      boundedSet(cache, request.key, observed);
      return attachEvidence(clone(observed));
    } catch (error) {
      if (!disposed && !job.cancelled && job.generation === generation) {
        try { onError(error); } catch { /* diagnostics must not affect simulation */ }
      }
      return unknownFor(request, `observation failed: ${error?.message ?? error}`);
    } finally {
      if (active === job) active = null;
    }
  }

  function inspect(device, overrides = {}) {
    if (disposed) return Promise.resolve(lifecycleSnapshot(device, { reason: 'diagnostics disposed' }));
    const bound = currentSim();
    if (!bound) return Promise.resolve(lifecycleSnapshot(device, { reason: 'no simulation' }));
    if (bound.disposed) return Promise.resolve(lifecycleSnapshot(device, { reason: 'simulation disposed' }));
    if (!record(overrides)) return Promise.resolve(lifecycleSnapshot(device, { reason: 'invalid diagnostic overrides' }));
    let request;
    try { request = normalizeRequest(device, clone(overrides), bound); }
    catch (error) { return Promise.resolve(lifecycleSnapshot(device, { reason: error?.message ?? 'invalid diagnostic request' })); }
    if (request.error) return Promise.resolve(lifecycleSnapshot(device, { reason: request.error }));
    boundedSet(latestById, request.device.id, request);
    invalidatedById.delete(request.device.id);
    // Selection/configuration changes supersede the active result even when the
    // new request can be answered from cache; never let its completion publish.
    if (active && (active.key !== request.key || active.generation !== generation || active.cancelled)) active.cancelled = true;
    const cached = cache.get(request.key);
    if (cached && now() - cached.sampledAt < throttleMs) return Promise.resolve(attachEvidence(withFreshness(cached, now(), staleMs)));
    if (active) {
      if (active.key === request.key && active.generation === generation && !active.cancelled) return active.promise;
      active.cancelled = true;
      return Promise.resolve(unknownFor(request, 'another observation is in flight', 'pending', true));
    }
    const job = { key: request.key, deviceId: request.device.id, deviceSignature: request.deviceSignature,
      generation, sim: bound, cancelled: false, promise: null, startedAt: null };
    active = job;
    job.promise = run(request, job);
    return job.promise;
  }

  function recordTransfer(device, event) {
    if (disposed || event?.confirmed !== true || !Number.isInteger(event.count) || event.count <= 0) return false;
    const key = industryDiagnosticSignature(device);
    if (!key) return false;
    boundedSet(transfers, key, { ...clone(event), observedAt: Number.isFinite(event.observedAt) ? event.observedAt : now() });
    return true;
  }
  function recordConfirmation(device, event) {
    if (disposed || event?.confirmed !== true || !record(event)) return false;
    const key = industryDiagnosticSignature(device);
    if (!key) return false;
    boundedSet(confirmations, key, { ...clone(event), observedAt: Number.isFinite(event.observedAt) ? event.observedAt : now() });
    return true;
  }
  function reset() {
    rememberInvalidated('diagnostics reset; old observation invalidated');
    generation++;
    if (active) active.cancelled = true;
    cache.clear(); latestById.clear(); transfers.clear(); confirmations.clear();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    if (active) active.cancelled = true;
    cache.clear(); latestById.clear(); invalidatedById.clear(); transfers.clear(); confirmations.clear();
    kernelState = null;
  }

  return {
    inspect, snapshot, recordTransfer, recordConfirmation, reset, dispose,
    get pending() { return active ? 1 : 0; },
    get ready() { return kernelState?.ready ?? Promise.resolve(); },
  };
}
