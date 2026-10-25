// One <=25s UI-only GPU slot: full map, plaque inspection/round-trip, three
// fixed interior viewpoints. No simulation stepping or fake global rAF.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const portAt = process.argv.indexOf('--port');
const port = portAt >= 0 ? Number(process.argv[portAt + 1]) : 54981;
const liveAt = process.argv.indexOf('--url');
const external = liveAt >= 0 ? process.argv[liveAt + 1] : null;
const bake = process.argv.includes('--bake-preview');
assert(!external || !bake, 'Do not bake a local asset from an unverified live build.');
const vite = external ? null : await startVite({ port, warmupEntries: ['/src/main.js', '/src/app.js'] });
const base = external ?? vite.url('/');
const out = '/tmp/tpt-lab-studies';
mkdirSync(out, { recursive: true });
const started = performance.now();
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 25000 });
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 800, height: 800 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (/GPU (validation|internal|out-of-memory)|GPU shader failed/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(new URL('?map=labStudies&view=realistic', base).href);
  await ready(page);
  await page.evaluate(async () => { __app.test.park(); await __app.test.ready(); });
  console.log('adapter:', await gpuInfo(page));
  const state = await page.evaluate(() => {
    const a = __app, signs = a.signs.toJSON();
    a.signs.fromJSON(signs);
    const specimen = a.signs.list.find(s => s.elementKey === 'SAND');
    if (!specimen) throw new Error('Missing inspectable sand specimen plaque');
    specimen.dom.plate.click();
    return { current: a.current(), dims: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
      count: signs.length, roundTrip: JSON.stringify(signs) === JSON.stringify(a.signs.toJSON()) };
  });
  assert.deepEqual(state.current, { map: 'labStudies', mode: 'sandbox' });
  assert.deepEqual(state.dims, [256, 96, 128]);
  assert(state.count > 12 && state.count < 64);
  assert(state.roundTrip, 'plaque element keys and text must survive save serialization');
  const dialog = page.getByRole('dialog', { name: 'Sand · SAND', exact: true });
  assert(await dialog.isVisible());
  assert.match(await dialog.textContent(), /Sand/);
  assert.match(await dialog.textContent(), /Powder/);
  await dialog.getByRole('button', { name: 'Close material facts' }).click();
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }' });
  for (const [key, eye, target] of [
    ['museum', [44, 12, 38], [44, 10, 78]],
    ['reactor', [128, 29, 84], [128, 9, 106]],
    ['containment', [212, 11, 36], [212, 9, 86]],
  ]) {
    await page.evaluate(([eye, target]) => {
      const a = __app;
      a.camera.position.fromArray(eye).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.fromArray(target).multiplyScalar(a.scale).add(a.volume.position);
      a.camera.fov = 80;
      a.camera.updateProjectionMatrix();
      a.controls.update();
      a.post.reset();
    }, [eye, target]);
    await render(page);
    await page.screenshot({ path: `${out}/${key}.png` });
  }
  assert.deepEqual(errors, []);
  const feet = await page.evaluate(async () => {
    await __app.pov.enter({ swoop: 0 });
    return __app.pov.player.pos.toArray();
  });
  assert.deepEqual(feet, [128, 2, 16], 'V must enter the indoor foyer, not land on the roof');
  if (bake) execFileSync('magick', [`${out}/museum.png`, '-resize', '400x400', '-quality', '85', 'public/maps/labStudies.webp']);
  console.log(`PASS full-size map, indoor player spawn, ${state.count} plaques, material inspector, save round-trip and three interior screenshots: ${out}`);
} finally {
  await browser?.close();
  await vite?.close();
  console.log(`Total test lifetime including player check, browser startup/compilation and cleanup: ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
