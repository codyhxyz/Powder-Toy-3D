// Generate one self-contained comparison from real, paused screenshots. No
// game files are changed; the second image only hides the HUD for a mock overlay.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { DEVICE_TYPES } from '../src/industry/catalog.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const output = path.resolve(arg('out', 'artifacts/factory-build-controls.html'));
const base = arg('url', 'https://tpt3d.codyh.xyz');
const generateOnly = process.argv.includes('--generate-only');
assert(!generateOnly || process.argv.includes('--reuse'), '--generate-only requires existing screenshots via --reuse');
const browser = generateOnly ? null : await launchBrowser();
try {
  let before, world, captured = new Date().toISOString().slice(0, 10);
  if (process.argv.includes('--reuse')) {
    // Keep the comparison's evidence fixed while revising only the proposal.
    const previous = readFileSync(output, 'utf8');
    before = Buffer.from(previous.match(/<img src="data:image\/jpeg;base64,([^"]+)"/)[1], 'base64');
    world = Buffer.from(previous.match(/url\('data:image\/jpeg;base64,([^']+)'\)/)[1], 'base64');
    captured = previous.match(/captured (\d{4}-\d{2}-\d{2})/)[1];
  } else {
    const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/?map=quarry&mode=factory&view=plain`);
    await ready(page);
    await page.waitForFunction(() => window.__app.scene.getObjectByName('Industry')?.visible);
    await page.evaluate(() => {
      const a = window.__app; a.test.park();
      const world = xyz => new a.THREE.Vector3(...xyz).multiplyScalar(a.scale).add(a.volume.position);
      a.camera.position.copy(world([73, 38, 82])); a.controls.target.copy(world([50, 10, 53])); a.controls.update();
    });
    await page.locator('.industry-build').click();
    await page.evaluate(() => window.__app.industry.update(0, false));
    await render(page);
    before = await page.screenshot({ type: 'jpeg', quality: 88 });
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }' });
    world = await page.screenshot({ type: 'jpeg', quality: 88 });
    await page.close();
  }

  const unlocks = { miner: 12, lift: 12, pump: 48, heater: 96 };
  const machines = Object.fromEntries(Object.entries(DEVICE_TYPES).map(([id, m]) => [id, { ...m, unlock: unlocks[id] ?? 0 }]));
  const template = readFileSync(new URL('../artifacts/factory-build-controls.source.html', import.meta.url), 'utf8');
  const html = template.replace('@@BEFORE@@', `data:image/jpeg;base64,${before.toString('base64')}`)
    .replace('@@WORLD@@', `data:image/jpeg;base64,${world.toString('base64')}`)
    .replace('@@DATE@@', captured)
    .replace('@@ICONS@@', readFileSync(new URL('../src/industry/icons.js', import.meta.url), 'utf8').replace('export function machineIcon', 'function machineIcon'))
    .replace('@@MACHINES@@', JSON.stringify(machines).replace(/</g, '\\u003c'));
  assert(!/@@[A-Z]+@@/.test(html));
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, html);

  if (generateOnly) {
    console.log(`Updated artifact: ${output}\nReused existing screenshots. JavaScript syntax checked; no browser or GPU testing.`);
  } else {
  const check = await newTestPage(browser, { mode: 'ui', viewport: { width: 1600, height: 1120 } });
  const errors = []; check.on('pageerror', error => errors.push(String(error)));
  await check.goto(pathToFileURL(output).href);
  assert.equal(await check.locator('.machine').count(), 8);
  assert.equal(await check.locator('.machine .industry-icon svg').count(), 8, 'keep the actual machine illustrations');
  assert(!/Ready to build|Selected/.test(await check.locator('.game').innerText()), 'no redundant readiness labels');
  assert.equal(await check.locator('.machine[aria-pressed=true]').count(), 1, 'selection stays visually and semantically explicit');
  await check.getByRole('button', { name: 'Try the new controls', exact: true }).click();
  await check.getByRole('button', { name: 'Done', exact: true }).click();
  assert(await check.locator('#tray').isHidden());
  await check.getByRole('button', { name: 'Build', exact: true }).click();
  await check.locator('#rotate').click();
  assert.match(await check.locator('#rotate').innerText(), /90/);
  const rect = await check.locator('#game').boundingBox();
  await check.mouse.click(rect.x + rect.width * .64, rect.y + rect.height * .49);
  assert.equal(await check.locator('.placed').count(), 1);
  assert.equal(await check.locator('#credits').innerText(), '22 credits');
  await check.locator('#dismantle').click();
  await check.locator('.placed').click();
  assert.equal(await check.locator('#credits').innerText(), '24 credits');
  assert.equal(await check.locator('.placed').count(), 0);
  await check.locator('#reset').click();
  await check.getByRole('button', { name: 'Side by side', exact: true }).click();
  await check.screenshot({ path: '/tmp/factory-controls-artifact-desktop.png', fullPage: true });
  await check.setViewportSize({ width: 740, height: 1000 });
  await check.screenshot({ path: '/tmp/factory-controls-artifact-compact.png', fullPage: true });
  assert(await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(`Artifact ready: ${output}\nPASS open/close, rotation, placement, full refund, responsive layout; no page errors.`);
  }
} finally {
  await browser?.close();
}
