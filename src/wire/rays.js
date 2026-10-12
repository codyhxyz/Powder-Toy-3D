// Photons and neutrons (src/raysLayer.js, src/rays.js; docs/webgpu.md G3,
// U12): the particle layer the simulation steps (sim.attachRays: a layer per
// grid) and its sprites. The sprites draw in our scene pass right after the
// volume (scene, order 0: depth-tested against it and three's opaque meshes,
// writing no depth), where the WebGL build drew them (renderOrder 1), not in
// an E2 overlay pass: app.js opens that pass on every presented frame once a
// ready wire has an overlay hook, and an empty pass that loads and stores the
// scene target isn't free on a tiled GPU.
import { Rays } from '../raysLayer.js';

const rays = {
  name: 'rays',
  ready: true,
  order: 0,

  attach(app) { app.sim.attachRays(new Rays(app.sim)); },
  detach(app) {
    const layer = app.sim.rays;
    app.sim.attachRays(null);
    layer.dispose?.();
  },
  // the sprites' size: px per cell at unit distance, for the scene target's height
  beforeView(app) {
    app.volume.updateMatrixWorld();
    app.sim.rays.updateView?.(app.camera, app.post.sceneTarget.height || app.canvas.height * app.post.renderScale, app.volume.matrixWorld);
  },
  scene(app, rp) {
    const t = app.post.sceneTarget;
    app.sim.rays.draw?.(rp, { width: t.width, height: t.height });
  },
  // particles fly between frames: the loop keeps ticking while any may be alive
  busy(app) { return !!app.sim.rays.active; },
};

export default rays;
