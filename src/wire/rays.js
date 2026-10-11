// Photons and neutrons (src/raysLayer.js, src/rays.js; docs/webgpu.md G3,
// U12): the particle layer the simulation steps (sim.attachRays) and its
// sprites, drawn in E2's overlay pass after three's meshes. Moved here from
// app.js and the WebGL sim's constructor as they were: U12 ports it. Until
// then the simulation runs with its inactive stand-in (sim.js NO_RAYS) and
// app.js greys out the particle tools.
import { Rays } from '../raysLayer.js';
import { quadVert } from '../shaders/common.js';

const rays = {
  name: 'rays',
  ready: false,

  attach(app) {
    app.sim.attachRays(new Rays(app.sim, quadVert));
    app.volume.add(app.sim.rays.view);   // photons and neutrons as points, in grid cells (raysLayer.js)
  },
  detach(app) { app.volume.remove(app.sim.rays.view); },
  beforeView(app) { app.sim.rays.updateView(app.camera, app.canvas.height * app.post.renderScale); },
  overlay(app, rp) { app.sim.rays.draw?.(rp); },
  busy(app) { return !!app.sim.rays.active; },
};

export default rays;
