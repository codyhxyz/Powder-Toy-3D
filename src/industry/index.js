import { DEVICE_TYPES, INDUSTRY_LIMIT, QUARRY_STARTERS } from './catalog.js';
import { createIndustryPhysics, validateIndustryPhysics } from './physics.js';
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
  let building = false, selected = 'belt', rotation = 0, filter = E.NUGGETS, powered = false;
  let epoch = 0, pending = false, disposed = false, candidate = null, candidateResult = null;
  let probePending = false, probeKey = '', probeAt = 0, animation = 0, lastMode = app.gamemode;
  const active = () => !app.win && ['sandbox','factory'].includes(app.gamemode);
  const factory = () => app.gamemode === 'factory' && app.settings.preset === 'quarry';
  const construction = createConstruction(app);
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
    onError: error => app.hud.toast(`Industry: ${error?.message ?? error}`),
  });
  physics.ready.catch(error => app.hud.toast(`Industry unavailable: ${error.message}`));
  const canBuild = type => !active() ? fail('Industry is available in Sandbox and Factory box maps')
    : pending ? fail('Construction is finishing') : devices.length >= INDUSTRY_LIMIT ? fail('128 machines is the limit')
    : factory() ? progression?.canBuild(type) ?? fail('The Quarry is still loading') : { ok: true };
  const state = () => ({ devices: devices.map(d => ({...d})), progression: factory() ? progression?.snapshot() ?? null : null,
    active: active(), factory: factory(), selected, building: building && active(), rotation, filter, powered, assisted, factoryRun, pending: pending || !!physics.pending });
  const report = result => { if (!result.ok) app.hud.toast(result.reason); app.requestRender(); return result; };
  const toggle = value => {
    if (!active()) return;
    building = value ?? !building; app.painting = false;
    if (building) { app.leaveBuild(); app.dock.setCollapsed(true); }
    app.requestRender();
  };
  const rotate = () => { rotation = (rotation + 1) % 4; probeKey = ''; app.requestRender(); };
  function check(d) {
    const can = canBuild(d.type); if (!can.ok) return can;
    if (factory() && d.powered) return fail('Spark drive is Sandbox-only. Use the built-in drive in Factory.');
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
  async function remove(id) {
    if (!active()) return fail('Industry is not active');
    if (pending || physics.pending) return fail('Wait for the current machine transfer to finish');
    const d = devices.find(d => d.id === id); if (!d) return fail('Aim at a machine to dismantle it');
    // Physics retains a removed pump's cargo and spills it back into the world.
    const token = epoch; pending = true;
    try {
      if (!await construction.run(d, 2)) return fail('Could not dismantle this machine');
      if (token !== epoch || disposed) return fail('The map changed');
      devices = devices.filter(other => other.id !== id);
      if (paid.delete(id)) progression?.refund(d.type);
      probeKey = ''; app.requestRender(); return { ok: true, id };
    } catch (e) { return fail(e.message); }
    finally { if (token === epoch) pending = false; }
  }
  const target = () => {
    const h = app.hover; if (!h.valid) return null;
    return devices.find(d => h.cell.x >= d.x && h.cell.x < d.x+4 && h.cell.y >= d.y && h.cell.y < d.y+deviceHeight(d) && h.cell.z >= d.z && h.cell.z < d.z+4);
  };
  const placeAimed = () => { if (candidate) return place(candidate).then(report); report(fail('Aim at a clear surface first')); };
  const removeAimed = () => remove(target()?.id).then(report);
  const view = createIndustryView(app, { toggle: () => toggle(), cancel: () => toggle(false), rotate, place: placeAimed, remove: removeAimed,
    select: type => { selected = type; probeKey = ''; toggle(true); }, canBuild,
    filter: value => { filter = value; }, power: value => { powered = factory() ? false : value; },
  });
  const key = e => {
    if (!active() || app.isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    const buildKey = e.code === 'KeyB' && (building || app.gamemode === 'factory' || e.shiftKey);
    if (buildKey || (building && ['KeyR','Escape'].includes(e.code))) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) { if (e.code === 'KeyB') toggle(); else if (e.code === 'KeyR') rotate(); else toggle(false); }
    }
  };
  const pointer = e => {
    if (!building || !active() || e.target !== app.canvas || e.altKey || ![0,2].includes(e.button)) return;
    if (app.pov?.active && !app.pov.locked) return; // first click captures the mouse
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'pointerdown') { if (e.button === 2) removeAimed(); else placeAimed(); }
  };
  addEventListener('keydown',key,true); addEventListener('pointerdown',pointer,true); addEventListener('mousedown',pointer,true);
  function modeChanged() {
    if (app.gamemode !== lastMode) {
      if (app.settings.preset === 'quarry' && app.gamemode === 'sandbox' && factoryRun) assisted = true;
      if (factory()) { if (!factoryRun) assisted = true; factoryRun = true; powered = false; }
      lastMode = app.gamemode; building = false; app.painting = false;
      app.toolbar.setUndoEnabled(!factory() && app.sim.canUndo);
    }
  }
  function update(dt, stepping) {
    if (disposed) return;
    modeChanged();
    if (!active()) building = false;
    // Physics runs on actual steps, never on paused UI/ghost frames.
    if (stepping && active() && !pending) { physics.step(Math.min(Math.max(dt,0),.05), devices); animation += Math.min(dt,.05); }
    candidate = null;
    if (building && app.hover.valid) {
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
    view.update(state(),candidate,candidateResult,animation);
  }
  let lastProbe = fail('Checking clearance…');
  const api = {
    update, place, remove, modeChanged, get state() { return state(); }, get building() { return building && active(); },
    get pending() { return pending || !!physics.pending; },
    reset({ starters = false } = {}) {
      epoch++; physics.reset(); devices = []; progression = null; paid.clear(); factoryRun = false; assisted = false;
      pending = false; building = false; if (factory()) powered = false; probeKey = ''; lastMode = app.gamemode;
      if (starters && app.settings.preset === 'quarry') {
        devices = QUARRY_STARTERS.map(d => ({...deviceSpec(d,dimensions(app)),id:d.id}));
        progression = createProgression(); paid = new Set(devices.map(d => d.id)); factoryRun = factory();
      }
      app.requestRender();
    },
    toJSON() {
      if (pending || physics.pending) throw new Error('Machines are transferring matter. Pause, wait a moment, then save again.');
      if (factory() && [...allLoads().values()].some(load => load.count || load.busy)) throw new Error('Empty held shovel/bucket cargo into the Quarry before saving.');
      return { version:1, devices:devices.map(d=>({...d})), progression:progression?.snapshot() ?? null,
        paid:[...paid], factoryRun, assisted, physics:physics.toJSON() };
    },
    fromJSON(data) {
      if (disposed || pending || physics.pending) throw new Error('Wait for the current machine transfer before restoring Industry.');
      const next = validateIndustrySave(data,dimensions(app),app.settings.preset);
      const nextProgression = data.progression ? createProgression(data.progression) : null;
      // Physics validates and allocates before replacing its loads. Do not reset
      // first: a malformed orphan must leave both registrations and cargo intact.
      physics.fromJSON(data.physics,next);
      epoch++; devices = next; progression = nextProgression;
      paid = new Set(data.paid); factoryRun = data.factoryRun; assisted = data.assisted;
      building = false; probeKey = ''; lastMode = app.gamemode;
      if (factory()) powered = false;
      app.requestRender();
    },
    dispose() {
      disposed = true; epoch++; physics.dispose(); view.dispose();
      removeEventListener('keydown',key,true); removeEventListener('pointerdown',pointer,true); removeEventListener('mousedown',pointer,true);
    },
  };
  return api;
}
