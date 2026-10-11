// The one WebGPU device everything draws and simulates on (docs/webgpu.md B2, W1).
//
//   const probe = await probeWebGPU();               // { ok, reason, message, adapter }; no device yet
//   const gpu = await createGpu({ adapter: probe.adapter, label: 'tpt3d' });
//
// Nothing here touches navigator.gpu at import time: Node tools import the
// shader generators, and some of those import this module's constants.
//
// Limits: only the spec defaults are required, so every WebGPU device
// qualifies. The storage binding and buffer size are requested up to the
// adapter's (at most 1 GiB): they decide which grids fit (gpu.fits). Every
// other limit is requested at the spec default on purpose, so a kernel that
// would need more fails here, on SwiftShader's 10 storage buffers, and not
// on a user's 8-buffer device.

import { GraphicsFailure, deviceLostMessage, gpuErrorMessage } from './errors.js';
import { GpuFrame } from './frame.js';
import { ParamRing, Header, SharedUniforms } from './params.js';
import { PipelineCache, Kernel, RenderPipe, withVisibility } from './kernels.js';
import { Readback, TEXEL } from './readback.js';
import { GpuTiming } from './timing.js';

const GiB = 1024 * 1024 * 1024, MiB = 1024 * 1024;

/** The spec defaults we request explicitly (B2). Raise one only with a decision in docs/webgpu.md. */
export const DEFAULT_LIMITS = Object.freeze({
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxBindGroups: 4,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupsPerDimension: 65535,
  maxColorAttachmentBytesPerSample: 32,
});
/** Optional features requested when the adapter has them (B2). Nothing else in v1 (W3). */
export const OPTIONAL_FEATURES = Object.freeze(['timestamp-query']);
/** Frames a GPU-bound loop may queue (B3): 2, and 1 on WebKit. */
export const MAX_FRAMES_IN_FLIGHT = 2;

/**
 * The limits createGpu requests from `adapter`.
 * @param {GPUAdapter} adapter
 * @returns {Record<string, number>}
 */
export function wantedLimits(adapter) {
  const a = adapter.limits;
  return {
    ...DEFAULT_LIMITS,
    maxStorageBufferBindingSize: Math.min(a.maxStorageBufferBindingSize, GiB),
    maxBufferSize: Math.min(a.maxBufferSize, GiB),
  };
}

const params = () => new URLSearchParams(globalThis.location?.search ?? '');

/** The page's test mode (`?test=` or __TPT_TEST_MODE__), or null. */
export function testModeOf() {
  return params().get('test') || globalThis.__TPT_TEST_MODE__ || null;
}

/** Safari: no navigator.userAgentData, AppleWebKit without Chrome/ (B2). */
export function isWebKit() {
  const nav = globalThis.navigator;
  if (!nav || nav.userAgentData) return false;
  return /AppleWebKit/.test(nav.userAgent) && !/Chrome\//.test(nav.userAgent);
}

/**
 * Asks for an adapter (no device yet). Fails when navigator.gpu is missing,
 * the adapter is null, or it is a fallback (software) adapter the page may
 * not use: those are accepted only in test mode, under the Vite dev server,
 * or with ?software=1, so a user whose GPU is blocklisted for WebGPU gets the
 * WebGL2 build on their GPU instead of a CPU rasterizer. ?gpu=high asks for
 * 'high-performance'; otherwise there is no powerPreference and the browser
 * picks by power source.
 * @param {{ allowFallback?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, reason: string | null, message: string, adapter: GPUAdapter | null }>}
 *   reason: null, 'no-webgpu', 'insecure', 'no-adapter', 'fallback-adapter' or 'adapter-error'
 */
export async function probeWebGPU({ allowFallback } = {}) {
  const q = params();
  allowFallback ??= Boolean(testModeOf() || import.meta.env?.DEV || q.get('software') === '1');
  const fail = (reason, message, adapter = null) => ({ ok: false, reason, message, adapter });
  if (!globalThis.navigator?.gpu) {
    if (globalThis.isSecureContext === false) return fail('insecure', 'WebGPU needs a secure origin: use https or localhost.');
    return fail('no-webgpu', 'This browser has no WebGPU.');
  }
  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter(q.get('gpu') === 'high' ? { powerPreference: 'high-performance' } : {});
  } catch (e) {
    return fail('adapter-error', `The browser refused a WebGPU adapter: ${e.message}`);
  }
  if (!adapter) return fail('no-adapter', 'The browser has WebGPU but offered no adapter for this GPU.');
  const info = adapter.info ?? {};
  if ((info.isFallbackAdapter ?? adapter.isFallbackAdapter) && !allowFallback) {
    return fail('fallback-adapter', 'The only WebGPU adapter is a software one (add ?software=1 to use it anyway).', adapter);
  }
  return { ok: true, reason: null, message: '', adapter };
}

/**
 * Creates the device and the gpu object every module records through. Throws
 * when there is no usable adapter or requestDevice rejects.
 * @param {{ adapter?: GPUAdapter, label?: string, debug?: boolean, testMode?: string | null }} [opts]
 *   debug: ?gpudebug=1 (a command per flush, inside an error scope)
 * @returns {Promise<Gpu>}
 */
export async function createGpu({ adapter, label = 'tpt3d', debug, testMode } = {}) {
  if (!adapter) {
    const probe = await probeWebGPU();
    if (!probe.ok) throw new Error(probe.message);
    adapter = probe.adapter;
  }
  const requiredFeatures = OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ label, requiredFeatures, requiredLimits: wantedLimits(adapter) });
  return new Gpu(adapter, device, {
    label,
    debug: debug ?? params().get('gpudebug') === '1',
    testMode: testMode === undefined ? testModeOf() : testMode,
  });
}

/**
 * The device and everything recorded on it: the frame, pipelines, layouts,
 * the params ring, readback, timing, stats and failure routing. Made by
 * createGpu; reached as __app.gpu by tools.
 */
export class Gpu {
  /**
   * @param {GPUAdapter} adapter
   * @param {GPUDevice} device
   * @param {{ label?: string, debug?: boolean, testMode?: string | null }} [opts]
   */
  constructor(adapter, device, { label = 'tpt3d', debug = false, testMode = null } = {}) {
    this.adapter = adapter;
    this.device = device;
    this.queue = device.queue;
    this.label = label;
    const info = adapter.info ?? {};
    /** vendor, architecture, device, description, isFallbackAdapter (tools print it) */
    this.adapterInfo = {
      vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '',
      description: info.description ?? '', isFallbackAdapter: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
    };
    this.features = device.features;
    this.limits = device.limits;
    this.isWebKit = isWebKit();
    this.testMode = testMode;
    this.debug = debug;
    /** a tick is not due while inFlight reaches this (B3) */
    this.maxFramesInFlight = this.isWebKit ? 1 : MAX_FRAMES_IN_FLIGHT;
    /** frames submitted whose work the queue hasn't finished */
    this.inFlight = 0;
    /** endFrame calls so far */
    this.frameNo = 0;
    /**
     * counters tools read (B3); `dispatches` counts each indirect dispatch
     * twice; `submits` counts three's too, `flushes` only ours, `writeFlushes`
     * those forced by a write (gpu.write's ordering, a FrameUniforms write)
     */
    this.stats = {
      submits: 0, computePasses: 0, renderPasses: 0, dispatches: 0, indirectDispatches: 0, draws: 0,
      workgroupsDirect: 0, pipelinesCreated: 0, pipelinesPending: 0, bytesAllocated: 0, bytesReadBack: 0, bytesUploaded: 0,
      flushes: 0, writeFlushes: 0,
    };
    /** test mode: every indirect dispatch's { kernel, buffer, offset }, for tools/budget-check.mjs */
    this.indirectLog = testMode ? [] : null;
    /** the GraphicsFailure once graphics have stopped */
    this.failure = null;
    /** whether the device is lost */
    this.lost = false;
    this._listeners = [];
    this._destroyed = false;
    this._resources = new Map();

    // Count every submit, three's included: they share this queue.
    const submit = this.queue.submit.bind(this.queue);
    this.queue.submit = (buffers) => { this.stats.submits++; return submit(buffers); };

    device.lost.then((lost) => {
      this.lost = true;
      if (!this._destroyed) this.fail(new GraphicsFailure(deviceLostMessage(lost)));
    });
    // A listener, not onuncapturederror: three's backend assigns that (B9).
    device.addEventListener('uncapturederror', (e) => this.fail(new GraphicsFailure(gpuErrorMessage(e.error), { cause: e.error })));

    /** @type {Record<string, GPUBindGroupLayout>} named layouts (C4), L.PARAMS and L.EMPTY built in */
    this.L = {};
    this._layoutEntries = new Map();
    this.pipelines = new PipelineCache(this);
    this.paramRing = new ParamRing(device, { label: `${label} params ring` });
    this._paramsGroups = new Map();
    this._groupReads = new WeakMap();
    // test and dev builds: groups bound where a layout has a plain uniform
    // buffer (FrameUniforms' kind) must come from gpu.bindGroup (_checkGroup)
    this._checkGroups = Boolean(testMode || debug || import.meta.env?.DEV);
    this._ourGroups = new WeakSet();
    this._uniformLayouts = new WeakSet();
    this._warnedGroups = new WeakSet();
    this.layout('EMPTY', []);
    this.layout('PARAMS', [
      { binding: 0, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ]);
    /** the bind group of L.EMPTY */
    this.emptyGroup = device.createBindGroup({ label: 'empty', layout: this.L.EMPTY, entries: [] });
    /** the header of a dispatch that reads no state */
    this.nullHeader = Object.freeze({ origin: [0, 0, 0], src: 0, dst: 0 });
    /** FrameUniforms (F6): a SharedUniforms set by the render setup (gpu.uniforms), null until then */
    this.frameUniforms = null;
    /** { renderer, prepare } once src/gpu/three.js has made the mesh renderer */
    this.three = null;
    this._frame = new GpuFrame(this);
    this.readback = new Readback(this);
    this.timing = new GpuTiming(this);
  }

  /**
   * The open frame (B3). Throws the GraphicsFailure once graphics have
   * stopped, so every state-mutating entry point throws as today.
   * @returns {GpuFrame}
   */
  get frame() {
    if (this.failure) throw this.failure;
    return this._frame;
  }

  _frameOrThrow() { return this.frame; }

  /**
   * Finishes and submits the open encoder, if any (B3).
   * @param {string} [reason]
   * @returns {boolean} whether anything was submitted
   */
  flush(reason) { return this._frame.flush(reason); }

  /** Flushes and counts the frame in flight until the queue finishes it (B3). */
  endFrame() { this._frame.endFrame(); }

  /**
   * The real fence (B8): flushes, then resolves when the queue has finished
   * everything submitted so far.
   * @returns {Promise<void>}
   */
  fence() {
    this._frame.flush('fence');
    return this.queue.onSubmittedWorkDone();
  }

  /**
   * Whether a grid's state fits this device: both copies of A
   * (2 · SLOTS · 16 bytes) within maxStorageBufferBindingSize and maxBufferSize.
   * @param {{ nx: number, ny: number, nz: number, slots?: number }} g
   */
  fits(g) { return this.fitsReason(g) === null; }

  /**
   * Why a grid doesn't fit, as the menus show it, or null when it does.
   * @param {{ nx: number, ny: number, nz: number, slots?: number }} g
   * @returns {string | null}
   */
  fitsReason(g) {
    const bytes = 2 * (g.slots ?? g.nx * g.ny * g.nz) * 16;
    const allowed = Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize);
    if (bytes <= allowed) return null;
    return `needs a ${Math.ceil(bytes / MiB)} MiB storage binding; this device allows ${Math.floor(allowed / MiB)} MiB`;
  }

  /**
   * A named bind group layout (C4), made once: gpu.L[name]. Entries are
   * GPUBindGroupLayoutEntry objects; a missing visibility defaults to compute
   * and fragment, plus vertex where WebGPU allows it (withVisibility).
   * Asking again with other entries throws.
   * @param {string} name
   * @param {GPUBindGroupLayoutEntry[]} entries
   * @returns {GPUBindGroupLayout}
   */
  layout(name, entries) {
    const full = entries.map(withVisibility);
    const key = JSON.stringify(full);
    const had = this._layoutEntries.get(name);
    if (had !== undefined) {
      if (had !== key) throw new Error(`layout ${name} already exists with other entries`);
      return this.L[name];
    }
    this._layoutEntries.set(name, key);
    const layout = (this.L[name] = this.device.createBindGroupLayout({ label: name, entries: full }));
    if (full.some((e) => e.buffer && (e.buffer.type ?? 'uniform') === 'uniform' && !e.buffer.hasDynamicOffset)) this._uniformLayouts.add(layout);
    return layout;
  }

  /**
   * A bind group (made once per grid or resize, never per frame: B6). Use
   * this rather than device.createBindGroup so the frame knows which commands
   * read shared uniforms such as FrameUniforms (test and dev builds warn
   * when a group made otherwise is bound where a layout has a uniform buffer).
   * @param {GPUBindGroupLayout} layout
   * @param {GPUBindGroupEntry[]} entries
   * @param {string} [label]
   * @returns {GPUBindGroup}
   */
  bindGroup(layout, entries, label) {
    const group = this.device.createBindGroup({ label: label ?? layout.label, layout, entries });
    const reads = [];
    for (const e of entries) {
      const buffer = e.resource?.buffer ?? e.resource;
      const u = buffer && this._uniformsOf?.get(buffer);
      if (u) reads.push(u);
    }
    if (reads.length) this._groupReads.set(group, reads);
    this._ourGroups.add(group);
    return group;
  }

  // Test and dev builds, at each bind: a group made with device.createBindGroup
  // where the layout has a uniform buffer hides from the FrameUniforms flush
  // rule (B3) what it reads. Warns once per group.
  _checkGroup(pipe, index, group) {
    if (this._ourGroups.has(group) || group === this.emptyGroup || this._warnedGroups.has(group)) return;
    if (!this._uniformLayouts.has(pipe.groups[index])) return;
    this._warnedGroups.add(group);
    console.warn(`gpu: ${pipe.name} binds "${group.label}" at group ${index}, made outside gpu.bindGroup: a FrameUniforms write can't see that it reads one`);
  }

  /**
   * A uniform buffer several commands read (FrameUniforms): writes flush
   * first when the open frame already reads it (B3).
   * @param {object} struct a uniformStruct
   * @param {string} [label]
   * @returns {SharedUniforms}
   */
  uniforms(struct, label) {
    const u = new SharedUniforms(this, struct, label);
    (this._uniformsOf ??= new WeakMap()).set(u.buffer, u);
    return u;
  }

  /**
   * A compute pipeline of ours (B5).
   * @param {ConstructorParameters<typeof Kernel>[1]} desc
   * @returns {Kernel}
   */
  kernel(desc) { return new Kernel(this, desc); }

  /**
   * A render pipeline of ours (B5).
   * @param {ConstructorParameters<typeof RenderPipe>[1]} desc
   * @returns {RenderPipe}
   */
  renderPipeline(desc) { return new RenderPipe(this, desc); }

  /** Resolves when every pipeline build started or queued so far has settled. */
  settled() { return this.pipelines.settled(); }

  /**
   * Test mode: the workgroups the indirect dispatches in indirectLog (from
   * index `from`) ran, their args read back now. Call it right after the
   * frame being measured, before a later build rewrites the args; the args
   * buffers need COPY_SRC.
   * @param {number} [from]
   * @returns {Promise<number>}
   */
  async indirectWorkgroups(from = 0) {
    const reads = (this.indirectLog ?? []).slice(from).map((e) => this.readback.buffer(e.buffer, e.offset, 12));
    let n = 0;
    for (const bytes of await Promise.all(reads)) {
      const [x, y, z] = new Uint32Array(bytes);
      n += x * y * z;
    }
    return n;
  }

  // the params group (L.PARAMS) whose binding 1 is `bytes` long
  _paramsGroup(bytes) {
    let g = this._paramsGroups.get(bytes);
    if (!g) {
      const buffer = this.paramRing.buffer;
      g = this.device.createBindGroup({
        label: `params ${bytes}`, layout: this.L.PARAMS,
        entries: [
          { binding: 0, resource: { buffer, offset: 0, size: Header.size } },
          { binding: 1, resource: { buffer, offset: 0, size: bytes } },
        ],
      });
      this._paramsGroups.set(bytes, g);
    }
    return g;
  }

  /**
   * device.createBuffer, counted in stats.bytesAllocated and the memory
   * registry (the profiler's memory line); destroy() uncounts it.
   * @param {GPUBufferDescriptor} desc
   * @returns {GPUBuffer}
   */
  createBuffer(desc) {
    return this._track(this.device.createBuffer(desc), desc.size, 'buffer');
  }

  /**
   * device.createTexture, counted like createBuffer.
   * @param {GPUTextureDescriptor} desc
   * @returns {GPUTexture}
   */
  createTexture(desc) {
    const t = this.device.createTexture(desc);
    const bpp = TEXEL[desc.format]?.[0] ?? 4;
    const mips = desc.mipLevelCount ?? 1;
    return this._track(t, Math.ceil(t.width * t.height * t.depthOrArrayLayers * bpp * (desc.sampleCount ?? 1) * (mips > 1 ? 4 / 3 : 1)), 'texture');
  }

  _track(resource, bytes, kind) {
    this.stats.bytesAllocated += bytes;
    this._resources.set(resource, { kind, bytes, label: resource.label });
    const destroy = resource.destroy.bind(resource);
    resource.destroy = () => {
      if (this._resources.delete(resource)) this.stats.bytesAllocated -= bytes;
      destroy();
    };
    return resource;
  }

  /**
   * Live buffers and textures made through createBuffer/createTexture.
   * @returns {{ buffers: number, textures: number, bytes: number, byLabel: Record<string, number> }}
   */
  memory() {
    const out = { buffers: 0, textures: 0, bytes: 0, byLabel: {} };
    for (const r of this._resources.values()) {
      out[r.kind === 'buffer' ? 'buffers' : 'textures']++;
      out.bytes += r.bytes;
      out.byLabel[r.label || '(unlabelled)'] = (out.byLabel[r.label || '(unlabelled)'] ?? 0) + r.bytes;
    }
    return out;
  }

  /**
   * queue.writeBuffer in program order: a write lands before every command
   * not yet submitted, so by default the open frame is flushed first and
   * commands recorded before this call never see the new bytes. That flush
   * costs a submit (counted in stats.writeFlushes): pass `ordered: false`
   * when nothing recorded since the last flush reads the target.
   * @param {GPUBuffer} buffer
   * @param {number} offset
   * @param {BufferSource} data
   * @param {{ ordered?: boolean }} [opts]
   */
  write(buffer, offset, data, { ordered = true } = {}) {
    if (this.failure) throw this.failure;
    if (ordered && this._frame.flush('write')) this.stats.writeFlushes++;
    this.queue.writeBuffer(buffer, offset, data);
    this.stats.bytesUploaded += data.byteLength;
  }

  /**
   * Registers what runs when graphics stop (app.js's stopGraphics). Called at
   * once (in a microtask) if they already have. Returns an unsubscribe.
   * @param {(failure: GraphicsFailure) => void} fn
   * @returns {() => void}
   */
  onFailure(fn) {
    this._listeners.push(fn);
    if (this.failure) queueMicrotask(() => fn(this.failure));
    return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
  }

  /**
   * Stops graphics once: records the failure, rejects pending reads and calls
   * every onFailure listener. Idempotent: later calls return the first failure.
   * @param {unknown} error
   * @returns {GraphicsFailure}
   */
  fail(error) {
    if (this.failure) return this.failure;
    const failure = GraphicsFailure.from(error);
    this.failure = failure;
    this.readback._failAll(failure);
    for (const fn of this._listeners) {
      try { fn(failure); } catch (e) { console.error(e); }
    }
    return failure;
  }

  /** Test hook: loses the device (reason 'destroyed'), which stops graphics. No restore, as today. */
  lose() { this.device.destroy(); }

  /** Tears the device down without reporting a failure (a test page's cleanup). */
  destroy() {
    this._destroyed = true;
    this.device.destroy();
  }
}
