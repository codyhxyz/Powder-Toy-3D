// The blocks renderer (?blocks, __app.setBlocks): the world drawn as the
// visible faces of its cells, Minecraft's way, instead of the volume's march
// (gfx/volume.js). The WGSL and what it does are shaders/blocks.js's; this
// module owns the face buffer, the counters and drawIndirect's args, makes the
// pipelines and bind groups once per grid, and records the work:
//
//   const blocks = createBlocks(gpu, sim, { world });   // world: a world's window (no faces past its sides)
//   await blocks.ready;
//   compute hook:  blocks.update();                   // re-meshes only when the state or the window moved
//   scene pass:    blocks.drawOpaque(rp, { view, marchNear, floor }); …; blocks.drawTranslucent(rp, { view, marchNear });
//
// A still scene records nothing: update() keys the mesh on the simulation's
// version, its current copy and the window's origin, so deep idle holds (no
// submits, docs/webgpu.md F7). Overflow: faces past a half's capacity are
// dropped (the draw's count is clamped on the GPU) and the raw counts come
// back through a readback slot, which warns once per grid.
import { frameUniformsOf } from './uniforms.js';
import { fold } from '../gpu/kernels.js';
import {
  meshWGSL, drawWGSL, MeshParams, BlockDrawParams, MESH_LAYOUTS, DRAW_LAYOUTS, LAYOUT_NAMES, FACE_BYTES,
  MESH_WORKGROUP, MESH_RESULT_BYTES, faceCapacity, blockPipelines,
} from '../shaders/blocks.js';

// slots of the counts' readback ring (a mesh a frame, read 1-3 frames later)
const RING_SLOTS = 16;
const BUF = { INDIRECT: 0x100, STORAGE: 0x80, COPY_DST: 0x08 };   // (GPUBufferUsage's bits)

/**
 * @param {object} gpu
 * @param {import('../sim.js').Simulation} sim
 * @param {{ world?: boolean }} [opts] world: the grid is a world's window
 */
export function createBlocks(gpu, sim, { world = false } = {}) {
  const g = sim.g;
  const fu = frameUniformsOf(gpu);
  const label = (x) => `sim${sim.id} blocks ${x}`;
  const L = {};
  for (const [names, groups] of [[LAYOUT_NAMES.mesh, MESH_LAYOUTS()], [LAYOUT_NAMES.draw, DRAW_LAYOUTS()]]) {
    names.forEach((name, i) => { L[name] = gpu.layout(name, groups[i]); });
  }
  const cap = faceCapacity(g, gpu.device.limits.maxStorageBufferBindingSize);
  const faces = gpu.createBuffer({ label: label('faces'), size: (cap.o + cap.t) * FACE_BYTES, usage: BUF.STORAGE });
  const counts = gpu.createBuffer({ label: label('counts'), size: 16, usage: BUF.STORAGE });
  const args = gpu.createBuffer({ label: label('args'), size: 32, usage: BUF.STORAGE | BUF.INDIRECT });
  const ring = gpu.readback.ring(label('counts ring'), MESH_RESULT_BYTES, RING_SLOTS);
  const meshGroup = gpu.bindGroup(L.BLOCK_MESH, [
    { binding: 0, resource: { buffer: faces } }, { binding: 1, resource: { buffer: counts } },
    { binding: 2, resource: { buffer: args } }, { binding: 3, resource: { buffer: ring.buffer } },
  ], label('mesh'));
  const facesGroup = gpu.bindGroup(L.BLOCK_FACES, [{ binding: 0, resource: { buffer: faces } }], label('faces'));

  const meshCode = meshWGSL(g);
  const mesh = gpu.kernel({
    name: 'blocks.mesh', code: meshCode, layouts: [L.TABLES, L.STATE_RO, L.BLOCK_MESH], params: MeshParams, workgroupSize: [MESH_WORKGROUP, 1, 1],
  });
  const finish = gpu.kernel({
    name: 'blocks.finish', code: meshCode, entry: 'finish', layouts: [L.TABLES, L.STATE_RO, L.BLOCK_MESH], params: MeshParams, workgroupSize: [1, 1, 1],
  });
  const drawCode = drawWGSL(g);
  const p = blockPipelines();
  const pipe = (name, desc) => gpu.renderPipeline({ name, code: drawCode, layouts: [fu.layout, L.BLOCK_FACES], params: BlockDrawParams, ...desc });
  const opaque = pipe('blocks.opaque', p.opaque);
  const translucent = pipe('blocks.translucent', p.translucent);
  const floor = pipe('blocks.floor', p.floor);
  const all = [mesh, finish, opaque, translucent, floor];

  let lastKey = null;
  let warned = false;
  let disposed = false;
  const stats = { meshes: 0, opaque: 0, translucent: 0, capO: cap.o, capT: cap.t, overflow: false };
  const modeOf = (view) => (view === 'heat' ? 1 : 0);

  const blocks = {
    sim,
    stats,
    /** Every pipeline is built. */
    ready: Promise.all(all.map((x) => x.ready)).then(() => blocks),
    get isReady() { return all.every((x) => x.state === 'ready'); },
    /** The key the last mesh was made for (null: none yet). */
    get meshKey() { return lastKey; },

    /**
     * Re-meshes into the open frame if the state or the window changed since
     * the last mesh (and the kernels are built). True when it recorded one.
     * @param {{ force?: boolean }} [opts]
     */
    update({ force = false } = {}) {
      if (disposed || mesh.state !== 'ready' || finish.state !== 'ready') return false;
      const key = `${sim.version}|${sim.cur}|${sim.origin.x},${sim.origin.y},${sim.origin.z}`;
      if (key === lastKey && !force) return false;
      lastKey = key;
      const f = gpu.frame;
      const bind = [sim.tables, sim.bindRO, meshGroup], header = sim.header();
      const params = { capO: cap.o, capT: cap.t, edge: world ? 1 : 0, slot: 0 };
      mesh.dispatch(f, fold(g.nbricks), { bind, header, params });
      const slot = ring.next();
      finish.dispatch(f, [1, 1, 1], { bind, header, params: { ...params, slot } });
      stats.meshes++;
      ring.read(slot).then((bytes) => {
        if (disposed) return;
        const [o, t] = new Uint32Array(bytes);
        stats.opaque = o;
        stats.translucent = t;
        stats.overflow = o > cap.o || t > cap.t;
        if (stats.overflow && !warned) {
          warned = true;
          console.warn(`blocks: ${o} opaque and ${t} translucent faces, over the buffer's ${cap.o} and ${cap.t}: the rest aren't drawn`);
        }
      }, () => {});
      return true;
    },

    /**
     * The opaque faces (and a box's floor) into the scene pass. False while the pipelines build.
     * @param {GPURenderPassEncoder} rp
     * @param {{ view?: string, marchNear?: number, floor?: boolean }} [opts]
     */
    drawOpaque(rp, { view = 'realistic', marchNear = 0, floor: withFloor = false } = {}) {
      if (!blocks.isReady) return false;
      const params = { base: 0, mode: modeOf(view), marchNear };
      opaque.draw(rp, { bind: [fu.group, facesGroup], params, indirect: { buffer: args, offset: 0 } });
      if (withFloor) floor.draw(rp, { bind: [fu.group, facesGroup], params, count: 6 });
      return true;
    },
    /** The translucent faces (liquids, glass, gases, flames), after everything opaque. */
    drawTranslucent(rp, { view = 'realistic', marchNear = 0 } = {}) {
      if (!blocks.isReady) return false;
      translucent.draw(rp, {
        bind: [fu.group, facesGroup], params: { base: cap.o, mode: modeOf(view), marchNear }, indirect: { buffer: args, offset: 16 },
      });
      return true;
    },
    /** The next update() re-meshes whatever the key says. */
    invalidate() { lastKey = null; },
    /** The pipelines' states: { name, state, ms }. */
    get pipelines() { return all.map((x) => ({ name: x.name, state: x.state, ms: x.buildMs })); },

    dispose() {
      if (disposed) return;
      disposed = true;
      gpu.flush('blocks dispose');
      ring.close();
      faces.destroy();
      counts.destroy();
      args.destroy();
    },
  };
  return blocks;
}
