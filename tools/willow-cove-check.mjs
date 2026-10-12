// Real-GPU Sandbox smoke: node tools/willow-cove-check.mjs --port 54937
// Keep physics at the real 128³ size; park while inspecting and stepping.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? fallback : args[i + 1];
};
const base = `http://localhost:${opt('port', '54937')}`;
const out = opt('out', '/tmp/willow-cove-check');
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('ERR_CONNECTION_REFUSED')) errors.push(msg.text());
  });
  await page.goto(base);
  const card = page.locator('.mm-card[data-map="willowCove"]');
  await card.waitFor();
  assert.equal(await page.evaluate(() => !!window.__app), false, 'menu does not boot a world');
  assert.equal(await page.locator('.mm-card[aria-selected="true"]').getAttribute('data-map'), 'island', 'existing default map stays selected');
  await card.click();
  await page.locator('.mm-start').click();
  await ready(page);
  const worldReady = () => page.waitForFunction(() => {
    const w = window.__app?.win;
    return w?.scene.key === 'willowCove' && w.loaded && w.far.ready && !w.far.queue.length;
  }, null, { timeout: 180000, polling: 250 });
  await worldReady();
  const generated = await page.evaluate(async () => {
    const a = window.__app;
    a.test.park();
    const { willowCoveTwin } = await import('/src/world/scenes/willowCove.js');
    const { E } = await import('/src/elements.js');
    const twin = willowCoveTwin(a.win.P), sim = a.sim, o = sim.origin;
    const [state] = sim.readState();
    const mismatches = [];
    let seed = 1;
    const coordinate = size => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 16) % size;
    };
    for (let i = 0; i < 512; i++) {
      const x = coordinate(sim.g.nx), y = coordinate(sim.g.ny), z = coordinate(sim.g.nz);
      const actual = Math.round(state[sim.cellTexel(x, y, z) * 4]);
      const expected = twin.wcCell(x + o.x, y, z + o.z);
      if (actual !== expected) mismatches.push({ x, y, z, actual, expected });
    }
    const [x, z] = a.win.scene.start(a.win.P, [sim.g.nx, sim.g.nz]);
    const y = a.win.scene.ground(x, z, a.win.P);
    const cell = yy => Math.round(sim.readCell(x - o.x, yy, z - o.z)[0][0]);
    const spawn = { x, y, z, support: cell(y - 1), head: cell(y + 5) };
    a.test.step(240);
    return {
      mismatches, spawn, dryAfterSteps: cell(y) === E.EMPTY && cell(y + 5) === E.EMPTY,
      dims: [sim.g.nx, sim.g.ny, sim.g.nz], scene: a.settings.scene, game: a.pov.game.running,
    };
  });
  assert.deepEqual(generated.mismatches, [], 'CPU/GPU scene cells agree');
  assert.deepEqual(generated.dims, [128, 128, 128]);
  assert.equal(generated.scene, 'willowCove');
  assert.equal(generated.game, false, 'no new gamemode starts');
  assert.equal(generated.spawn.head, 0);
  assert.ok(generated.dryAfterSteps, 'plaza stays dry after physics');
  console.log('PASS menu launch, CPU/GPU parity, Sandbox rules, dry spawn', generated.spawn);

  const roundTrip = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim, w = a.win;
    const { E } = await import('/src/elements.js');
    const [wx, wz] = w.scene.start(w.P, [sim.g.nx, sim.g.nz]);
    const y = w.scene.ground(wx, wz, w.P) + 3, x = wx - sim.origin.x, z = wz - sim.origin.z;
    sim.paint({ center: new a.THREE.Vector3(x + 0.5, y + 0.5, z + 0.5), radius: 1, shape: 1, tool: E.WALL, rate: 1, replace: true });
    const before = Math.round(sim.readCell(x, y, z)[0][0]);
    for (const direction of [1, -1]) for (let i = 0; i < 10; i++) {
      w.shift(direction * 16, 0);
      await w.pending;
    }
    return { before, after: Math.round(sim.readCell(x, y, z)[0][0]), expected: E.WALL };
  });
  assert.equal(roundTrip.before, roundTrip.expected, 'Sandbox paint changes real cells');
  assert.equal(roundTrip.after, roundTrip.expected, 'edit survives leaving and returning');
  console.log('PASS paint and streaming edit round-trip');

  await page.evaluate(() => {
    const a = window.__app;
    a.day.fixed = { az: 35, el: 32 };
    a.autoRes.enabled = false;
    a.rig.reset(true);
    a.post.reset();
  });
  await render(page);
  await page.screenshot({ path: join(out, 'home.png') });
  await page.keyboard.press('Escape');
  await page.locator('.mm.open').waitFor();
  await page.evaluate(() => window.__app.test.resume());
  await page.locator('.mm-card[data-map="lab"]').click();
  await page.locator('.mm-start').click();
  await page.waitForFunction(() => !window.__app.win && window.__app.settings.preset === 'lab');
  await render(page);
  assert.equal(await page.evaluate(() => window.__app.pov.game.running), false);
  assert.deepEqual(errors, [], 'no page, shader, or map errors');
  console.log(`PASS switching to existing Lab map; screenshot: ${join(out, 'home.png')}`);
} finally {
  await browser.close();
}
