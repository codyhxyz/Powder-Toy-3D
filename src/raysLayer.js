import * as THREE from 'three';
import { RAYS, rayKindOfTool, emitterIds } from './rays.js';
import {
  raysAdvanceFrag, raysSpawnFrag, raysPaintFrag, raysRowsFrag, raysTotalFrag,
  raysDepositVert, raysDepositFrag, raysBrickVert, raysBrickFrag, raysDrawVert, raysDrawFrag,
} from './shaders/rays.js';
import { stateUniforms } from './shaders/common.js';

// The fast-particle layer (docs/particles.md): a list of up to N = RAY_TEX²
// photons and neutrons beside a Simulation's grid. Simulation.step calls
// step() before its activity map and settle() after react; while nothing is
// alive and nothing emits, it costs nothing (active is false).

const N = RAYS.RAY_TEX * RAYS.RAY_TEX;
const LIST_ATTACHMENTS = 4;    // L0..L3 (shaders/rays.js)
// Sweep numbers (L3.w) wrap here, well inside a float's exact integers.
const STAMP_WRAP = 1 << 20;

function target(w, h, count, type) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}
const raw = (vert, frag, uniforms, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
  depthTest: false, depthWrite: false, ...extra,
});
const listUniforms = () => ({ tL0: { value: null }, tL1: { value: null }, tL2: { value: null }, tL3: { value: null } });
// One vertex per list slot (the passes read their slot by gl_VertexID).
function slotPoints() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const pts = new THREE.Points(geo);
  pts.frustumCulled = false;
  return pts;
}

export class Rays {
  constructor(sim, quadVert) {
    this.sim = sim;
    const g = sim.g, F = THREE.FloatType;
    this.lists = [target(RAYS.RAY_TEX, RAYS.RAY_TEX, LIST_ATTACHMENTS, F), target(RAYS.RAY_TEX, RAYS.RAY_TEX, LIST_ATTACHMENTS, F)];
    this.tmp = target(RAYS.RAY_TEX, RAYS.RAY_TEX, LIST_ATTACHMENTS, F);
    this.cur = 0;
    // deposits, laid out like the state (react.js reads its cell's texel)
    this.deposit = target(g.width, g.height, 1, THREE.HalfFloatType);
    // bricks holding a particle (activity.js quietFrag keeps them and their neighbours awake)
    this.bricks = target(g.bwidth, g.bheight, 1, THREE.UnsignedByteType);
    this.rows = target(RAYS.RAY_TEX, 1, 1, F);
    this.total = target(1, 1, 1, F);
    this.totalBuf = new Float32Array(4);
    // steps to sweep the atlas with the spawn pass's stripe (docs/particles.md)
    this.cycle = Math.ceil((g.width * g.height) / N);
    this.cursor = 0;          // the paint pass's next slot
    this.active = false;
    this.stepped = false;     // this step's deposits are in the target (settle zeroes them)
    this.wokeSince = false;   // woken since the count in flight was asked for
    this.reading = false;
    this.emitters = new Set(emitterIds());

    const state = stateUniforms;
    this.mats = {
      advance: raw(quadVert, raysAdvanceFrag(g), { ...state(), ...listUniforms(), uFrame: { value: 0 } }),
      spawn: raw(quadVert, raysSpawnFrag(g), {
        ...state(), ...listUniforms(), uFrame: { value: 0 }, uStride: { value: 1 }, uPhase: { value: 0 },
        uCycle: { value: this.cycle }, uStamp: { value: 1 },
      }),
      paint: raw(quadVert, raysPaintFrag(g), {
        ...state(), ...listUniforms(), uFrame: { value: 0 }, uCursor: { value: 0 }, uCount: { value: 0 }, uKind: { value: 0 },
        uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 }, uShape: { value: 0 },
      }),
      rows: raw(quadVert, raysRowsFrag(g), { ...state(), ...listUniforms(), uStamp: { value: 1 } }),
      total: raw(quadVert, raysTotalFrag(g), { ...state(), ...listUniforms(), tRows: { value: this.rows.texture } }),
      deposit: raw(raysDepositVert(g), raysDepositFrag, { ...state(), ...listUniforms(), uZero: { value: false } }, {
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }),
      bricks: raw(raysBrickVert(g), raysBrickFrag, { ...state(), ...listUniforms() }),
    };
    for (const [k, m] of Object.entries(this.mats)) m.name = `rays.${k}`;
    this.pts = slotPoints();
    this.ptsScene = new THREE.Scene();
    this.ptsScene.add(this.pts);
    this.ptsQuads = { mesh: this.pts, scene: this.ptsScene };

    // what the app draws: the list as points, in grid cells (a child of the volume)
    this.view = slotPoints();
    this.view.material = new THREE.ShaderMaterial({
      vertexShader: raysDrawVert, fragmentShader: raysDrawFrag,
      uniforms: { tL0: { value: null }, tL2: { value: null }, uPointPx: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.view.renderOrder = 1;   // after the volume
    this.view.visible = false;
  }

  get list() { return this.lists[this.cur]; }
  setList(m, t) { ['tL0', 'tL1', 'tL2', 'tL3'].forEach((k, i) => { m.uniforms[k].value = t.textures[i]; }); }
  setState(m) {
    const s = this.sim;
    m.uniforms.tA.value = s.stateA;
    m.uniforms.tB.value = s.stateB;
    m.uniforms.tF.value = s.stateF;
  }

  // Something may make particles: start running (and keep the activity map honest).
  wake() {
    this.sim.wake();   // invalidate idle readbacks too: particles live outside the state targets
    this.active = true;
    this.wokeSince = true;
  }
  // Painting an element that emits wakes the layer (Simulation.paint).
  noteElement(id) { if (this.emitters.has(id)) this.wake(); }

  // The brush, for a particle tool (rays.js RAY_TOOLS): new particles in free
  // slots of the next stretch of the list. Returns false for any other tool.
  paint({ center, radius, shape, tool, rate }) {
    const kind = rayKindOfTool(tool);
    if (!kind) return false;
    const vol = shape === 0 ? (4 / 3) * Math.PI * radius ** 3 : (2 * radius) ** 3;
    const count = Math.min(RAYS.RAY_PAINT_MAX, Math.ceil(vol * RAYS.RAY_PAINT_PER_CELL * rate));
    const m = this.mats.paint, u = m.uniforms;
    this.setState(m);
    this.setList(m, this.list);
    u.uFrame.value = ++this.sim.paints;
    u.uCursor.value = this.cursor;
    u.uCount.value = count;
    u.uKind.value = kind;
    u.uCenter.value.copy(center);
    u.uRadius.value = radius;
    u.uShape.value = shape;
    this.sim.run(m, this.lists[1 - this.cur]);
    this.cur = 1 - this.cur;
    this.cursor = (this.cursor + count) % N;
    this.wake();
    return true;
  }

  // Before the activity map: fly every particle, spawn, splat the deposits and
  // mark the bricks holding particles.
  step() {
    this.stepped = false;
    if (!this.active) return;
    const sim = this.sim, { advance, spawn, deposit, bricks } = this.mats;
    this.setState(advance);
    this.setList(advance, this.list);
    advance.uniforms.uFrame.value = sim.frame;
    sim.run(advance, this.tmp);
    const sweep = Math.floor(sim.frame / this.cycle);
    const stamp = (sweep % STAMP_WRAP) + 1;
    this.setState(spawn);
    this.setList(spawn, this.tmp);
    const su = spawn.uniforms;
    su.uFrame.value = sim.frame;
    su.uStride.value = 2 * Math.floor(Math.random() * (N / 2)) + 1;   // odd, in [1, N)
    su.uPhase.value = sim.frame % this.cycle;
    su.uStamp.value = stamp;
    sim.run(spawn, this.lists[1 - this.cur]);
    this.cur = 1 - this.cur;
    // deposits (from the scratch list: a slot that died this step deposits too)
    this.setList(deposit, this.tmp);
    deposit.uniforms.uZero.value = false;
    deposit.blending = THREE.CustomBlending;
    sim.run(deposit, this.deposit, this.ptsQuads);
    // occupied bricks
    this.clear(this.bricks);
    this.setList(bricks, this.list);
    sim.run(bricks, this.bricks, this.ptsQuads);
    this.stepped = true;
    // at the end of a sweep, count what's alive and what emits (asynchronously)
    if (sim.frame % this.cycle === this.cycle - 1) this.count(stamp);
  }

  // Forget every particle (a new state was loaded, or the window moved: their
  // positions are grid cells), then look for emitters.
  reset() {
    for (const t of this.lists) this.clear(t);
    this.clear(this.tmp);
    this.wake();
  }

  // After react: zero the deposits it took, so the target is empty between steps.
  settle() {
    if (!this.stepped) return;
    const d = this.mats.deposit;
    this.setList(d, this.tmp);
    d.uniforms.uZero.value = true;
    d.blending = THREE.NoBlending;
    this.sim.run(d, this.deposit, this.ptsQuads);
    this.stepped = false;
  }

  clear(t) {   // (every attachment)
    const r = this.sim.renderer;
    this.clearColor ??= new THREE.Color();
    r.getClearColor(this.clearColor);
    const alpha = r.getClearAlpha();
    r.setRenderTarget(t);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setClearColor(this.clearColor, alpha);
  }

  count(stamp) {
    if (this.reading) return;
    const sim = this.sim, { rows, total } = this.mats;
    this.setList(rows, this.list);
    rows.uniforms.uStamp.value = stamp;
    sim.run(rows, this.rows);
    sim.run(total, this.total);
    this.reading = true;
    this.wokeSince = false;
    const simId = sim.id;
    sim.renderer.readRenderTargetPixelsAsync(this.total, 0, 0, 1, 1, this.totalBuf).then(() => {
      this.reading = false;
      if (this.disposed || sim.id !== simId) return;
      this.live = this.totalBuf[0];
      this.seen = this.totalBuf[1];
      if (this.live === 0 && this.seen === 0 && !this.wokeSince) this.sleep();
    }, () => { this.reading = false; });
  }

  // Nothing alive and nothing emitting: stop, and let the bricks sleep.
  sleep() {
    this.active = false;
    this.clear(this.bricks);
    this.sim.actDirty = true;
  }

  // The app's per-frame view update: the current list, and the point size for
  // a camera (fov in degrees) over a canvas h px tall.
  updateView(camera, h) {
    const u = this.view.material.uniforms;
    u.tL0.value = this.list.textures[0];
    u.tL2.value = this.list.textures[2];
    u.uPointPx.value = (h / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 50) / 2) * this.view.matrixWorld.getMaxScaleOnAxis();
    this.view.visible = this.active;
  }

  materials() { return Object.values(this.mats).concat(this.view.material); }

  dispose(retire = null) {
    this.disposed = true;
    [...this.lists, this.tmp, this.deposit, this.bricks, this.rows, this.total].forEach((t) => t.dispose());
    this.pts.geometry.dispose();
    this.view.geometry.dispose();
    this.view.removeFromParent();
    if (retire) retire.push(...this.materials());
    else this.materials().forEach((m) => m.dispose());
  }
}
