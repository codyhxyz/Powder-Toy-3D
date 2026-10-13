// Willow Cove in the app, on WebGPU. Two stages, each in a browser of its own:
//   world  booted from its link (?map=willowCove): its generated cells equal
//          the CPU twin's (world/scenes/willowCove.js), it's a Sandbox world
//          (no match starts), the plaza stays dry through physics, a painted
//          cell survives leaving the window and coming back, and it draws
//          (the volume changes the frame, as tools/smoke.mjs measures it); a
//          shot of the home view
//   menu   the start menu: it doesn't boot a world, the default map stays
//          selected, Willow Cove's card and Start boot it as a Sandbox world,
//          and the menu then switches on to the Lab
// Neither may log a page, shader or map error.
// usage: node tools/willow-cove-check.mjs [--stage world,menu] [--port N] [--out dir] [--win 64 | --full]
// Runs its own Vite (tools/vite-server.mjs; --port: on that port). The world
// keeps the game's 128-wide window and the saved view, and waits the far field
// out before its shot, unless the adapter is a fallback one (the container's
// SwiftShader): then the window is 64 wide (?win=64, docs/webgpu.md G1) and
// the view plain (?view=plain, B5), set on the menu page's URL before Start so
// the menu still boots it, the far field isn't waited for (its whole build is
// minutes there) and the shots are single frames (test.renderOnce). --win N or
// --full choose either way. Parks while inspecting and stepping.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? fallback : args[i + 1];
};
const out = opt('out', '/tmp/willow-cove-check');
const STAGES = opt('stage', 'world,menu').split(',');
const FULL = args.includes('--full');
const WIN = opt('win', null);
const LOAD_TIMEOUT = 300000;   // ms: the world's kernels on a cold SwiftShader, beside another agent's run
const DIFF = 12, MIN_CHANGED = 0.02;   // a frame drew the scene: tools/smoke.mjs's measure
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

// a page that keeps its errors (the relay the UI asks for quota isn't running here)
async function open(browser, mode) {
  const page = await newTestPage(browser, { mode, viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('ERR_CONNECTION_REFUSED')) errors.push(msg.text());
  });
  return { page, errors };
}
// the window's size for this adapter: --win, else 64 on a fallback adapter unless --full
const windowFor = (info) => WIN ?? (!FULL && info.isFallbackAdapter ? '64' : null);
const worldReady = (page, far) => page.waitForFunction((far) => {
  const w = window.__app?.win;
  return w?.scene.key === 'willowCove' && w.loaded && (!far || (w.far?.ready && !w.far.queue.length));
}, far, { timeout: LOAD_TIMEOUT, polling: 250 });

async function worldStage(browser, vite) {
  // (the adapter first, on a page of the site: a link boots the app at once)
  const probe = await newTestPage(browser, { mode: 'manual' });
  await probe.goto(vite.url('/favicon.ico')).catch(() => {});
  const info = await gpuInfo(probe);
  await probe.close();
  const win = windowFor(info);
  console.log(`world: gpu ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; window ${win ? `${win} wide, plain view` : 'the game\'s'}`);
  const { page, errors } = await open(browser, 'manual');
  await page.goto(vite.url(`/?map=willowCove${win ? `&win=${win}&view=plain` : ''}`));
  await ready(page);
  await worldReady(page, false);
  await page.evaluate(() => window.__app.test.ready());
  console.log(`world: loaded, pipelines ready (${secs()})`);
  const generated = await page.evaluate(async () => {
    const a = window.__app;
    a.test.park();
    const { willowCoveTwin } = await import('/src/world/scenes/willowCove.js');
    const { E } = await import('/src/elements.js');
    const twin = willowCoveTwin(a.win.P), sim = a.sim, o = sim.origin;
    const [state] = await sim.readState();
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
    const cell = async yy => Math.round((await sim.readCell(x - o.x, yy, z - o.z))[0][0]);
    const spawn = { x, y, z, support: await cell(y - 1), head: await cell(y + 5) };
    a.test.step(240);
    return {
      mismatches, spawn, brick: E.BRICK, dryAfterSteps: (await cell(y)) === E.EMPTY && (await cell(y + 5)) === E.EMPTY,
      dims: [sim.g.nx, sim.g.ny, sim.g.nz], scene: a.settings.scene, game: a.pov.game.running,
    };
  });
  assert.deepEqual(generated.mismatches, [], 'CPU/GPU scene cells agree');
  assert.deepEqual(generated.dims, win ? [Number(win), 128, Number(win)] : [128, 128, 128]);
  assert.equal(generated.scene, 'willowCove');
  assert.equal(generated.game, false, 'no new gamemode starts');
  assert.equal(generated.spawn.support, generated.brick, 'the plaza is paved');
  assert.equal(generated.spawn.head, 0);
  assert.ok(generated.dryAfterSteps, 'plaza stays dry after physics');
  console.log(`PASS CPU/GPU parity (512 cells), Sandbox rules, dry spawn after 240 steps (${secs()})`, generated.spawn);

  const roundTrip = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim, w = a.win;
    const { E } = await import('/src/elements.js');
    const [wx, wz] = w.scene.start(w.P, [sim.g.nx, sim.g.nz]);
    const y = w.scene.ground(wx, wz, w.P) + 3, x = wx - sim.origin.x, z = wz - sim.origin.z;
    sim.paint({ center: new a.THREE.Vector3(x + 0.5, y + 0.5, z + 0.5), radius: 1, shape: 1, tool: E.WALL, rate: 1, replace: true });
    const before = Math.round((await sim.readCell(x, y, z))[0][0]);
    for (const direction of [1, -1]) for (let i = 0; i < 10; i++) {
      w.shift(direction * 16, 0);
      await w.pending;
    }
    return { before, after: Math.round((await sim.readCell(x, y, z))[0][0]), expected: E.WALL };
  });
  assert.equal(roundTrip.before, roundTrip.expected, 'Sandbox paint changes real cells');
  assert.equal(roundTrip.after, roundTrip.expected, 'edit survives leaving and returning');
  console.log(`PASS paint and streaming edit round-trip (${secs()})`);

  if (!win) {
    // (the far field builds a few chunks a frame: live frames until it's done)
    await page.evaluate(() => window.__app.test.resume());
    await worldReady(page, true);
  }
  await page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    a.day.fixed = { az: 35, el: 32 };
    a.autoRes.enabled = false;
    a.rig.reset(true);
    a.post.reset();
  });
  // it draws: the share of the frame the volume changes (tools/smoke.mjs's measure), then the shot
  const drew = await page.evaluate(async (diff) => {
    const a = window.__app;
    await a.test.renderOnce();
    const ref = await a.test.renderOnce({ capture: true, volume: false });
    const shot = await a.test.renderOnce({ capture: true });
    let n = 0;
    for (let i = 0; i < shot.data.length; i += 4) {
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(shot.data[i + c] - ref.data[i + c]))) > diff) n++;
    }
    return { drawn: a.view.volumeDrawn, added: n / (shot.width * shot.height) };
  }, DIFF);
  assert.ok(drew.drawn && drew.added >= MIN_CHANGED, `the volume draws the world: ${JSON.stringify(drew)}`);
  if (!win) await render(page);
  await page.screenshot({ path: join(out, 'home.png') });
  assert.deepEqual(errors, [], 'no page, shader, or map errors');
  console.log(`PASS draws (volume changed ${(drew.added * 100).toFixed(1)}% of the frame); screenshot ${join(out, 'home.png')} (${secs()})`);
  await page.close();
}

async function menuStage(browser, vite) {
  const { page, errors } = await open(browser, 'ui');
  await page.goto(vite.url('/'));
  const card = page.locator('.mm-card[data-map="willowCove"]');
  await card.waitFor();
  assert.equal(await page.evaluate(() => !!window.__app), false, 'menu does not boot a world');
  assert.equal(await page.locator('.mm-card[aria-selected="true"]').getAttribute('data-map'), 'island', 'existing default map stays selected');
  const info = await gpuInfo(page);
  const win = windowFor(info);
  console.log(`menu: window ${win ? `${win} wide, plain view` : 'the game\'s'}`);
  await card.click();
  // (app.js reads the URL when Start imports it: the menu stays up, the world gets the small window)
  if (win) await page.evaluate((w) => history.replaceState(null, '', `/?win=${w}&view=plain`), win);
  await page.locator('.mm-start').click();
  await ready(page);
  await worldReady(page, false);
  const booted = await page.evaluate(() => {
    const a = window.__app;
    return { scene: a.settings.scene, dims: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz], game: a.pov.game.running };
  });
  assert.equal(booted.scene, 'willowCove');
  assert.deepEqual(booted.dims, win ? [Number(win), 128, Number(win)] : [128, 128, 128]);
  assert.equal(booted.game, false, 'no new gamemode starts');
  console.log(`PASS menu launch: Willow Cove as a Sandbox world (${secs()})`);
  await page.keyboard.press('Escape');
  await page.locator('.mm.open').waitFor();
  await page.locator('.mm-card[data-map="lab"]').click();
  await page.locator('.mm-start').click();
  await page.waitForFunction(() => !window.__app.win && window.__app.settings.preset === 'lab', null, { timeout: LOAD_TIMEOUT });
  if (win) await page.evaluate(async () => { await window.__app.test.ready(); window.__app.test.park(); await window.__app.test.renderOnce(); });
  else await render(page);
  assert.equal(await page.evaluate(() => window.__app.pov.game.running), false);
  assert.deepEqual(errors, [], 'no page, shader, or map errors');
  console.log(`PASS switching to existing Lab map (${secs()})`);
  await page.close();
}

const vite = await startVite();
const browser = await launchBrowser();
try {
  if (STAGES.includes('world')) await worldStage(browser, vite);
  if (STAGES.includes('menu')) await menuStage(browser, vite);
} finally {
  await browser.close();
  await vite.close();
}
