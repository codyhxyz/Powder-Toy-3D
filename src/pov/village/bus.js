import { Vector3 } from 'three';
import { E, ELEMENTS, K } from '../../elements.js';
import { BODY_HEIGHT, BODY_WIDTH } from '../constants.js';
import { CITY_FOLK_CITY } from '../../world/scenes/cityFolk/city.js';

export const CITY_BUS_STOPS = Object.freeze({
  town: { arrival: CITY_FOLK_CITY.landmarks.townArrival, destination: 'city', label: 'Board bus to the city' },
  city: { arrival: CITY_FOLK_CITY.landmarks.cityArrival, destination: 'town', label: 'Return bus to Tinker Creek' },
});
const worldPoint = (p, world) => new Vector3(p[0] + world.P.size[0] / 2, p[1], p[2] + world.P.size[2] / 2);

// The app supplies moveWindow (including entity/grid shifts). No load, scene
// replacement or edit-store operation is allowed here. Keep focus through the
// live clearance check and teleport, so the normal frame cannot pull it away.
export async function withCityBusFocus({ world, at, valid, getFocus, setFocus, move, visit }) {
  if (!world?.loaded || !valid() || getFocus()) return false;
  const focus = [...at];
  setFocus(focus);
  const current = () => valid() && world.loaded && getFocus() === focus;
  try {
    // Finite world, 16-cell shifts: this bound is ample for either supported size.
    const limit = Math.ceil((world.P.size[0] + world.P.size[2]) / 16) + 4;
    for (let i = 0; i < limit; i++) {
      // the last move's leaving slab, and under V2 the window's pipelines (WorldWindow.blocker): a move
      // that can't be made yet must not be taken for arrival, or the arrival lands outside the window
      for (let n = 0, wait; n < limit && (wait = world.blocker ? world.blocker() : world.pending); n++) await wait;
      await world.sim?.deco?.pending;
      if (!current()) return false;
      const moved = move();
      if (moved?.then) { await moved; continue; }   // a move that commits later: wait for it, then look again
      if (!moved) return visit ? await visit(current) : true;
    }
    throw new Error('Bus streaming did not converge');
  } finally { if (getFocus() === focus) setFocus(null); }
}

// Inspect every covered support/body cell in the edited live simulation. Never
// assume the generated arrival is still intact after somebody mines/builds it.
export async function cityBusArrivalClear(sim, feet, player) {
  const width = Math.max(BODY_WIDTH, player.width ?? BODY_WIDTH);
  const height = Math.max(BODY_HEIGHT, player.height ?? BODY_HEIGHT);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width > 16 || height > 32) return false;
  const half = width / 2, eps = 0.0001, g = sim.g;
  const lo = [Math.floor(feet.x - half + eps), Math.floor(feet.y), Math.floor(feet.z - half + eps)];
  const hi = [Math.floor(feet.x + half - eps), Math.ceil(feet.y + height) - 1, Math.floor(feet.z + half - eps)];
  if (lo[0] < 0 || lo[1] < 1 || lo[2] < 0 || hi[0] >= g.nx || hi[1] >= g.ny || hi[2] >= g.nz) return false;
  const clear = (id, support) => support ? ELEMENTS[id]?.kind === K.SOLID : id === E.EMPTY;
  // V2: its own cells' ids in one read (sim.readNativeIds: the physical view, so a liquid film is
  // liquid, not the drawn projection's empty), not V1's projection exported and read cell by cell.
  if (sim.compact?.isReady) {
    const ids = await sim.readNativeIds();
    for (let x = lo[0]; x <= hi[0]; x++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1] - 1; y <= hi[1]; y++) if (!clear(ids[sim.cellTexel(x, y, z)], y === lo[1] - 1)) return false;
    }
    return true;
  }
  const reads = [];
  for (let x = lo[0]; x <= hi[0]; x++) for (let z = lo[2]; z <= hi[2]; z++) {
    for (let y = lo[1] - 1; y <= hi[1]; y++) {
      const support = y === lo[1] - 1;
      reads.push(sim.readCell(x, y, z).then(([a]) => clear(Math.round(a[0]), support)));
    }
  }
  return (await Promise.all(reads)).every(Boolean);
}

// Adapter: {getWorld,getSim,getMode,getPlayer,active,withVillageFocus,
// requestRender,notify}. withVillageFocus(at:[worldX,worldZ],valid,visit) must
// hold exclusive streaming focus until visit resolves. Repeated requests are
// rejected rather than overlapping journeys. cancel() restores departure;
// invalidate() irrevocably releases the body's lifecycle ownership.
export function createCityBus(adapter) {
  let journey = null, disposed = false;
  const { getWorld, getSim, getMode, getPlayer } = adapter;
  const available = () => !disposed && adapter.active() && getMode() === 'animalCrossing'
    && getWorld()?.scene.key === 'willowCove' && getWorld().loaded
    && getWorld().P.size[0] === 3072 && !getPlayer()?.dead;
  function nearby() {
    if (!available() || journey) return null;
    const world = getWorld(), player = getPlayer();
    if (!player) return null;
    const p = player.pos.clone().add(getSim().origin);
    return Object.keys(CITY_BUS_STOPS).find(key => {
      const at = worldPoint(CITY_BUS_STOPS[key].arrival, world);
      return Math.abs(p.y - at.y) <= 2 && Math.hypot(p.x - at.x, p.z - at.z) <= (key === 'town' ? 22 : 9);
    }) ?? null;
  }
  function freeze(input) {
    if (!journey || !journey.same()) return;
    if (input) {
      input.move.x = input.move.z = 0;
      for (const k of ['jump', 'chargeJump', 'sprint', 'down', 'crouch']) input[k] = false;
      input.cancelJump = true;
    }
    journey.player.cancelJump?.();
    journey.player.pos.copy(journey.source).sub(journey.sim.origin);
    journey.player.vel.set(0, 0, 0);
  }
  async function board(from = nearby()) {
    if (!from || from !== nearby() || journey || !available()) return { ok: false, reason: 'unavailable' };
    const world = getWorld(), sim = getSim(), player = getPlayer(), epoch = world.epoch;
    // Lifecycle rejection is permanent for this ticket. The same body can
    // respawn/reactivate while arrival reads are pending; it is then no longer
    // owned by the old journey, even if all current conditions match again.
    let invalidated = false;
    const same = () => {
      if (invalidated) return false;
      invalidated = !(!disposed && getWorld() === world && getSim() === sim && world.epoch === epoch
        && world.loaded && adapter.active() && getMode() === 'animalCrossing' && getPlayer() === player && !player.dead);
      return !invalidated;
    };
    const ticket = { same, invalidate() { invalidated = true; }, sim, player,
      source: player.pos.clone().add(sim.origin), cancelled: false };
    journey = ticket; freeze(); adapter.requestRender();
    const valid = () => journey === ticket && !ticket.cancelled && same();
    const dest = worldPoint(CITY_BUS_STOPS[CITY_BUS_STOPS[from].destination].arrival, world);
    let arrived = false, reason = 'cancelled';
    try {
      arrived = await adapter.withVillageFocus([dest.x, dest.z], valid, async current => {
        const origin = sim.origin.clone(), feet = dest.clone().sub(origin);
        const clear = await cityBusArrivalClear(sim, feet, player);
        if (!valid() || !current() || !sim.origin.equals(origin)) return false;
        if (!clear) { reason = 'blocked'; return false; }
        // Keep holding the actual departure if teleport refuses or throws.
        // Successful teleport alone transfers the held anchor to the arrival.
        const teleported = player.teleport(feet);
        if (teleported) ticket.source.copy(dest);
        return teleported;
      });
      if (!arrived && !ticket.cancelled && reason !== 'blocked') reason = 'unavailable';
    } catch { reason = 'failed'; }
    finally {
      // On cancel/blocked arrivals bring the existing window back to the
      // departure body. Never touch a replacement world or changed mode.
      if (!arrived && same()) {
        try { await adapter.withVillageFocus([ticket.source.x, ticket.source.z], same, () => true); }
        catch { reason = 'failed'; }
      }
      if (journey === ticket) { freeze(); journey = null; }
      adapter.requestRender();
    }
    if (!arrived && reason !== 'cancelled' && same()) adapter.notify?.(reason === 'blocked'
      ? 'The bus arrival is blocked or unsupported. Clear the landing and try again.' : 'The bus could not travel. Please try again.');
    return { ok: !!arrived, reason: arrived ? 'arrived' : reason };
  }
  return {
    nearby, board, freeze,
    get busy() { return !!journey; },
    get holding() { return !!journey && journey.same(); },
    cancel() { if (journey) journey.cancelled = true; },
    invalidate() { journey?.invalidate(); },
    dispose() { disposed = true; journey?.invalidate(); },
  };
}
