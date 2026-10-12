// GPU visual/interaction smoke: node tools/presentation-visual-check.mjs --port 54941
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '54941';
const out = '/tmp/tpt-presentation-check';
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('ERR_CONNECTION_REFUSED')) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('.mm-mode').filter({ hasText: 'Animal Crossing' }).click();
  assert.equal(await page.locator('.mm-card').count(), 1);
  assert.equal(await page.locator('.mm-card').getAttribute('data-map'), 'willowCove');
  assert.equal(await page.evaluate(() => !!window.__app), false, 'mode menu stays lightweight');
  await page.locator('.mm-mode').filter({ hasText: 'Sandbox' }).click();
  assert.equal(await page.locator('.mm-card[data-map="willowCove"]').count(), 1, 'Sandbox still includes Willow Cove');
  await page.goto(`http://127.0.0.1:${port}/?map=willowCove&mode=animalCrossing`);
  await ready(page);
  await page.waitForFunction(() => {
    const a = window.__app;
    return a.presentation.effect === 'rollingLog' && a.win.loaded && a.win.far.ready && !a.win.far.queue.length;
  }, null, { timeout: 180000, polling: 250 });
  const initial = await page.evaluate(async () => {
    const a = window.__app;
    a.test.park();
    a.autoRes.enabled = false;
    a.settings.upscale = 'native';
    a.post.settings.resolutionScale = 1;
    a.day.fixed = { az: 35, el: 32 };
    return { current: a.current(), version: a.sim.version, pov: a.pov.active };
  });
  assert.deepEqual(initial.current, { map: 'willowCove', mode: 'animalCrossing' });
  assert.equal(initial.pov, false, 'presentation mode does not force POV');
  await render(page);
  const curved = await page.screenshot({ path: `${out}/rolling.png` });
  await page.evaluate(() => window.__app.setMode('sandbox'));
  await render(page);
  const flat = await page.screenshot({ path: `${out}/flat.png` });
  const comparison = await page.evaluate(async ([before, after]) => {
    async function pixels(data) {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(310, 280, 790, 400).data; // no HUD
    }
    const a = await pixels(before), b = await pixels(after);
    let changed = 0, bright = 0, difference = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 30) changed++;
      if (a[i] + a[i + 1] + a[i + 2] > 60) bright++;
      difference += d;
    }
    return { changed: changed / (a.length / 4), bright: bright / (a.length / 4), difference: difference / (a.length / 4) };
  }, [curved.toString('base64'), flat.toString('base64')]);
  assert(comparison.changed > 0.05, `curvature must visibly change geometry: ${JSON.stringify(comparison)}`);
  assert(comparison.bright > 0.5, 'curved scene is not a black shader failure');
  assert.equal(await page.evaluate(() => window.__app.sim.version), initial.version, 'effect toggles do not change physics');
  console.log('PASS URL launch, render-only mode, visible A/B', comparison);

  // A real voxel target and an ordinary Three mesh share the same deformation.
  const target = await page.evaluate(async () => {
    const a = window.__app, T = a.THREE;
    const { E } = await import('/src/elements.js');
    const { warp } = await import('/src/gfx/presentationMath.js');
    await a.setMode('animalCrossing');
    a.test.render();
    const center = [484.5, 52.5, 524.5];
    const local = new T.Vector3(...center).sub(new T.Vector3(a.sim.origin.x, 0, a.sim.origin.z));
    a.sim.paint({ center: local, radius: 3, shape: 1, tool: E.WALL, rate: 1, replace: true });
    const meshWorld = [496.5, 68.5, 524.5];
    const mesh = new T.Mesh(new T.BoxGeometry(4 * a.scale, 4 * a.scale, 4 * a.scale), new T.MeshBasicMaterial({ color: 0xff00ff }));
    mesh.name = 'presentation-check-marker';
    mesh.position.set(...meshWorld).applyMatrix4(a.presentation.worldToScene);
    a.scene.add(mesh);
    a.test.render();
    const project = p => {
      const v = new T.Vector3(...warp(p, a.presentation.parameters)).applyMatrix4(a.presentation.worldToScene).project(a.camera);
      return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
    };
    return { voxel: project(center), mesh: project(meshWorld), center, id: E.WALL, origin: a.sim.origin, version: a.sim.version };
  });
  assert(target.voxel.x > 300 && target.voxel.x < 1150 && target.voxel.y > 100 && target.voxel.y < 700, 'voxel target is visible and outside HUD');
  await page.evaluate(() => { window.__app.hover.valid = false; window.__app.test.resume(); });
  await page.mouse.move(target.voxel.x, target.voxel.y);
  try {
    await page.waitForFunction(id => window.__app.hover.valid && window.__app.hover.id === id, target.id, { timeout: 15000 });
  } catch (error) {
    await page.evaluate(() => window.__app.test.park());
    await page.screenshot({ path: `${out}/pick-failure.png` });
    console.error({ target, hover: await page.evaluate(() => window.__app.hover), errors });
    throw error;
  }
  const hover = await page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    return { ...a.hover, cell: a.hover.cell.toArray() };
  });
  for (let i = 0; i < 3; i++) {
    const origin = [target.origin.x, 0, target.origin.z][i];
    assert(Math.abs(hover.cell[i] + origin - target.center[i]) <= 4, 'hover picks the deformed target in flat cell coordinates');
  }
  await render(page);
  const markerImage = await page.screenshot({ path: `${out}/targets.png` });
  const meshPixel = await page.evaluate(async ({ png, point }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data];
  }, { png: markerImage.toString('base64'), point: target.mesh });
  assert(meshPixel[0] > meshPixel[1] * 1.2 && meshPixel[2] > meshPixel[1] * 1.2, `mesh appears at its deformed projection: ${meshPixel}`);
  console.log('PASS screen picking and ordinary mesh projection', { hover, meshPixel });

  const lifecycle = await page.evaluate(async () => {
    const a = window.__app, revision = a.presentation.revision;
    await a.setMode('animalCrossing');
    const stable = a.presentation.revision === revision;
    await a.setMode('sandbox');
    a.test.render();
    const mesh = a.scene.getObjectByName('presentation-check-marker');
    const restored = mesh.frustumCulled && !a.presentation.active && a.presentation.uniforms.uWarpK.value === 0;
    a.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
    return { stable, restored, version: a.sim.version, current: a.current() };
  });
  assert(lifecycle.stable && lifecycle.restored, 'effect selection is idempotent and restores mesh state');
  assert.equal(lifecycle.version, target.version, 'picking and effect changes do not step physics');
  assert.equal(lifecycle.current.mode, 'sandbox');
  await page.evaluate(() => window.__app.openMap('lab', 'animalCrossing'));
  await page.waitForFunction(() => !window.__app.win && window.__app.settings.preset === 'lab');
  await render(page);
  assert.equal(await page.evaluate(() => window.__app.current().mode), 'sandbox', 'incompatible mode/map falls back safely');
  assert.deepEqual(errors, []);
  console.log('PASS mode lifecycle, incompatible-map fallback, no browser errors');
} finally {
  await browser.close();
}
