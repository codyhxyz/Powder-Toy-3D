// One <=10s slot: production post shader on its existing fixture + real WebAudio, no app/world.
import assert from 'node:assert/strict';
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const vite = await startVite({ port: 43929, harness: true });
let browser;
const started = performance.now(), errors = [];
try {
  browser = await launchBrowser({ lifetimeMs: 10000 });
  const page = await openHarness(browser, vite, '/tools/harness/post.html', { timeout: 4000, errors });
  page.setDefaultTimeout(1500);
  const packed = await page.evaluate(() => __harness.run('sprintBlurPacked'));
  assert.ok(packed[0] > 49 && packed[0] < 52, `HDR highlight preserved through packed bilinear filtering: ${packed}`);
  const pixels = await page.evaluate(() => __harness.run('sprintBlur'));
  assert.equal(pixels.full.center, 0, 'aiming center unchanged');
  assert.ok(pixels.full.edge > pixels.low.edge * 2 && pixels.full.edge > 1, 'peripheral blur builds with speed');
  assert.equal(pixels.flat.edge, 0, 'constant radiance/coverage stays constant');
  assert.equal(pixels.hands.edge, 0, 'opaque viewmodels remain sharp');
  assert.deepEqual(await page.evaluate(() => __harness.failures), []);
  await page.locator('#view').screenshot({ path: '/tmp/tpt-sprint-blur.png' });

  await page.evaluate(async () => {
    const { createPovAudio, stats } = await import('/src/pov/audio.js');
    const player = { sprintRush: 0.2, dead: false, on: () => () => {} };
    const state = { active: true, player, sprintMusic: true };
    window.audioCheck = { state, stats };
    createPovAudio({ camera: { add() {} }, getVolume: () => null, getScale: () => 1, state: () => state });
  });
  await page.locator('#view').click();
  await page.waitForFunction(() => audioCheck.stats().sprintMusic?.playing);
  const low = await page.evaluate(() => audioCheck.stats().sprintMusic);
  assert.ok(low.cutoffHz > 500 && low.cutoffHz < 600);
  await page.evaluate(() => { audioCheck.state.player.sprintRush = 1; });
  await page.waitForFunction(() => audioCheck.stats().sprintMusic?.cutoffNowHz > 8000);
  const high = await page.evaluate(() => audioCheck.stats().sprintMusic);
  assert.equal(high.cutoffHz, 10000); assert.equal(high.playbackRate, 1);
  assert.ok(high.gain > low.gain);
  await page.evaluate(() => { audioCheck.state.sprintMusic = false; });
  await page.waitForFunction(() => !audioCheck.stats().sprintMusic.playing && audioCheck.stats().sprintMusic.gain === 0);
  await page.evaluate(() => { audioCheck.state.sprintMusic = true; audioCheck.state.player.headInLiquid = true; });
  await page.waitForFunction(() => audioCheck.stats().sprintMusic.playing && audioCheck.stats().filterHz === 420);
  await page.evaluate(() => { audioCheck.state.player.dead = true; });
  await page.waitForFunction(() => !audioCheck.stats().sprintMusic.playing);
  assert.deepEqual(errors, []);
  console.log('PASS sprint AV:', JSON.stringify({ packed, pixels, low, high }));
} finally {
  if (browser) await browser.close();
  console.log(`Browser attempt through close: ${((performance.now() - started) / 1000).toFixed(2)}s`);
  await vite.close();
}
