import * as THREE from 'three';
import { rawMat, makeFieldTarget } from '../sim.js';
import { BRICK } from '../shaders/common.js';
import { farSceneLayout, farSceneCellsFrag, farFrag, farMeshVert } from '../shaders/far.js';
import { TREE } from './generator.js';

// Render-only chunks. GPU scene cells + persisted edits are meshed once in a
// worker, not simulated, and replace (rather than overlay) coarse geometry.
export const DETAIL_CHUNK = 32;
const PAD = 4, MAX_CHUNKS = 96, MAX_BYTES = 96 * 1024 * 1024;
const CELL_PIXELS = 3; // largest projected cell before requesting finer geometry

export class WorldDetail {
  constructor(far) {
    this.far = far;
    this.win = far.win;
    this.renderer = far.renderer;
    this.nx = Math.ceil(far.win.size[0] / DETAIL_CHUNK);
    this.nz = Math.ceil(far.win.size[2] / DETAIL_CHUNK);
    this.mask = new Uint8Array(this.nx * this.nz);
    this.revisions = new Uint32Array(this.mask.length);
    this.texture = new THREE.DataTexture(this.mask, this.nx, this.nz, THREE.RedFormat);
    this.texture.needsUpdate = true;
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.unpackAlignment = 1;
    far.mesh.material.uniforms.tDetailMask = { value: this.texture };
    this.material = new THREE.ShaderMaterial({
      name: 'worldDetail', vertexShader: farMeshVert,
      fragmentShader: farFrag(far.sim.g, far.L, true),
      uniforms: far.mesh.material.uniforms,
    });
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.depthScene = new THREE.Scene();
    this.depthGroup = new THREE.Group();
    this.depthGroup.matrixAutoUpdate = false;
    this.depthScene.add(this.depthGroup);
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: true,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    Object.assign(far.mesh.material.uniforms, {
      tDetailDepth: { value: this.depthTarget.texture }, uDetailHasDepth: { value: false },
    });
    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: farMeshVert, uniforms: far.mesh.material.uniforms,
      fragmentShader: `
        varying vec3 vWorld;
        uniform mat4 uSceneToWorld;
        uniform ivec3 uWinLo;
        void main() {
          if (all(greaterThanEqual(vWorld.xz, vec2(uWinLo.xz))) &&
              all(lessThan(vWorld.xz, vec2(uWinLo.xz + ivec2(${far.sim.g.nx}, ${far.sim.g.nz}))))) discard;
          vec3 eye = (uSceneToWorld * vec4(cameraPosition, 1.0)).xyz;
          gl_FragColor = vec4(length(vWorld - eye), 0.0, 0.0, 1.0);
        }`,
    });
    // Runs after post has applied this frame's projection jitter. The coarse
    // trace stops at the actual cached surface, not the old inflated crown.
    far.mesh.onBeforeRender = (renderer, scene, camera) => this.depth(camera);
    this.entries = new Map();
    this.wanted = [];
    this.blocked = new Set();
    this.epoch = 0;
    this.bytes = 0;
    this.pending = null;
    this.layout = farSceneLayout(far.L, DETAIL_CHUNK + 2 * PAD);
    this.cells = makeFieldTarget(this.layout.width, this.layout.height, 1, THREE.HalfFloatType, THREE.NearestFilter);
    this.stage = rawMat(farSceneCellsFrag(far.sim.g, far.L, far.scene.glsl(far.sim.g), this.layout, true), {
      ...this.win.sceneU, tA: { value: null },
      uChunkLo: { value: new THREE.Vector2() }, uLiveOrigin: far.sim.originUniform,
    });
    this.stage.name = 'detailCells';
    far.mats.detailCells = this.stage; // included in the window's background compile
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
    for (const key of this.entries.keys()) this.drop(key);
    this.wanted = [];
    this.blocked.clear();
    this.revisions.fill(0);
  }

  drop(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      entry.mesh.removeFromParent();
      entry.depthMesh.removeFromParent();
      entry.mesh.geometry.dispose();
      this.entries.delete(key);
    }
    this.mask[key] = 0;
    this.texture.needsUpdate = true;
  }

  // Called before a leaving slab is replaced, and when the window is swept.
  // A readback/worker job started before the edit can never publish afterward.
  invalidate(lo, size) {
    const C = DETAIL_CHUNK;
    for (let z = Math.max(0, Math.floor((lo[2] - PAD) / C)); z < Math.min(this.nz, Math.ceil((lo[2] + size[2] + PAD) / C)); z++)
      for (let x = Math.max(0, Math.floor((lo[0] - PAD) / C)); x < Math.min(this.nx, Math.ceil((lo[0] + size[0] + PAD) / C)); x++) {
        const key = x + z * this.nx;
        this.revisions[key]++;
        this.blocked.delete(key);
        this.drop(key);
      }
  }

  view(camera, visible) {
    const far = this.far;
    if (!this.group.parent && far.mesh.parent) far.mesh.parent.add(this.group);
    this.group.visible = visible;
    if (!visible) return;
    this.group.matrix.copy(far.worldToScene);
    this.group.matrixWorldNeedsUpdate = true;
    this.depthGroup.matrix.copy(far.worldToScene);
    this.depthGroup.matrixWorldNeedsUpdate = true;
    const eye = camera.position.clone().applyMatrix4(far.sceneToWorld);
    const viewKey = `${camera.matrixWorld.elements}|${camera.fov}|${camera.aspect}|${this.renderer.domElement.height}|${far.sim.origin.toArray()}`;
    if (viewKey === this.viewKey) return;
    this.viewKey = viewKey;
    this.blocked.clear();
    const pixels = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(camera.fov * Math.PI / 360));
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const o = far.sim.origin, g = far.sim.g, C = DETAIL_CHUNK, candidates = [];
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) {
      const lo = [x * C, 0, z * C], hi = [Math.min(lo[0] + C, far.win.size[0]), far.win.size[1], Math.min(lo[2] + C, far.win.size[2])];
      if (lo[0] >= o.x && hi[0] <= o.x + g.nx && lo[2] >= o.z && hi[2] <= o.z + g.nz) continue;
      const box = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
      const distance = Math.max(1, box.distanceToPoint(eye));
      if (pixels * 4 / distance < CELL_PIXELS || !frustum.intersectsBox(box.applyMatrix4(far.worldToScene))) continue;
      // Two geometric levels: real cells where coarse cells span >3 pixels,
      // the existing coarse field otherwise. Adjacent cached chunks share a
      // lattice; independent step sizes would open cracks between them.
      const step = 1;
      candidates.push({ key: x + z * this.nx, x: lo[0], z: lo[2], step, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.wanted = candidates;
    const keep = new Set(this.wanted.map((c) => c.key));
    for (const key of this.entries.keys()) if (!keep.has(key)) this.drop(key);
  }

  tick() {
    if (this.failed || this.pending || !this.far.ready || !this.group.visible || this.win.pending) return;
    const job = this.wanted.find((c) => !this.blocked.has(c.key) && this.entries.get(c.key)?.step !== c.step);
    if (!job) return;
    const sim = this.far.sim, o = sim.origin, g = sim.g;
    const token = { ...job, epoch: this.epoch, revision: this.revisions[job.key] };
    this.pending = token;
    const origin = [job.x - PAD, -PAD, job.z - PAD], side = this.layout.side, height = this.win.size[1];
    this.stage.uniforms.uChunkLo.value.set(origin[0], origin[2]);
    this.stage.uniforms.tA.value = sim.stateA;
    const prev = this.renderer.getRenderTarget();
    sim.run(this.stage, this.cells);
    this.renderer.setRenderTarget(prev);
    const raw = new Uint16Array(this.cells.width * this.cells.height * 4);
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
    this.renderer.readRenderTargetPixelsAsync(this.cells, 0, 0, this.cells.width, this.cells.height, raw).then(() => {
      if (!this.valid(token)) { this.pending = null; return; }
      this.worker.postMessage({ token, raw, layout: this.layout, origin, height, pad: PAD,
        bounds: [job.x, 0, job.z, Math.min(job.x + DETAIL_CHUNK, this.win.size[0]), height, Math.min(job.z + DETAIL_CHUNK, this.win.size[2])],
        live, planted, wb, trees, edits }, [raw.buffer, planted.buffer]);
    }).catch((err) => {
      console.error('world detail readback', err);
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
    const bytes = positions.byteLength + normals.byteLength + ids.byteLength + (indices?.byteLength ?? 0);
    this.drop(token.key);
    // Keep the nearest chunks, never cycle through them forever when the
    // budget is full. Reconsider rejected chunks only after the view changes.
    for (const candidate of [...this.wanted].reverse()) {
      if (this.bytes + bytes <= MAX_BYTES && this.entries.size < MAX_CHUNKS) break;
      if (candidate.distance <= token.distance) break;
      if (this.entries.has(candidate.key)) { this.drop(candidate.key); this.blocked.add(candidate.key); }
    }
    if (this.bytes + bytes > MAX_BYTES || this.entries.size >= MAX_CHUNKS) {
      for (const c of this.wanted) if (c.distance >= token.distance && !this.entries.has(c.key)) this.blocked.add(c.key);
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('element', new THREE.BufferAttribute(ids, 1));
    if (indices) geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    const depthMesh = new THREE.Mesh(geo, this.depthMaterial);
    this.group.add(mesh);
    this.depthGroup.add(depthMesh);
    this.entries.set(token.key, { mesh, depthMesh, bytes, step: token.step });
    this.bytes += bytes;
    // Publish the mesh and its ownership together; the raymarch must never
    // skip a chunk whose geometry is still being prepared.
    this.mask[token.key] = liquid ? 2 : 1;
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    this.reset();
    this.worker.terminate();
    this.group.removeFromParent();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.depthTarget.dispose();
    this.texture.dispose();
    this.cells.dispose();
    // stage belongs to far.mats
  }

  depth(camera) {
    const r = this.renderer, target = r.getRenderTarget();
    this.far.mesh.material.uniforms.uDetailHasDepth.value = !!this.entries.size && this.group.visible;
    if (!this.entries.size || !this.group.visible) return;
    const size = target ? { x: target.width, y: target.height } : r.getDrawingBufferSize(new THREE.Vector2());
    this.depthTarget.setSize(size.x, size.y);
    const color = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setRenderTarget(this.depthTarget);
    r.setClearColor(0, 0);
    r.clear();
    r.render(this.depthScene, camera);
    r.setClearColor(color, alpha);
    r.setRenderTarget(target);
  }
}
