// Flat material views of every map: opaque full-world LOD terrain and sky,
// depth-bounded media and optics, then an HDR + hardware-depth composite.
// ?renderer=march retains the legacy full-screen march, field clipmaps (F)
// and split G-buffer. Both renderers read the world copy (W) and lighting (L).
//
//   prepare: view.writeUniforms(values, writeFrameUniforms(gpu, values));
//   compute: physics, then view.update(gpu.frame, { boxes, camera, sun });
//   opaque:  view.prepass(gpu.frame, { inSize, allocSize, … });
//   draw:    post.sceneViewport(rp); view.draw(rp, { inSize, … });
//
// boxed: a big map's frame whose far view draws: the march draws inside physics' window only (live's
// full-detail box, shaders/world/reach.js), the far view the rest; else the whole world (a small map, or a
// big one's far view not drawing yet).
//
// The split march (shaders/world/march.js, "The split march"): prepass records its stages as passes
// of their own ('world beam', 'world march', 'world reflect', 'world shade') into a G-buffer the size of the scene
// target; draw then composites their picture into the scene pass. A detail variant that doesn't
// split (the grains), or a draw with no prepass before it, draws the whole march in the scene pass.
//
// FrameUniforms in world cells: the window's FrameUniforms (gfx/uniforms.js) hold the camera,
// the volume's model and the lamps, wand lights and dig mark in physics' window cells, which the
// data views, the shadow kernel and GI still read. The march's copy is the same values with the
// model moved to the world's corner (worldModelMatrix: the eye comes out in world cells) and those
// positions moved by sim.origin. A small map's origin is 0: both copies are equal.
import { Matrix4, Vector3 } from 'three/webgpu';
import { createMeshGround } from './meshGround.js';
import { createOpticsOverlay } from './opticsOverlay.js';
import { WGSL_CHECK as rasterCompositeCheck } from '../shaders/world/rasterComposite.js';
import { FrameUniformsStruct, frameUniformValues, frameUniformValuesFor, worldModelMatrix, frameUniformsOf } from './uniforms.js';
import { drawableDetail } from './detail.js';
import { decoShown } from '../deco.js';
import { isMaterialView } from '../views.js';
import {
  worldMarchFrag, worldMarchPipeline, MarchParams, physParams, WORLD_MARCH_LAYOUTS, WORLD_GROUP2, WORLD_MARCH_VERTICES, WORLD_MARCH_LAYOUT_NAMES,
  MARCH_STAGES, marchSplits, EVENT_COLOR_BYTES, stageCounted, worldMarchLayoutNames, stageTextures, STAGE_TARGETS, STAGE_LOADS, STAGE_GATE, STORAGE_GBUF, GBUF, GBUF_LAYERS, gbufViewDim, gbufSize, GBUF_NO_DEPTH, compositeWGSL, COMPOSITE_LAYOUT,
  COMPOSITE_NAME, COMPOSITE_LAYOUT_NAMES, stagePipeName,
} from '../shaders/world/march.js';
import { worldGroup2Entries } from '../shaders/world/bindings.js';
import { materialTextures } from './materialTextures.js';
import { WorldLight } from './worldLight.js';
import { worldFieldsWGSL, fieldsBindingsWGSL, FIELDS_BINDINGS, fieldClipFor, fieldFocus } from '../shaders/world/fields.js';
import { RENDER_LAYOUT } from '../shaders/bindings.js';
import { WorldCopy } from '../world/worldCopy.js';
import { WorldFields } from './worldFields.js';
import { worldCopyWGSL } from '../shaders/world/copy.js';
import { costify, costBinding, costLayoutEntry } from '../shaders/costView.js';
import { worldPickFrag, WORLD_PICK_LAYOUTS } from '../shaders/world/pick.js';
import { PickParams, PICK_BATCH, PICK_RESULT_BYTES, SCENE_FORMATS } from '../shaders/render.js';

const GBUF_KEPT = 2;
const PICK_RING_SLOTS = 64;   // (gfx/volume.js's: rays in flight)
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10 };   // (GPUTextureUsage's bits, importable in Node)
const detailKey = (d = {}) => Object.keys(d).filter((k) => d[k]).sort().join(',');
const xyz = (o) => [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0];

/**
 * @param {object} gpu
 * @param {import('../sim.js').Simulation} sim
 * @param {{ volume: object, renderer?: string, floor?: number, onVariant?: () => void }} opts
 *   volume lends its media noise and the legacy optics hint. onVariant requests
 *   another frame when pipelines land or more mesh batches remain.
 */
export function createWorldView(gpu, sim, { volume, onVariant = () => {}, renderer, floor }) {
  const useLegacyMarch = (renderer ?? new URLSearchParams(globalThis.location?.search).get('renderer')) === 'march';
  const fastRaster = !useLegacyMarch;
  const label = (x) => `sim${sim.id} world ${x}`;
  const size = [sim.world?.[0] ?? sim.g.nx, sim.world?.[1] ?? sim.g.ny, sim.world?.[2] ?? sim.g.nz];
  const worldCopy = new WorldCopy(gpu, { size });
  // W's build: a small map's from its box's cells now; a big map's from its window once that has loaded
  // (wire/world.js calls build(win)), so the whole map is in before the first frame (app.js waits on ready)
  let settle;
  const copyReady = new Promise((resolve) => { settle = resolve; });
  const build = (source) => worldCopy.build(source).then((c) => { primed = false; settle(c); return c; }, (err) => {
    console.error('world copy: the build failed', err);
    settle(null);
    throw err;
  });
  // F's level 0 is physics' window's box at a texel a cell (fieldClipFor), centred on the full-detail box (update)
  const win = [sim.g.nx, sim.g.ny, sim.g.nz];
  const fields = useLegacyMarch ? new WorldFields(gpu, worldCopy, { copyWGSL: worldCopyWGSL(), tables: sim.tables, tablesLayout: sim.L?.TABLES, ...fieldClipFor(size, win) }) : null;
  const light = new WorldLight(gpu, worldCopy, fields, {
    copyWGSL: worldCopyWGSL(), mediaNoise: volume.mediaNoiseView,
    ...(fields && { fieldsWGSL: `${fieldsBindingsWGSL(2)}\n${worldFieldsWGSL()}`, fieldsBindings: FIELDS_BINDINGS }),
  });
  const meshOpts = { floor, mediaNoise: volume.mediaNoiseView, compact: true };
  const mesh = fastRaster ? createMeshGround(gpu, sim, worldCopy, light, meshOpts) : null;
  const optics = fastRaster ? createOpticsOverlay(gpu, sim, worldCopy, light) : null;
  const rasterDesc = rasterCompositeCheck()[0];
  const rasterLayout = fastRaster ? gpu.layout('WORLD_RASTER_COMPOSITE', rasterDesc.layouts()[0]) : null;
  const rasterPipe = fastRaster ? gpu.renderPipeline({
    name: rasterDesc.name, code: rasterDesc.code(), layouts: [rasterLayout], fragment: rasterDesc.fragment, depthStencil: rasterDesc.depthStencil,
  }) : null;
  // Optional optics never hold up the first opaque frame; redraw when they land.
  optics?.ready.then(() => { if (!disposed) onVariant(); }, () => {});
  const ready = Promise.all([copyReady, fields?.ready, light.ready, mesh?.ready, rasterPipe?.ready]).then(([copy]) => copy);
  ready.catch(() => {});

  const list = WORLD_GROUP2();
  const [frameEntries, , group2Entries] = WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT);
  const L = useLegacyMarch ? {
    frame: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[0], frameEntries),
    copy: worldCopy.layout,
    group2: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[2], group2Entries),
  } : null;
  // each split stage's group 0 (the frame's four and its G-buffer textures) and the composite's
  const stageL = useLegacyMarch ? Object.fromEntries(MARCH_STAGES.map((st) => [st,
    gpu.layout(worldMarchLayoutNames(st)[0], WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT, st)[0])])) : null;
  const compositeL = useLegacyMarch ? gpu.layout(COMPOSITE_LAYOUT_NAMES[0], COMPOSITE_LAYOUT) : null;
  // the cost view's twins (gfx/costView.js): each stage's group 0 and the counters' storage texture
  const frameEntriesOf = (st) => WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT, st)[0];
  const costL = {};
  const costLayout = (st) => (costL[st] ??= gpu.layout(`${worldMarchLayoutNames(st)[0]}_COST`, [...frameEntriesOf(st),
    costLayoutEntry(costBinding(frameEntriesOf(st)))]));
  const fu = frameUniformsOf(gpu);
  const uniforms = gpu._worldFrameUniforms ??= gpu.uniforms(FrameUniformsStruct, 'FrameUniforms (world cells)');
  const last = { viewProj: new Matrix4(), model: new Matrix4(), eye: new Vector3() };
  const clamp = useLegacyMarch ? (gpu._volumeSamplers?.clamp ?? gpu.device.createSampler({ label: 'linearClamp', magFilter: 'linear', minFilter: 'linear' })) : null;
  const dummy = useLegacyMarch ? (gpu._worldDummies ??= {
    buffer: gpu.createBuffer({ label: 'world group 2 (none)', size: 16, usage: GPUBufferUsage.STORAGE }),
    tex3d: gpu.createTexture({ label: 'world 3d (none)', size: [1, 1, 1], dimension: '3d', format: 'rgba8unorm', usage: TEX.TEXTURE_BINDING }).createView({ dimension: '3d' }),
    tex2d: gpu.createTexture({ label: 'world 2d (none)', size: [1, 1], format: 'rgba32float', usage: TEX.TEXTURE_BINDING }).createView(),
    depth: gpu.createTexture({ label: 'mesh depth (none)', size: [1, 1], format: 'depth32float', usage: TEX.TEXTURE_BINDING }),
    plane: gpu.createBuffer({ label: 'deco plane (none)', size: 16, usage: GPUBufferUsage.STORAGE }),
  }) : null;

  const rasterTargets = [];
  let rasterPrepared = null;
  const viewProjModel = new Matrix4();
  const destroyRasterTargets = (set) => {
    gpu.flush('world raster targets');
    set.textures.forEach((t) => t.destroy());
  };
  function compactTargets(allocSize) {
    const i = rasterTargets.findIndex((set) => allocSize.every((n, j) => n === set.size[j]));
    if (i >= 0) {
      const [set] = rasterTargets.splice(i, 1);
      rasterTargets.unshift(set);
      return set;
    }
    if (rasterTargets.length >= GBUF_KEPT) destroyRasterTargets(rasterTargets.pop());
    const tex = (name, format, usage = 0) => gpu.createTexture({ label: label(name), size: allocSize, format,
      usage: TEX.TEXTURE_BINDING | TEX.RENDER_ATTACHMENT | usage });
    const opaqueTexture = tex('raster opaque color', SCENE_FORMATS.color, TEX.COPY_DST);
    const opaqueDepthTexture = tex('raster opaque depth', SCENE_FORMATS.depth, TEX.COPY_DST);
    const textures = [opaqueTexture, opaqueDepthTexture, tex('raster final color', SCENE_FORMATS.color), tex('raster final depth', SCENE_FORMATS.depth)];
    const [opaqueColor, opaqueDepth, finalColor, finalDepth] = textures.map((t) => t.createView());
    const set = { size: [...allocSize], textures, opaqueTexture, opaqueColor, opaqueDepth, finalColor, finalDepth,
      depthTarget: { texture: opaqueDepthTexture, view: opaqueDepth }, groups: new WeakMap() };
    rasterTargets.unshift(set);
    return set;
  }

  // ---- bind groups, cached by their resources' identities ----
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o || typeof o !== 'object') return String(o); let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  const groups = new Map();
  const cached = (key, make) => { let g = groups.get(key); if (!g) { if (groups.size > 64) groups.clear(); groups.set(key, g = make()); } return g; };
  function group2() {
    const entries = worldGroup2Entries(list, {
      fields: fields.bindEntries(), light: light.bindEntries(), noise: volume.mediaNoiseView, clamp,
      flow: sim.state.flow, cells: sim.compact?.isReady ? sim.compact.cells : null, matTex: materialTextures(gpu), dummy,
    });
    const key = `g2|${entries.map((e) => idOf(e.resource.buffer ?? e.resource)).join(',')}`;
    return cached(key, () => gpu.bindGroup(L.group2, entries, label('group 2')));
  }
  // (g: the G-buffer a stage binds, the frame's by default; cost: the cost view's counters, its twins' group 0)
  function frameGroup(depth, stage = 'whole', g = gb, cost = null) {
    const plane = sim.decoPlane ?? { buffer: dummy.plane, offset: 0, size: dummy.plane.size };
    const extra = stage === 'whole' ? [] : stageTextures(stage);
    const key = `g0|${stage}|${idOf(depth)}|${idOf(plane.buffer)}|${plane.offset}|${plane.size}|${extra.length ? idOf(g) : ''}|${cost ? idOf(cost) : ''}`;
    return cached(key, () => gpu.bindGroup(cost ? costLayout(stage) : stage === 'whole' ? L.frame : stageL[stage], [
      { binding: 0, resource: { buffer: fu.tables } }, { binding: 1, resource: { buffer: uniforms.buffer } },
      { binding: 2, resource: depth.createView({}) },
      { binding: 3, resource: { buffer: plane.buffer, offset: plane.offset, size: plane.size } },
      ...extra.map(([binding, k]) => ({ binding, resource: g.views[k] })),
      ...(cost ? [{ binding: costBinding(frameEntriesOf(stage)), resource: cost }] : []),
    ], label(`${stage === 'whole' ? 'frame' : `${stage} frame`}${cost ? ' (cost)' : ''}`)));
  }

  // ---- the split march's G-buffer (shaders/world/march.js GBUF), the scene target's size ----
  // (two kept, by size: a still's target, a thumbnail's, doesn't make the frame's over each time)
  let gb = null;
  const gbs = [];
  const destroyGb = (b) => { gpu.flush('world gbuffer'); Object.values(b.tex).forEach((t) => t.destroy?.()); };
  function gbuffer(w, h) {
    const i = gbs.findIndex((b) => b.w === w && b.h === h);
    if (i >= 0) { gb = gbs[i]; gbs.splice(i, 1); gbs.unshift(gb); return gb; }
    if (gbs.length >= GBUF_KEPT) destroyGb(gbs.pop());
    const tex = {}, views = {};
    for (const [k, format] of Object.entries(GBUF)) {
      const usage = GPUTextureUsage.TEXTURE_BINDING | (STORAGE_GBUF.has(k) ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.RENDER_ATTACHMENT);
      tex[k] = gpu.createTexture({ label: label(`gbuffer ${k}`), size: [...gbufSize(k, w, h), GBUF_LAYERS[k] ?? 1], format, usage });
      views[k] = tex[k].createView({ dimension: gbufViewDim(k) });
    }
    gb = { w, h, tex, views };
    gbs.unshift(gb);
    return gb;
  }
  const CLEAR = { D: { r: GBUF_NO_DEPTH, g: 0, b: 0, a: 0 } };
  const attach = (k, g = gb, load = false) => ({ view: g.views[k], loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: CLEAR[k] ?? { r: 0, g: 0, b: 0, a: 0 } });
  // the split stages into G-buffer g (the frame's, or the cost view's own), each a pass of its own
  function recordStages(frame, parts, g, depth, header, params, { names = (st) => `world ${st}`, cost = null } = {}) {
    const copy = worldCopy.bindGroup, g2 = group2();
    for (const st of MARCH_STAGES) {
      // (the event stage's gate: shaders/world/march.js EVENT_GATE_Z)
      // (the event kernels' gate: depth, shaders/world/march.js "The event kernels")
      const gate = STAGE_GATE[st] === 'write' ? { view: g.views.Z, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }
        : STAGE_GATE[st] === 'rewrite' ? { view: g.views.Z, depthLoadOp: 'load', depthStoreOp: 'store' }
          : STAGE_GATE[st] === 'test' ? { view: g.views.Z, depthReadOnly: true } : undefined;
      const rp = frame.render({ colorAttachments: STAGE_TARGETS[st].map((k) => attach(k, g, STAGE_LOADS.has(st))), ...(gate ? { depthStencilAttachment: gate } : {}) }, names(st));
      try {
        const k = STAGE_TARGETS[st][0] ?? 'Z';
        const [w, h] = gbufSize(k, ...params.sceneRes);
        const [aw, ah] = gbufSize(k, g.w, g.h);
        if (w !== aw || h !== ah) {
          rp.setViewport(0, 0, w, h, 0, 1);
          rp.setScissorRect(0, 0, w, h);
        }
        parts[st].draw(rp, { bind: [frameGroup(depth, st, g, stageCounted(st) ? cost?.[st] ?? null : null), copy, g2], header, params, count: WORLD_MARCH_VERTICES });
      } finally { rp.end(); }
    }
  }
  // cut: the full-detail box ({ lo, hi }, world cells) when boxed (world/window.js cutBox), else physics' window
  // size: the split stages' target (the beam stage's tiles), [w, h]
  const marchParams = ({ meshDepth, marchNear, aerCopy, floorLines, boxed = false, cut = null, inSize = null }) => {
    const depth = meshDepth ?? dummy.depth, phys = physParams(sim);
    return {
      meshInv, meshRes: inSize ?? [depth.width, depth.height], meshCut: meshDepth ? 1 : 0, marchNear, aerCopy,
      deco: decoShown(sim) && sim.decoPlane ? 1 : 0, floorLines: floorLines ? 1 : 0, ...phys, boxed: boxed ? 1 : 0,
      cutLo: cut?.lo ?? phys.physOrigin, cutHi: cut?.hi ?? phys.physOrigin.map((v, i) => v + phys.physSize[i]), sceneRes: inSize ?? [1, 1],
    };
  };
  let drawNo = 0;
  const twins = new WeakMap();
  const woken = new WeakSet();   // the rich optics' variants whose landing wakes the frame loop (onVariant)
  let compositePipe = null;
  let prepared = false;   // a prepass this frame, for the next draw to composite
  let compositeParams = null;

  // ---- pipelines ----
  const pipes = new Map();
  const fallback = !!gpu.adapterInfo?.isFallbackAdapter;
  const meshInv = new Matrix4();
  let disposed = false;
  const frameEntriesForWorld = () => [
    { binding: 0, resource: { buffer: fu.tables } }, { binding: 1, resource: { buffer: uniforms.buffer } },
  ];
  let lightFrame, emptyDeco, paintGroup;
  function worldFrameGroup() {
    return lightFrame ??= gpu.bindGroup(mesh?.frameLayout ?? gpu.layout('FRAME', RENDER_LAYOUT.FRAME),
      frameEntriesForWorld(), label('frame tables and uniforms'));
  }
  function meshFrameGroup(plane) {
    if (!plane) {
      emptyDeco ??= gpu.createBuffer({ label: label('raster deco (none)'), size: 4, usage: GPUBufferUsage.STORAGE });
      plane = { buffer: emptyDeco, offset: 0, size: 4 };
    }
    if (!paintGroup || ['buffer', 'offset', 'size'].some((k) => plane[k] !== paintGroup.plane[k])) {
      paintGroup = { plane, group: gpu.bindGroup(mesh.drawFrameLayout, [
        ...frameEntriesForWorld(), { binding: 3, resource: plane },
      ], label('raster frame and deco')) };
    }
    return paintGroup.group;
  }
  // F's levels are filled whole on the first update after a build (fields.prime), so the first frame
  // has every level around the camera, not a few thousand bricks of them
  let primed = true;

  // ---- the whole map's pick (shaders/world/pick.js): a big map's god view aims at what the far view draws too
  // (app.js worldAim). Built on its first ray: a map that never asks compiles nothing. ----
  const picker = (() => {
    const kernel = gpu.kernel({
      name: 'worldPick', code: worldPickFrag(sim.g), layouts: [sim.L.TABLES, worldCopy.layout, gpu.layout('WORLD_PICK', WORLD_PICK_LAYOUTS()[2])],
      params: PickParams, workgroupSize: [PICK_BATCH, 1, 1], build: 'manual',
    });
    const ring = gpu.readback.ring(label('picks'), PICK_RESULT_BYTES, PICK_RING_SLOTS);
    const group = gpu.bindGroup(kernel.groups[2], [{ binding: 0, resource: { buffer: ring.buffer } }], label('picks'));
    return { kernel, ring, group, queue: [], scheduled: false };
  })();
  const failPicks = (e) => { for (const p of picker.queue.splice(0)) p.reject(e); };
  const recordPicksQuietly = () => { try { view.recordPicks(); } catch { /* (the picks carry it) */ } };

  const view = {
    worldCopy, fields, light, fastRaster, mesh, optics,
    get rasterPrepared() { return !!rasterPrepared; },
    /** Whether pick() can run: the world copy built. */
    get picks() { return !!worldCopy.bindGroup && !disposed; },
    /**
     * A flat ray through the whole map (world cells): the first non-gas cell, the world's floor, or a miss,
     * as gfx/volume.js pick resolves them ({ valid, cell (world cells), face, id, T, P, life }). Queued and
     * recorded with the frame's compute (recordPicks), or on its own in a microtask.
     */
    pick(ro, rd, skipLiquids = false, cutaway = [0, 0, 0, 0]) {
      if (!view.picks) return Promise.reject(new Error('world pick: no world copy'));
      const v3 = (v) => (Array.isArray(v) ? [...v] : [v.x, v.y, v.z]);
      const p = new Promise((resolve, reject) => picker.queue.push({ ro: v3(ro), rd: v3(rd), skipLiquids, cutaway, resolve, reject }));
      if (!picker.scheduled) {
        picker.scheduled = true;
        queueMicrotask(() => { picker.scheduled = false; if (!disposed && picker.queue.length) recordPicksQuietly(); });
      }
      return p;
    },
    /** Records the queued rays into the open frame (PICK_BATCH a dispatch), as gfx/volume.js recordPicks. */
    recordPicks() {
      if (!picker.queue.length) return;
      if (picker.kernel.state !== 'ready') { picker.kernel.build().then(recordPicksQuietly, failPicks); return; }
      const copy = worldCopy.bindGroup;
      if (!copy) { failPicks(new Error('world pick: no world copy')); return; }
      while (picker.queue.length) {
        const batch = picker.queue.splice(0, PICK_BATCH);
        let slots;
        try {
          slots = batch.map(() => picker.ring.next());
          const words = new Array(PICK_BATCH).fill(0);
          slots.forEach((s, i) => { words[i] = s; });
          picker.kernel.dispatch(gpu.frame, [1, 1, 1], {
            bind: [sim.tables, copy, picker.group],
            params: {
              ro: batch.map((b) => [...b.ro, 0]), rd: batch.map((b) => [...b.rd, b.skipLiquids ? 1 : 0]),
              cutaway: batch.map(b => b.cutaway), warp: batch.map(() => [0, 0, 0, 1]), slot: [words.slice(0, 4), words.slice(4, 8)], n: batch.length,
            },
          });
        } catch (e) {
          for (const b of batch) b.reject(e);
          failPicks(e);
          throw e;
        }
        batch.forEach((b, i) => picker.ring.read(slots[i]).then((bytes) => {
          const f = new Float32Array(bytes);
          b.resolve({ valid: f[3] >= 0, cell: [f[0], f[1], f[2]], face: f[3], id: Math.round(f[4]), T: f[5], P: f[6], life: f[7], raw: f });
        }, b.reject));
      }
    },
    /** W's build (the whole map, before the first frame). */
    ready,
    /** Builds the world copy from a loaded window (a big map), or a simulation (a small map). */
    build,
    /** A scratch variant of the march's module for timing ({ name, filter(code) -> code }), or null: tests only. */
    testVariant: globalThis.__worldTestVariant ?? null,   // (a test page may set it before boot: its first build is the variant)
    /** Whether this module draws `view` (the material views; the data views and Plain keep their paths). */
    draws: (v, curved = false) => isMaterialView(v) && !curved,
    /** The view and detail the last prepass was asked for (tests). */
    lastDraw: null,
    /** The split march (a test switch: false draws the whole march, the A/B). */
    split: globalThis.__worldSplit ?? true,
    /** Whether `detail` draws through the split stages (prepass, then draw composites). */
    // (Intentional: a device with WebGPU's default colour bytes, 32, draws the one-pass march: the split's gated
    // stages need EVENT_COLOR_BYTES, shaders/world/march.js "The event kernels")
    splits(detail = {}) { return useLegacyMarch && view.split && !view.testVariant && (gpu.limits?.maxColorAttachmentBytesPerSample ?? 0) >= EVENT_COLOR_BYTES && marchSplits(drawableDetail(detail, fallback)); },
    /**
     * The march's pipeline for a material view and its detail, made on first use. One module per
     * (view, detail, optics) serves every map: the world's size is a uniform (W's WC.size).
     * Lean optics until the grid holds a film or glass (gfx/opticsScan.js, the box volume's
     * opticsWanted); then the rich variant once it is built, in the background, the lean one drawn
     * meanwhile, as gfx/volume.js pipeline does.
     */
    pipeline(v, detail = {}, build = 'now') {
      if (fastRaster) return rasterPipe;
      const plain = view.variant(v, detail, build, false);
      if (!volume.opticsWanted) return plain;
      const rich = view.variant(v, detail, 'now', true);
      if (rich.state === 'ready') return rich;
      if (!woken.has(rich)) { woken.add(rich); rich.ready.then(() => { if (!disposed) onVariant(); }, () => {}); }
      return plain;
    },
    /** The march's pipeline (or split set) with or without the rich optics, made on first use. */
    variant(v, detail, build, optics) {
      const d = drawableDetail(detail, fallback);
      if (view.splits(d)) return view.stages(v, d, build, optics);
      const t = view.testVariant;   // (test.js-style hook: a scratch variant of the module, { name, filter(code) })
      const key = `${v}|${detailKey(d)}${optics ? '|optics' : ''}${t ? `|${t.name}` : ''}`;
      let p = pipes.get(key);
      if (!p) {
        const code = worldMarchFrag(sim.g, { view: v, detail: d, optics });
        pipes.set(key, p = gpu.renderPipeline({
          name: `world.${v}(${detailKey(d) || 'off'})${optics ? '.optics' : ''}${t ? `.${t.name}` : ''}`,
          code: t ? t.filter(code) : code, layouts: [L.frame, L.copy, L.group2],
          params: MarchParams, ...worldMarchPipeline(), build, first: build === 'now',
        }));
      } else if (build === 'now' && (p.state === 'idle' || p.state === 'pending')) p.build();
      return p;
    },
    /**
     * The split march's pipelines for a view and its (drawable) detail, made on first use: one per
     * stage and the composite, as one pipeline to its callers (state, ready, build, buildMs).
     */
    stages(v, d, build = 'now', optics = false) {
      const key = `${v}|${detailKey(d)}|split${optics ? '|optics' : ''}`;
      let set = pipes.get(key);
      if (!set) {
        compositePipe ??= gpu.renderPipeline({
          name: COMPOSITE_NAME, code: compositeWGSL(), layouts: [compositeL, gpu.L.EMPTY, gpu.L.EMPTY],
          params: MarchParams, ...worldMarchPipeline('composite'), build,
        });
        const parts = Object.fromEntries(MARCH_STAGES.map((st) => [st, gpu.renderPipeline({
          name: stagePipeName(v, d, st, optics), code: worldMarchFrag(sim.g, { view: v, detail: d, stage: st, optics }),
          layouts: [stageL[st], L.copy, L.group2], params: MarchParams, ...worldMarchPipeline(st), build, first: build === 'now',
        })]));
        const all = [...Object.values(parts), compositePipe];
        set = {
          parts, composite: compositePipe, name: `world.${v}(${detailKey(d) || 'off'})${optics ? '.optics' : ''} split`,
          get state() {
            const st = all.map((p) => p.state);
            return st.includes('failed') ? 'failed' : st.every((x) => x === 'ready') ? 'ready' : st.includes('pending') ? 'pending' : 'idle';
          },
          ready: Promise.all(all.map((p) => p.ready)),
          build() { for (const p of all) p.build(); return set.ready; },
          get buildMs() { const ms = all.map((p) => p.buildMs); return ms.some((x) => x == null) ? null : Math.max(...ms); },
        };
        pipes.set(key, set);
        // (an A/B test page: the whole march built beside the stages, __worldWarmWhole before boot)
        if (globalThis.__worldWarmWhole) { view.split = false; view.variant(v, d, build, optics); view.split = true; }
      } else if (build === 'now' && (set.state === 'idle' || set.state === 'pending')) set.build();
      return set;
    },
    /**
     * Records raster + optics or the legacy split stages before the scene
     * pass. Returns true when draw() has a picture to composite. The active
     * viewport is anchored at [0,0] inside the reusable allocSize targets.
     */
    prepass(frame, { view: v = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0, floorLines = true, boxed = false, cut = null, target, opaqueSource, loadOpaque = false, edgeSea,
      allocSize = target && [target.width, target.height], inSize = allocSize } = {}) {
      prepared = false;
      rasterPrepared = null;
      view.lastDraw = { view: v, detail };   // (tests: what the frame draws)
      if (disposed || !worldCopy.bindGroup) return false;
      if (fastRaster) {
        if (rasterPipe.state !== 'ready' || !mesh.isReady) return false;
        const [w, h] = inSize;
        const targets = compactTargets(allocSize);
        const frameGroup = worldFrameGroup();
        viewProjModel.multiplyMatrices(last.viewProj, last.model);
        const plane = decoShown(sim) ? sim.decoPlane : null;
        if (!mesh.draw(frame, { views: { S: targets.opaqueColor, opaqueTexture: targets.opaqueTexture }, w, h, allocSize,
          depthTarget: targets.depthTarget, opaqueSource, loadOpaque, deco: !!plane, edgeSea }, frameGroup, viewProjModel, meshFrameGroup(plane))) return false;
        const opaqueDepth = targets.opaqueDepth;
        const eye = last.eye.toArray();
        const maxDist = Math.hypot(...size.map((n, i) => Math.max(Math.abs(eye[i]), Math.abs(n - eye[i]))));
        const overlaid = optics.render(frame, {
          frameGroup0: frameGroup, opaqueColorView: targets.opaqueColor, opaqueDepthView: opaqueDepth,
          outColorView: targets.finalColor, outDepthView: targets.finalDepth, w, h, allocSize,
          viewProj: viewProjModel, invViewProj: meshInv.copy(viewProjModel).invert(), eye, maxDist,
        });
        const [color, depth] = overlaid ? [targets.finalColor, targets.finalDepth] : [targets.opaqueColor, opaqueDepth];
        let group = targets.groups.get(depth);
        if (!group) targets.groups.set(depth, group = gpu.bindGroup(rasterLayout, [
          { binding: 0, resource: color }, { binding: 1, resource: depth },
        ], label('raster composite')));
        rasterPrepared = group;
        return true;
      }
      if (!view.splits(detail)) return false;
      const set = view.pipeline(v, detail, 'now');
      if (set.state !== 'ready') return false;
      gbuffer(...allocSize);
      meshInv.multiplyMatrices(last.viewProj, last.model).invert();   // clip → world cells, the jittered camera's
      const header = { ...sim.readHeader(), origin: [0, 0, 0] };
      const params = marchParams({ meshDepth, marchNear, aerCopy, floorLines, boxed, cut, inSize });
      recordStages(frame, set.parts, gb, meshDepth ?? dummy.depth, header, params);
      view.lastRecorded = { split: true, view: v, detail, meshDepth, marchNear, aerCopy, floorLines, boxed, cut, inSize, size: inSize, pipe: set, n: ++drawNo, at: performance.now() };
      compositeParams = params;
      prepared = true;
      return true;
    },
    /**
     * Writes the march's FrameUniforms: the frame's values (gfx/uniforms.js frameValues' shape),
     * moved into world cells. After writeFrameUniforms for the same frame; `windowValues`, what
     * that returned, lends its camera matrices and settings (else they are built again).
     */
    writeUniforms(frame, windowValues = null) {
      const o = xyz(sim.origin);
      if (!windowValues) frame.camera.updateMatrixWorld();
      const values = frameUniformValuesFor(windowValues ?? frameUniformValues(frame), frame.camera, worldModelMatrix(frame.model, o));
      const shift = (v) => { v[0] += o[0]; v[1] += o[1]; v[2] += o[2]; };
      if (values.cutaway[3]) values.cutaway = [values.cutaway[0] + o[values.cutaway[2]], ...values.cutaway.slice(1)];
      values.lampPos.forEach(shift);
      for (const w of values.wandLightPosition) { w.x += o[0]; w.y += o[1]; w.z += o[2]; }
      if (values.digMax[3] > 0) { shift(values.digMin); shift(values.digMax); }
      last.viewProj.copy(values.viewProj);
      last.model.copy(values.model);
      last.eye.copy(values.cam);
      uniforms.write(values);
    },
    /**
     * World upkeep after physics: writeback, fields (legacy only), lighting,
     * then the raster path's bounded mesh jobs.
     */
    update(frame, { boxes = [], camera = null, sun = null, drawLo = null, cutCentre = null, floor, phase = () => {} } = {}) {
      const rev = worldCopy.revision ?? 0;
      phase('worldCopy');
      worldCopy.recordWriteback(frame, sim, boxes);
      const changes = worldCopy.changesSince ? worldCopy.changesSince(rev) : [];
      const eye = camera ? last.eye.toArray() : null;
      // F follows the march's full detail, not the eye (a god view's eye is often past level 0's reach of it,
      // which read thin walls from coarse levels: gone). cutCentre: the full-detail box's centre (world/window.js
      // cutBox), the focus itself, so level 0 scrolls a brick's slab at a time as the box slides (a slab a
      // frame: the per-frame budget's, gfx/worldFields.js), never refilling behind a window walking WIN_STEP a frame.
      // Else where the window comes to rest (drawLo: world/window.js drawOrigin).
      if (fields && eye) {
        const focus = cutCentre ?? fieldFocus(drawLo ?? xyz(sim.origin), win);
        phase('worldFields');
        if (!primed && worldCopy.bindGroup) { fields.prime(frame, focus); primed = true; } else fields.update(frame, focus, changes);
      }
      phase('worldLight');
      if (eye) light.update(frame, eye, sun, changes, { frameGroup: worldFrameGroup() });
      if (mesh && eye) {
        if (floor !== undefined) meshOpts.floor = floor;
        phase('worldMesh');
        mesh.update(frame, eye);
        if (worldCopy.bindGroup && (mesh.busy || worldCopy.pendingChanges)) onVariant();  // keep bounded chunk batches progressing while idle
      }
    },
    /**
     * Draws into the scene pass at its active viewport. Returns false if a
     * required pipeline, bind group or prepass result isn't available yet.
     */
    draw(rp, { view: v = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0, floorLines = true, boxed = false, cut = null, inSize = null } = {}) {
      if (disposed) return false;
      if (fastRaster) {
        if (!rasterPrepared) return false;
        rasterPipe.draw(rp, { bind: [rasterPrepared] });
        rasterPrepared = null;
        return true;
      }
      if (view.splits(detail)) {
        // the split march's picture, recorded by prepass this frame, over the sky
        if (!prepared) return false;
        prepared = false;
        const set = view.pipeline(v, detail, 'now');
        const group = cached(`comp|${idOf(gb)}`, () => gpu.bindGroup(compositeL, [
          { binding: 0, resource: gb.views.S }, { binding: 1, resource: gb.views.D }], label('composite')));
        set.composite.draw(rp, { bind: [group, gpu.emptyGroup, gpu.emptyGroup], header: sim.readHeader(), params: compositeParams, count: WORLD_MARCH_VERTICES });
        return true;
      }
      const pipe = view.pipeline(v, detail, 'now');
      if (pipe.state !== 'ready') return false;
      const copy = worldCopy.bindGroup;
      if (!copy) return false;
      meshInv.multiplyMatrices(last.viewProj, last.model).invert();   // clip → world cells, the jittered camera's
      const depth = meshDepth ?? dummy.depth;
      pipe.draw(rp, {
        bind: [frameGroup(depth), copy, group2()], header: { ...sim.readHeader(), origin: [0, 0, 0] },
        params: marchParams({ meshDepth, marchNear, aerCopy, floorLines, boxed, cut, inSize }),
        count: WORLD_MARCH_VERTICES,
      });
      view.lastRecorded = { split: false, view: v, detail, meshDepth, marchNear, aerCopy, floorLines, boxed, cut, inSize, pipe, n: ++drawNo, at: performance.now() };
      return true;
    },

    // ---- the cost view (gfx/costView.js, docs/profiler.md "Cost view") ----
    /** What the last frame drew: { split, view, detail, meshDepth, marchNear, aerCopy, floorLines, boxed, size?, pipe, n }, or null. */
    lastRecorded: null,
    /**
     * A live pipeline's counted twin (shaders/costView.js costify of its own WGSL text, a storage
     * texture for the counters in its group 0), made on first use. stage: 'whole' or a split stage.
     */
    costTwin(pipe, stage = 'whole') {
      if (!stageCounted(stage)) return pipe;   // (nothing to count: the counted chain runs it as it is)
      let t = twins.get(pipe);
      if (!t) {
        const { code, params, vertex, fragment, primitive, depthStencil, multisample } = pipe.desc;
        const binding = costBinding(frameEntriesOf(stage));
        twins.set(pipe, t = gpu.renderPipeline({
          name: `${pipe.name}.cost`, code: costify(code, { binding, require: stage === 'whole' ? undefined : [] }),
          layouts: [costLayout(stage), L.copy, L.group2], params, vertex, fragment, primitive, depthStencil, ...(multisample ? { multisample } : {}),
          build: 'now', optional: true,   // (a failure to build it is the cost view's, not the game's)
        }));
      }
      return t;
    },
    /** A G-buffer of the cost view's own (every texture readable), the size of the scene target. */
    costGbuffer(w, h) {
      const tex = {}, views = {};
      for (const [k, format] of Object.entries(GBUF)) {
        tex[k] = gpu.createTexture({ label: label(`cost gbuffer ${k}`), size: [...gbufSize(k, w, h), GBUF_LAYERS[k] ?? 1], format,
          usage: TEX.TEXTURE_BINDING | TEX.COPY_SRC | (STORAGE_GBUF.has(k) ? TEX.STORAGE_BINDING : TEX.RENDER_ATTACHMENT) });
        views[k] = tex[k].createView({ dimension: gbufViewDim(k) });
      }
      return { w, h, tex, views, destroy() { Object.values(tex).forEach((t) => t.destroy()); } };
    },
    /**
     * Replays the last recorded draw (lastRecorded) on the frame state it left: the split stages
     * into G-buffer g with `parts` (the live pipelines, or their twins with `cost`: a storage view per
     * stage), or the whole march into `target` ({ color, depth } views) with `pipe`. Pass names
     * start 'cost view …' (never timed: gfx/profileReport.js EXCLUDED_PASS). False if it can't.
     */
    costReplay(frame, rec, { parts, pipe, g, target, cost = null, name }) {
      const copy = worldCopy.bindGroup;
      if (disposed || !copy) return false;
      meshInv.multiplyMatrices(last.viewProj, last.model).invert();
      const header = { ...sim.readHeader(), origin: [0, 0, 0] };
      const params = marchParams(rec);
      const depth = rec.meshDepth ?? dummy.depth;
      if (rec.split) {
        recordStages(frame, parts, g, depth, header, params, { names: (st) => `${name} world ${st}`, cost });
        return true;
      }
      const rp = frame.render({ colorAttachments: [{ view: target.color, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: target.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }, `${name} world march`);
      try {
        pipe.draw(rp, { bind: [frameGroup(depth, 'whole', gb, cost?.whole ?? null), copy, group2()], header, params, count: WORLD_MARCH_VERTICES });
      } finally { rp.end(); }
      return true;
    },
    /** The pipelines made so far: { key, state, ms }. */
    get pipelines() { return [...pipes].map(([key, p]) => ({ key, state: p.state, ms: p.buildMs })); },
    dispose() {
      disposed = true;
      gpu.flush('world view dispose');
      groups.clear();
      gbs.splice(0).forEach((b) => Object.values(b.tex).forEach((t) => t.destroy?.()));
      gb = null;
      failPicks(new Error('world view disposed'));
      picker.ring.close();
      worldCopy.dispose?.();
      fields?.dispose();
      mesh?.dispose();
      optics?.dispose();
      rasterTargets.splice(0).forEach(destroyRasterTargets);
      rasterPrepared = null;
      emptyDeco?.destroy();
      light.dispose?.();
    },
  };
  if (!sim.windowed && !sim.g?.windowed) build(sim).catch(() => {});
  return view;
}
