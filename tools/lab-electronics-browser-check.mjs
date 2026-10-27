// Actual E input, native circuits and registered pumps on the full authored map.
// One 25-second slot; the numerical test advances the normal native callbacks.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { preservationManifest, PRESERVATION_SIZE } from '../src/lab/preservation/index.js';
import { BUTTON_HOLD, ELEC } from '../src/electricity.js';
import { E } from '../src/elements.js';
import { controlCell, deviceCell } from '../src/industry/catalog.js';
import { hearthRegions } from '../src/industry/hearth.js';
import { createIndustryDiagnostics } from '../src/industry/diagnostics.js';

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const layout = preservationManifest();
const wave = layout.circuits.find(c => c.id === 'light-wave');
const water = layout.circuits.find(c => c.id === 'processing-cascade');
const pumps = layout.devices.filter(d => water.inputs.some(p =>
  p.every((v, i) => v === controlCell(d)[i])));
assert.equal(pumps.length, 8);
const external = option('url', null);
const foundryOnly = process.argv.includes('--foundry');
const thermal = process.argv.includes('--thermal') || foundryOnly;
function productTargets() {
  const targets = layout.devices.filter(d => d.type === 'hearth').map(device => {
    const reaction = device.id === 'exceptions-reaction-hearth';
    const cells = [...hearthRegions(device).firebox, ...hearthRegions(device).outlet, ...hearthRegions(device).mouth];
    const [xs, ys, zs] = reaction ? [[1, 2], [-4, 9], [2, 5]] : [[0, 5], [-2, -1], [4, 10]];
    for (let x = xs[0]; x <= xs[1]; x++) for (let y = ys[0]; y <= ys[1]; y++)
      for (let z = zs[0]; z <= zs[1]; z++) cells.push(deviceCell(device, x, y, z));
    return { name: device.id, device, cells: [...new Map(cells.map(p => [p.join(','), p])).values()],
      ids: reaction ? [E.LAVA] : [E.LAVA, E.GOLD] };
  });
  const separator = layout.devices.find(d => d.type === 'separator');
  for (const [name, id, x0, x1, z0, z1] of [
    ['sand-bin', E.SAND, -1, 4, 12, 18], ['gold-bin', E.NUGGETS, 4, 11, -1, 4],
  ]) {
    const cells = [];
    for (let x = x0; x <= x1; x++) for (let y = -3; y <= -2; y++)
      for (let z = z0; z <= z1; z++) cells.push(deviceCell(separator, x, y, z));
    targets.push({ name, device: separator, cells, ids: [id] });
  }
  return targets;
}
const targets = thermal ? productTargets().filter(t => !foundryOnly || t.name === 'receiving-coal-hearth') : [];
// Exercise the production request validator before claiming a GPU slot.
// The intentionally GPU-less simulation must fail at prepare(), not validation.
const metadata = { g: Object.fromEntries(['nx', 'ny', 'nz'].map((k, i) => [k, PRESERVATION_SIZE[i]])) };
const preflight = createIndustryDiagnostics({ getSim: () => metadata });
for (const target of targets) {
  const result = await preflight.inspect({ ...target.device, type: 'control-cell' }, {
    regions: { products: { cells: target.cells, ids: target.ids } },
  });
  assert.equal(result.reason, 'observation failed: Industry simulation is unavailable');
}
preflight.dispose();
if (process.argv.includes('--preflight')) {
  console.log(`PASS ${targets.length} bounded product probes validated without GPU`);
  process.exit(0);
}
const vite = external ? null : await startVite({
  port: Number(option('port', 54985)), warmupEntries: ['/src/main.js', '/src/app.js'],
});
let browser;
try {
  browser = await launchBrowser({ lifetimeMs: 25000,
    why: foundryOnly ? 'Full-map isolated foundry: real E, finite coal heat and native products' :
      thermal ? 'Full-map real E switches: finite coal foundry and thermite native products' :
      'Physical E buttons: full-map light pulse, eight-pump Start, drive-supply cut and Stop' });
  const viewport = { width: 800, height: 600 };
  const page = await newTestPage(browser, { mode: 'manual', viewport });
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
    await a.physics.v2.dynamicsReady;
    const { createIndustryDiagnostics } = await import('/src/industry/diagnostics.js');
    const { E, TOOLS } = await import('/src/elements.js');
    const ERASE_TOOL = TOOLS.find(t => t.key === 'ERASE').id;
    const { HOST_HZ } = await import('/src/v2/host.js');
    const { machinePorts } = await import('/src/industry/physics.js');
    const { cid, ctypeOf } = await import('/src/v2/layout.js');
    const probe = createIndustryDiagnostics({ getSim: () => a.sim, throttleMs: 0 });
    let probeIndex = 0;
    window.__circuitCheck = {
      E, ERASE_TOOL, probe,
      async sample(cell) {
        const d = { id: `probe-${++probeIndex}`, type: 'control-cell', rotation: 0,
          x: Math.min(cell[0], a.sim.g.nx - 4), y: cell[1], z: Math.min(cell[2], a.sim.g.nz - 4) };
        const result = await probe.inspect(d, {
          regions: {}, guard: { base: [0, 0, 0], material: -1, port: cell, powered: true },
        });
        return result.evidence.control.sample;
      },
      async discharge(device) {
        const result = await probe.inspect({ ...device, id: `discharge-${++probeIndex}` }, {
          regions: { discharge: { cells: machinePorts(device).outlet, ids: [E.WATER] } },
        });
        return result.evidence.regions.discharge.eligible;
      },
      async products({ device, cells, ids, requiresPositiveLife = false }) {
        const result = await probe.inspect({ ...device, type: 'control-cell', id: `products-${++probeIndex}` }, {
          regions: { products: { cells, ids, requiresPositiveLife } },
        });
        if (!result.evidence) throw new Error(`Product probe refused: ${result.reason}`);
        return result.evidence.regions.products;
      },
      async castGold() {
        // Grid projection and the separate flying-matter owner must BOTH be
        // read: a launched pour is not necessarily in the projected voxel grid.
        const read = a.sim.readState();
        const dynamic = a.physics.v2.dynamics.snapshotDynamicState();
        await a.sim.gpuSync();
        const [cells] = await read;
        let solid = 0, molten = 0;
        for (let i = 0; i < cells.length; i += 4) {
          const id = Math.round(cells[i]);
          if (id === E.GOLD) solid++;
          if (id === E.LAVA && Math.floor(cells[i + 3]) === E.GOLD) molten++;
        }
        const { particles } = await dynamic;
        let flyingSolid = 0, flyingMolten = 0;
        for (let i = 0; i < particles.length; i += 12) {
          if (!particles[i + 3]) continue;
          const core = particles.subarray(i + 7, i + 11), id = cid(core);
          if (id === E.GOLD) flyingSolid++;
          if (id === E.LAVA && ctypeOf(core) === E.GOLD) flyingMolten++;
        }
        return { solid: solid + flyingSolid, molten: molten + flyingMolten, flyingSolid, flyingMolten };
      },
      async advance(n) {
        for (let i = 0; i < n; i++) {
          a.test.step(1);
          // Production afterStep clock, following nativeAfterStep's actuator callback.
          a.industry.update(1 / HOST_HZ, true, true);
          if (i % 8 === 7) {
            await a.sim.gpuSync();
            await new Promise(requestAnimationFrame);
          }
        }
        await a.sim.gpuSync();
        // Native pump take/put confirmations finish through asynchronous GPU
        // readbacks. Drain work already submitted, without extra physics ticks.
        for (let pass = 0; pass < 32 && a.industry.pending; pass++) {
          await a.sim.gpuSync();
          await new Promise(requestAnimationFrame);
        }
        if (a.industry.pending) throw new Error(`Native transfers did not drain at frame ${a.sim.frame}`);
        await a.sim.gpuSync();
      },
    };
  });
  console.log('adapter:', (await gpuInfo(page)).description);
  assert.equal(await page.evaluate(() => __app.industry.state.devices.length), 18);
  const sample = cell => page.evaluate(p => __circuitCheck.sample(p), cell);
  const advance = n => page.evaluate(n => __circuitCheck.advance(n), n);
  async function press(cell, expectedLife = BUTTON_HOLD) {
    await page.evaluate(cell => {
      const a = __app;
      a.camera.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] - 4.5)
        .multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.set(...cell.map(n => n + 0.5)).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.update(); a.camera.updateMatrixWorld(true); a.volume.updateMatrixWorld(true);
      document.activeElement?.blur();
    }, cell);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
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
    assert.equal(result.life, expectedLife, 'Actual E listener must activate the native contact');
    return result;
  }
  let seenProducts = null;
  if (thermal) {
    const initialGold = await page.evaluate(() => __circuitCheck.castGold());
    for (const target of targets) {
      assert(target.cells.length <= 128);
      assert.equal((await page.evaluate(t => __circuitCheck.products(t), target)).eligible, 0);
    }
    console.log('stage: real maintained switches');
    for (const id of foundryOnly ? ['receiving-foundry-control'] :
      ['receiving-sort-control', 'receiving-foundry-control', 'exceptions-reaction-station']) {
      await press(layout.circuits.find(c => c.id === id).gate, ELEC.SWITCH_ON);
    }
    const seen = new Set();
    // Include cold-metal preheating after the electrical wave arrives.
    for (let checkpoint = 0; checkpoint < Number(option('checkpoints', 24)); checkpoint++) {
      await advance(16);
      for (const target of targets) {
        const observed = await page.evaluate(t => __circuitCheck.products(t), target);
        if (observed.eligible > 0 && !seen.has(target.name)) {
          if (target.name !== 'receiving-coal-hearth') seen.add(target.name);
          console.log('native products:', target.name, observed);
        }
      }
      if (checkpoint % 2 === 1) {
        const gold = await page.evaluate(() => __circuitCheck.castGold());
        console.log('native cast gold including packets:', gold, 'initial:', initialGold);
        if (gold.solid > initialGold.solid || gold.molten > initialGold.molten) seen.add('receiving-coal-hearth');
      }
      if (seen.size === targets.length) break;
    }
    const foundry = layout.devices.find(d => d.id === 'receiving-coal-hearth');
    console.log('foundry final control:', await sample(controlCell(foundry)));
    console.log('foundry remaining fuel:', await page.evaluate(t => __circuitCheck.products(t), {
      device: foundry, cells: hearthRegions(foundry).firebox,
      ids: [E.COAL, E.BROKENCOAL], requiresPositiveLife: true,
    }));
    if (process.argv.includes('--diagnose')) {
      const values = [];
      for (const cell of hearthRegions(foundry).firebox) values.push({ cell, ...(await sample(cell)) });
      console.log('actual foundry firebox:', values);
    }
    seenProducts = [...seen].sort();
  } else {
  console.log('stage: momentary light-wave input');
  await press(wave.gate);
  await advance(1);
  assert((await sample(wave.indicator)).ctype > 0, 'Native indicator receives the pulse');
  await advance(3);
  assert.equal((await sample(wave.gate)).life, 0, 'Native button releases without a map callback');

  console.log('stage: Start, native relay and eight native pumps');
  assert.equal(await page.evaluate(d => __circuitCheck.discharge(d), pumps.at(-1)), 0,
    'The top outlet starts empty, above the primed suction pockets');
  const startedAt = await page.evaluate(() => Date.now());
  await press(water.buttons.start);
  await advance(96);
  assert.equal((await sample(water.gate)).life, ELEC.SWITCH_ON);
  for (const input of water.inputs) assert((await sample(input)).life > 0, `Receiver at ${input} has supply`);
  const observations = await page.evaluate(async ids => {
    const out = [];
    for (const id of ids) out.push(await __app.industry.observe(id));
    return out;
  }, pumps.map(d => d.id));
  console.log('native pump observations:', observations.map(o => ({
    id: o.id, status: o.status, running: o.running, transfer: o.transferHistory,
  })));
  assert(observations.every(o => o?.running === 'confirmed-transfer-observed'
    && o.transferHistory.count > 0 && o.transferHistory.observedAt >= startedAt),
  'All eight pumps need actual confirmed transfers during the powered interval');
  assert((await page.evaluate(d => __circuitCheck.discharge(d), pumps.at(-1))) > 0,
    'Actual water reaches the initially empty high outlet');

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
  }
  if (process.argv.includes('--screenshot')) {
    await page.evaluate(thermal => {
      const a = __app;
      a.camera.position.set(...(thermal ? [44, 43, 94] : [134, 67, 109])).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.target.set(...(thermal ? [29, 42, 89] : [146, 61, 101])).multiplyScalar(a.scale).add(a.volume.position);
      a.controls.update(); a.post.reset();
    }, thermal);
    await render(page);
    mkdirSync('/tmp/tpt-electronics', { recursive: true });
    await page.screenshot({ path: `/tmp/tpt-electronics/${thermal ? 'foundry' : 'waterworks'}.png` });
  }
  if (thermal) {
    assert.deepEqual(seenProducts, targets.map(t => t.name).sort(),
      'Selected installations need actual native products');
    console.log('PASS actual E-operated native products; no forced heat, phase or grain placement');
  }
  assert.deepEqual(errors, []);
  if (!thermal) console.log('PASS real E, momentary release, native relay, eight confirmed pumps, physical supply cut, Stop');
} finally {
  await browser?.close();
  await vite?.close();
}
