import * as THREE from 'three';
import { prelude, quadVert } from '../shaders/common.js';
import { ELEMENTS, E, K } from '../elements.js';

// What the birds know of the world (the `world` flock.js reads): one small
// GPU pass a few times a second that walks one column in every PROBE_STEP² of
// the window from the top down and writes, per column, a texel of
//   R  the surface: the top of the topmost solid, powder or liquid (cells; 0: none)
//   G  its element id
//   B  its rise: how far that top stands over the next surface down, across a
//      gap of open air (a tree crown over the ground, a roof over a floor; 0:
//      none): a perch. A top run thicker than PERCH_RUN_MAX is ground (over a
//      cave, say), not a perch, and the walk stops there
//   A  the column's hot band: lowest·HOT_PACK + highest + 1 of the cells hotter
//      than BIRD_IGNITE_T (0: none), so a bird inside it catches fire
// read back asynchronously (64 KB for a 128² window), so it never stalls a frame. Outside the window, in a world, the scene's own ground
// (scene.ground, the generator's CPU twin) stands in, raised by TREE_ALLOWANCE
// for the trees it doesn't know about; a box's outside is its floor.
//
// Queries take world cells (the window's grid cell plus sim.origin), so the
// birds don't care where the window is.

export const BIRD_IGNITE_T = 300;   // °C: feathers burn in anything this hot (the NPC's world model calls it a burn too)
const PERCH_RISE = 5;              // cells of open air under a top for it to count as a perch (1.5 m)
const PERCH_RUN_MAX = 8;           // cells: a top run thicker than this is ground, not a crown or a roof
const PROBE_STEP = 2;              // cells between probed columns, along x and z
const PROBE_S = 0.25;              // s between probes
const HOT_PACK = 256;              // the hot band's packing (grids are under this tall)
const TREE_ALLOWANCE = 18;         // cells over a world's generated ground outside the window: its trees' crowns (a scene that plants them)
const GROUND_CACHE = 1 << 14;      // world columns whose scene ground is kept
const GROUND_QUANT = 2;            // cells: scene ground looked up on this lattice outside the window
const PERCHES_MAX = 4096;          // perch columns kept per probe (a 128² window has 4096 probed columns)
const TREE_IDS = new Set([E.PLANT, E.WOOD]);

const f = (x) => x.toFixed(1);
const probeFrag = (g) => /* glsl */ `
${prelude(g)}
#define IGNITE_T ${f(BIRD_IGNITE_T)}
#define HOT_PACK ${f(HOT_PACK)}
#define PERCH_RUN_MAX ${PERCH_RUN_MAX}
#define PROBE_STEP ${PROBE_STEP}
out vec4 oP;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) * PROBE_STEP;   // the column (x, z)
  float top = 0.0, topId = 0.0, rise = 0.0, hotLo = -1.0, hotHi = -1.0;
  int state = 0;   // 0: above the top, 1: in the top run, 2: in the air under it
  for (int y = NY - 1; y >= 0; y--) {
    vec4 a = fetchA(ivec3(c.x, y, c.y));
    int id = eid(a);
    if (a.y > IGNITE_T) { if (hotHi < 0.0) hotHi = float(y); hotLo = float(y); }
    bool matter = !isGasLike(id);
    if (state == 0) { if (matter) { top = float(y + 1); topId = float(id); state = 1; } }
    else if (state == 1) {
      if (!matter) state = 2;
      else if (top - float(y) > float(PERCH_RUN_MAX)) break;   // ground: no perch, and nothing under it a bird reaches
    }
    else if (matter) { rise = top - float(y + 1); break; }   // the next surface under the gap
  }
  if (state == 2 && rise == 0.0) rise = top;   // air down to the floor under an overhang
  oP = vec4(top, topId, rise, hotHi < 0.0 ? 0.0 : hotLo * HOT_PACK + hotHi + 1.0);
}`;
export { probeFrag };

const KIND = ELEMENTS.map((e) => e.kind);

// env: { renderer, getSim, getWin: () => WorldWindow | null }
export function createBirdWorld({ renderer, getSim, getWin }) {
  let g = null, mat = null, target = null, buf = null, spare = null;
  let busy = false, age = Infinity;
  // the last probe: its grid, origin and columns
  let data = null, nx = 0, nz = 0, ox = 0, oz = 0, perchCols = [];
  const groundCache = new Map();
  let groundScene = null;

  function ensure(sim) {
    if (g === sim.g) return;
    g = sim.g;
    mat?.dispose(); target?.dispose();
    mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: probeFrag(g),
      uniforms: { tA: { value: null } }, depthTest: false, depthWrite: false,
    });
    mat.name = 'birdProbe';
    target = new THREE.WebGLRenderTarget(g.nx / PROBE_STEP, g.nz / PROBE_STEP, {
      type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    buf = new Float32Array(target.width * target.height * 4);
    spare = new Float32Array(target.width * target.height * 4);
    data = null;
  }

  function ingest(sim, o) {
    // the readback's buffer becomes the columns; the old columns' the next readback's
    [data, buf] = [buf, data && data.length === buf.length ? data : spare];
    nx = sim.g.nx / PROBE_STEP; nz = sim.g.nz / PROBE_STEP; ox = o.x; oz = o.z;
    perchCols = [];
    for (let i = 0; i < nx * nz && perchCols.length < PERCHES_MAX; i++) {
      const top = data[i * 4], id = data[i * 4 + 1], rise = data[i * 4 + 2];
      if (rise >= PERCH_RISE && top > 0 && KIND[id] === K.SOLID) perchCols.push(i);
    }
  }

  // the probe's texel nearest world column (x, z), or -1 outside the window (or before the first probe)
  function col(x, z) {
    if (!data) return -1;
    const gx = Math.floor((x - ox) / PROBE_STEP), gz = Math.floor((z - oz) / PROBE_STEP);
    return gx >= 0 && gz >= 0 && gx < nx && gz < nz ? gz * nx + gx : -1;
  }

  function sceneGround(x, z) {
    const win = getWin();
    if (!win?.loaded) return 0;
    if (groundScene !== win) { groundScene = win; groundCache.clear(); }
    const qx = Math.floor(x / GROUND_QUANT), qz = Math.floor(z / GROUND_QUANT);
    const key = qx * 65536 + qz;
    let h = groundCache.get(key);
    if (h === undefined) {
      if (groundCache.size >= GROUND_CACHE) groundCache.clear();
      h = win.scene.ground(qx * GROUND_QUANT, qz * GROUND_QUANT, win.P) + (win.scene.trees ? TREE_ALLOWANCE : 0);
      groundCache.set(key, h);
    }
    return h;
  }

  const world = {
    // a box keeps its flocks over its floor; a world has no sides
    get bounds() {
      const sim = getSim();
      if (!sim || getWin()) return null;
      return { x0: 0, z0: 0, x1: sim.g.nx, z1: sim.g.nz };
    },
    ground(x, z) {
      const i = col(x, z);
      if (i >= 0) return data[i * 4];
      return getWin() ? sceneGround(x, z) : 0;
    },
    hot(x, y, z) {
      const i = col(x, z);
      if (i < 0) return false;
      const h = data[i * 4 + 3];
      if (h <= 0) return false;
      const lo = Math.floor(h / HOT_PACK), hi = h - lo * HOT_PACK - 1;
      return y >= lo && y <= hi + 1;
    },
    perches(x, z, r) {
      const out = [];
      for (const i of perchCols) {
        const wx = (i % nx) * PROBE_STEP + ox + 0.5, wz = Math.floor(i / nx) * PROBE_STEP + oz + 0.5;
        if (Math.hypot(wx - x, wz - z) > r) continue;
        out.push({ x: wx, y: data[i * 4], z: wz, tree: TREE_IDS.has(data[i * 4 + 1]) });
      }
      return out;
    },
    holds(s) {
      const i = col(s.x, s.z);
      return i < 0 || Math.abs(data[i * 4] - s.y) < 1;
    },
  };

  return {
    world,
    get ready() { return !!data; },
    get perchCount() { return perchCols.length; },
    get pass() { return { mat, target }; },   // (checks time it: tools/birds-shots.mjs)
    // every frame: starts a probe when the last is PROBE_S old
    update(dt) {
      age += dt;
      const sim = getSim();
      if (!sim || busy || age < PROBE_S) return;
      ensure(sim);
      mat.uniforms.tA.value = sim.stateA;
      sim.run(mat, target);
      renderer.setRenderTarget(null);
      busy = true;
      age = 0;
      const o = sim.origin.clone(), from = sim;
      renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, buf)
        .then(() => { if (from === getSim()) ingest(from, o); })
        .catch((err) => console.error('bird probe readback failed', err))
        .finally(() => { busy = false; });
    },
    // a new grid or scene: forget the old one's columns
    reset() { data = null; perchCols = []; groundCache.clear(); groundScene = null; age = Infinity; },
    dispose() { mat?.dispose(); target?.dispose(); },
  };
}
