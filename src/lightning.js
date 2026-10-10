import * as THREE from 'three';
import { quadVert, stateUniforms } from './shaders/common.js';
import { boltFrag, stormBrickFrag, stormRowsFrag, stormPickFrag, stormScanFrag } from './shaders/lightning.js';
import { BOLT, STORM, boltPath, boltStart, toolStrikeR, stormColumns, pickStrike } from './bolt.js';

// Lightning on the GPU: the Lightning tool's strikes and storms' (src/bolt.js
// has the shape and the rules, shaders/lightning.js the passes). One bolt for
// both: strike() builds its path on the CPU and draws it in one pass.
//
// Storms. Every STORM.POLL_STEPS steps, three small reductions find the most
// charged cloud cell (react.js charges freezing cloud that snow falls through)
// and one texel is read back. If it is at breakdown and STORM.MIN_STEPS have
// passed since the last natural strike, a second small pass scans the columns
// around it for the highest matter below, that is read back, and the bolt
// strikes the nearest (conductors counting nearer), spending the charge
// around its origin.
//
// A strike sparks the conductors it lands on: the "BOLT LANDS" spot in
// shaders/lightning.js boltFrag (and the CPU twin's World.strike) is where
// el-elec's sparkCell goes.

const RGBA = 4;

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}
const floatTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
});

export function createLightning({ renderer }) {
  let mats = null, targets = null, simId = -1;
  let nextPoll = 0, lastStrike = -Infinity, busy = false, ready = false;
  const rng = Math.random;
  const api = {
    strikes: 0,             // natural strikes so far (tools/mat-check)
    lastBolt: null,         // the last bolt's { from, to, segs, id } (tools/mat-check)
    strikeTool, update, strike,
  };

  function ensure(sim) {
    if (sim.id === simId) return;
    dispose();
    const g = sim.g;
    mats = {
      bolt: rawMat(boltFrag(g), {
        ...stateUniforms(), uFrame: { value: 0 },
        uSegA: { value: [...Array(BOLT.MAX_SEGS)].map(() => new THREE.Vector4()) },
        uSegB: { value: [...Array(BOLT.MAX_SEGS)].map(() => new THREE.Vector4()) },
        uSegs: { value: 0 }, uStrike: { value: new THREE.Vector3() }, uStrikeR: { value: 1 },
        uBoltFrom: { value: new THREE.Vector3() }, uDischargeR: { value: 0 },
        uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
      }),
      brick: rawMat(stormBrickFrag(g), { tA: { value: null } }),
      rows: rawMat(stormRowsFrag(g), { tSrc: { value: null } }),
      pick: rawMat(stormPickFrag(g), { tSrc: { value: null } }),
      scan: rawMat(stormScanFrag(g), {
        tA: { value: null }, uCols: { value: [...Array(STORM.CANDIDATES)].map(() => new THREE.Vector2()) },
        uCount: { value: 0 }, uFromY: { value: 0 },
      }),
    };
    for (const [k, m] of Object.entries(mats)) m.name = `lightning-${k}`;
    targets = {
      brick: floatTarget(g.bwidth, g.bheight), rows: floatTarget(g.bheight, 1), pick: floatTarget(1, 1),
      scan: floatTarget(STORM.CANDIDATES, 1),
    };
    simId = sim.id;
    nextPoll = sim.frame + STORM.POLL_STEPS;
    lastStrike = -Infinity;
    busy = false;
    // compile in the background (KHR_parallel_shader_compile, as pov/ballistics.js
    // does), so storms never stall a frame; a tool strike before then compiles
    // its pass on the spot
    ready = false;
    const built = mats, keep = sim.quad.material;
    Promise.all(Object.values(mats).map((m) => {
      sim.quad.material = m;
      return renderer.compileAsync(sim.scene, sim.camera);
    })).then(() => { if (mats === built) ready = true; }).catch(() => {});
    sim.quad.material = keep;
  }
  function dispose() {
    if (mats) Object.values(mats).forEach((m) => m.dispose());
    if (targets) Object.values(targets).forEach((t) => t.dispose());
    mats = targets = null;
  }

  // Draw one bolt from `from` to `to` (cells, [x, y, z]). strikeR: the strike's
  // radius; origin and dischargeR: the cloud charge it spends (storms).
  function strike(sim, from, to, { strikeR = STORM.STRIKE_R, dischargeR = 0, id = -1 } = {}) {
    ensure(sim);
    const g = sim.g, size = [g.nx, g.ny, g.nz];
    const segs = boltPath(from, to, rng, size);
    const u = mats.bolt.uniforms;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const grow = (p, r) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k] - r); hi[k] = Math.max(hi[k], p[k] + r); } };
    segs.forEach((s, i) => {
      u.uSegA.value[i].set(s.a[0], s.a[1], s.a[2], s.r);
      u.uSegB.value[i].set(s.b[0], s.b[1], s.b[2], 0);
      grow(s.a, s.r); grow(s.b, s.r);
    });
    grow(to, strikeR + BOLT.STRIKE_P_REACH);
    if (dischargeR > 0) grow(from, dischargeR);
    u.uSegs.value = segs.length;
    u.uStrike.value.fromArray(to);
    u.uStrikeR.value = strikeR;
    u.uBoltFrom.value.fromArray(from);
    u.uDischargeR.value = dischargeR;
    u.uLo.value.fromArray(lo);
    u.uHi.value.fromArray(hi);
    u.uFrame.value = (u.uFrame.value + 1) >>> 0;
    sim.touchCentres(lo, hi);
    sim.pass(mats.bolt);
    api.lastBolt = { from, to, segs, id };
    return segs;
  }

  // The Lightning tool: strike the surface under the cursor. hit: the app's
  // pick ({ cell, face, id }); radius: the brush radius.
  function strikeTool(sim, hit, radius) {
    ensure(sim);
    const g = sim.g, size = [g.nx, g.ny, g.nz];
    const n = [0, 0, 0];
    n[Math.floor(hit.face / 2)] = hit.face % 2 === 0 ? 1 : -1;
    const to = [0, 1, 2].map((k) => hit.cell.getComponent(k) + 0.5 + n[k] * 0.5);
    return strike(sim, boltStart(to, rng, size), to, { strikeR: toolStrikeR(radius), id: hit.id });
  }

  // Storms: call once per frame after the steps (host only).
  function update(sim) {
    ensure(sim);
    if (!ready || busy || sim.frame < nextPoll) return;
    nextPoll = sim.frame + STORM.POLL_STEPS;
    if (sim.frame - lastStrike < STORM.MIN_STEPS) return;
    busy = true;
    const id0 = sim.id;
    const m = mats;
    m.brick.uniforms.tA.value = sim.stateA;
    sim.run(m.brick, targets.brick);
    m.rows.uniforms.tSrc.value = targets.brick.texture;
    sim.run(m.rows, targets.rows);
    m.pick.uniforms.tSrc.value = targets.rows.texture;
    sim.run(m.pick, targets.pick);
    const buf = new Float32Array(RGBA);
    renderer.readRenderTargetPixelsAsync(targets.pick, 0, 0, 1, 1, buf).then(() => {
      if (sim.id !== id0 || buf[3] <= 0) { busy = false; return; }
      return scan(sim, [buf[0], buf[1], buf[2]]);
    }).catch(() => {}).finally(() => { busy = false; });
  }

  function scan(sim, origin) {
    const g = sim.g, id0 = sim.id;
    const cols = stormColumns(origin, [g.nx, g.ny, g.nz]);
    const su = mats.scan.uniforms;
    cols.forEach((c, i) => su.uCols.value[i].set(c[0], c[1]));
    su.uCount.value = cols.length;
    su.uFromY.value = Math.floor(origin[1]);
    su.tA.value = sim.stateA;
    sim.run(mats.scan, targets.scan);
    const buf = new Float32Array(STORM.CANDIDATES * RGBA);
    return renderer.readRenderTargetPixelsAsync(targets.scan, 0, 0, STORM.CANDIDATES, 1, buf).then(() => {
      if (sim.id !== id0 || sim.frame - lastStrike < STORM.MIN_STEPS) return;
      const hits = cols.map((c, i) => ({ x: c[0], z: c[1], top: buf[i * RGBA], id: Math.round(buf[i * RGBA + 1]), ok: buf[i * RGBA + 2] > 0 }))
        .filter((h) => h.ok);
      const best = pickStrike(origin, hits);
      if (!best) return;
      lastStrike = sim.frame;
      api.strikes++;
      strike(sim, origin, best.to, { strikeR: STORM.STRIKE_R, dischargeR: STORM.DISCHARGE_R, id: best.id });
    });
  }

  api.dispose = dispose;
  return api;
}
