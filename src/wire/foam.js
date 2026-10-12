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
  // While whitewater runs, the frame loop keeps ticking: even a certified-idle
  // step runs aeration's idle step, so the foam left on still water bursts
  // (sim.js step; docs/webgpu.md D1, G4), and a sleeping loop would freeze it
  // mid-burst. U12: narrow this to "the field still holds foam" (a count its
  // list kernel reads back), so a settled box with whitewater on can sleep.
  busy(app) { return !!app.sim.aeration?.active; },
};

export default foam;
