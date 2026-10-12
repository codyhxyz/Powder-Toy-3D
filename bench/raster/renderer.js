// The raster bench's renderer: plain WebGPU, nothing from src/. One scene's
// static resources (faces, material rows, patterns, the cell ids as a 3D
// texture, the light grid, the shadow map), the pipelines, and two ways to
// draw a frame of it:
//
//   msaa   shadow → opaque (4× MSAA at the output size, resolved: colour +
//          linear depth; the samples discarded) → translucent (1×) → tone map
//   taau   shadow → opaque (1× at ⅔ size, Halton-jittered: colour, linear
//          depth, motion) → translucent (⅔) → resolve (reprojection,
//          neighbourhood clamp, upscale to the output size) with the tone map
//
// Each pass writes timestamps when the device has timestamp-query; every
// frame also records submit-to-onSubmittedWorkDone and its CPU encode time.
import { shaderSources } from './shaders.js';
import { makePatterns, TILE } from './patterns.js';
import { mul, perspective, ortho, lookAt, invert, halton } from './math.js';
import { CLS } from './scene.js';

const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;
export const PASSES = { msaa: ['shadow', 'opaque', 'translucent', 'tonemap'], taau: ['shadow', 'opaque', 'translucent', 'resolve'] };
export const TAAU_SCALE = 2 / 3;   // Lean's internal resolution (docs/v2/evidence/pitch-lean.md)
const SAMPLES = 4;
const FRAME_BYTES = 416;           // shaders.js Frame
const MAT_FLOATS = 28;             // shaders.js Mat: 4 tones, emit, sigma, surf
const LIGHT_ITERS = 16;            // 15 levels of 16: 16 Jacobi iterations reach the full answer
const FAR = 60000;
const FOG = 0.0012;                // per cell
const EXPOSURE = 0.55;
const TAA_BLEND = 0.1;
const EMIT_STRENGTH = 4;           // HDR emission of a glowing cell, × its blackbody colour
// The default god view (src/app.js: the camera at (11, 12, 13) looking at (0, 2.5, 0) in a 10-unit box, 40° fov)
const CAM = { offset: [11, 9.5, 13], target: 0.25, fov: 40 };
// A fixed sun, 38° up (tools/lod-frame-bench.mjs's elevation), behind the default camera's shoulder
const SUN = { az: 35, el: 38 };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** The material rows (shaders.js Mat) of the bake's element table. */
function materialRows(elements, patterns) {
  const out = new Float32Array(Math.max(1, elements.length) * MAT_FLOATS);
  elements.forEach((e, i) => {
    const o = i * MAT_FLOATS, base = hexRgb(e.color);
    // 4 tones around the element's colour, ±its variance (TPT's per-particle jitter; docs/v2.md 3.3)
    [-0.6, -0.2, 0.2, 0.6].forEach((t, k) => {
      for (let c = 0; c < 3; c++) out[o + k * 4 + c] = srgbToLinear(Math.min(1, Math.max(0, base[c] * (1 + e.var * t))));
    });
    if (e.emit) for (let c = 0; c < 3; c++) out[o + 16 + c] = srgbToLinear(e.emit[c]) * EMIT_STRENGTH;
    out[o + 19] = e.cls;
    if (e.sigma) for (let c = 0; c < 3; c++) out[o + 20 + c] = e.sigma[c];
    out[o + 23] = e.pattern;
    // surface: roughness, F0, metal, sparkle (docs/v2.md 3.3's matte · gloss · metal)
    const name = patterns[e.pattern];
    const surf = name === 'plate' ? [0.35, 0.6, 1, 0.3]
      : e.cls === CLS.LIQUID || e.cls === CLS.TRANSLUCENT ? [0.08, 0.02, 0, 0]
        : name === 'snow' ? [0.7, 0.04, 0, 0.8] : name === 'grain' ? [0.85, 0.04, 0, 0.4] : [0.9, 0.04, 0, 0];
    out.set(surf, o + 24);
  });
  return out;
}

/**
 * Whether this device takes transient MSAA attachments: a 4×4 MSAA colour
 * and depth pair with GPUTextureUsage.TRANSIENT_ATTACHMENT, cleared and
 * discarded in a pass, without a validation error.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function probeTransient(device, usage) {
  if (!usage) return { ok: false, reason: 'GPUTextureUsage.TRANSIENT_ATTACHMENT is not defined in this browser' };
  device.pushErrorScope('validation');
  const tex = (format, sampleCount, extra) => device.createTexture({ size: [4, 4], format, sampleCount, usage: TU.RENDER_ATTACHMENT | extra });
  const color = tex('rgba16float', SAMPLES, usage), resolve = tex('rgba16float', 1, 0), depth = tex('depth24plus', SAMPLES, usage);
  const enc = device.createCommandEncoder();
  enc.beginRenderPass({
    colorAttachments: [{ view: color.createView(), resolveTarget: resolve.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  }).end();
  device.queue.submit([enc.finish()]);
  const e = await device.popErrorScope();
  for (const t of [color, resolve, depth]) t.destroy();
  return e ? { ok: false, reason: e.message } : { ok: true };
}

export class Renderer {
  /**
   * @param {{ device: GPUDevice, context: GPUCanvasContext, format: string, scene: object, faces: object,
   *   heights: Uint32Array, shadowSize: number, timestamps: boolean, transientUsage: number,
   *   shared?: { layouts: object, pipelines: object } }} o
   */
  constructor(o) {
    Object.assign(this, o);
    const { device: d, scene } = o;
    const [nx, ny, nz] = this.dims = scene.dims;
    this.nOpaque = o.faces.counts.opaque;
    this.nTrans = o.faces.counts.liquid + o.faces.counts.glass;
    const buffer = (label, data, usage) => {
      const b = d.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | BU.COPY_DST });
      d.queue.writeBuffer(b, 0, data);
      return b;
    };
    this.opaqueBuf = buffer('opaque faces', o.faces.opaque, BU.STORAGE);
    this.transBuf = buffer('translucent faces', o.faces.translucent, BU.STORAGE);
    this.matsBuf = buffer('materials', materialRows(scene.header.elements, scene.header.patterns), BU.STORAGE);
    this.heightsBuf = buffer('column heights', o.heights, BU.STORAGE);
    // the patterns: one texture_2d_array with mips
    const pat = makePatterns(scene.header.patterns);
    this.patterns = d.createTexture({
      label: 'patterns', size: [TILE, TILE, pat.layers], format: 'rgba8unorm', mipLevelCount: pat.levels.length,
      usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    pat.levels.forEach((layers, m) => layers.forEach((img, l) => {
      const s = TILE >> m;
      d.queue.writeTexture({ texture: this.patterns, mipLevel: m, origin: [0, 0, l] }, img, { bytesPerRow: s * 4, rowsPerImage: s }, [s, s, 1]);
    }));
    this.grassLayer = Math.max(0, scene.header.patterns.indexOf('grass'));
    // the cells' ids (the light fill and the liquid walk read them) and the light grid
    this.idVol = d.createTexture({ label: 'ids', size: [nx, ny, nz], dimension: '3d', format: 'r8uint', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
    d.queue.writeTexture({ texture: this.idVol }, scene.ids, { bytesPerRow: nx, rowsPerImage: ny }, [nx, ny, nz]);
    this.light = d.createTexture({ label: 'light grid', size: [nx, ny, nz], dimension: '3d', format: 'rgba8unorm', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING });
    this.shadow = d.createTexture({ label: 'shadow map', size: [o.shadowSize, o.shadowSize], format: 'depth16unorm', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    this.patSampler = d.createSampler({ magFilter: 'nearest', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.linSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.shadowCmp = d.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.frameHi = d.createBuffer({ label: 'frame (output size)', size: FRAME_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    this.frameLo = d.createBuffer({ label: 'frame (TAAU internal size)', size: FRAME_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    this.frameData = new Float32Array(FRAME_BYTES / 4);
    if (o.timestamps) {
      this.querySet = d.createQuerySet({ type: 'timestamp', count: 8 });
      this.resolveBuf = d.createBuffer({ label: 'timestamps', size: 64, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
      this.readbacks = Array.from({ length: 4 }, (_, i) => ({ buf: d.createBuffer({ label: `timestamps readback ${i}`, size: 64, usage: BU.MAP_READ | BU.COPY_DST }), busy: false }));
    }
    // the pipelines don't depend on the scene: a second scene's renderer takes the first's
    this.layouts = o.shared?.layouts ?? this.makeLayouts();
    this.pipelines = o.shared?.pipelines ?? null;
    this.targets = null;
    this.sun = this.sunMatrix();
  }

  makeLayouts() {
    const d = this.device, VF = SS.VERTEX | SS.FRAGMENT, F = SS.FRAGMENT, C = SS.COMPUTE;
    const L = (label, entries) => d.createBindGroupLayout({ label, entries: entries.map((e, binding) => ({ binding, ...e })) });
    const ub = (visibility) => ({ visibility, buffer: { type: 'uniform' } });
    const ro = (visibility) => ({ visibility, buffer: { type: 'read-only-storage' } });
    const tex = (visibility, viewDimension = '2d', sampleType = 'float') => ({ visibility, texture: { viewDimension, sampleType } });
    const smp = (visibility, type = 'filtering') => ({ visibility, sampler: { type } });
    return {
      shadow: L('shadow', [ub(SS.VERTEX), ro(SS.VERTEX)]),
      scene: L('scene', [ub(VF), ro(VF), ro(VF), tex(VF, '2d-array'), smp(VF), tex(VF, '2d', 'depth'), smp(VF, 'comparison'), tex(VF, '3d'), smp(VF)]),
      trans: L('translucent inputs', [tex(F), tex(F), tex(F, '3d', 'uint')]),
      // (the frame is the vertex stage's too: vsFull's nonce reads it)
      tone: L('tone map', [ub(VF), tex(F), tex(F)]),
      taa: L('TAAU resolve', [ub(VF), tex(F), tex(F), tex(F), tex(F), smp(F)]),
      light: L('light grid', [ub(C), tex(C, '3d', 'uint'), ro(C), ro(C), ro(C), { visibility: C, buffer: { type: 'storage' } },
        { visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } }]),
    };
  }

  /**
   * Builds every pipeline one after another, each timed from its
   * create*PipelineAsync call to the pipeline (wall time; with a fresh
   * nonce, a cold compile). Throws on a shader or pipeline error.
   * @returns {Promise<{ name: string, kind: string, ms: number }[]>}
   */
  async compile(nonce) {
    const d = this.device, src = shaderSources(nonce), L = this.layouts, fmt = this.format;
    const times = [];
    const modules = {};
    for (const [name, code] of Object.entries(src)) {
      const t0 = performance.now();
      const m = d.createShaderModule({ label: name, code });
      const info = await m.getCompilationInfo();
      const errors = info.messages.filter((x) => x.type === 'error');
      if (errors.length) throw new Error(`WGSL ${name}: ${errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('; ')}`);
      modules[name] = m;
      times.push({ name: `module ${name}`, kind: 'module', ms: performance.now() - t0, bytes: code.length });
    }
    const layout = (...ls) => d.createPipelineLayout({ bindGroupLayouts: ls });
    const blendOver = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const depth = (compare, write, format = 'depth24plus') => ({ format, depthCompare: compare, depthWriteEnabled: write });
    const scene2 = [{ format: 'rgba16float' }, { format: 'r16float' }];
    const scene3 = [...scene2, { format: 'rg16float' }];
    const render = (label, lay, mod, vs, fs, targets, extra = {}) => ({
      label, layout: lay, vertex: { module: modules[mod], entryPoint: vs },
      ...(fs ? { fragment: { module: modules[mod], entryPoint: fs, targets } } : {}),
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' }, ...extra,
    });
    const compute = (label, entryPoint) => ({ label, layout: layout(L.light), compute: { module: modules.light, entryPoint } });
    const specs = [
      ['lightInit', 'compute', compute('light init', 'lightInit')],
      ['lightStep', 'compute', compute('light step', 'lightStep')],
      ['lightStore', 'compute', compute('light store', 'lightStore')],
      ['shadow', 'render', render('shadow', layout(L.shadow), 'shadow', 'vsShadow', null, null, {
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { ...depth('less', true, 'depth16unorm'), depthBias: 2, depthBiasSlopeScale: 2 },
      })],
      ['skyMsaa', 'render', render('sky, MSAA', layout(L.scene), 'scene', 'vsFull', 'fsSky', scene2,
        { depthStencil: depth('always', false), multisample: { count: SAMPLES }, primitive: { topology: 'triangle-list' } })],
      ['opaqueMsaa', 'render', render('opaque, MSAA', layout(L.scene), 'scene', 'vsFace', 'fsOpaque', scene2,
        { depthStencil: depth('less', true), multisample: { count: SAMPLES } })],
      ['translucent', 'render', render('translucent', layout(L.scene, L.trans), 'trans', 'vsFace', 'fsTrans', [{ format: 'rgba16float', blend: blendOver }])],
      ['tonemap', 'render', render('tone map', layout(L.tone), 'tone', 'vsFull', 'fsTone', [{ format: fmt }], { primitive: { topology: 'triangle-list' } })],
      ['skyTaau', 'render', render('sky, TAAU', layout(L.scene), 'scene', 'vsFull', 'fsSkyTaa', scene3,
        { depthStencil: depth('always', false), primitive: { topology: 'triangle-list' } })],
      ['opaqueTaau', 'render', render('opaque, TAAU', layout(L.scene), 'scene', 'vsFaceTaa', 'fsOpaqueTaa', scene3, { depthStencil: depth('less', true) })],
      ['resolve', 'render', render('TAAU resolve', layout(L.taa), 'taa', 'vsFull', 'fsResolve', [{ format: 'rgba16float' }, { format: fmt }],
        { primitive: { topology: 'triangle-list' } })],
    ];
    this.pipelines = {};
    for (const [name, kind, desc] of specs) {
      d.pushErrorScope('validation');
      const t0 = performance.now();
      let p;
      try {
        p = kind === 'compute' ? await d.createComputePipelineAsync(desc) : await d.createRenderPipelineAsync(desc);
      } finally {
        const e = await d.popErrorScope();
        if (e) throw new Error(`pipeline ${name}: ${e.message}`);
      }
      times.push({ name, kind, ms: performance.now() - t0 });
      this.pipelines[name] = p;
    }
    return times;
  }

  /** Fills the light grid (16 iterations over every cell), timed. @returns {Promise<{ wallMs: number, gpuMs: number | null, dispatches: number }>} */
  async fillLight() {
    const d = this.device, [nx, ny, nz] = this.dims, cells = nx * ny * nz, P = this.pipelines;
    const params = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(params, 0, new Uint32Array([nx, ny, nz, 0]));
    d.queue.writeBuffer(params, 16, new Float32Array([-1, 0, 0, 0]));
    const bufs = [0, 1].map((i) => d.createBuffer({ label: `light ${i}`, size: cells * 4, usage: BU.STORAGE }));
    const group = (src, dst) => d.createBindGroup({
      layout: this.layouts.light, entries: [params, this.idVol.createView(), this.matsBuf, this.heightsBuf, src, dst, this.light.createView()]
        .map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
    });
    const g01 = group(bufs[0], bufs[1]), g10 = group(bufs[1], bufs[0]);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass(this.querySet ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
    const wg = [Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4)];
    pass.setPipeline(P.lightInit); pass.setBindGroup(0, g10); pass.dispatchWorkgroups(...wg);   // writes bufs[0]
    let cur = 0;
    pass.setPipeline(P.lightStep);
    for (let i = 0; i < LIGHT_ITERS; i++) { pass.setBindGroup(0, cur ? g10 : g01); pass.dispatchWorkgroups(...wg); cur ^= 1; }
    pass.setPipeline(P.lightStore); pass.setBindGroup(0, cur ? g10 : g01); pass.dispatchWorkgroups(...wg);
    pass.end();
    const read = this.querySet ? this.resolveTimestamps(enc, 2) : null;
    const t0 = performance.now();
    d.queue.submit([enc.finish()]);
    await d.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - t0;
    const ts = read ? await read : null;
    bufs.forEach((b) => b.destroy());
    params.destroy();
    return { wallMs, gpuMs: ts ? ts.passes[0] : null, dispatches: LIGHT_ITERS + 2 };
  }

  // resolve this frame's queries into a free readback buffer; resolves to { passes: ms[], span: ms, raw: ns[] } or null
  resolveTimestamps(enc, count = 8) {
    const rb = this.readbacks.find((r) => !r.busy);
    if (!rb) return Promise.resolve(null);
    rb.busy = true;
    enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuf, 0);
    enc.copyBufferToBuffer(this.resolveBuf, 0, rb.buf, 0, count * 8);
    return (async () => {
      await new Promise((r) => setTimeout(r, 0));   // after the submit
      try {
        await rb.buf.mapAsync(GPUMapMode.READ, 0, count * 8);
        const t = new BigUint64Array(rb.buf.getMappedRange(0, count * 8).slice(0));
        rb.buf.unmap();
        const passes = [];
        for (let p = 0; p < count / 2; p++) passes.push(Number(t[2 * p + 1] - t[2 * p]) / 1e6);
        return { passes, span: Number(t[count - 1] - t[0]) / 1e6, raw: [...t].map((x) => Number(x - t[0])) };
      } catch {
        return null;
      } finally {
        rb.busy = false;
      }
    })();
  }

  sunMatrix() {
    const [nx, ny, nz] = this.dims, az = SUN.az * Math.PI / 180, el = SUN.el * Math.PI / 180;
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const c = [nx / 2, ny / 2, nz / 2], R = Math.hypot(nx, ny, nz) / 2 + 2;
    const view = lookAt([c[0] + dir[0] * (R + 8), c[1] + dir[1] * (R + 8), c[2] + dir[2] * (R + 8)], c, [0, 1, 0]);
    return { dir, viewProj: mul(ortho(-R, R, -R, R, 0, 2 * R + 16), view) };
  }

  /** The camera of frame `i` on the fixed orbit: the default god view, circling once every 720 frames, dollying and bobbing. */
  camera(i, aspect) {
    const [nx, ny, nz] = this.dims, u = nx / 10, tau = 2 * Math.PI;
    const target = [nx / 2, ny * CAM.target, nz / 2];
    const R = Math.hypot(CAM.offset[0], CAM.offset[2]) * u, H = CAM.offset[1] * u;
    const a = Math.atan2(CAM.offset[2], CAM.offset[0]) + tau * i / 720;
    const dolly = 1 - 0.25 * (0.5 - 0.5 * Math.cos(tau * i / 900));
    const eye = [target[0] + Math.cos(a) * R * dolly, target[1] + H * dolly * (1 + 0.15 * Math.sin(tau * i / 600)), target[2] + Math.sin(a) * R * dolly];
    const viewProj = mul(perspective(CAM.fov * Math.PI / 180, aspect, 0.5, 4000), lookAt(eye, target, [0, 1, 0]));
    return { eye, viewProj };
  }

  /**
   * (Re)creates the render targets for `variant` at an output of w × h.
   * transient: the MSAA attachments get GPUTextureUsage.TRANSIENT_ATTACHMENT.
   * @returns {{ bytes: number, msaaBytes: number, internal: number[] }} what they allocate
   */
  setup(variant, w, h, transient = false) {
    this.release();
    const d = this.device;
    const all = [];
    const tex = (label, size, format, usage, sampleCount = 1) => {
      const t = d.createTexture({ label, size, format, usage, sampleCount });
      const bpp = { rgba16float: 8, r16float: 2, rg16float: 4, depth24plus: 4 }[format] ?? 4;
      all.push({ t, bytes: size[0] * size[1] * bpp * sampleCount, ms: sampleCount > 1, transient: Boolean(usage & this.transientUsage) });
      return t;
    };
    const RA = TU.RENDER_ATTACHMENT, SAMPLED = RA | TU.TEXTURE_BINDING;
    const T = { variant, w, h, transient };
    if (variant === 'msaa') {
      const ms = RA | (transient ? this.transientUsage : 0);
      T.msColor = tex('MSAA colour', [w, h], 'rgba16float', ms, SAMPLES);
      T.msDepthLin = tex('MSAA linear depth', [w, h], 'r16float', ms, SAMPLES);
      T.msDepth = tex('MSAA depth', [w, h], 'depth24plus', ms, SAMPLES);
      T.color = tex('resolved colour', [w, h], 'rgba16float', SAMPLED);
      T.depthLin = tex('resolved linear depth', [w, h], 'r16float', SAMPLED);
      T.trans = tex('translucent layer', [w, h], 'rgba16float', SAMPLED);
      T.internal = [w, h];
    } else {
      const lw = Math.max(1, Math.round(w * TAAU_SCALE)), lh = Math.max(1, Math.round(h * TAAU_SCALE));
      T.color = tex('colour (⅔)', [lw, lh], 'rgba16float', SAMPLED);
      T.depthLin = tex('linear depth (⅔)', [lw, lh], 'r16float', SAMPLED);
      T.motion = tex('motion (⅔)', [lw, lh], 'rg16float', SAMPLED);
      T.depth = tex('depth (⅔)', [lw, lh], 'depth24plus', RA);
      T.trans = tex('translucent layer (⅔)', [lw, lh], 'rgba16float', SAMPLED);
      T.history = [0, 1].map((k) => tex(`history ${k}`, [w, h], 'rgba16float', SAMPLED));
      T.internal = [lw, lh];
    }
    T.all = all;
    const L = this.layouts, v = (t) => t.createView();
    const group = (layout, resources) => d.createBindGroup({
      layout, entries: resources.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
    });
    const sceneFrame = variant === 'msaa' ? this.frameHi : this.frameLo;
    const sceneRes = (faces) => [sceneFrame, faces, this.matsBuf, v(this.patterns), this.patSampler, v(this.shadow), this.shadowCmp, v(this.light), this.linSampler];
    T.shadowBG = group(L.shadow, [this.frameHi, this.opaqueBuf]);
    T.opaqueBG = group(L.scene, sceneRes(this.opaqueBuf));
    T.transBG = group(L.scene, sceneRes(this.transBuf));
    T.transInBG = group(L.trans, [v(T.color), v(T.depthLin), v(this.idVol)]);
    if (variant === 'msaa') T.toneBG = group(L.tone, [this.frameHi, v(T.color), v(T.trans)]);
    else T.resolveBG = [0, 1].map((k) => group(L.taa, [this.frameHi, v(T.color), v(T.trans), v(T.motion), v(T.history[k]), this.linSampler]));
    T.views = Object.fromEntries(Object.entries(T).filter(([, x]) => x instanceof GPUTexture).map(([k, x]) => [k, v(x)]));
    if (T.history) T.historyViews = T.history.map(v);
    this.targets = T;
    this.prevViewProj = null;
    return {
      bytes: all.reduce((s, x) => s + x.bytes, 0),
      msaaBytes: all.filter((x) => x.ms).reduce((s, x) => s + x.bytes, 0),
      transientBytes: all.filter((x) => x.transient).reduce((s, x) => s + x.bytes, 0),
      internal: T.internal,
    };
  }

  release() {
    for (const x of this.targets?.all ?? []) x.t.destroy();
    this.targets = null;
  }

  // Frame i's uniforms into `buf` for a target of w × h.
  writeFrame(buf, i, w, h, jitter, cam, first) {
    const f = this.frameData, [nx, ny, nz] = this.dims;
    let vp = cam.viewProj;
    if (jitter) {
      vp = new Float32Array(vp);
      for (let c = 0; c < 4; c++) { vp[c * 4] += jitter[0] * vp[c * 4 + 3]; vp[c * 4 + 1] += jitter[1] * vp[c * 4 + 3]; }
    }
    f.set(vp, 0);
    f.set(cam.viewProj, 16);
    f.set(this.prevViewProj ?? cam.viewProj, 32);
    f.set(invert(vp), 48);
    f.set(this.sun.viewProj, 64);
    f.set([...cam.eye, i / 60], 80);
    f.set([...this.sun.dir, 1], 84);
    f.set([w, h, 1 / w, 1 / h], 88);
    f.set([jitter?.[0] ?? 0, jitter?.[1] ?? 0, 0, 0], 92);
    f.set([nx, ny, nz, -1], 96);
    f.set([EXPOSURE, first ? 1 : TAA_BLEND, this.grassLayer, FOG], 100);
    this.device.queue.writeBuffer(buf, 0, f);
  }

  /**
   * Encodes and submits frame `i` of the current variant into the canvas.
   * @returns {{ cpuMs: number, submitAt: number, done: Promise<number>, gpu: Promise<object | null> }}
   *   done: when onSubmittedWorkDone resolved (performance.now()); gpu: the passes' timestamps
   */
  frame(i, first) {
    const t0 = performance.now();
    const d = this.device, T = this.targets, P = this.pipelines, V = T.views, { w, h } = T;
    const cam = this.camera(i, w / h);
    let jitter = null;
    if (T.variant === 'taau') {
      const [lw, lh] = T.internal, k = (i % 8) + 1;
      jitter = [(2 * halton(k, 2) - 1) / lw, (2 * halton(k, 3) - 1) / lh];
      this.writeFrame(this.frameLo, i, lw, lh, jitter, cam, first);
    }
    this.writeFrame(this.frameHi, i, w, h, jitter, cam, first);
    this.prevViewProj = cam.viewProj;
    const ts = (p) => (this.querySet ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 2 * p, endOfPassWriteIndex: 2 * p + 1 } } : {});
    const enc = d.createCommandEncoder();
    // 1. the sun's shadow map (v2 redraws it at ≤ 30 Hz and only on change; here every frame, so its cost shows)
    let pass = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: this.shadowView ??= this.shadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...ts(0),
    });
    pass.setPipeline(P.shadow);
    pass.setBindGroup(0, T.shadowBG);
    pass.draw(6 * this.nOpaque);
    pass.end();
    // 2. the opaque pass: sky and ground, then the faces
    const clear0 = { loadOp: 'clear', clearValue: [0, 0, 0, 1] }, clearFar = { loadOp: 'clear', clearValue: [FAR, 0, 0, 0] };
    if (T.variant === 'msaa') {
      pass = enc.beginRenderPass({
        colorAttachments: [
          { view: V.msColor, resolveTarget: V.color, storeOp: 'discard', ...clear0 },
          { view: V.msDepthLin, resolveTarget: V.depthLin, storeOp: 'discard', ...clearFar },
        ],
        depthStencilAttachment: { view: V.msDepth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        ...ts(1),
      });
      pass.setBindGroup(0, T.opaqueBG);
      pass.setPipeline(P.skyMsaa);
      pass.draw(3);
      pass.setPipeline(P.opaqueMsaa);
      pass.draw(6 * this.nOpaque);
    } else {
      pass = enc.beginRenderPass({
        colorAttachments: [
          { view: V.color, storeOp: 'store', ...clear0 },
          { view: V.depthLin, storeOp: 'store', ...clearFar },
          { view: V.motion, storeOp: 'store', loadOp: 'clear', clearValue: [0, 0, 0, 0] },
        ],
        depthStencilAttachment: { view: V.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        ...ts(1),
      });
      pass.setBindGroup(0, T.opaqueBG);
      pass.setPipeline(P.skyTaau);
      pass.draw(3);
      pass.setPipeline(P.opaqueTaau);
      pass.draw(6 * this.nOpaque);
    }
    pass.end();
    // 3. the translucent pass at 1× over the resolved colour and depth
    pass = enc.beginRenderPass({ colorAttachments: [{ view: V.trans, storeOp: 'store', loadOp: 'clear', clearValue: [0, 0, 0, 0] }], ...ts(2) });
    if (this.nTrans) {
      pass.setPipeline(P.translucent);
      pass.setBindGroup(0, T.transBG);
      pass.setBindGroup(1, T.transInBG);
      pass.draw(6 * this.nTrans);
    }
    pass.end();
    // 4. to the canvas: the tone map, or TAAU's resolve with the same tone map
    const canvas = this.context.getCurrentTexture().createView();
    if (T.variant === 'msaa') {
      pass = enc.beginRenderPass({ colorAttachments: [{ view: canvas, storeOp: 'store', ...clear0 }], ...ts(3) });
      pass.setPipeline(P.tonemap);
      pass.setBindGroup(0, T.toneBG);
    } else {
      const k = i & 1;   // reads history k, writes the other
      pass = enc.beginRenderPass({
        colorAttachments: [{ view: T.historyViews[k ^ 1], storeOp: 'store', ...clear0 }, { view: canvas, storeOp: 'store', ...clear0 }],
        ...ts(3),
      });
      pass.setPipeline(P.resolve);
      pass.setBindGroup(0, T.resolveBG[k]);
    }
    pass.draw(3);
    pass.end();
    const gpu = this.querySet ? this.resolveTimestamps(enc) : Promise.resolve(null);
    d.queue.submit([enc.finish()]);
    const submitAt = performance.now();
    const done = d.queue.onSubmittedWorkDone().then(() => performance.now());
    return { cpuMs: submitAt - t0, submitAt, done, gpu };
  }

  destroy() {
    this.release();
    for (const x of [this.opaqueBuf, this.transBuf, this.matsBuf, this.heightsBuf, this.patterns, this.idVol, this.light, this.shadow,
      this.frameHi, this.frameLo, this.resolveBuf, ...(this.readbacks ?? []).map((r) => r.buf)]) x?.destroy();
    this.querySet?.destroy();
  }
}

