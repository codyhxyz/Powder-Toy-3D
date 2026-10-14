// Native phase-change checkpoint: mined scrap -> melt -> cold metal -> shipment.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '19543';
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 300 } });
  await page.goto(`http://localhost:${port}/?size=128&preset=empty&view=plain`);
  await ready(page);
  const result = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim;
    const { E } = await import('/src/elements.js');
    const { createIndustryPhysics } = await import('/src/industry/physics.js');
    const { baseMaterial } = await import('/src/industry/catalog.js');
    const device = { id: 'thermal', type: 'heater', x: 48, y: 12, z: 48, rotation: 0 };
    const intake = { id: 'collector', type: 'ship', x: 48, y: 14, z: 56, rotation: 0 };
    const meltPump = { id: 'molten-pour', type: 'pump', x: 48, y: 12, z: 52, rotation: 0 };
    const pump = { id: 'coolant', type: 'pump', x: 52, y: 16, z: 56, rotation: 1 };
    const line = [device, meltPump, pump, intake];
    let shipped = 0;
    const physics = createIndustryPhysics({ getSim: () => sim, onShip: c => { if (c.id === E.METAL) shipped += c.count; } });
    const fill = sim.editKernel('industryThermalFixture', { params: { material: 'vec4f' }, update: `
      fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
        *oA = P.material; *oB = vec4f(0.0);
      }` });
    await Promise.all([physics.ready, fill.ready]);
    const box = (lo, hi, id, temp = 20) => sim.edit(fill, { lo, hi }, { material: [id, temp, 0, 0.125] });
    try {
      sim.clear();
      box([44, 0, 44], [67, 7, 67], E.ROCK);
      box([48, 8, 48], [51, 11, 51], E.ROCK);
      box([48, 12, 48], [51, 12, 51], baseMaterial('heater'));
      box([48, 14, 56], [51, 14, 59], baseMaterial('ship'));
      // Separate hot hearth and lower, cold casting catch. These never share
      // footprints, and all machines exist before material enters the line.
      box([47, 8, 47], [47, 16, 51], E.TUNGSTEN);
      box([52, 8, 47], [52, 15, 51], E.TUNGSTEN);
      box([48, 8, 47], [51, 16, 47], E.TUNGSTEN);
      box([48, 12, 52], [51, 12, 55], baseMaterial('pump'));
      box([47, 14, 55], [47, 20, 60], E.TUNGSTEN);
      box([52, 14, 55], [52, 15, 60], E.TUNGSTEN);
      box([48, 14, 55], [51, 20, 55], E.TUNGSTEN);
      box([48, 14, 60], [51, 20, 60], E.TUNGSTEN);
      box([52, 16, 56], [55, 16, 59], baseMaterial('pump'));
      // Elevated finite reservoir feeds the pump's actual adjacent inlet.
      box([56, 16, 55], [82, 24, 60], E.TUNGSTEN);
      box([56, 17, 56], [81, 24, 59], E.WATER);
      box([48, 13, 48], [51, 13, 51], E.SCRAP);
      let peak = 0, melted = false, frames = 0;
      for (; frames < 1200; frames++) {
        physics.step(1 / 60, line);
        a.test.step(4);
        if (frames % 30 === 29) {
          const [cell] = await sim.readCell(49, 13, 49);
          peak = Math.max(peak, cell[1]);
          if (cell[0] === E.LAVA || shipped) { melted = true; break; }
        }
      }
      // Keep the line running: liquid must flow off the hearth, down the chute,
      // and meet real pumped coolant. No direct state edits after startup.
      for (let frame = 0; frame < 1200; frame++) {
        physics.step(1 / 60, line);
        a.test.step(4);
        if (frame % 30 === 29) {
          await a.gpu.fence();
          if (shipped > 0) break;
        }
      }
      const [cooled] = await sim.readCell(49, 15, 57);
      await a.gpu.fence();
      const [cells] = await sim.readState(), samples = [], counts = {};
      for (let y = 8; y < 32; y++) for (let z = 44; z < 68; z++) for (let x = 44; x < 68; x++) {
        const i = sim.cellTexel(x, y, z) * 4, id = cells[i];
        if (![E.METAL, E.SCRAP, E.LAVA, E.WATER].includes(id)) continue;
        counts[id] = (counts[id] || 0) + 1;
        if (id !== E.WATER && samples.length < 20) samples.push([x, y, z, id, Math.round(cells[i + 1])]);
      }
      melted ||= !!counts[E.LAVA] || !!counts[E.METAL] || shipped > 0;
      return { melted, peak, frames, cooled: [...cooled], metal: E.METAL, shipped, counts, samples };
    } finally { physics.dispose(); }
  });
  console.log(JSON.stringify(result));
  assert(result.melted, 'furnace must actually melt scrap at default timing');
  assert(result.shipped > 0, 'native cooled metal must reach the shipping economy');
} finally { await browser.close(); }
