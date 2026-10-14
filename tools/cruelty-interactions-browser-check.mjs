// One <=10s UI-mode slot: restored mission, E-operated door, real GPU clearance.
// Optional --url checks production without importing dev-server source modules.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { startVite, freePort } from './vite-server.mjs';

const option = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const remote = option('--url'), shot = option('--shot');
async function builtPreview() {
  const { preview } = await import('vite');
  const port = await freePort();
  const server = await preview({ root: new URL('../', import.meta.url).pathname,
    logLevel: 'warn', preview: { host: '127.0.0.1', port, strictPort: true } });
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.httpServer.close(e => e ? reject(e) : resolve())) };
}
const vite = remote ? null : process.argv.includes('--preview') ? await builtPreview() : await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'ui', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${remote ?? vite.origin}/?map=pharmakokinetiks&mode=crueltySquad&view=plain`);
  await ready(page);
  await page.waitForFunction(() => __app.pov.mission.active);
  const state = await page.evaluate(async () => {
    const a = __app;
    a.test.park(); await a.test.ready();
    a.pov.update(0); await a.gpu.fence();
    return { targets: a.pov.mission.state.total, actors: a.pov.npcs.length,
      profiles: [...new Set(a.pov.npcs.map(n => n.debug.profile))],
      skulls: a.pov.npcs.filter(n => n.root.getObjectByName('angular-skull')).length };
  });
  assert.equal(state.targets, 2, 'Pinky is no longer rejected by phantom ceiling voxels');
  assert.equal(state.actors, 23);
  assert.equal(state.skulls, state.actors, 'actual spawned actors use new figures');
  const passage = await page.evaluate(async () => {
    const a = __app, p = a.pov.player, map = a.win.scene.importManifest;
    const door = map.interactions.doors.find(d => d.sourcePath.endsWith('/entity_160_Door'));
    const { min, max } = door.bounds, origin = a.sim.origin.clone();
    const center = new a.THREE.Vector3((min[0] + max[0]) / 2, min[1] + 1, (min[2] + max[2]) / 2).sub(origin);
    const outside = center.clone(); outside.z = min[2] - origin.z - 2;
    async function clearance(at) {
      p.teleport(at); p.update(0);
      await a.gpu.fence();
      // Readback completion, not a fixed boot/physics sleep.
      for (let i = 0; p.clearance() === null && i < 8; i++) {
        await new Promise(requestAnimationFrame); p.update(0); await a.gpu.fence();
      }
      return p.clearance();
    }
    const closed = await clearance(center);
    await clearance(outside);
    a.pov.test.assumeLocked = true;
    const eye = p.pos.clone().setY(p.pos.y + p.height * 0.8);
    const target = center.clone().setY(eye.y);
    a.pov.interact.update(eye, target.sub(eye).normalize(), Infinity, true);
    window.__doorCheck = { door, center, outside, clearance };
    return { closed, focus: a.pov.interact.focus?.id };
  });
  assert.equal(passage.closed, false, 'closed leaf obstructs real GPU body probe');
  assert.match(passage.focus, /entity_160_Door$/);
  await page.keyboard.press('e');
  await page.waitForFunction(() => __app.win.scene.interactionState.states.get(__doorCheck.door.sourcePath)?.open);
  assert.equal(await page.evaluate(() => __doorCheck.clearance(__doorCheck.center)), true, 'E clears full normal-size GPU collision aperture');
  await page.evaluate(async () => {
    const a = __app, { outside, center, clearance } = __doorCheck;
    await clearance(outside);
    const eye = a.pov.player.pos.clone().setY(a.pov.player.pos.y + a.pov.player.height * 0.8);
    a.pov.interact.update(eye, center.clone().setY(eye.y).sub(eye).normalize(), Infinity, true);
  });
  await page.keyboard.press('e');
  await page.waitForFunction(() => __app.win.scene.interactionState.states.get(__doorCheck.door.sourcePath)?.open === false);
  assert.equal(await page.evaluate(() => __doorCheck.clearance(__doorCheck.center)), false, 'closing restores real GPU obstruction');
  if (shot) {
    await page.evaluate(() => {
      const a = __app, V = a.THREE.Vector3, g = a.sim.g;
      // Frame an actual authored guard from its front, only where source air is clear.
      const guard = a.pov.npcs.find(n => {
        if (n.debug.profile !== 'grunt') return false;
        const p = n.body.pos;
        if (p.x < 2 || p.x >= g.nx - 2 || p.z < 12 || p.z >= g.nz - 2) return false;
        for (let z = 1; z < 10; z++) if (a.win.scene.cell(Math.floor(p.x + a.sim.origin.x), Math.floor(p.y + 5), Math.floor(p.z + a.sim.origin.z - z))) return false;
        return true;
      });
      if (!guard) throw new Error('No resident guard with a clear front view');
      a.pov.player.teleport(guard.body.pos.clone().add(new V(0, 0, -9)));
      a.pov.camera.setLook(Math.PI, -0.05);
      a.pov.update(0);
    });
    await render(page);
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({ path: shot });
  }
  assert.deepEqual(errors, []);
  console.log('PASS restored Pharmakokinetiks mission, source-profile figures and E door GPU collision', state);
} finally {
  await browser?.close();
  await vite?.close();
}
