import { E } from '../../src/elements.js';

// Same live app/device/state for A/B. Ownership switches BEFORE derived fields.
// GPU pass sums exclude copies, compositor work and work on other devices.
export async function run(a, { warmup = 6, frames = 24 } = {}) {
  const assert = (v, why) => { if (!v) throw new Error(why); };
  assert(a.hybrid && a.gpu.timing.supported, 'hybrid and hardware timestamps required');
  a.test.park();
  a.settings.paused = true;
  a.settings.upscale = 'native';
  a.autoRes.enabled = false;
  a.autoRes.scale = 1;
  a.day.fixed = { az: 215, el: 38 };
  const { gpu, hybrid, post } = a, timing = gpu.timing;
  const prepare = hybrid.prepare, drawPost = post.render, oldPass = timing.onPass, oldFrame = timing.onFrame;
  let mode = 'hybrid', tag = '', sceneName = '', edit = false;
  const trials = [], byTag = new Map();
  const V = a.THREE.Vector3;
  const eye = new V(64, 48, 116), target = new V(64, 32, 84);
  const model = a.volume.matrixWorld.clone(), up = new V(0, 1, 0);
  const gridToDisplay = p => p.clone().applyMatrix4(model);
  const showCamera = i => {
    const p = eye.clone().sub(target).applyAxisAngle(up, 0.025 * Math.sin(i / 10)).add(target);
    a.camera.position.copy(gridToDisplay(p));
    a.controls.target.copy(gridToDisplay(target));
    a.camera.lookAt(a.controls.target);
    a.camera.updateMatrixWorld();
  };
  hybrid.prepare = function (frame) { return prepare.call(this, { ...frame, disabled: mode === 'legacy' || frame.disabled }); };
  post.render = function (...args) {
    const start = performance.now();
    try { return drawPost.apply(this, args); }
    finally { if (byTag.has(tag)) byTag.get(tag).cpu.push(performance.now() - start); }
  };
  timing.onPass = p => { oldPass?.(p); p.phase = tag; };
  timing.onFrame = f => {
    oldFrame?.(f);
    const tags = new Set(f.passes.map(p => p.phase));
    if (tags.size !== 1) return;
    const trial = byTag.get([...tags][0]);
    if (!trial || !f.passes.some(p => p.name === 'scene')) return;
    if (!f.coverage.complete || f.gpu == null) { trial.invalid++; return; }
    const sum = name => f.passes.filter(p => p.name === name).reduce((n, p) => n + p.gpu, 0);
    trial.gpu.push(f.gpu);
    trial.scene.push(sum('scene'));
    trial.raster.push(sum('hybrid opaque surfaces and particles'));
    trial.sun.push(sum('hybrid sun shadows'));
    if (trial.mode === 'hybrid' && !f.passes.some(p => p.name === 'hybrid opaque surfaces and particles')) trial.missingRaster++;
  };
  const cube = (id, radius, center, erase = false) => a.sim.paint({
    center: new V(...center), radius, shape: 1, tool: id, rate: 1, replace: true, erase,
  });
  const snapshot = () => ({
    builds: hybrid.geometry.stats.builds, shadows: hybrid.shadows.stats.passes, version: a.sim.version,
    pipelines: gpu.stats.pipelinesCreated,
  });
  timing.split = false;
  timing.enabled = true;
  const initialStep = a.sim.frame;
  try {
    for (const scene of [
      { name: 'opaque wall', id: E.WALL },
      { name: 'smooth sand control', id: E.SAND },
      { name: 'changing wall', id: E.WALL, edit: true },
    ]) {
      sceneName = scene.name; edit = !!scene.edit;
      mode = 'hybrid'; tag = '';
      a.loadPreset('empty', false);
      cube(scene.id, 28, [64, 32, 64]);
      showCamera(0);
      await a.test.ready();
      await a.test.render();
      await gpu.readback.idle();
      assert(!hybrid.stats.reason && !hybrid.geometry.stats.fallbackRequired, JSON.stringify(hybrid.stats));
      const argsRead = gpu.readback.buffer(hybrid.geometry.resources.args, 0, 16);
      gpu.flush('hybrid benchmark ownership');
      const faces = new Uint32Array(await argsRead)[1];
      assert(scene.id === E.WALL ? faces > 0 : faces === 0, `wrong mesh ownership in ${sceneName}: ${faces}`);
      // ABBA controls short-term drift; all trials use the same camera trace.
      for (const [index, selected] of ['legacy', 'hybrid', 'hybrid', 'legacy'].entries()) {
        mode = selected;
        post.reset();
        const trial = { workload: sceneName, mode, index, faces, gpu: [], scene: [], raster: [], sun: [], cpu: [],
          invalid: 0, missingRaster: 0, edits: 0 };
        const measureTag = `${sceneName}/${index}/${mode}`;
        byTag.set(measureTag, trial);
        trials.push(trial);
        tag = `warm/${measureTag}`;
        let i = 0, lastView = -1, before;
        await new Promise((resolve, reject) => {
          const next = () => {
            try {
              if (i === warmup) { tag = measureTag; before = snapshot(); }
              if (i >= warmup + frames) { tag = ''; a.test.park(); resolve(); return; }
              showCamera(i);
              // One synthetic surface edit per observed app draw, not per
              // unconstrained callback. Physics remains paused in both paths.
              if (edit && a.view.frame !== lastView) {
                lastView = a.view.frame;
                cube(E.WALL, 18, [64, 32, 92], (i & 1) === 0);
                if (i >= warmup) trial.edits++;
              }
              i++;
              requestAnimationFrame(next);
            } catch (error) { a.test.park(); reject(error); }
          };
          requestAnimationFrame(next);
          a.test.resume();
        });
        await gpu.fence();
        await timing.settled();
        await gpu.readback.idle();
        const after = snapshot();
        trial.builds = after.builds - before.builds;
        trial.shadowPasses = after.shadows - before.shadows;
        trial.versionChanges = after.version - before.version;
        trial.pipelineBuilds = after.pipelines - before.pipelines;
        trial.canvas = [a.renderer.domElement.width, a.renderer.domElement.height];
        trial.scale = post.renderScale;
        assert(trial.gpu.length >= 12 && !trial.invalid, `insufficient/invalid timing coverage: ${sceneName} ${mode} ${trial.gpu.length}/${trial.invalid}`);
        assert(!trial.pipelineBuilds, `cold pipelines entered measured interval: ${sceneName} ${mode}`);
        assert(!gpu.failure && a.view.renderView === 0, `GPU/view error: ${gpu.failure}`);
        assert(mode !== 'hybrid' || !trial.missingRaster, `hybrid fell back while timing ${sceneName}`);
        assert(trial.canvas[0] === 1280 && trial.canvas[1] === 800 && trial.scale === 1, 'render size changed');
      }
    }
    assert(a.sim.frame === initialStep, 'renderer benchmark advanced physics');
    return {
      trials, grid: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], geometryBytes: hybrid.geometry.stats.bytes,
      physicsSteps: a.sim.frame - initialStep, splitCompute: timing.split,
      quality: { upscale: a.settings.upscale, gfx: { ...a.gfx } },
      method: 'ABBA, moving camera, normal visual cadence, paused physics, unsplit GPU pass timestamps; not quality-equivalent or sustained FPS',
    };
  } finally {
    tag = ''; a.test.park();
    await gpu.fence().catch(() => {});
    await timing.settled();
    timing.enabled = false;
    timing.onPass = oldPass; timing.onFrame = oldFrame;
    hybrid.prepare = prepare; post.render = drawPost;
  }
}
