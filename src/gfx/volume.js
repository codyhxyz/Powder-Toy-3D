// The volume's GPU side (docs/webgpu.md F1, F2, F5): the view pass, the sun's
// shadow map and the pick rays, for one simulation. The WGSL is
// shaders/render.js's; this module makes the pipelines, the resources it owns
// (the shadow map's two textures, the samplers, the dummies a box binds where
// a world has its far field) and the bind groups, once per grid (B6), and
// records the work into the open frame:
//
//   const volume = createVolume(gpu, sim, { shadows: viewShadows(view) });   // sim.derived attached (src/derived.js)
//   await volume.ready;                             // pick (and shadow); views build on first use
//   post.render({
//     prepare(p) { writeFrameUniforms(gpu, { camera, model, sun, shadowRes: volume.shadowRes, … }); },
//     compute() { sim.updateBricks(); volume.recordShadow(); volume.recordPicks(); },
//     opaque(p) { …three's opaque meshes…; return cut.capture(p.sceneTarget.depth); },
//     draw(rp) { grid; volume.draw(rp, { view: 'realistic', detail, meshDepth: cut.take() }); edges; brush },
//   }, camera);
//   const hit = await volume.pick(ro, rd);          // { valid, cell, face, id, T, P, life }
//
// Pipelines (W18): every one asynchronous, with an explicit layout. The pick
// kernel builds at once, and the shadow kernel too when the session's view
// reads the map (shadows: B5 builds it at boot only then); otherwise it
// builds on the first recordShadow() or shadowReady() (a switch to a view with
// shadows). A view's module builds on first use (build: 'now'), or ahead of it
// when prefetch() queues it for idle time (B5). draw() draws nothing while its
// pipeline is pending (the caller keeps the previous variant meanwhile:
// gfx/readyVolumeView.js).
//
// The rolling log (gfx/presentation.js; docs/webgpu.md Sync log, Sync 4):
// while a gamemode's effect bends the view, draw() and pick() take its
// parameters (warp: { k, anchor, dir }, presentation.parameters). A view
// draws its curved module then (volumeFrag's curved variant: a full-screen
// triangle, the displayed rays' parabolas walked a chord at a time, no mesh
// cut), a pipeline of its own that builds on first use like any variant; a
// pick walks the displayed ray in the same pick kernel.
import { Matrix4 } from 'three/webgpu';
import { farLayout } from '../shaders/farShared.js';
import {
  volumeFrag, volumePipeline, VOLUME_LAYOUTS, VolumeParams, VOLUME_VERTICES, VOLUME_SCREEN_VERTICES, VOLUME_VIEWS,
  shadowFrag, SHADOW_LAYOUTS, shadowRes as shadowResOf, SHADOW_WORKGROUP,
  pickFrag, PICK_LAYOUTS, PickParams, PICK_BATCH, PICK_RESULT_BYTES, LAYOUT_NAMES,
} from '../shaders/render.js';
import { frameUniformsOf } from './uniforms.js';
import { createMediaNoise } from './mediaNoise.js';
import { DETAIL, SOFTWARE_UNDRAWABLE, drawableDetail } from './detail.js';
import { decoShown } from '../deco.js';
import { isMaterialView } from '../views.js';
import { RENDER_LAYOUT } from '../shaders/bindings.js';
import { createPacketShadow, packetShadowSource, packetShadowKey } from './packetShadow.js';

// slots of the pick ring: a hover pick every frame plus a few one-off rays in flight
const PICK_RING_SLOTS = 64;
// Whether the rolling log's parameters bend the view (a k of 0: flat, the same as none).
const isCurved = (warp) => !!warp && warp.k !== 0;
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08 };   // (GPUTextureUsage's bits)

/** A defines object's key: its switched-on names, sorted. */
export const detailKey = (d = {}) => Object.keys(d).filter((k) => d[k]).sort().join(',');
// Shared with menu warm-up: the same world must produce identical shader text.
export const volumeShaderGrid = (g, world, sourceAppearance = false) => ({
  ...g, sourceGrid: world ? farLayout(world).bricks.n : [1, 1, 1],
  sourceAppearance: !!world && sourceAppearance === true,
});

// The data views that draw the air's pressure and velocity (Pressure, Flow: B's .w and .xyz).
// V1 keeps both per cell in B, with a grain's or a liquid's own velocity; Physics V2 keeps the
// air per 4³ brick and the motion in the cores. Every view draws V2's format 2 (the drawn
// projection), whose read group binds V2's air in B (v2/physics.js readGroup), and the volume
// reads V1's B from both (shaders/v2/viewRead.js: render.js volumeB): the same views of the same
// quantities, in V1's units. Not a deviation. (World draws the same: its atlas's B, which
// world/renderSource.js's V2 export fills through the same rule.)

/**
 * The read format a session's volume draws `view` in (shaders/render.js fixedReadFormat): V2's
 * packed cells (2) in every view, the air views included (their air comes in V2's read group, above);
 * V1's A/B (0). What volumeReadFormat forecasts for an owner still building, for the start menu's
 * warm-up (src/preload.js), which has no simulation yet.
 * @param {string} _view @param {boolean} native the session runs Physics V2 (launch.js physicsEngine)
 * @returns {0 | 2}
 */
export const sessionVolumeFormat = (_view, native) => (native ? 2 : 0);

// Compile the intended native representation before its initialization finishes.
// Actual draw headers are checked separately, so legacy buffers are never read
// through a forecast native pipeline. physical: a physical reader's (format 3: the pick).
export function volumeReadFormat(sim, gpu, header, physical = false) {
  const owner = sim.compact;
  if (owner && !owner.disposed && !owner.isReady) return physical ? 3 : 2;
  return (header ?? sim.readHeader({ physical })).format ?? 0;
}

/**
 * @param {object} gpu
 * @param {import('../sim.js').Simulation} sim with its derived passes attached (sim.derived)
 * @param {{ shadows?: boolean, sourceAppearance?: boolean }} [opts] sourceAppearance:
 *   the selected world's imported manifest has source artwork (not a view setting).
 *   shadows: the session's view reads the
 *   shadow map (shaders/render.js viewShadows): its kernel builds now and
 *   `ready` waits for it; false, it builds when first wanted
 * @returns the volume (see the file header)
 */
export function createVolume(gpu, sim, { shadows = true, sourceAppearance = false } = {}) {
  // The atlas dimensions are fixed for this world. Constant divisors avoid
  // repeating Metal's variable-integer-division expansion at every lookup.
  const g = volumeShaderGrid(sim.g, sim.world, sourceAppearance);
  const derived = sim.derived;
  if (!derived) throw new Error('createVolume: the simulation has no derived passes (new Derived(sim) first)');
  const fu = frameUniformsOf(gpu);
  // the layouts under the names WGSL_CHECK gives them (shaders/render.js LAYOUT_NAMES)
  const L = {};
  for (const [names, groups] of [[LAYOUT_NAMES.volume, VOLUME_LAYOUTS()], [LAYOUT_NAMES.shadow, SHADOW_LAYOUTS()], [LAYOUT_NAMES.pick, PICK_LAYOUTS()]]) {
    names.forEach((name, i) => { L[name] = gpu.layout(name, groups[i]); });
  }
  // (V2's shadow kernel's: V1's with the packet shadow buffer, gfx/packetShadow.js)
  L.LIGHTING_SHADOW_PACKETS = gpu.layout('LIGHTING_SHADOW_PACKETS', RENDER_LAYOUT.LIGHTING_SHADOW_PACKETS);
  const label = (x) => `sim${sim.id} ${x}`;

  // ---- resources (once per grid) ----
  const res = shadowResOf(g);
  const shadowMap = gpu.createTexture({ label: label('shadow map'), size: [res, res], format: 'rgba32float', usage: TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | TEX.COPY_SRC });
  const shadowX = gpu.createTexture({ label: label('shadow map x'), size: [res, res], format: 'r32float', usage: TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | TEX.COPY_SRC });
  const noise = createMediaNoise(gpu);
  const samplers = gpu._volumeSamplers ??= {
    clamp: gpu.device.createSampler({ label: 'linearClamp', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' }),
    repeat: gpu.device.createSampler({ label: 'linearRepeat', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' }),
  };
  // what a box binds where a world has its far field, and with Whitewater off its aeration (F6)
  const dummy = gpu._volumeDummies ??= {
    grid: gpu.createTexture({ label: 'far grid (none)', size: [1, 1, 1], dimension: '3d', format: 'rgba16uint', usage: TEX.TEXTURE_BINDING }),
    flat: gpu.createTexture({ label: 'far 2d (none)', size: [1, 1], format: 'rgba16float', usage: TEX.TEXTURE_BINDING }),
    buffer: gpu.createBuffer({ label: 'aeration (none)', size: 16, usage: GPUBufferUsage.STORAGE }),
    depth: gpu.createTexture({ label: 'mesh depth (none)', size: [1, 1], format: 'depth32float', usage: TEX.TEXTURE_BINDING }),
  };
  const views = new WeakMap();
  const viewOf = (t, desc) => {
    if (!(t instanceof GPUTexture)) return t;   // (a view already)
    let v = views.get(t);
    if (!v) views.set(t, v = t.createView({ label: t.label, ...(desc ?? (t.dimension === '3d' ? { dimension: '3d' } : {})) }));
    return v;
  };
  let far = null;          // { grid, top, shadow } (textures or views) while a world's far field is attached
  let aeration = null;     // Whitewater's aeration buffer (both copies) while it runs

  // ---- bind groups ----
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o) return 0; let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  const lightingCache = new Map();
  // group 2: derived's resources (fields, light, GI, bricks), ours (the shadow
  // map, the noise, the far field or its dummies, the samplers) and the sim's
  // (flow, aeration). Derived's entries win where both name a binding.
  function lightingGroup(layout) {
    const key = `${layout.label}|${idOf(far)}|${idOf(aeration)}`;
    let group = lightingCache.get(key);
    if (!group) {
      const byBinding = new Map();
      for (const e of [
        { binding: 8, resource: viewOf(shadowMap) }, { binding: 9, resource: viewOf(shadowX) },
        { binding: 10, resource: noise.view },
        { binding: 11, resource: viewOf(far?.grid ?? dummy.grid) },
        { binding: 12, resource: viewOf(far?.top ?? dummy.flat) },
        { binding: 13, resource: viewOf(far?.shadow ?? dummy.flat) },
        { binding: 14, resource: samplers.clamp }, { binding: 15, resource: samplers.repeat },
        { binding: 18, resource: { buffer: sim.state.flow } },
        { binding: 19, resource: { buffer: aeration ?? dummy.buffer } },
        ...derived.lightingEntries(),
        ...(layout === L.LIGHTING_SHADOW_PACKETS ? [{ binding: 20, resource: { buffer: packets.buffer } }] : []),
      ]) byBinding.set(e.binding, e);
      lightingCache.set(key, group = gpu.bindGroup(layout, [...byBinding.values()], `${label('lighting')} ${layout.label}`));
    }
    return group;
  }
  // group 0 of the volume: the tables, FrameUniforms, the meshes' depth
  // (gfx/meshCut.js) and the decoration plane (src/deco.js: a range of the
  // sim's moveSrc buffer, which whitewater remakes; the dummy while there is
  // none), per depth texture and plane buffer
  const frameGroups = new WeakMap();
  function volumeFrameGroup(depth) {
    const plane = sim.decoPlane ?? { buffer: dummy.buffer, offset: 0, size: dummy.buffer.size };
    let byPlane = frameGroups.get(depth);
    if (!byPlane) frameGroups.set(depth, byPlane = new WeakMap());
    let group = byPlane.get(plane.buffer);
    if (!group) {
      byPlane.set(plane.buffer, group = gpu.bindGroup(L.VOLUME_FRAME, [
        { binding: 0, resource: { buffer: fu.tables } }, { binding: 1, resource: { buffer: fu.uniforms.buffer } },
        { binding: 2, resource: viewOf(depth, {}) },
        { binding: 3, resource: { buffer: plane.buffer, offset: plane.offset, size: plane.size } },
      ], `${label('volume frame')} ${depth.label}`));
    }
    return group;
  }

  // ---- pipelines ----
  const shadowKernel = gpu.kernel({
    name: 'shadow', code: shadowFrag(g), layouts: [L.FRAME, L.STATE_RO, L.LIGHTING_SHADOW],
    workgroupSize: [SHADOW_WORKGROUP, SHADOW_WORKGROUP, 1], build: shadows ? 'now' : 'manual',
  });
  const pickKernel = gpu.kernel({
    name: 'pick', code: pickFrag(g), layouts: [L.TABLES, L.STATE_RO, L.PICK], params: PickParams, workgroupSize: [PICK_BATCH, 1, 1],
  });
  const pipes = new Map();
  // A software adapter (SwiftShader: the container, ?software=1) can't draw
  // some detail features (gfx/detail.js SOFTWARE_UNDRAWABLE): the view leaves
  // them out there, and says so once.
  const fallback = !!gpu.adapterInfo?.isFallbackAdapter;
  let toldUndrawable = false;
  const drawable = (detail) => {
    const d = drawableDetail(detail, fallback);
    if (fallback && !toldUndrawable && SOFTWARE_UNDRAWABLE.some((k) => detail[k])) {
      toldUndrawable = true;
      const names = DETAIL.filter((f) => SOFTWARE_UNDRAWABLE.includes(f.define) && detail[f.define]).map((f) => f.label);
      console.warn(`volume: a software adapter can't draw ${names.join(', ')} (its GPU process crashes compiling them); the view draws without them`);
    }
    return d;
  };
  const pickRing = gpu.readback.ring(label('picks'), PICK_RESULT_BYTES, PICK_RING_SLOTS);
  const pickGroup = gpu.bindGroup(L.PICK, [{ binding: 0, resource: { buffer: pickRing.buffer } }], label('picks'));
  const pickQueue = [];
  let pickScheduled = false;
  // a pick that can't be marched (its kernel failed, the frame threw) fails with the reason
  const failPicks = (e) => { for (const p of pickQueue.splice(0)) p.reject(e); };
  const meshInv = new Matrix4();
  let disposed = false;
  // V2's flying packets in the map (gfx/packetShadow.js), made when a V2 box first records it; lastPackets:
  // whether the last map had them (a switch either way traces every tile)
  let packets = null;
  let lastPackets = false;

  const volume = {
    sim,
    get format() { return volumeReadFormat(sim, gpu); },
    /** The shadow map's texels per side (FrameUniforms.shadowRes). */
    shadowRes: res,
    /** The shadow map's two textures (F5): rgba32float, and its .x as r32float. */
    shadowTextures: { map: shadowMap, x: shadowX },
    /** The media noise (gfx/mediaNoise.js): resolves once its tile is in the texture. */
    noiseReady: noise.ready,
    /** Its view (the clouds' shadow: gfx/nativeParticles.js lights V2's flying matter with it). */
    mediaNoiseView: noise.view,
    /** The pick kernel is built, and the shadow kernel if `shadows` (views build on first use: viewReady). */
    ready: Promise.all([pickKernel.ready, ...(shadows ? [shadowKernel.ready] : [])]).then(() => volume),
    /** Builds the shadow kernel if it isn't yet (a switch to a view with shadows); resolves when it is ready. */
    shadowReady() { return shadowKernel.build(); },
    /** V2's packets in the map (gfx/packetShadow.js): 'none' (not wanted yet), 'building' or 'ready'. */
    get packetShadowState() { return packets ? (packets.ready ? 'ready' : 'building') : 'none'; },
    /**
     * For the derived passes' key (app.js): changes each tick while V2's matter may fly, and once more as it lands,
     * so the map takes the packets where they are now. A V1 flying cell changes the grid every step, and the
     * grid's version moves that key; a V2 packet flies in the dynamics pool and moves no grid version.
     */
    get packetShadowKey() { return packetShadowKey(sim, this.packetShadowState); },
    /** The shadow kernel's state: 'idle' (not wanted yet), 'pending', 'ready' or 'failed'. */
    get shadowState() { return shadowKernel.state; },

    /**
     * The view's pipeline (a gpu.renderPipeline), made on first use.
     * @param {string} view a VOLUME_VIEWS key ('realistic', 'heat', … 'plain')
     * @param {object} [detail] the realistic view's detail defines (gfx/detail.js;
     *   on a software adapter without SOFTWARE_UNDRAWABLE)
     * @param {'now' | 'idle' | 'manual'} [build] when to build it if it isn't yet
     * @param {boolean} [curved] the rolling log's variant
     * @param {0 | 2 | 3} [format] draw's captured representation (otherwise the view's: volumeReadFormat)
     */
    pipeline(view, detail = {}, build = 'now', curved = false, format = volumeReadFormat(sim, gpu)) {
      if (!VOLUME_VIEWS.includes(view)) throw new Error(`volume: no view ${view}`);
    const d = isMaterialView(view) ? drawable(detail) : {};
      const key = `${view}|${detailKey(d)}${curved ? '|curved' : ''}|format${format}`;
      let p = pipes.get(key);
      if (!p) {
      const name = isMaterialView(view) ? `volume.${view}(${detailKey(d) || 'off'})` : `volume.${view}`;
        // (a view drawn now is a long pole of the frame waiting for it: it starts ahead of the short
        // builds, gpu/kernels.js BUILD_RANK.FIRST; a prefetch stays behind them)
        pipes.set(key, p = gpu.renderPipeline({
          name: `${curved ? `${name}.curved` : name}.format${format}`,
          code: volumeFrag(g, { view, detail: d, curved, fixedReadFormat: format }), layouts: [L.VOLUME_FRAME, L.STATE_RO, L.LIGHTING],
          params: VolumeParams, ...volumePipeline(), build, first: build === 'now',
        }));
      } else if (build === 'now' && (p.state === 'idle' || p.state === 'pending')) p.build();   // (a queued prefetch moves up: BUILD_RANK)
      return p;
    },
    /** Queues a view's pipeline for idle time (B5); resolves with it when it is ready. */
    prefetch(view, detail = {}, curved = false) { const p = volume.pipeline(view, detail, 'idle', curved); return p.ready; },
    /** Builds a view's pipeline now; resolves when it is ready. */
    viewReady(view, detail = {}, curved = false) { return volume.pipeline(view, detail, 'now', curved).ready; },

    /**
     * Draws the view into the scene pass (post's draw hook). Draws nothing and
     * returns false while the view's pipeline is still building. FrameUniforms
     * must have been written this frame (gfx/uniforms.js writeFrameUniforms):
     * the mesh cut's matrix comes from the same values.
     * @param {GPURenderPassEncoder} rp
     * @param {{ view?: string, detail?: object, meshDepth?: GPUTexture | null, marchNear?: number, aerCopy?: number, warp?: object | null }} [opts]
     *   meshDepth: the meshes' depth this frame (gfx/meshCut.js take()), or null for no cut;
     *   marchNear: cells nothing nearer the eye is drawn (first person's eye clip);
     *   aerCopy: Whitewater's current aeration copy (0 or 1); warp: the rolling
     *   log's parameters while it bends the view ({ k, anchor, dir }, world
     *   cells: gfx/presentation.js parameters), else null. The decoration is
     *   drawn when src/deco.js decoShown(sim) says so (painted, display on)
     * @returns {boolean}
     */
    draw(rp, { view = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0, warp = null, indirect = null } = {}) {
      const curved = isCurved(warp);
      const header = sim.readHeader(), format = volumeReadFormat(sim, gpu, header);
      if ((header.format ?? 0) !== format) return false;
      const state = sim.bindRO;
      const pipe = volume.pipeline(view, detail, 'now', curved, format);
      if (pipe.state !== 'ready') return false;
      meshInv.multiplyMatrices(fu.last.viewProj, fu.last.model).invert();   // clip → grid, the jittered camera's
      const depth = meshDepth ?? dummy.depth;
      pipe.draw(rp, {
        bind: [volumeFrameGroup(depth), state, lightingGroup(L.LIGHTING)], header,
        params: {
          meshInv, meshRes: [depth.width, depth.height], meshCut: meshDepth ? 1 : 0, marchNear, aerCopy,
          deco: decoShown(sim) && sim.decoPlane ? 1 : 0,
          warpK: curved ? warp.k : 0, warpAnchor: curved ? warp.anchor : [0, 0], warpDir: curved ? warp.dir : [0, 1],
        },
        count: curved ? VOLUME_SCREEN_VERTICES : VOLUME_VERTICES,
        ...(indirect ? { indirect } : {}),
      });
      return true;
    },

    /**
     * Records the shadow map (every derived frame of a view with shadows, D9;
     * after FrameUniforms is written: it reads the sun and shadowRes). False
     * while its kernel is building (the first call starts it).
     * @returns {boolean}
     */
    recordShadow() {
      // Under V2 its flying packets cast as V1's flying cells do (gfx/packetShadow.js): the splat, then V2's
      // kernel, V1's trace with them folded in. Until it is built, V1's kernel traces the map without them.
      const source = packetShadowSource(sim);
      if (source && !packets) {
        packets = createPacketShadow(gpu, { g, res, derived,
          layouts: { shadow: [L.FRAME, L.STATE_RO, L.LIGHTING_SHADOW_PACKETS], frame: L.FRAME } });
      }
      if (source) packets.build();
      const withPackets = !!source && packets.ready;
      if (withPackets !== lastPackets) { derived.shadowFull = true; lastPackets = withPackets; }
      if (shadowKernel.state !== 'ready' && !withPackets) { shadowKernel.build(); return false; }
      if (withPackets) {
        if (!derived.shadowTilesReady()) return false;
        packets.record(gpu.frame, fu.group, source, [sim.origin?.x ?? 0, sim.origin?.y ?? 0, sim.origin?.z ?? 0]);
      }
      // the tiles to re-trace: those a change crossed, or all (src/derived.js shadowTiles)
      const tiles = derived.shadowTiles(res, shadowMap);
      if (!tiles) return false;
      (withPackets ? packets.kernel : shadowKernel).dispatch(gpu.frame, tiles, { bind: [fu.group, sim.bindRO,
        lightingGroup(withPackets ? L.LIGHTING_SHADOW_PACKETS : L.LIGHTING_SHADOW)], header: sim.readHeader() });
      return true;
    },

    /**
     * Casts a pick ray (grid cells): the first non-gas voxel along it, the
     * floor, or a miss. The ray is queued and marched with the others queued
     * this frame (recordPicks: post's compute hook records them into the
     * frame; else a microtask does), and the result comes back 1–3 frames
     * later through the pick ring (B7). It reads the state current when it is
     * recorded; the caller keeps its own staleness tokens (the grid, the
     * window's origin), as app.js's pickedNow does.
     * A ray asked for with the rolling log's parameters (warp, as draw takes
     * them, while it bends the view) is the displayed ray from the eye: it
     * walks that ray's parabola, so it finds what the pixel shows.
     * @param {number[] | { x: number, y: number, z: number }} ro
     * @param {number[] | { x: number, y: number, z: number }} rd
     * @param {{ k: number, anchor: number[], dir: number[] } | null} [warp]
     * @param {boolean} [skipLiquids] Aim through liquids for non-liquid hand tools.
     * @returns {Promise<{ valid: boolean, cell: number[], face: number, id: number, T: number, P: number, life: number, raw: Float32Array }>}
     */
    pick(ro, rd, warp = null, skipLiquids = false) {
      const v3 = (v) => (Array.isArray(v) ? [...v] : [v.x, v.y, v.z]);
      const w = isCurved(warp) ? { k: warp.k, anchor: [...warp.anchor], dir: [...warp.dir] } : null;   // (as asked: the parameters move with the camera)
      const p = new Promise((resolve, reject) => pickQueue.push({ ro: v3(ro), rd: v3(rd), warp: w, skipLiquids, resolve, reject }));
      if (!pickScheduled) {
        pickScheduled = true;
        queueMicrotask(() => { pickScheduled = false; if (!disposed && pickQueue.length) recordPicksQuietly(); });
      }
      return p;
    },
    /**
     * Records the queued pick rays into the open frame (PICK_BATCH per
     * dispatch). If the pick kernel failed, or recording throws (a
     * GraphicsFailure after the device is gone), every queued pick rejects
     * with the reason, and a throw is rethrown to the caller.
     */
    recordPicks() {
      if (!pickQueue.length) return;
      if (pickKernel.state !== 'ready') { pickKernel.ready.then(recordPicksQuietly, failPicks); return; }
      const read = sim.compact ? sim.bindPhysicalRO : sim.bindRO;
      if (!read) { sim.compactOwner.ready.then(recordPicksQuietly, failPicks); return; }
      while (pickQueue.length) {
        const batch = pickQueue.splice(0, PICK_BATCH);
        let slots;
        try {
          slots = batch.map(() => pickRing.next());
          const words = new Array(PICK_BATCH).fill(0);
          slots.forEach((s, i) => { words[i] = s; });
          const rays = {
            ro: batch.map((b) => [...b.ro, b.warp?.k ?? 0]), rd: batch.map((b) => [...b.rd, b.skipLiquids ? 1 : 0]),
            slot: [words.slice(0, 4), words.slice(4, 8)], n: batch.length,
          };
          pickKernel.dispatch(gpu.frame, [1, 1, 1], {
            bind: [sim.tables, read, pickGroup], header: sim.readHeader({ physical: true }),
            params: { ...rays, warp: batch.map((b) => (b.warp ? [...b.warp.anchor, ...b.warp.dir] : [0, 0, 0, 1])) },
          });
          // V2's flying matter (a V1 flying cell is a cell the march finds): gfx/nativeParticles.js recordPick
          sim.compact?.dynamics?.drawAdapter?.recordPick?.(gpu.frame, { ring: pickRing.buffer, ...rays, origin: sim.origin });
        } catch (e) {
          for (const b of batch) b.reject(e);
          failPicks(e);
          throw e;
        }
        batch.forEach((b, i) => pickRing.read(slots[i]).then((bytes) => {
          const f = new Float32Array(bytes);
          b.resolve({ valid: f[3] >= 0, cell: [f[0], f[1], f[2]], face: f[3], id: Math.round(f[4]), T: f[5], P: f[6], life: f[7], raw: f });
        }, b.reject));
      }
    },

    /**
     * A big map's far grid, tops and shadow heights for the far view, which
     * binds this lighting group (world/far.js attachVolume; null: a box's
     * dummies). far: { grid, top, shadow }, textures or views (shaders/bindings.js 11-13).
     */
    attachFar(f) { far = f ?? null; },
    /** Whitewater's aeration buffer, both copies (null: none). */
    attachAeration(buffer) { aeration = buffer ?? null; },
    /** The lighting group the volume binds (group 2): the sign probe and others read the same. */
    get lightingGroup() { return lightingGroup(L.LIGHTING); },
    /** The volume's pipelines made so far: { key, state, ms }. */
    get pipelines() { return [...pipes].map(([key, p]) => ({ key, state: p.state, ms: p.buildMs })); },

    dispose() {
      disposed = true;
      gpu.flush('volume dispose');
      for (const p of pickQueue.splice(0)) p.reject(new Error('volume disposed'));
      pickRing.close();
      shadowMap.destroy();
      shadowX.destroy();
      packets?.dispose();
      lightingCache.clear();
    },
  };
  // the microtask's and the kernel's late recordPicks: a throw has already rejected the picks it concerns
  function recordPicksQuietly() {
    try { volume.recordPicks(); } catch { /* (the picks carry it) */ }
  }
  return volume;
}
