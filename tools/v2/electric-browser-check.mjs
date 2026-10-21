// GPU: the production electric pass (shaders/v2/electric.js) on a real device,
// against its CPU twin (v2/electric.js) and V1's timing. One slot, one launch.
//   - a battery and a metal wire of WIRE cells: cell k first live at tick
//     ceil(k / 4), so the far end in WIRE / 4 ticks, V1's WIRE steps;
//   - a battery, metal and fresh water: the GPU's cores equal the twin's every
//     tick, and the energy ledger's source equals the twin's Joule heat exactly;
//   - a lit fuse: its front reaches the next cell on the tick V1's FUSE_STEPS_PER_CELL
//     steps give, and the GPU's cores still equal the twin's there.
// The driver's sequence (gather, args, commit, then three gather/commit steps,
// over the awake list and then the electric list) runs on the harness's device.
// usage: node tools/v2/electric-browser-check.mjs [--out result.json]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';
import { PHYS } from '../../src/physics.js';

const outputIndex = process.argv.indexOf('--out');
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
const TICKS = 8, WIRE = 28, FUSE_TICKS = 280;
const vite = await startVite({ harness: true, port: 19643 });
let browser;
const t0 = Date.now();
try {
  browser = await launchBrowser();
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/outcomes.html?engine=v2', { errors });
  const result = await page.evaluate(async ({ TICKS, WIRE, FUSE_TICKS }) => {
    const { gridLayout } = await import('/src/sim.js');
    const { E } = await import('/src/elements.js');
    const { LAYOUT, tablesBuffer, cellSlot, slotCell } = await import('/src/shaders/common.js');
    const { V2Params, V2_CONTACT_LAYOUT, V2_ARGS_LAYOUT, v2ActLayout, v2Table, ARGS2 } = await import('/src/shaders/v2.js');
    const { v2ElecGatherWGSL, v2ElecArgsWGSL, v2ElecCommitWGSL } = await import('/src/shaders/v2/electric.js');
    const { ctNew, CONTACT_CONSTANTS } = await import('/src/v2/contact.js');
    const { electricGrid, setGridCell, gridIndex, electricTick, ELEC_STEPS } = await import('/src/v2/electric.js');
    const gpu = window.__harness.gpu, g = gridLayout(32, 32, 32), a = v2ActLayout(g), buffers = [];
    const q = T => Math.round((T + 273.25) * 4);
    const buffer = (name, size, data, extra = 0) => {
      const b = gpu.createBuffer({ label: name, size: Math.max(16, Math.ceil(size / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
      buffers.push(b); if (data) gpu.queue.writeBuffer(b, 0, data); return b;
    };
    try {
      // the twin's grid is the fixture: air; a battery and a metal wire on row (y 4, z 4);
      // a battery, 3 metal and 5 fresh water walled in on row (y 20, z 20)
      const twin = electricGrid(32, 32, 32);
      for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setGridCell(twin, x, y, z, ctNew(E.EMPTY, q(20), 65536));
      setGridCell(twin, 0, 4, 4, ctNew(E.BATTERY, q(20), 65536));
      for (let x = 1; x <= WIRE; x++) setGridCell(twin, x, 4, 4, ctNew(E.METAL, q(20), 65536));
      for (let x = 0; x <= 10; x++) for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) setGridCell(twin, x, 20 + dy, 20 + dz, ctNew(E.WALL, q(20), 65536));
      setGridCell(twin, 0, 20, 20, ctNew(E.BATTERY, q(20), 65536));
      for (let x = 1; x <= 3; x++) setGridCell(twin, x, 20, 20, ctNew(E.METAL, q(20), 65536));
      for (let x = 4; x <= 8; x++) setGridCell(twin, x, 20, 20, ctNew(E.WATER, q(20), 65536));
      setGridCell(twin, 9, 20, 20, ctNew(E.WALL, q(20), 65536));
      // three fuse cells on row (y 12, z 12), the first lit by hand (V1's 1 - FUSE_BURN: one step in)
      for (let x = 1; x <= 3; x++) setGridCell(twin, x, 12, 12, ctNew(E.FUSE, q(20), 65536));
      { const f = ctNew(E.FUSE, q(20), 65536); f.life = CONTACT_CONSTANTS.CT_FUSE_UNLIT[1] - 1; setGridCell(twin, 1, 12, 12, f); }
      // into GPU slot order
      const toSlots = () => {
        const cores = new Uint32Array(g.slots * 4), banks = new Int32Array(g.slots);
        for (let s = 0; s < g.slots; s++) {
          const [x, y, z] = slotCell(g, s), i = gridIndex(twin, x, y, z);
          cores.set(twin.cores.subarray(4 * i, 4 * i + 4), 4 * s); banks[s] = twin.banks[i];
        }
        return { cores, banks };
      };
      const start = toSlots();
      const act = new Uint32Array(a.allocated);
      act[a.count + 3] = g.nbricks;   // CNT_USE_AWAKE: every brick awake, as after a full import
      for (let b = 0; b < g.nbricks; b++) act[a.list + b] = b;
      const argsData = new Uint32Array(ARGS2.allocated); argsData.set([g.nbricks, 1, 1], ARGS2.BRICKS);
      const cells = buffer('electric cells', start.cores.byteLength, start.cores);
      const banks = buffer('electric banks', start.banks.byteLength, start.banks);
      const actBuf = buffer('electric activity', act.byteLength, act);
      const ev = v2Table(), legacy = tablesBuffer();
      const evBuf = buffer('electric elements', ev.byteLength, ev);
      const args = buffer('electric args', argsData.byteLength, argsData, GPUBufferUsage.INDIRECT);
      const entry = (binding, b) => ({ binding, resource: { buffer: b } });
      const tables = gpu.layout('electric tables', LAYOUT.TABLES), contact = gpu.layout('electric contact', V2_CONTACT_LAYOUT), argsLayout = gpu.layout('electric args', V2_ARGS_LAYOUT);
      const tablesGroup = gpu.bindGroup(tables, [entry(0, buffer('electric legacy tables', legacy.byteLength, legacy))]);
      const contactBind = [tablesGroup, gpu.emptyGroup, gpu.bindGroup(contact, [entry(0, cells), entry(1, actBuf), entry(2, evBuf), entry(4, banks),
        entry(5, buffer('electric liquid scratch', g.slots * 16)), entry(6, buffer('electric events', g.slots * 4))])];
      const argsBind = [tablesGroup, gpu.emptyGroup, gpu.bindGroup(argsLayout, [entry(0, cells), entry(1, actBuf), entry(2, evBuf), entry(3, args)])];
      const compile0 = performance.now();
      const kernel = (name, code, layout, workgroupSize = [64, 1, 1]) => gpu.kernel({ name, code, params: V2Params, layouts: [tables, gpu.L.EMPTY, layout], workgroupSize });
      const gather = kernel('electric gather', v2ElecGatherWGSL(g), contact);
      const publish = kernel('electric args', v2ElecArgsWGSL(g), argsLayout, [1, 1, 1]);
      const commit = kernel('electric commit', v2ElecCommitWGSL(g), contact);
      await Promise.all([gather.ready, publish.ready, commit.ready]);
      const compileMs = performance.now() - compile0;
      const ind = at => ({ indirect: args, offset: at * 4 });
      const first = Array(WIRE + 1).fill(-1), mismatches = [];
      let twinSource = 0n, listed = [];
      const run0 = performance.now();
      for (let tick = 1; tick <= TICKS; tick++) {
        for (let elecStep = 0; elecStep < ELEC_STEPS; elecStep++) {
          const params = { tick, busyIn: 0, busyOut: a.busy1, full: 0, offset: [0, 0, 0], preserveLegacyMarks: 0, gravMode: 1, edge: 0, airMode: 0, ambientHeat: 1, gravity: 0, ambient: 20, elecStep };
          gather.dispatch(gpu.frame, ind(elecStep === 0 ? ARGS2.BRICKS : ARGS2.ELEC), { bind: contactBind, params });
          if (elecStep === 0) publish.dispatch(gpu.frame, [1, 1, 1], { bind: argsBind, params });
          commit.dispatch(gpu.frame, ind(ARGS2.ELEC), { bind: contactBind, params });
        }
        const r = electricTick(twin, tick);
        twinSource += r.source; listed.push(r.listed.length);
        await gpu.fence();
        const raw = new Uint32Array(await gpu.readback.buffer(cells, 0, g.slots * 16));
        const want = toSlots();
        for (let s = 0; s < g.slots; s++) for (let w = 0; w < 4; w++) if (raw[4 * s + w] !== want.cores[4 * s + w] && mismatches.length < 8) mismatches.push({ tick, cell: slotCell(g, s), word: w, gpu: raw[4 * s + w], twin: want.cores[4 * s + w] });
        for (let x = 1; x <= WIRE; x++) {
          const w = raw[4 * cellSlot(g, x, 4, 4) + 3] & 4095;
          if (first[x] < 0 && w % 9 > 4) first[x] = tick;
        }
      }
      // the fuse: on to FUSE_TICKS, reading the second cell as the front reaches it
      const fuseSlot = cellSlot(g, 2, 12, 12), UNLIT = CONTACT_CONSTANTS.CT_FUSE_UNLIT[1];
      let twinLit = -1, gpuLit = -1;
      for (let tick = TICKS + 1; tick <= FUSE_TICKS; tick++) {
        for (let elecStep = 0; elecStep < ELEC_STEPS; elecStep++) {
          const params = { tick, busyIn: 0, busyOut: a.busy1, full: 0, offset: [0, 0, 0], preserveLegacyMarks: 0, gravMode: 1, edge: 0, airMode: 0, ambientHeat: 1, gravity: 0, ambient: 20, elecStep };
          gather.dispatch(gpu.frame, ind(elecStep === 0 ? ARGS2.BRICKS : ARGS2.ELEC), { bind: contactBind, params });
          if (elecStep === 0) publish.dispatch(gpu.frame, [1, 1, 1], { bind: argsBind, params });
          commit.dispatch(gpu.frame, ind(ARGS2.ELEC), { bind: contactBind, params });
        }
        twinSource += electricTick(twin, tick).source;
        const twinFuse = twin.cores[4 * gridIndex(twin, 2, 12, 12) + 1] & 65535;
        if (twinLit < 0 && twinFuse < UNLIT) twinLit = tick;
        if (tick >= FUSE_TICKS - 20 && gpuLit < 0) {
          await gpu.fence();
          const core = new Uint32Array(await gpu.readback.buffer(cells, fuseSlot * 16, 16));
          if ((core[1] & 65535) < UNLIT) gpuLit = tick;
        }
      }
      await gpu.fence();
      const rawEnd = new Uint32Array(await gpu.readback.buffer(cells, 0, g.slots * 16)), wantEnd = toSlots();
      for (let s = 0; s < g.slots; s++) for (let w = 0; w < 4; w++) if (rawEnd[4 * s + w] !== wantEnd.cores[4 * s + w] && mismatches.length < 8) mismatches.push({ tick: FUSE_TICKS, cell: slotCell(g, s), word: w, gpu: rawEnd[4 * s + w], twin: wantEnd.cores[4 * s + w] });
      const runMs = performance.now() - run0;
      const actOut = new Uint32Array(await gpu.readback.buffer(actBuf, 0, act.byteLength));
      const source = BigInt(actOut[a.energySource]) + (BigInt(actOut[a.energySource + 1]) << 32n) + (BigInt(actOut[a.energySource + 2]) << 64n);
      const sink = BigInt(actOut[a.energySink]) + (BigInt(actOut[a.energySink + 1]) << 32n);
      const flagsClear = Array.from(actOut.subarray(a.elecFlag, a.elecFlag + g.nbricks)).every(v => v === 0);
      const scratchClear = Array.from(actOut.subarray(a.elecScratch, a.elecScratch + g.slots)).every(v => v === 0);
      return { ticks: TICKS, wire: WIRE, first, fuseTicks: FUSE_TICKS, twinLit, gpuLit, compileMs, runMs, mismatches, gpuSource: String(source), twinSource: String(twinSource), sink: String(sink), listed, flagsClear, scratchClear, failures: [...window.__harness.failures] };
    } finally { for (const b of buffers) b.destroy(); }
  }, { TICKS, WIRE, FUSE_TICKS });
  result.errors = errors;
  result.slotMs = Date.now() - t0;
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.mismatches, [], 'GPU cores equal the CPU twin\'s every tick');
  for (let x = 1; x <= WIRE; x++) assert.equal(result.first[x], Math.ceil(x / 4), `wire cell ${x}: first live at tick ceil(${x}/4), V1's step ${x}`);
  assert.equal(result.first[WIRE], WIRE / 4, `the far end in ${WIRE / 4} ticks: V1's ${WIRE} steps`);
  assert.ok(BigInt(result.gpuSource) > 0n && result.gpuSource === result.twinSource, 'Joule heat: the GPU ledger equals the twin exactly');
  // V1: the lit cell hands on after its FUSE_STEPS_PER_CELL-odd steps; one step was spent before tick 1
  assert.ok(result.twinLit > 0 && result.gpuLit === result.twinLit, `the fuse's second cell lights on tick ${result.twinLit} on both`);
  assert.ok(Math.abs((result.twinLit * 4 + 1) - PHYS.FUSE_STEPS_PER_CELL) <= 4, `its front took V1's ${PHYS.FUSE_STEPS_PER_CELL} steps`);
  assert.equal(result.sink, '0');
  assert.ok(result.flagsClear && result.scratchClear, 'the pass leaves its list bits and scratch clear');
  assert.ok(Math.max(...result.listed) < 512 / 4, 'the list stays near the circuits');
  console.log(`ok electric pass on the GPU: ${WIRE} cells in ${WIRE / 4} ticks, ${TICKS} ticks equal to the twin, Joule ${result.gpuSource}, fuse front on tick ${result.gpuLit}`);
} finally { await browser?.close(); await vite.close(); console.log(`slot ${Date.now() - t0} ms`); }
