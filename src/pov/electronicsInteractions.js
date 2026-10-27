import { Vector3 } from 'three';
import { E } from '../elements.js';
import { HAND_REACH } from './constants.js';

const services = new WeakMap();
export const isPhysicalControl = id => Number.isInteger(id) && (id === E.SWITCH || id === E.BUTTON);
const fail = (reason, matched = false) => ({ ok: false, matched, reason });
const xyz = p => [p.x, p.y, p.z];
const same = (a, b) => a.every((n, i) => n === b[i]);

// Only actual physical contacts enter this lane. Continue the original blow
// after activation, without editing a replacement scene or stealing authority.
export function beforeControlContact(sim, hit, source, after, options) {
  if (!Number.isInteger(hit?.id) || hit.id < 0 || !hit.cell) return false;
  const service = services.get(sim);
  if (!service || (!isPhysicalControl(hit.id) && !service.busy)) return false;
  void service.contact(hit, source, after, options);
  return true;
}

export function createElectronicsInteractions({ getSim, getWorld, getSceneKey,
  canMutate, guestUse, pickRay, parts, requestRender = () => {}, rejectContact = () => {} }) {
  let epoch = 0, disposed = false, bound = null;
  let queue = Promise.resolve(), ownedPending = null, commitGuard = null;
  const jobs = new Set(), contacts = new Set();
  function bind() {
    const sim = getSim();
    if (bound !== sim) {
      if (bound && services.get(bound) === api) services.delete(bound);
      bound = sim;
      if (sim && !disposed) services.set(sim, api);
    }
  }
  function snapshot() {
    bind();
    const sim = getSim(), world = getWorld();
    if (disposed || !sim || sim.disposed) return null;
    return { sim, world, scene: world?.scene, identity: world?.historyIdentity,
      worldEpoch: world?.epoch, owner: sim.compactOwner, sceneKey: getSceneKey(),
      origin: xyz(sim.origin), epoch };
  }
  function current(c, allowShift = false) {
    return !disposed && c.epoch === epoch && getSim() === c.sim && !c.sim.disposed
      && getWorld() === c.world && c.world?.scene === c.scene
      && c.world?.historyIdentity === c.identity && c.world?.epoch === c.worldEpoch
      && c.sim.compactOwner === c.owner && getSceneKey() === c.sceneKey
      && (allowShift || same(xyz(c.sim.origin), c.origin));
  }
  const resident = (c, p) => p.every((n, i) => Number.isInteger(n)
    && n >= c.origin[i] && n < c.origin[i] + [c.sim.g.nx, c.sim.g.ny, c.sim.g.nz][i]);
  function run(work, authority = () => true, contact = false) {
    const c = snapshot();
    if (!c) return Promise.resolve(fail('No current scene', true));
    const foreign = c.world?.pending && c.world.pending !== ownedPending ? c.world.pending : null;
    if (foreign && !contact) return Promise.resolve(fail('World transaction in progress', true));
    let admitted = null;
    const valid = () => current(admitted ?? c, !admitted && contact) && authority();
    const op = queue.then(async () => {
      // Keep frozen world coordinates while a foreign transaction owns the
      // window. Acquire its barrier synchronously only after it releases.
      while (c.world?.pending && c.world.pending !== ownedPending) {
        await c.world.pending;
        if (!valid()) return fail('Scene or authority changed', true);
      }
      if (!valid()) return fail('Scene or authority changed', true);
      admitted = snapshot();
      if (c.world) c.world.pending = job;
      ownedPending = job;
      return work(admitted, valid);
    });
    let job;
    job = op.catch(error => fail(error?.message ?? 'Control activation failed', true)).then(result => {
      if (contact && !result.continued) rejectContact(result.reason);
      return result;
    }).finally(() => {
      jobs.delete(job);
      if (c.world?.pending === job) c.world.pending = null;
      if (ownedPending === job) ownedPending = null;
    });
    jobs.add(job); queue = job;
    if (!foreign && !ownedPending) { ownedPending = job; if (c.world) c.world.pending = job; }
    requestRender(); return job;
  }
  async function activate(c, worldCell, material, valid) {
    if (!valid() || !canMutate()) return fail('Not authoritative', true);
    if (!isPhysicalControl(material) || !resident(c, worldCell)) return fail('Control is outside the loaded simulation', true);
    const p = worldCell.map((n, i) => n - c.origin[i]);
    const guard = () => valid() && canMutate();
    commitGuard = guard;
    let result;
    try { result = await parts.activate({ x: p[0], y: p[1], z: p[2], material }); }
    finally { if (commitGuard === guard) commitGuard = null; }
    if (!guard()) return fail('Scene or authority changed', true);
    requestRender();
    return { ...result, matched: true };
  }
  function useRay(eye, direction, { source = 'use', expected = null, authority = () => true } = {}) {
    const c = snapshot();
    if (!c) return Promise.resolve(fail('No current scene', true));
    const worldEye = xyz(eye).map((n, i) => n + c.origin[i]);
    const dir = new Vector3().copy(direction);
    if (!worldEye.every(Number.isFinite) || !Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-12) return Promise.resolve(fail('Invalid activation ray'));
    dir.normalize();
    return run(async (s, valid) => {
      const ro = new Vector3(...worldEye.map((n, i) => n - s.origin[i]));
      const hit = await pickRay(ro, dir, false, false);
      if (!valid()) return fail('Scene or authority changed', true);
      if (!hit?.valid || !isPhysicalControl(hit.id)) return fail('No physical control on ray');
      const cell = xyz(hit.cell).map((n, i) => n + s.origin[i]);
      if (expected && (expected.material !== hit.id || !same(cell, expected.cell))) return fail('Contact changed', true);
      if (!resident(s, cell)) return fail('Control is outside the loaded simulation', true);
      const center = new Vector3(...cell).addScalar(0.5);
      if (source !== 'god' && center.distanceTo(new Vector3(...worldEye)) > HAND_REACH) return fail('Control is out of reach', true);
      if (!canMutate()) {
        if (!['use', 'god'].includes(source) || !guestUse) return fail('Host authority required', true);
        return { ok: !!guestUse({ cell, material: hit.id, source,
          actionRay: { eye: worldEye.slice(), dir: dir.toArray() } }),
        matched: true, reason: 'Activation requested from host' };
      }
      return activate(s, cell, hit.id, valid);
    }, authority);
  }
  function contact(hit, source, after, { valid: instanceValid = () => true, cancel = () => {} } = {}) {
    let cancelled = false;
    const cancelOnce = () => {
      if (cancelled) return;
      cancelled = true; contacts.delete(cancelOnce); cancel();
    };
    const authority = () => !cancelled && instanceValid() && canMutate();
    if (!['melee', 'ballistic'].includes(source)) {
      cancelOnce(); return Promise.resolve(fail('Invalid physical contact'));
    }
    const c = snapshot();
    if (!c || !authority()) {
      cancelOnce(); return Promise.resolve(fail('Host authority required', true));
    }
    contacts.add(cancelOnce);
    const worldCell = xyz(hit.cell).map((n, i) => n + c.origin[i]), material = hit.id;
    return run(async (s, valid) => {
      if (!resident(s, worldCell)) return fail('Queued contact left the loaded simulation', true);
      const result = isPhysicalControl(material) ? await activate(s, worldCell, material, valid)
        : { ok: true, matched: false };
      if (valid() && authority()) {
        after?.(new Vector3(...c.origin.map((n, i) => n - s.origin[i])));
        return { ...result, continued: true };
      }
      return fail('Scene or authority changed', true);
    }, authority, true).then(result => {
      if (!result.continued) cancelOnce();
      contacts.delete(cancelOnce);
      return result;
    });
  }
  const api = {
    bind, useRay, contact,
    get generation() { return epoch; },
    get pending() { return jobs.size; },
    get busy() { return jobs.size > 0 || !!getWorld()?.pending; },
    get canCommit() { return !!commitGuard?.(); },
    async settle() { while (jobs.size) await Promise.all([...jobs]); },
    reset() { epoch++; for (const cancel of [...contacts]) cancel(); parts.reset(); bind(); },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++;
      for (const cancel of [...contacts]) cancel();
      parts.dispose();
      if (bound && services.get(bound) === api) services.delete(bound);
    },
  };
  bind();
  return api;
}
