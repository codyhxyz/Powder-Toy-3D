// One bounded UI slot: actual mission result clicks and map/mode lifecycle.
// Plain view is sufficient: this checks UI/restart, not source-art rendering.
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const at = process.argv.indexOf('--url');
const server = at < 0 ? await preview({
  preview: { host: '127.0.0.1', port: 54981, strictPort: true }, logLevel: 'warn',
}) : null;
const origin = server ? 'http://127.0.0.1:54981' : process.argv[at + 1];
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?map=paradise&mode=crueltySquad&view=plain`, { waitUntil: 'commit' });
  await ready(page);
  await page.waitForFunction(() => __app.pov.mission.active);
  // Exercise the real failure controller/HUD, without spending a slot waiting
  // for an enemy to kill the body. No synthetic result button or retry handler.
  const fail = () => page.evaluate(() => {
    const p = __app.pov;
    p.player.hurt(1, 'Verification', { lethal: true, shielded: false });
    p.mission.update(0, p.updateEntities(0));
    __app.requestRender();
    return p.mission.state.phase;
  });
  assert.equal(await fail(), 'failed');
  await page.evaluate(() => {
    globalThis.__retryBefore = { sim: __app.sim.id, actors: [...__app.pov.mission.actors] };
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => __app.pov.mission.active && __app.sim.id !== __retryBefore.sim);
  await ready(page);
  const restarted = await page.evaluate(() => ({
    mode: __app.current().mode,
    alive: !__app.pov.player.dead,
    eliminated: __app.pov.mission.state.eliminated,
    newActors: __app.pov.mission.actors.every(actor => !__retryBefore.actors.includes(actor)),
    resultHidden: document.querySelector('.mission-result').hidden,
  }));
  assert.deepEqual(restarted, {
    mode: 'crueltySquad', alive: true, eliminated: 0, newActors: true, resultHidden: true,
  });
  await render(page);
  await page.screenshot({ path: '/tmp/cruelty-retry.png' });
  assert.equal(await fail(), 'failed');
  await page.getByRole('button', { name: 'Leave mission', exact: true }).click();
  await page.waitForFunction(() => __app.current().mode === 'sandbox' && !__app.pov.mission.engaged);
  assert.deepEqual(errors, []);
  console.log('PASS live result Retry rebuilds world/actors, clears failure, respawns; Leave returns to Sandbox.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
