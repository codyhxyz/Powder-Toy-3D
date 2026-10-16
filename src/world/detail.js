import { Vector3, Matrix4, Frustum, Box3, WebGPUCoordinateSystem } from 'three/webgpu';
// Cache ownership, limits and checks: docs/world-lod.md.
import { BRICK } from '../shaders/common.js';
import {
  DETAIL_CHUNK, DETAIL_PAD, detailChunks, detailMaskAt, farSceneLayout, farSceneCellsFrag, farFrag, farMeshPipeline,
  SceneCellsParams, sceneCellsDispatch, SCENE_CELLS_LAYOUT_OF, SCENE_CELLS_BINDING, FarViewParams,
  farDetailDepthFrag, farDetailDepthPipeline, FAR_DETAIL_DEPTH_FORMAT,
} from '../shaders/far.js';
import { TREE } from './generator.js';
import { warpBox, IDENTITY } from '../gfx/presentationMath.js';
import { materialWord } from '../appearance.js';

export { DETAIL_CHUNK };

// Render-only chunks (docs/world-lod.md; docs/webgpu.md G1): the visible world
// as meshes of its cells, independently of the simulated window. A chunk's cells (the
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
// effect), the chunks wanted change with it (the view key). Conservative
// warped bounds keep frustum culling without rejecting curved geometry.
// All view-intersecting columns are wanted at one-cell resolution, nearest
// first within each priority class, with a bounded pool of mesh workers.
// Exposed missing meshes precede live-window prewarming and stale replacements.
// The cells kernel and both pipelines build alongside the far view at boot or
// view switch (B5: nothing builds in views that don't draw it).
// Keep a look-around's working set; wanted geometry is never budget-evicted.
// Until a mesh arrives there is a loading gap, not a coarse opaque substitute.
const PAD = DETAIL_PAD, SPARE_CHUNKS = 192, SPARE_BYTES = 96 * 1024 * 1024;
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
    this.dirty = new Map();
    this.simVersion = this.sim.version;
    this.epoch = 0;
    this.bytes = 0;
    this.spareChunks = SPARE_CHUNKS;
    this.spareBytes = SPARE_BYTES;
    this.retentionViews = 1;
    this.pending = new Map();
    this.visible = false;
    this.viewKey = null;
    this.disposed = false;
    this.onChange = null; // world wire → pacer: async results redraw even while paused
    this.layout = farSceneLayout(L, DETAIL_CHUNK + 2 * PAD);
    this.cells = gpu.createBuffer({ label: 'detail cells', size: this.layout.cells * 4, usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
    // Its kernel and pipelines build with the far view; the window's don't wait for them.
    const scene = this.win.scene, sceneKey = JSON.stringify(SCENE_CELLS_LAYOUT_OF(scene));
    this.stage = gpu.kernel({
      name: `${scene.key} detailCells`, code: farSceneCellsFrag(g, L, scene.glsl(g), this.layout, true),
      layouts: [this.sim.L.TABLES, this.sim.L.STATE_RO, gpu.layout(`far scene cells ${sceneKey}`, SCENE_CELLS_LAYOUT_OF(scene))],
      params: SceneCellsParams, build: 'manual',
    });
    this.pipe = gpu.renderPipeline({
      name: 'far detail', code: farFrag(g, L, true, { sourceAppearance: far.sourceAppearance }), layouts: [far.viewFrameLayout, this.sim.L.STATE_RO, gpu.L.LIGHTING],
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
    const capacity = Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 6) - 2));
    this.workers = Array.from({ length: capacity }, () => {
      const worker = new Worker(new URL('./detail-worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, token: null };
      worker.onmessage = ({ data }) => this.accept(data);
      worker.onerror = (err) => this.fail('worker', err);
      return slot;
    });
  }

  reset() {
    this.epoch++;
    this.pending.clear(); // occupied slots drain their old readback/mesh before reuse
    this.viewKey = null;
    for (const key of [...this.entries.keys()]) this.drop(key);
    this.mask.fill(0);
    this.maskDirty = true;
    this.wanted = [];
    this.spareChunks = SPARE_CHUNKS;
    this.spareBytes = SPARE_BYTES;
    this.retentionViews = 1;
    this.dirty.clear();
    this.simVersion = this.sim.version;
    this.revisions.fill(0);
    this.onChange?.();
  }

  drop(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      for (const b of entry.buffers) this.sim._retire(b);
      this.entries.delete(key);
    }
    if (this.mask[key]) { this.mask[key] = 0; this.maskDirty = true; }
    if (entry) this.onChange?.();
  }

  // Explicit destructive invalidation. Ordinary summaries use stale instead.
  // A readback/worker job started before this call cannot publish afterward.
  invalidate(lo, size) {
    for (const key of this.chunksAround(lo, size)) {
      this.revisions[key]++;
      this.drop(key);
    }
  }

  // Simulation writes dirty geometry; moving the window only moves ownership.
  // Keep the last mesh until its replacement is ready, including leaving slabs.
  stale(lo, size) {
    if (this.simVersion !== this.sim.version) {
      const o = this.sim.origin, g = this.sim.g;
      for (const key of this.chunksAround([o.x, o.y, o.z], [g.nx, g.ny, g.nz])) this.dirty.set(key, this.sim.version);
      this.simVersion = this.sim.version;
    }
    for (const key of this.chunksAround(lo, size)) {
      const changed = this.dirty.get(key);
      if (changed === undefined) continue;
      this.dirty.delete(key);
      const entry = this.entries.get(key), pending = this.pending.get(key);
      // A mesh/readback started after these writes already includes them.
      const oldEntry = entry && entry.version < changed, oldJob = pending && pending.version < changed;
      if (!oldEntry && !oldJob) continue;
      if (!pending || oldJob) this.revisions[key]++;
      if (oldEntry) entry.step = 0;
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
    const bend = far.presentation?.active ? far.presentation.parameters : IDENTITY;
    const viewKey = `${camera.matrixWorld.elements}|${camera.fov}|${camera.aspect}|${height}|${o.x},${o.y},${o.z}|${far.presentation?.key}`;
    if (viewKey === this.viewKey) return;
    this.viewKey = viewKey;
    camera.updateMatrixWorld?.();
    m.frustum.setFromProjectionMatrix(m.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
    const C = DETAIL_CHUNK, size = this.win.size, candidates = [];
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) {
      const lo = [x * C, 0, z * C], hi = [Math.min(lo[0] + C, size[0]), size[1], Math.min(lo[2] + C, size[2])];
      const box = m.box.set(new Vector3(...lo), new Vector3(...hi));
      const distance = Math.max(1, box.distanceToPoint(eye));
      if (!m.frustum.intersectsBox(warpBox(box, bend).applyMatrix4(m.worldToScene))) continue;
      // One shared cell lattice at every distance, including adjacent seams.
      candidates.push({ key: x + z * this.nx, x: lo[0], z: lo[2], step: 1, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.wanted = candidates;
    const horizontalFov = 2 * Math.atan(Math.tan((camera.fov ?? 70) * Math.PI / 360) * (camera.aspect ?? 1));
    // A real turn passes through several frusta, not just two opposite views.
    this.retentionViews = Math.ceil(2 * Math.PI / horizontalFov);
    // Map order is last use, not build order: revisiting a view refreshes it.
    for (const { key } of candidates) {
      const entry = this.entries.get(key);
      if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    }
    this.trimSpares();
    // Cache residency is independent of physics residency. The shaders clip
    // live-window fragments; keep their meshes ready for when the window moves.
  }

  // Wanted entries do not consume spare budgets and are never victims.
  trimSpares() {
    const wanted = new Set(this.wanted.map((c) => c.key));
    const spares = [];
    let wantedBytes = 0;
    for (const [key, e] of this.entries) {
      if (wanted.has(key)) wantedBytes += e.bytes;
      else spares.push([key, e]);
    }
    // Size spares for a panorama, not a tiny fixed fraction of the old view.
    const views = this.retentionViews ?? 1;
    this.spareChunks = Math.min(this.mask.length, Math.max(this.spareChunks ?? SPARE_CHUNKS, wanted.size * views));
    this.spareBytes = Math.max(this.spareBytes ?? SPARE_BYTES, wantedBytes * views);
    let count = spares.length, bytes = spares.reduce((n, [, e]) => n + e.bytes, 0);
    for (const [key, e] of spares) {
      if (count <= this.spareChunks && bytes <= this.spareBytes) break;
      this.drop(key); // oldest offscreen spare first
      count--; bytes -= e.bytes;
    }
  }

  // A column is hidden only if the live volume covers its entire world height.
  covered(c) {
    const o = this.sim.origin, g = this.sim.g, size = this.win.size;
    return o.x <= c.x && o.z <= c.z && o.y <= 0 && o.y + g.ny >= size[1] &&
      o.x + g.nx >= Math.min(c.x + DETAIL_CHUNK, size[0]) &&
      o.z + g.nz >= Math.min(c.z + DETAIL_CHUNK, size[2]);
  }

  jobs() {
    return this.wanted.filter(c => !this.pending.has(c.key) && this.entries.get(c.key)?.step !== c.step)
      .sort((a, b) => {
        const rank = c => this.entries.has(c.key) ? 2 : this.covered(c) ? 1 : 0;
        return rank(a) - rank(b) || a.distance - b.distance;
      });
  }

  // Only runnable work keeps rAF awake. Async waits wake it on completion.
  get busy() {
    return !this.disposed && !this.failed && this.far.built && this.visible &&
      this.workers.some(s => !s.token) && !this.building && !this.waitingWindow &&
      this.jobs().length > 0;
  }

  sameJob(a, b) {
    return !!a && !!b && ['key', 'epoch', 'revision', 'version'].every(k => a[k] === b[k]);
  }

  completed(token) {
    if (this.sameJob(this.pending.get(token.key), token)) this.pending.delete(token.key);
    const slot = this.workers.find(s => this.sameJob(s.token, token));
    if (slot) slot.token = null;
    if (!this.failed && !this.disposed) this.onChange?.();
  }

  fail(where, err) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    if (!this.gpu.failure) console.error(`world detail ${where}`, err);
    for (const slot of this.workers) { slot.worker.terminate(); slot.token = null; }
    this.pending.clear();
    this.onChange?.();
  }

  // The world wire starts all three builds alongside the far-view build.
  build() {
    if (this.buildPromise) return this.buildPromise;
    if (this.disposed || this.failed) return Promise.resolve();
    const pipes = [this.stage, this.pipe, this.depthPipe];
    if (pipes.every(k => k.state === 'ready')) return Promise.resolve();
    this.buildPromise = this.building = Promise.all(pipes.map(k => k.build())).then(() => {
      this.building = null;
      if (!this.disposed && !this.failed) this.onChange?.();
    }, err => { this.building = null; this.fail('build', err); });
    return this.buildPromise;
  }

  // Each slot stays occupied through readback and meshing, including old epochs.
  tick() {
    if (this.disposed || this.failed || !this.far.built || !this.visible) return;
    if (this.win.pending) {
      if (!this.waitingWindow) this.waitingWindow = this.win.pending.then(() => {
        this.waitingWindow = null;
        if (!this.disposed && !this.failed) this.onChange?.();
      }, err => { this.waitingWindow = null; this.fail('window transfer', err); });
      return;
    }
    // No ownership is published before all three pipelines can draw.
    if ([this.stage, this.pipe, this.depthPipe].some(k => k.state !== 'ready')) { this.build(); return; }
    const jobs = this.jobs();
    for (const slot of this.workers) {
      if (slot.token) continue;
      const job = jobs.shift();
      if (!job) break;
      try { this.submit(job, slot); }
      catch (err) { this.fail('submission', err); break; }
    }
  }

  submit(job, slot) {
    const sim = this.sim, o = sim.origin, g = sim.g, gpu = this.gpu, res = this.win.gen.res;
    const token = { ...job, epoch: this.epoch, revision: this.revisions[job.key], version: sim.version };
    this.pending.set(job.key, token);
    slot.token = token;
    const origin = [job.x - PAD, -PAD, job.z - PAD], side = this.layout.side, height = this.win.size[1];
    // the scene's prepass over the columns the cells read (held to the world), then the cells
    const c0 = [Math.max(0, origin[0]), Math.max(0, origin[2])], c1 = [Math.min(this.win.size[0], origin[0] + side), Math.min(this.win.size[2], origin[2] + side)];
    res.prepassFor([c0[0], 0, c0[1]], [c1[0], height, c1[1]]);
    this.group ??= gpu.bindGroup(this.stage.groups[2], res.entries([{ binding: SCENE_CELLS_BINDING, resource: { buffer: this.cells } }]), 'detail cells');
    this.stage.dispatch(gpu.frame, sceneCellsDispatch(this.layout), {
      bind: [sim.tables, sim.bindRO, this.group], header: sim.readHeader(), params: { chunkLo: [origin[0], origin[2]] },
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
    // readback.buffer records a copy into its own staging buffer NOW, before
    // the next dispatch overwrites shared cells. Keep dispatch/copy pairs ordered.
    gpu.readback.buffer(this.cells).then((buf) => {
      if (!this.valid(token)) { this.completed(token); return; }
      const raw = new Uint32Array(buf);
      slot.worker.postMessage({ token, raw, layout: this.layout, origin, height, pad: PAD,
        bounds: [job.x, 0, job.z, Math.min(job.x + DETAIL_CHUNK, this.win.size[0]), height, Math.min(job.z + DETAIL_CHUNK, this.win.size[2])],
        live, planted, wb, trees, edits }, [raw.buffer, planted.buffer]);
    }).catch((err) => {
      this.fail('readback', err);
      this.completed(token);
    });
  }

  valid(token) {
    return !this.disposed && !this.failed && token.epoch === this.epoch &&
      token.revision === this.revisions[token.key] && this.sameJob(this.pending.get(token.key), token);
  }

  accept({ token, positions, normals, ids, appearances, indices, liquid, error }) {
    const uploaded = [];
    try {
      if (!this.valid(token)) return;
      if (error) { this.fail('mesh', error); return; }
      const bytes = positions.byteLength + normals.byteLength + ids.length * 4 + (indices?.byteLength ?? 0);
      // A late offscreen result cannot displace wanted geometry or allocate an
      // oversized spare. Wanted replacements have no geometry budget cutoff.
      if (!this.wanted.some(c => c.key === token.key) && bytes > (this.spareBytes ?? SPARE_BYTES)) return;
      const gpu = this.gpu;
      const upload = (label, data, usage) => {
        const b = gpu.createBuffer({ label, size: Math.max(4, Math.ceil(data.byteLength / 4) * 4), usage: usage | BUFFER.COPY_DST });
        uploaded.push(b);
        gpu.write(b, 0, data, { ordered: false });
        return b;
      };
      const u32 = indices instanceof Uint32Array;
      // (16-bit indices padded to whole words: a buffer write is 4-byte aligned)
      const index = !indices || u32 || indices.length % 2 === 0 ? indices : Uint16Array.from([...indices, 0]);
      const buffers = indices?.length ? [
        upload('detail positions', positions, BUFFER.VERTEX), upload('detail normals', normals, BUFFER.VERTEX),
        upload('detail materials', Uint32Array.from(ids, (id, i) => materialWord(id, appearances?.[i] ?? 0)), BUFFER.VERTEX), upload('detail indices', index, BUFFER.INDEX),
      ] : [];
      const bounds = new Box3().setFromArray(positions);
      this.drop(token.key);
      this.entries.set(token.key, { buffers, count: indices?.length ?? 0, format: u32 ? 'uint32' : 'uint16', bytes, step: token.step, version: token.version, bounds });
      this.bytes += bytes;
      // Publish the mesh and its ownership together; the raymarch must never
      // skip a chunk whose geometry is still being prepared.
      this.mask[token.key] = buffers.length ? (liquid ? 2 : 1) : 0;
      this.maskDirty = true;
      uploaded.length = 0; // ownership transferred to the entry
      this.trimSpares();
    } catch (err) {
      for (const b of uploaded) this.sim._retire(b);
      this.fail('upload', err);
    } finally { this.completed(token); }
  }

  // Cache residency is not visibility. Use the actual jittered draw matrix;
  // Curved geometry needs warped bounds, not the flat mesh's box.
  *visibleDrawEntries(params) {
    const frustum = this._m.frustum, box = this._m.box;
    const bend = params.warpK ? { k: params.warpK, anchor: params.warpAnchor, dir: params.warpDir } : IDENTITY;
    frustum.setFromProjectionMatrix(params.worldToClip, WebGPUCoordinateSystem);
    for (const e of this.entries.values()) {
      if (e.count && frustum.intersectsBox(warpBox(e.bounds, bend, box))) yield e;
    }
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
    const header = { ...this.sim.readHeader(), origin: [0, 0, 0] };
    let drawn = 0;
    for (const e of this.visibleDrawEntries(params)) {
      this.pipe.draw(rp, { bind, header, params, count: e.count, vertexBuffers: e.buffers.slice(0, 3), index: { buffer: e.buffers[3], format: e.format } });
      drawn++;
    }
    return drawn;
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
      for (const e of this.visibleDrawEntries(params)) {
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
    for (const slot of this.workers) { slot.worker.terminate(); slot.token = null; }
    this.sim._retire(this.cells);
    this._dropDepth();
  }
}
