// One bounded slot: UI/visual checks, or --inventory native specimen census.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { PRESERVATION_SPAWN, preservationManifest } from '../src/lab/preservation/index.js';

const option = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const visualOnly = process.argv.includes('--visual-only');
const inventory = process.argv.includes('--inventory');
const uiOnly = !visualOnly, bake = process.argv.includes('--bake-preview');
const external = option('url', null), view = option('view', visualOnly ? 'realistic' : 'plain');
assert(!visualOnly || !process.argv.includes('--ui-only'), 'Choose UI or visual-only.');
assert(!inventory || !visualOnly && !process.argv.includes('--ui-only'), 'Choose inventory or UI/visual.');
assert(!bake || visualOnly && !external, 'Bake from local rendered geometry only.');
const vite = external ? null : await startVite({
  port: Number(option('port', 54983)), warmupEntries: ['/src/main.js', '/src/app.js'],
});
const base = external ?? vite.url('/');
const out = '/tmp/tpt-preservation';
mkdirSync(out, { recursive: true });
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 25000, why: inventory ? 'Preservation missing materials: native census before and after 24 physics ticks' : visualOnly ? 'Preservation story viewpoints, authentic material lighting; no body compilation' : 'Preservation first-person entry and material inspector' });
  const page = await newTestPage(browser, {
    mode: inventory ? 'manual' : 'ui', viewport: visualOnly || inventory ? { width: 400, height: 400 } : { width: 800, height: 600 },
  });
  page.setDefaultTimeout(13000);
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error('page error:', String(error)); });
  page.on('console', message => {
    if (/GPU (validation|internal|out-of-memory)|GPU shader failed/i.test(message.text())) errors.push(message.text());
  });
  // The existing raw-preset URL does not request a gamemode start. Reuse it
  // for visual checkpoints without compiling a body invisible in these shots.
  const query = visualOnly || inventory ? `?size=valley&preset=preservationLab&view=${view}` : `?map=preservationLab&view=${view}`;
  await page.goto(new URL(query, base).href);
  await page.waitForFunction(() => window.__app?.sim || document.getElementById('error')?.textContent, null, { timeout: 10000 });
  const bootError = await page.evaluate(() => document.getElementById('error')?.textContent ?? '');
  assert(!bootError, `boot failed: ${bootError}`);
  await ready(page);
  const bootState = () => ({
    map: __app.current(), mode: __app.pov?.mode, player: !!__app.pov?.player,
    physics: __app.physics?.readiness, failure: __app.lastGpuFailure,
    error: document.getElementById('error')?.textContent,
  });
  console.log('app ready:', await page.evaluate(bootState));
  try {
    if (!visualOnly && !inventory) await page.waitForFunction(() => __app.pov?.player && __app.pov.mode === 'on', null, { timeout: 7000 });
  } catch (error) {
    console.error('entry stalled:', await page.evaluate(bootState), errors);
    throw error;
  }
  const initial = await page.evaluate(async () => {
    const a = __app;
    a.test.park();
    await a.test.ready();
    return { current: a.current(), feet: a.pov.player?.pos.toArray(), signs: a.signs.list.length };
  });
  assert.deepEqual(initial.current, { map: 'preservationLab', mode: 'sandbox' });
  if (!visualOnly && !inventory) {
    assert.deepEqual(initial.feet, PRESERVATION_SPAWN);
    assert(initial.signs > 0 && initial.signs <= 32);
  }
  console.log('adapter:', (await gpuInfo(page)).description);
  if (inventory) {
    const entries = preservationManifest().catalog.filter(e => e.type === 'material' && e.key !== 'SINGULARITY')
      .map(e => ({ key: e.key, id: e.elementId }));
    const result = await page.evaluate(async entries => {
      const a = __app, initial = await a.sim.census(), seen = new Set();
      const missingInitially = entries.filter(e => !initial[e.id]?.n).map(e => e.key);
      for (let sample = 0; sample < 3; sample++) {
        a.test.step(8);
        await a.sim.gpuSync();
        const census = await a.sim.census();
        for (const e of entries) if (census[e.id]?.n) seen.add(e.key);
      }
      return { missingInitially, missingAfterPhysics: entries.filter(e => !seen.has(e.key)).map(e => e.key) };
    }, entries);
    console.log('native inventory:', result);
    assert.deepEqual(result.missingInitially, []);
    assert.deepEqual(result.missingAfterPhysics, []);
  }
  if (!uiOnly) {
    if (visualOnly) {
      await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }' });
      await page.evaluate(() => {
        const a = __app;
        a.camera.position.set(20, 33, 28).multiplyScalar(a.scale).add(a.volume.position);
        a.controls.target.set(36, 34, 52).multiplyScalar(a.scale).add(a.volume.position);
        a.camera.fov = 75; a.camera.updateProjectionMatrix(); a.controls.update(); a.post.reset();
      });
    }
    await render(page);
    await page.screenshot({ path: `${out}/arrival.png` });
    console.log('arrival checkpoint captured');
    if (bake) execFileSync('magick', [`${out}/arrival.png`, '-resize', '400x400^', '-gravity', 'center', '-extent', '400x400', '-quality', '85', 'public/maps/preservationLab.webp']);
  }
  if (!visualOnly && !inventory) {
    await page.evaluate(() => {
      const a = __app, saved = a.signs.toJSON();
      a.signs.fromJSON(saved);
      const sand = a.signs.list.find(s => s.elementKey === 'SAND');
      if (!sand?.sceneKey) throw new Error('Missing generated sand specimen plaque');
      sand.dom.plate.click();
    });
    const dialog = page.getByRole('dialog', { name: 'Sand · SAND', exact: true });
    assert(await dialog.isVisible());
    assert.match(await dialog.textContent(), /Powder/);
    await dialog.getByRole('button', { name: 'Close material facts' }).click();
  }
  if (!uiOnly) {
    // A diagnostic god-view checkpoint at an actually reachable inspection dais.
    await page.evaluate(() => {
      const a = __app;
      a.pov.exit(true);
      a.camera.position.set(184, 41, 92).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.set(224, 32, 92).multiplyScalar(a.scale).add(a.volume.position);
      a.camera.fov = 75; a.camera.updateProjectionMatrix();
      a.controls.update(); a.post.reset();
    });
    await render(page);
    await page.screenshot({ path: `${out}/empty-chamber.png` });
  }
  assert.deepEqual(errors, []);
  console.log(inventory ? 'PASS physical materials before/after native stepping (singularity intentionally absent)' : visualOnly ? `PASS full-size authored story viewpoints: ${out}` :
    `PASS Preservation entry at ${initial.feet}, ${initial.signs} nearby plaques, inspector and saved generated keys${uiOnly ? '' : `; story screenshots ${out}`}`);
} finally {
  await browser?.close();
  await vite?.close();
}
