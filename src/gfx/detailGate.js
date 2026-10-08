// Distance gating for the close-up detail features (gfx/detail.js).
//
// A feature compiled into the view shader costs time even where it draws
// nothing: a bigger shader runs slower everywhere (registers, occupancy). So
// a switched-on feature is only compiled into the view shader while the
// camera is close enough for it to show. Each feature declares fadeM, the
// pixel footprint (metres per pixel) above which it draws nothing. The
// smallest footprint anywhere on screen is bounded by the distance from the
// camera to the grid box: inside the box (POV mode) every feature is in.
//
// Features enter in order of fadeM, largest first, so the variants form a
// chain: level k = the first k features. That keeps the number of shader
// programs at (features + 1). Each variant is compiled in the background
// (KHR_parallel_shader_compile through compileAsync) into a holder material
// that shares the view material's shaders and uniforms, which keeps the
// program alive in three's cache; switching to it is then free. Until a
// variant is ready the view keeps the one it has: detail shows up a moment
// late instead of the frame stalling on a compile.
import * as THREE from 'three';
import { DETAIL, settingKey } from './detail.js';
import { CELL_M } from '../scale.js';

// A feature that came in at footprint fadeM goes out above fadeM × this, so
// a camera hovering at the threshold doesn't flip variants every frame.
const GATE_HYSTERESIS = 1.25;
// ms after start-up (or a settings change) before variants compile in the background
const PREWARM_DELAY_MS = 1500;
const DEG = Math.PI / 180;
const fadeOf = (f) => f.fadeM ?? Infinity;   // a feature without fadeM is always in

// onReady: called when a variant finishes compiling (the view should redraw).
export function createDetailGate(renderer, onReady) {
  let mat = null, mesh = null;           // the view material and a mesh to compile holders on
  let chain = [];                        // switched-on features, by fadeM descending
  let level = 0;                         // features currently wanted in
  let shown = '';                        // define key the view material has
  const holders = new Map();             // define key → { mat, ready }
  let timer = 0;
  const dummy = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });

  const definesOf = (k) => Object.fromEntries(chain.slice(0, k).map((f) => [f.define, 1]));
  const keyOf = (d) => Object.keys(d).sort().join(',');

  function holder(k, camera, scene) {
    const defines = definesOf(k), key = keyOf(defines);
    if (holders.has(key)) return holders.get(key);
    const h = {
      ready: false,
      mat: new THREE.ShaderMaterial({
        vertexShader: mat.vertexShader, fragmentShader: mat.fragmentShader, uniforms: mat.uniforms, defines,
        side: mat.side, transparent: mat.transparent, depthWrite: mat.depthWrite,
        blending: mat.blending, blendSrc: mat.blendSrc, blendDst: mat.blendDst,
      }),
    };
    holders.set(key, h);
    // The view renders into post's HDR target: compile with a target bound so
    // the program's parameters (output colour space) match and it is reused.
    const o = new THREE.Mesh(mesh.geometry, h.mat);
    o.frustumCulled = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dummy);
    const done = renderer.compileAsync(o, camera, scene);
    renderer.setRenderTarget(prev);
    done.then(() => { h.ready = true; onReady(); }, (err) => console.error('detail variant failed to compile', err));
    return h;
  }

  function prewarm(camera, scene) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const idle = globalThis.requestIdleCallback ?? ((fn) => fn());
      idle(() => { if (mat) for (let k = 1; k <= chain.length; k++) holder(k, camera, scene); });
    }, PREWARM_DELAY_MS);
  }

  function disposeHolders() {
    holders.forEach((h) => h.mat?.dispose());
    holders.clear();
    holders.set('', { ready: true, mat: null });   // no features: the material as built
  }

  return {
    // A new view material (grid rebuilt) or new feature switches.
    configure(viewMesh, settings, camera, scene) {
      if (viewMesh.material !== mat) { disposeHolders(); shown = ''; level = 0; }
      mesh = viewMesh;
      mat = viewMesh.material;
      const next = DETAIL.filter((f) => settings[settingKey(f)]).sort((a, b) => fadeOf(b) - fadeOf(a));
      if (next.map((f) => f.key).join() !== chain.map((f) => f.key).join()) {
        disposeHolders();
        chain = next;
        level = 0;
        if (shown) { mat.defines = {}; mat.needsUpdate = true; shown = ''; }
      }
      prewarm(camera, scene);
    },

    // Every rendered frame, before the view draws. camGrid: camera position in
    // grid cells; dims: [nx, ny, nz]. Returns true if the variant changed.
    update(camera, camGrid, dims, scene) {
      if (!mat) return false;
      let d2 = 0;
      for (let i = 0; i < 3; i++) {
        const c = camGrid.getComponent(i);
        const e = c < 0 ? -c : c > dims[i] ? c - dims[i] : 0;
        d2 += e * e;
      }
      const heightPx = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
      const fpM = Math.sqrt(d2) * CELL_M * 2 * Math.tan(camera.fov * DEG / 2) / heightPx;
      while (level < chain.length && fpM < fadeOf(chain[level])) level++;
      while (level > 0 && fpM > fadeOf(chain[level - 1]) * GATE_HYSTERESIS) level--;

      // the deepest ready variant at or below the wanted level
      for (let k = level; k >= 0; k--) {
        const defines = definesOf(k), key = keyOf(defines);
        const h = holders.get(key) ?? holder(k, camera, scene);
        if (!h.ready) continue;
        if (key === shown) return false;
        mat.defines = defines;
        mat.needsUpdate = true;
        shown = key;
        return true;
      }
      return false;
    },

    get level() { return level; },
    get pending() { let n = 0; holders.forEach((h) => { if (!h.ready) n++; }); return n; },   // variants still compiling
    get shown() { return shown; },
    dispose() { clearTimeout(timer); disposeHolders(); dummy.dispose(); mat = mesh = null; },
  };
}
