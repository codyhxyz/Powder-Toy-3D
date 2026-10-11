// Whitewater (gfx/foam.js; docs/webgpu.md G4, U12): the aeration field the
// move feeds while the Whitewater detail switch is on (sim.attachAeration),
// which the volume and the derived passes read. Moved here from app.js as it
// was (WebGL): U12 ports it. Until then the switch changes only the view's
// detail, which reads an empty field.
import { setAeration } from '../gfx/foam.js';
import { DETAIL, settingKey } from '../gfx/detail.js';

const DETAIL_FOAM = DETAIL.find((f) => f.key === 'liquidFoam');   // whitewater also runs a field with the sim

const foam = {
  name: 'foam',
  ready: false,

  attach(app) { foam.detail(app); },
  // whitewater's per-step field, and the volume's binding of it
  detail(app) {
    setAeration(app.sim, !!app.settings[settingKey(DETAIL_FOAM)]);
    app.vol.attachAeration(app.sim.aeration?.active ? app.sim.aeration.buffer : null);
  },
  busy(app) { return !!app.sim.aeration?.active && !app.sim.idleCertified; },
};

export default foam;
