// App-level construction, progression, and physical starter-line checks.
// Own Vite: node tools/industry-integration-check.mjs --port 19543
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const base = process.argv.includes('--url') ? option('--url') : `http://localhost:${option('--port') || '19543'}/`;
const browser = await launchBrowser();
const errors = [];
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (/GPU (validation|internal)|Error while parsing WGSL/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${base}?map=quarry&mode=factory&view=plain`);
  await ready(page);
  await page.waitForFunction(() => !!window.__app?.industry);
  const initial = await page.evaluate(async () => {
    const a = window.__app;
    a.industry.update(0, false);
    await a.gpu.fence();
    return a.industry.state;
  });
  assert.equal(initial.devices.length, 4, 'starter line is installed');
  assert(initial.progression, 'Factory economy is active');
  console.log('ok: Factory boots with physical starter line and progression');

  const construction = await page.evaluate(async () => {
    const a = window.__app, industry = a.industry;
    const before = industry.state.progression.credits;
    const placed = await industry.place({ type: 'belt', x: 60, y: 8, z: 84, rotation: 1 });
    const overlap = await industry.place({ type: 'belt', x: 60, y: 8, z: 84, rotation: 0 });
    const invalid = await industry.place({ type: 'belt', x: -4, y: 8, z: 84, rotation: 0 });
    const after = industry.state.progression.credits;
    const removed = placed.ok ? await industry.remove(placed.id) : null;
    const refunded = industry.state.progression.credits;
    const repeated = placed.ok ? await industry.remove(placed.id) : null;
    return { before, placed, overlap, invalid, after, removed, refunded, repeated };
  });
  assert(construction.placed.ok, JSON.stringify(construction));
  assert.equal(construction.overlap.ok, false);
  assert.equal(construction.invalid.ok, false);
  assert.equal(construction.after, construction.before - 2);
  assert(construction.removed.ok);
  assert.equal(construction.refunded, construction.before);
  assert.equal(construction.repeated.ok, false);
  console.log('ok: atomic place, overlap/bounds rejection, one charge and one refund');

  const flow = await page.evaluate(async () => {
    const a = window.__app, industry = a.industry;
    const before = industry.state.progression.earned;
    // Manual mode leaves rAF intact; drive only simulation and industry.
    for (let frame = 0; frame < 360; frame++) {
      a.test.step(4);
      industry.update(1 / 60, true);
      if (frame % 6 === 5) await a.gpu.fence();
    }
    await a.gpu.fence();
    return { before, after: industry.state.progression, state: industry.state };
  });
  assert(flow.after.earned > flow.before, `physical starter delivery stalled: ${JSON.stringify(flow.state)}`);
  console.log(`ok: real grains shipped; earned ${flow.after.earned}, stage ${flow.after.stage}`);

  const paused = await page.evaluate(async () => {
    const a = window.__app, before = a.industry.state.progression.earned;
    const frame = a.sim.frame;
    for (let i = 0; i < 20; i++) a.industry.update(1, false);
    await a.gpu.fence();
    return { before, after: a.industry.state.progression.earned, frame, afterFrame: a.sim.frame };
  });
  assert.equal(paused.before, paused.after);
  assert.equal(paused.frame, paused.afterFrame);
  console.log('ok: paused updates do not mine, ship, or advance physics');

  const persistence = await page.evaluate(async () => {
    const a = window.__app;
    const before = a.industry.toJSON();
    const saving = a.saveGame('Industry integration');
    await a.test.render();
    const meta = await saving;
    if (!meta) throw new Error('Factory save was refused');
    await a.industry.place({ type: 'belt', x: 60, y: 8, z: 84 });
    const restored = await a.openSave(meta.id);
    return { restored, before, after: a.industry.toJSON(), mode: a.current().mode };
  });
  assert.equal(persistence.restored, true);
  assert.equal(persistence.mode, 'factory');
  assert.deepEqual(persistence.after, persistence.before, 'real save restores matching economy and machines');
  console.log('ok: native save/load restores Factory mode, machines and credits');

  const sandbox = await page.evaluate(async () => {
    const a = window.__app;
    await a.setMode('sandbox');
    a.industry.update(0, false);
    const placed = await a.industry.place({ type: 'pump', x: 60, y: 8, z: 84, powered: true });
    const before = a.industry.toJSON();
    if (!a.loadPreset('empty')) throw new Error('Clear was refused');
    await a.gpu.fence();
    const cleared = a.industry.state.devices.length;
    a.undo();
    await a.gpu.fence();
    return { placed, cleared, before, after: a.industry.toJSON() };
  });
  assert(sandbox.placed.ok, JSON.stringify(sandbox.placed));
  assert.equal(sandbox.cleared, 0);
  assert.deepEqual(sandbox.after, sandbox.before, 'Clear/Undo restores industry instead of only dead decks');
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => window.__app.industry.building), false, 'Sandbox B retains brush shortcut');
  await page.keyboard.press('Shift+b');
  assert.equal(await page.evaluate(() => window.__app.industry.building), false);
  assert(await page.locator('.industry-build').isHidden());
  assert(await page.locator('.industry').isHidden());
  console.log('ok: Sandbox saved machines/electricity and Clear/Undo work; Factory-only build UI stays hidden');

  await page.evaluate(() => {
    const a = window.__app;
    const world = xyz => new a.THREE.Vector3(...xyz).multiplyScalar(a.scale).add(a.volume.position);
    a.camera.position.copy(world([73, 38, 82]));
    a.controls.target.copy(world([50, 10, 53]));
    a.controls.update();
    a.industry.update(0, false);
  });
  await render(page);
  await page.screenshot({ path: '/tmp/industry-desktop.png' });
  await page.setViewportSize({ width: 740, height: 740 });
  await render(page);
  await page.screenshot({ path: '/tmp/industry-compact.png' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async () => {
    const a = window.__app;
    await a.setMode('factory');
    a.settings.paused = true;
    a.test.resume();
    await a.pov.enter({ at: new a.THREE.Vector3(48, 8, 84), swoop: 0, hint: false });
  });
  await page.waitForFunction(() => window.__app.pov.mode === 'on');
  await page.locator('.industry-build').click();
  await page.waitForFunction(() => window.__app.industry.building);
  await page.locator('.industry [data-action="rotate"]').click();
  assert.equal(await page.evaluate(() => window.__app.industry.state.rotation), 1);
  const bodyGuard = await page.evaluate(async () => {
    const a = window.__app, p = a.pov.player.pos;
    const result = await a.industry.place({ type: 'belt', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    a.test.park();
    return result;
  });
  assert.equal(bodyGuard.ok, false);
  assert.match(bodyGuard.reason, /Move clear/);
  await render(page);
  await page.screenshot({ path: '/tmp/industry-pov.png' });
  console.log('ok: first-person construction opens and protects the live player footprint');
  assert.deepEqual(errors, []);
  console.log('ok: no page/WGSL errors; /tmp/industry-{desktop,compact}.png');
} finally {
  await browser.close();
}
