// The seamless world's view (docs/seamless-world.md, "M"): the material views of every map, small
// and big, drawn by one full-screen march in world cells (shaders/world/march.js) over the world
// copy (W), the field clipmaps (F) and the lighting (L). It owns their objects, its pipelines,
// its own FrameUniforms in world cells and its bind groups; app.js calls, each frame:
//
//   const view = createWorldView(gpu, sim, { volume });   // volume: gfx/volume.js (its shadow map, its noise)
//   prepare:  writeFrameUniforms(gpu, values); view.writeUniforms(values);
//   compute:  physics, then view.update(gpu.frame, { boxes, camera, sun })   // W writeback → F → L
//   draw:     view.draw(rp, { view: 'realistic', detail, meshDepth, marchNear, aerCopy })
//
// FrameUniforms in world cells: the window's FrameUniforms (gfx/uniforms.js) hold the camera,
// the volume's model and the lamps, wand lights and dig mark in physics' window cells, which the
// data views, the shadow kernel and GI still read. The march's copy is the same values with the
// model moved to the world's corner (worldModelMatrix: the eye comes out in world cells) and those
// positions moved by sim.origin. A small map's origin is 0: both copies are equal.
import { Matrix4 } from 'three/webgpu';
import { FrameUniformsStruct, frameUniformValues, worldModelMatrix, frameUniformsOf } from './uniforms.js';
import { DETAIL, SOFTWARE_UNDRAWABLE, drawableDetail } from './detail.js';
import { decoShown } from '../deco.js';
import { isMaterialView } from '../views.js';
import {
  worldMarchFrag, worldMarchPipeline, MarchParams, WORLD_MARCH_LAYOUTS, WORLD_GROUP2, WORLD_MARCH_VERTICES, WORLD_MARCH_LAYOUT_NAMES,
} from '../shaders/world/march.js';
import { worldGroup2Entries } from '../shaders/world/bindings.js';
// The owners' classes. Until W, F and L land these are the stand-ins (shaders/world/stubs.js); the
// lead swaps them for world/worldCopy.js WorldCopy, gfx/worldFields.js WorldFields and
// gfx/worldLight.js WorldLight at integration (same constructors and methods).
import { WorldCopyStub as WorldCopy, WorldFieldsStub as WorldFields, WorldLightStub as WorldLight } from '../shaders/world/stubs.js';

const TEX = { TEXTURE_BINDING: 0x04 };
export const detailKey = (d = {}) => Object.keys(d).filter((k) => d[k]).sort().join(',');
const xyz = (o) => [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0];

/**
 * @param {object} gpu
 * @param {import('../sim.js').Simulation} sim
 * @param {{ volume: object }} opts volume: the window's (gfx/volume.js): the shadow map and media noise it owns
 */
export function createWorldView(gpu, sim, { volume }) {
  const label = (x) => `sim${sim.id} world ${x}`;
  const size = [sim.world?.[0] ?? sim.g.nx, sim.world?.[1] ?? sim.g.ny, sim.world?.[2] ?? sim.g.nz];
  const worldCopy = new WorldCopy(gpu, { size });
  const ready = worldCopy.build(sim);
  const fields = new WorldFields(gpu, worldCopy);
  const light = new WorldLight(gpu, worldCopy, fields, { shadowTextures: volume.shadowTextures });

  const list = WORLD_GROUP2();
  const [frameEntries, , group2Entries] = WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT);
  const L = {
    frame: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[0], frameEntries),
    copy: worldCopy.layout,
    group2: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[2], group2Entries),
  };
  const fu = frameUniformsOf(gpu);
  const uniforms = gpu._worldFrameUniforms ??= gpu.uniforms(FrameUniformsStruct, 'FrameUniforms (world cells)');
  const last = { viewProj: new Matrix4(), model: new Matrix4() };
  const clamp = gpu._volumeSamplers?.clamp ?? gpu.device.createSampler({ label: 'linearClamp', magFilter: 'linear', minFilter: 'linear' });
  const dummy = gpu._worldDummies ??= {
    buffer: gpu.createBuffer({ label: 'world group 2 (none)', size: 16, usage: GPUBufferUsage.STORAGE }),
    tex3d: gpu.createTexture({ label: 'world 3d (none)', size: [1, 1, 1], dimension: '3d', format: 'rgba8unorm', usage: TEX.TEXTURE_BINDING }).createView({ dimension: '3d' }),
    tex2d: gpu.createTexture({ label: 'world 2d (none)', size: [1, 1], format: 'rgba32float', usage: TEX.TEXTURE_BINDING }).createView(),
    depth: gpu.createTexture({ label: 'mesh depth (none)', size: [1, 1], format: 'depth32float', usage: TEX.TEXTURE_BINDING }),
    plane: gpu.createBuffer({ label: 'deco plane (none)', size: 16, usage: GPUBufferUsage.STORAGE }),
  };

  // ---- bind groups, cached by their resources' identities ----
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o || typeof o !== 'object') return String(o); let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  const groups = new Map();
  const cached = (key, make) => { let g = groups.get(key); if (!g) { if (groups.size > 64) groups.clear(); groups.set(key, g = make()); } return g; };
  function group2() {
    const entries = worldGroup2Entries(list, {
      fields: fields.bindEntries(), light: light.bindEntries(), noise: volume.mediaNoiseView, clamp,
      flow: sim.state.flow, cells: sim.compact?.isReady ? sim.compact.cells : null, dummy,
    });
    const key = `g2|${entries.map((e) => idOf(e.resource.buffer ?? e.resource)).join(',')}`;
    return cached(key, () => gpu.bindGroup(L.group2, entries, label('group 2')));
  }
  function frameGroup(depth) {
    const plane = sim.decoPlane ?? { buffer: dummy.plane, offset: 0, size: dummy.plane.size };
    const key = `g0|${idOf(depth)}|${idOf(plane.buffer)}|${plane.offset}|${plane.size}`;
    return cached(key, () => gpu.bindGroup(L.frame, [
      { binding: 0, resource: { buffer: fu.tables } }, { binding: 1, resource: { buffer: uniforms.buffer } },
      { binding: 2, resource: depth.createView({}) },
      { binding: 3, resource: { buffer: plane.buffer, offset: plane.offset, size: plane.size } },
    ], label('frame')));
  }

  // ---- pipelines ----
  const pipes = new Map();
  const fallback = !!gpu.adapterInfo?.isFallbackAdapter;
  const meshInv = new Matrix4();
  let disposed = false;

  const view = {
    worldCopy, fields, light,
    /** W's build (the whole map, before the first frame). */
    ready,
    /** Whether this module draws `view` (the material views; the data views and Plain keep their paths). */
    draws: (v, curved = false) => isMaterialView(v) && !curved,
    /**
     * The march's pipeline for a material view and its detail, made on first use. One module per
     * (view, detail) serves every map: the world's size is a uniform (W's WC.size).
     */
    pipeline(v, detail = {}, build = 'now') {
      const d = drawableDetail(detail, fallback);
      const key = `${v}|${detailKey(d)}`;
      let p = pipes.get(key);
      if (!p) {
        pipes.set(key, p = gpu.renderPipeline({
          name: `world.${v}(${detailKey(d) || 'off'})`,
          code: worldMarchFrag(sim.g, { view: v, detail: d }), layouts: [L.frame, L.copy, L.group2],
          params: MarchParams, ...worldMarchPipeline(), build, first: build === 'now',
        }));
      } else if (build === 'now' && (p.state === 'idle' || p.state === 'pending')) p.build();
      return p;
    },
    /**
     * Writes the march's FrameUniforms: the frame's values (gfx/uniforms.js frameValues' shape),
     * moved into world cells. After writeFrameUniforms for the same frame.
     */
    writeUniforms(frame) {
      frame.camera.updateMatrixWorld();
      const o = xyz(sim.origin);
      const values = frameUniformValues({ ...frame, model: worldModelMatrix(frame.model, o) });
      const shift = (v) => { v[0] += o[0]; v[1] += o[1]; v[2] += o[2]; };
      values.lampPos.forEach(shift);
      for (const w of values.wandLightPosition) { w.x += o[0]; w.y += o[1]; w.z += o[2]; }
      if (values.digMax[3] > 0) { shift(values.digMin); shift(values.digMax); }
      last.viewProj.copy(values.viewProj);
      last.model.copy(values.model);
      uniforms.write(values);
    },
    /**
     * The frame's world upkeep, in the contract's order, after physics' step: W writes back the
     * boxes physics changed, then F updates its clip levels and L its lighting for those changes.
     * @param {object} frame gpu.frame
     * @param {{ boxes?: object[], camera?: object, sun?: number[] }} [opts]
     */
    update(frame, { boxes = [], camera = null, sun = null } = {}) {
      const rev = worldCopy.revision ?? 0;
      worldCopy.recordWriteback(frame, sim, boxes);
      const changes = worldCopy.changesSince ? worldCopy.changesSince(rev) : [];
      const eye = camera ? camera.position.clone().applyMatrix4(last.model.clone().invert()).toArray() : null;
      fields.update(frame, eye, changes);
      light.update(frame, camera, sun, changes);
    },
    /**
     * Draws the march into the scene pass. Returns false (draws nothing) while its pipeline builds
     * or a group isn't available yet.
     * @param {GPURenderPassEncoder} rp
     * @param {{ view?: string, detail?: object, meshDepth?: GPUTexture | null, marchNear?: number, aerCopy?: number }} [opts]
     */
    draw(rp, { view: v = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0 } = {}) {
      if (disposed) return false;
      const pipe = view.pipeline(v, detail, 'now');
      if (pipe.state !== 'ready') return false;
      const copy = worldCopy.bindGroup;
      if (!copy) return false;
      meshInv.multiplyMatrices(last.viewProj, last.model).invert();   // clip → world cells, the jittered camera's
      const depth = meshDepth ?? dummy.depth;
      pipe.draw(rp, {
        bind: [frameGroup(depth), copy, group2()], header: { ...sim.readHeader(), origin: [0, 0, 0] },
        params: {
          meshInv, meshRes: [depth.width, depth.height], meshCut: meshDepth ? 1 : 0, marchNear, aerCopy,
          deco: decoShown(sim) && sim.decoPlane ? 1 : 0, physOrigin: xyz(sim.origin),
        },
        count: WORLD_MARCH_VERTICES,
      });
      return true;
    },
    /** The pipelines made so far: { key, state, ms }. */
    get pipelines() { return [...pipes].map(([key, p]) => ({ key, state: p.state, ms: p.buildMs })); },
    dispose() {
      disposed = true;
      gpu.flush('world view dispose');
      groups.clear();
      worldCopy.dispose?.();
      fields.dispose?.();
      light.dispose?.();
    },
  };
  return view;
}

/** The software adapter's undrawable detail, as gfx/volume.js leaves it out. */
export const WORLD_VIEW_UNDRAWABLE = DETAIL.filter((f) => SOFTWARE_UNDRAWABLE.includes(f.define)).map((f) => f.key);
