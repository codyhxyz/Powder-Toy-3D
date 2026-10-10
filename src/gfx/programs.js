import * as THREE from 'three';

// Shader programs: claiming them ahead of the first draw, and compiling them
// in the background.
//
// three keeps one program per distinct shader source (and the parameters it
// depends on) while any live material uses it. Materials made to replace
// others (a rebuilt grid) claim their programs before the old materials are
// disposed of, so a program both use carries over instead of being deleted
// and compiled again (app.js build). Compiling a big program is seconds of
// ANGLE/Metal work, done synchronously on the first draw unless it was started
// ahead with KHR_parallel_shader_compile (compileInBackground).

const QUAD = new THREE.PlaneGeometry(2, 2);
const CAMERA = new THREE.Camera();
// A ShaderMaterial's program depends on whether a render target is bound (its
// output colour space): the view draws into post's, so claims bind one too.
const TARGET = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });

function sceneOf(materials, geometry) {
  const s = new THREE.Scene();
  for (const m of materials) {
    const o = new THREE.Mesh(geometry, m);
    o.frustumCulled = false;
    s.add(o);
  }
  return s;
}

// Claim the programs of materials now: the ones another live material already
// has are shared, the rest start compiling (without waiting for them).
// geometry: what they draw (full-screen passes: a quad); lights: the scene
// whose lights, fog and environment the materials see (their parameters).
export function claimPrograms(renderer, materials, { geometry = QUAD, lights = null } = {}) {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(TARGET);
  const s = sceneOf(materials, geometry);
  renderer.compile(s, CAMERA, lights ?? s);
  renderer.setRenderTarget(prev);
}

// Compile full-screen passes in the background (KHR_parallel_shader_compile):
// resolves once every one can be drawn without the page stalling on its compile.
export function compileInBackground(renderer, materials) {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(TARGET);
  const done = renderer.compileAsync(sceneOf(materials, QUAD), CAMERA);
  renderer.setRenderTarget(prev);
  return done;
}
