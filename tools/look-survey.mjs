// Look survey: stills of fixed cameras on several maps at a Retina laptop's
// size, plus the GPU profiler's frame time at each map's default camera. For
// before/after looks at the renderer (the clay audit, docs/v2 audit-render 2.1).
// Each camera is the map's own start view moved toward its orbit target:
// `zoom` is the share of the distance cut (0 = the start view).
// usage: node tools/look-survey.mjs <outDir> [--port 5741 | --base https://tpt3d.codyh.xyz]
//          [--maps island,volcanoWorld,lab,descent] [--settle 12000] [--prof 0|1]
import { launchBrowser, newTestPage, gpuInfo, render } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { mkdirSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt('base', null);
const maps = opt('maps', 'island,volcanoWorld,lab,descent').split(',');
const SETTLE_MS = Number(opt('settle', '12000'));   // boot, world stream and GI settle at the start view
const MOVE_MS = Number(opt('move', '4000'));        // a moved camera's window stream and probes settle
const USE_RENDER = opt('render', '0') === '1';   // the converged test render (slow on a world at 2880×1800); else live frames
const PROF = opt('prof', '1') === '1';
// cameras per map: [name, zoom, orbit (rad about the target's vertical; 0 = none)]
const CAMS = {
  island: [['god', 0, 0], ['mid', 0.55, 0], ['close', 0.8, 0], ['closeSide', 0.8, 0.9]],
  volcanoWorld: [['god', 0, 0], ['flank', 0.6, 0], ['flankClose', 0.82, 0.6]],
  lab: [['god', 0, 0], ['close', 0.6, 0.5]],
  descent: [['god', 0, 0], ['close', 0.6, 0]],
};
mkdirSync(out, { recursive: true });
const vite = base ? null : await startVite({ port: Number(opt('port', '5741')) });
const url = base ?? vite.origin;
const b = await launchBrowser();
const report = {};
try {
  for (const m of maps) {
    const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    p.on('console', (msg) => { if (msg.type() === 'error') errs.push(msg.text().slice(0, 300)); });
    await p.goto(`${url}/?map=${m}`, { timeout: 180000 });
    await p.waitForFunction(() => window.__app?.sim && window.__app?.gpu, null, { polling: 200, timeout: 240000 });
    if (!report.gpu) report.gpu = await gpuInfo(p).catch((e) => String(e));
    await p.waitForTimeout(SETTLE_MS);
    await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas{visibility:visible !important}' });
    const home = await p.evaluate(() => {
      const a = window.__app;
      if (a.day) a.day.clock = a.day.clock;   // keep the scene's own time of day
      return { pos: a.camera.position.toArray(), tgt: a.controls.target.toArray() };
    });
    const r = { home, cams: {} };
    for (const [name, zoom, orbit] of CAMS[m] ?? [['god', 0, 0]]) {
      await p.evaluate(([home, zoom, orbit]) => {
        const a = window.__app, V = a.camera.position.constructor;
        const t = new V(...home.tgt), d = new V(...home.pos).sub(t);
        d.applyAxisAngle(new V(0, 1, 0), orbit).multiplyScalar(1 - zoom);
        a.camera.position.copy(t).add(d);
        a.controls.target.copy(t);
        a.controls.update();
        a.post?.reset?.();
        a.requestRender?.();
      }, [home, zoom, orbit]);
      await p.waitForTimeout(zoom ? MOVE_MS : 500);
      // an animated scene (waves) never settles: its settle-limit frames are converged enough
      const tr = Date.now();
      if (USE_RENDER) await render(p).catch((e) => { if (!/did not converge/.test(e.message)) throw e; });
      console.log(m, name, 'render ms', Date.now() - tr);
      const t0 = Date.now();
      await p.screenshot({ path: `${out}/${m}-${name}.png`, timeout: 180000 });
      console.log(m, name, 'shot ms', Date.now() - t0);
      if (USE_RENDER) await p.evaluate(() => window.__app.test.resume());
      r.cams[name] = await p.evaluate(() => window.__app.camera.position.distanceTo(window.__app.controls.target));
    }
    if (PROF) {
      // back to the start view, then the profiler's frame time there and at the closest camera
      Object.assign(r, await p.evaluate(async (home) => {
        const a = window.__app, V = a.camera.position.constructor;
        const sleep = (t) => new Promise((res) => setTimeout(res, t));
        a.camera.position.set(...home.pos); a.controls.target.set(...home.tgt); a.controls.update();
        await sleep(2000);
        a.settings.profiler = true;
        await sleep(4000);
        const s = a.prof.last && JSON.parse(JSON.stringify(a.prof.last));
        a.settings.profiler = false;
        return {
          renderScale: a.post.renderScale, upscale: a.settings.upscale, detail: a.settings.detail,
          gpuMs: s?.gpu, phases: s?.phases?.map((ph) => ({ id: ph.id, gpu: +(ph.gpu ?? 0).toFixed(2) })),
        };
      }, home));
    }
    r.errs = errs.slice(0, 5);
    report[m] = r;
    console.log(m, JSON.stringify({ gpuMs: r.gpuMs, cams: r.cams, errs: r.errs }));
    await p.close();
  }
} finally {
  await b.close();
  await vite?.close();
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
