// Native-GPU regression for transparent/black rectangular flecks in Island's
// limestone cave. Full 128³ physics fixture, real material shader and lighting.
// Run each view in its own <=25s slot: --cozy, --url=http://127.0.0.1:YOUR_PORT.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, gpuInfo } from './browser.mjs';

const COUNTERS = `
@group(0) @binding(0) var colour: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>, 4>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(colour))) { return; }
  if (textureLoad(depth, id.xy, 0) >= 1.0) { return; }
  atomicAdd(&counts[0], 1u);
  let c = textureLoad(colour, id.xy, 0);
  if (c.a < 0.999) { atomicAdd(&counts[1], 1u); }
  if (c.a >= 0.999 && all(c.rgb == vec3f(0.0))) { atomicAdd(&counts[2], 1u); }
  if (!all(abs(c) < vec4f(65505.0))) { atomicAdd(&counts[3], 1u); }
}`;

const view = process.argv.includes('--cozy') ? 6 : 0;
const url = new URL(process.argv.find(a => a.startsWith('--url='))?.slice(6) ?? 'https://tpt3d.codyh.xyz');
url.searchParams.set('map', 'island');
url.searchParams.set('view', view === 6 ? 'cozy' : 'realistic');
url.searchParams.set('paused', '1');
let browser;
const started = performance.now();
const log = text => console.log(`${((performance.now() - started) / 1000).toFixed(2)}s ${text}`);
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, {
    mode: 'manual', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
  });
  page.on('pageerror', error => console.error(error));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
    if (message.text().startsWith('opaque-cave:')) log(message.text());
  });
  await page.addInitScript(() => {
    // Finish the identical CPU noise tile without headless idle-time stalls.
    // Do not replace rAF: normal presentation and input callbacks stay intact.
    window.requestIdleCallback = fn => setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 0 }), 0);
    window.cancelIdleCallback = id => clearTimeout(id);
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({
      upscale: 'performance', paused: true, nearGI: true, glowLights: true, caustics: true,
    }));
  });
  const bootTrace = setTimeout(() => {
    page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-1200) }))
      .then(state => log(`startup: ${JSON.stringify(state)}`)).catch(() => {});
  }, 9000);
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    log('document loaded');
    await ready(page);
  } finally { clearTimeout(bootTrace); }
  log('app ready');
  const adapter = await gpuInfo(page);
  assert(!adapter.isFallbackAdapter && adapter.webgpu, 'this regression requires a native WebGPU adapter');
  await page.evaluate(() => __app.test.park());
  await page.waitForFunction(() => __app.win?.loaded, null, { polling: 100 });
  const result = await page.evaluate(async ({ source, view }) => {
    const a = __app;
    await a.test.ready();
    console.info('opaque-cave: material pipelines ready');
    if (a.settings.view !== view) throw new Error('The requested material view did not become active');
    if (a.sim.g.nx !== 128 || a.sim.g.ny !== 128 || a.sim.g.nz !== 128)
      throw new Error('This regression requires the full 128³ Island window');
    a.worldLoad([592, 0, 608]);
    a.controls.enabled = false;
    a.volume.updateMatrixWorld(true);
    const eye = new a.THREE.Vector3(656.5, 29, 672.5).sub(a.sim.origin).applyMatrix4(a.volume.matrixWorld);
    a.camera.position.copy(eye);
    a.camera.fov = 75;
    a.camera.lookAt(eye.clone().add(new a.THREE.Vector3(1, 0, 0)));
    a.camera.updateProjectionMatrix();
    a.camera.updateMatrixWorld(true);
    a.controls.target.copy(eye.clone().add(new a.THREE.Vector3(1, 0, 0)));
    a.autoRes.enabled = false;
    a.autoRes.scale = .6;
    a.post.reset();
    await a.test.render();
    console.info('opaque-cave: cave rendered');
    a.test.park();
    const { color, depth } = a.win.far.under, d = a.gpu.device;
    if (!color || !depth) throw new Error('The local-volume pass did not run');
    const output = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const pipeline = await d.createComputePipelineAsync({
        layout: 'auto', compute: { module: d.createShaderModule({ code: source }), entryPoint: 'main' },
      });
      const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: color.createView() }, { binding: 1, resource: depth.createView() },
        { binding: 2, resource: { buffer: output } },
      ] });
      const encoder = d.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(color.width / 8), Math.ceil(color.height / 8));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, 16);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const [covered, transparent, black, invalid] = new Uint32Array(read.getMappedRange());
      return { view, pixels: color.width * color.height, covered, transparent, black, invalid };
    } finally {
      if (read.mapState === 'mapped') read.unmap();
      read.destroy(); output.destroy();
    }
  }, { source: COUNTERS, view });
  assert.equal(result.covered, result.pixels, 'every ray in the enclosed cave must hit');
  assert.equal(result.transparent, 0, 'opaque cave walls must not expose the far scene');
  assert.equal(result.black, 0, 'do not replace bright flecks with black holes');
  assert.equal(result.invalid, 0, 'colour and opacity must remain finite');
  const screenshot = process.argv.find(a => a.startsWith('--screenshot='))?.slice(13);
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log('PASS: native opaque cave', { ...result, adapter: adapter.description });
} catch (error) {
  console.error('Opaque cave regression failed:', error);
  throw error;
} finally {
  if (browser) await browser.close();
}
