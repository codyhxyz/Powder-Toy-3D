// The Lightning tool's bolts and storms' (src/lightning.js, src/bolt.js;
// docs/webgpu.md G4, U12): the bolt is an edit, the storm's search a kernel
// whose result comes back through a readback ring.
import { createLightning } from '../lightning.js';

const lightning = {
  name: 'lightning',
  ready: true,

  // (a search that found a cloud needs a tick to scan or strike, not a redrawn view: the strike's own write
  // draws it. pacer.wake here re-rendered the view's settle frames after every 4 Hz search, clear sky too.)
  boot(app) { app.lightning = createLightning({ onReady: () => app.wakeLoop() }); },
  detach(app) { app.lightning?.reset(); },
  // storms: charged cloud strikes by itself (src/lightning.js)
  afterStep(app) {
    // (the storm keeps game time under either engine: lightning.js stormNow, v2/host.js stepClock)
    if (app.stepping) app.lightning.update(app.sim, { worldEpoch: app.win?.epoch, worldIdentity: app.win });
  },
};

export default lightning;
