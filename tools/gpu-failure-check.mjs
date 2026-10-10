// node tools/gpu-failure-check.mjs [port=5496]
// Lose only this test page's context, then verify that restoration cannot
// resume a simulation whose GPU contents have disappeared.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const port = process.argv[2] ?? '5496';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'preview', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/?size=64&preset=empty`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => __app.sim.frame > 8);
  await page.evaluate(() => {
    const a = __app;
    window.lossExtension = a.renderer.getContext().getExtension('WEBGL_lose_context');
    if (!lossExtension) throw new Error('Test requires WEBGL_lose_context');
    lossExtension.loseContext();
  });
  await page.waitForFunction(() => document.getElementById('error').textContent.includes('Rendering and simulation stopped'));
  const stopped = await page.evaluate(() => ({ frame: __app.sim.frame, version: __app.sim.version }));
  await page.evaluate(() => lossExtension.restoreContext());
  await page.waitForFunction(() => !__app.renderer.getContext().isContextLost());
  await page.waitForTimeout(250); // several live rAFs after restoration must do no simulation work
  assert.deepEqual(await page.evaluate(() => ({ frame: __app.sim.frame, version: __app.sim.version })), stopped);
  const blocked = await page.evaluate(() => {
    try { __app.sim.step(); return false; }
    catch (error) { return error.message.includes('lost the WebGL context'); }
  });
  // An already-certified idle step can do no drawing. Explicit writes must
  // still be rejected before they mutate or swap either state history.
  assert(await page.evaluate(() => {
    try { __app.sim.paint({ center: new __app.THREE.Vector3(8, 8, 8), radius: 2, shape: 1, tool: 1, rate: 1 }); return false; }
    catch (error) { return error.message.includes('lost the WebGL context'); }
  }));
  assert(!errors.some(s => /Shader Error|program not valid|Mismatch between texture/.test(s)), errors.join('\n'));
  console.log('PASS: context loss/restoration halts automatic work and direct writes', { activeStepBlocked: blocked });
  await page.close();

  const shaderPage = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  await shaderPage.goto(`http://localhost:${port}/?size=64&preset=empty`, { waitUntil: 'domcontentloaded' });
  await ready(shaderPage);
  const failure = await shaderPage.evaluate(() => {
    const a = __app, T = a.THREE;
    const mat = new T.RawShaderMaterial({
      glslVersion: T.GLSL3, name: 'injectedShaderFailure', depthTest: false, depthWrite: false,
      vertexShader: 'in vec3 position; void main(){gl_Position=vec4(position,1.0);}',
      fragmentShader: 'precision highp float; out vec4 o; void main(){o=invalidShaderIdentifier;}',
    });
    const target = new T.WebGLRenderTarget(1, 1);
    try { a.sim.run(mat, target); return null; }
    catch (error) { return error.message; }
    finally { mat.dispose(); target.dispose(); }
  });
  assert.match(failure, /GPU shader failed: injectedShaderFailure/);
  assert.match(failure, /invalidShaderIdentifier/);
  await shaderPage.evaluate(() => __app.test.resume());
  await shaderPage.waitForTimeout(100);
  assert.equal(await shaderPage.evaluate(() => __app.sim.frame), 0);
  console.log('PASS: first shader failure preserves diagnostics and stops further frames');
  await shaderPage.close();

  const worldPage = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  await worldPage.goto(`http://localhost:${port}/?map=labWorld`, { waitUntil: 'domcontentloaded' });
  await ready(worldPage);
  await worldPage.evaluate(() => {
    window.savedWindow = __app.win;
    savedWindow.store.put(123, new Uint8Array([1, 2, 3]));
    __app.renderer.getContext().getExtension('WEBGL_lose_context').loseContext();
  });
  await worldPage.waitForFunction(() => document.getElementById('error').textContent.includes('Rendering and simulation stopped'));
  const preservation = await worldPage.evaluate(() => {
    const a = __app, settings = JSON.stringify(a.settings);
    const rejected = [() => a.openMap('empty'), () => a.setSize('64'),
      () => a.loadPreset('empty'), () => a.worldLoad([0, 0, 0])].map(fn => {
        try { fn(); return false; } catch (error) { return error.name === 'GraphicsFailure'; }
      });
    return { rejected, sameWindow: a.win === savedWindow, edit: [...savedWindow.store.map.get(123)],
      sameSettings: settings === JSON.stringify(a.settings) };
  });
  assert.deepEqual(preservation, { rejected: [true, true, true, true], sameWindow: true, edit: [1, 2, 3], sameSettings: true });
  console.log('PASS: failed-state map/load operations preserve the existing window, CPU edits and settings');
} finally { await browser.close(); }
