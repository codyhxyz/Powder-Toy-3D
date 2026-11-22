// CPU-only integration: record the real renderer and post hooks without a browser or a GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridLayout } from '../src/sim.js';
import { createWorldView } from '../src/gfx/worldView.js';
import { meshGroundWGSL, WGSL_CHECK as meshShaders } from '../src/gfx/meshGround.js';
import { createMeshCut } from '../src/gfx/meshCut.js';
import { createMeshFrames } from '../src/gfx/meshFrames.js';
import { createPost, UPSCALE } from '../src/gfx/post.js';
import { AUTO_RES, levelScale } from '../src/gfx/autoResolution.js';
import { FarField } from '../src/world/far.js';
import { WGSL_CHECK as farShaders } from '../src/shaders/far.js';
import { WGSL_CHECK as rasterShaders } from '../src/shaders/world/rasterComposite.js';
import { WGSL_CHECK as signShaders } from '../src/shaders/probe.js';
import { GBUF, gbufSize, MARCH_STAGES } from '../src/shaders/world/march.js';
import { WGSL_CHECK as opticsShaders } from '../src/shaders/world/opticsOverlay.js';
import { nagaExec } from './naga.mjs';

const g = gridLayout(64, 64, 64);
const alloc = [941, 607];
const sun = new Vector3(0.2, 0.8, 0.4).normalize();
const camera = new PerspectiveCamera(70, alloc[0] / alloc[1], 0.1, 4096);
camera.coordinateSystem = WebGPUCoordinateSystem;
camera.position.set(70, 71, 92);
camera.lookAt(32, 32, 32);
camera.updateProjectionMatrix();

Object.assign(globalThis, {
  GPUBuffer: class GPUBuffer {},
  GPUTexture: class GPUTexture {},
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
});

function recordingGpu({ deferOptics = false } = {}) {
  const log = [], textures = [], buffers = [], pipes = new Map();
  let active = null;
  const record = (d) => {
    const deferred = deferOptics && /world (mediaHalf|opticsOverlay)$/.test(d.name);
    let resolve;
    const p = {
      name: d.name, desc: d, groups: d.layouts, state: deferred ? 'pending' : 'ready',
      ready: deferred ? new Promise((r) => { resolve = r; }) : Promise.resolve(),
      finish() { p.state = 'ready'; resolve?.(); },
      draw(pass, opts) {
        assert.equal(pass, active);
        assert.equal(p.state, 'ready');
        d.params?.pack(opts.params);
        log.push({ type: 'draw', name: d.name, pass, ...opts });
      },
      dispatch(_frame, size, opts) {
        assert.equal(active, null);
        d.params?.pack(opts.params);
        log.push({ type: 'dispatch', name: d.name, size, ...opts });
      },
    };
    pipes.set(d.name, p);
    return p;
  };
  const emptyGroup = {};
  const queue = { writeBuffer() {}, writeTexture() {}, onSubmittedWorkDone: async () => {} };
  function buffer(d) {
    const b = Object.assign(new GPUBuffer(), d, { destroy() { this.dead = true; } });
    buffers.push(b);
    return b;
  }
  const gpu = {
    log, textures, buffers, pipes, queue, emptyGroup, stats: { draws: 0, flushes: 0 }, L: { EMPTY: { entries: [] } },
    limits: { maxColorAttachmentBytesPerSample: 128 },
    device: { queue, createSampler: (d) => d ?? {}, limits: { maxStorageBufferBindingSize: 128 << 20, maxBufferSize: 256 << 20 } },
    layout: (label, entries) => ({ label, entries }),
    bindGroup(layout, entries, label) {
      if (layout?.entries) {
        const sorted = (es) => es.map((e) => e.binding).sort((a, b) => a - b);
        assert.deepEqual(sorted(entries), sorted(layout.entries), label ?? layout.label);
      }
      return { layout, entries, label };
    },
    renderPipeline: record, kernel: record, createBuffer: buffer, write() {},
    uniforms(struct, label) { return { buffer: buffer({ label, size: struct.size }), write: (v) => struct.pack(v) }; },
    readback: { ring: () => ({ buffer: {}, next: () => 0, read: () => new Promise(() => {}), close() {} }), buffer: async (b, at, size) => new ArrayBuffer(size) },
    createTexture(d) {
      const t = Object.assign(new GPUTexture(), d, { width: d.size[0], height: d.size[1], createView() { return { texture: this }; }, destroy() { this.dead = true; } });
      textures.push(t);
      return t;
    },
    frame: {
      render(desc, name) {
        assert.equal(active, null);
        active = { type: 'pass', name, desc, setViewport(...v) { this.viewport = v; }, setScissorRect(...r) { this.scissor = r; },
          drawIndexedIndirect() {}, end() { assert.equal(active, this); active = null; } };
        log.push(active);
        return active;
      },
      compute() { assert.equal(active, null); }, copy() {}, clear() {},
      direct() {
        assert.equal(active, null);
        return { copyTextureToTexture(src, dst, size) { log.push({ type: 'copyTexture', src, dst, size }); } };
      },
    },
    fence: async () => {}, flush() { gpu.stats.flushes++; },
  };
  return gpu;
}

function fixture(gpu, world = null) {
  const sim = { id: 1, g, gpu, world, windowed: !!world, origin: new Vector3(world ? 32 : 0, 0, world ? 64 : 0),
    L: { TABLES: {}, STATE_RO: {} }, tables: {}, state: { flow: {} }, readHeader: () => ({}) };
  const volume = { mediaNoiseView: {}, opticsWanted: false };
  const values = { camera, sun, model: new Matrix4().makeTranslation(...sim.origin.toArray()) };
  return { sim, volume, values };
}

function assertViewport(pass, dims, backing) {
  assert(pass);
  if (dims.some((n, i) => n !== backing[i])) {
    assert.deepEqual(pass.viewport, [0, 0, ...dims, 0, 1], pass.name);
    assert.deepEqual(pass.scissor, [0, 0, ...dims], pass.name);
  } else {
    assert.equal(pass.viewport, undefined, pass.name);
    assert.equal(pass.scissor, undefined, pass.name);
  }
}
const pass = (gpu, name) => gpu.log.find((p) => p.type === 'pass' && p.name === name);
const draw = (gpu, name) => gpu.log.find((p) => p.type === 'draw' && p.name === name);
const backingSize = (t) => [t.width, t.height];
const half = (p) => p.map((n) => Math.ceil(n / 2));

function checkShader(name, code, layouts = []) {
  nagaExec(code, `${name}.wgsl`, { bin: process.env.NAGA ?? 'naga' });
  // wgsl_reflect 1.6 cannot constant-fold this existing FarField vec3 * scalar
  // expression. Expand its components for reflection only; Naga sees the original.
  const reflectCode = code.replace('vec3f(0.016, 0.006, 0.01) * (CELL_M * 100.0)',
    'vec3f(0.016 * CELL_M * 100.0, 0.006 * CELL_M * 100.0, 0.01 * CELL_M * 100.0)');
  const r = new WgslReflect(reflectCode);
  for (const [group, layout] of layouts.entries()) {
    if (!Array.isArray(layout)) continue;
    for (const resource of (r.getBindGroups()[group] ?? []).filter(Boolean)) {
      assert(layout.some((b) => b.binding === resource.binding), `${name} group ${group} binding ${resource.binding}`);
    }
  }
  return r;
}
test('Naga and reflection validate the compact composite, mesh, optics, and mixed FarField shaders', () => {
  const [comp] = rasterShaders();
  const r = checkShader(comp.name, comp.code(), comp.layouts());
  assert.equal(r.entry.fragment[0].outputs.find((o) => o.location === 'frag_depth').type.name, 'f32');
  assert.equal(comp.depthStencil.depthWriteEnabled, true);
  assert.equal(comp.depthStencil.depthCompare, 'less-equal');
  const compact = meshGroundWGSL(g, true);
  for (const name of ['draw', 'background']) {
    const e = meshShaders().find((s) => s.name === `mesh ground ${name}`);
    const fs = checkShader(`compact mesh ${name}`, compact[name], e.layouts()).entry.fragment[0];
    assert.deepEqual(fs.outputs.filter((o) => o.locationType === 'location').map((o) => o.location), [0]);
  }
  for (const e of [...opticsShaders, ...signShaders, ...farShaders().filter((s) => s.name.startsWith('far view mixed'))]) {
    checkShader(e.name, e.code(g), e.layouts(g));
  }
});

for (const world of [null, [1024, 128, 1024]]) test(`default ${world ? 'streamed world' : 'box'}: opaque fallback, then all DRS viewports without target churn`, async () => {
  const gpu = recordingGpu({ deferOptics: true });
  const { sim, volume, values } = fixture(gpu, world);
  let wakes = 0;
  const view = createWorldView(gpu, sim, { volume, onVariant: () => wakes++ });
  assert.equal(view.fastRaster, true);
  assert.equal(view.fields, null);
  assert.equal(view.draws('realistic', true), false, 'curved view keeps its separate route');
  assert.equal(view.draws('heat'), false);
  assert.deepEqual(view.worldCopy.size, world ?? [g.nx, g.ny, g.nz]);
  if (world) {
    assert.equal(view.worldCopy.bindGroup, null);
    await view.build({ sim }); // Use the real WorldCopy lifecycle without generating terrain.
  }
  assert.equal(await view.ready, view.worldCopy, 'world readiness must not block on optional optics');
  assert(view.mesh.isReady);
  const writeback = view.worldCopy.recordWriteback.bind(view.worldCopy);
  view.worldCopy.recordWriteback = (...args) => { gpu.log.push({ type: 'writeback' }); return writeback(...args); };

  const [width, height] = alloc;
  const presenter = { canvas: { width, height }, format: 'rgba8unorm', texture: () => ({ width, height }), attachment: () => ({ view: {} }) };
  const post = createPost(gpu, { presenter });
  await post.ready;
  post.settings.upscale = UPSCALE.quality;
  const hooks = {
    prepare() { view.writeUniforms(values); },
    compute() { view.update(gpu.frame, { camera, sun, sea: 9, floor: 2 }); },
    opaque(p) {
      assert(view.prepass(gpu.frame, { target: p.sceneTarget.color, allocSize: p.allocSize, inSize: p.inSize }));
      return false; // independent of whether the scene pass should load existing Three attachments
    },
    draw(rp) { assert(view.rasterPrepared); assert(view.draw(rp)); assert(!view.rasterPrepared); },
    overlay() {},
  };
  function render() {
    gpu.log.length = 0;
    assert(post.render(hooks, camera));
    const [w, h] = post.inSize;
    for (const name of ['mesh ground', 'scene', 'overlay']) assertViewport(pass(gpu, name), [w, h], alloc);
    const meshPass = pass(gpu, 'mesh ground');
    const opaqueView = meshPass.desc.colorAttachments[0].view;
    assert.equal(meshPass.desc.colorAttachments.length, 1);
    assert.equal(draw(gpu, 'mesh ground background').params.sea, 9);
    assert.equal(draw(gpu, 'mesh ground background').params.floor, 2);
    const composite = draw(gpu, 'world raster composite');
    const [color, depth] = composite.bind[0].entries.map((e) => e.resource);
    const opticsPass = pass(gpu, 'world optics overlay');
    if (opticsPass) {
      const mediaPass = pass(gpu, 'world media half');
      assertViewport(opticsPass, post.inSize, alloc);
      assertViewport(mediaPass, half(post.inSize), half(alloc));
      assert.deepEqual(draw(gpu, 'world opticsOverlay').params.inSize, post.inSize);
      assert.equal(color, opticsPass.desc.colorAttachments[0].view);
      assert.equal(depth, opticsPass.desc.depthStencilAttachment.view);
      assert.equal(draw(gpu, 'world opticsOverlay').bind[0], draw(gpu, 'mesh ground background').bind[0]);
      assert.deepEqual(draw(gpu, 'world opticsOverlay').params.eye, camera.position.toArray());
    } else {
      assert.equal(color, opaqueView);
      assert.equal(depth, view.mesh.depthView);
    }
    const order = [gpu.log.find((e) => e.type === 'writeback'), gpu.log.find((e) => e.type === 'dispatch' && e.name.startsWith('worldLight')),
      gpu.log.find((e) => e.type === 'dispatch' && e.name === 'mesh ground reset'), meshPass,
      ...(opticsPass ? [pass(gpu, 'world media half'), opticsPass] : []), composite].filter(Boolean).map((e) => gpu.log.indexOf(e));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    return { order, opticsPass };
  }
  const fallback = render();
  assert.equal(fallback.order.length, 5, 'first frame runs writeback, lighting, mesh jobs, raster, and composite');
  assert(!fallback.opticsPass);
  for (const name of ['world mediaHalf', 'world opticsOverlay']) {
    assert.equal(gpu.pipes.get(name).desc.optional, true);
    gpu.pipes.get(name).finish();
  }
  const wakesBeforeOptics = wakes;
  await view.optics.ready;
  assert(wakes > wakesBeforeOptics, 'optics readiness wakes presentation');
  assert(render().opticsPass);
  const textures = gpu.textures.length;
  const fullTargets = gpu.textures.filter((t) => /world raster |mesh ground hardware depth/.test(t.label));
  const media = gpu.textures.find((t) => t.label === 'world media half');
  assert.deepEqual(fullTargets.map((t) => t.format), ['rgba16float', 'rgba16float', 'depth32float', 'depth32float']);
  for (const t of fullTargets) {
    assert.deepEqual(backingSize(t), alloc);
    assert.equal(t.usage, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
  }
  assert.deepEqual(backingSize(media), half(alloc));
  assert(!gpu.textures.some((t) => /gbuffer|world field |mesh ground clip depth/.test(t.label)));
  assert(![...gpu.pipes.keys()].some((name) => name.startsWith('worldField ')));
  const viewports = new Set();
  for (let i = 1; i <= AUTO_RES.LEVELS; i++) {
    post.settings.resolutionScale = levelScale(i);
    assert(render().opticsPass);
    viewports.add(post.inSize.join('x'));
    assert.equal(gpu.textures.length, textures, 'no allocation, including mesh depth and media');
    assert(fullTargets.every((t) => !t.dead) && !media.dead);
  }
  assert.equal(viewports.size, 8);
  view.dispose();
  assert(fullTargets.every((t) => t.dead) && media.dead);
  assert(gpu.buffers.filter((b) => /mesh ground/.test(b.label)).every((b) => b.dead));
});

test('URL and explicit march selection retain the split G-buffer and active mesh resolution', async () => {
  const gpu = recordingGpu();
  const { sim, volume, values } = fixture(gpu);
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?renderer=march' } });
  let view;
  try { view = createWorldView(gpu, sim, { volume }); }
  finally {
    if (location) Object.defineProperty(globalThis, 'location', location);
    else delete globalThis.location;
  }
  assert.equal(view.fastRaster, false);
  assert.equal(view.mesh, null);
  assert(view.fields);
  await view.ready;
  const optsGpu = recordingGpu();
  const explicit = fixture(optsGpu);
  const diagnostic = createWorldView(optsGpu, explicit.sim, { volume: explicit.volume, renderer: 'march' });
  assert.equal(diagnostic.fastRaster, false);
  await diagnostic.ready;
  diagnostic.dispose();
  view.writeUniforms(values);
  const meshDepth = gpu.createTexture({ size: alloc, format: 'depth32float' });
  const target = gpu.createTexture({ size: alloc, format: 'rgba16float' });
  const gbufferCount = () => gpu.textures.filter((t) => t.label?.includes('world gbuffer ')).length;
  const render = (inSize) => {
    gpu.log.length = 0;
    view.update(gpu.frame, { camera, sun });
    assert(view.prepass(gpu.frame, { target, meshDepth, inSize }));
    for (const st of MARCH_STAGES) {
      const stage = pass(gpu, `world ${st}`);
      assert(stage);
      const k = st === 'beam' ? 'T' : 'Z';
      assertViewport(stage, gbufSize(k, ...inSize), gbufSize(k, ...alloc));
    }
    assert.deepEqual(view.lastRecorded.inSize, inSize);
    const p = gpu.frame.render({}, 'scene');
    assert(view.draw(p, { inSize, meshDepth }));
    p.end();
    const rendered = gpu.log.find((e) => e.type === 'draw' && e.pass.name === 'world march');
    assert.deepEqual(rendered.params.meshRes, inSize);
    assert.deepEqual(rendered.params.sceneRes, inSize);
  };
  render([603, 359]);
  assert.equal(gbufferCount(), Object.keys(GBUF).length);
  render([411, 217]);
  assert.equal(gbufferCount(), Object.keys(GBUF).length);
  view.dispose();
});

test('depth handoffs copy full allocations and cached scenes restore only the active viewport', async () => {
  const gpu = recordingGpu();
  const cut = createMeshCut(gpu), kept = createMeshFrames(gpu);
  const width = alloc[0], height = alloc[1];
  const presenter = { canvas: { width, height }, format: 'rgba8unorm', texture: () => ({ width, height }), attachment: () => ({ view: {} }) };
  const post = createPost(gpu, { presenter });
  await post.ready;
  post.settings.upscale = UPSCALE.quality;
  kept.plan('kept scene', { moved: true, settle: 1 });
  kept.plan('kept scene', { moved: true, settle: 1 });
  function render() {
    gpu.log.length = 0;
    assert(post.render({
      opaque(p) {
        const depth = p.sceneTarget.depth;
        assert(cut.capture(depth));
        assert.deepEqual(backingSize(cut.take()), alloc);
        assert.equal(cut.take(), null);
        assert(!kept.fits(p));
        kept.capture(p);
        assert(kept.restore(p));
        return true;
      },
    }, camera));
    const copied = gpu.log.filter((e) => e.type === 'copyTexture');
    assert.equal(copied.length, 2);
    for (const e of copied) {
      assert.deepEqual(e.size, alloc);
      assert.deepEqual(backingSize(e.dst.texture), alloc);
    }
    assertViewport(pass(gpu, 'mesh frames restore'), post.inSize, alloc);
  }
  render();
  const count = gpu.textures.length;
  post.settings.resolutionScale = levelScale(4);
  render();
  assert.equal(gpu.textures.length, count);
  cut.dispose();
  kept.dispose();
});

test('diagnostic and curved FarField resolve use active full and half viewports with stable textures', () => {
  const gpu = recordingGpu();
  const mixed = gpu.renderPipeline({ name: 'test mixed far' });
  const far = Object.create(FarField.prototype);
  Object.assign(far, {
    gpu, presentation: { active: false, parameters: { k: 0 } },
    _drawPipeline: () => mixed, _pipeline: () => mixed, _params: () => ({}), _frameGroupMixed: () => ({}),
    sim: { bindRO: {}, readHeader: () => ({}) }, light: { bindEntries: () => [] }, vol: { farLightingGroup: () => ({}), lightingGroup: {} },
  });
  const color = gpu.createTexture({ size: alloc, format: 'rgba16float' });
  const depth = gpu.createTexture({ size: alloc, format: 'depth32float' });
  for (const curved of [false, true]) {
    far.presentation.active = curved;
    far.presentation.parameters.k = curved ? 0.1 : 0;
    for (const inSize of [[581, 359], [333, 217]]) {
      gpu.log.length = 0;
      assert(far.drawPass(gpu.frame, { color, depth, inSize, march: true, load: true }));
      assertViewport(pass(gpu, 'far view low'), half(inSize), half(alloc));
      assertViewport(pass(gpu, 'far view'), inSize, alloc);
      const calls = gpu.log.filter((e) => e.type === 'draw');
      assert.equal(calls[0].params.resolve, 0);
      assert.equal(calls[1].params.resolve, 1);
      assert.equal(calls[1].params.march, curved ? 0 : 1);
      assert.deepEqual(calls[1].params.lowSize, half(inSize));
      assert.equal(gpu.textures.length, 4, 'two scene targets and two reusable low targets');
    }
  }
});
