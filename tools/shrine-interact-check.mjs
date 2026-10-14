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
    const { CELL_M } = await import('/src/scale.js');
    await import('/src/ui/styles.css');
    await import('/src/pov/pov.css');
    await import('/src/pov/tools/hotbar.css');
    await import('/src/fonts.css');
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
    // A shrine must not inherit the 6.75 m tool-pickup range, in any direction.
    const nearest = targets[1];
    targets = [nearest];
    const range = 1.2 / CELL_M;
    const boundary = [];
    for (const axis of ['x', 'y', 'z']) {
      eye.copy(nearest.position); eye[axis] += range - 0.01;
      interaction.update(eye, dir, Infinity, true);
      boundary.push(interaction.focus === nearest);
      eye.copy(nearest.position); eye[axis] += range + 0.01;
      interaction.update(eye, dir, Infinity, true);
      boundary.push(interaction.focus === null && !interaction.use());
    }
    eye.copy(nearest.position).add(new THREE.Vector3(range * 0.8, 0, range * 0.8));
    interaction.update(eye, dir, Infinity, true);
    const diagonalOut = interaction.focus === null;
    // Real shrine geometry: floor at y=1, eye at y=6, orb over a y=2 plinth.
    nearest.position.set(0, 4.75, 0);
    eye.set(0, 6, 3);
    interaction.update(eye, dir, Infinity, true);
    const besidePlinth = interaction.focus === nearest;
    eye.set(0, 0, 0);
    targets = [{ ...nearest, position: new THREE.Vector3(2, 0, 0), proximity: false }];
    interaction.update(eye, dir, Infinity, true);
    const ordinaryNeedsAim = interaction.focus === null;
    targets[0].position.set(0, 0, 2);
    interaction.update(eye, dir, Infinity, true);
    const ordinaryAimed = interaction.focus?.id === 'nearest';
    targets[0].position.set(0, 0, HAND_REACH);
    interaction.update(eye, dir, Infinity, true);
    const ordinaryRangeUnchanged = interaction.focus?.id === 'nearest';
    interaction.update(eye, dir, Infinity, false);
    const inactive = interaction.focus === null;
    const hidden = getComputedStyle(document.querySelector('.pov-use')).visibility === 'hidden';
    targets = [{ ...nearest, position: new THREE.Vector3(1, 0, 0), title: '😇 Saving Grace',
      lines: ['A blow that would kill you leaves you at the last sliver of health instead.'] }];
    interaction.update(eye, dir, Infinity, true);
    // Keep the real prompt around for responsive layout checks.
    window.fixtureInteraction = interaction;
    const held = document.createElement('div');
    held.className = 'hb-held show';
    held.textContent = 'Jackhammer';
    document.body.append(held);
    return { nearby, turned, noAutoTake, keyOnly, clicked, used, outOfRange, boundary,
      diagonalOut, besidePlinth, ordinaryNeedsAim, ordinaryAimed, ordinaryRangeUnchanged, inactive, hidden };
  });
  assert.deepEqual(result, {
    nearby: 'nearest', turned: 'nearest', noAutoTake: true, keyOnly: true,
    clicked: true, used: true, outOfRange: true, boundary: Array(6).fill(true),
    diagonalOut: true, besidePlinth: true, ordinaryNeedsAim: true, ordinaryAimed: true,
    ordinaryRangeUnchanged: true, inactive: true, hidden: true,
  });
  for (const [width, height] of [[1280, 720], [390, 844], [320, 568], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const prompt = document.querySelector('.pov-use');
      const box = prompt.getBoundingClientRect();
      const title = prompt.querySelector('.pov-use-title').getBoundingClientRect();
      const lines = prompt.querySelector('.pov-use-lines').getBoundingClientRect();
      const button = prompt.querySelector('button').getBoundingClientRect();
      const held = document.querySelector('.hb-held').getBoundingClientRect();
      return {
        contained: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        readable: getComputedStyle(prompt).backgroundColor === 'rgb(22, 26, 35)',
        separated: title.bottom <= lines.top && lines.right <= button.left,
        clearOfTool: box.right <= held.left || box.bottom <= held.top || box.left >= held.right,
        hitTarget: button.width >= 44 && button.height >= 44,
        noOverflow: prompt.scrollWidth <= prompt.clientWidth,
      };
    });
    assert.deepEqual(layout, { contained: true, readable: true, separated: true,
      clearOfTool: true, hitTarget: true, noOverflow: true }, `${width}×${height}`);
    if (process.env.SCREENSHOT_DIR && (width === 1280 || width === 390))
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/shrine-${width}.png` });
  }
  await page.evaluate(() => window.fixtureInteraction.dispose());
  console.log('Shrine 1.2 m boundary, plinth geometry, click/E, ordinary range and responsive prompt checks passed.');
} finally {
  await browser.close();
}
