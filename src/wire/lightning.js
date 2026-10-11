// The Lightning tool's bolts and storms' (src/lightning.js, src/bolt.js;
// docs/webgpu.md G4, U12): the bolt is an edit, the storm's search a probe.
// Moved here from app.js as it was (WebGL): U12 ports it. Until then app.js
// greys out the Lightning tool and storms don't strike.
import { createLightning } from '../lightning.js';

const lightning = {
  name: 'lightning',
  ready: false,

  boot(app) { app.lightning = createLightning({ renderer: app.renderer }); },
  // storms: charged cloud strikes by itself (src/lightning.js)
  afterStep(app) { if (app.stepping) app.lightning.update(app.sim); },
};

export default lightning;
