// One <=10s manual-mode slot on the full imported map, not a reduced physics fixture.
// Requires local source conversion. Run one map per explicitly planned GPU slot.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const map = process.argv[2] ?? 'paradise', vite = await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.origin}/?map=${encodeURIComponent(map)}&mode=crueltySquad&view=plain`);
  await ready(page);
  await page.waitForFunction(() => __app.pov.mission.active);
  const state = await page.evaluate(async () => {
    const a = __app;
    await a.test.ready();
    a.pov.update(0);
    await a.gpu.fence();
    return {
      mode: a.gamemode(), phase: a.pov.mission.state.phase,
      targets: a.pov.mission.state.total, actors: a.pov.npcs.length,
      weapon: a.pov.toolbelt.selectedKey,
      window: [a.sim.g.nx, a.sim.g.ny, a.sim.g.nz],
      sourceSize: a.settings.worldSize,
      errors: a.test.errors,
    };
  });
  assert.equal(state.mode, 'crueltySquad');
  assert.equal(state.phase, 'active');
  assert.ok(state.targets > 0 && state.actors >= state.targets);
  assert.equal(state.weapon, 'GUN');
  await page.waitForFunction(() => __app.pov.player.clearance() !== null);
  assert.equal(await page.evaluate(() => __app.pov.player.clearance()), true, 'authored spawn is clear in actual GPU voxel collision');
  const floor = await page.evaluate(async () => {
    const { povGpu } = await import('/src/pov/gpu.js');
    const a = __app, p = a.pov.player.pos;
    const read = povGpu(a.sim).probe('povCells', { cells: [[Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), 0]], count: 1 });
    if (!read) throw new Error('Spawn-support probe unavailable');
    return new Float32Array(await read)[0];
  });
  assert.ok(floor > 0, 'the authored floor exists in real GPU cells, not just in the CPU scene twin');
  assert.deepEqual(errors, []);
  console.log(`PASS imported ${map} boots mission, armed player and authored actors with clear GPU spawn`, state);
} finally {
  await browser?.close();
  await vite.close();
}
