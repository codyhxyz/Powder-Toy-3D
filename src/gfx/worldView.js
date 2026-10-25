// The seamless world's view (docs/seamless-world.md, "M"): the material views of every map, small
// and big, drawn by one full-screen march in world cells (shaders/world/march.js) over the world
// copy (W), the field clipmaps (F) and the lighting (L). It owns their objects, its pipelines,
// its own FrameUniforms in world cells and its bind groups; app.js calls, each frame:
//
//   const view = createWorldView(gpu, sim, { volume });   // volume: gfx/volume.js (its shadow map, its noise)
//   prepare:  writeFrameUniforms(gpu, values); view.writeUniforms(values);
//   compute:  physics, then view.update(gpu.frame, { boxes, camera, sun })   // W writeback → F → L
//   before the scene pass: view.prepass(gpu.frame, { view, detail, meshDepth, marchNear, aerCopy, target })
//   draw:     view.draw(rp, { view: 'realistic', detail, meshDepth, marchNear, aerCopy })
//
// The split march (shaders/world/march.js, "The split march"): prepass records its stages as passes
// of their own ('world march', 'world reflect', 'world shade') into a G-buffer the size of the scene
// target; draw then composites their picture into the scene pass. A detail variant that doesn't
// split (the grains), or a draw with no prepass before it, draws the whole march in the scene pass.
//
// FrameUniforms in world cells: the window's FrameUniforms (gfx/uniforms.js) hold the camera,
// the volume's model and the lamps, wand lights and dig mark in physics' window cells, which the
// data views, the shadow kernel and GI still read. The march's copy is the same values with the
// model moved to the world's corner (worldModelMatrix: the eye comes out in world cells) and those
// positions moved by sim.origin. A small map's origin is 0: both copies are equal.
import { Matrix4 } from 'three/webgpu';
import { FrameUniformsStruct, frameUniformValues, worldModelMatrix, frameUniformsOf } from './uniforms.js';
import { drawableDetail } from './detail.js';
import { decoShown } from '../deco.js';
import { isMaterialView } from '../views.js';
import {
  worldMarchFrag, worldMarchPipeline, MarchParams, physParams, WORLD_MARCH_LAYOUTS, WORLD_GROUP2, WORLD_MARCH_VERTICES, WORLD_MARCH_LAYOUT_NAMES,
  MARCH_STAGES, marchSplits, worldMarchLayoutNames, stageTextures, STAGE_TARGETS, GBUF, GBUF_NO_DEPTH, compositeWGSL, COMPOSITE_LAYOUT,
  COMPOSITE_NAME, COMPOSITE_LAYOUT_NAMES, stagePipeName,
} from '../shaders/world/march.js';
import { worldGroup2Entries } from '../shaders/world/bindings.js';
import { materialTextures } from './materialTextures.js';
// The owners' classes. Until W, F and L land these are the stand-ins (shaders/world/stubs.js); the
// lead swaps them for world/worldCopy.js WorldCopy, gfx/worldFields.js WorldFields and
// gfx/worldLight.js WorldLight at integration (same constructors and methods).
import { WorldLight } from './worldLight.js';
import { worldFieldsWGSL, fieldsBindingsWGSL, FIELDS_BINDINGS } from '../shaders/world/fields.js';
import { RENDER_LAYOUT } from '../shaders/bindings.js';
import { WorldCopy } from '../world/worldCopy.js';
import { WorldFields } from './worldFields.js';
import { worldCopyWGSL } from '../shaders/world/copy.js';
import { costify, costBinding, costLayoutEntry } from '../shaders/costView.js';

const TEX = { COPY_SRC: 0x01, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10 };   // (GPUTextureUsage's bits, importable in Node)
const detailKey = (d = {}) => Object.keys(d).filter((k) => d[k]).sort().join(',');
const xyz = (o) => [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0];

/**
 * @param {object} gpu
 * @param {import('../sim.js').Simulation} sim
 * @param {{ volume: object, onVariant?: () => void }} opts volume: the window's (gfx/volume.js): the shadow map and media noise it owns,
 *   and whether its grid wants the rich optics (opticsWanted); onVariant: a rich optics' variant has landed (redraw)
 */
export function createWorldView(gpu, sim, { volume, onVariant = () => {} }) {
  const label = (x) => `sim${sim.id} world ${x}`;
  const size = [sim.world?.[0] ?? sim.g.nx, sim.world?.[1] ?? sim.g.ny, sim.world?.[2] ?? sim.g.nz];
  const worldCopy = new WorldCopy(gpu, { size });
  // W's build: a small map's from its box's cells now; a big map's from its window once that has loaded
  // (wire/world.js calls build(win)), so the whole map is in before the first frame (app.js waits on ready)
  let settle;
  const ready = new Promise((resolve) => { settle = resolve; });
  const build = (source) => worldCopy.build(source).then(async (c) => { await Promise.all([fields.ready, light.ready]); primed = false; settle(c); return c; }, (err) => {
    console.error('world copy: the build failed', err);
    settle(null);
    throw err;
  });
  if (!sim.windowed && !sim.g?.windowed) build(sim).catch(() => {});
  const fields = new WorldFields(gpu, worldCopy, { copyWGSL: worldCopyWGSL(), tables: sim.tables, tablesLayout: sim.L?.TABLES });
  const light = new WorldLight(gpu, worldCopy, fields, {
    copyWGSL: worldCopyWGSL(), fieldsWGSL: `${fieldsBindingsWGSL(2)}\n${worldFieldsWGSL()}`, fieldsBindings: FIELDS_BINDINGS, mediaNoise: volume.mediaNoiseView,
  });

  const list = WORLD_GROUP2();
  const [frameEntries, , group2Entries] = WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT);
  const L = {
    frame: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[0], frameEntries),
    copy: worldCopy.layout,
    group2: gpu.layout(WORLD_MARCH_LAYOUT_NAMES[2], group2Entries),
  };
  // each split stage's group 0 (the frame's four and its G-buffer textures) and the composite's
  const stageL = Object.fromEntries(MARCH_STAGES.map((st) => [st,
    gpu.layout(worldMarchLayoutNames(st)[0], WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT, st)[0])]));
  const compositeL = gpu.layout(COMPOSITE_LAYOUT_NAMES[0], COMPOSITE_LAYOUT);
  // the cost view's twins (gfx/costView.js): each stage's group 0 and the counters' storage texture
  const frameEntriesOf = (st) => WORLD_MARCH_LAYOUTS(worldCopy.layoutEntries ?? WorldCopy.LAYOUT, st)[0];
  const costL = {};
  const costLayout = (st) => (costL[st] ??= gpu.layout(`${worldMarchLayoutNames(st)[0]}_COST`, [...frameEntriesOf(st),
    costLayoutEntry(costBinding(frameEntriesOf(st)))]));
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
  const GBUF_KEPT = 2;
  const destroyGb = (b) => { gpu.flush('world gbuffer'); Object.values(b.tex).forEach((t) => t.destroy?.()); };
  function gbuffer(w, h) {
    const i = gbs.findIndex((b) => b.w === w && b.h === h);
    if (i >= 0) { gb = gbs[i]; gbs.splice(i, 1); gbs.unshift(gb); return gb; }
    if (gbs.length >= GBUF_KEPT) destroyGb(gbs.pop());
    const storage = new Set(stageTextures('march').filter(([, , wr]) => wr).map(([, k]) => k));
    const tex = {}, views = {};
    for (const [k, format] of Object.entries(GBUF)) {
      const usage = GPUTextureUsage.TEXTURE_BINDING | (storage.has(k) ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.RENDER_ATTACHMENT);
      tex[k] = gpu.createTexture({ label: label(`gbuffer ${k}`), size: [w, h], format, usage });
      views[k] = tex[k].createView();
    }
    gb = { w, h, tex, views };
    gbs.unshift(gb);
    return gb;
  }
  const CLEAR = { D: { r: GBUF_NO_DEPTH, g: 0, b: 0, a: 0 } };
  const attach = (k, g = gb) => ({ view: g.views[k], loadOp: 'clear', storeOp: 'store', clearValue: CLEAR[k] ?? { r: 0, g: 0, b: 0, a: 0 } });
  // the split stages into G-buffer g (the frame's, or the cost view's own), each a pass of its own
  function recordStages(frame, parts, g, depth, header, params, { names = (st) => `world ${st}`, cost = null } = {}) {
    const copy = worldCopy.bindGroup, g2 = group2();
    for (const st of MARCH_STAGES) {
      const rp = frame.render({ colorAttachments: STAGE_TARGETS[st].map((k) => attach(k, g)) }, names(st));
      try {
        parts[st].draw(rp, { bind: [frameGroup(depth, st, g, cost?.[st] ?? null), copy, g2], header, params, count: WORLD_MARCH_VERTICES });
      } finally { rp.end(); }
    }
  }
  const marchParams = ({ meshDepth, marchNear, aerCopy, floorLines }) => {
    const depth = meshDepth ?? dummy.depth;
    return {
      meshInv, meshRes: [depth.width, depth.height], meshCut: meshDepth ? 1 : 0, marchNear, aerCopy,
      deco: decoShown(sim) && sim.decoPlane ? 1 : 0, floorLines: floorLines ? 1 : 0, ...physParams(sim),
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
  let lightFrame = null;
  // F's levels are filled whole on the first update after a build (fields.prime), so the first frame
  // has every level around the camera, not a few thousand bricks of them
  let primed = true;

  const view = {
    worldCopy, fields, light,
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
    splits(detail = {}) { return view.split && !view.testVariant && marchSplits(drawableDetail(detail, fallback)); },
    /**
     * The march's pipeline for a material view and its detail, made on first use. One module per
     * (view, detail, optics) serves every map: the world's size is a uniform (W's WC.size).
     * Lean optics until the grid holds a film or glass (gfx/opticsScan.js, the box volume's
     * opticsWanted); then the rich variant once it is built, in the background, the lean one drawn
     * meanwhile, as gfx/volume.js pipeline does.
     */
    pipeline(v, detail = {}, build = 'now') {
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
     * Records the split march's stages before the scene pass, each a pass of its own, into a
     * G-buffer the size of `target` (the scene target's colour). Returns whether it did: draw()
     * then composites them. False (nothing recorded) for a variant that doesn't split, while a
     * pipeline builds, or before the world copy is ready.
     * @param {object} frame gpu.frame
     * @param {{ view?: string, detail?: object, meshDepth?: GPUTexture | null, marchNear?: number, aerCopy?: number, floorLines?: boolean, target: GPUTexture }} opts
     */
    prepass(frame, { view: v = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0, floorLines = true, target } = {}) {
      prepared = false;
      view.lastDraw = { view: v, detail };   // (tests: what the frame draws)
      if (disposed || !view.splits(detail)) return false;
      const set = view.pipeline(v, detail, 'now');
      if (set.state !== 'ready') return false;
      const copy = worldCopy.bindGroup;
      if (!copy) return false;
      gbuffer(target.width, target.height);
      meshInv.multiplyMatrices(last.viewProj, last.model).invert();   // clip → world cells, the jittered camera's
      const header = { ...sim.readHeader(), origin: [0, 0, 0] };
      const params = marchParams({ meshDepth, marchNear, aerCopy, floorLines });
      recordStages(frame, set.parts, gb, meshDepth ?? dummy.depth, header, params);
      view.lastRecorded = { split: true, view: v, detail, meshDepth, marchNear, aerCopy, floorLines, size: [target.width, target.height], pipe: set, n: ++drawNo, at: performance.now() };
      compositeParams = params;
      prepared = true;
      return true;
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
      if (!primed && eye && worldCopy.bindGroup) { fields.prime(frame, eye); primed = true; } else if (eye) fields.update(frame, eye, changes);
      // L's writers read the tables and FrameUniforms in world cells (group 0 without the march's extras)
      lightFrame ??= gpu.bindGroup(gpu.layout('FRAME', RENDER_LAYOUT.FRAME), [
        { binding: 0, resource: { buffer: fu.tables } }, { binding: 1, resource: { buffer: uniforms.buffer } }], label('light frame'));
      if (eye) light.update(frame, eye, sun, changes, { frameGroup: lightFrame });
    },
    /**
     * Draws the march into the scene pass. Returns false (draws nothing) while its pipeline builds
     * or a group isn't available yet.
     * @param {GPURenderPassEncoder} rp
     * @param {{ view?: string, detail?: object, meshDepth?: GPUTexture | null, marchNear?: number, aerCopy?: number }} [opts]
     */
    draw(rp, { view: v = 'realistic', detail = {}, meshDepth = null, marchNear = 0, aerCopy = 0, floorLines = true } = {}) {
      if (disposed) return false;
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
        params: marchParams({ meshDepth, marchNear, aerCopy, floorLines }),
        count: WORLD_MARCH_VERTICES,
      });
      view.lastRecorded = { split: false, view: v, detail, meshDepth, marchNear, aerCopy, floorLines, pipe, n: ++drawNo, at: performance.now() };
      return true;
    },

    // ---- the cost view (gfx/costView.js, docs/profiler.md "Cost view") ----
    /** What the last frame drew: { split, view, detail, meshDepth, marchNear, aerCopy, floorLines, size?, pipe, n }, or null. */
    lastRecorded: null,
    /**
     * A live pipeline's counted twin (shaders/costView.js costify of its own WGSL text, a storage
     * texture for the counters in its group 0), made on first use. stage: 'whole' or a split stage.
     */
    costTwin(pipe, stage = 'whole') {
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
      const storage = new Set(stageTextures('march').filter(([, , wr]) => wr).map(([, k]) => k));
      const tex = {}, views = {};
      for (const [k, format] of Object.entries(GBUF)) {
        tex[k] = gpu.createTexture({ label: label(`cost gbuffer ${k}`), size: [w, h], format,
          usage: TEX.TEXTURE_BINDING | TEX.COPY_SRC | (storage.has(k) ? TEX.STORAGE_BINDING : TEX.RENDER_ATTACHMENT) });
        views[k] = tex[k].createView();
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
      worldCopy.dispose?.();
      fields.dispose?.();
      light.dispose?.();
    },
  };
  return view;
}
