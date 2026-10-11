// The foundation check's page (tools/gpu-foundation-check.mjs, docs/webgpu.md
// I1 and U0's acceptance) and the foundation's budget scenarios
// (tools/budgets/foundation.mjs). Each test returns plain data; the tool
// asserts on it. Tests that stop graphics run on a gpu of their own.

import {
  probeWebGPU, createGpu, uniformStruct, headerWGSL, fold, createPresenter, createBlit,
  halfsToFloats, fullscreenVert, glslMod, luma,
} from '/src/gpu/index.js';
import { createThreeRenderer, gpuTextureOf, externalTexture, initRenderTarget, threeHasVisible, useWebGPUCamera } from '/src/gpu/three.js';
import * as THREE from 'three/webgpu';
import { texture3D, vec3 } from 'three/tsl';
import { boot, ready, test, log, measure, readU32 } from './harness.js';

const W = 400, H = 250;
const h = await boot({ label: 'foundation' });
const gpu = h.gpu;
const canvas = document.getElementById('view');

// ---------------------------------------------------------------- shared test kernels

const OUT = gpu.layout('TEST_OUT', [{ binding: 0, buffer: { type: 'storage' } }]);
const IN_OUT = gpu.layout('TEST_IN_OUT', [{ binding: 0, buffer: { type: 'storage' } }, { binding: 1, buffer: { type: 'read-only-storage' } }]);
const SHARED = gpu.layout('TEST_SHARED', [{ binding: 0, buffer: { type: 'uniform' } }, { binding: 1, buffer: { type: 'storage' } }]);
const outLayouts = [undefined, undefined, OUT];

const storage = (label, bytes, extra = 0) => gpu.createBuffer({ label, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
const outGroup = (buffer) => gpu.bindGroup(OUT, [{ binding: 0, resource: { buffer } }]);
const kernel = (name, code, params, layouts = outLayouts, workgroupSize = [1, 1, 1]) => gpu.kernel({ name, code, params, layouts, workgroupSize });
const tick = () => new Promise((r) => setTimeout(r, 0));

// params packing: every type uniformStruct lays out, read back through a kernel
const Pack = uniformStruct('Pack', {
  a: 'f32', b: 'vec3f', c: 'i32', d: 'vec2u', e: 'bool', f: 'array<vec4f, 2>', g: 'mat4x4f', h: 'u32', i: 'vec3i',
});
const packK = kernel('packCheck', `
${Pack.wgsl}${headerWGSL()}
@group(3) @binding(1) var<uniform> P: Pack;
@group(2) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(1) fn main() {
  out[0] = bitcast<u32>(P.a);
  out[1] = bitcast<u32>(P.b.x); out[2] = bitcast<u32>(P.b.y); out[3] = bitcast<u32>(P.b.z);
  out[4] = bitcast<u32>(P.c); out[5] = P.d.x; out[6] = P.d.y; out[7] = P.e;
  for (var i = 0; i < 2; i++) { for (var k = 0; k < 4; k++) { out[8 + i * 4 + k] = bitcast<u32>(P.f[i][k]); } }
  for (var c = 0; c < 4; c++) { for (var r = 0; r < 4; r++) { out[16 + c * 4 + r] = bitcast<u32>(P.g[c][r]); } }
  out[32] = P.h;
  out[33] = bitcast<u32>(P.i.x); out[34] = bitcast<u32>(P.i.y); out[35] = bitcast<u32>(P.i.z);
  out[36] = bitcast<u32>(H.origin.x); out[37] = bitcast<u32>(H.origin.y); out[38] = bitcast<u32>(H.origin.z);
  out[39] = H.src; out[40] = H.dst;
}`, Pack);

// the same rules in the storage address space (C6 tables use them)
const Store = uniformStruct('Store', { a: 'f32', b: 'vec3f', w: 'array<f32, 3>', v: 'vec2f', m: 'mat3x3f', k: 'i32' }, { space: 'storage' });
const storeK = gpu.kernel({
  name: 'storeCheck', layouts: [undefined, undefined, IN_OUT], workgroupSize: [1, 1, 1], code: `
${Store.wgsl}
@group(2) @binding(0) var<storage, read_write> out: array<u32>;
@group(2) @binding(1) var<storage, read> S: Store;
@compute @workgroup_size(1) fn main() {
  out[0] = bitcast<u32>(S.a);
  out[1] = bitcast<u32>(S.b.x); out[2] = bitcast<u32>(S.b.y); out[3] = bitcast<u32>(S.b.z);
  for (var i = 0; i < 3; i++) { out[4 + i] = bitcast<u32>(S.w[i]); }
  out[7] = bitcast<u32>(S.v.x); out[8] = bitcast<u32>(S.v.y);
  for (var c = 0; c < 3; c++) { for (var r = 0; r < 3; r++) { out[9 + c * 3 + r] = bitcast<u32>(S.m[c][r]); } }
  out[18] = bitcast<u32>(S.k);
}` });

// one result per step: frame, parity and the header it was recorded with
const Step = uniformStruct('Step', { frame: 'u32', parity: 'u32' });
const stepK = kernel('stepCheck', `
${Step.wgsl}${headerWGSL()}
@group(3) @binding(1) var<uniform> P: Step;
@group(2) @binding(0) var<storage, read_write> out: array<vec4u>;
@compute @workgroup_size(1) fn main() {
  out[P.frame] = vec4u(P.frame * 2u + P.parity, bitcast<u32>(H.origin.x), bitcast<u32>(H.origin.y), H.src | (H.dst << 1u));
}`, Step);

const Fill = uniformStruct('Fill', { value: 'u32' });
const fillK = kernel('fill', `
${Fill.wgsl}
@group(3) @binding(1) var<uniform> P: Fill;
@group(2) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { out[id.x] = P.value; }`, Fill, outLayouts, [64, 1, 1]);

const RingP = uniformStruct('RingP', { slot: 'u32', k: 'u32' });
const ringK = kernel('ringWrite', `
${RingP.wgsl}
@group(3) @binding(1) var<uniform> P: RingP;
@group(2) @binding(0) var<storage, read_write> ring: array<vec4u>;
@compute @workgroup_size(1) fn main() { ring[P.slot] = vec4u(P.k, P.k * P.k, P.slot, 7u); }`, RingP);

const argsK = kernel('writeArgs', `
@group(2) @binding(0) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn main() { args[0] = 3u; args[1] = 1u; args[2] = 1u; }`);
const countK = kernel('countWorkgroups', `
@group(2) @binding(0) var<storage, read_write> count: array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) { if (li == 0u) { atomicAdd(&count[0], 1u); } }`, null, outLayouts, [64, 1, 1]);

// fold(): a kernel that counts its workgroups by folded index
const foldK = kernel('foldIndex', `
@group(2) @binding(0) var<storage, read_write> hits: array<atomic<u32>>;
const N: u32 = 70001u;
@compute @workgroup_size(1) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = wg.x + wg.y * nwg.x;
  if (i >= N) { return; }
  atomicAdd(&hits[i >> 5u], 1u << (i & 31u));
}`);

const Shared = uniformStruct('Shared', { v: 'u32' });
const Idx = uniformStruct('Idx', { i: 'u32' });
const sharedK = gpu.kernel({
  name: 'sharedRead', params: Idx, layouts: [undefined, undefined, SHARED], workgroupSize: [1, 1, 1], code: `
${Shared.wgsl}${Idx.wgsl}
@group(2) @binding(0) var<uniform> U: Shared;
@group(2) @binding(1) var<storage, read_write> out: array<u32>;
@group(3) @binding(1) var<uniform> P: Idx;
@compute @workgroup_size(1) fn main() { out[P.i] = U.v; }` });
const copyK = gpu.kernel({
  name: 'copyWord', params: Idx, layouts: [undefined, undefined, IN_OUT], workgroupSize: [1, 1, 1], code: `
${Idx.wgsl}
@group(2) @binding(0) var<storage, read_write> out: array<u32>;
@group(2) @binding(1) var<storage, read> src: array<u32>;
@group(3) @binding(1) var<uniform> P: Idx;
@compute @workgroup_size(1) fn main() { out[P.i] = src[0]; }` });

// the shared WGSL snippets compile and do what GLSL did
const snippetK = kernel('snippets', `
${glslMod}${luma}
@group(2) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(1) fn main() {
  out[0] = glslMod(-1.25, 1.0);                    // GLSL mod: 0.75 (WGSL % gives -0.25)
  out[1] = glslMod3(vec3f(-3.5), vec3f(2.0)).y;   // 0.5
  out[2] = luma(vec3f(1.0));                       // 1.0
  out[3] = saturate(1.5);                          // builtin: 1.0
}`);

await Promise.all([packK, storeK, stepK, fillK, ringK, argsK, countK, foldK, sharedK, copyK, snippetK].map((k) => k.ready));
log('kernels ready', [...gpu.pipelines.times.entries()].map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', '));

// ---------------------------------------------------------------- tests

const f32 = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
const i32 = (x) => new Uint32Array(new Int32Array([x]).buffer)[0];

test('info', () => ({
  adapter: gpu.adapterInfo,
  limits: Object.fromEntries(['maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxStorageBufferBindingSize',
    'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxColorAttachmentBytesPerSample']
    .map((k) => [k, gpu.limits[k]])),
  features: [...gpu.features],
  isWebKit: gpu.isWebKit,
  maxFramesInFlight: gpu.maxFramesInFlight,
  fits128: gpu.fits({ nx: 128, ny: 128, nz: 128 }),
  fitsGiantWindow: gpu.fits({ nx: 128, ny: 384, nz: 128 }),
  giantWorldReason: gpu.fitsReason({ nx: 1024, ny: 384, nz: 1024 }),
}));

test('params', async () => {
  const values = {
    a: 1.5, b: [-2.25, 3.125, 1e-7], c: -123456, d: [7, 0xfffffffe], e: true,
    f: [[1, 2, 3, 4], { x: 5, y: 6, z: 7, w: 8 }], g: Array.from({ length: 16 }, (_, i) => i * 0.5 - 3), h: 0xdeadbeef, i: [-1, 2, -2147483648],
  };
  const header = { origin: [-64, 128, 3], src: 1, dst: 0 };
  const expect = [
    f32(1.5), f32(-2.25), f32(3.125), f32(1e-7), i32(-123456), 7, 0xfffffffe, 1,
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(f32), ...values.g.map(f32), 0xdeadbeef, i32(-1), 2, i32(-2147483648),
    i32(-64), 128, 3, 1, 0,
  ];
  const out = storage('pack out', 256);
  packK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , outGroup(out)], header, params: values });
  const got = [...await readU32(gpu, out, expect.length)];

  const svalues = { a: -0.5, b: [1, 2, 3], w: [0.25, 0.5, 0.75], v: [9, 10], m: [1, 2, 3, 4, 5, 6, 7, 8, 9], k: -7 };
  const sbuf = storage('store in', Store.size);
  gpu.write(sbuf, 0, Store.pack(svalues));
  const sout = storage('store out', 128);
  storeK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , gpu.bindGroup(IN_OUT, [{ binding: 0, resource: { buffer: sout } }, { binding: 1, resource: { buffer: sbuf } }])] });
  const sexpect = [-0.5, 1, 2, 3, 0.25, 0.5, 0.75, 9, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(f32).concat([i32(-7)]);
  const sgot = [...await readU32(gpu, sout, sexpect.length)];
  return {
    uniform: { size: Pack.size, offsets: Pack.offsets, mismatches: expect.flatMap((w, i) => (w === got[i] ? [] : [{ i, want: w, got: got[i] }])) },
    storage: { size: Store.size, offsets: Store.offsets, mismatches: sexpect.flatMap((w, i) => (w === sgot[i] ? [] : [{ i, want: w, got: sgot[i] }])) },
  };
});

// More than FLUSH_DISPATCHES steps in one synchronous run, as test.step(n) records
// them: every step reads its own frame, parity and header. Distinct headers
// fill the ring first (512 B a step); a shared header lets the count flush first.
test('manySteps', async (n = 2500, distinctHeaders = true) => {
  const out = storage('steps out', n * 16);
  const group = outGroup(out);
  const shared = { origin: [5, -6, 0], src: 0, dst: 1 };
  const stats = await measure(gpu, async () => {
    for (let frame = 0; frame < n; frame++) {
      const header = distinctHeaders ? { origin: [frame, -frame, 0], src: frame & 1, dst: (frame + 1) & 1 } : shared;
      stepK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], header, params: { frame, parity: frame & 1 } });
    }
    await gpu.fence();
  });
  const words = await readU32(gpu, out, n * 4);
  let wrong = 0, first = null;
  for (let frame = 0; frame < n; frame++) {
    const hd = distinctHeaders ? { x: frame, y: -frame, s: frame & 1, d: (frame + 1) & 1 } : { x: 5, y: -6, s: 0, d: 1 };
    const want = [frame * 2 + (frame & 1), hd.x >>> 0, hd.y >>> 0, hd.s | (hd.d << 1)];
    const got = words.subarray(frame * 4, frame * 4 + 4);
    if (want.some((w, i) => w !== got[i])) { wrong++; first ??= { frame, want, got: [...got] }; }
  }
  return { n, wrong, first, submits: stats.submits, dispatches: stats.dispatches, bytesUploaded: stats.bytesUploaded };
});

// B7: the bytes are the state at the call, whatever is recorded after it
test('readbackAtRequest', async () => {
  const buf = storage('fill', 256);
  const group = outGroup(buf);
  const stats = await measure(gpu, async () => {
    fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { value: 1 } });
    const early = gpu.readback.buffer(buf, 0, 256);
    fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { value: 2 } });
    const late = gpu.readback.buffer(buf, 16, 64);
    h.tmp = [new Uint32Array(await early), new Uint32Array(await late)];
  });
  const [a, b] = h.tmp;
  return { early: [...new Set(a)], late: [...new Set(b)], lateLength: b.length, submits: stats.submits };
});

test('textureReadback', async () => {
  const w = 37, ht = 5;
  const tex = gpu.createTexture({ label: 'pad test', size: [w, ht], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  const src = new Uint8Array(w * ht * 4).map((_, i) => (i * 7 + 3) & 255);
  gpu.queue.writeTexture({ texture: tex }, src, { bytesPerRow: w * 4 }, [w, ht]);
  const all = await gpu.readback.texture(tex);
  const sub = await gpu.readback.texture(tex, { origin: [3, 2, 0], size: [5, 2, 1] });
  let subWrong = 0;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 5; x++) for (let c = 0; c < 4; c++) {
    if (sub[(y * 5 + x) * 4 + c] !== src[((y + 2) * w + x + 3) * 4 + c]) subWrong++;
  }
  const half = gpu.createTexture({ label: 'half test', size: [3, 2], format: 'rgba16float', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  const bits = new Uint16Array(24).map((_, i) => [0x3400, 0x3800, 0x3a00, 0x3c00, 0xc000, 0][i % 6]);
  gpu.queue.writeTexture({ texture: half }, bits, { bytesPerRow: 3 * 8 }, [3, 2]);
  const halves = halfsToFloats(await gpu.readback.texture(half));
  tex.destroy(); half.destroy();
  return {
    length: all.length, want: w * ht * 4, wrong: all.reduce((n, v, i) => n + (v !== src[i]), 0), subWrong,
    halves: [...halves.slice(0, 6)],
  };
});

test('ring', async () => {
  const ring = gpu.readback.ring('test', 16, 8);
  const reads = [];
  const stats = await measure(gpu, async () => {
    for (let k = 0; k < 12; k++) {
      const slot = ring.next();
      ringK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , outGroup(ring.buffer)], params: { slot, k } });
      reads.push(ring.read(slot).then((b) => [...new Uint32Array(b)]));
    }
    h.tmp = await Promise.all(reads);
  });
  const again = [...new Uint32Array(await ring.read(3))];
  return { results: h.tmp, again, submits: stats.submits };
});

test('indirect', async () => {
  const args = storage('args', 16, GPUBufferUsage.INDIRECT);
  const count = storage('count', 16);
  gpu.write(count, 0, new Uint32Array(4));
  gpu.indirectLog.length = 0;
  const stats = await measure(gpu, async () => {
    argsK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , outGroup(args)] });
    countK.dispatch(gpu.frame, { indirect: args, offset: 0 }, { bind: [, , outGroup(count)] });
    gpu.endFrame();
  });
  const n = (await readU32(gpu, count, 1))[0];
  return { workgroups: n, stats, log: gpu.indirectLog.map((e) => ({ kernel: e.kernel, offset: e.offset })) };
});

test('fold', async () => {
  const n = 70001;
  const size = fold(n);
  const hits = storage('fold hits', Math.ceil(n / 32) * 4);
  gpu.write(hits, 0, new Uint32Array(hits.size / 4));
  let tooBig = null;
  try { foldK.dispatch(gpu.frame, [n, 1, 1], { bind: [, , outGroup(hits)] }); } catch (e) { tooBig = `${e.name}: ${e.message}`; }
  foldK.dispatch(gpu.frame, size, { bind: [, , outGroup(hits)] });
  const words = await readU32(gpu, hits);
  let missing = 0;
  for (let i = 0; i < n; i++) if (!((words[i >> 5] >>> (i & 31)) & 1)) missing++;
  return { size, missing, tooBig, giant: fold(98304) };
});

// B3: a shared uniform written between two commands of one encoder
test('sharedUniforms', async () => {
  const su = gpu.uniforms(Shared, 'TestShared');
  const out = storage('shared out', 16);
  const group = gpu.bindGroup(SHARED, [{ binding: 0, resource: { buffer: su.buffer } }, { binding: 1, resource: { buffer: out } }]);
  const stats = await measure(gpu, async () => {
    su.write({ v: 11 });
    sharedK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { i: 0 } });
    su.write({ v: 22 });
    sharedK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { i: 1 } });
    await gpu.fence();
  });
  const ruled = [...await readU32(gpu, out, 2)];
  // the hazard the rule exists for: a raw writeBuffer between them reaches both
  su.write({ v: 33 });
  sharedK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { i: 0 } });
  gpu.queue.writeBuffer(su.buffer, 0, new Uint32Array([44]));
  sharedK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { i: 1 } });
  const raw = [...await readU32(gpu, out, 2)];
  // gpu.write keeps program order for any buffer
  const src = storage('ordered src', 16);
  gpu.write(src, 0, new Uint32Array([3]));
  const copyGroup = gpu.bindGroup(IN_OUT, [{ binding: 0, resource: { buffer: out } }, { binding: 1, resource: { buffer: src } }]);
  copyK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , copyGroup], params: { i: 0 } });
  gpu.write(src, 0, new Uint32Array([5]));
  copyK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , copyGroup], params: { i: 1 } });
  const ordered = [...await readU32(gpu, out, 2)];
  return { ruled, raw, ordered, submits: stats.submits };
});

test('snippets', async () => {
  const out = storage('snippets', 16);
  snippetK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , outGroup(out)] });
  return [...new Float32Array(await gpu.readback.buffer(out))];
});

test('timing', async () => {
  if (!gpu.timing.supported) return { supported: false };
  gpu.timing.enabled = true;
  const out = storage('timing', 256);
  const group = outGroup(out);
  const frames = [];
  for (const split of [false, true]) {
    gpu.timing.split = split;
    const stats = await measure(gpu, async () => {
      fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { value: 1 } });
      stepK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { frame: 0, parity: 0 } });
      fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , group], params: { value: 2 } });
      gpu.endFrame();
      const want = gpu.frameNo;
      for (let i = 0; i < 100 && gpu.timing.lastFrame < want; i++) await new Promise((r) => setTimeout(r, 10));
    });
    frames.push({ split, last: { ...gpu.timing.last }, computePasses: stats.computePasses });
  }
  gpu.timing.split = false;
  gpu.timing.enabled = false;
  return { supported: true, frames };
});

// ---------------------------------------------------------------- failures (each on a gpu of its own)

async function freshGpu(label) {
  const probe = await probeWebGPU({ allowFallback: true });
  const g = await createGpu({ adapter: probe.adapter, label, testMode: 'manual' });
  const failed = new Promise((r) => g.onFailure(r));
  return { g, failed };
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const frameThrows = (g) => { try { g.frame; return null; } catch (e) { return e.name; } };

test('failShader', async () => {
  const { g, failed } = await freshGpu('fail-shader');
  const k = g.kernel({ name: 'injectedShaderFailure', code: '@compute @workgroup_size(1) fn main() { let x = injectedShaderFailure_undefined + 1; }' });
  const rejected = await k.ready.then(() => null, (e) => e.message);
  const f = await within(failed, 10000);
  return { message: f?.message, name: f?.name, rejected, frameThrows: frameThrows(g), state: k.state };
});

test('failLimits', async () => {
  const { g, failed } = await freshGpu('fail-limits');
  const five = Array.from({ length: 5 }, (_, i) => ({ binding: i, buffer: { type: 'storage' } }));
  const decl = (grp) => five.map((_, i) => `@group(${grp}) @binding(${i}) var<storage, read_write> b${grp}_${i}: array<u32>;`).join('\n');
  const k = g.kernel({
    name: 'tenStorageBuffers', layouts: [g.layout('FIVE_A', five), g.layout('FIVE_B', five)],
    code: `${decl(0)}\n${decl(1)}\n@compute @workgroup_size(1) fn main() { ${[0, 1].flatMap((grp) => five.map((_, i) => `b${grp}_${i}[0] = 1u;`)).join(' ')} }`,
  });
  await k.ready.catch(() => {});
  const f = await within(failed, 10000);
  return { message: f?.message, limit: g.limits.maxStorageBuffersPerShaderStage, adapterLimit: g.adapter.limits.maxStorageBuffersPerShaderStage };
});

test('failLose', async () => {
  const { g, failed } = await freshGpu('fail-lose');
  const buf = g.createBuffer({ label: 'lose src', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pending = g.readback.buffer(buf).then(() => 'resolved', (e) => `rejected: ${e.name}`);
  g.lose();
  const f = await within(failed, 10000);
  const after = await g.readback.buffer(buf).then(() => 'resolved', (e) => `rejected: ${e.name}`);
  let dispatchThrows = null;
  try { g.kernel({ name: 'x', code: '@compute @workgroup_size(1) fn main() {}' }).dispatch(g.frame, [1, 1, 1]); } catch (e) { dispatchThrows = e.name; }
  return { message: f?.message, name: f?.name, frameThrows: frameThrows(g), pending: await within(pending, 5000), after, dispatchThrows };
});

test('failValidationAfterThree', async () => {
  const { g, failed } = await freshGpu('fail-validation');
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  await createThreeRenderer(g, c);
  const threeOwnsHandler = typeof g.device.onuncapturederror === 'function';
  g.device.createBuffer({ label: 'injected', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE });
  g.queue.submit([]);   // errors reach the page when the device next does work, as every frame does
  const f = await within(failed, 10000);
  return { message: f?.message, name: f?.name, threeOwnsHandler, frameThrows: frameThrows(g) };
});

// ---------------------------------------------------------------- three.js interop and the walking skeleton

const presenter = createPresenter(gpu, canvas);
const three = await createThreeRenderer(gpu, canvas);
three.setPixelRatio(1);
three.setSize(W, H, false);
const blit = createBlit(gpu, presenter.format);
const backdrop = gpu.renderPipeline({
  name: 'skeletonBackdrop',
  code: `${fullscreenVert('vs')}
struct Out { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
@fragment fn fs(in: FullScreen) -> Out {
  var o: Out;
  o.color = vec4f(in.uv.x, 0.25, 1.0 - in.uv.x, 1.0);   // a gradient: our pass's colour
  o.depth = select(0.999, 0.2, in.uv.x < 0.5);            // left half near, right half far
  return o;
}`,
  fragment: { targets: [{ format: 'rgba16float' }] },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
});
await Promise.all([blit.ready, backdrop.ready]);

// three's scene: a red plane across the middle, at depth 0.495 (ortho, near 0.1, far 10, z = -5)
const camera = useWebGPUCamera(new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10));
const scene = new THREE.Scene();
const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicNodeMaterial({ color: 0xff0000 }));
plane.position.z = -5;
scene.add(plane);
const sceneTarget = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
initRenderTarget(three, sceneTarget);
await gpu.three.prepare(plane, { camera, scene, target: sceneTarget });
log('three ready; pipelines', gpu.stats.pipelinesCreated);

const px = (data, x, y, w = W) => Array.from(data.subarray(4 * (y * w + x), 4 * (y * w + x) + 4));
const SAMPLES = { leftHidden: [150, 125], rightMesh: [250, 125], rightBackdrop: [350, 125], corner: [20, 20] };

test('skeleton', async () => {
  const stats = await measure(gpu, async () => {
    const color = gpuTextureOf(three, sceneTarget.texture), depth = gpuTextureOf(three, sceneTarget.depthTexture);
    const f = gpu.frame;
    // E1: our scene pass
    const rp = f.render({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' },
    }, 'scene');
    backdrop.draw(rp);
    rp.end();
    // three: its own submit, loading our colour and depth
    h.visible = threeHasVisible(scene, camera);
    three.setRenderTarget(sceneTarget);
    three.render(scene, camera);
    three.setRenderTarget(null);
    h.sceneColor = gpu.readback.texture(color);
    h.sceneDepth = gpu.readback.texture(depth);
    // E2: the composite to the canvas
    const cp = gpu.frame.render({ colorAttachments: [presenter.attachment()] }, 'canvas');
    blit.draw(cp, color.createView());
    cp.end();
    h.capture = presenter.capture();
    gpu.endFrame();
    await gpu.fence();
  });
  const sceneColor = halfsToFloats(await h.sceneColor), sceneDepth = await h.sceneDepth, cap = await h.capture;
  const at = (name) => ({
    canvas: px(cap.data, ...SAMPLES[name], cap.width),
    scene: px(sceneColor, ...SAMPLES[name]).map((v) => Math.round(v * 1000) / 1000),
    depth: Math.round(sceneDepth[SAMPLES[name][1] * W + SAMPLES[name][0]] * 1000) / 1000,
  });
  return {
    visible: h.visible, canvasSize: [cap.width, cap.height], format: presenter.format, alphaMode: presenter.alphaMode,
    samples: Object.fromEntries(Object.keys(SAMPLES).map((k) => [k, at(k)])), stats,
  };
});

test('threeInterop', async () => {
  const out = {};
  // threeHasVisible
  out.visible = threeHasVisible(scene, camera);
  plane.visible = false; out.hiddenMesh = threeHasVisible(scene, camera); plane.visible = true;
  plane.layers.set(3); out.otherLayer = threeHasVisible(scene, camera); plane.layers.set(0);
  out.emptyScene = threeHasVisible(new THREE.Scene(), camera);

  // an external 3D texture sampled by a TSL material, then its source swapped once
  const make = (label, rgba) => {
    const t = gpu.createTexture({ label, size: [4, 4, 4], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    gpu.queue.writeTexture({ texture: t }, new Uint16Array(4 * 4 * 4 * 4).map((_, i) => rgba[i & 3]), { bytesPerRow: 4 * 8, rowsPerImage: 4 }, [4, 4, 4]);
    return t;
  };
  const texA = make('ext A', [0x3400, 0x3800, 0x3a00, 0x3c00]);   // 0.25, 0.5, 0.75, 1
  const texB = make('ext B', [0, 0x3c00, 0, 0x3c00]);             // 0, 1, 0, 1
  const extA = externalTexture(texA);
  const node = texture3D(extA, vec3(0.5, 0.5, 0.5));
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = node;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.position.z = -1;
  const s3 = new THREE.Scene();
  s3.add(quad);
  const rt = new THREE.RenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: false });
  initRenderTarget(three, rt);
  await gpu.three.prepare(quad, { camera, scene: s3, target: rt });
  const draw = async () => {
    three.setRenderTarget(rt);
    three.render(s3, camera);
    three.setRenderTarget(null);
    const c = halfsToFloats(await gpu.readback.texture(gpuTextureOf(three, rt.texture)));
    return px(c, 4, 4, 8);
  };
  out.is3D = extA.is3DTexture === true;
  out.sampleA = await draw();
  const extB = externalTexture(texB);
  node.value = extB;
  extA.dispose();
  out.sampleB = await draw();

  // the scene target's GPUTexture changes on resize: callers compare identity
  const before = gpuTextureOf(three, rt.texture);
  rt.setSize(16, 16);
  initRenderTarget(three, rt);
  const after = gpuTextureOf(three, rt.texture);
  out.newTextureOnResize = before !== after && after.width === 16;
  rt.dispose();
  return out;
});

// ---------------------------------------------------------------- budget scenarios (tools/budgets/foundation.mjs)

const budgetBuf = storage('budget', 256);
const budgetGroup = outGroup(budgetBuf);
const budgetArgs = storage('budget args', 16, GPUBufferUsage.INDIRECT);
const budgetCount = storage('budget count', 16);

test('budget:idle', async (ms = 1000) => {
  const stats = await measure(gpu, () => new Promise((r) => setTimeout(r, ms)));
  return { stats };
});
test('budget:frame', async (n = 10) => {
  const stats = await measure(gpu, async () => {
    for (let i = 0; i < n; i++) fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , budgetGroup], params: { value: i } });
    gpu.endFrame();
    await tick();
  });
  return { stats };
});
test('budget:indirect', async () => {
  gpu.indirectLog.length = 0;
  const stats = await measure(gpu, async () => {
    argsK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , outGroup(budgetArgs)] });
    countK.dispatch(gpu.frame, { indirect: budgetArgs }, { bind: [, , outGroup(budgetCount)] });
    gpu.endFrame();
    await tick();
  });
  // the workgroups the indirect dispatches ran, from their args read back
  let workgroups = 0;
  for (const e of gpu.indirectLog) {
    const a = new Uint32Array(await gpu.readback.buffer(e.buffer, e.offset, 12));
    workgroups += a[0] * a[1] * a[2];
  }
  return { stats, workgroups };
});
test('budget:flush', async (n = 3000) => {
  const stats = await measure(gpu, async () => {
    for (let i = 0; i < n; i++) fillK.dispatch(gpu.frame, [1, 1, 1], { bind: [, , budgetGroup], header: gpu.nullHeader, params: { value: i } });
    gpu.endFrame();
    await tick();
  });
  return { stats };
});
test('budget:present', async () => {
  const color = gpuTextureOf(three, sceneTarget.texture);
  const stats = await measure(gpu, async () => {
    const cp = gpu.frame.render({ colorAttachments: [presenter.attachment()] }, 'canvas');
    blit.draw(cp, color.createView());
    cp.end();
    gpu.endFrame();
    await tick();
  });
  return { stats };
});

ready();
log('ready');
