// Whitewater (gfx/foam.js; docs/webgpu.md G4): the aeration field the move
// feeds while the Whitewater detail switch is on (sim.attachAeration), which
// the volume (binding 19) and the derived passes read.
import { setAeration, dropAeration } from '../gfx/foam.js';
import { DETAIL, settingKey } from '../gfx/detail.js';

const DETAIL_FOAM = DETAIL.find((f) => f.key === 'liquidFoam');   // whitewater also runs a field with the sim

const foam = {
  name: 'foam',
  ready: true,

  attach(app) { foam.detail(app); },
  // the grid is going: its field with it
  detach(app) { if (app.sim) dropAeration(app.sim); },
  // whitewater's per-step field, on or off with the switch
  detail(app) {
    setAeration(app.sim, !!app.settings[settingKey(DETAIL_FOAM)]);
    foam.beforeView(app);
  },
  // the volume's binding of it: from the step its kernels are built (they
  // build in the background; until then the move runs in place and the view
  // reads no field)
  beforeView(app) {
    const aer = app.sim?.aeration;
    app.vol?.attachAeration(aer?.active ? aer.buffer : null);
  },
  // An idle world's steps still burst the foam left on it (sim.js step: its
  // idle step), for AER_IDLE_STEPS: until then the frame loop keeps ticking;
  // after, or paused, it may sleep.
  busy(app) { return !!app.sim?.aeration?.bursting && !app.settings.paused; },
};

export default foam;
