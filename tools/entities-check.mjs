// Real-shell smoke; works on built/deployed sites (no /src imports in page).
// node tools/entities-check.mjs --url https://tpt3d.codyh.xyz
// or --port YOUR_OWN_PORT. Parent batches GPU runs; CPU: entities-node-check.mjs.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { E, ELEMENTS } from '../src/elements.js';
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const url = new URL(opt('url', `http://localhost:${opt('port', '5499')}/`));
url.searchParams.set('size', '128'); url.searchParams.set('preset', 'empty');
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/localhost:8787|127\.0\.0\.1:8787/.test(m.location().url)) errors.push(m.text()); });
  await page.goto(url.href); await ready(page);
  await page.waitForFunction(() => window.__app?.pov && window.__app?.spawners);
  await page.evaluate(({ id, temp, life }) => {
    const a = window.__app, [A, B] = a.sim.blankState(), g = a.sim.g;
    for (let y = 0; y < 20; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = a.sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = temp; A[i + 2] = life;
    }
    a.sim.load(A, B); a.requestRender();
  }, { id: E.WATER, temp: ELEMENTS[E.WATER].temp, life: ELEMENTS[E.WATER].life });
  await page.keyboard.press('t');
  await page.getByRole('button', { name: 'Entities', exact: true }).click();
  for (const name of ['Boat', 'Jeep', 'Hoverbike', 'Axeman', 'Gunner', 'Worm', 'Giant worm', 'Bird flock']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `truthful palette: ${name}`);
  }
  await page.getByRole('button', { name: 'Boat', exact: true }).click();
  const click = await page.evaluate(() => {
    const a = window.__app, p = new a.THREE.Vector3(64, 20, 64).multiplyScalar(a.scale).add(a.volume.position).project(a.camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  });
  await page.mouse.move(click.x, click.y);
  await page.waitForFunction((water) => window.__app.hover.valid && window.__app.hover.id === water, E.WATER);
  await page.mouse.click(click.x, click.y);
  await page.mouse.click(click.x, click.y);
  assert.equal(await page.evaluate(() => window.__app.spawners.of('boat').length), 2, 'nearby second click adds, never removes');
  await page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    for (const [i, kind] of ['jeep', 'hoverbike', 'enemy', 'gunner', 'worm', 'giantworm', 'birds'].entries()) a.spawners.place(kind, new a.THREE.Vector3(20 + i * 13, 24, 30));
  });
  async function converge(test) {
    const until = Date.now() + 30000;
    do {
      await render(page);
      if (await page.evaluate(test)) return;
      await delay(100); // asynchronous models/pipelines/readbacks, not a boot sleep
    } while (Date.now() < until);
    throw new Error('Entity creation did not converge');
  }
  await converge(() => {
    const a = window.__app;
    return a.pov.vehicles.list.length === 4 && a.pov.npcs.length === 4 && a.birds.count > 0;
  });
  assert.deepEqual(await page.evaluate(() => {
    const a = window.__app;
    window.__entityBefore = { vehicles: [...a.pov.vehicles.list], npcs: [...a.pov.npcs], positions: a.pov.vehicles.list.map((v) => ({ ...v.impl.body.translation() })) };
    return { mode: a.pov.mode, markers: a.spawners.root.children.length, visible: a.pov.vehicles.root.visible && a.pov.npcs.every((n) => n.root.visible) };
  }), { mode: 'off', markers: 0, visible: true }, 'all real entities visible before entering POV');
  await render(page);
  assert.equal(await page.evaluate(() => {
    const a = window.__app;
    return a.pov.vehicles.list.every((v, i) => JSON.stringify({ ...v.impl.body.translation() }) === JSON.stringify(window.__entityBefore.positions[i]));
  }), true, 'god-view pause does not move vehicles');
  await page.evaluate(() => {
    const a = window.__app, v = a.pov.vehicles.list[0];
    a.pov.vehicles.damage(v, 0.2);
    window.__entityBefore.health = v.health;
    const gunner = a.pov.npcs.find((n) => n.kind === 'gunner');
    gunner.body.hurt(999, 'Test');
    window.__entityBefore.deadNpc = gunner;
  });
  await page.evaluate(async () => {
    const a = window.__app;
    await a.pov.enter({ at: new a.THREE.Vector3(100, 30, 100), swoop: 0, hint: false });
    a.pov.update(0);
    a.pov.exit(true);
    a.pov.updateEntities(0);
  });
  assert.equal(await page.evaluate(() => {
    const a = window.__app, b = window.__entityBefore;
    return a.pov.mode === 'off' && a.pov.vehicles.list.every((v, i) => v === b.vehicles[i]) && a.pov.npcs.every((n, i) => n === b.npcs[i]);
  }), true, 'camera switch preserves entity instances');
  assert.equal(await page.evaluate(() => {
    const a = window.__app, b = window.__entityBefore;
    return b.deadNpc.body.dead && a.pov.vehicles.list[0].health === b.health && !a.spawners.toJSON().some((s) => s.kind === 'gunner');
  }), true, 'camera switches neither heal vehicles nor revive dead NPCs');
  const death = await page.evaluate(() => {
    const a = window.__app, vs = a.pov.vehicles, v = vs.list.find((v) => v.kind === 'boat');
    const home = v.home;
    vs.damage(v, 999);
    const f = { player: null, live: false, worldToGrid: new a.THREE.Matrix4() };
    vs.update(9, f); vs.reset(); vs.update(0, f);
    const deadPlacement = a.spawners.list.find((s) => `pad:${s.id}` === home);
    return { respawned: vs.list.some((v) => v.home === home && v.alive), consumed: deadPlacement.consumed, savedBoats: a.spawners.toJSON().filter((s) => s.kind === 'boat').length };
  });
  assert.equal(death.respawned, false); assert.equal(death.consumed, true); assert.ok(death.savedBoats < 2);
  const roundtrip = await page.evaluate(() => {
    const a = window.__app, saved = a.spawners.toJSON();
    a.spawners.fromJSON(saved); a.pov.worldReplaced(); a.birds.worldReplaced(); a.pov.updateEntities(0);
    return { expected: saved.filter((s) => s.kind === 'boat').length, actual: a.pov.vehicles.list.filter((v) => v.kind === 'boat').length };
  });
  assert.equal(roundtrip.actual, roundtrip.expected, 'dead boats do not return on load');
  const legacy = await page.evaluate(() => {
    const a = window.__app, vs = a.pov.vehicles;
    a.spawners.clear(); a.pov.worldReplaced();
    vs.spawnLayout({ vehicles: [{ kind: 'boat', at: [64, 20, 64] }] });
    const f = { player: null, live: false, worldToGrid: new a.THREE.Matrix4() };
    vs.update(0, f);
    const old = vs.list[0]; vs.damage(old, 999); vs.update(9, f);
    return vs.list.some((v) => v.alive && v.id !== old.id);
  });
  assert.equal(legacy, true, 'arena layout still respawns');
  assert.deepEqual(errors, []);
  console.log('ok entities: palette/no-toggle, immediate god entities, paused pose, mode identity, permanent boat death/save-load, arena respawn');
} finally { await browser.close(); }
