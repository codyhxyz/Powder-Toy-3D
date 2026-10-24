// GPU check of the world's light on the real adapter (Chrome's Tint and Metal), one slot of tools/browser.mjs.
// Hypothesis: the shadow writer (shaders/world/lightWriters.js shadowTraceFrag, the cell model) run on the
// GPU over the synthetic world of tools/world-light-twin.mjs writes the texels the JS twin writes (f32 against
// f64: opaque and translucent depths within SHADOW_DEPTH_TOL cells at all but MISMATCH_MAX of them, tint ids
// equal), the readers (shCascadeFor, sunMapShadowAt) over those texels give the twin's answers at its points,
// and every writer pipeline compiles under Tint (naga accepts some modules Tint rejects).
// No app, no dev server: a blank page on a loopback server of its own (WebGPU wants a secure context).
// usage: node tools/world-light-gpu-check.mjs   (AC power; one slot ≤ 25 s)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launchBrowser, newTestPage, gpuInfo } from './browser.mjs';
import { prelude, tablesBuffer } from '../src/shaders/common.js';
import { FrameUniforms } from '../src/shaders/bindings.js';
import { cellWordWGSL } from '../src/shaders/world/cellWord.js';
import { worldLightWGSL, lightDeclsWGSL, SHADOW, LightUniforms, LC_BUF_VEC4S, SHADOW_TEXELS } from '../src/shaders/world/light.js';
import {
  ShadowJobs, MAX_JOBS, shadowTraceFrag, shadowTraceDispatch, probeUpdateFrag, probePublishFrag, glowSeedFrag, glowBlurFrag, glowFinalFrag,
} from '../src/shaders/world/lightWriters.js';
import { lightAssembly } from '../src/gfx/worldLight.js';
import { probeLevels, glowLevels, lightUniformValues, shadowJobValues } from '../src/gfx/worldLightBook.js';
import { SIZE, cells, casc, traceJobs, slots, sun0, shadowAt, cascadeFor, idOf, occupancyArrays } from './world-light-twin.mjs';

const SHADOW_DEPTH_TOL = 0.02;   // cells
const MISMATCH_MAX = 0.005;      // share of texels allowed off (a ray grazing a cell's edge goes either way in f32)
const READER_TOL = 0.02;
const SAMPLE_TEXELS = 20000;

if (process.platform === 'darwin' && !/AC Power/.test(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }))) {
  console.log('world-light-gpu-check: on battery, skipped (no GPU runs on battery)');
  process.exit(0);
}

// ---- the twin: trace every tile, keep the jobs for the GPU ----
const cam = [32, 10, 24];
const allJobs = [];
for (let f = 0; f < 2000; f++) {
  casc.update(cam, sun0, []);
  const j = casc.jobs();
  if (!j.length) break;
  traceJobs(j);
  allJobs.push(...j);
}
const batches = [];
for (let i = 0; i < allJobs.length; i += MAX_JOBS) {
  const b = allJobs.slice(i, i + MAX_JOBS);
  batches.push({ n: b.length, bytes: Buffer.from(ShadowJobs.pack(shadowJobValues(casc, b))).toString('base64') });
}
const lc = Buffer.from(LightUniforms.pack(lightUniformValues(SIZE, casc, probeLevels(), glowLevels()))).toString('base64');
// texels to compare (a sample) and points for the readers (in air, as the CPU check's)
let rnd = 11;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const texels = [];
for (const [slot, m] of slots.entries()) for (const [idx, v] of m) if (rand() < SAMPLE_TEXELS / (3 * SHADOW.RES ** 2)) texels.push([slot * SHADOW.RES ** 2 + idx, ...v]);
const points = [];
while (points.length < 2000) {
  const p = [rand() * SIZE[0], 4 + rand() * 24, rand() * SIZE[2]];
  if (!idOf(p.map(Math.floor))) points.push([...p, ...shadowAt(p), cascadeFor(p)]);
}

// ---- the stand-ins: W's readers over cells and occupancy arrays, F's over dummy textures ----
const occ = occupancyArrays();
const OFF = [SIZE[0] * SIZE[1] * SIZE[2]];
for (const o of occ) OFF.push(OFF.at(-1) + o.bits.length);
const words = new Uint32Array(OFF.at(-1));
words.set(cells, 0);
occ.forEach((o, l) => words.set(o.bits, OFF[l]));
const W_GPU = /* wgsl */ `
${cellWordWGSL}
struct WorldCopyUniforms { size: vec3i, air: u32 }
@group(1) @binding(0) var<uniform> WC: WorldCopyUniforms;
@group(1) @binding(1) var<storage, read> wcStub: array<u32>;
const OCC_AT = array<u32, 3>(${OFF.slice(0, 3).map((v) => `${v}u`).join(', ')});
const OCC_DIM = array<vec3i, 3>(${occ.map((o) => `vec3i(${o.dims.join(', ')})`).join(', ')});
fn wcIn(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < WC.size); }
fn wcCell(c: vec3i) -> u32 { if (!wcIn(c)) { return WC.air; } return wcStub[u32(c.x + WC.size.x * (c.y + WC.size.y * c.z))]; }
fn wcA(c: vec3i) -> vec4f { let w = wcCell(c); return vec4f(f32(wcId(w)), wcTemp(w), wcAux(w), f32(wcCtype(w))); }
fn wcInfo(b: vec3i) -> u32 { return 0u; }
fn wcOccupied(level: u32, c: vec3i) -> bool {
  if (!wcIn(c)) { return false; }
  let n = c >> vec3u(2u + 2u * level);
  let d = OCC_DIM[level];
  return wcStub[OCC_AT[level] + u32(n.x + d.x * (n.y + d.y * n.z))] != 0u;
}`;
const F_STUB = /* wgsl */ `
@group(2) @binding(0) var tFS: texture_3d<f32>;
@group(2) @binding(1) var tFM: texture_3d<f32>;
@group(2) @binding(6) var wrapLinear: sampler;
fn surfField(p: vec3f) -> vec4f { return textureSampleLevel(tFS, wrapLinear, p / 64.0, 0.0); }
fn surfSample(p: vec3f) -> vec4f { return surfField(p); }
fn mediaField(p: vec3f) -> vec4f { return textureSampleLevel(tFM, wrapLinear, p / 64.0, 0.0); }`;
const headC = lightAssembly({ copyWGSL: W_GPU });
const headF = lightAssembly({ copyWGSL: W_GPU, fieldsWGSL: F_STUB });
const READER = /* wgsl */ `${headF}
${worldLightWGSL({ fields: false })}
${lightDeclsWGSL()}
@group(2) @binding(16) var tMediaNoise: texture_3d<f32>;
@group(2) @binding(17) var linearClamp: sampler;
@group(3) @binding(1) var<storage, read> pts: array<vec4f>;
@group(3) @binding(2) var<storage, read_write> outv: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&pts)) { return; }
  let p = pts[id.x].xyz;
  outv[id.x] = vec4f(sunMapShadowAt(p), f32(shCascadeFor(p)));
}`;
const COMPILE = {
  probeUpdate: `${headF}\n${probeUpdateFrag({ fields: true })}`,
  probePublish: probePublishFrag(),
  glowSeed: `${headC}\n${glowSeedFrag()}`,
  glowBlurX: glowBlurFrag(0),
  glowBlurY: glowBlurFrag(1),
  glowFinal: glowFinalFrag(),
  shadowFields: `${headF}\n${shadowTraceFrag({ fields: true })}`,
};
const payload = {
  shadowWGSL: `${headC}\n${shadowTraceFrag({ fields: false })}`, readerWGSL: READER, compile: COMPILE,
  tables: Buffer.from(tablesBuffer()).toString('base64'), fuSize: FrameUniforms.size,
  wc: Buffer.from(new Int32Array([...SIZE, 0]).buffer).toString('base64'), words: Buffer.from(words.buffer).toString('base64'),
  lc, batches, lcBytes: LC_BUF_VEC4S * 16, texels, points, groupsX: shadowTraceDispatch(MAX_JOBS)[0],
  tol: SHADOW_DEPTH_TOL, readerTol: READER_TOL,
};

// ---- the run ----
const server = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>light</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser, bad = 0;
const t0 = Date.now();
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const info = await gpuInfo(page);
  console.log(`  adapter: ${info.vendor} ${info.architecture} ${info.description}`);
  const r = await page.evaluate(async (P) => {
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
    const errors = [];
    device.onuncapturederror = (e) => errors.push(e.error.message);
    const U = GPUBufferUsage;
    const buf = (data, usage, size) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil((size ?? data.byteLength) / 16) * 16), usage: usage | U.COPY_DST });
      if (data) device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const module = async (name, code) => {
      const m = device.createShaderModule({ label: name, code });
      const ci = await m.getCompilationInfo();
      const errs = ci.messages.filter((x) => x.type === 'error').map((x) => `${name}:${x.lineNum}: ${x.message}`);
      return { m, errs };
    };
    const L = (entries) => device.createBindGroupLayout({ entries: entries.map(([binding, kind]) => ({ binding, visibility: GPUShaderStage.COMPUTE,
      ...(kind === 'u' ? { buffer: { type: 'uniform' } } : kind === 'r' ? { buffer: { type: 'read-only-storage' } } : kind === 's' ? { buffer: { type: 'storage' } }
        : kind === 't' ? { texture: { sampleType: 'float', viewDimension: '3d' } } : { sampler: { type: 'filtering' } }) })) });
    const out = { errors: [], timings: {} };
    const tables = buf(b64(P.tables), U.STORAGE), fu = buf(null, U.UNIFORM, P.fuSize), header = buf(null, U.UNIFORM, 256);
    const wc = buf(b64(P.wc), U.UNIFORM), words = buf(b64(P.words), U.STORAGE);
    const lcU = buf(b64(P.lc), U.UNIFORM);
    const lcBuf = device.createBuffer({ size: P.lcBytes, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
    const g0L = L([[0, 'r'], [1, 'u']]), g1L = L([[0, 'u'], [1, 'r']]), g3L = L([[0, 'u']]);
    const g0 = device.createBindGroup({ layout: g0L, entries: [{ binding: 0, resource: { buffer: tables } }, { binding: 1, resource: { buffer: fu } }] });
    const g1 = device.createBindGroup({ layout: g1L, entries: [{ binding: 0, resource: { buffer: wc } }, { binding: 1, resource: { buffer: words } }] });
    const g3 = device.createBindGroup({ layout: g3L, entries: [{ binding: 0, resource: { buffer: header } }] });
    // 1. the shadow writer, every batch of the twin's jobs
    let t = performance.now();
    const sh = await module('shadow', P.shadowWGSL);
    out.errors.push(...sh.errs);
    if (sh.errs.length) return out;
    const g2L = L([[14, 'u'], [22, 's'], [23, 'u']]);
    const pipe = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [g0L, g1L, g2L, g3L] }), compute: { module: sh.m, entryPoint: 'main' } });
    out.timings.shadowCompileMs = performance.now() - t;
    t = performance.now();
    for (const b of P.batches) {
      const jobs = buf(b64(b.bytes), U.UNIFORM);
      const g2 = device.createBindGroup({ layout: g2L, entries: [{ binding: 14, resource: { buffer: lcU } }, { binding: 22, resource: { buffer: lcBuf } }, { binding: 23, resource: { buffer: jobs } }] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      [g0, g1, g2, g3].forEach((g, i) => pass.setBindGroup(i, g));
      pass.dispatchWorkgroups(Math.min(b.n, P.groupsX), Math.ceil(b.n / P.groupsX));
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    out.timings.shadowTraceMs = performance.now() - t;
    out.timings.tiles = P.batches.reduce((a, b) => a + b.n, 0);
    // 2. the readers over the GPU's texels
    const rd = await module('reader', P.readerWGSL);
    out.errors.push(...rd.errs);
    if (!rd.errs.length) {
      const dummy = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
      const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const r2L = L([[0, 't'], [1, 't'], [6, 'p'], [8, 't'], [9, 't'], [10, 't'], [11, 't'], [12, 't'], [14, 'u'], [15, 'r'], [16, 't'], [17, 'p']]);
      const r3L = L([[0, 'u'], [1, 'r'], [2, 's']]);
      const rp = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [g0L, g1L, r2L, r3L] }), compute: { module: rd.m, entryPoint: 'main' } });
      const pts = buf(new Float32Array(P.points.flatMap((p) => [p[0], p[1], p[2], 0])), U.STORAGE);
      const res = device.createBuffer({ size: P.points.length * 16, usage: U.STORAGE | U.COPY_SRC });
      const r2 = device.createBindGroup({ layout: r2L, entries: [[0, dummy], [1, dummy], [6, smp], [8, dummy], [9, dummy], [10, dummy], [11, dummy], [12, dummy],
        [14, { buffer: lcU }], [15, { buffer: lcBuf }], [16, dummy], [17, smp]].map(([binding, resource]) => ({ binding, resource })) });
      const r3 = device.createBindGroup({ layout: r3L, entries: [{ binding: 0, resource: { buffer: header } }, { binding: 1, resource: { buffer: pts } }, { binding: 2, resource: { buffer: res } }] });
      const read = device.createBuffer({ size: res.size, usage: U.MAP_READ | U.COPY_DST });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(rp);
      [g0, g1, r2, r3].forEach((g, i) => pass.setBindGroup(i, g));
      pass.dispatchWorkgroups(Math.ceil(P.points.length / 64));
      pass.end();
      enc.copyBufferToBuffer(res, 0, read, 0, res.size);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(read.getMappedRange().slice(0));
      let off = 0, casc = 0, worst = 0;
      const pairs = {};
      P.points.forEach((p, i) => {
        const e = Math.max(...[0, 1, 2].map((k) => Math.abs(v[4 * i + k] - p[3 + k])));
        worst = Math.max(worst, e);
        if (e > P.readerTol) off++;
        if (v[4 * i + 3] !== p[6]) { casc++; const k = `${p[6]}->${v[4 * i + 3]}`; pairs[k] = (pairs[k] ?? 0) + 1; }
      });
      out.reader = { n: P.points.length, off, casc, worst, pairs };
    }
    // 3. the texels
    const read = device.createBuffer({ size: P.lcBytes, usage: U.MAP_READ | U.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(lcBuf, 0, read, 0, P.lcBytes);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const tex = new Float32Array(read.getMappedRange());
    let off = 0, idOff = 0, worst = 0;
    for (const [i, x, y, z, w] of P.texels) {
      const g = [tex[4 * i], tex[4 * i + 1], tex[4 * i + 2], tex[4 * i + 3]];
      const e = Math.max(Math.abs(g[0] - x), Math.abs(g[1] - y), Math.abs(g[2] - z), Math.abs(g[3] - w));
      if (Math.floor(g[3] / 256) !== Math.floor(w / 256)) idOff++;
      if (e > P.tol) off++;
      worst = Math.max(worst, e);
    }
    out.texels = { n: P.texels.length, off, idOff, worst };
    read.unmap();
    // 4. every other writer compiles under Tint
    t = performance.now();
    for (const [name, code] of Object.entries(P.compile)) {
      const m = await module(name, code);
      out.errors.push(...m.errs);
      if (!m.errs.length) {
        try { await device.createComputePipelineAsync({ layout: 'auto', compute: { module: m.m, entryPoint: 'main' } }); } catch (e) { out.errors.push(`${name}: ${e.message}`); }
      }
    }
    out.timings.compileOthersMs = performance.now() - t;
    await device.queue.onSubmittedWorkDone();
    out.errors.push(...errors);
    device.destroy();
    return out;
  }, payload);
  for (const e of r.errors) { bad++; console.error('FAIL', e.slice(0, 600)); }
  console.log(`  shadow: ${r.timings.tiles} tiles (${r.timings.tiles * 64} rays) traced in ${r.timings.shadowTraceMs?.toFixed(1)} ms (compile ${r.timings.shadowCompileMs?.toFixed(0)} ms); other writers compiled in ${r.timings.compileOthersMs?.toFixed(0)} ms`);
  if (r.texels) {
    console.log(`  texels: ${r.texels.off}/${r.texels.n} off by > ${SHADOW_DEPTH_TOL} cells (worst ${r.texels.worst.toFixed(4)}), ${r.texels.idOff} tint ids differ`);
    if (r.texels.off > MISMATCH_MAX * r.texels.n || r.texels.idOff > MISMATCH_MAX * r.texels.n) { bad++; console.error('FAIL the GPU\'s texels differ from the twin\'s'); }
  } else { bad++; console.error('FAIL no texels compared'); }
  if (r.reader) {
    console.log(`  readers: ${r.reader.off}/${r.reader.n} points off by > ${READER_TOL} (worst ${r.reader.worst.toFixed(4)}), ${r.reader.casc} picked another cascade ${JSON.stringify(r.reader.pairs)}`);
    if (r.reader.off > MISMATCH_MAX * r.reader.n || r.reader.casc > MISMATCH_MAX * r.reader.n) { bad++; console.error('FAIL the GPU\'s readers differ from the twin\'s'); }
  } else { bad++; console.error('FAIL the readers didn\'t run'); }
} finally {
  await browser?.close();
  server.close();
}
console.log(`world-light-gpu-check: ${bad ? `${bad} failures` : 'ok'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(bad ? 1 : 0);
