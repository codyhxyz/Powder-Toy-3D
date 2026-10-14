// Pixel regression: expired particles must stay dead when another shot fires.
// Start Vite on your own port, then: node tools/shot-particles-check.mjs --port PORT
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const port = process.argv[process.argv.indexOf('--port') + 1];
assert.ok(/^\d+$/.test(port), '--port PORT is required');
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual' });
  await page.route('**/shot-particles-fixture', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Shot particle regression</title>',
  }));
  await page.goto(`http://localhost:${port}/shot-particles-fixture`);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.webgpu.js');
    const { createBillboards } = await import('/src/gfx/billboards.js');
    const renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer._animation.stop();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
    camera.position.z = 5;
    const target = new THREE.RenderTarget(64, 32);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0, 1);
    const pool = createBillboards({ name: 'shot-expiry', capacity: 8 });
    scene.add(pool.mesh);
    const spawn = (x) => pool.burst(1, (p) => p.set(
      new THREE.Vector3(x, 0, 0), new THREE.Vector3(), 1, [1, 1, 1], 1, 0.055, { move: 0 },
    ));
    const draw = async () => {
      renderer._nodes.nodeFrame.update();
      renderer.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32);
      const energy = (lo, hi) => {
        let sum = 0;
        for (let y = 0; y < 32; y++) for (let x = lo; x < hi; x++) sum += pixels[(y * 64 + x) * 4];
        return sum;
      };
      return { left: energy(0, 32), right: energy(32, 64), count: pool.count() };
    };
    try {
      pool.mesh.visible = true;
      await renderer.compileAsync(scene, camera);
      spawn(-1); pool.update(0);
      const first = await draw();
      pool.update(0.1);
      const expired = await draw();
      spawn(1); pool.update(0.1);
      const second = await draw();
      pool.update(0.2);
      spawn(1); pool.update(0.2);
      const third = await draw();
      return { first, expired, second, third };
    } finally {
      pool.dispose(); target.dispose(); renderer.dispose();
    }
  });
  console.log(JSON.stringify(result));
  assert.ok(result.first.left > 0 && result.first.right === 0, 'first shot appears only at its origin');
  assert.equal(result.expired.left + result.expired.right, 0, 'expired shot disappears');
  for (const name of ['second', 'third']) {
    assert.equal(result[name].left, 0, `${name}: old shot never reappears`);
    assert.ok(result[name].right > 0, `${name}: new shot is visible`);
    assert.equal(result[name].count, 1);
  }
  console.log('PASS: shot expiry and repeated-shot pixels');
} finally {
  await browser.close();
}
