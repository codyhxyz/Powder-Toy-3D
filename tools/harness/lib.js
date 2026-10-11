// tools/lib-check.mjs's page: builds and runs the render library's kernels
// on this page's device (our requested limits: 8 storage buffers, 4 storage
// textures, 16 sampled textures per stage). Everything is generated in Node;
// the page makes the resources a job's layout names, with the job's data in
// them, dispatches (or draws) once and reads back the buffers marked `read`.
// Raw device calls, not gpu.kernel: a failure is a result to report.
//
// A job: { label, code, kind: 'compute' | 'render', entry, groups, dispatch,
// budgetMs }. groups: per bind group, layout entries (GPUBindGroupLayoutEntry)
// carrying what to bind:
//   buffer          data (base64) or size (bytes, zeros); read: copy it back
//   texture         tex: { format, size: [w, h, d], data (base64) }; else a
//                   1×1(×1) zero texture of a format its sample type takes
//   storageTexture  a 1×1(×1) texture of its format
//   sampler         samp: { address: 'clamp-to-edge' | 'repeat' } (linear filtering)
// Returns { ok, stage, error, messages, moduleMs, pipelineMs, outputs }, with
// outputs['group.binding'] in base64.

import { compilationInfo, withVisibility } from '/src/gpu/index.js';
import { boot, ready, test } from './harness.js';

const h = await boot({ label: 'lib-check' });
const device = h.gpu.device;

const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const pad4 = (n) => Math.ceil(n / 4) * 4;
const SAMPLED_FORMAT = { float: 'rgba16float', 'unfilterable-float': 'rgba32float', uint: 'rgba16uint', sint: 'rgba16sint', depth: 'depth32float' };
const TEXEL_BYTES = { rgba16float: 8, rgba32float: 16, r32float: 4, rgba16uint: 8, rgba8unorm: 4 };

function texture(dim, format, usage, size = dim === '3d' ? [1, 1, 1] : [1, 1], data = null) {
  const t = device.createTexture({ size, dimension: dim === '3d' ? '3d' : '2d', format, usage: usage | GPUTextureUsage.COPY_DST });
  if (data) {
    const bpr = size[0] * TEXEL_BYTES[format];
    device.queue.writeTexture({ texture: t }, fromB64(data), { bytesPerRow: bpr, rowsPerImage: size[1] }, size);
  }
  return t;
}

function resource(e, made) {
  if (e.buffer) {
    const data = e.data ? fromB64(e.data) : null;
    const size = Math.max(16, pad4(data ? data.byteLength : e.size ?? 256));
    const buffer = device.createBuffer({ label: `binding ${e.binding}`, size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    if (data) {
      const padded = new Uint8Array(pad4(data.byteLength));
      padded.set(data);
      device.queue.writeBuffer(buffer, 0, padded);
    }
    made.push(buffer);
    return { resource: { buffer }, buffer };
  }
  if (e.texture) {
    const dim = e.texture.viewDimension ?? '2d';
    const t = e.tex
      ? texture(dim, e.tex.format, GPUTextureUsage.TEXTURE_BINDING, e.tex.size, e.tex.data)
      : texture(dim, SAMPLED_FORMAT[e.texture.sampleType ?? 'float'], GPUTextureUsage.TEXTURE_BINDING);
    made.push(t);
    return { resource: t.createView({ dimension: dim }) };
  }
  if (e.storageTexture) {
    const dim = e.storageTexture.viewDimension ?? '2d';
    const t = texture(dim, e.storageTexture.format, GPUTextureUsage.STORAGE_BINDING);
    made.push(t);
    return { resource: t.createView({ dimension: dim }) };
  }
  if (e.sampler) {
    const address = e.samp?.address ?? 'clamp-to-edge';
    return { resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: address, addressModeV: address, addressModeW: address }) };
  }
  throw new Error(`binding ${e.binding}: no resource type`);
}
const layoutEntry = ({ binding, visibility, buffer, texture: t, storageTexture, sampler }) =>
  withVisibility({ binding, visibility, ...(buffer && { buffer }), ...(t && { texture: t }), ...(storageTexture && { storageTexture }), ...(sampler && { sampler }) });
const messages = (info) => info.messages.map((m) => ({ type: m.type, line: m.lineNum, col: m.linePos, text: m.message }));

test('run', async (job) => {
  const out = { ok: false, stage: 'module', error: null, messages: [], moduleMs: 0, pipelineMs: 0, outputs: {} };
  const made = [];
  device.pushErrorScope('validation');
  try {
    const t0 = performance.now();
    const module = device.createShaderModule({ label: job.label, code: job.code });
    out.messages = messages(await compilationInfo(module));
    out.moduleMs = performance.now() - t0;
    if (out.messages.some((m) => m.type === 'error')) throw new Error('compile errors');
    out.stage = 'pipeline';
    const layouts = job.groups.map((entries, i) => device.createBindGroupLayout({ label: `${job.label} g${i}`, entries: entries.map(layoutEntry) }));
    const layout = device.createPipelineLayout({ label: job.label, bindGroupLayouts: layouts });
    const t1 = performance.now();
    const pending = job.kind === 'render'
      ? device.createRenderPipelineAsync({
        label: job.label, layout,
        vertex: { module, entryPoint: job.vertex ?? 'vs' },
        fragment: { module, entryPoint: job.fragment ?? 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      })
      : device.createComputePipelineAsync({ label: job.label, layout, compute: { module, entryPoint: job.entry ?? 'main' } });
    let timer;
    const pipeline = await Promise.race([pending, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`pipeline over ${job.budgetMs} ms`)), job.budgetMs ?? 30000); })]);
    clearTimeout(timer);
    out.pipelineMs = performance.now() - t1;
    out.stage = 'bind';
    const groups = job.groups.map((entries, gi) => {
      const res = entries.map((e) => ({ e, ...resource(e, made) }));
      const group = device.createBindGroup({ label: `${job.label} g${gi}`, layout: layouts[gi], entries: res.map(({ e, resource: r }) => ({ binding: e.binding, resource: r })) });
      return { group, dynamic: res.filter(({ e }) => e.buffer?.hasDynamicOffset).map(() => 0), res };
    });
    out.stage = 'run';
    const enc = device.createCommandEncoder({ label: job.label });
    if (job.kind === 'render') {
      const target = device.createTexture({ size: [4, 4], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      made.push(target);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline);
      groups.forEach(({ group, dynamic }, i) => pass.setBindGroup(i, group, dynamic));
      pass.draw(3);
      pass.end();
    } else {
      const pass = enc.beginComputePass({ label: job.label });
      pass.setPipeline(pipeline);
      groups.forEach(({ group, dynamic }, i) => pass.setBindGroup(i, group, dynamic));
      pass.dispatchWorkgroups(...(job.dispatch ?? [1, 1, 1]));
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
    const err = await device.popErrorScope();
    if (err) { out.ok = false; out.error = `${out.error ? `${out.error}; ` : ''}${err.message}`; }
    for (const r of made) r.destroy?.();
    if (h.gpu.lost) { out.ok = false; out.error = `device lost: ${h.failures.at(-1) ?? ''}`; }
  }
  return out;
});

test('info', () => ({ ...h.gpu.adapterInfo }));

ready();
