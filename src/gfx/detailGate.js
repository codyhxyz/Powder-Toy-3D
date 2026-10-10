// Distance gating for the close-up detail features (gfx/detail.js).
//
// A feature compiled into the view shader costs time even where it draws
// nothing: a bigger shader runs slower everywhere (registers, occupancy). So
// an expensive feature is only compiled in while the camera is close enough
// for it to show. Each feature declares fadeM, the pixel footprint (metres
// per pixel) above which it draws nothing. The smallest footprint anywhere on
// screen is bounded by the distance from the camera to the grid box: inside
// the box (POV mode) every feature is in.
//
// Every variant is a full compile of a very large shader, and ANGLE's Metal
// backend does the slow part (building the pipeline) synchronously on the
// first draw: about 0.5 s for the plain raymarcher, many seconds with every
// feature in. So there are only two variants:
//   base  the switched-on features gating can't help: low-cost ones, and
//         ones that show from any ordinary viewing distance (fadeM at or
//         above GATE_ALWAYS_M). They are in the view material as built.
//   near  base plus the rest, compiled in a holder material (sharing the view
//         material's shaders and uniforms, which keeps the program alive in
//         three's cache) and drawn once into a 1-pixel target of the view
//         target's formats at idle time, so the stall never lands on the frame
//         the camera walks up to something. Until it is ready the view keeps
//         the base variant: detail shows up late rather than the frame stalling.
// With the default (Balanced) switches every feature is in base: no extra
// compile at all.
import * as THREE from 'three';
import { DETAIL, settingKey } from './detail.js';
import { CELL_M } from '../scale.js';

// m per pixel. The god view's nearest surfaces are ~100 cells away (~2.7 cm
// per pixel at 1280×800): a feature that starts showing at or above this
// footprint is on screen from any ordinary view, so gating it saves nothing.
const GATE_ALWAYS_M = 0.05;
// Near comes in at the largest gated fadeM and goes out above it × this, so a
// camera hovering at the threshold doesn't flip variants every frame.
const GATE_HYSTERESIS = 1.25;
// ms after start-up (or a settings change) before the near variant compiles
const PREWARM_DELAY_MS = 1500;
// ms between telling the user a compile is coming and the stall, so the page
// paints the message first
const WARN_PAINT_MS = 100;
const DEG = Math.PI / 180;

const alwaysIn = (f) => f.cost === 'low' || f.fadeM === undefined || f.fadeM >= GATE_ALWAYS_M;
const definesOf = (features) => Object.fromEntries(features.map((f) => [f.define, 1]));
const keyOf = (d) => Object.keys(d).sort().join(',');

// onReady: the near variant is ready (the view should redraw).
// onCompile: a slow compile is about to stall the page (tell the user).
export function createDetailGate(renderer, onReady, onCompile) {
  let mat = null, mesh = null;      // the view material and its mesh
  let base = {}, near = {};         // define sets of the two variants
  let applied = {};                 // the base the view has switched to (a changed base waits WARN_PAINT_MS)
  let nearFadeM = 0;                // footprint below which near is wanted
  let wantNear = false;
  let holder = null;                // { mat, ready, key } compiling / holding the near program
  let timer = 0;
  // post.js's sceneRT formats: RGBA half float colour, float depth texture
  const dummy = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
  });
  const warmScene = new THREE.Scene();
  const idle = (fn) => (globalThis.requestIdleCallback ?? ((f) => setTimeout(f)))(fn);

  function dropHolder() {
    holder?.mat.dispose();
    holder = null;
  }

  function compileNear(camera, scene) {
    const key = keyOf(near);
    if (holder?.key === key || key === keyOf(base)) return;
    dropHolder();
    const h = {
      key, ready: false,
      mat: new THREE.ShaderMaterial({
        vertexShader: mat.vertexShader, fragmentShader: mat.fragmentShader, uniforms: mat.uniforms, defines: { ...near },
        side: mat.side, transparent: mat.transparent, depthWrite: mat.depthWrite,
        blending: mat.blending, blendSrc: mat.blendSrc, blendDst: mat.blendDst,
      }),
    };
    holder = h;
    // The view renders into post's HDR target: compile with a target bound so
    // the program's parameters (output colour space) match and it is reused.
    const o = new THREE.Mesh(mesh.geometry, h.mat);
    o.frustumCulled = false;
    o.matrixWorld.copy(mesh.matrixWorld);
    o.matrixAutoUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dummy);
    const done = renderer.compileAsync(o, camera, scene);
    renderer.setRenderTarget(prev);
    done.then(() => idle(() => {
      if (holder !== h) return;   // replaced meanwhile
      onCompile();
      setTimeout(() => {
        if (holder !== h) return;
        const before = renderer.getRenderTarget();
        warmScene.add(o);
        renderer.setRenderTarget(dummy);
        renderer.render(warmScene, camera);
        renderer.setRenderTarget(before);
        warmScene.remove(o);
        h.ready = true;
        onReady();
      }, WARN_PAINT_MS);
    }), (err) => console.error('detail variant failed to compile', err));
  }

  function show(defines) {
    if (keyOf(defines) === keyOf(mat.defines ?? {})) return false;
    mat.defines = { ...defines };
    mat.needsUpdate = true;
    return true;
  }

  return {
    // A new view material (grid rebuilt) or new feature switches.
    configure(viewMesh, settings, camera, scene) {
      const fresh = viewMesh.material !== mat;   // just built: it compiles on its first frame anyway
      if (fresh) dropHolder();
      mesh = viewMesh;
      mat = viewMesh.material;
      const on = DETAIL.filter((f) => settings[settingKey(f)]);
      const gated = on.filter((f) => !alwaysIn(f));
      const nextBase = definesOf(on.filter(alwaysIn));
      near = definesOf(on);
      nearFadeM = Math.max(0, ...gated.map((f) => f.fadeM));
      if (fresh || keyOf(nextBase) !== keyOf(base)) {
        base = nextBase;
        wantNear = false;
        if (fresh) { applied = base; show(base); }
        else {
          // a switch changed: the base variant recompiles, after the message paints
          onCompile();
          const m = mat;
          const b = base;
          setTimeout(() => { if (mat !== m || base !== b) return; applied = b; if (show(b)) onReady(); }, WARN_PAINT_MS);
        }
      }
      if (holder && holder.key !== keyOf(near)) dropHolder();
      clearTimeout(timer);
      if (gated.length) timer = setTimeout(() => idle(() => { if (mat) compileNear(camera, scene); }), PREWARM_DELAY_MS);
    },

    // Every rendered frame, before the view draws. camGrid: camera position in
    // grid cells; dims: [nx, ny, nz]. Returns true if the variant changed.
    update(camera, camGrid, dims, scene) {
      if (!mat) return false;
      if (!nearFadeM) return show(applied);
      let d2 = 0;
      for (let i = 0; i < 3; i++) {
        const c = camGrid.getComponent(i);
        const e = c < 0 ? -c : c > dims[i] ? c - dims[i] : 0;
        d2 += e * e;
      }
      const heightPx = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
      const fpM = Math.sqrt(d2) * CELL_M * 2 * Math.tan(camera.fov * DEG / 2) / heightPx;
      if (fpM < nearFadeM) wantNear = true;
      else if (fpM > nearFadeM * GATE_HYSTERESIS) wantNear = false;
      if (wantNear && !holder) compileNear(camera, scene);
      return show(wantNear && holder?.ready && applied === base ? near : applied);
    },

    get level() { return wantNear ? 1 : 0; },
    get pending() { return Number(!!mat && applied !== base) + Number(!!holder && !holder.ready); },   // delayed base change + compiling near variant
    get shown() { return keyOf(mat?.defines ?? {}); },
    dispose() { clearTimeout(timer); dropHolder(); dummy.depthTexture.dispose(); dummy.dispose(); mat = mesh = null; },
  };
}
