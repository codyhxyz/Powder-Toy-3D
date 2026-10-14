// One bounded GPU slot: real models/materials, no world simulation or animation loop.
// node tools/jetpack-visual-check.mjs [--port N]
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 1280, height: 650 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/jetpack-preview', route => route.fulfill({
    contentType: 'text/html',
    body: '<body style="margin:0;background:#202630"><script type="module">window.previewReady=true</script></body>',
  }));
  await page.goto(vite.url('/jetpack-preview'));
  await page.waitForFunction(() => window.previewReady);
  const result = await page.evaluate(async () => {
    const { THREE: T, createFigure, buildSpartan, buildCrasher, createRealFigure, meshLight, GLTFLoader, MeshoptDecoder }
      = await import('/tools/harness/jetpacks.js');
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/models/character/body.glb');
    const renderer = new T.WebGPURenderer({ antialias: true });
    renderer.setSize(1280, 650);
    document.body.append(renderer.domElement);
    const scene = new T.Scene();
    scene.background = new T.Color(0x202630);
    const camera = new T.OrthographicCamera(-12, 12, 6.1, -6.1, 0.1, 100);
    camera.position.set(0, 8, 24);
    camera.lookAt(0, 2.5, 0);
    meshLight.sun.value.set(0.35, 0.65, 0.67, 0);
    meshLight.cave.value.set(0.35, 0.35, 0.35, 0);
    const figures = [createFigure(), createRealFigure(gltf), createFigure(buildSpartan), createFigure(() => buildCrasher())];
    const states = figures.map((figure, i) => {
      scene.add(figure.root);
      figure.setVisible(true);
      return {
        feet: new T.Vector3(-9 + i * 6, 0, 0), scale: 1, yaw: -0.45,
        worldToGrid: new T.Matrix4(), speedH: 0, velY: 2, onGround: false,
        inLiquid: false, dead: false, jetting: true,
      };
    });
    for (let frame = 0; frame < 30; frame++) figures.forEach((f, i) => f.update(1 / 60, states[i]));
    await renderer.init();
    await renderer.compileAsync(scene, camera);
    await renderer.renderAsync(scene, camera);
    window.jetpackPreview = { renderer, scene, camera, figures };
    return figures.map(f => ({ nozzles: f.nozzles.length, flames: f.nozzles.filter(n => n.getObjectByName('jet-flame').visible).length }));
  });
  assert.ok(result.every(r => r.nozzles === 2 && r.flames === 2));
  await page.screenshot({ path: '/tmp/tpt-jetpacks.png' });
  assert.deepEqual(errors, []);
  console.log('Four live character rigs rendered with attached packs/flames: /tmp/tpt-jetpacks.png');
} finally {
  await browser?.close();
  await vite.close();
}
