// Actual E input, native circuits and registered pumps on the full authored map.
// One 25-second slot; the numerical test advances the normal native callbacks.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { preservationManifest } from '../src/lab/preservation/index.js';
import { BUTTON_HOLD, ELEC } from '../src/electricity.js';

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const layout = preservationManifest();
const wave = layout.circuits.find(c => c.id === 'light-wave');
const water = layout.circuits.find(c => c.id === 'processing-cascade');
const pumps = layout.devices.filter(d => water.inputs.some(p =>
  p[0] === d.x - 1 && p[1] === d.y && p[2] === d.z + 1));
assert.equal(pumps.length, 8);
const external = option('url', null);
const vite = external ? null : await startVite({
  port: Number(option('port', 54985)), warmupEntries: ['/src/main.js', '/src/app.js'],
});
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 25000,
    why: 'Physical E buttons: full-map light pulse, eight-pump Start, drive-supply cut and Stop' });
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 400 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.error('page error:', String(e)); });
  page.on('console', m => {
    if (/GPU (validation|internal|out-of-memory)|GPU shader failed/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(new URL('?size=valley&preset=preservationLab&view=plain', external ?? vite.url('/')).href);
  await ready(page);
  await page.evaluate(async () => {
    const a = __app;
    a.test.park(); await a.test.ready();
    const { createIndustryDiagnostics } = await import('/src/industry/diagnostics.js');
    const { E, TOOLS } = await import('/src/elements.js');
    const ERASE_TOOL = TOOLS.find(t => t.key === 'ERASE').id;
    const { HOST_HZ } = await import('/src/v2/host.js');
    const probe = createIndustryDiagnostics({ getSim: () => a.sim, throttleMs: 0 });
    window.__circuitCheck = {
      E, ERASE_TOOL, probe,
      async sample(cell) {
        const d = { id: `probe-${cell.join('-')}`, type: 'control-cell', rotation: 0,
          x: Math.min(cell[0], a.sim.g.nx - 4), y: cell[1], z: Math.min(cell[2], a.sim.g.nz - 4) };
        const result = await probe.inspect(d, {
          regions: {}, guard: { base: [0, 0, 0], material: -1, port: cell, powered: true },
        });
        return result.evidence.control.sample;
      },
      async advance(n) {
        for (let i = 0; i < n; i++) {
          a.test.step(1);
          // Production afterStep clock, following nativeAfterStep's actuator callback.
          a.industry.update(1 / HOST_HZ, true, true);
          if (i % 8 === 7) await a.sim.gpuSync();
        }
        await a.sim.gpuSync();
      },
    };
  });
  console.log('adapter:', (await gpuInfo(page)).description);
  assert.equal(await page.evaluate(() => __app.industry.state.devices.length), 18);
  const sample = cell => page.evaluate(p => __circuitCheck.sample(p), cell);
  const advance = n => page.evaluate(n => __circuitCheck.advance(n), n);
  async function press(cell) {
    await page.evaluate(cell => {
      const a = __app;
      a.camera.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] - 4.5)
        .multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.set(...cell.map(n => n + 0.5)).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.update(); a.camera.updateMatrixWorld(true); a.volume.updateMatrixWorld(true);
      document.activeElement?.blur();
    }, cell);
    await page.mouse.move(200, 200);
    const picked = await page.evaluate(async () => {
      const a = __app, ray = a.actionRay();
      const hit = await a.pickRay(ray.origin, ray.direction, false, false);
      if (!hit?.valid) throw new Error('Pointer did not hit a native cell');
      // Manual mode parks the hover frame. Populate its cache using the real
      // pointer ray and native picker, never an invented target or material.
      const cell = a.hover.cell;
      cell.copy(hit.cell); Object.assign(a.hover, hit, { cell });
      return { cell: hit.cell.toArray().map(Math.floor), material: hit.id };
    });
    assert.deepEqual(picked.cell, cell, 'Actual first hit must be the exposed control');
    await page.keyboard.press('e');
    await page.evaluate(async () => { await __app.electronics.settle(); await __app.sim.gpuSync(); });
    const result = await sample(cell);
    assert.equal(result.life, BUTTON_HOLD, 'Actual E listener must activate the native momentary contact');
    return result;
  }
  console.log('stage: momentary light-wave input');
  await press(wave.gate);
  await advance(1);
  assert((await sample(wave.indicator)).ctype > 0, 'Native indicator receives the pulse');
  await advance(3);
  assert.equal((await sample(wave.gate)).life, 0, 'Native button releases without a map callback');

  console.log('stage: Start, native relay and eight native pumps');
  await press(water.buttons.start);
  await advance(96);
  assert.equal((await sample(water.gate)).life, ELEC.SWITCH_ON);
  for (const input of water.inputs) assert((await sample(input)).life > 0, `Receiver at ${input} has supply`);
  const observations = await page.evaluate(async ids => {
    const out = [];
    for (const id of ids) out.push(await __app.industry.observe(id));
    return out;
  }, pumps.map(d => d.id));
  console.log('native pump observations:', JSON.stringify(observations));
  assert(observations.every(o => o?.running === 'confirmed'), 'All eight pumps need actual confirmed transfers');

  console.log('stage: erase only the drive battery; command remains ON');
  await page.evaluate(p => {
    const a = __app, centre = a.controls.target.clone().set(...p.map(n => n + 0.5));
    assertPaint(a.sim.paint({ center: centre, radius: 0.4, shape: 1,
      tool: __circuitCheck.ERASE_TOOL, rate: 1, replace: false,
      filter: __circuitCheck.E.BATTERY, erase: true }));
    function assertPaint(result) { if (result === false) throw new Error('Native erase was not admitted'); }
  }, water.supply);
  await advance(80);
  assert.equal((await sample(water.supply)).material, await page.evaluate(() => __circuitCheck.E.EMPTY));
  assert.equal((await sample(water.gate)).life, ELEC.SWITCH_ON, 'Latch remembers ON but cannot manufacture drive power');
  for (const input of water.inputs) assert.equal((await sample(input)).life, 0);

  console.log('stage: Stop uses its separate physical control supply');
  await press(water.buttons.stop);
  await advance(8);
  assert.equal((await sample(water.gate)).life, 0);
  if (process.argv.includes('--screenshot')) {
    await page.evaluate(() => {
      const a = __app;
      a.camera.position.set(134, 67, 109).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.set(146, 61, 101).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.update(); a.post.reset();
    });
    await render(page);
    mkdirSync('/tmp/tpt-electronics', { recursive: true });
    await page.screenshot({ path: '/tmp/tpt-electronics/waterworks.png' });
  }
  assert.deepEqual(errors, []);
  console.log('PASS real E, momentary release, native relay, eight confirmed pumps, physical supply cut, Stop');
} finally {
  await browser?.close();
  await vite?.close();
}
