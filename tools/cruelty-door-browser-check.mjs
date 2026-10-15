// One bounded UI slot. Normal-sized Androgen world, real use controls and
// native moving-leaf edit/readback. Explicit clock steps; no physics shrink.
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { APPEARANCE_HEADER as H, APPEARANCE_TRIANGLE_WORDS as TW } from '../src/world/import/appearanceFormat.js';

const at = process.argv.indexOf('--url');
const server = at < 0 ? await preview({
  preview: { host: '127.0.0.1', port: 54983, strictPort: true }, logLevel: 'warn',
}) : null;
const origin = server ? 'http://127.0.0.1:54983' : process.argv[at + 1];
const view = process.argv.includes('--realistic') ? 'realistic' : 'plain';
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
  });
  await page.goto(`${origin}/?map=androgenAssault&mode=crueltySquad&view=${view}`, { waitUntil: 'commit' });
  await ready(page);
  await page.waitForFunction(() => __app.pov.mission.active && __app.pov.mode === 'on');
  if (view === 'realistic') {
    await page.waitForFunction(() => __app.view.renderView === __app.settings.view
      && __app.view.volumeDrawn && __app.post.settings.cruelty);
  }
  await page.evaluate(({ header, stride }) => {
    const a = __app;
    a.test.park();
    const scene = a.win.scene;
    const door = scene.importManifest.interactions.doors.find(d => d.sourcePath === 'QodotMap/entity_2_Door');
    if (!door?.motion || !scene.appearanceWords) throw new Error('Motion-enabled source assets are not loaded');
    const { min, max } = door.motion.sweptBounds, origin = a.sim.origin.toArray();
    if (!min.every((n, k) => n >= origin[k] && max[k] <= origin[k] + [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz][k])) {
      throw new Error('Expected real source leaf is not fully resident');
    }
    const triangleAt = scene.appearanceWords[header] + door.appearanceTriangleIndices[0] * stride;
    globalThis.__doorCheck = {
      door, scene, triangleAt, original: [...scene.appearanceWords.slice(triangleAt, triangleAt + stride)],
    };
    // Stand in the real corridor on the side the leaf swings away from.
    a.pov.player.teleport(new a.THREE.Vector3(431.5, 264, 231).sub(a.sim.origin));
    a.pov.setLook(0, 0);
    a.pov.test.assumeLocked = true;
    a.pov.update(0);
  }, { header: H.trianglesAt, stride: TW });
  await render(page);
  await page.evaluate(() => __app.pov.update(0));
  const prompt = await page.evaluate(() => {
    const root = document.querySelector('.pov-use'), style = getComputedStyle(root);
    return {
      focus: __app.pov.interact.focus?.id, shown: root.classList.contains('show'),
      source: root.classList.contains('source-use'),
      width: root.getBoundingClientRect().width, height: root.getBoundingClientRect().height,
      background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow,
      title: getComputedStyle(root.querySelector('.pov-use-title')).display,
      keyDisplay: getComputedStyle(root.querySelector('.action-key')).display,
      readout: getComputedStyle(document.querySelector('.readout')).visibility,
    };
  });
  assert.equal(prompt.focus, 'imported:QodotMap/entity_2_Door', JSON.stringify(prompt));
  assert(prompt.shown && prompt.source);
  assert(prompt.width < 160 && prompt.height <= 36, `Prompt remains bulky: ${JSON.stringify(prompt)}`);
  assert.equal(prompt.background, 'rgba(0, 0, 0, 0)');
  assert.equal(prompt.border, '0px'); assert.equal(prompt.shadow, 'none');
  assert.equal(prompt.title, 'none'); assert.equal(prompt.readout, 'hidden');
  assert.equal(prompt.keyDisplay, 'flex', 'Bracket pseudos must not become three rows in the shared kbd grid');
  await page.screenshot({ path: '/tmp/cruelty-door-closed.png' });
  await page.getByRole('button', { name: 'Open Door', exact: true }).click();
  const mid = await page.evaluate(async () => {
    const a = __app, c = __doorCheck;
    for (let i = 0; i < 6; i++) {
      a.pov.importedInteractions.update(1 / 30);
      await a.win.pending;
    }
    a.pov.update(0);
    const state = c.scene.interactionState.states.get(c.door.sourcePath);
    return {
      progress: state?.progress, alive: [...state.alive], placed: [...state.placed],
      art: [...c.scene.appearanceWords.slice(c.triangleAt, c.triangleAt + 24)],
      original: c.original, error: a.pov.importedInteractions.lastError,
    };
  });
  assert(mid.progress > 0 && mid.progress < 1, 'Use must move through an intermediate physical pose');
  assert(mid.alive.every(Boolean), 'Native old-state reads must preserve every living source cell');
  assert(mid.placed.some(Boolean), 'The moving leaf remains physical, not merely retracted');
  assert.notDeepEqual(mid.art, mid.original, 'Original UV/plane records must move with the leaf');
  assert.equal(mid.art[3], mid.original[3], 'Source material identity is immutable');
  assert.equal(mid.error, null);
  await render(page);
  await page.screenshot({ path: '/tmp/cruelty-door-moving.png' });
  // Exercise the real E handler as well as click/tap, reversing mid-motion.
  await page.keyboard.press('e');
  const closed = await page.evaluate(async () => {
    const a = __app, c = __doorCheck;
    const state = c.scene.interactionState.states.get(c.door.sourcePath);
    const reversed = state.desiredProgress === 0;
    for (let i = 0; i < 40 && state.progress !== state.desiredProgress; i++) {
      a.pov.importedInteractions.update(1 / 30);
      await a.win.pending;
    }
    return { reversed, progress: state.progress, alive: [...state.alive], placed: [...state.placed],
      error: a.pov.importedInteractions.lastError };
  });
  assert(closed.reversed, 'E must reverse the actual moving door');
  assert.equal(closed.progress, 0); assert(closed.alive.every(Boolean)); assert(closed.placed.every(Boolean));
  assert.equal(closed.error, null);
  const opened = await page.evaluate(async () => {
    const a = __app, c = __doorCheck;
    await a.pov.importedInteractions.use(c.door);
    const state = c.scene.interactionState.states.get(c.door.sourcePath);
    for (let i = 0; i < 40 && state.progress !== 1; i++) {
      a.pov.importedInteractions.update(1 / 30);
      await a.win.pending;
    }
    a.pov.update(0);
    return { progress: state.progress, alive: [...state.alive], placed: [...state.placed] };
  });
  assert.equal(opened.progress, 1); assert(opened.alive.every(Boolean)); assert(opened.placed.some(Boolean));
  await render(page);
  await page.screenshot({ path: '/tmp/cruelty-door-open.png' });
  await page.evaluate(async () => {
    await __app.setMode('sandbox');
    __app.pov.update(0);
    await __app.test.renderOnce();
  });
  assert.equal(await page.locator('.pov-use').evaluate(root => root.classList.contains('source-use')), false);
  assert.notEqual(await page.locator('.readout').evaluate(root => getComputedStyle(root).visibility), 'hidden');
  assert.deepEqual(errors, []);
  console.log('PASS compact actual source prompt, click/E, native intermediate physical door, moving art, reversal and scoped mode exit.', {
    view, prompt, midProgress: mid.progress, survivingCells: mid.alive.length,
    screenshots: ['/tmp/cruelty-door-closed.png', '/tmp/cruelty-door-moving.png', '/tmp/cruelty-door-open.png'],
  });
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
