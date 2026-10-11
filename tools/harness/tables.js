// The WGSL lab (tools/harness/tables.html): a WebGPU device and three calls
// that Node scripts drive through page.evaluate (tools/tables-check.mjs,
// tools/elements-core-check.mjs). Everything it runs is generated in Node:
// the page only compiles, builds pipelines with explicit layouts, dispatches
// and reads back. Bytes cross as base64.
//   lab.info()          the adapter, its features and the device's limits
//   lab.compile(code)   createShaderModule + getCompilationInfo: the messages
//   lab.run(job)        build a pipeline from job.code with the layouts in
//                       job.groups, make every resource the layouts name (a
//                       buffer from job data or zeros, a 1×1(×1) texture, a
//                       sampler), dispatch or draw once (job.steps: several
//                       entry points dispatched in order on the same
//                       resources), read back the buffers marked read;
//                       returns { ok, stage, error, messages, pipelineMs, outputs }
// The device takes the spec's default limits (8 storage buffers, 4 storage
// textures per stage), as src/gpu/device.js asks for, so a layout over them
// fails here as it would on a user's device (docs/webgpu.md B2).
const status = document.getElementById('status');
const say = (s) => { status.textContent = s; };

const toB64 = (bytes) => {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
};
const fromB64 = (b64) => {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const pad4 = (n) => Math.ceil(n / 4) * 4;

let device = null, adapter = null;
const uncaptured = [];
let lost = null;

async function init() {
  if (!navigator.gpu) throw new Error(`no navigator.gpu (secure context: ${isSecureContext})`);
  adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  device = await adapter.requestDevice({ label: 'wgsl-lab' });
  device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
  device.lost.then((info) => { lost = `${info.reason}: ${info.message}`; });
}

const messagesOf = async (module) => (await module.getCompilationInfo()).messages.map((m) => ({
  type: m.type, line: m.lineNum, col: m.linePos, message: m.message,
}));

// A texture for a sampled-texture layout entry: a format its sample type accepts.
const SAMPLED_FORMAT = { float: 'rgba16float', 'unfilterable-float': 'rgba32float', uint: 'rgba16uint', sint: 'rgba16sint', depth: 'depth32float' };
function textureFor(dim, format, usage) {
  const size = dim === '3d' ? [1, 1, 1] : [1, 1];
  return device.createTexture({ size, dimension: dim === '3d' ? '3d' : '2d', format, usage });
}

function resourceFor(entry, made) {
  if (entry.buffer) {
    const data = entry.data ? fromB64(entry.data) : null;
    const size = Math.max(16, pad4(data ? data.byteLength : entry.size ?? 256));
    const buffer = device.createBuffer({
      label: entry.label ?? `binding ${entry.binding}`, size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    if (data) {
      const padded = new Uint8Array(pad4(data.byteLength));
      padded.set(data);
      device.queue.writeBuffer(buffer, 0, padded);
    }
    made.push(buffer);
    return { resource: { buffer }, buffer };
  }
  if (entry.texture) {
    const t = textureFor(entry.texture.viewDimension ?? '2d', SAMPLED_FORMAT[entry.texture.sampleType ?? 'float'], GPUTextureUsage.TEXTURE_BINDING);
    made.push(t);
    return { resource: t.createView({ dimension: entry.texture.viewDimension ?? '2d' }) };
  }
  if (entry.storageTexture) {
    const t = textureFor(entry.storageTexture.viewDimension ?? '2d', entry.storageTexture.format, GPUTextureUsage.STORAGE_BINDING);
    made.push(t);
    return { resource: t.createView({ dimension: entry.storageTexture.viewDimension ?? '2d' }) };
  }
  if (entry.sampler) return { resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) };
  throw new Error(`binding ${entry.binding}: no resource type`);
}
// The layout entry alone (no data, size, read or label).
const layoutEntry = ({ binding, visibility, buffer, texture, storageTexture, sampler }) =>
  ({ binding, visibility, ...(buffer && { buffer }), ...(texture && { texture }), ...(storageTexture && { storageTexture }), ...(sampler && { sampler }) });

async function run(job) {
  const out = { ok: false, stage: 'module', error: null, messages: [], pipelineMs: 0, outputs: {} };
  const made = [];
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  try {
    const module = device.createShaderModule({ label: job.label, code: job.code });
    out.messages = await messagesOf(module);
    if (out.messages.some((m) => m.type === 'error')) throw new Error('compile errors');
    out.stage = 'layout';
    const layouts = job.groups.map((entries, i) => device.createBindGroupLayout({ label: `${job.label} g${i}`, entries: entries.map(layoutEntry) }));
    const layout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    out.stage = 'pipeline';
    const t0 = performance.now();
    let pipeline;
    const steps = job.steps ?? [{ entry: job.entry ?? 'main', dispatch: job.dispatch }];
    if (job.render) {
      pipeline = await device.createRenderPipelineAsync({
        label: job.label, layout,
        vertex: { module, entryPoint: job.render.vertex },
        fragment: { module, entryPoint: job.render.fragment, targets: [{ format: job.render.format ?? 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      });
    } else {
      for (const step of steps) {
        step.pipeline = await device.createComputePipelineAsync({ label: `${job.label} ${step.entry}`, layout, compute: { module, entryPoint: step.entry } });
      }
    }
    out.pipelineMs = performance.now() - t0;
    if (!steps[0].dispatch && !job.render) { out.ok = true; return out; }
    out.stage = 'bind';
    const groups = job.groups.map((entries, gi) => {
      const res = entries.map((e) => ({ e, ...resourceFor(e, made) }));
      const group = device.createBindGroup({ layout: layouts[gi], entries: res.map(({ e, resource }) => ({ binding: e.binding, resource })) });
      const dynamic = res.filter(({ e }) => e.buffer?.hasDynamicOffset).map(() => 0);
      return { group, dynamic, res };
    });
    out.stage = 'dispatch';
    const enc = device.createCommandEncoder();
    if (job.render) {
      const target = device.createTexture({ size: [4, 4], format: job.render.format ?? 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      made.push(target);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline);
      groups.forEach(({ group, dynamic }, i) => pass.setBindGroup(i, group, dynamic));
      pass.draw(3);
      pass.end();
    } else {
      const pass = enc.beginComputePass();
      groups.forEach(({ group, dynamic }, i) => pass.setBindGroup(i, group, dynamic));
      for (const step of steps) {
        pass.setPipeline(step.pipeline);
        pass.dispatchWorkgroups(...step.dispatch);
      }
      pass.end();
    }
    const reads = [];
    groups.forEach(({ res }, gi) => res.forEach(({ e, buffer }) => {
      if (!e.read) return;
      const staging = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      made.push(staging);
      enc.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
      reads.push({ key: `${gi}.${e.binding}`, staging });
    }));
    device.queue.submit([enc.finish()]);
    for (const { key, staging } of reads) {
      await staging.mapAsync(GPUMapMode.READ);
      out.outputs[key] = toB64(new Uint8Array(staging.getMappedRange().slice(0)));
      staging.unmap();
    }
    out.ok = true;
  } catch (e) {
    out.error = String(e.message ?? e);
  } finally {
    const oom = await device.popErrorScope();
    const validation = await device.popErrorScope();
    for (const err of [validation, oom]) if (err) { out.ok = false; out.error = `${out.error ? `${out.error}; ` : ''}${err.message}`; }
    for (const r of made) r.destroy?.();
    if (lost) { out.ok = false; out.error = `device lost (${lost})`; }
  }
  return out;
}

window.lab = {
  ready: false,
  error: null,
  info: () => ({
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
    features: [...adapter.features],
    limits: Object.fromEntries(['maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxSampledTexturesPerShaderStage',
      'maxStorageBufferBindingSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension'].map((k) => [k, device.limits[k]])),
    uncaptured: [...uncaptured], lost,
  }),
  compile: async (code, label = 'module') => {
    const module = device.createShaderModule({ label, code });
    return messagesOf(module);
  },
  run,
};
init().then(() => { window.lab.ready = true; say('ready'); }, (e) => { window.lab.error = String(e.message ?? e); say(`failed: ${window.lab.error}`); });
