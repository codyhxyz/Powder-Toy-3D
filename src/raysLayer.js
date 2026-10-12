import { RAYS, rayKindOfTool, emitterIds } from './rays.js';
import {
  RAYS_KERNELS, RAYS_LAYOUT, RAYS_DRAW_LAYOUT, raysDrawWGSL, raysDrawPipeline, RayDrawParams, raysDispatch,
  COUNT_WORDS, COUNT, QUAD_VERTICES,
} from './shaders/rays.js';
import { frameUniformsOf } from './gfx/uniforms.js';

// The fast-particle layer (docs/particles.md, docs/webgpu.md G3): a list of up
// to N = RAY_TEX² photons and neutrons beside a Simulation's grid, attached
// with sim.attachRays (src/wire/rays.js). Simulation.step calls step(f)
// before its activity map and settle(f) after react; while nothing is alive
// and nothing emits, it records nothing (active is false). Its kernels
// (shaders/rays.js) build when it first wakes, in the background; until they
// are built a step leaves the particles as they are and a stroke waits for
// them. The sprites are drawn in the scene pass after the volume (draw;
// src/wire/rays.js), only the live ones (drawIndirect over the list the
// deposit kernel compacts).
//
//   sim.attachRays(new Rays(sim));
//   sim.rays.paint({ center, radius, shape, tool, rate });   // a particle tool's stroke
//   const { l0, l2 } = await sim.rays.readList();             // tools: slot j's l0 at 4j

const N = RAYS.RAY_TEX * RAYS.RAY_TEX;
const PARTICLE_BYTES = 64;   // four vec4f (shaders/rays.js Particle)
const LIST_FLOATS = PARTICLE_BYTES / 4;
// Sweep numbers (l3.w) wrap here, well inside a float's exact integers.
const STAMP_WRAP = 1 << 20;
const SET_BYTES = COUNT_WORDS * 4;

export class Rays {
  /** @param {import('./sim.js').Simulation} sim */
  constructor(sim) {
    this.sim = sim;
    const gpu = (this.gpu = sim.gpu), g = sim.g;
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const buf = (label, size, usage = S | CS | CD) => gpu.createBuffer({ label: `rays${sim.id} ${label}`, size: Math.max(16, size), usage });
    this.list = buf('list', N * PARTICLE_BYTES);
    // per slot of the state: heat and pressure, fixed point (react.js reads them while `stepped`)
    this.deposit = buf('deposit', g.slots * 8);
    // a bit per brick holding a particle (activity.js quietFrag keeps them and their neighbours awake)
    this.bricks = buf('bricks', Math.ceil(g.nbricks / 32) * 4);
    // two sets of the sprites' drawIndirect arguments and the counts (shaders/rays.js COUNT)
    this.counts = buf('counts', 2 * SET_BYTES, S | CS | CD | GPUBufferUsage.INDIRECT);
    const init = new Uint32Array(2 * COUNT_WORDS);
    init[COUNT.VERTICES] = init[COUNT_WORDS + COUNT.VERTICES] = QUAD_VERTICES;
    gpu.queue.writeBuffer(this.counts, 0, init);
    this.drawList = buf('draw list', N * 4);
    this.set = 1;   // the counts' set the last compaction filled (the first fills 0)
    const L = gpu.layout('RAYS', RAYS_LAYOUT);
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.group = gpu.bindGroup(L, [b(0, this.list), b(1, this.deposit), b(2, this.bricks), b(3, this.counts), b(4, this.drawList)], 'rays');
    this.kernels = Object.fromEntries(Object.entries(RAYS_KERNELS).map(([name, [code, params]]) => [name, gpu.kernel({
      name, code: code(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, L], params, build: 'manual',
    })]));
    this.draws = null;   // the sprites' pipeline and group, made at the first draw
    // steps to sweep every slot with the spawn kernel's stripe (docs/particles.md)
    this.cycle = Math.ceil(g.slots / N);
    this.cursor = 0;          // the paint kernel's next slot
    this.active = false;
    this.stepped = false;     // this step's deposits are in the buffer (settle zeroes them)
    this.wokeSince = false;   // woken since the count in flight was asked for
    this.reading = false;
    this.live = 0;            // the last sweep's count of particles...
    this.seen = 0;            // ...and of slots that saw an emitter
    this.pointPx = 1;
    this.emitters = new Set(emitterIds());
    this._ready = null;
  }

  /** Builds the kernels (once); resolves to the layer when they are built. */
  prepare() { return (this._ready ??= Promise.all(Object.values(this.kernels).map((k) => k.build())).then(() => this)); }
  get ready() { return this.prepare(); }
  get built() { return Object.values(this.kernels).every((k) => k.state === 'ready'); }

  // Records a dispatch into the frame's compute pass and tells the profiler.
  _dispatch(kernel, params) {
    const sim = this.sim;
    kernel.dispatch(this.gpu.frame, raysDispatch(), { bind: [sim.tables, sim.bindRO, this.group], header: sim.header(), params });
    sim.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
  }

  // The next compaction's counts set, and the stamp of the sweep `frame` is in.
  _flip() { this.set = 1 - this.set; return this.set; }
  _stamp(frame = this.sim.frame) { return (Math.floor(frame / this.cycle) % STAMP_WRAP) + 1; }

  // Something may make particles: start running (and keep the activity map honest).
  wake() {
    this.sim.wake();   // invalidate idle readbacks too: particles live outside the state
    this.active = true;
    this.wokeSince = true;
    this.prepare();
  }
  // Painting an element that emits wakes the layer (Simulation.paint).
  noteElement(id) { if (this.emitters.has(id)) this.wake(); }

  // The brush, for a particle tool (rays.js RAY_TOOLS): new particles in free
  // slots of the next stretch of the list. Returns false for any other tool.
  // A stroke before the kernels are built is made once they are.
  paint({ center, radius, shape, tool, rate }) {
    const kind = rayKindOfTool(tool);
    if (!kind) return false;
    this.wake();
    if (!this.built) {
      const c = { x: center.x, y: center.y, z: center.z }, sim = this.sim;
      this.prepare().then(() => { if (!this.disposed && !sim.disposed && !this.gpu.failure) this.paint({ center: c, radius, shape, tool, rate }); }, () => {});
      return true;
    }
    const vol = shape === 0 ? (4 / 3) * Math.PI * radius ** 3 : (2 * radius) ** 3;
    const count = Math.min(RAYS.RAY_PAINT_MAX, Math.ceil(vol * RAYS.RAY_PAINT_PER_CELL * rate));
    this._dispatch(this.kernels.raysPaint, {
      center: [center.x, center.y, center.z], radius, shape, kind, frame: ++this.sim.paints, cursor: this.cursor, count,
    });
    this.cursor = (this.cursor + count) % N;
    this._compact();
    return true;
  }

  // The draw list again (after paint or a load of the list: no step moved them).
  _compact() {
    this._dispatch(this.kernels.raysDeposit, { stamp: this._stamp(), countSet: this._flip(), deposit: false });
  }

  /**
   * Before the activity map: fly every particle, spawn, add the deposits,
   * mark the bricks holding particles and list the live ones (into the open
   * frame, gpu.frame).
   */
  step() {
    this.stepped = false;
    if (!this.active || !this.built) return;
    const k = this.kernels, frame = this.sim.frame, stamp = this._stamp(frame);
    this._dispatch(k.raysAdvance, { frame });
    this._dispatch(k.raysSpawn, {
      frame, stride: 2 * Math.floor(Math.random() * (N / 2)) + 1, phase: frame % this.cycle, cycle: this.cycle, stamp,
    });
    this._dispatch(k.raysDeposit, { stamp, countSet: this._flip(), deposit: true });
    this.stepped = true;
    // at the end of a sweep, count what's alive and what emits (asynchronously)
    if (frame % this.cycle === this.cycle - 1) this.count();
  }

  // After react: zero the deposits it took, so the buffer is empty between steps.
  settle() {
    if (!this.stepped) return;
    this._dispatch(this.kernels.raysSettle);
    this.stepped = false;
  }

  // Forget every particle (a new state was loaded, or the window moved: their
  // positions are grid cells), then look for emitters.
  reset() {
    const f = this.gpu.frame;
    f.clear(this.list);
    for (const set of [0, 1]) f.clear(this.counts, set * SET_BYTES + 4, 16);   // (live through seen; the vertex count stays)
    this.wake();
  }

  // The count the last compaction made (its set: live and seen), read back
  // once a sweep; nothing alive and nothing emitting since puts the layer to sleep.
  count() {
    if (this.reading) return;
    this.reading = true;
    this.wokeSince = false;
    const sim = this.sim, simId = sim.id;
    this.gpu.readback.buffer(this.counts, this.set * SET_BYTES, SET_BYTES).then((bytes) => {
      this.reading = false;
      if (this.disposed || sim.id !== simId) return;
      const w = new Uint32Array(bytes);
      this.live = w[COUNT.LIVE];
      this.seen = w[COUNT.SEEN];
      if (this.live === 0 && this.seen === 0 && !this.wokeSince) this.sleep();
    }, () => { this.reading = false; });
  }

  // Nothing alive and nothing emitting: stop, and let the bricks sleep.
  sleep() {
    this.active = false;
    this.gpu.frame.clear(this.bricks);
    this.sim.actDirty = true;
  }

  /**
   * The list as it is at this call, a Float32Array per vec4 of the Particle
   * (slot j's at 4j): the WebGL build's four attachments. Tools and saves.
   * @returns {Promise<{ l0: Float32Array, l1: Float32Array, l2: Float32Array, l3: Float32Array }>}
   */
  async readList() {
    const all = new Float32Array(await this.gpu.readback.buffer(this.list));
    const out = { l0: new Float32Array(N * 4), l1: new Float32Array(N * 4), l2: new Float32Array(N * 4), l3: new Float32Array(N * 4) };
    const parts = [out.l0, out.l1, out.l2, out.l3];
    for (let j = 0; j < N; j++) for (let k = 0; k < 4; k++) parts[k].set(all.subarray(j * LIST_FLOATS + k * 4, j * LIST_FLOATS + k * 4 + 4), j * 4);
    return out;
  }

  /**
   * Replaces the list (a save's: the four attachments one after the other,
   * N × 4 floats each, as readList returns them), then wakes. Once the
   * kernels are built, the sprites' list holds them.
   * @param {Float32Array} lists
   */
  writeList(lists) {
    const all = new Float32Array(N * LIST_FLOATS);
    for (let j = 0; j < N; j++) for (let k = 0; k < 4; k++) all.set(lists.subarray(k * N * 4 + j * 4, k * N * 4 + j * 4 + 4), j * LIST_FLOATS + k * 4);
    this.gpu.write(this.list, 0, all);
    this.wake();
    const sim = this.sim;
    this.prepare().then(() => { if (!this.disposed && !sim.disposed && !this.gpu.failure) this._compact(); }, () => {});
  }

  /**
   * The app's per-frame view update: the point size for a camera (fov in
   * degrees) over a scene target h px tall, the volume's scale (scene units
   * per cell) taken from its world matrix (a three Matrix4, or 16 numbers
   * column-major).
   */
  updateView(camera, h, matrixWorld = null) {
    const e = matrixWorld?.elements ?? matrixWorld;
    const scale = e ? Math.sqrt(Math.max(e[0] ** 2 + e[1] ** 2 + e[2] ** 2, e[4] ** 2 + e[5] ** 2 + e[6] ** 2, e[8] ** 2 + e[9] ** 2 + e[10] ** 2)) : 1;
    this.pointPx = (h / 2) / Math.tan(((camera.fov ?? 50) * Math.PI) / 360) * scale;
  }

  /**
   * The live particles into a render pass on the scene target (the scene
   * pass after the volume, or E2's overlay pass: they write no depth), sized
   * for a target width × height px. Draws nothing while the layer sleeps or
   * its pipeline builds; returns whether it drew.
   */
  draw(rp, { width, height }) {
    if (!this.active) return false;
    const gpu = this.gpu;
    if (!this.draws) {
      const fu = frameUniformsOf(gpu);
      const L = gpu.layout('RAYS_DRAW', RAYS_DRAW_LAYOUT);
      this.draws = {
        fu,
        pipe: gpu.renderPipeline({ name: 'raysDraw', code: raysDrawWGSL(), layouts: [fu.layout, L], params: RayDrawParams, ...raysDrawPipeline() }),
        group: gpu.bindGroup(L, [{ binding: 0, resource: { buffer: this.list } }, { binding: 1, resource: { buffer: this.drawList } }], 'rays draw'),
      };
    }
    const { fu, pipe, group } = this.draws;
    if (pipe.state !== 'ready' || !this.built) return false;
    pipe.draw(rp, {
      bind: [fu.group, group], indirect: { buffer: this.counts, offset: this.set * SET_BYTES },
      params: { pointPx: this.pointPx, viewport: [width, height] },
    });
    return true;
  }

  dispose() {
    this.disposed = true;
    if (!this.gpu.failure) this.gpu.flush('rays dispose');
    for (const b of [this.list, this.deposit, this.bricks, this.counts, this.drawList]) b.destroy();
  }
}
