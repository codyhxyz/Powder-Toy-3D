// The small compute subsystems in the real app (docs/webgpu.md G4, U12), one
// parked page (manual mode), every result read back (W6):
//   codec      the world stream's pack and unpack (net/codec.js): pack, unpack
//              into the sim, pack again: the same bytes, and the cells' ids
//              and ctypes as they were
//   lightning  a bolt from the sky onto a metal bar (src/lightning.js strike):
//              plasma along the channel, the bar heated and sparked where it lands
//   console    typed commands through the console's input (src/console): a
//              write, reads of it (a command waits for the GPU as a
//              coroutine), a write and read in one command, sim.step then a read
//   deco       the Decorate tool on matter (src/deco.js): the painted cells hold
//              the tool's colour, air none
//   saves      ⌘S's save and a load of it: every cell and the decoration back
//              bit for bit (src/saves)
// usage: node tools/subsystems-gpu-check.mjs [--port 5419] [--size 64]
//   (it starts its own Vite on that port: tools/vite-server.mjs)
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const size = Number(opt('size', '64'));

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };

const vite = await startVite();
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GPUValidationError|WGSL/.test(t)) errors.push(t.slice(0, 400));
  });
  await page.routeWebSocket(/.*/, () => {});   // no multiplayer relay
  const t0 = Date.now();
  await page.goto(vite.url(`/?size=${size}&preset=empty`));
  // (a cold boot on a software adapter builds every pipeline first: give it longer than browser.mjs ready's 2 minutes)
  await page.waitForFunction(() => window.__app?.sim, null, { polling: 250, timeout: 300000 });
  await page.evaluate(async () => { const a = window.__app; a.test.park(); await a.test.ready(); });
  console.log(`app ready in ${((Date.now() - t0) / 1000).toFixed(0)} s (${size}³)`);

  // ---- a scene: a sand pile, a water pool, a metal bar, stone ----
  await page.evaluate(async () => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { SEED_MAX } = await import('/src/shaders/common.js');
    const [A, B] = sim.blankState();
    const set = (x, y, z, id) => {
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; A[i + 3] = Math.random() * SEED_MAX;
    };
    const c = g.nx / 2;
    for (let y = 0; y < 3; y++) for (let z = 4; z < g.nz - 4; z++) for (let x = 4; x < g.nx - 4; x++) set(x, y, z, E.STONE);
    for (let y = 3; y < 8; y++) for (let z = 6; z < 20; z++) for (let x = 6; x < 20; x++) set(x, y, z, E.WATER);
    for (let y = 3; y < 10; y++) for (let z = c - 4; z < c + 4; z++) for (let x = c - 4; x < c + 4; x++) set(x, y + (x + z) % 3, z, E.SAND);
    for (let x = 30; x < g.nx - 6; x++) set(x, 3, c + 12, E.METAL);
    sim.load(A, B);
    a.test.step(6);
  });

  // ---- codec ----
  const codec = await page.evaluate(async () => {
    const sim = window.__app.sim;
    const { createPacker, createUnpacker } = await import('/src/net/codec.js');
    const packer = createPacker(), unpacker = createUnpacker();
    const [A0] = await sim.readState();
    const shot = await packer.pack(sim);
    const bytes = shot.bytes.slice();
    shot.release();
    await unpacker.unpack(sim, bytes);
    const again = await packer.pack(sim);
    let diff = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== again.bytes[i]) diff++;
    again.release();
    // the cells after the unpack: ids as packed, ctype (A.w's integer part) as sent
    const [A1] = await sim.readState();
    let ids = 0, cells = 0;
    const g = sim.g;
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
      const i = sim.cellTexel(x, y, z) * 4;
      cells++;
      if (Math.round(A0[i]) !== Math.round(A1[i])) ids++;
    }
    let nonzero = 0;
    for (const v of bytes) if (v) nonzero++;
    return { bytes: bytes.length, nonzero, diff, ids, cells };
  });
  ok(codec.nonzero > 0 && codec.diff === 0, `codec: pack → unpack → pack gives the same ${codec.bytes} bytes (${codec.diff} differ, ${codec.nonzero} nonzero)`);
  ok(codec.ids === 0, `codec: every cell's element survives the round trip (${codec.ids} of ${codec.cells} differ)`);

  // ---- lightning ----
  const bolt = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E } = await import('/src/elements.js');
    const { isLive } = await import('/src/electricity.js');
    const c = g.nx / 2, x = 40, z = c + 12;
    const before = await sim.readCell(x, 3, z);
    const segs = a.lightning.strike(sim, [x + 0.5, g.ny - 2, z + 0.5], [x + 0.5, 4, z + 0.5], { strikeR: 3 });
    await a.lightning.ready;
    await sim.gpuSync();
    const [A] = await sim.readState();
    let plasma = 0;
    for (let y = 5; y < g.ny - 2; y++) for (let zz = z - 4; zz <= z + 4; zz++) for (let xx = x - 6; xx <= x + 6; xx++) {
      if (Math.round(A[sim.cellTexel(xx, y, zz) * 4]) === E.PLASMA) plasma++;
    }
    const [hit] = await sim.readCell(x, 3, z);
    let live = 0;
    for (let xx = x - 2; xx <= x + 2; xx++) { const [m] = await sim.readCell(xx, 3, z); if (isLive(Math.round(m[0]), m[3])) live++; }
    return { segs: segs.length, plasma, T0: before[0][1], T1: hit[1], id: Math.round(hit[0]), metal: E.METAL, live };
  });
  ok(bolt.segs > 0 && bolt.plasma > 0, `lightning: ${bolt.segs} segments, ${bolt.plasma} cells of plasma along the channel`);
  ok(bolt.id === bolt.metal && bolt.T1 > bolt.T0 + 100, `lightning: the bar heated where it lands (${bolt.T0.toFixed(0)} → ${bolt.T1.toFixed(0)} °C)`);
  ok(bolt.live > 0, `lightning: the bar sparked where it lands (${bolt.live} live cells)`);

  // ---- console ----
  await page.evaluate(() => window.__app.scripts.setOpen(true));
  await page.waitForFunction(() => /Lua 5\.3/.test(document.querySelector('.console-log')?.textContent ?? ''), null, { timeout: 60000 });
  const run = async (code) => {
    const before = await page.evaluate(() => document.querySelectorAll('.console-row').length);
    await page.fill('.console-input', code);
    await page.press('.console-input', 'Enter');
    // the command's echo, then its result or error (a read waits for the GPU: a few frames)
    await page.waitForFunction((n) => {
      const rows = [...document.querySelectorAll('.console-row')].slice(n);
      return rows.length >= 2 && !document.querySelector('.console-input').disabled;
    }, before, { timeout: 60000 });
    return page.evaluate((n) => [...document.querySelectorAll('.console-row')].slice(n + 1).map((r) => `${r.className.includes('row-error') ? 'ERROR ' : ''}${r.textContent}`).join(' | '), before);
  };
  const ids = await page.evaluate(async () => { const { E } = await import('/src/elements.js'); const g = window.__app.sim.g; return { WATER: E.WATER, nx: g.nx, ny: g.ny }; });
  const key = (x, y, z) => (z * ids.ny + y) * ids.nx + x;
  const r1 = await run('sim.partCreate(-1, 30, 40, 30, "WATR")');
  ok(r1 === String(key(30, 40, 30)), `console: partCreate returns the new particle's index (${r1})`);
  const r2 = await run('sim.partID(30, 40, 30), sim.partProperty(sim.partID(30, 40, 30), "type")');
  ok(r2 === `${key(30, 40, 30)}, ${ids.WATER}`, `console: a later command reads it back from the GPU (${r2})`);
  const r3 = await run('sim.cellProperty(31, 40, 30, "temp", 500); return sim.cellProperty(31, 40, 30, "temp"), sim.partID(32, 41, 30)');
  ok(r3 === '500, nil', `console: a write and a read in one command (${r3})`);
  const gpuCell = await page.evaluate(async () => { const [a] = await window.__app.sim.readCell(31, 40, 30); return a[1]; });
  ok(gpuCell === 500, `console: the edit is in the GPU state (${gpuCell} °C)`);
  const r4 = await run('sim.step(30); return sim.partID(30, 40, 30), sim.elementCount("WATR") > 0');
  ok(r4 === 'nil, true', `console: sim.step, then reads in the same command see the steps (${r4})`);
  await page.evaluate(() => window.__app.scripts.setOpen(false));

  // ---- deco ----
  const deco = await page.evaluate(async () => {
    const a = window.__app, sim = a.sim, g = sim.g;
    const { E, DECO_TOOLS } = await import('/src/elements.js');
    const { readDeco, decoView, setDecoColor } = await import('/src/deco.js');
    const c = g.nx / 2;
    setDecoColor([200, 40, 30, 255]);
    const tool = DECO_TOOLS.find((t) => t.key === 'DECO_SET').id;
    sim.paint({ center: { x: 12.5, y: 1.5, z: 30.5 }, radius: 4, shape: 1, tool, rate: 1, replace: false });   // the stone floor
    await sim.deco.ready;
    for (let k = 0; k < 100 && !sim.deco.active; k++) await new Promise((r) => setTimeout(r, 20));   // (its queued stroke runs once built)
    const data = await readDeco(sim);
    const at = (x, y, z) => Array.from(data.subarray(sim.cellTexel(x, y, z) * 4, sim.cellTexel(x, y, z) * 4 + 4));
    return { stone: at(12, 1, 30), air: at(12, 10, 30), want: [...decoView.color] };
  });
  ok(deco.stone.join() === deco.want.join(), `deco: the Decorate tool colours the stone it covers (${deco.stone} = ${deco.want})`);
  ok(deco.air.every((v) => v === 0), `deco: air takes none (${deco.air})`);

  // ---- saves ----
  const saves = await page.evaluate(async () => {
    const a = window.__app, sim0 = a.sim;
    const { readDeco } = await import('/src/deco.js');
    const bits = async (sim) => {
      const [A, B] = await sim.readState();
      return [new Uint32Array(A.buffer, A.byteOffset, A.length), new Uint32Array(B.buffer, B.byteOffset, B.length)];
    };
    const same = (p, q) => p.length === q.length && p.every((v, i) => v === q[i]);
    const [A0, B0] = await bits(sim0);
    const d0 = await readDeco(sim0);
    const meta = await a.saveGame('subsystems-gpu-check');
    if (!meta) return { error: 'saveGame returned null' };
    a.loadPreset('empty');
    a.test.step(2);
    const loaded = await a.openSave(meta.id);
    const sim = a.sim;
    const [A1, B1] = await bits(sim);
    const d1 = await readDeco(sim);
    return { loaded, bytes: meta.bytes, A: same(A0, A1), B: same(B0, B1), deco: !!d0 && !!d1 && same(d0, d1) };
  });
  ok(saves.loaded && saves.A && saves.B, `saves: every cell back bit for bit (${saves.error ?? `${(saves.bytes / 1024).toFixed(0)} KB`})`);
  ok(saves.deco, 'saves: the decoration back bit for bit');

  const fails = await page.evaluate(() => window.__app.gpu.failure?.message ?? null);
  ok(!fails && !errors.length, `no GPU failure or page errors (${[fails, ...errors].filter(Boolean).join('; ') || 'none'})`);
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `subsystems-gpu-check: ${failures} failure(s)` : 'subsystems-gpu-check: clean');
process.exit(failures ? 1 : 0);
