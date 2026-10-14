// Live integration: node tools/village-check.mjs --port 54961 --out /tmp/village-check
// Uses the shared low-cadence browser helper; do not run beside another GPU suite.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const out = option('out', '/tmp/village-check'); mkdirSync(out, { recursive: true });
async function homePose(page, x, z, yaw = -Math.PI / 2) {
  await page.evaluate(({ x, z, yaw }) => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 96 + x, 24, a.win.P.size[2] / 2 + 60 + z).sub(a.sim.origin));
    a.pov.setLook(yaw, a.pov.village.carrying ? a.pov.camera.look.pitch : -0.25); a.test.resume();
  }, { x, z, yaw });
  await page.waitForFunction(() => {
    const a = __app, expected = a.pov.player.pos.clone().multiplyScalar(a.scale).add(a.volume.position);
    const aimedDown = new a.THREE.Vector3(0, 0, -1).applyQuaternion(a.pov.camera.pose.quat).y < -0.92;
    return a.pov.village.avatar.position.distanceTo(expected) < 0.01 && (!a.pov.village.carrying || aimedDown);
  });
  await page.evaluate(() => __app.test.park());
}
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errors.push(m.text()); });
  await page.goto(`http://localhost:${option('port', '54961')}/?map=willowCove&mode=animalCrossing`);
  await ready(page);
  await page.waitForFunction(() => window.__app?.pov.mode === 'on' && window.__app.pov.village.avatar.visible, null, { timeout: 180000 });
  await page.evaluate(() => document.fonts.ready);
  const first = await page.evaluate(() => {
    const a = window.__app; a.test.park();
    return { mode: a.current().mode, home: a.pov.village.context.home, feet: a.pov.player.pos.clone().add(a.sim.origin).toArray(),
      third: a.pov.camera.third, originalVisible: a.pov.figure.root.visible, residents: a.pov.village.residents, state: a.pov.village.state };
  });
  assert.equal(first.mode, 'animalCrossing'); assert.equal(first.home, true);
  assert.ok(Math.abs(first.feet[1] - 24) < 1, 'spawn on indoor floor, not roof');
  assert.equal(first.third, true); assert.equal(first.originalVisible, false);
  assert.equal(await page.locator('.game-hud').isVisible(), false, 'peaceful mode hides match controls');
  assert.deepEqual(first.residents.map(r => r.species), ['bear', 'rabbit', 'cat']);
  const inventoryIds = s => [...s.placed, ...s.pockets, ...s.storage].map(i => i.id).sort();
  const original = inventoryIds(first.state);
  const controls = page.locator('.village-controls');
  assert.equal(await controls.getByRole('button').count(), 1, 'pockets stay visible; no irrelevant arrange action');
  assert.equal(await controls.locator('[data-action="pockets"] .action-key').textContent(), 'I');
  assert.equal(await controls.getByText('H', { exact: true }).count(), 0, 'no separate arrange shortcut');
  await render(page); await page.screenshot({ path: join(out, 'home.png') });
  const panel = page.locator('.village-panel');
  await controls.getByRole('button', { name: 'Pockets', exact: true }).click();
  await panel.getByRole('heading', { name: 'Your pockets' }).waitFor();
  assert.equal(await controls.getByRole('button').count(), 0, 'world actions hide while a menu owns input');
  await panel.getByRole('button', { name: 'Close pockets or dialogue' }).click();
  await page.keyboard.down('i'); await page.keyboard.down('i');
  assert.equal(await panel.isVisible(), true, 'holding the shortcut does not toggle the menu repeatedly');
  await page.keyboard.up('i'); await page.keyboard.press('Escape');
  await homePose(page, 3.5, 0);
  await controls.getByRole('button', { name: 'Pockets', exact: true }).click();
  await panel.waitFor({ state: 'visible' });
  await render(page); await page.screenshot({ path: join(out, 'pockets-desktop.png') });
  await panel.getByRole('button', { name: 'Leafy plant', exact: true }).click();
  await page.screenshot({ path: join(out, 'pocket-actions-desktop.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Take out to place', exact: true }).click();
  assert.equal(await panel.isVisible(), false, 'placement happens in the world, not in a floor editor');
  assert.equal(await page.evaluate(() => __app.pov.village.blocked), false, 'carrying leaves movement enabled');
  assert.ok(await page.evaluate(() => __app.pov.village.carrying?.id === 'plant' && __app.pov.village.state.pockets.some(i => i.id === 'plant')), 'grab is provisional until drop');
  await homePose(page, 3.5, 0);
  await render(page); await page.screenshot({ path: join(out, 'carry-desktop.png'), animations: 'disabled' });
  await page.keyboard.down('a'); await page.evaluate(() => __app.test.resume());
  await page.waitForFunction(() => __app.pov.village.context.player.z < -0.6);
  await page.keyboard.up('a'); await page.evaluate(() => __app.test.park());
  assert.ok(await page.evaluate(() => __app.pov.village.carrying.z < 0), 'real movement keys carry the furniture through the world');
  const shiftedCarry = await page.evaluate(() => {
    const a = __app, v = a.pov.village, before = v.carrying, delta = new a.THREE.Vector3(8, 0, 16);
    try {
      a.sim.origin.add(delta); a.pov.player.pos.sub(delta); v.update(0, true, a.pov.camera.look.yaw);
      return { before, after: v.carrying };
    } finally { a.sim.origin.sub(delta); a.pov.player.pos.add(delta); v.update(0, true, a.pov.camera.look.yaw); }
  });
  assert.deepEqual(shiftedCarry.after, shiftedCarry.before, 'streaming-origin shifts preserve the absolute carry target');
  await homePose(page, 0, 0, 0);
  assert.equal(await controls.getByRole('button', { name: 'Set down', exact: true }).isDisabled(), true, 'blocked drops explain the invalid footprint');
  await page.keyboard.press('e');
  assert.ok(await page.evaluate(() => __app.pov.village.state.pockets.some(i => i.id === 'plant')), 'invalid drop never loses the furniture');
  await render(page); await page.screenshot({ path: join(out, 'carry-blocked.png'), animations: 'disabled' });
  await homePose(page, 3.5, 0);
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => __app.pov.village.state.placed.find(i => i.id === 'plant')?.x), 6);
  assert.equal(await page.evaluate(() => __app.pov.camera.look.pitch), -0.25, 'drop restores the previous camera pitch');
  assert.equal(await page.evaluate(() => __app.pov.camera.third), true, 'drop restores the previous perspective');
  assert.equal(await controls.locator('[data-action="interact"] .action-key').textContent(), 'E');
  await page.keyboard.down('e'); await page.keyboard.down('e'); await page.keyboard.up('e');
  assert.ok(await page.evaluate(() => __app.pov.village.carrying), 'holding E grabs once, never immediately drops again');
  assert.equal(await panel.isVisible(), false, 'grabbing placed furniture never opens a menu');
  await page.keyboard.press('r');
  await homePose(page, 3.5, -2);
  assert.equal(await page.evaluate(() => __app.pov.village.carrying.z), -2, 'carried furniture follows the player');
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => __app.pov.village.state.placed.find(i => i.id === 'plant')?.rotation), 1);
  assert.equal(await page.evaluate(() => __app.pov.village.state.placed.find(i => i.id === 'plant')?.z), -2);
  await page.keyboard.press('e'); await page.keyboard.press('i');
  assert.ok(await page.evaluate(() => __app.pov.village.state.pockets.some(i => i.id === 'plant')));
  await homePose(page, -2.5, 5, Math.PI / 2);
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => __app.pov.village.carrying.id), 'bed');
  const throughOldFootprint = await page.evaluate(() => {
    const a = __app, v = a.pov.village;
    v.beforeBody(); a.pov.player.pos.x -= 3.5; v.afterBody();
    return v.context.player.x;
  });
  assert.equal(throughOldFootprint, -6, 'a lifted piece no longer collides at its old position');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => __app.pov.village.carrying), null);
  assert.equal(await page.evaluate(() => __app.pov.village.context.player.x), -2.5, 'cancel cannot trap the player in the restored piece');
  assert.deepEqual(await page.evaluate(() => __app.pov.village.state.placed.find(i => i.id === 'bed')), first.state.placed[0], 'cancel preserves the original furniture');
  const collision = await page.evaluate(() => {
    const a = __app, p = a.pov.player;
    p.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 96, 24, a.win.P.size[2] / 2 + 65).sub(a.sim.origin));
    a.pov.village.beforeBody(); p.pos.x -= 6; a.pov.village.afterBody();
    const x = p.pos.x + a.sim.origin.x - (a.win.P.size[0] / 2 - 96);
    p.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 102, 30, a.win.P.size[2] / 2 + 65).sub(a.sim.origin));
    a.pov.village.beforeBody(); p.pos.y = 25; p.vel.y = -5; a.pov.village.afterBody();
    const landed = p.pos.y;
    p.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 96 + 3, 24, a.win.P.size[2] / 2 + 60 + 3).sub(a.sim.origin));
    return { x, landed };
  });
  assert.ok(collision.x > -4, 'furniture blocks movement, including a swept six-cell move');
  assert.ok(collision.landed > 26.8, 'jumping onto furniture has landing support');
  await homePose(page, 3, 3, -Math.PI * 0.75);
  await page.keyboard.press('e');
  await page.screenshot({ path: join(out, 'dresser-desktop.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Pockets', exact: true }).click();
  await panel.getByRole('button', { name: 'Leafy plant', exact: true }).click();
  await panel.getByRole('button', { name: 'Store in dresser', exact: true }).click();
  assert.ok(await page.evaluate(() => __app.pov.village.state.storage.some(i => i.id === 'plant')));
  await panel.getByRole('button', { name: 'Dresser', exact: true }).click();
  await panel.getByRole('button', { name: 'Leafy plant', exact: true }).click();
  await panel.getByRole('button', { name: 'Take out', exact: true }).click();
  const storageWarning = await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
      __app.pov.village.act({ type: 'store', id: 'plant' });
      return __app.pov.village.context.warning;
    } finally { Storage.prototype.setItem = write; }
  });
  assert.match(storageWarning, /memory only/);
  await page.evaluate(() => __app.pov.village.act({ type: 'withdraw', id: 'plant' }));
  const saved = await page.evaluate(() => __app.pov.village.state);
  assert.deepEqual(inventoryIds(saved), original);
  await page.keyboard.press('Escape');
  const denied = await page.evaluate(() => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 40, 24, a.win.P.size[2] / 2 + 60).sub(a.sim.origin));
    return a.pov.village.act({ type: 'take', id: 'bed' });
  });
  assert.ok(denied.error, 'neighbors cannot be robbed');
  await page.evaluate(() => __app.test.resume());
  await page.waitForFunction(() => {
    const a = __app, p = a.pov.player.pos;
    return document.querySelector('.village-location')?.textContent === 'Maple’s home'
      && p.x > 16 && p.x < a.sim.g.nx - 16 && p.z > 16 && p.z < a.sim.g.nz - 16 && !a.win.pending;
  }, null, { timeout: 180000 });
  await page.evaluate(() => {
    const a = __app, r = a.pov.village.residents[0];
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 40 + r.x, 24, a.win.P.size[2] / 2 + 60 + r.z - 4).sub(a.sim.origin));
    a.pov.setLook(Math.PI, -0.12);
  });
  await page.waitForFunction(() => {
    const a = __app, expected = a.pov.player.pos.clone().multiplyScalar(a.scale).add(a.volume.position);
    return a.pov.village.avatar.position.distanceTo(expected) < 0.01;
  });
  await page.keyboard.press('e');
  await panel.getByRole('heading', { name: 'Maple', exact: true }).waitFor();
  await page.waitForFunction(() => __app.pov.village.speech.played > 0);
  await page.keyboard.press('e');
  assert.equal(await panel.locator('.village-typed').textContent(), await panel.locator('.village-dialogue .sr-only').textContent(), 'E completes the text reveal');
  const greeting = await panel.locator('.village-typed').textContent();
  await panel.getByRole('button', { name: 'Keep chatting', exact: true }).click();
  await page.keyboard.press('e');
  assert.notEqual(await panel.locator('.village-typed').textContent(), greeting, 'continue advances the conversation');
  await panel.getByRole('button', { name: 'Mute animalese', exact: true }).click();
  assert.equal(await page.evaluate(() => __app.pov.village.speech.queued), 0);
  await render(page); await page.screenshot({ path: join(out, 'neighbor.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mm.open').count(), 0, 'Escape closes dialogue, not the game');
  await page.evaluate(() => __app.test.resume());
  await page.keyboard.press('F5');
  await page.waitForFunction(() => !__app.pov.village.avatar.visible);
  await render(page); await page.screenshot({ path: join(out, 'resident.png') });
  await page.evaluate(() => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 96, 24, a.win.P.size[2] / 2 + 60).sub(a.sim.origin));
    a.pov.village.act({ type: 'grab', id: 'plant' });
  });
  assert.ok(await page.evaluate(() => __app.pov.village.carrying), 'mode-exit fixture carries a piece');
  await page.evaluate(async () => { await __app.setMode('sandbox'); });
  assert.equal(await page.evaluate(() => __app.pov.village.carrying), null, 'mode exit cancels an unfinished move without saving it');
  assert.equal(await page.evaluate(() => __app.pov.village.enabled || document.body.classList.contains('village-on')), false);
  assert.equal(await page.evaluate(() => __app.pov.village.root.children.length), 0, 'mode exit releases resident/furniture meshes');
  await page.evaluate(async () => { __app.test.resume(); await __app.setMode('animalCrossing'); });
  await page.waitForFunction(() => __app.pov.mode === 'on', null, { timeout: 180000 });
  await page.evaluate(() => __app.test.park());
  assert.deepEqual(await page.evaluate(() => __app.pov.village.state), saved, 'furniture survives mode round trip');
  const focusAfterRestart = await page.evaluate(async () => {
    const a = __app;
    a.test.resume();
    const first = a.setMode('animalCrossing');
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await Promise.all([first, a.setMode('animalCrossing')]);
    return a.worldFocus;
  });
  assert.equal(focusAfterRestart, null, 'overlapping village starts release temporary world focus');
  await page.waitForFunction(() => __app.pov.mode === 'on', null, { timeout: 180000 });
  await page.evaluate(() => __app.test.park());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('i');
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'mobile pockets fit');
  await render(page); await page.screenshot({ path: join(out, 'pockets-mobile.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { __app.test.resume(); __app.openMap('lab', 'sandbox'); });
  await page.waitForFunction(() => !__app.win && __app.settings.preset === 'lab');
  await page.evaluate(() => __app.test.park());
  assert.equal(await page.locator('.village-hud').isVisible(), false);
  // The same action helper also makes the standard look-at prompt tappable.
  await page.evaluate(() => {
    const a = __app;
    window.actionUsed = 0;
    a.pov.interact.provide(() => [{ id: 'note', title: 'Test note', verb: 'Read note', radius: 1,
      position: new a.THREE.Vector3(0, 0, -2), use: () => window.actionUsed++ }]);
    a.pov.interact.update(new a.THREE.Vector3(), new a.THREE.Vector3(0, 0, -1), 10, true);
  });
  await page.locator('.pov-use').getByRole('button', { name: 'Read note' }).click();
  assert.equal(await page.evaluate(() => window.actionUsed), 1);
  await page.evaluate(() => {
    const a = __app;
    a.pov.interact.update(new a.THREE.Vector3(), new a.THREE.Vector3(0, 0, -1), 10, false);
  });
  assert.equal(await page.locator('.pov-use .action-buttons').isVisible(), false, 'used target can disappear immediately');
  assert.deepEqual(errors, [], 'no page or shader errors');
  await page.close();

  const mobile = await newTestPage(browser, { mode: 'ui', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', e => errors.push(String(e)));
  await mobile.goto(`http://localhost:${option('port', '54961')}/?map=willowCove&mode=animalCrossing`);
  await ready(mobile);
  await mobile.waitForFunction(() => __app.pov.mode === 'on' && __app.pov.village.avatar.visible);
  await mobile.evaluate(() => document.fonts.ready);
  const touchActions = mobile.locator('.village-controls');
  const touchPanel = mobile.locator('.village-panel');
  assert.equal(await mobile.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), true);
  assert.equal(await touchActions.locator('.action-key').first().isVisible(), false, 'phones show action names, not keyboard keys');
  const layout = await mobile.evaluate(() => {
    const actions = [...document.querySelectorAll('.village-controls button')].map(b => b.getBoundingClientRect());
    const stick = document.querySelector('.touch-stick').getBoundingClientRect();
    const jump = document.querySelector('.touch-actions .touch-row:last-child').getBoundingClientRect();
    const place = document.querySelector('.village-place').getBoundingClientRect();
    const camera = document.querySelector('.cam-seg').getBoundingClientRect();
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return !overlaps(place, camera) && actions.every(a => a.width >= 48 && a.height >= 48 && a.left >= 0 && a.right <= innerWidth
      && !overlaps(a, stick) && !overlaps(a, jump));
  });
  assert.equal(layout, true, 'context buttons are thumb-sized and clear of movement/jump controls');
  assert.equal(await mobile.getByText('Press , to choose a class', { exact: true }).count(), 0, 'only relevant mode prompts appear');
  await render(mobile); await mobile.screenshot({ path: join(out, 'touch-home.png') });
  await touchActions.getByRole('button', { name: 'Pockets', exact: true }).tap();
  await mobile.screenshot({ path: join(out, 'pockets-touch.png'), animations: 'disabled' });
  await touchPanel.getByRole('button', { name: 'Leafy plant', exact: true }).tap();
  await mobile.screenshot({ path: join(out, 'pocket-actions-mobile.png'), animations: 'disabled' });
  await touchPanel.getByRole('button', { name: 'Take out to place' }).tap();
  assert.equal(await touchPanel.isVisible(), false, 'touch placement also closes the menu');
  await homePose(mobile, 3.5, 0);
  await render(mobile); await mobile.screenshot({ path: join(out, 'carry-mobile.png'), animations: 'disabled' });
  const carryControlsFit = await touchActions.getByRole('button').evaluateAll(buttons => {
    const stick = document.querySelector('.touch-stick').getBoundingClientRect(), jump = document.querySelector('.touch-actions').getBoundingClientRect();
    const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return buttons.every(b => { const r = b.getBoundingClientRect(); return r.height >= 48 && r.width >= 48 && r.left >= 0 && r.right <= innerWidth && !overlap(r, stick) && !overlap(r, jump); });
  });
  assert.equal(carryControlsFit, true, 'all four carrying actions clear the touch movement controls');
  const stick = await mobile.locator('.touch-stick').boundingBox(), touch = await mobile.context().newCDPSession(mobile);
  const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
  try {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [center] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x - 38, y: center.y }] });
    await mobile.evaluate(() => __app.test.resume());
    await mobile.waitForFunction(() => __app.pov.village.context.player.z < -0.6);
  } finally {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
    await mobile.evaluate(() => __app.test.park());
  }
  assert.ok(await mobile.evaluate(() => __app.pov.village.carrying.z < 0), 'touch stick moves the held piece, not just the camera');
  await homePose(mobile, 3.5, 0);
  await touchActions.getByRole('button', { name: 'Set down', exact: true }).tap();
  assert.ok(await mobile.evaluate(() => __app.pov.village.state.placed.some(i => i.id === 'plant')));
  await touchActions.getByRole('button', { name: 'Grab leafy plant' }).tap();
  await touchActions.getByRole('button', { name: 'Rotate · 0°' }).tap();
  await homePose(mobile, 3.5, -2);
  await touchActions.getByRole('button', { name: 'Set down', exact: true }).tap();
  assert.equal(await mobile.evaluate(() => __app.pov.village.state.placed.find(i => i.id === 'plant').rotation), 1, 'touch rotates and drops physical furniture');
  await touchActions.getByRole('button', { name: 'Grab leafy plant' }).tap();
  await touchActions.getByRole('button', { name: 'Cancel move' }).tap();
  assert.equal(await mobile.evaluate(() => __app.pov.village.carrying), null);
  await mobile.evaluate(() => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 93, 24, a.win.P.size[2] / 2 + 63).sub(a.sim.origin));
    a.pov.setLook(-Math.PI * 0.75, -0.3);
    a.test.resume();
  });
  await touchActions.getByRole('button', { name: 'Open dresser' }).waitFor();
  await render(mobile); await mobile.screenshot({ path: join(out, 'touch-dresser.png') });
  await touchActions.getByRole('button', { name: 'Open dresser' }).tap();
  await touchPanel.getByRole('heading', { name: 'Your dresser' }).waitFor();
  await mobile.screenshot({ path: join(out, 'dresser-mobile.png'), animations: 'disabled' });
  await touchPanel.getByRole('button', { name: 'Pockets', exact: true }).tap();
  await touchPanel.getByRole('button', { name: 'Sage sofa', exact: true }).tap();
  await touchPanel.getByRole('button', { name: 'Store in dresser' }).tap();
  assert.ok(await mobile.evaluate(() => __app.pov.village.state.storage.some(i => i.id === 'sofa')));
  await touchPanel.getByRole('button', { name: 'Close pockets or dialogue' }).tap();
  await mobile.evaluate(() => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 40, 24, a.win.P.size[2] / 2 + 60).sub(a.sim.origin));
    a.test.resume();
  });
  await touchActions.getByRole('button', { name: 'Talk to Maple' }).waitFor();
  await mobile.emulateMedia({ reducedMotion: 'reduce' });
  await touchActions.getByRole('button', { name: 'Talk to Maple' }).tap();
  await touchPanel.getByRole('heading', { name: 'Maple', exact: true }).waitFor();
  assert.equal(await touchPanel.locator('.village-typed').textContent(), await touchPanel.locator('.village-dialogue .sr-only').textContent(), 'reduced motion shows dialogue immediately');
  assert.equal(await touchPanel.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight && el.scrollWidth <= el.clientWidth), true, 'mobile dialogue stays within the viewport');
  await render(mobile); await mobile.screenshot({ path: join(out, 'dialogue-mobile.png'), animations: 'disabled' });
  await touchPanel.getByRole('button', { name: 'Close pockets or dialogue' }).tap();
  await mobile.evaluate(() => {
    const a = __app;
    a.pov.player.teleport(new a.THREE.Vector3(a.win.P.size[0] / 2 - 40, 24, a.win.P.size[2] / 2 + 36).sub(a.sim.origin));
    a.test.resume();
  });
  await mobile.waitForFunction(() => document.querySelector('.village-location').textContent === 'Tinker Creek');
  assert.equal(await touchActions.getByRole('button').count(), 1, 'irrelevant interaction hides outside');
  assert.equal(await touchActions.getByRole('button', { name: 'Pockets' }).isVisible(), true);
  await render(mobile); await mobile.screenshot({ path: join(out, 'touch-outside.png') });
  assert.deepEqual(errors, [], 'desktop and real touch contexts have no page errors');
  console.log(`PASS village gameplay, contextual E prompts, shared interaction buttons, real touch arrange/place/store/talk, responsive controls, persistence and cleanup; screenshots ${out}`);
} finally { await browser.close(); }
