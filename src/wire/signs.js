// Signs (src/signs.js; docs/webgpu.md G4, U12): text pinned to cells, kept on
// the surface they were put on by a probe of the state (a kernel whose
// results come back through a readback ring).
import { Signs } from '../signs.js';
import { ScenePlaques } from '../lab/scenePlaques.js';
import { Vector3, Matrix4 } from 'three';

const eye = new Vector3(), inverse = new Matrix4();
const NO_PLAQUES = [];
let plaques;

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
    plaques = new ScenePlaques(app.signs);
  },
  attach(app) { app.signs.clear(); app.signs.rebuild(); },
  beforeView(app) {
    plaques.set(app.getScenePlaques?.() ?? NO_PLAQUES);
    app.camera.updateMatrixWorld();
    app.volume.updateMatrixWorld();
    eye.setFromMatrixPosition(app.camera.matrixWorld).applyMatrix4(inverse.copy(app.volume.matrixWorld).invert()).add(app.sim.origin);
    plaques.update(eye.toArray());
    app.signs.update();
  },
};

export default signs;
