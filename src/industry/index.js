import { DEVICE_TYPES, INDUSTRY_LIMIT, QUARRY_STARTERS } from './catalog.js';
import { createIndustryPhysics, validateIndustryPhysics, controlCell } from './physics.js';
import { createGatePhysics } from './gates.js';
import { createFactoryControlParts, CONTROL_PARTS, CONTROL_PART_THRESHOLD_BOUNDS, validateControlPartSpec } from './controlParts.js';
import { createIndustryDiagnostics } from './diagnostics.js';
import { createProgression } from './progression.js';
import { createConstruction } from './construction.js';
import { createIndustryView } from './view.js';
import { deviceSpec, validateDevices, overlaps, overlapsBody, deviceHeight } from './validation.js';
import { allLoads } from '../pov/tools/transfer.js';
import { E } from '../elements.js';

const fail = reason => ({ ok: false, reason });
const dimensions = app => [app.sim.g.nx, app.sim.g.ny, app.sim.g.nz];

// Called by the save loader BEFORE changing either terrain or progression.
export function validateIndustrySave(data, dims, preset) {
  if (!data || data.version !== 1 || typeof data.assisted !== 'boolean' || typeof data.factoryRun !== 'boolean') throw new Error('Invalid Industry save');
  const devices = validateDevices(data.devices, dims);
  if (!Array.isArray(data.paid) || new Set(data.paid).size !== data.paid.length || data.paid.some(id => !devices.some(d => d.id === id))) throw new Error('Invalid Industry ownership');
  if (data.progression !== null) {
    if (preset !== 'quarry' || !data.progression || typeof data.progression !== 'object') throw new Error('Factory progression belongs to the Quarry');
    const owned = createProgression(data.progression).snapshot().owned;
    for (const type of Object.keys(DEVICE_TYPES)) {
      if (owned[type] !== devices.filter(d => d.type === type && data.paid.includes(d.id)).length) throw new Error('Industry ownership does not match its machines');
    }
  } else if (data.factoryRun || data.paid.length) throw new Error('Missing Factory progression');
  validateIndustryPhysics(data.physics, devices, { nx: dims[0], ny: dims[1], nz: dims[2] });
  return devices;
}

export function createIndustry(app) {
  let devices = [], progression = null, paid = new Set(), factoryRun = false, assisted = false;
  let building = false, dismantling = false, selected = 'belt', rotation = 0, filter = E.NUGGETS, powered = false;
  let part = null, partThreshold = 200, inspectMode = false, inspection = null, partCandidate = null, partCandidateResult = null;
  let inspectionKey = '', inspectionAt = 0, inspectionFlight = false, inspectionControlAt = 0;
  let epoch = 0, pending = false, disposed = false, candidate = null, candidateResult = null;
  let probePending = false, probeKey = '', probeAt = 0, animation = 0, lastMode = app.gamemode, lastSim = app.sim;
  // ponytail: box maps only; streamed worlds need persistent world-coordinate machinery.
  const active = () => !app.win && ['sandbox','factory'].includes(app.gamemode);
  // Keep machines running and preserve the build selection, but driving has no
  // construction input or placement ghost. Exit restores the previous console.
  const driving = () => !!app.pov?.vehicles?.seated;
  const factory = () => app.gamemode === 'factory' && app.settings.preset === 'quarry';
  const isBuilding = () => building && active() && factory() && !driving();
  const syncToolbar = () => app.toolbar.setIndustry?.(active() && factory(), isBuilding());
  const construction = createConstruction(app);
  const diagnostics = createIndustryDiagnostics({ getSim: () => app.sim,
    onError: error => app.hud.toast(`Industry diagnostics: ${error?.message ?? error}`),
  });
  const gatePhysics = createGatePhysics({ getSim: () => app.sim,
    onError: error => app.hud.toast(`Industry gate: ${error?.message ?? error}`),
    onState: (id, result) => {
      const gate = devices.find(d => d.id === id && d.type === 'gate');
      if (!gate || result?.id !== id || typeof result.gateClosed !== 'boolean'
          || !['OPEN', 'CLOSED', 'BLOCKED'].includes(result.status)
          || (result.gateMode && result.gateMode !== gate.gateMode)) return;
      // The backend reports only GPU-confirmed physical transitions. Do not
      // apply a detached callback to a removed/replaced controller registration.
      gate.gateClosed = result.gateClosed;
      diagnostics.recordConfirmation(gate, { confirmed: true, status: result.status, gateClosed: result.gateClosed });
      app.requestRender();
    },
  });
  const controlParts = createFactoryControlParts({ getSim: () => app.sim });
  const physics = createIndustryPhysics({ getSim: () => app.sim,
    onShip: shipment => {
      if (disposed || !factory() || !progression) return;
      const before = progression.snapshot();
      progression.ship(shipment);
      const after = progression.snapshot();
      if (after.stage > before.stage) {
        const unlocked = after.unlocked.filter(type => !before.unlocked.includes(type)).map(type => DEVICE_TYPES[type].name);
        app.hud.toast(after.complete ? 'Quarry complete — keep expanding!' : `Unlocked: ${unlocked.join(' + ')}. ${after.hint}`);
      }
      app.requestRender();
    },
    onTransfer: event => {
      if (disposed || event?.confirmed !== true || !event.device) return;
      const registered = devices.find(d => d.id === event.device.id && d.type === event.device.type
        && d.x === event.device.x && d.y === event.device.y && d.z === event.device.z && d.rotation === event.device.rotation);
      if (registered) diagnostics.recordTransfer(registered, event);
    },
    onError: error => app.hud.toast(`Industry: ${error?.message ?? error}`),
  });
  physics.ready.catch(error => app.hud.toast(`Industry unavailable: ${error.message}`));
  const anyMutationPending = () => pending || !!gatePhysics.pending || !!controlParts.pending;
  const canBuild = type => !active() ? fail('Industry is available in Sandbox and Factory box maps')
    : anyMutationPending() ? fail('Construction is finishing') : devices.length >= INDUSTRY_LIMIT ? fail('128 machines is the limit')
    : factory() ? progression?.canBuild(type) ?? fail('The Quarry is still loading') : { ok: true };
  const state = () => ({ devices: devices.map(d => ({...d})), progression: factory() ? progression?.snapshot() ?? null : null,
    active: active(), factory: factory(), selected, building: isBuilding(), dismantling, rotation, filter, powered, assisted, factoryRun,
    part, partThreshold, inspectMode, inspection: inspection && { ...inspection, device: inspection.device && { ...inspection.device },
      observation: inspection.observation && structuredClone(inspection.observation), gateStatus: inspection.gateStatus && { ...inspection.gateStatus },
      controlPart: inspection.controlPart && { ...inspection.controlPart } },
    partCandidate: partCandidate && { ...partCandidate }, partCandidateResult: partCandidateResult && { ...partCandidateResult },
    pending }); // Construction/placement only; live transport never rewrites the prompt
  const report = result => { if (!result.ok) app.hud.toast(result.reason); app.requestRender(); return result; };
  const clearInspection = () => { inspection = null; inspectionKey = ''; inspectionAt = 0; inspectionFlight = false; inspectionControlAt = 0; };
  const clearCompetingModes = () => { part = null; inspectMode = false; partCandidate = null; partCandidateResult = null; clearInspection(); };
  const toggle = value => {
    if (!active() || !factory() || driving()) return;
    building = value ?? !building; app.painting = false;
    if (!building) { dismantling = false; clearCompetingModes(); }
    else { clearCompetingModes(); app.leaveBuild(); app.dock.setCollapsed(true); }
    syncToolbar();
    app.requestRender();
  };
  const rotate = () => { rotation = (rotation + 1) % 4; probeKey = ''; app.requestRender(); };
  function selectPart(key) {
    if (key !== null && (typeof key !== 'string' || !Object.hasOwn(CONTROL_PARTS, key))) return report(fail('Choose a permitted native control part'));
    if (!active() || !factory() || driving()) return report(fail('Control parts are available in the Factory'));
    building = false; dismantling = false; inspectMode = false;
    part = key; partCandidate = null; partCandidateResult = null; clearInspection();
    app.painting = false; app.leaveBuild(); app.dock?.setCollapsed?.(true); syncToolbar();
    app.requestRender(); return { ok: true, reason: '' };
  }
  function setThreshold(value) {
    if (part !== 'TSNS') return report(fail('Select a temperature sensor for placement first'));
    if (typeof value !== 'number' || !Number.isFinite(value)) return report(fail('Temperature threshold must be finite'));
    const [minimum, maximum] = CONTROL_PART_THRESHOLD_BOUNDS;
    partThreshold = Math.max(minimum, Math.min(maximum, value));
    app.requestRender(); return { ok: true, reason: '', threshold: partThreshold };
  }
  function toggleInspect(value) {
    if (!active() || !factory() || driving()) return report(fail('Inspection is available in the Factory'));
    if (value !== undefined && typeof value !== 'boolean') return report(fail('Inspection mode must be on or off'));
    inspectMode = value ?? !inspectMode;
    part = null; partCandidate = null; partCandidateResult = null; building = false; dismantling = false;
    if (!inspectMode) clearInspection(); else { app.painting = false; app.leaveBuild(); }
    syncToolbar(); app.requestRender(); return { ok: true, reason: '' };
  }
  function setDrive(id, value) {
    if (typeof value !== 'boolean') return report(fail('Drive state must be on or off'));
    const device = devices.find(d => d.id === id);
    if (!device || ['foundation', 'gate'].includes(device.type)) return report(fail('Choose a registered machine to drive'));
    if (anyMutationPending()) return report(fail('Wait for the current construction to finish'));
    device.powered = value; app.requestRender(); return { ok: true, reason: '' };
  }
  function setGateMode(id, mode) {
    if (!['open', 'closed', 'signal'].includes(mode)) return report(fail('Gate mode must be open, closed, or signal'));
    const device = devices.find(d => d.id === id && d.type === 'gate');
    if (!device) return report(fail('Choose a registered material gate'));
    if (anyMutationPending()) return report(fail('Wait for the current construction to finish'));
    device.gateMode = mode; app.requestRender(); return { ok: true, reason: '' };
  }
  async function toggleControl() {
    const selectedControl = inspection?.controlPart;
    if (!selectedControl || selectedControl.type !== 'SWITCH') return report(fail('Inspect a real native switch first'));
    if (!factory() || !active()) return report(fail('Native control switches are available in the Factory'));
    if (anyMutationPending() || physics.pending) return report(fail('Wait for the current machine operation to finish'));
    const token = epoch, selected = { ...selectedControl };
    pending = true;
    try {
      const result = await controlParts.toggle({ x: selected.x, y: selected.y, z: selected.z });
      if (token !== epoch || disposed) return fail('The map changed');
      if (!result.ok) return report(result);
      if (inspection?.controlPart && inspection.controlPart.x === selected.x && inspection.controlPart.y === selected.y && inspection.controlPart.z === selected.z) {
        inspection.controlPart = { ...inspection.controlPart, on: result.on };
        inspectionControlAt = performance.now();
      }
      app.requestRender(); return { ok: true, reason: '', on: result.on };
    } catch (error) { return report(fail(error?.message ?? 'Switch toggle failed')); }
    finally { if (token === epoch) pending = false; }
  }
  function check(d) {
    const can = canBuild(d.type); if (!can.ok) return can;
    // Factory drive is opt-in: `powered` requires an actual native signal at the
    // real port, but no default machine depends on a purchased conductor.
    if (devices.some(other => overlaps(d, other))) return fail('Another machine occupies that space');
    if (app.pov?.active && overlapsBody(d, app.pov.player?.pos)) return fail('Move clear of the machine footprint');
    return { ok: true };
  }
  async function place(spec) {
    let d;
    try { d = deviceSpec(spec, dimensions(app)); } catch (e) { return fail(e.message); }
    const can = check(d); if (!can.ok) return can;
    const token = epoch, charge = factory(); pending = true;
    try {
      await construction.ready;
      if (token !== epoch || disposed) return fail('The map changed');
      // Check the body again immediately before dispatch, not after a queued compile.
      if (app.pov?.active && overlapsBody(d, app.pov.player?.pos)) return fail('Move clear of the machine footprint');
      if (!await construction.run(d, 1)) return fail('Obstructed: clear the full 4 × 4 deck and headroom first');
      if (token !== epoch || disposed) return fail('The map changed');
      const id = crypto.randomUUID(); // Never reuse IDs belonging to retained orphan pump cargo.
      // The single pending construction reserves both cost and space. No other
      // build/refund/load can change this economy while its GPU answer lands.
      if (charge) {
        const result = progression.build(d.type);
        if (!result.ok) { await construction.run(d, 2); return result; }
        paid.add(id);
      }
      devices.push({ id, ...d }); probeKey = ''; app.requestRender();
      return { ok: true, id };
    } catch (e) { return fail(e.message); }
    finally { if (token === epoch) pending = false; }
  }
  function controlPartFootprintConflict(spec) {
    return devices.some(d => spec.x >= d.x && spec.x < d.x + 4
      && spec.y >= d.y && spec.y < d.y + deviceHeight(d)
      && spec.z >= d.z && spec.z < d.z + 4);
  }
  function checkControlPart(spec) {
    if (!active() || !factory()) return fail('Paid control parts are available in the Factory');
    if (anyMutationPending()) return fail('Construction is finishing');
    if (!part || !Object.hasOwn(CONTROL_PARTS, part)) return fail('Choose a control part first');
    if (spec?.type !== undefined && spec.type !== part) return fail('Select the control part you are placing');
    let canonical;
    try {
      const input = { key: part, x: spec.x, y: spec.y, z: spec.z };
      if (part === 'TSNS') input.threshold = spec.threshold ?? partThreshold;
      canonical = validateControlPartSpec(input, dimensions(app));
    } catch (error) { return fail(error.message); }
    if (controlPartFootprintConflict(canonical)) return fail('Control parts must stay outside machine footprints; use the native port');
    const can = progression?.canBuyPart(part) ?? fail('The Quarry is still loading');
    if (!can.ok) return can;
    return { ok: true, reason: '', spec: canonical };
  }
  async function placeControlPart(spec) {
    const checked = checkControlPart(spec ?? {});
    if (!checked.ok) return checked;
    const canonical = checked.spec, key = canonical.key, token = epoch;
    const cost = CONTROL_PARTS[key].cost; // Never trust a caller/backend-supplied price.
    // This lock reserves affordability and serializes against every other
    // controller spend/refund until the backend confirms an empty-cell write.
    pending = true;
    try {
      const placement = { key, x: canonical.x, y: canonical.y, z: canonical.z };
      if (key === 'TSNS') placement.threshold = canonical.threshold;
      const result = await controlParts.place(placement);
      if (token !== epoch || disposed) return fail('The map changed');
      if (!result.ok) return result;
      const debit = progression?.buyPart(key);
      if (!debit?.ok) return fail(debit?.reason ?? 'The Factory economy is unavailable');
      app.requestRender();
      return { ok: true, reason: '', key, material: CONTROL_PARTS[key].material,
        cost, x: canonical.x, y: canonical.y, z: canonical.z,
        ...(canonical.threshold === undefined ? {} : { threshold: canonical.threshold }) };
    } catch (error) { return fail(error?.message ?? 'Control-part placement failed'); }
    finally { if (token === epoch) pending = false; }
  }
  async function remove(id) {
    if (!active()) return fail('Industry is not active');
    if (anyMutationPending() || physics.pending) return fail('Wait for the current machine transfer to finish');
    const d = devices.find(d => d.id === id); if (!d) return fail('Aim at a machine to dismantle it');
    // Physics retains a removed pump's cargo and spills it back into the world.
    // A gate first erases only its confirmed tagged shutter; never dismantle its
    // native base or unregister it while that ownership operation is pending.
    const token = epoch; pending = true;
    try {
      if (d.type === 'gate') {
        const result = await gatePhysics.remove(d);
        if (token !== epoch || disposed) return fail('The map changed');
        if (!result.ok) return fail(result.reason || 'Could not safely open the gate');
        d.gateClosed = false;
      }
      if (!await construction.run(d, 2)) return fail('Could not dismantle this machine');
      if (token !== epoch || disposed) return fail('The map changed');
      devices = devices.filter(other => other.id !== id);
      if (paid.delete(id)) progression?.refund(d.type);
      probeKey = ''; app.requestRender(); return { ok: true, id };
    } catch (e) { return fail(e.message); }
    finally { if (token === epoch) pending = false; }
  }
  const target = () => {
    const h = app.hover; if (!h?.valid) return null;
    return devices.find(d => h.cell.x >= d.x && h.cell.x < d.x+4 && h.cell.y >= d.y && h.cell.y < d.y+deviceHeight(d) && h.cell.z >= d.z && h.cell.z < d.z+4);
  };
  const hoverCell = () => {
    const h = app.hover;
    if (!h?.valid || !h.cell || ![h.cell.x, h.cell.y, h.cell.z].every(Number.isFinite)) return null;
    return [h.cell.x, h.cell.y, h.cell.z].map(Math.floor);
  };
  const controlOwnerAt = cell => cell && devices.find(d => {
    const port = controlCell(d);
    return port[0] === cell[0] && port[1] === cell[1] && port[2] === cell[2];
  });
  const placeAimed = () => { if (candidate) return place(candidate).then(report); report(fail('Aim at a clear surface first')); };
  const placePartAimed = () => { if (partCandidate) return placeControlPart(partCandidate).then(report); report(fail('Aim at an in-bounds cell first')); };
  const removeAimed = () => remove(target()?.id).then(report);
  const view = createIndustryView(app, { toggle: () => toggle(), cancel: () => toggle(false), rotate, place: placeAimed,
    remove: () => {
      if (isBuilding()) { clearCompetingModes(); dismantling = !dismantling; probeKey = ''; app.requestRender(); }
    },
    select: type => { clearCompetingModes(); selected = type; dismantling = false; probeKey = ''; toggle(true); }, canBuild,
    selectPart, setThreshold, toggleInspect, setDrive, setGateMode, toggleControl,
    filter: value => { filter = value; }, power: value => { powered = !!value; },
  });
  const key = e => {
    if (app.isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    // Factory Q opens Build only. Sandbox keeps GMod's spawn menu: that is the intentional cheat.
    if (e.code === 'KeyQ' && !e.repeat && factory() && active()) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (driving()) return;
      const opening = !building;
      toggle();
      if (opening && document.pointerLockElement) document.exitPointerLock();
      return;
    }
    if (!isBuilding() && !part && !inspectMode) return;
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) {
        if (isBuilding()) toggle(false);
        else { clearCompetingModes(); app.requestRender(); }
      }
    }
  };
  const pointer = e => {
    const partMode = !!part && active() && factory() && !driving();
    if ((!isBuilding() && !partMode && !inspectMode) || e.target !== app.canvas || e.altKey || e.button !== 0) return;
    if (app.pov?.active && !app.pov.locked) return; // first click captures the mouse
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'pointerdown') {
      if (partMode) placePartAimed();
      else if (isBuilding()) { if (dismantling) removeAimed(); else placeAimed(); }
      // Inspection is hover-driven; consuming this click prevents an unrelated
      // brush or Sandbox action without adding a new key binding.
    }
  };
  addEventListener('keydown',key,true); addEventListener('pointerdown',pointer,true); addEventListener('mousedown',pointer,true);
  // Five bounded ID-set probes encode all seven whitelist materials uniquely;
  // each region permits two IDs and remains within the diagnostic 8-region cap.
  const controlCodes = {
    TSNS: [1, 0, 0, 0, 0], SWITCH: [0, 1, 0, 0, 0], BATTERY: [0, 0, 1, 0, 0],
    METAL: [0, 0, 0, 1, 0], PSCN: [0, 0, 0, 0, 1], NSCN: [1, 1, 0, 0, 0], INSULATOR: [0, 0, 1, 1, 0],
  };
  function controlProbeOverrides(device, cell) {
    const regions = {};
    for (let index = 0; index < 5; index++) {
      const keys = Object.keys(controlCodes).filter(key => controlCodes[key][index]);
      regions[`controlPart${index}`] = { cells: [cell], ids: keys.map(key => CONTROL_PARTS[key].material) };
    }
    // Inspect the actual native port signal independently of the machine's
    // optional drive setting; the backend still samples only this one cell.
    return { regions, guard: { base: [0, 0, 0], material: -1, port: controlCell(device), powered: true } };
  }
  function observedControlPart(observation, cell) {
    const regions = observation?.evidence?.regions;
    if (!regions || observation.freshness !== 'fresh') return null;
    const code = Array.from({ length: 5 }, (_, index) => regions[`controlPart${index}`]?.eligible === 1 ? 1 : 0);
    const type = Object.keys(controlCodes).find(key => controlCodes[key].every((bit, index) => bit === code[index]));
    if (!type) return null;
    const signal = observation.evidence?.control?.active ?? null;
    const sensor = type === 'TSNS' ? regions.controlPart0 : null;
    return { type, x: cell[0], y: cell[1], z: cell[2],
      threshold: type === 'TSNS' ? sensor?.meanTemperatureC ?? null : null,
      on: type === 'SWITCH' ? signal : null };
  }
  function inspectHovered() {
    if (!inspectMode || !active() || !factory()) { clearInspection(); return; }
    const cell = hoverCell();
    const device = target() ?? controlOwnerAt(cell);
    if (!cell || !device || device.type === 'foundation') { clearInspection(); return; }
    const port = controlCell(device), onPort = port.every((n, i) => n === cell[i]);
    const expectedShipId = device.type === 'ship' ? physics.expectedShipId(device.id) : undefined;
    const key = JSON.stringify([epoch, device.id, device.type, device.x, device.y, device.z, device.rotation,
      device.filter ?? null, !!device.powered, expectedShipId ?? null, onPort ? cell : null]);
    if (key !== inspectionKey) {
      inspectionKey = key; inspectionAt = -Infinity; inspectionFlight = false;
      inspection = { device: { ...device }, observation: diagnostics.snapshot(device),
        gateStatus: device.type === 'gate' ? gatePhysics.status(device.id) : null, controlPart: null };
    }
    if (!inspection) return;
    inspection.gateStatus = device.type === 'gate' ? gatePhysics.status(device.id) : null;
    inspection.observation = diagnostics.snapshot(device);
    const now = performance.now();
    if (!inspectionFlight && now - inspectionAt >= 750) {
      inspectionAt = now; inspectionFlight = true;
      const token = epoch, sim = app.sim;
      const overrides = { ...(expectedShipId === undefined ? {} : { expectedShipId }),
        ...(onPort ? controlProbeOverrides(device, cell) : {}) };
      diagnostics.inspect(device, overrides).then(observation => {
        if (token !== epoch || app.sim !== sim || inspectionKey !== key || !inspection) return;
        inspection.observation = observation;
        inspection.controlPart = onPort && (observation?.completedAt ?? -Infinity) >= inspectionControlAt
          ? observedControlPart(observation, cell) : inspection.controlPart;
        inspection.gateStatus = device.type === 'gate' ? gatePhysics.status(device.id) : null;
        app.requestRender();
      }).catch(() => {}).finally(() => {
        if (token === epoch && inspectionKey === key) inspectionFlight = false;
      });
    } else if (onPort && (inspection.observation?.completedAt ?? -Infinity) >= inspectionControlAt) {
      inspection.controlPart = observedControlPart(inspection.observation, cell) ?? inspection.controlPart;
    } else if (!onPort) inspection.controlPart = null;
  }
  let spawnLocked = null;
  function modeChanged() {
    if (app.sim !== lastSim) {
      lastSim = app.sim; epoch++; pending = false;
      physics.reset(); gatePhysics.reset(); controlParts.reset(); diagnostics.reset();
      candidate = candidateResult = partCandidate = partCandidateResult = null; probeKey = '';
      clearInspection();
    }
    if (app.gamemode !== lastMode) {
      if (app.settings.preset === 'quarry' && app.gamemode === 'sandbox' && factoryRun) assisted = true;
      if (factory()) { if (!factoryRun) assisted = true; factoryRun = true; powered = false; }
      lastMode = app.gamemode; building = false; dismantling = false; app.painting = false;
      if (!factory()) clearCompetingModes();
      app.toolbar.setUndoEnabled(!factory() && app.sim.canUndo);
    }
    const locked = factory();
    if (locked !== spawnLocked) {
      spawnLocked = locked;
      app.dock?.setSpawnLocked?.(locked);
      if (locked) app.pov?.closeMenu?.();
    }
    syncToolbar();
  }
  function update(dt, stepping) {
    if (disposed) return;
    modeChanged();
    if (!active() || !factory()) { building = false; dismantling = false; if (part || inspectMode) clearCompetingModes(); }
    // Native machines and shutters advance only beside real simulation steps.
    if (stepping && active() && !pending) {
      const stepDt = Math.min(Math.max(dt, 0), .05);
      physics.step(stepDt, devices); gatePhysics.step(stepDt, devices); animation += stepDt;
    }
    candidate = null; candidateResult = null; partCandidate = null; partCandidateResult = null;
    if (isBuilding() && dismantling) {
      candidate = target();
      if (candidate) candidateResult = { ok: true, reason: 'Click to dismantle' };
    } else if (isBuilding() && app.hover.valid) {
      const h = app.hover, xyz = [h.cell.x,h.cell.y,h.cell.z].map(Math.floor);
      const axis = Math.floor(h.face/2), sign = h.face % 2 === 0 ? 1 : -1;
      if (h.id >= 0) xyz[axis] += sign > 0 ? 1 : -(axis === 1 ? deviceHeight({type:selected}) : 4);
      // Horizontal snap keeps adjacent transport decks contiguous; height is
      // exact so terraces, lifts and player-made shelves all remain buildable.
      candidate = { type:selected, x:Math.floor(xyz[0]/4)*4, y:Math.max(0,xyz[1]), z:Math.floor(xyz[2]/4)*4, rotation, filter, powered };
      try { deviceSpec(candidate,dimensions(app)); candidateResult = check(candidate); }
      catch (e) { candidateResult = fail(e.message); }
      if (candidateResult.ok) {
        const key = JSON.stringify(candidate), now = performance.now();
        if (probeKey !== key) candidateResult = fail('Checking clearance…');
        else candidateResult = lastProbe;
        if (!probePending && (probeKey !== key || now - probeAt > 250)) {
          probePending = true; const d = {...candidate}, token = epoch;
          construction.run(d,0).then(ok => {
            if (token !== epoch) return;
            probeKey = key; probeAt = performance.now(); lastProbe = ok ? {ok:true,reason:'Clear deck · Click to place'} : fail('Obstructed · Clear deck and headroom');
            app.requestRender();
          }, error => { lastProbe = fail(error.message); }).finally(() => { probePending = false; });
        }
      }
    }
    if (part && active() && factory() && !driving() && app.hover?.valid) {
      const h = app.hover, xyz = [h.cell.x, h.cell.y, h.cell.z].map(Math.floor);
      const axis = Math.floor(h.face / 2), sign = h.face % 2 === 0 ? 1 : -1;
      if (h.id >= 0) xyz[axis] += sign;
      partCandidate = { x: xyz[0], y: xyz[1], z: xyz[2], type: part,
        threshold: part === 'TSNS' ? partThreshold : null };
      const checked = checkControlPart(partCandidate);
      partCandidateResult = { ok: checked.ok, reason: checked.reason };
    }
    inspectHovered();
    view.update(state(),candidate,candidateResult,animation);
  }
  let lastProbe = fail('Checking clearance…');
  const api = {
    update, place, placeControlPart, remove, toggle, modeChanged, selectPart, setThreshold, toggleInspect,
    setDrive, setGateMode, toggleControl,
    get state() { return state(); }, get building() { return isBuilding(); },
    get pending() { return pending || !!physics.pending || !!gatePhysics.pending || !!controlParts.pending; },
    reset({ starters = false } = {}) {
      if (factory()) app.hud.dismissHint?.(); // The Sandbox pouring hint is false on the initial Factory boot too.
      epoch++; physics.reset(); gatePhysics.reset(); controlParts.reset(); diagnostics.reset();
      devices = []; progression = null; paid.clear(); factoryRun = false; assisted = false;
      pending = false; building = false; dismantling = false; part = null; partThreshold = 200; inspectMode = false;
      partCandidate = partCandidateResult = null; clearInspection();
      if (factory()) powered = false; probeKey = ''; lastMode = app.gamemode; lastSim = app.sim;
      if (starters && app.settings.preset === 'quarry') {
        devices = QUARRY_STARTERS.map(d => ({...deviceSpec(d,dimensions(app)),id:d.id}));
        progression = createProgression(); paid = new Set(devices.map(d => d.id)); factoryRun = factory();
      }
      syncToolbar(); app.requestRender();
    },
    toJSON() {
      if (pending || physics.pending || gatePhysics.pending || controlParts.pending) throw new Error('Machines are transferring matter. Pause, wait a moment, then save again.');
      if (factory() && [...allLoads().values()].some(load => load.count || load.busy)) throw new Error('Empty held shovel/bucket cargo into the Quarry before saving.');
      return { version:1, devices:devices.map(d=>({...d})), progression:progression?.snapshot() ?? null,
        paid:[...paid], factoryRun, assisted, physics:physics.toJSON() };
    },
    fromJSON(data) {
      if (disposed || pending || physics.pending || gatePhysics.pending || controlParts.pending) throw new Error('Wait for the current machine transfer before restoring Industry.');
      const next = validateIndustrySave(data,dimensions(app),app.settings.preset);
      const nextProgression = data.progression ? createProgression(data.progression) : null;
      // Physics validates and allocates before replacing its loads. Do not reset
      // first: a malformed orphan must leave both registrations and cargo intact.
      physics.fromJSON(data.physics,next);
      epoch++; gatePhysics.reset(); controlParts.reset(); diagnostics.reset();
      devices = next; progression = nextProgression;
      paid = new Set(data.paid); factoryRun = data.factoryRun; assisted = data.assisted;
      building = false; dismantling = false; part = null; inspectMode = false;
      partCandidate = partCandidateResult = null; clearInspection(); probeKey = ''; lastMode = app.gamemode; lastSim = app.sim;
      if (factory()) powered = false;
      syncToolbar(); app.requestRender();
    },
    dispose() {
      disposed = true; epoch++; physics.dispose(); gatePhysics.dispose(); controlParts.dispose(); diagnostics.dispose(); view.dispose();
      app.toolbar.setIndustry?.(false, false);
      removeEventListener('keydown',key,true); removeEventListener('pointerdown',pointer,true); removeEventListener('mousedown',pointer,true);
    },
  };
  syncToolbar();
  return api;
}
