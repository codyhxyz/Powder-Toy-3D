// The GPU foundation's check (docs/webgpu.md I1, U0's acceptance), on the
// harness page tools/harness/foundation.html: params packing against the WGSL
// layout (uniform and storage), more than FLUSH_DISPATCHES steps in one run
// with every step's frame, parity and header right, readback recorded at the
// request, texture de-padding, result rings, indirect dispatch counts, fold(),
// shared-uniform and write ordering, the WGSL snippets, timestamps, three.js
// interop (a mesh into a target we read, an external 3D texture sampled from
// TSL and its source swapped once, render target identity on resize,
// threeHasVisible), the walking skeleton (our scene pass, three's mesh after it
// with loadOp load, our composite to the canvas, a non-blank screenshot), and
// the failure paths: a bad WGSL module, a per-stage limit overrun, lose(), and
// a validation error after three's init, each reaching gpu.fail with the text
// tools assert.
//
// usage: node tools/gpu-foundation-check.mjs [--port N] [--out DIR] [--real-gpu]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : tmpdir();
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? `: ${detail}` : ''}`);
async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message.split('\n').slice(0, 6).join('\n     ')}`);
  }
}
const near = (a, b, tol, what) => a.forEach((v, i) => assert(Math.abs(v - b[i]) <= tol, `${what}: got [${a}], want [${b}] ±${tol}`));

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
const errors = [];
try {
  const page = await openHarness(browser, vite, '/tools/harness/foundation.html', { errors, viewport: { width: 400, height: 250 } });
  const run = (name, ...args) => page.evaluate(([n, a]) => window.__harness.run(n, ...a), [name, args]);
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture} (${info.description})${info.isFallbackAdapter ? ', fallback adapter' : ''}`);
  console.log((await page.evaluate(() => window.__harness.log)).filter((l) => /kernels ready|three ready/.test(l)).join('\n'));

  await check('device limits', async () => {
    const r = await run('info');
    assert.equal(r.limits.maxStorageBuffersPerShaderStage, 8, 'storage buffers requested at the spec default');
    assert.equal(r.limits.maxStorageTexturesPerShaderStage, 4);
    assert.equal(r.limits.maxComputeWorkgroupStorageSize, 16384);
    assert(r.fits128 && r.giantWorldReason?.startsWith('needs a '), 'gpu.fits');
    return `${r.limits.maxStorageBuffersPerShaderStage} storage buffers, binding ${r.limits.maxStorageBufferBindingSize / 2 ** 20} MiB, features [${r.features}]; ${r.giantWorldReason}`;
  });
  await check('params packing (uniform and storage layouts vs WGSL)', async () => {
    const r = await run('params');
    assert.deepEqual(r.uniform.mismatches, [], 'uniform');
    assert.deepEqual(r.storage.mismatches, [], 'storage');
    return `Pack ${r.uniform.size} B, Store ${r.storage.size} B, every word equal`;
  });
  await check('2500 steps, distinct headers (the ring fills first)', async () => {
    const r = await run('manySteps', 2500, true);
    assert.equal(r.wrong, 0, `step ${JSON.stringify(r.first)}`);
    assert(r.submits >= 2, `${r.submits} submits`);
    return `0 wrong, ${r.submits} submits, ${r.bytesUploaded} B of params`;
  });
  await check('4500 steps, one header (FLUSH_DISPATCHES flushes)', async () => {
    const r = await run('manySteps', 4500, false);
    assert.equal(r.wrong, 0, `step ${JSON.stringify(r.first)}`);
    assert.equal(r.submits, 3, '2048 + 2048 + 404');
    return `0 wrong, ${r.submits} submits`;
  });
  await check('readback recorded at the request', async () => {
    const r = await run('readbackAtRequest');
    assert.deepEqual(r.early, [1], 'a write after the request is not seen');
    assert.deepEqual(r.late, [2]);
    assert.equal(r.submits, 1, 'both reads from one submit');
    return 'early read 1, later read 2, one submit';
  });
  await check('texture readback de-padding', async () => {
    const r = await run('textureReadback');
    assert.equal(r.length, r.want);
    assert.equal(r.wrong, 0);
    assert.equal(r.subWrong, 0, 'sub-region');
    assert.deepEqual(r.halves, [0.25, 0.5, 0.75, 1, -2, 0]);
    return '37×5 rgba8unorm (148 B rows) and a sub-region exact, rgba16float decoded';
  });
  await check('result ring', async () => {
    const r = await run('ring');
    r.results.forEach((v, k) => assert.deepEqual(v, [k, k * k, k % 8, 7], `use ${k}`));
    assert.deepEqual(r.again, [11, 121, 3, 7]);
    return `12 uses of 8 slots, ${r.submits} submits (a wrap flushes)`;
  });
  await check('indirect dispatch', async () => {
    const r = await run('indirect');
    assert.equal(r.workgroups, 3);
    assert.equal(r.stats.indirectDispatches, 1);
    assert.equal(r.stats.dispatches, 3, 'one direct + one indirect counted twice');
    assert.equal(r.stats.submits, 1);
    assert.deepEqual(r.log, [{ kernel: 'countWorkgroups', offset: 0 }]);
    return '3 workgroups from GPU-written args, stats count it twice';
  });
  await check('fold()', async () => {
    const r = await run('fold');
    assert.equal(r.missing, 0);
    assert.deepEqual(r.size, [35001, 2, 1]);
    assert.deepEqual(r.giant, [49152, 2, 1]);
    assert.match(r.tooBig ?? '', /^RangeError: foldIndex: dispatch \[70001,1,1\]/);
    return `70,001 workgroups as [${r.size}], every index once; [70001] refused`;
  });
  await check('shared uniforms and write order', async () => {
    const r = await run('sharedUniforms');
    assert.deepEqual(r.ruled, [11, 22], 'each command sees the value current when it was recorded');
    assert.deepEqual(r.raw, [44, 44], 'control: a raw writeBuffer between them reaches both');
    assert.deepEqual(r.ordered, [3, 5], 'gpu.write keeps program order');
    return 'FrameUniforms-style writes flush first (control shows the hazard)';
  });
  await check('WGSL snippets', async () => {
    const r = await run('snippets');
    near(r, [0.75, 0.5, 1, 1], 1e-6, 'glslMod, glslMod3, luma, saturate');
    return 'glslMod(-1.25, 1) = 0.75, luma(1) = 1, saturate builtin';
  });
  await check('timestamps', async () => {
    const r = await run('timing');
    if (!r.supported) return 'no timestamp-query on this adapter: skipped';
    const [plain, split] = r.frames;
    assert.equal(plain.computePasses, 1, 'timing alone keeps one pass');
    assert.equal(split.computePasses, 3, 'split mode: a pass per dispatch');
    assert(Object.keys(split.last).sort().join() === 'fill,stepCheck', `split names ${Object.keys(split.last)}`);
    assert(Object.values(split.last).every((ms) => ms >= 0 && ms < 1000));
    return `split: ${Object.entries(split.last).map(([k, v]) => `${k} ${v.toFixed(3)} ms`).join(', ')}`;
  });
  await check('three.js interop (B10)', async () => {
    const r = await run('threeInterop');
    assert.deepEqual([r.visible, r.hiddenMesh, r.otherLayer, r.emptyScene], [true, false, false, false], 'threeHasVisible');
    assert(r.is3D, 'ExternalTexture is3DTexture');
    near(r.sampleA, [0.25, 0.5, 0.75, 1], 1e-3, 'external 3D texture A through TSL');
    near(r.sampleB, [0, 1, 0, 1], 1e-3, 'after the source swap');
    assert(r.newTextureOnResize, 'three recreates the GPUTexture on resize');
    return 'TSL samples our 3D texture, swap to a new ExternalTexture, identity changes on resize';
  });
  await check('walking skeleton', async () => {
    const r = await run('skeleton');
    const s = r.samples;
    assert(r.visible, 'threeHasVisible');
    // our near depth (0.2) hides three's plane (0.495) on the left: colour and depth were loaded
    near(s.leftHidden.canvas, [96, 64, 159, 255], 2, 'left: our gradient, the mesh hidden behind our depth');
    assert.equal(s.leftHidden.depth, 0.2);
    near(s.rightMesh.canvas, [255, 0, 0, 255], 1, 'right: three\'s mesh over our far depth');
    assert.equal(s.rightMesh.depth, 0.495);
    near(s.rightBackdrop.canvas, [223, 64, 32, 255], 2, 'right of the mesh: our pass\'s colour kept');
    near(s.corner.canvas, [13, 64, 242, 255], 2, 'corner');
    assert.equal(r.alphaMode, 'opaque');
    assert.equal(r.stats.submits, 3, 'ours, three\'s, ours');
    assert.equal(r.stats.renderPasses, 2, 'scene + canvas (three\'s pass not counted)');
    const shot = await page.locator('#view').screenshot({ path: join(OUT, 'foundation-skeleton.png') });
    const img = await run('imageStats', shot.toString('base64'), [[150, 125], [250, 125], [350, 125]]);
    assert(img.differ > 0.5 && img.variance > 100, `screenshot looks blank (differ ${img.differ}, variance ${img.variance})`);
    near(img.samples[1].slice(0, 3), [255, 0, 0], 3, 'screenshot: the mesh');
    near(img.samples[0].slice(0, 3), [96, 64, 159], 3, 'screenshot: hidden half');
    return `canvas ${r.canvasSize.join('×')} ${r.format}; 3 submits; screenshot ${img.width}×${img.height}, ${(img.differ * 100).toFixed(0)}% non-uniform, saved ${join(OUT, 'foundation-skeleton.png')}`;
  });
  await check('failure: bad WGSL', async () => {
    const r = await run('failShader');
    assert.match(r.message, /^GPU shader failed: injectedShaderFailure\.\n\d+:\d+ unresolved value 'injectedShaderFailure_undefined'/);
    assert.equal(r.rejected, r.message, 'kernel.ready rejects with the same failure');
    assert.equal(r.frameThrows, 'GraphicsFailure');
    return JSON.stringify(r.message);
  });
  await check('failure: 10 storage buffers on an 8-buffer device', async () => {
    const r = await run('failLimits');
    assert.equal(r.limit, 8);
    assert.match(r.message, /^GPU shader failed: tenStorageBuffers\.\nPipeline layout: .*\(10\).*\(8\)/s);
    return `adapter allows ${r.adapterLimit}, we requested ${r.limit}: caught here`;
  });
  await check('failure: lose()', async () => {
    const r = await run('failLose');
    assert.match(r.message, /^The browser lost the WebGPU device \(destroyed\): /);
    assert.equal(r.name, 'GraphicsFailure');
    assert.equal(r.frameThrows, 'GraphicsFailure');
    assert.equal(r.dispatchThrows, 'GraphicsFailure');
    assert.equal(r.pending, 'rejected: GraphicsFailure', 'a read in flight rejects');
    assert.equal(r.after, 'rejected: GraphicsFailure', 'a read after rejects');
    return JSON.stringify(r.message);
  });
  await check('failure: validation error after three\'s init', async () => {
    const r = await run('failValidationAfterThree');
    assert(r.threeOwnsHandler, 'three assigned device.onuncapturederror');
    assert.match(r.message ?? '', /^GPU validation error: /);
    assert.equal(r.frameThrows, 'GraphicsFailure');
    return 'reached gpu.fail through our listener';
  });
  const pageFailures = await page.evaluate(() => window.__harness.failures);
  await check('no stray failures on the main gpu', () => { assert.deepEqual(pageFailures, []); return ''; });
} finally {
  await browser.close();
  await vite.close();
}
const stray = errors.filter((e) => !/WebGPU is experimental/.test(e));
if (stray.length) { failures++; console.log(`FAIL page errors:\n  ${stray.join('\n  ')}`); }
console.log(failures ? `${failures} check(s) failed` : 'gpu-foundation-check: all passed');
process.exit(failures ? 1 : 0);
