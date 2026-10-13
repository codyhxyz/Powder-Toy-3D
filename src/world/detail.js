import { Vector3, Matrix4, Frustum, Box3 } from 'three/webgpu';
// Cache ownership, limits and checks: docs/world-lod.md.
import { BRICK } from '../shaders/common.js';
import {
  DETAIL_CHUNK, DETAIL_PAD, detailChunks, detailMaskAt, farSceneLayout, farSceneCellsFrag, farFrag, farMeshPipeline,
  SceneCellsParams, sceneCellsDispatch, SCENE_CELLS_LAYOUT_OF, SCENE_CELLS_BINDING, FarViewParams,
  farDetailDepthFrag, farDetailDepthPipeline, FAR_DETAIL_DEPTH_FORMAT,
} from '../shaders/far.js';
import { TREE } from './generator.js';

export { DETAIL_CHUNK };

// Render-only chunks (docs/world-lod.md; docs/webgpu.md G1): the world near
// the window as meshes of its cells, so it doesn't turn into the far field's
// coarse bricks a few steps outside the simulated window. A chunk's cells (the
// scene's sceneCell, the live window's state where it overlaps, the trees the
// window would plant, the store's edits) are read back once (the scene cells
// kernel, shaders/far.js farSceneCellsFrag's live variant), meshed in a worker
// (world/detail-worker.js: surface nets), not simulated, and drawn with the
// far view's material (shaders/far.js farFrag's mesh variant) in our scene
// pass before the far view, which leaves a meshed chunk's opaque field to the
// mesh (the detail mask, after the occupancy levels in the far field's
// occupancy buffer: 1 a dry chunk, which it crosses whole; 2 one with
// liquids, whose surface stays the field's) and depth-tests against it.
// Before the scene pass the meshes' rasterized depth goes into a target of
// its own (depth: our depth-only pass, docs/webgpu.md G1), where the far
// view's march stops, so a dry pit dug below sea level in a meshed chunk
// isn't flooded by the coarse sea beyond (shaders/far.js farFrag: cached).
// While the rolling log bends the view (gfx/presentation.js) the meshes bend
// in their vertex stage, the prepass's too (the view's params carry the
// effect), the chunks wanted change with it (the view key), and none is
// culled by the flat frustum: bent down, a chunk outside it can show.
// Chunks are wanted where a cell would span more than CELL_PIXELS of the
// screen, nearest first, one in flight at a time, at most MAX_CHUNKS of them
// and MAX_BYTES of geometry; a chunk the window covers isn't kept. The cells
// kernel and both pipelines build the first time the far view is drawn
// (B5: nothing of it builds in views that don't draw it).
const PAD = DETAIL_PAD, MAX_CHUNKS = 96, MAX_BYTES = 96 * 1024 * 1024;
const CELL_PIXELS = 3; // largest projected cell before requesting finer geometry
const BUFFER = { VERTEX: 0x20, INDEX: 0x10, COPY_DST: 0x08, STORAGE: 0x80, COPY_SRC: 0x04 };   // (GPUBufferUsage's bits)
const TEX = { COPY_SRC: 0x01, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };                   // (GPUTextureUsage's bits)

export class WorldDetail {
  constructor(far) {
    this.far = far;
    this.win = far.win;
    this.sim = far.sim;
    this.gpu = far.gpu;
    const L = far.L, g = this.sim.g, gpu = this.gpu;
    [this.nx, this.nz] = detailChunks(L);
    this.mask = new Uint32Array(this.nx * this.nz);   // per chunk: 0 none, 1 dry mesh, 2 with liquids (uploaded into far.occ)
    this.maskAt = detailMaskAt(L) * 4;
    this.maskDirty = true;
    this.revisions = new Uint32Array(this.mask.length);
    this.entries = new Map();
    this.wanted = [];
    this.blocked = new Set();
    this.epoch = 0;
    this.bytes = 0;
    this.pending = null;
    this.visible = false;
    this.viewKey = null;
    this.disposed = false;
    this.layout = farSceneLayout(L, DETAIL_CHUNK + 2 * PAD);
    this.cells = gpu.createBuffer({ label: 'detail cells', size: this.layout.cells * 4, usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
    // its kernel and pipelines build when the far view is first drawn (tick); the window's don't wait for them
    const scene = this.win.scene, sceneKey = JSON.stringify(SCENE_CELLS_LAYOUT_OF(scene));
    this.stage = gpu.kernel({
      name: `${scene.key} detailCells`, code: farSceneCellsFrag(g, L, scene.glsl(g), this.layout, true),
      layouts: [this.sim.L.TABLES, this.sim.L.STATE_RO, gpu.layout(`far scene cells ${sceneKey}`, SCENE_CELLS_LAYOUT_OF(scene))],
      params: SceneCellsParams, build: 'manual',
    });
    this.pipe = gpu.renderPipeline({
      name: 'far detail', code: farFrag(g, L, true), layouts: [far.viewFrameLayout, this.sim.L.STATE_RO, gpu.L.LIGHTING],
      params: FarViewParams, ...farMeshPipeline(), build: 'manual',
    });
    this.depthPipe = gpu.renderPipeline({
      name: 'far detail depth', code: farDetailDepthFrag(g), layouts: [], params: FarViewParams, ...farDetailDepthPipeline(), build: 'manual',
    });
    // the meshes' distances (depth): made at the scene target's size on first use
    this.depthTex = null;
    this.depthZ = null;
    this.depthView = null;
    this.group = null;   // the cells kernel's group 2 (the scene's resources: made on first use)
    this._m = { worldToScene: new Matrix4(), sceneToWorld: new Matrix4(), eye: new Vector3(), proj: new Matrix4(), frustum: new Frustum(), box: new Box3() };
    this.worker = new Worker(new URL('./detail-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.accept(data);
    this.worker.onerror = (err) => {
      console.error('world detail worker', err);
      this.failed = true;
      this.pending = null; // the coarse field remains available
    };
  }

  reset() {
    this.epoch++;
    this.viewKey = null;
    for (const key of [...this.entries.keys()]) this.drop(key);
    this.mask.fill(0);
    this.maskDirty = true;
    this.wanted = [];
    this.blocked.clear();
    this.revisions.fill(0);
  }

  drop(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      for (const b of entry.buffers) this.sim._retire(b);
      this.entries.delete(key);
    }
    if (this.mask[key]) { this.mask[key] = 0; this.maskDirty = true; }
  }

  // Called before a leaving slab is replaced, and when the window is swept.
  // A readback/worker job started before the edit can never publish afterward.
  invalidate(lo, size) {
    for (const key of this.chunksAround(lo, size)) {
      this.revisions[key]++;
      this.blocked.delete(key);
      this.drop(key);
    }
  }

  // Called when a sweep re-reads live cells that chunks may pad into. Their
  // meshes are only out of date at the window's edge, not wrong: they stay
  // shown, and are rebuilt (tick: a step that matches no candidate's) and
  // swapped in whole by accept. Older jobs for them are still rejected.
  stale(lo, size) {
    for (const key of this.chunksAround(lo, size)) {
      this.revisions[key]++;
      this.blocked.delete(key);
      const entry = this.entries.get(key);
      if (entry) entry.step = 0;
    }
  }

  // Keys of the chunks whose meshes (with their padding) read cells in [lo, lo + size).
  *chunksAround(lo, size) {
    const C = DETAIL_CHUNK;
    for (let z = Math.max(0, Math.floor((lo[2] - PAD) / C)); z < Math.min(this.nz, Math.ceil((lo[2] + size[2] + PAD) / C)); z++)
      for (let x = Math.max(0, Math.floor((lo[0] - PAD) / C)); x < Math.min(this.nx, Math.ceil((lo[0] + size[0] + PAD) / C)); x++)
        yield x + z * this.nx;
  }

  /**
   * Before the scene draws (far.view): which chunks the view wants, and the
   * mask to the far field's occupancy buffer if it changed.
   * @param {object} camera the god or first-person camera (three)
   * @param {boolean} visible the far view draws this frame
   * @param {Matrix4} worldToScene world cells → scene units (the volume's matrix after the window's origin)
   */
  view(camera, visible, worldToScene) {
    const far = this.far, m = this._m;
    this.visible = visible;
    if (this.maskDirty) {
      this.gpu.write(far.occ, this.maskAt, this.mask);
      this.maskDirty = false;
    }
    if (!visible || !camera || !worldToScene) return;
    m.worldToScene.copy(worldToScene);
    m.sceneToWorld.copy(worldToScene).invert();
    const eye = m.eye.copy(camera.position).applyMatrix4(m.sceneToWorld);
    const height = Math.max(1, Math.round((globalThis.innerHeight ?? 720) * (globalThis.devicePixelRatio ?? 1)));
    const o = this.sim.origin;
    const bent = !!far.presentation?.active;
    const viewKey = `${camera.matrixWorld.elements}|${camera.fov}|${camera.aspect}|${height}|${o.x},${o.y},${o.z}|${far.presentation?.key}`;
    if (viewKey === this.viewKey) return;
    this.viewKey = viewKey;
    this.blocked.clear();
    const pixels = height / (2 * Math.tan((camera.fov ?? 60) * Math.PI / 360));
    camera.updateMatrixWorld?.();
    m.frustum.setFromProjectionMatrix(m.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const g = this.sim.g, C = DETAIL_CHUNK, size = this.win.size, candidates = [];
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) {
      const lo = [x * C, 0, z * C], hi = [Math.min(lo[0] + C, size[0]), size[1], Math.min(lo[2] + C, size[2])];
      if (lo[0] >= o.x && hi[0] <= o.x + g.nx && lo[2] >= o.z && hi[2] <= o.z + g.nz) continue;
      const box = m.box.set(new Vector3(...lo), new Vector3(...hi));
      const distance = Math.max(1, box.distanceToPoint(eye));
      if (pixels * 4 / distance < CELL_PIXELS || (!bent && !m.frustum.intersectsBox(box.applyMatrix4(m.worldToScene)))) continue;
      // Two geometric levels: real cells where coarse cells span >3 pixels,
      // the existing coarse field otherwise. Adjacent cached chunks share a
      // lattice; independent step sizes would open cracks between them.
      candidates.push({ key: x + z * this.nx, x: lo[0], z: lo[2], step: 1, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.wanted = candidates;
    // A cached chunk the view no longer wants stays as a spare (evicted first,
    // oldest first: makeRoom) unless the live window now covers it.
    const keep = new Set(this.wanted.map((c) => c.key));
    for (const key of [...this.entries.keys()]) {
      if (keep.has(key)) continue;
      const cx = (key % this.nx) * C, cz = Math.floor(key / this.nx) * C;
      if (cx + C > o.x && cx < o.x + g.nx && cz + C > o.z && cz < o.z + g.nz) this.drop(key);
    }
  }

  // Is the cache full for a mesh `bytes` big (0: any mesh at all)?
  full(bytes = 0) {
    return this.entries.size >= MAX_CHUNKS || this.bytes + bytes > MAX_BYTES || (!bytes && this.bytes >= MAX_BYTES);
  }

  // Evict until a mesh `bytes` big (0: just a slot) fits for a chunk at
  // `distance`: spares first, then wanted chunks farther than it, farthest
  // first. With `dry`, only report whether it would.
  makeRoom(distance, bytes, dry = false) {
    const wanted = new Set(this.wanted.map((c) => c.key));
    const victims = [...this.entries.keys()].filter((key) => !wanted.has(key));
    for (let i = this.wanted.length - 1; i >= 0 && this.wanted[i].distance > distance; i--)
      if (this.entries.has(this.wanted[i].key)) victims.push(this.wanted[i].key);
    if (dry) return !this.full(bytes) || victims.length > 0;
    for (const key of victims) {
      if (!this.full(bytes)) break;
      this.drop(key);
      if (wanted.has(key)) this.blocked.add(key);
    }
    return !this.full(bytes);
  }

  // Every frame (far.tick): the nearest wanted chunk without its mesh, its
  // cells recorded now and read back, then meshed in the worker.
  tick() {
    if (this.failed || this.pending || !this.far.built || !this.visible || this.win.pending) return;
    // (no mesh is made before all three are built: a published mask hands its chunk to a mesh that draws)
    const pipes = [this.stage, this.pipe, this.depthPipe];
    if (pipes.some((k) => k.state !== 'ready')) { for (const k of pipes) k.build(); return; }
    const job = this.wanted.find((c) => !this.blocked.has(c.key) && this.entries.get(c.key)?.step !== c.step);
    if (!job) return;
    // A chunk that couldn't be kept isn't built: before this check the nearest
    // one past the budget was read back, meshed and thrown away on every camera move.
    if (!this.entries.has(job.key) && !this.makeRoom(job.distance, 0, true)) {   // (a stale one replaces its own)
      for (const c of this.wanted) if (c.distance >= job.distance && !this.entries.has(c.key)) this.blocked.add(c.key);
      return;
    }
    const sim = this.sim, o = sim.origin, g = sim.g, gpu = this.gpu, res = this.win.gen.res;
    const token = { ...job, epoch: this.epoch, revision: this.revisions[job.key] };
    this.pending = token;
    const origin = [job.x - PAD, -PAD, job.z - PAD], side = this.layout.side, height = this.win.size[1];
    // the scene's prepass over the columns the cells read (held to the world), then the cells
    const c0 = [Math.max(0, origin[0]), Math.max(0, origin[2])], c1 = [Math.min(this.win.size[0], origin[0] + side), Math.min(this.win.size[2], origin[2] + side)];
    res.prepassFor([c0[0], 0, c0[1]], [c1[0], height, c1[1]]);
    this.group ??= gpu.bindGroup(this.stage.groups[2], res.entries([{ binding: SCENE_CELLS_BINDING, resource: { buffer: this.cells } }]), 'detail cells');
    this.stage.dispatch(gpu.frame, sceneCellsDispatch(this.layout), {
      bind: [sim.tables, sim.bindRO, this.group], header: sim.header(), params: { chunkLo: [origin[0], origin[2]] },
    });
    const live = [o.x, o.y, o.z, o.x + g.nx, o.y + g.ny, o.z + g.nz];
    const planted = this.win.planted.slice();
    const trees = this.win.scene.trees?.treesIn(origin[0] - TREE.REACH, origin[2] - TREE.REACH,
      origin[0] + side + TREE.REACH, origin[2] + side + TREE.REACH, this.win.P, this.win.candidates) ?? [];
    const edits = [];
    const wb = this.win.wb;
    for (let bz = Math.max(0, Math.floor(origin[2] / BRICK)); bz < Math.min(wb[2], Math.ceil((origin[2] + side) / BRICK)); bz++)
      for (let bx = Math.max(0, Math.floor(origin[0] / BRICK)); bx < Math.min(wb[0], Math.ceil((origin[0] + side) / BRICK)); bx++)
        for (let by = 0; by < wb[1]; by++) {
          const bytes = this.win.store.map.get(this.win.store.key(bx, by, bz));
          if (bytes) edits.push({ at: [bx * BRICK, by * BRICK, bz * BRICK], bytes });
        }
    gpu.readback.buffer(this.cells).then((buf) => {
      if (!this.valid(token)) { this.pending = null; return; }
      const raw = new Uint32Array(buf);
      this.worker.postMessage({ token, raw, layout: this.layout, origin, height, pad: PAD,
        bounds: [job.x, 0, job.z, Math.min(job.x + DETAIL_CHUNK, this.win.size[0]), height, Math.min(job.z + DETAIL_CHUNK, this.win.size[2])],
        live, planted, wb, trees, edits }, [raw.buffer, planted.buffer]);
    }).catch((err) => {
      if (!this.gpu.failure) console.error('world detail readback', err);
      this.pending = null;
      this.failed = true;
    });
  }

  valid(token) {
    return !this.disposed && token.epoch === this.epoch && token.revision === this.revisions[token.key]
      && this.wanted.some((c) => c.key === token.key && c.step === token.step);
  }

  accept({ token, positions, normals, ids, indices, liquid, error }) {
    this.pending = null;
    if (!this.valid(token)) return;
    if (error) { console.error('world detail mesh', error); this.failed = true; return; }
    const bytes = positions.byteLength + normals.byteLength + ids.length * 4 + (indices?.byteLength ?? 0);
    this.drop(token.key);
    // Keep the nearest chunks, never cycle through them forever when the
    // budget is full. Reconsider rejected chunks only after the view changes.
    if (!this.makeRoom(token.distance, bytes)) {
      for (const c of this.wanted) if (c.distance >= token.distance && !this.entries.has(c.key)) this.blocked.add(c.key);
      return;
    }
    if (!indices?.length) return;   // (nothing to draw: the mask stays clear, the field draws it)
    const gpu = this.gpu;
    const upload = (label, data, usage) => {
      const b = gpu.createBuffer({ label, size: Math.max(4, Math.ceil(data.byteLength / 4) * 4), usage: usage | BUFFER.COPY_DST });
      gpu.write(b, 0, data, { ordered: false });
      return b;
    };
    const u32 = indices instanceof Uint32Array;
    // (16-bit indices padded to whole words: a buffer write is 4-byte aligned)
    const index = u32 || indices.length % 2 === 0 ? indices : Uint16Array.from([...indices, 0]);
    const buffers = [
      upload('detail positions', positions, BUFFER.VERTEX), upload('detail normals', normals, BUFFER.VERTEX),
      upload('detail elements', Uint32Array.from(ids), BUFFER.VERTEX), upload('detail indices', index, BUFFER.INDEX),
    ];
    this.entries.set(token.key, { buffers, count: indices.length, format: u32 ? 'uint32' : 'uint16', bytes, step: token.step });
    this.bytes += bytes;
    // Publish the mesh and its ownership together; the raymarch must never
    // skip a chunk whose geometry is still being prepared.
    this.mask[token.key] = liquid ? 2 : 1;
    this.maskDirty = true;
  }

  /**
   * Draws the chunks' meshes into our scene pass, before the far view (its
   * params: the far view's, written for this frame). Nothing while the view
   * doesn't draw or the pipeline builds. Returns the meshes drawn.
   * @param {GPURenderPassEncoder} rp
   * @param {object} params the far view's (FarViewParams values)
   * @param {GPUBindGroup[]} bind groups 0-2: the far view's
   */
  draw(rp, params, bind) {
    if (!this.visible || this.pipe.state !== 'ready' || !this.entries.size) return 0;
    const header = { origin: [0, 0, 0], src: this.sim.cur, dst: this.sim.cur };
    for (const e of this.entries.values()) {
      this.pipe.draw(rp, { bind, header, params, count: e.count, vertexBuffers: e.buffers.slice(0, 3), index: { buffer: e.buffers[3], format: e.format } });
    }
    return this.entries.size;
  }

  /**
   * The meshes' rasterized depth (0 where none) into the depth
   * target, at the scene target's size, in a render pass of its own recorded
   * now: before the scene pass, after FrameUniforms is written (the far
   * field's prepass). Returns whether it drew (nothing to draw, or its
   * pipeline building: the view goes without).
   * @param {{ width: number, height: number }} size the scene target's
   * @param {object} params the far view's (FarViewParams values) for this frame
   */
  depth(size, params) {
    if (!this.visible || !this.entries.size || this.depthPipe.state !== 'ready') return false;
    const gpu = this.gpu, w = size.width, h = size.height;
    if (!this.depthTex || this.depthTex.width !== w || this.depthTex.height !== h) {
      this._dropDepth();
      // (copied out only by tools: world-detail-check reads it back)
      const usage = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | (gpu.testMode ? TEX.COPY_SRC : 0);
      this.depthTex = gpu.createTexture({ label: 'far detail depth', size: [w, h], format: FAR_DETAIL_DEPTH_FORMAT, usage });
      this.depthZ = gpu.createTexture({ label: 'far detail depth z', size: [w, h], format: 'depth32float', usage: TEX.RENDER_ATTACHMENT });
      this.depthView = this.depthTex.createView({ label: 'far detail depth' });
    }
    const rp = gpu.frame.render({
      colorAttachments: [{ view: this.depthView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: this.depthZ.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' },
    }, 'far detail depth');
    try {
      for (const e of this.entries.values()) {
        this.depthPipe.draw(rp, { params, count: e.count, vertexBuffers: [e.buffers[0]], index: { buffer: e.buffers[3], format: e.format } });
      }
    } finally {
      rp.end();
    }
    return true;
  }

  _dropDepth() {
    for (const t of [this.depthTex, this.depthZ]) if (t) this.sim._retire(t);
    this.depthTex = this.depthZ = this.depthView = null;
  }

  dispose() {
    this.disposed = true;
    this.reset();
    this.worker.terminate();
    this.sim._retire(this.cells);
    this._dropDepth();
  }
}
