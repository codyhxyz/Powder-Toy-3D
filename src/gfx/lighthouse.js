import { E } from '../elements.js';
import { structuresOf } from '../world/structures.js';
import { gfxUniforms } from './uniforms.js';
import { LIGHTHOUSE, lighthouseLantern, lighthouseInside, lighthouseNight, lighthouseDirection } from './lighthouseMath.js';

// Call before writeFrameUniforms. state.time is simulation seconds (paused
// time freezes the sweep). onChange must wake presentation after a readback.
// No cells are written, erased, or restored here. Reset only stops the light;
// the next update may relight it, but never forgets a destroyed physical lamp.
export function createLighthouse({ uniforms = gfxUniforms, getStructures = structuresOf, onChange = () => {} } = {}) {
  let world = null, simOf = null, epoch = -1, lantern = null, disposed = false;
  let generation = 0, pending = false, destroyed = false, visited = false;
  let verified = -1, lastInside = -2, readVersion = -1, nextRead = -Infinity, previousTime = null;
  const published = new Float32Array(12);
  function publish() {
    const active = published[7] > 0 || uniforms.uBeaconDir.value[3] > 0;
    let changed = false, i = 0;
    for (const key of ['uBeacon', 'uBeaconDir', 'uBeaconCell']) {
      for (const v of uniforms[key].value) { if (published[i] !== v) changed = true; published[i++] = v; }
    }
    if (active && changed) onChange();
  }
  const originOf = (sim) => [sim.origin.x, sim.origin.y, sim.origin.z];
  function cancel() { generation++; pending = false; }
  function dark() { uniforms.uBeaconDir.value[3] = 0; }
  function clear() {
    cancel(); dark(); world = null; simOf = null; epoch = -1; lantern = null;
    destroyed = false; visited = false; verified = -1; lastInside = -2;
    readVersion = -1; nextRead = -Infinity; previousTime = null;
    uniforms.uBeacon.value.fill(0); uniforms.uBeaconCell.value.fill(0);
  }
  function capture(sim, origin, version) {
    const token = generation, w = world, e = epoch;
    const cell = lantern.cell.map((v, i) => v - origin[i]);
    pending = true; readVersion = version;
    // readCell records the copies synchronously at the call (WebGPU B7).
    // No late request can observe a shifted/reused state buffer by accident.
    const valid = () => !disposed && token === generation && world === w && w.loaded &&
      w.epoch === e && simOf === sim && w.sim === sim && origin.every((v, i) => v === originOf(sim)[i]);
    let read;
    try { read = sim.readCell(...cell); } catch { pending = false; return; }
    Promise.resolve(read).then(([a]) => {
      if (!valid()) return;
      if (Math.round(a[0]) !== E.CRYSTAL) { destroyed = true; dark(); }
      else verified = version;
      onChange();
    }).catch(() => { /* Unknown departed lamps stay dark; the live shader still checks resident cells. */ })
      .finally(() => { if (token === generation) pending = false; });
  }
  function update(state, { world: w, sim = w?.sim, dayPhase = 0.5, enabled = true } = {}) {
    if (disposed) return;
    if (!w?.loaded || !sim || !w.P?.structures) { if (world) clear(); return; }
    if (world !== w || epoch !== w.epoch || simOf !== sim) {
      clear(); world = w; epoch = w.epoch; simOf = sim;
      lantern = lighthouseLantern(getStructures(w.P));
    }
    dark();
    if (!lantern) return;
    const time = Number.isFinite(state?.time) ? state.time : 0;
    const held = time === previousTime; previousTime = time;
    const origin = originOf(sim), version = sim.version ?? sim.frame;
    const inside = lighthouseInside(lantern.cell, origin, sim.g);
    if (inside) { visited = true; lastInside = version; }
    const allowed = !destroyed && (inside || !visited || verified === lastInside);
    uniforms.uBeacon.value.set([...lantern.position, LIGHTHOUSE.range]);
    uniforms.uBeaconCell.value.set([...lantern.cell, 0]);
    uniforms.uBeaconDir.value.set([...lighthouseDirection(time), enabled && allowed ? lighthouseNight(dayPhase) : 0]);
    if (!enabled) { cancel(); readVersion = -1; return; }
    // At most four tiny reads per simulation second; a paused edit may need
    // one immediately. An unchanged sleeping world queues no repeated reads.
    if (inside && !destroyed && !pending && readVersion !== version && (time >= nextRead || held || time < nextRead - LIGHTHOUSE.captureInterval)) {
      nextRead = time + LIGHTHOUSE.captureInterval;
      capture(sim, origin, version);
    }
  }
  return {
    update(...args) { update(...args); publish(); },
    reset() { cancel(); dark(); readVersion = -1; nextRead = -Infinity; publish(); },
    dispose() { clear(); disposed = true; publish(); },
  };
}
