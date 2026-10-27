import { createFactoryControlParts } from '../industry/controlParts.js';
import { createElectronicsInteractions, isPhysicalControl } from '../pov/electronicsInteractions.js';

const removeInput = new WeakMap(), remote = new WeakMap();
export default {
  name: 'electronics', ready: true,
  boot(app) {
    const parts = createFactoryControlParts({ getSim: () => app.sim,
      isCurrent: () => !!app.electronics?.canCommit });
    app.electronics = createElectronicsInteractions({
      getSim: () => app.sim, getWorld: () => app.win,
      getSceneKey: () => JSON.stringify([app.settings.preset, app.settings.scene, app.worldSeed]),
      canMutate: () => !app.mp?.replica,
      guestUse: intent => app.mp?.requestControlUse?.(intent) ?? false,
      pickRay: (...args) => app.pickRay(...args), parts,
      requestRender: () => app.requestRender(),
      rejectContact: reason => app.hud.toast(reason),
    });
    const key = e => {
      if (e.defaultPrevented || e.code !== 'KeyE' || e.repeat || e.ctrlKey || e.metaKey || e.altKey
          || app.isTyping() || app.pov?.active || !app.pointerInside || app.uiHover
          || app.painting || app.industry?.building || !app.hover.valid || !isPhysicalControl(app.hover.id)) return;
      e.preventDefault();
      const sim = app.sim, cell = app.hover.cell.clone(), material = app.hover.id;
      const ray = app.actionRay();
      const eye = ray.origin.clone().add(sim.origin), dir = ray.direction.clone();
      const expected = { cell: cell.add(sim.origin).toArray(), material };
      const resident = expected.cell.every((n, i) => n >= sim.origin.toArray()[i]
        && n < sim.origin.toArray()[i] + [sim.g.nx, sim.g.ny, sim.g.nz][i]);
      if (!resident) {
        // Reuse normal worldAim admission without pinning the very window
        // movement needed to make this target resident.
        if (app.mp?.replica || !app.workAt(expected.cell[0], expected.cell[2])) {
          app.hud.toast('Control is outside the loaded simulation'); return;
        }
        remote.set(app, { sim, win: app.win, identity: app.win?.historyIdentity, epoch: app.win?.epoch,
          generation: app.electronics.generation,
          key: JSON.stringify([app.settings.preset, app.settings.scene, app.worldSeed]),
          eye, dir, expected, until: performance.now() + 10000 });
        app.requestRender(); return;
      }
      void app.electronics.useRay(eye.sub(sim.origin), dir, { source: 'god', expected }).then(result => {
        if (!result.ok && app.sim === sim) app.hud.toast(result.reason);
      });
    };
    addEventListener('keydown', key);
    removeInput.set(app, () => removeEventListener('keydown', key));
  },
  attach(app) { app.electronics?.bind(); },
  detach(app) { remote.delete(app); app.electronics?.reset(); },
  afterStep(app) {
    const r = remote.get(app); if (!r) return;
    if (app.sim !== r.sim || app.electronics?.generation !== r.generation
        || app.win !== r.win || r.win?.historyIdentity !== r.identity
        || r.win?.epoch !== r.epoch || app.mp?.replica || app.pov?.active
        || JSON.stringify([app.settings.preset, app.settings.scene, app.worldSeed]) !== r.key
        || performance.now() > r.until) {
      remote.delete(app); app.hud.toast('Remote control activation cancelled'); return;
    }
    const o = app.sim.origin.toArray(), g = app.sim.g;
    if (app.win?.pending || !r.expected.cell.every((n, i) => n >= o[i] && n < o[i] + [g.nx, g.ny, g.nz][i])) return;
    remote.delete(app);
    void app.electronics.useRay(r.eye.clone().sub(app.sim.origin), r.dir,
      { source: 'god', expected: r.expected }).then(result => { if (!result.ok) app.hud.toast(result.reason); });
  },
  busy(app) { return remote.has(app) || !!app.electronics?.pending; },
  invalidate(app) {
    remote.delete(app); removeInput.get(app)?.(); removeInput.delete(app);
    app.electronics?.dispose(); app.electronics = null;
  },
};
