// GPU: V1's shock under V2 on what only the GPU runs, through the integrated native engine on the outcome
// bench's bare simulation (tools/outcomes/engine-v2.js: src/v2/physics.js with its dynamics, no app):
// nitroglycerin poured gently rests, dropped from height goes off where its run lands
// (shaders/v2/columns.js colShockLand); C-4 hit by grains thrown down at it goes off
// (shaders/v2/particles.js dShockHit, posted by blasts.js airborneEvents). The rules' CPU checks:
// tools/v2/shock-check.mjs, particle-deposition-check.mjs. One launch, one GPU slot.
//
//   node tools/v2/shock-browser-check.mjs [--port N]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

let failures = 0;
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what} [${at()}]`); };
const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/outcomes.html?engine=v2', { errors, timeout: 20000 });
  console.log(`harness up [${at()}]`);
  await page.evaluate(async () => {
    const { createEngine } = await import('/tools/outcomes/engine-v2.js');
    const e = createEngine(window.__harness.gpu);
    window.__shock = { e, async count(name) { const g = await e.read(), id = e.id(name); let n = 0; for (let i = 0; i < g.id.length; i++) if (g.id[i] === id) n++; return n; } };
  });
  // nitroglycerin: a block resting a cell over the floor, then one dropped from 42 cells (12.6 m)
  const nitro = await page.evaluate(async () => {
    const { e, count } = window.__shock, out = {};
    await e.create([32, 48, 32]);
    e.box([22, 1, 22], [25, 3, 25], 'NITRO');
    await e.advance(0.05); out.gentle0 = await count('NITRO'); await e.advance(1); out.gentle1 = await count('NITRO');
    e.box([4, 42, 4], [7, 44, 7], 'NITRO');
    await e.advance(0.05); out.high0 = await count('NITRO'); await e.advance(2); out.high1 = await count('NITRO');
    return out;
  });
  ok(nitro.gentle0 > 10 && nitro.gentle1 === nitro.gentle0, `nitroglycerin poured gently rests: ${nitro.gentle0} → ${nitro.gentle1} cells`);
  ok(nitro.high0 > 10 && nitro.high1 < nitro.high0 / 2, `dropped from 12.6 m it goes off where it lands: ${nitro.high0} → ${nitro.high1} cells`);
  // C-4 on the floor; sand thrown down at it at 25 m/s (a body-coupled launch: engine-v2.js box { v })
  const c4 = await page.evaluate(async () => {
    const { e, count } = window.__shock, out = {};
    await e.create([24, 32, 24]);
    e.box([10, 0, 10], [13, 1, 13], 'C4');
    await e.advance(0.05); out.rest0 = await count('C4'); await e.advance(0.5); out.rest1 = await count('C4');
    e.box([10, 20, 10], [13, 22, 13], 'SAND', { v: [0, -25, 0] });
    await e.advance(0.75); out.hit = await count('C4');
    await e.dispose();
    return out;
  });
  ok(c4.rest0 > 10 && c4.rest1 === c4.rest0, `C-4 left alone stays: ${c4.rest0} → ${c4.rest1} cells`);
  ok(c4.hit < c4.rest1 / 2, `hit by grains thrown at 25 m/s it goes off: ${c4.rest1} → ${c4.hit} cells`);
  ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`${failures ? `${failures} FAILED` : 'all ok'} (${at()})`);
process.exit(failures ? 1 : 0);
