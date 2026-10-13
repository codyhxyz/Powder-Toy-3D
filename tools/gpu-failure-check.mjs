// node tools/gpu-failure-check.mjs [port=5496]
// Graphics stop for good, with today's messages and throws (docs/webgpu.md
// B9): a lost device (__app.gpu.lose(): device.destroy(), reason 'destroyed';
// there is no restore, as the state lived on the GPU), a WGSL module that
// doesn't compile, and an uncaptured validation error. After each, nothing
// steps or draws on its own and every entry point that would record GPU work
// throws the GraphicsFailure, before it changes anything.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const port = process.argv[2] ?? '5496';
const base = `http://localhost:${port}/?size=64&view=plain`;
const VIEWPORT = { width: 320, height: 200 };
const stopped = (page) => page.waitForFunction(() => document.getElementById('error').textContent.includes('Rendering and simulation stopped'), null, { timeout: 60000 });
const browser = await launchBrowser();
try {
  // 1. device loss, on a running page
  const page = await newTestPage(browser, { mode: 'preview', viewport: VIEWPORT });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}&preset=lab`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => __app.sim.frame > 2, null, { timeout: 120000 });
  await page.evaluate(() => __app.gpu.lose());
  await stopped(page);
  const text = await page.evaluate(() => document.getElementById('error').textContent);
  assert.match(text, /The browser lost the WebGPU device \(destroyed\)/, text);
  const halted = await page.evaluate(() => ({ frame: __app.sim.frame, version: __app.sim.version, submits: __app.gpu.stats.submits }));
  await page.waitForTimeout(250); // several live rAFs after the loss must do no simulation work
  assert.deepEqual(await page.evaluate(() => ({ frame: __app.sim.frame, version: __app.sim.version, submits: __app.gpu.stats.submits })), halted);
  assert.equal(await page.evaluate(() => __app.loop.asleep), true, 'the frame loop stopped');
  // every writer throws the GraphicsFailure before it mutates or swaps a state copy
  const blocked = await page.evaluate(() => {
    const a = __app, threw = (fn) => { try { fn(); return null; } catch (e) { return e.name === 'GraphicsFailure' && /lost the WebGPU device/.test(e.message); } };
    const version = a.sim.version, cur = a.sim.cur;
    return {
      step: threw(() => a.sim.step()),
      paint: threw(() => a.sim.paint({ center: new a.THREE.Vector3(8, 8, 8), radius: 2, shape: 1, tool: 1, rate: 1 })),
      testStep: threw(() => { a.test.park(); a.test.step(1); }),
      unchanged: a.sim.version === version && a.sim.cur === cur,
    };
  });
  assert.deepEqual(blocked, { step: true, paint: true, testStep: true, unchanged: true });
  // the map, size and scene entry points refuse too, and leave the settings as they were
  const preservation = await page.evaluate(() => {
    const a = __app, settings = JSON.stringify(a.settings), sim = a.sim;
    const rejected = [() => a.openMap('empty'), () => a.setSize('96'), () => a.loadPreset('empty'), () => a.worldLoad([0, 0, 0])].map((fn) => {
      try { fn(); return false; } catch (error) { return error.name === 'GraphicsFailure'; }
    });
    return { rejected, sameSim: a.sim === sim, sameSettings: settings === JSON.stringify(a.settings) };
  });
  assert.deepEqual(preservation, { rejected: [true, true, true, true], sameSim: true, sameSettings: true });
  const report = await page.evaluate(() => __app.lastGpuFailure);
  assert.equal(report?.kind, 'deviceLost', JSON.stringify(report));
  assert(!errors.some((s) => /GPU shader failed/.test(s)), errors.join('\n'));
  console.log('PASS: device loss halts automatic work and direct writes; map, size and scene changes are refused');
  await page.close();

  // 2. a WGSL module that doesn't compile
  const shaderPage = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  await shaderPage.goto(`${base}&preset=empty`, { waitUntil: 'domcontentloaded' });
  await ready(shaderPage);
  const failure = await shaderPage.evaluate(async () => {
    const k = __app.gpu.kernel({
      name: 'injectedShaderFailure',
      code: '@compute @workgroup_size(1) fn main() { let x: f32 = invalidShaderIdentifier; }',
    });
    try { await k.ready; return null; } catch (error) { return { name: error.name, message: error.message }; }
  });
  assert.equal(failure?.name, 'GraphicsFailure');
  assert.match(failure.message, /GPU shader failed: injectedShaderFailure/);
  assert.match(failure.message, /invalidShaderIdentifier/);
  await stopped(shaderPage);
  assert.match(await shaderPage.evaluate(() => document.getElementById('error').textContent), /GPU shader failed: injectedShaderFailure/);
  await shaderPage.evaluate(() => __app.test.resume());
  await shaderPage.waitForTimeout(100);
  assert.equal(await shaderPage.evaluate(() => __app.sim.frame), 0);
  assert.equal(await shaderPage.evaluate(() => __app.lastGpuFailure?.kind), 'shaderFailed');
  console.log('PASS: the first shader failure keeps its diagnostics and stops further frames');
  await shaderPage.close();

  // 3. an uncaptured validation error, after three.js set up its own error handler (B9)
  const validationPage = await newTestPage(browser, { mode: 'manual', viewport: VIEWPORT });
  await validationPage.goto(`${base}&preset=empty`, { waitUntil: 'domcontentloaded' });
  await ready(validationPage);
  await validationPage.evaluate(async () => {
    // a buffer that can't be both mapped for reading and used as storage
    __app.gpu.device.createBuffer({ label: 'injectedValidationError', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE });
    // (Chrome delivers an uncaptured error when the device next does work: a
    // settled page does none, so ask the queue, as the next frame would)
    await __app.gpu.fence().catch(() => {});
  });
  await stopped(validationPage);
  const v = await validationPage.evaluate(() => document.getElementById('error').textContent);
  assert.match(v, /GPU validation error/, v);
  assert.match(v, /injectedValidationError/, v);
  const vThrows = await validationPage.evaluate(() => { try { __app.sim.step(); return false; } catch (e) { return e.name === 'GraphicsFailure'; } });
  assert(vThrows, 'a step after a validation error throws');
  console.log('PASS: an uncaptured validation error stops graphics with its message and the object it names');
  await validationPage.close();
} finally { await browser.close(); }
