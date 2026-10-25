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
      onInspect: (key) => app.inspectElement(key),
    });
  },
  attach(app) { app.signs.clear(); app.signs.rebuild(); },
  beforeView(app) {
    app.signs.update();
  },
};

export default signs;
