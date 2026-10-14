import assert from 'node:assert/strict';
import { launchBrowser, newTestPage } from './browser.mjs';

const base = process.env.BASE_URL ?? 'http://localhost:5197';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui' });
  // Exercise the real prompt without booting a GPU simulation.
  await page.route('**/shrine-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(`${base}/shrine-fixture`);
  const result = await page.evaluate(async () => {
    const { createInteract } = await import('/src/pov/interact.js');
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { HAND_REACH } = await import('/src/pov/constants.js');
    await import('/src/pov/pov.css');
    const interaction = createInteract();
    const eye = new THREE.Vector3();
    const dir = new THREE.Vector3(0, 0, -1);
    let taken = 0;
    let targets = [
      { id: 'farther', title: 'Farther', position: new THREE.Vector3(2, 0, 0), radius: 0.75, proximity: true, use() { taken++; } },
      { id: 'nearest', title: 'Nearest', position: new THREE.Vector3(1, 0, 0), radius: 0.75, proximity: true, use() { taken++; } },
    ];
    interaction.provide(() => targets);
    interaction.update(eye, dir, 0, true);
    const nearby = interaction.focus?.id;
    const noAutoTake = taken === 0;
    const button = document.querySelector('.pov-use button');
    const keyOnly = getComputedStyle(button.querySelector('.action-label')).display === 'none'
      && getComputedStyle(button).borderTopWidth === '0px'
      && button.querySelector('kbd').textContent === 'E';
    button.click();
    const clicked = taken === 1;
    interaction.use();
    const used = taken === 2;
    dir.negate();
    interaction.update(eye, dir, Infinity, true);
    const turned = interaction.focus?.id;
    eye.set(HAND_REACH * 3, 0, 0);
    interaction.update(eye, dir, Infinity, true);
    const outOfRange = interaction.focus === null;
    eye.set(0, 0, 0);
    targets = [{ ...targets[0], proximity: false }];
    interaction.update(eye, dir, Infinity, true);
    const ordinaryNeedsAim = interaction.focus === null;
    targets[0].position.set(0, 0, 2);
    interaction.update(eye, dir, Infinity, true);
    const ordinaryAimed = interaction.focus?.id === 'farther';
    interaction.update(eye, dir, Infinity, false);
    const inactive = interaction.focus === null;
    interaction.dispose();
    return { nearby, turned, noAutoTake, keyOnly, clicked, used, outOfRange, ordinaryNeedsAim, ordinaryAimed, inactive };
  });
  assert.deepEqual(result, {
    nearby: 'nearest', turned: 'nearest', noAutoTake: true, keyOnly: true,
    clicked: true, used: true, outOfRange: true, ordinaryNeedsAim: true, ordinaryAimed: true, inactive: true,
  });
  console.log('Shrine proximity, key-only prompt, click/E use, and ordinary aim checks passed.');
} finally {
  await browser.close();
}
