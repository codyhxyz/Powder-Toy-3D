// Photons, neutrons and the rest of V2's flying matter (v2/dynamics.js particles; src/rays.js; docs/webgpu.md
// G3, U12): their sprites (gfx/nativeParticles.js). The sprites draw in our scene pass right after the
// volume (scene, order 0: depth-tested against it and three's opaque meshes,
// writing no depth), where the WebGL build drew them (renderOrder 1), not in
// an E2 overlay pass: app.js opens that pass on every presented frame once a
// ready wire has an overlay hook, and an empty pass that loads and stores the
// scene target isn't free on a tiled GPU.
// V1's photon layer (raysLayer.js) went with V1: the same particles and sprites, V2's owner.
import { NativeParticles, boxParticleLight, worldParticleLight } from '../gfx/nativeParticles.js';
import { particleLagSeconds } from '../v2/host.js';

function nativeLayer(app) {
  const source = app.sim.compactOwner?.dynamics;
  if (!source || source.disposed) return null;
  if (app.nativeParticles?.source !== source) {
    app.nativeParticles?.dispose();
    const layer = app.nativeParticles = new NativeParticles(app.sim.gpu, source);
    layer.ready.then(() => app.pacer?.wake(), () => {});
  }
  return app.nativeParticles;
}

const rays = {
  name: 'rays',
  ready: true,
  order: 0,

  attach(app) { nativeLayer(app); },
  detach(app) { app.nativeParticles?.dispose(); app.nativeParticles = null; },
  // the sprites' size: px per cell at unit distance, for the scene target's height
  beforeView(app) {
    app.volume.updateMatrixWorld();
    const native = app.sim.compact ? nativeLayer(app) : null;
    const height = app.post.sceneTarget.height || app.canvas.height * app.post.renderScale;
    if (native) {
      // (between ticks, a share of a tick behind their records, so they move every frame: v2/host.js
      // particleLagSeconds; a replica's records are the host's, and it runs no ticks of its own)
      native.updateView(app.camera, height, app.volume.matrixWorld, app.sim.origin, { lagSeconds: particleLagSeconds(app.sim, !app.mp?.replica) });
      if (native.isReady) native.prepareDraw(); // compute must precede the scene pass
    }
  },
  // (Not bent by a presentation effect yet, as main's Points were: the
  // sprites' vertex stage, shaders/v2/particleRender.js, would warp each particle's world
  // cell with presentationWGSL's warpPoint before projecting it, from the
  // parameters app.presentation holds while active: U12's.)
  scene(app, rp) {
    const t = app.post.sceneTarget;
    // (the volume's light, as V1's flying cells take it: the Box's sun map and GI, from the GPU volume, app.vol, not
    // the three Object3D app.volume, which holds only its matrix; on frames the world march draws, L's world light)
    if (app.sim.compact && app.nativeParticles?.isReady) {
      const light = app.worldLight ? worldParticleLight(app.worldLight, app.vol, app.sim.gpu) : boxParticleLight(app.vol, app.derived, app.sim.gpu);
      app.nativeParticles.draw(rp, t, light);
    }
  },
  // particles fly between frames: the loop keeps ticking while any may be
  // alive, unless paused (they fly only with the steps; a load wakes the layer
  // until a sweep finds it empty, which a paused box would never run)
  busy(app) {
    const native = app.sim.compact?.dynamics;
    return !!native && !app.settings.paused && native.isIdle !== true;
  },
};

export default rays;
