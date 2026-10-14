// One browser, two original-size numerical fixtures. No presentation loop.
// Announce/reserve the bounded GPU slot before running this command.
import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { openHarness } from './harness/open.mjs';

if (process.argv.includes('--cpu')) {
  const { gridLayout } = await import('../src/sim.js');
  const { editKernelWGSL, EDIT_FIELDS } = await import('../src/shaders/common.js');
  const { uniformStruct } = await import('../src/gpu/params.js');
  const text = readFileSync(new URL(import.meta.url), 'utf8');
  const fixtures = [...text.matchAll(/editKernel\('weatherFixture(Sky|Sea)', \{ reads: 'own', update: `([\s\S]*?)`/g)];
  assert.equal(fixtures.length, 2);
  const dir = mkdtempSync(join(tmpdir(), 'weather-fixture-wgsl-'));
  try {
    for (const [, name, update] of fixtures) {
      const n = name === 'Sky' ? 128 : 64, path = join(dir, `${name}.wgsl`);
      writeFileSync(path, editKernelWGSL(gridLayout(n, n, n), {
        update, reads: 'own', params: uniformStruct('FixtureParams', EDIT_FIELDS),
      }));
      execFileSync('naga', [path], { stdio: 'pipe' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('Both full native runtime fixture shaders validated on CPU. No browser/GPU.');
  process.exit(0);
}

const at = process.argv.indexOf('--port');
if (at < 0) throw new Error('Supply your owned server --port');
const start = Date.now(), slotPath = join(homedir(), '.cache/tpt-headless/slot');
const browser = await launchBrowser({ timeout: 5000, lifetimeMs: 15000 });
let slotStart = null;
try { if (readFileSync(slotPath, 'utf8').trim() === String(process.pid)) slotStart = statSync(slotPath).birthtimeMs; } catch {}
try {
  const errors = [];
  const page = await openHarness(browser, { url: p => `http://127.0.0.1:${process.argv[at + 1]}${p}` },
    '/tools/harness/weather-runtime.html', { errors, timeout: 4000 });
  const result = await page.evaluate(async () => {
    const setupStart = performance.now();
    const [{ createGpu }, { Simulation, cellTexel }, { createElementWeather }, { createOceanEvents }, { createLightning }, { E }] =
      await Promise.all([import('/src/gpu/device.js'), import('/src/sim.js'), import('/src/elementWeather.js'),
        import('/src/oceanEvents.js'), import('/src/lightning.js'), import('/src/elements.js')]);
    const gpu = await createGpu({ label: 'weather bounded fixture', testMode: true });
    const sky = new Simulation(gpu, 128, 128, 128), sea = new Simulation(gpu, 64, 64, 64);
    sea.origin.set(100, 0, 200);
    const sources = createElementWeather(), ocean = createOceanEvents(), lightning = createLightning();
    const skyFixture = sky.editKernel('weatherFixtureSky', { reads: 'own', update: `
      fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
        let id = select(E_EMPTY, E_METAL, p.y == 0 || (p.x < 64 && p.y == 111));
        *oA = vec4f(f32(id), AMBIENT, 0.0, 0.2); *oB = vec4f(0.0);
      }` });
    const seaFixture = sea.editKernel('weatherFixtureSea', { reads: 'own', update: `
      fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
        var id = E_EMPTY;
        if (p.y <= select(23, 8, p.x < 32)) { id = E_ROCK; }
        else if (p.x < 32 && p.y < 20) { id = E_WATER; }
        if (p.x >= 5 && p.x <= 12 && p.z >= 5 && p.z <= 12 && p.y >= 9 && p.y <= 27) {
          id = select(E_EMPTY, E_WATER, p.y < 20);
          if (p.x == 5 || p.x == 12 || p.z == 5 || p.z == 12 || p.y == 9) { id = E_METAL; }
        }
        if (p.x >= 20 && p.x <= 27 && p.z >= 5 && p.z <= 12 && p.y >= 20 && p.y <= 24) {
          id = select(E_EMPTY, E_WATER, p.y < 23);
          if (p.y == 20 || p.x == 20 || p.x == 27 || p.z == 5 || p.z == 12) { id = E_METAL; }
        }
        if (p.z >= 48 && p.y == 32) { id = E_METAL; }
        *oA = vec4f(f32(id), AMBIENT, 0.0, 0.2); *oB = vec4f(0.0);
      }` });
    const full = s => ({ lo: [0, 0, 0], hi: [s.g.nx - 1, s.g.ny - 1, s.g.nz - 1] });
    const skyContext = { sim: sky, enabled: true, advancing: true, host: true, seaLevel: 18, fogEnabled: false };
    const storm = { preset: 'storm', cloud: 1, rain: 1, storm: 1, fog: 0, wind: [.8, .6], time: 0 };
    const seaContext = { sim: sea, mapId: 'fixture', seaLevel: 20, target: [132, 232], groundHeight: x => x < 132 ? 8 : 23 };
    const count = (a, id) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] === id) n++; return n; };
    const equal = (a, b) => a.every((q, k) => q.every((v, i) => v === b[k][i]));
    let workloadStart;
    try {
      await Promise.all([sky.ready, sea.ready, skyFixture.ready, seaFixture.ready]);
      sources.step(storm, skyContext); await sources.ready; // lazy compilation, not a recorded pulse
      lightning.update(sky); await lightning.ready;
      sky.edit(skyFixture, full(sky), {}, { scrub: true });
      sea.edit(seaFixture, full(sea), {}, { scrub: true });
      const triggered = await ocean.trigger(seaContext); // warms native kernels; no material writes
      await gpu.fence();
      const setupMs = performance.now() - setupStart;
      workloadStart = performance.now();
      const checkBudget = () => { if (performance.now() - workloadStart > 9000) throw new Error('9s workload budget exhausted; no retry'); };

      sources.step(storm, skyContext);
      sky.frame = 60; sources.step({ ...storm, time: .25 }, skyContext);
      const emitted = await sky.readState();
      let charged = 0, roofDrops = 0, indoor = 0;
      for (let z = 0; z < 128; z++) for (let y = 1; y < 128; y++) for (let x = 0; x < 128; x++) {
        const i = cellTexel(sky.g, x, y, z) * 4, id = emitted[0][i];
        if (id === E.CLOUD && emitted[0][i + 3] >= 1) charged++;
        if (id === E.WATER && x < 64 && y === 112) roofDrops++;
        if (x < 64 && y < 111 && [E.CLOUD, E.WATER, E.SNOW].includes(id)) indoor++;
      }
      sources.step(storm, { ...skyContext, advancing: false });
      sources.step(storm, { ...skyContext, host: false });
      sources.step({ ...storm, preset: 'clear' }, skyContext);
      sources.reset();
      const stopPreserved = equal(emitted, await sky.readState());
      let plasma = false;
      for (let n = 0; n < 240; n++) {
        sky.step(); const strikes = lightning.strikes; lightning.update(sky);
        if (lightning.strikes > strikes) plasma ||= count((await sky.readState())[0], E.PLASMA) > 0;
        if (n % 12 === 0) { await gpu.fence(); await new Promise(requestAnimationFrame); checkBudget(); }
      }
      sky.edit(skyFixture, full(sky), {}, { scrub: true });
      sources.step({ ...storm, preset: 'clear', cloud: 0, rain: 0, storm: 0, fog: 1 }, { ...skyContext, fogEnabled: true });
      await sources.ready; sources.step({ ...storm, preset: 'clear', cloud: 0, rain: 0, storm: 0, fog: 1 }, { ...skyContext, fogEnabled: true });
      const fog = count((await sky.readState())[0], E.CLOUD);
      const atmosphereWallMs = performance.now() - workloadStart;
      checkBudget();

      const oceanStart = performance.now(), before = await sea.readState();
      sea.frame += 960; ocean.step({ ocean: 0 }, seaContext);
      const surge = await sea.readState();
      let solidChanges = 0, moving = 0;
      for (let i = 0; i < before[0].length; i += 4) {
        if ([E.ROCK, E.METAL].includes(before[0][i]) && before.some((q, k) => q.slice(i, i + 4).some((v, j) => v !== surge[k][i + j]))) solidChanges++;
        if (surge[0][i] === E.WATER && surge[1][i] > .05 && surge[1][i + 3] > 0) moving++;
      }
      ocean.cancel(); sea.frame += 60; ocean.step({ ocean: 0 }, seaContext);
      const cancelPreserved = equal(surge, await sea.readState());
      for (let n = 0; n < 240; n++) {
        sea.step();
        if (n % 30 === 0) { await gpu.fence(); checkBudget(); }
      }
      const propagated = await sea.readState();
      let coastalWater = 0;
      for (let z = 0; z < 64; z++) for (let y = 24; y < 64; y++) for (let x = 35; x < 64; x++)
        if (propagated[0][cellTexel(sea.g, x, y, z) * 4] === E.WATER) coastalWater++;
      sea.edit(seaFixture, full(sea), {}, { scrub: true });
      const calm = await sea.readState(); sea.frame += 60; ocean.step({ ocean: 1, wind: [1, 0] }, seaContext);
      const chopped = await sea.readState();
      let waterMoved = 0, protectedChanges = 0;
      for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const i = cellTexel(sea.g, x, y, z) * 4, id = calm[0][i];
        if (!calm[1].slice(i, i + 4).some((v, k) => v !== chopped[1][i + k])) continue;
        if (id === E.WATER) waterMoved++;
        if (id !== E.WATER || z >= 48 || ((x >= 5 && x <= 12 || x >= 20 && x <= 27) && z >= 5 && z <= 12)) protectedChanges++;
      }
      await gpu.fence(); checkBudget();
      if (gpu.failure) throw gpu.failure;
      return { setupMs, atmosphereWallMs, oceanWallMs: performance.now() - oceanStart,
        workloadWallMs: performance.now() - workloadStart, timingKind: 'fence-bounded wall time, not GPU timestamps',
        atmosphere: { cloud: count(emitted[0], E.CLOUD), water: count(emitted[0], E.WATER), charged, roofDrops, indoor, stopPreserved, strikes: lightning.strikes, plasma, fog },
        ocean: { triggered, addedWater: count(surge[0], E.WATER) - count(before[0], E.WATER), solidChanges, moving, cancelPreserved, coastalWater, waterMoved, protectedChanges } };
    } finally { sources.dispose(); ocean.dispose(); lightning.dispose(); sky.dispose(); sea.dispose(); }
  });
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  const { atmosphere: a, ocean: o } = result;
  assert(a.cloud > 0 && a.water > 0 && a.charged > 0 && a.roofDrops > 0 && a.fog > 0);
  assert.equal(a.indoor, 0); assert(a.stopPreserved);
  assert(a.strikes > 0 && a.plasma);
  assert(o.triggered && o.addedWater > 0 && o.moving > 0 && o.coastalWater > 0 && o.waterMoved > 0);
  assert.equal(o.solidChanges, 0); assert.equal(o.protectedChanges, 0); assert(o.cancelPreserved);
} finally {
  await browser.close();
  console.log(JSON.stringify({ requestToReleaseMs: Date.now() - start, slotOccupancyMs: slotStart === null ? null : Date.now() - slotStart }));
}
