// Signs (src/signs.js; docs/webgpu.md G4, U12): text pinned to cells, kept on
// the surface they were put on by a probe of the state (a kernel whose
// results come back through a readback ring).
import { Signs } from '../signs.js';

const signs = {
  name: 'signs',
  ready: true,

  boot(app) {
    const signLayer = Object.assign(document.createElement('div'), { className: 'sign-layer' });
    Object.assign(signLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 4 });
    document.body.append(signLayer);
    app.signs = new Signs({
      renderer: app.renderer, camera: app.camera, container: signLayer,
      getSim: () => app.sim, getVolume: () => app.volume,
      onChange: () => {},
    });
  },
  attach(app) { app.signs.clear(); app.signs.rebuild(); },
  beforeView(app) {
    // Future App contract: win.render.signsOwner === 'world' is exclusive,
    // signFrame is the accepted completion envelope documented in world-signs.md.
    // No accepted frame means retain accepted UI/loading, NEVER probe BOX.
    // Intentional (the WORLD frame probes a big map's signs: worldRenderFrame.js signRequest).
    if (app.win?.render) {
      app.signs.setWorldOwner(true);
      // Atomic results/projection are committed by the accepted frame driver.
    } else {
      app.signs.setWorldOwner(false);
      app.signs.update();
    }
  },
};

export default signs;
