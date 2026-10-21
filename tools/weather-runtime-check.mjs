// One browser, one original-size numerical fixture. No presentation loop.
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
  const fixtures = [...text.matchAll(/editKernel\('weatherFixture(Sky)', \{ reads: 'own', update: `([\s\S]*?)`/g)];
  assert.equal(fixtures.length, 1);
  const dir = mkdtempSync(join(tmpdir(), 'weather-fixture-wgsl-'));
  try {
    for (const [, name, update] of fixtures) {
      const n = 128, path = join(dir, `${name}.wgsl`);
      writeFileSync(path, editKernelWGSL(gridLayout(n, n, n), {
        update, reads: 'own', params: uniformStruct('FixtureParams', EDIT_FIELDS),
      }));
      execFileSync('naga', [path], { stdio: 'pipe' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('The full native runtime fixture shader validated on CPU. No browser/GPU.');
  process.exit(0);
}

const at = process.argv.indexOf('--port');
if (at < 0) throw new Error('Supply your owned server --port');
const start = Date.now(), slotPath = join(homedir(), '.cache/tpt-headless/slot');
const browser = await launchBrowser({ timeout: 5000, lifetimeMs: 10000 });
let slotStart = null;
try { if (readFileSync(slotPath, 'utf8').trim() === String(process.pid)) slotStart = statSync(slotPath).birthtimeMs; } catch {}
try {
  const errors = [];
  const page = await openHarness(browser, { url: p => `http://127.0.0.1:${process.argv[at + 1]}${p}` },
    '/tools/harness/weather-runtime.html', { errors, timeout: 4000 });
  const result = await page.evaluate(async () => {
    const setupStart = performance.now();
    const [{ createGpu }, { Simulation, cellTexel }, { createElementWeather }, { createLightning }, { E }] =
      await Promise.all([import('/src/gpu/device.js'), import('/src/sim.js'), import('/src/elementWeather.js'),
        import('/src/lightning.js'), import('/src/elements.js')]);
    const gpu = await createGpu({ label: 'weather bounded fixture', testMode: true });
    const sky = new Simulation(gpu, 128, 128, 128);
    const sources = createElementWeather(), lightning = createLightning();
    const skyFixture = sky.editKernel('weatherFixtureSky', { reads: 'own', update: `
      fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
        let id = select(E_EMPTY, E_METAL, p.y == 0 || (p.x < 64 && p.y == 111));
        *oA = vec4f(f32(id), AMBIENT, 0.0, 0.2); *oB = vec4f(0.0);
      }` });
    const full = s => ({ lo: [0, 0, 0], hi: [s.g.nx - 1, s.g.ny - 1, s.g.nz - 1] });
    const skyContext = { sim: sky, enabled: true, advancing: true, host: true, seaLevel: 18 };
    const storm = { preset: 'storm', cloud: 1, rain: 1, storm: 1, wind: [.8, .6], time: 0 };
    const count = (a, id) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] === id) n++; return n; };
    const equal = (a, b) => a.every((q, k) => q.every((v, i) => v === b[k][i]));
    let workloadStart;
    try {
      await Promise.all([sky.ready, skyFixture.ready]);
      sources.step(storm, skyContext); await sources.ready; // lazy compilation, not a recorded pulse
      lightning.update(sky); await lightning.ready;
      sky.edit(skyFixture, full(sky), {}, { scrub: true });
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
      const atmosphereWallMs = performance.now() - workloadStart;
      await gpu.fence(); checkBudget();
      if (gpu.failure) throw gpu.failure;
      return { setupMs, atmosphereWallMs,
        workloadWallMs: performance.now() - workloadStart, timingKind: 'fence-bounded wall time, not GPU timestamps',
        atmosphere: { cloud: count(emitted[0], E.CLOUD), water: count(emitted[0], E.WATER), charged, roofDrops, indoor, stopPreserved, strikes: lightning.strikes, plasma } };
    } finally { sources.dispose(); lightning.dispose(); sky.dispose(); }
  });
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  const { atmosphere: a } = result;
  assert(a.cloud > 0 && a.water > 0 && a.charged > 0 && a.roofDrops > 0);
  assert.equal(a.indoor, 0); assert(a.stopPreserved);
  assert(a.strikes > 0 && a.plasma);
} finally {
  await browser.close();
  console.log(JSON.stringify({ requestToReleaseMs: Date.now() - start, slotOccupancyMs: slotStart === null ? null : Date.now() - slotStart }));
}
