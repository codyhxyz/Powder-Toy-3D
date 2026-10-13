// Digging tools, looked at in first person (dig.js: the shovel and the pickaxe):
// the outline on the aimed lattice block, a held dig into a sand heap (square
// holes, the load heaped on the blade), the shovel cracking rock, and one
// pickaxe blow taking a block of it. Writes stills to <outDir> and prints the
// pack and the last blows.
// usage: node tools/dig-look.mjs <outDir> [--port 5519]   (runs its own Vite on --port)
import { mkdirSync } from 'fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const out = args[0] ?? 'dig-look';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', '5519'));
mkdirSync(out, { recursive: true });
const W = 960, H = 600;
const HOLD_MS = 1200;        // a held dig into the sand: about eight digs at the shovel's 0.15 s
const LOOK_HEAP = -0.2;      // rad: at the heap's flank
const LOOK_ROCK = -0.1;      // rad: at the boulder's face, from a step back

const vite = await startVite({ port });
const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'visual', viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  await p.goto(vite.url('/?preset=empty'));
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const settle = (ms) => p.waitForTimeout(ms);
  const shot = (name) => p.screenshot({ path: `${out}/${name}.png` });
  const paint = (tool, c, r) => ev(async ([tool, c, r]) => {
    const { E } = await import('/src/elements.js');
    const a = window.__app;
    a.sim.paint({ center: new a.camera.position.constructor(...c), radius: r, shape: 1, tool: E[tool], rate: 1, replace: true });
  }, [tool, c, r]);
  const stand = (x, z, yaw, pitch) => ev(([x, z, yaw, pitch]) => {
    const a = window.__app;
    a.pov.player.spawn(a.pov.player.pos.clone().set(x, 0, z));
    a.pov.setLook(yaw, pitch);
  }, [x, z, yaw, pitch]);
  // the button on the game canvas, as a locked pointer delivers it whatever HUD is over the middle
  const down = () => ev(() => (window.__app.canvas ?? window.__app.renderer.domElement).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })));
  const up = () => ev(() => dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
  // pick a tool, and close the weapon selector (HL2's: the first click confirms it, not a dig)
  const select = async (k) => {
    await ev((k) => window.__app.pov.toolbelt.select(k), k);
    await settle(200);
    await down(); await settle(60); await up();
    await settle(400);
  };
  const state = (k) => ev((k) => {
    const t = window.__app.pov.toolbelt.tool(k);
    const blow = t?.lastBlow ?? null;
    return { pack: window.__app.pov.toolbelt.tool('SHOVEL').load.status(), blow: blow && { min: blow.min.toArray(), id: blow.id, need: blow.need, hits: blow.hits } };
  }, k);

  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});
  await ev(() => { window.__app.pov.test.assumeLocked = true; });

  // every dig's cells, and every blow (a dig that took nothing hit an empty block: the aim was stale)
  await ev(async () => {
    const { povEvents } = await import('/src/pov/events.js');
    window.__digs = [];
    povEvents.on('tool:action', (e) => { if (e.action === 'dig') window.__digs.push(e.amount); });
    // every take the tools ask for: issued or not, and how many were in flight
    const tr = window.__app.pov.toolbelt.transfer, take = tr.take.bind(tr);
    window.__takes = [];
    tr.take = (...a) => { const r = take(...a); window.__takes.push({ t: Math.round(performance.now()), issued: !!r, pending: tr.pending }); return r; };
  });
  const digs = () => ev(() => window.__digs.splice(0));
  // a sand heap ahead (+x), a rock boulder beside it
  await paint('SAND', [42, 3, 64], 7);
  await paint('ROCK', [42, 3, 90], 6);
  await settle(1500);

  // ---- shovel: the outline, then a held dig
  await stand(31, 64, -Math.PI / 2, LOOK_HEAP);
  await select('SHOVEL');
  await settle(1200);
  await shot('1-shovel-outline');
  await down();
  await settle(HOLD_MS / 2);
  await shot('2-shovel-digging');
  await settle(HOLD_MS / 2);
  await up();
  await settle(1000);
  console.log('shovel, sand:', JSON.stringify(await state('SHOVEL')), 'digs', JSON.stringify(await digs()), 'takes', JSON.stringify(await ev(() => window.__takes.splice(0))));
  await shot('3-shovel-dug');
  // ---- the shovel on rock: two digs crack it (it takes five)
  await stand(27, 90, -Math.PI / 2, LOOK_ROCK);
  await settle(800);
  for (let i = 0; i < 2; i++) { await down(); await settle(60); await up(); await settle(200); }
  console.log('shovel, rock:', JSON.stringify(await state('SHOVEL')));
  await shot('4-shovel-crack');
  // ---- pickaxe: one blow takes the block
  await select('PICKAXE');
  await settle(800);
  await down(); await settle(60); await up();
  await settle(1000);
  console.log('pickaxe, rock:', JSON.stringify(await state('PICKAXE')));
  await shot('5-pickaxe-dug');
  console.log(errs.length ? errs.join('\n') : 'no console errors');
} finally {
  await b.close();
  await vite.close();
}
