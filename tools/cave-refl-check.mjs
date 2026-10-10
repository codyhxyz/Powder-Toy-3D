// Water reflections underground: a rock-roofed cave with a pool (should
// mirror the cave, not the sky) and an open pool on top (should still mirror
// the sky). Shoots both on each URL given, for a before/after.
// usage: node tools/cave-refl-check.mjs <outDir> <label=url> [<label=url> ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const [out, ...targets] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ROCK = 20, WATER = 7, LAVA = 10;
const views = {
  cave: [[64, 34, 104], [64, 10, 50]],
  caveGraze: [[64, 22, 106], [64, 14, 30]],
  open: [[64, 92, 140], [64, 64, 60]],
};
for (const t of targets) {
  const [label, url] = t.split('=');
  const p = await b.newPage({ viewport: { width: 960, height: 600 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await p.goto(`${url}/?preset=lab`);
  await p.waitForTimeout(4000);
  await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
  await p.evaluate(([ROCK, WATER, LAVA]) => {
    const a = window.__app, s = a.sim, { nx, ny, nz } = s.g;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.day.clock = 0;
    const [A, B] = s.blankState();
    const set = (x, y, z, id) => { const i = s.cellTexel(x, y, z) * 4; A[i] = id; if (id === LAVA) A[i + 1] = 1300; };
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) for (let y = 0; y < 70; y++) {
      const inCave = x >= 20 && x < 108 && z >= 20 && z < 108 && y >= 10 && y < 40;
      const inPool = x >= 30 && x < 98 && z >= 30 && z < 98 && y >= 62;
      // a mouth in the near wall, and a lava lamp on a rock pedestal in a far corner
      const inMouth = x >= 44 && x < 84 && z >= 108 && y >= 22 && y < 40;
      const pedestal = x >= 22 && x < 32 && z >= 22 && z < 32;
      if (inMouth) continue;
      if (inCave && pedestal) { if (y < 18) set(x, y, z, ROCK); else if (y < 22) set(x, y, z, LAVA); continue; }
      if (inCave) { if (y < 18) set(x, y, z, WATER); continue; }
      if (inPool) { if (y < 67) set(x, y, z, WATER); continue; }
      set(x, y, z, ROCK);
    }
    s.load(A, B);
  }, [ROCK, WATER, LAVA]);
  // let the fields, bricks and GI probes catch up
  await p.waitForTimeout(4000);
  for (const [name, [pos, tgt]] of Object.entries(views)) {
    await p.evaluate(([pos, tgt]) => {
      const a = window.__app, V = a.camera.position.constructor;
      a.camera.position.copy(a.volume.localToWorld(new V(...pos)));
      a.controls.target.copy(a.volume.localToWorld(new V(...tgt)));
      a.controls.update();
      a.post.reset();
      a.requestRender?.();
    }, [pos, tgt]);
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${out}/${label}-${name}.png` });
  }
  console.log(label, errs.length ? errs : 'no errors');
  await p.close();
}
await b.close();
