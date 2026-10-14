// Parent-owned focused GPU run (NOT run by the physics worker).
// Start your own server: npx vite --port 54937 --strictPort
// Then: node tools/industry-gpu-check.mjs --port 54937
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const args = process.argv.slice(2), port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '54937';
const browser = await launchBrowser();
const errors = [];
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 800, height: 500 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await ready(page);
  const results = await page.evaluate(async () => {
    const app = window.__app, sim = app.sim;
    app.test.park(); await app.test.ready();
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { ELEC, SPARK_BORN, SPARK_CYCLE } = await import('/src/electricity.js');
    const { createIndustryPhysics, controlCell, machinePorts } = await import('/src/industry/physics.js');
    const { baseMaterial, deviceCell, CASTING_TEMPERATURE } = await import('/src/industry/catalog.js');
    const shipped = [], failures = [], checks = [];
    const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
    const physics = createIndustryPhysics({ getSim: () => sim, onShip: c => shipped.push(c), onError: e => failures.push(String(e)) });
    const fill = sim.editKernel('industryFixture', { params: { cell: 'vec4f' }, update: `
      fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
        *oA = P.cell; *oB = vec4f(0.0);
      }` });
    await Promise.all([physics.ready, fill.ready]);
    const put = (at, id, temperature = 20, life = 0, ct = 0) => sim.edit(fill, { lo: at, hi: at }, { cell: [id, temperature, life, ct + 0.125] });
    const base = d => sim.edit(fill, { lo: [d.x, d.y, d.z], hi: [d.x + 3, d.y, d.z + 3] }, { cell: [baseMaterial(d.type), 20, 0, 0.125] });
    const d = (type, x, z, extras = {}) => ({ id: `${type}-${x}-${z}`, type, x, y: 8, z, rotation: 0, ...extras });
    const belt = d('belt', 8, 8), sort = d('separator', 20, 8), lift = d('lift', 32, 8), heater = d('heater', 44, 8), miner = d('miner', 56, 8);
    const battery = d('belt', 8, 24, { powered: true }), sw = d('belt', 20, 24, { powered: true });
    const dead = d('belt', 32, 24), spark = d('belt', 44, 24, { powered: true });
    const ship = d('ship', 8, 40), pump = d('pump', 24, 40);
    const ds = [belt, sort, lift, heater, miner, battery, sw, dead, spark, ship, pump];
    try {
      sim.clear(); ds.forEach(base);
      for (const m of [belt, sort, lift, battery, sw, dead, spark]) put(deviceCell(m, 1, 1, 1), E.NUGGETS);
      put(deviceCell(belt, 2, 2, 1), E.SAND); // airborne: must not be accelerated
      put(deviceCell(sort, 2, 1, 1), E.SAND);
      put(deviceCell(heater, 1, 1, 1), E.METAL);
      put(deviceCell(miner, 1, 1, 4), E.ROCK);
      put(deviceCell(miner, 1, 1, 5), E.ROCK); // occluded until next pulse
      put(deviceCell(miner, 1, 1, 8), E.ROCK); // beyond finite reach
      put(controlCell(battery), E.BATTERY);
      put(controlCell(sw), E.SWITCH, 20, 0);
      put(controlCell(spark), E.METAL, 20, 0, SPARK_BORN + SPARK_CYCLE * ELEC.SPARK_V);
      put(deviceCell(dead, 0, 0, 0), E.EMPTY);
      const inlet = machinePorts(pump).inlet;
      inlet.forEach(c => put(c, E.WATER, 27));
      machinePorts(pump).outlet.forEach(c => put(c, E.WALL));
      put(deviceCell(ship, 0, 1, 0), E.NUGGETS);
      put(deviceCell(ship, 1, 1, 0), E.METAL, CASTING_TEMPERATURE - 1);
      put(deviceCell(ship, 2, 1, 0), E.METAL, CASTING_TEMPERATURE);
      put(deviceCell(ship, 3, 1, 0), E.METAL, CASTING_TEMPERATURE + 1);
      const read = (m, x = 1, y = 1, z = 1) => sim.readCell(...deviceCell(m, x, y, z));
      const flush = async () => { await sim.readCell(0, 0, 0); await new Promise(r => setTimeout(r, 0)); };
      physics.step(0.1, ds); await flush();
      check((await read(belt))[1][2] > 0.59, 'belt drives supported grain forward');
      check((await read(belt, 2, 2))[1][2] === 0, 'belt leaves airborne grain alone');
      check((await read(sort))[1][2] > 0.59 && (await read(sort, 2))[1][0] > 0.59, 'sorter splits gold forward / sand right');
      check((await read(lift))[1][1] === 1, 'lift propels real grain');
      check((await read(heater))[0][1] > 190, 'furnace heats actual matter');
      check((await read(battery))[1][2] > 0 && (await read(spark))[1][2] > 0, 'native battery and live conductor enable control');
      check((await read(sw))[1][2] === 0, 'off native switch stops drive');
      check((await read(dead))[1][2] === 0, 'one destroyed base cell stops drive');
      put(controlCell(sw), E.SWITCH, 20, ELEC.SWITCH_ON);
      for (let i = 0; i < 3; i++) { physics.step(0.1, ds); await flush(); }
      check((await read(sw))[1][2] > 0, 'enabled native switch enables drive');
      check((await read(miner, 1, 1, 4))[0][0] === E[ELEMENTS[E.ROCK].breakInto], 'miner leaves native debris in world');
      check((await read(miner, 1, 1, 5))[0][0] === E.ROCK, 'miner does not drill through occluding face in same pulse');
      check((await read(miner, 1, 1, 8))[0][0] === E.ROCK, 'miner has finite reach');
      check(shipped.filter(c => c.id === E.NUGGETS).length === 1 && shipped.filter(c => c.id === E.METAL).length === 2, 'shipping confirms only actual removed valuable cells');
      check((await read(ship, 2, 1, 0))[0][0] === E.EMPTY && (await read(ship, 3, 1, 0))[0][0] === E.METAL, 'casting-temperature metal ships; hotter metal remains at intake');
      check(physics.pending === 0 && physics.buffered === 8, 'blocked pump conserves eight serializable liquid cells');
      machinePorts(pump).outlet.forEach(c => put(c, E.EMPTY));
      for (let i = 0; i < 2; i++) { physics.step(0.1, ds); await flush(); }
      check((await sim.readCell(...machinePorts(pump).outlet[0]))[0][0] === E.WATER, 'pump deposits actual water at elevated outlet');
      check(physics.pending === 0, 'successful pump delivery drains conserved cargo');
      // Native movement at the default four steps/frame, not merely velocity
      // assertions: one belt grain must leave its initial cell and lift rises.
      let lifted = false;
      for (let frame = 0; frame < 12; frame++) {
        physics.step(1 / 60, [belt, lift]);
        for (let n = 0; n < 4; n++) sim.step();
        if (frame < 3) {
          for (let y = 10; y <= 15; y++) if ((await sim.readCell(33, y, 9))[0][0] === E.NUGGETS) lifted = true;
        }
      }
      check((await read(belt))[0][0] !== E.NUGGETS, 'belt grain actually travels at default sim speed');
      check(lifted, 'lift grain actually rises under native gravity');
      // A whole production line, not just a velocity probe: drill a GOLD face,
      // carry its native NUGGETS backward, and ship them through a second belt.
      sim.clear(); physics.reset(); await physics.ready; shipped.length = 0;
      const digger = d('miner', 8, 12), rearBelt = d('belt', 8, 8, { rotation: 2 });
      const receiver = d('ship', 8, 4, { rotation: 2 });
      [digger, rearBelt, receiver].forEach(base);
      for (let z = 16; z <= 17; z++) for (let x = 8; x <= 11; x++) {
        put([x, 8, z], E.ROCK);
        put([x, 9, z], E.GOLD);
        put([x, 10, z], E.GOLD);
      }
      for (let frame = 0; frame < 240; frame++) {
        physics.step(1 / 60, [digger, rearBelt, receiver]);
        for (let n = 0; n < 4; n++) sim.step();
        if (frame % 6 === 5) await flush();
      }
      check(shipped.some(c => c.id === E.NUGGETS), 'mining agent -> real debris -> rear belt -> shipping intake');
      check(failures.length === 0, `no async errors: ${failures.join(', ')}`);
      return checks;
    } finally { physics.dispose(); app.test.park(); }
  });
  results.forEach(s => console.log(`PASS ${s}`));
  assert.deepEqual(errors, []);
  console.log(`${results.length} industry GPU checks passed`);
} finally { await browser.close(); }
