// The Lightning tool's bolts and storms' (src/lightning.js, src/bolt.js;
// docs/webgpu.md G4, U12): the bolt is an edit, the storm's search a kernel
// whose result comes back through a readback ring.
import { createLightning, STORM_HZ } from '../lightning.js';
import { HOST_HZ } from '../v2/host.js';

const lightning = {
  name: 'lightning',
  ready: true,

  boot(app) { app.lightning = createLightning({ onReady: () => app.pacer.wake() }); },
  detach(app) { app.lightning?.reset(); },
  // storms: charged cloud strikes by itself (src/lightning.js)
  afterStep(app) {
    // (V2 ticks HOST_HZ times a second, V1 steps 4 a frame: wire/weather.js stepHz)
    if (app.stepping) app.lightning.update(app.sim, { worldEpoch: app.win?.epoch, worldIdentity: app.win, stepHz: app.sim.compact ? HOST_HZ : STORM_HZ });
  },
};

export default lightning;
