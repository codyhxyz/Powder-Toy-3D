// Numerical production-WGSL fixture, no app loop or reduced physics fixtures.
import assert from 'node:assert/strict';
import { appearanceFixture } from './appearance-fixture.mjs';
import { sourceAppearanceWGSL } from '../src/shaders/gfx/sourceAppearance.js';
import { appearanceRegion } from '../src/gfx/sourceAppearance.js';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { E } from '../src/elements.js';
import { spawnSync } from 'node:child_process';

const words = new Uint32Array(160);
words.set(appearanceFixture().words);
words[1] = words.length;
words.set([0xff0000ff, 0xff00ff00, 0xffff0000, 0xffffffff], 156);
const sourceGrid = [3, 5, 4], region = appearanceRegion(sourceGrid, words.length);
const code = `
struct FixtureFrame { sourceAppearance: vec4u, time: f32, sourceStyle: u32 }
@group(0) @binding(0) var tFarGrid: texture_3d<u32>;
@group(0) @binding(1) var<uniform> FU: FixtureFrame;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;
${sourceAppearanceWGSL(true, sourceGrid)}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= 8u) { return; }
  let positions = array<vec3f, 8>(
    vec3f(1.0), vec3f(1.0), vec3f(1.0, 5.0, 1.0), vec3f(1.0), vec3f(1.0),
    vec3f(1.5, 1.0, 0.5), vec3f(2.5, 4.0, 1.5), vec3f(7.5, 1.0, 1.5));
  let ids = array<i32, 8>(${E.ROCK}, ${E.CERAMIC}, ${E.ROCK}, ${E.ROCK}, ${E.EMPTY}, ${E.ROCK}, ${E.ROCK}, ${E.ROCK});
  let normal = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), i == 3u);
  // One callsite: static probe expansion must not multiply the Metal compiler's
  // large source-reader tree merely to exercise eight independent inputs.
  let hit = sourceMaterial(ids[i], positions[i], normal);
  let slot = select(i, i + 6u, i >= 5u);
  results[slot] = select(vec4f(hit.albedo, f32(hit.kind)), vec4f(f32(hit.kind)), i > 0u && i < 5u);
  if (i != 0u) { return; }
  var col = vec3f(0.0); var trans = vec3f(1.0);
  sourceBlend(vec3f(0.0, 1.0, 0.0), 1.0, 2u << 16u, &col, &trans);
  results[5] = vec4f(col + trans, 1.0);
  results[6] = sourceVec4(67u);
  results[7] = sourceVec4(68u);
  results[8] = sourceTexture(156u, vec2u(2u), vec2f(0.5), 268u);
  results[9] = sourceTexture(156u, vec2u(2u), vec2f(-0.125), 268u);
  results[10] = sourceTexture(156u, vec2u(2u), vec2f(-0.25), 260u);
}`;
async function checkGPU() {
const vite = await startVite({ harness: true, port: 54979 });
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual' });
  page.on('console', m => { if (m.text().startsWith('Source fixture:')) console.log(m.text()); });
  await page.route('**/appearance-fixture', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Source appearance</title>' }));
  await page.goto(vite.url('/appearance-fixture'));
  const result = await page.evaluate(async ({ code, words, region }) => {
    const { uploadAppearance, uploadAppearanceRange } = await import('/src/gfx/sourceAppearance.js');
    const { createDoorAppearance } = await import('/src/world/import/doorAppearance.js');
    console.log('Source fixture: modules loaded');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    console.log('Source fixture: native device ready');
    const errors = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const texture = device.createTexture({ size: region.size, dimension: '3d', format: 'rgba16uint',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    const live = new Uint32Array(words), gpu = { queue: device.queue };
    uploadAppearance(gpu, texture, live, region);
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frame = new Uint32Array(8); frame.set(region.uniform); frame[5] = 1;
    const output = device.createBuffer({ size: 224, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 224, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const module = device.createShaderModule({ code });
      const messages = (await module.getCompilationInfo()).messages;
      if (messages.some(m => m.type === 'error')) throw new Error(JSON.stringify(messages));
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      console.log('Source fixture: pipeline ready');
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: output } }] });
      const run = async () => {
        device.queue.writeBuffer(uniform, 0, frame);
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(8); pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, 224); device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange().slice(0))); read.unmap(); return values;
      };
      const on = await run(); frame[5] = 0; const off = await run();
      frame[5] = 1;
      // A nonuniform texture catches wrong affine gradients/biases, not merely
      // moving a constant-colour panel. These are the production range uploader
      // and pose helper; odd triangle records cross multiple atlas rows/planes.
      live.set([156, 2, 2, 4 | 256], 91);
      uploadAppearanceRange(gpu, texture, live, region, 91, 4);
      const textured = await run();
      const art = createDoorAppearance({}, live, (from, data) =>
        uploadAppearanceRange(gpu, texture, live, region, from, data.length));
      art.pose({ motion: { kind: 'sliding', translation: [1, 3, 1] }, appearanceTriangleIndices: [0] }, 1);
      const moved = await run();
      art.pose({ motion: { kind: 'swing', pivot: [4, 0, 4], axis: [0, 1, 0], angleRadians: -Math.PI / 2 },
        appearanceTriangleIndices: [0] }, 1);
      const rotated = await run();
      art.reset();
      const reset = await run();
      return { on, off, textured, moved, rotated, reset, errors, fallback: adapter.info.isFallbackAdapter, vendor: adapter.info.vendor };
    } finally {
      texture.destroy(); uniform.destroy(); output.destroy(); read.destroy(); device.destroy();
    }
  }, { code, words: [...words], region });
  assert.deepEqual(result.errors, []);
  if (process.platform === 'darwin') assert.equal(result.fallback, false);
  const linear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  [224, 64, 32].forEach((c, i) => assert(Math.abs(result.on[i] - linear(c / 255)) < 0.00001));
  assert.equal(result.on[3], 1);
  assert(result.on.slice(4, 20).every(v => v === 0), 'changed element, cut face, side face and deleted geometry have no source artwork');
  assert.deepEqual(result.on.slice(20, 24), [1, 0, 1, 1], 'original subtractive green glass produces magenta, not green');
  assert.equal(result.off[3], 0, 'mode exit disables source lookup');
  assert.deepEqual(result.on.slice(24, 28), [0, 1, 0, 0], 'unaligned vector reader');
  assert.deepEqual(result.on.slice(28, 32), [1, 0, 0, 0.5], 'aligned vector reader');
  const near = (actual, expected, label) => actual.forEach((v, i) =>
    assert(Math.abs(v - expected[i]) < 1e-6, `${label}: channel ${i}: ${v} != ${expected[i]}`));
  // GPU pow() at sRGB1 can differ by two ULPs; retain sub-byte precision.
  near(result.on.slice(32, 36), [0.5, 0.5, 0.5, 1], 'original bilinear interpolation');
  near(result.on.slice(36, 40), [0.625, 0.75, 0.75, 1], 'negative repeated filtered UV');
  near(result.on.slice(40, 44), [1, 1, 1, 1], 'negative repeated nearest UV');
  near(result.textured.slice(44, 48), [0, 1, 0, 1], 'nonuniform original UV');
  near(result.moved.slice(48, 52), [0, 1, 0, 1], 'translated door keeps exact UV/pixel');
  assert.equal(result.moved[3], 0, 'translated leaf leaves no source artwork at the old plane');
  near(result.rotated.slice(52, 56), [0, 1, 0, 1], 'rotated door keeps exact UV/pixel');
  near(result.reset.slice(44, 48), [0, 1, 0, 1], 'reset restores immutable source artwork');
  console.log('PASS native production WGSL: exact source pixels/UV, moving-door affine/range uploads/reset, packed vectors, filtering/repeat, cut/destruction fallback, subtractive blend, mode gating', result.vendor);
} finally {
  await browser?.close();
  await vite.close();
}
}
if (process.argv.includes('--cpu')) {
  const result = spawnSync('naga', ['--stdin-file-path', 'appearance-fixture.wgsl'], { input: code, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  console.log('PASS numerical source fixture Naga validation (CPU only)');
} else await checkGPU();
