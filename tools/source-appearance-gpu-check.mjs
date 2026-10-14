// Numerical production-WGSL fixture, no app loop or reduced physics fixtures.
import assert from 'node:assert/strict';
import { appearanceFixture } from './appearance-fixture.mjs';
import { sourceAppearanceWGSL } from '../src/shaders/gfx/sourceAppearance.js';
import { appearanceRegion } from '../src/gfx/sourceAppearance.js';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { E } from '../src/elements.js';
import { spawnSync } from 'node:child_process';

const { words } = appearanceFixture(), region = appearanceRegion([1, 1, 1], words.length);
const code = `
struct FixtureFrame { sourceAppearance: vec4u, time: f32, sourceStyle: u32 }
@group(0) @binding(0) var tFarGrid: texture_3d<u32>;
@group(0) @binding(1) var<uniform> FU: FixtureFrame;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;
${sourceAppearanceWGSL()}
@compute @workgroup_size(1) fn main() {
  let hit = sourceMaterial(${E.ROCK}, vec3f(1.0), vec3f(0.0, 1.0, 0.0));
  results[0] = vec4f(hit.albedo, f32(hit.kind));
  results[1] = vec4f(f32(sourceMaterial(${E.CERAMIC}, vec3f(1.0), vec3f(0.0, 1.0, 0.0)).kind));
  results[2] = vec4f(f32(sourceMaterial(${E.ROCK}, vec3f(1.0, 5.0, 1.0), vec3f(0.0, 1.0, 0.0)).kind));
  results[3] = vec4f(f32(sourceMaterial(${E.ROCK}, vec3f(1.0), vec3f(1.0, 0.0, 0.0)).kind));
  results[4] = vec4f(f32(sourceMaterial(${E.EMPTY}, vec3f(1.0), vec3f(0.0, 1.0, 0.0)).kind));
  var col = vec3f(0.0); var trans = vec3f(1.0);
  sourceBlend(vec3f(0.0, 1.0, 0.0), 1.0, 2u << 16u, &col, &trans);
  results[5] = vec4f(col + trans, 1.0);
}`;
async function checkGPU() {
const vite = await startVite({ harness: true, port: 54979 });
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual' });
  await page.route('**/appearance-fixture', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Source appearance</title>' }));
  await page.goto(vite.url('/appearance-fixture'));
  const result = await page.evaluate(async ({ code, words, region }) => {
    const { uploadAppearance } = await import('/src/gfx/sourceAppearance.js');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const texture = device.createTexture({ size: region.size, dimension: '3d', format: 'rgba16uint',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    uploadAppearance({ queue: device.queue }, texture, new Uint32Array(words), region);
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frame = new Uint32Array(8); frame.set(region.uniform); frame[5] = 1;
    const output = device.createBuffer({ size: 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 96, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const module = device.createShaderModule({ code });
      const messages = (await module.getCompilationInfo()).messages;
      if (messages.some(m => m.type === 'error')) throw new Error(JSON.stringify(messages));
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: output } }] });
      const run = async () => {
        device.queue.writeBuffer(uniform, 0, frame);
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, 96); device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange().slice(0))); read.unmap(); return values;
      };
      const on = await run(); frame[5] = 0; const off = await run();
      return { on, off, errors, fallback: adapter.info.isFallbackAdapter, vendor: adapter.info.vendor };
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
  console.log('PASS native production WGSL: exact source pixels/UV, cut/destruction fallback, subtractive blend, mode gating', result.vendor);
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
