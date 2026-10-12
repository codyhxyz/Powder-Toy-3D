// The app-level POV checks' shared harness (U11; docs/webgpu.md I1, I3): a
// Vite of their own, the app in manual mode booted through ready() and
// __app.test.ready() (no fixed sleeps), and the body's frames run by the
// check, as app.js's tick runs them (the crosshair's pick, pov.update, the
// frame's steps, the GPU done with them), so a check holds however slow
// SwiftShader's frames are. Game time is the frames' dt, never the wall's.
//
//   const app = await openPovApp();                     // the empty box at 64³
//   try {
//     await app.enter();                               // drops in and stands
//     await app.page.evaluate(() => __pov.frames(30, () => __app.pov.player.onGround));
//     app.check('no page or GPU errors', !app.errors.length, app.errors.join(' | '));
//   } finally { await app.close(); }
//
// In the page, __pov.frames(n, done?, look?) runs up to n body frames (until
// done() is true, holding the look [yaw, pitch] if given) and resolves to the
// frames run; __pov.steps and __pov.dt are a frame's. Every 60th frame prints
// a progress line, so a run cut short says how far it got.
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

export const POV_STEPS = 4;     // sim steps a body frame (the app's default)
export const POV_DT = 1 / 30;   // s a body frame
// three's warnings for the meshes the mesh layer ports (U13), allowed until it lands
const ALLOW = [/NodeBuilder: Material "(Raw)?ShaderMaterial" is not compatible/];
// what the page may log that isn't ours: the relay the UI asks for quota (not running here)
const IGNORE = [/Failed to load resource: net::ERR_CONNECTION_REFUSED/, /favicon/];

/**
 * Boots the app at `query` in manual mode and installs __pov.
 * @param {{ query?: string, viewport?: { width: number, height: number }, steps?: number, dt?: number }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, errors: string[], allowed: string[], boot: number,
 *   enter: (at?: number[]) => Promise<{ mode: string, onGround: boolean, pos: number[], frames: number, s: number }>,
 *   check: (name: string, ok: boolean, info?: string) => boolean, failures: () => number,
 *   secs: () => string, close: () => Promise<void> }>}
 */
export async function openPovApp({ query = '?size=64&preset=empty&view=plain', viewport = { width: 480, height: 300 }, steps = POV_STEPS, dt = POV_DT } = {}) {
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const vite = await startVite();
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await newTestPage(browser, { mode: 'manual', viewport });
    const errors = [], allowed = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.stack || e).slice(0, 400)}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'log' && t.startsWith('· ')) { console.log(`  ${t}`); return; }   // (the frames' progress, below)
      if (ALLOW.some((r) => r.test(t))) { allowed.push(t); return; }
      if (IGNORE.some((r) => r.test(t))) return;
      // (Chrome reports a WebGPU error as a warning)
      if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|GPU (validation|internal|out-of-memory)|shader failed/i.test(t))) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
    });
    // a fresh inventory (the palette's gifts are remembered across sessions)
    await page.addInitScript(() => { try { localStorage.removeItem('tpt3d.pov.given'); } catch { /* storage unavailable */ } });
    await page.goto(vite.url(`/${query}`));
    await ready(page);
    const failed = await page.evaluate(() => document.getElementById('error')?.textContent || null);
    if (failed) throw new Error(`the app didn't boot: ${failed.slice(0, 300)}`);
    await page.evaluate(() => { __app.post.settings.taa = false; return __app.test.ready(); });
    const boot = (Date.now() - t0) / 1000;
    // (headless has no pointer lock, so the hotbar's tool stack, which opens over the crosshair on a switch, would take the clicks meant for the tool)
    await page.addStyleTag({ content: '.hb-stack { pointer-events: none !important; }' });
    await page.evaluate(({ steps, dt }) => {
      // (a manual page starts paused; the frames below step the sim themselves, and the tools pace by its steps)
      __app.settings.paused = false;
      const ro = new __app.THREE.Vector3(), rd = new __app.THREE.Vector3(), hv = __app.hover;
      const t0 = performance.now(), PROGRESS_EVERY = 60;
      window.__pov = {
        steps, dt, count: 0,
        async frames(n, done = () => false, look = null) {
          for (let i = 0; i < n; i++) {
            if (look) __app.pov.setLook(...look);
            if (__app.pov.active && __app.pov.aimRay(ro, rd)) {
              const hit = await __app.vol.pick(ro, rd);
              hv.valid = hit.valid;
              if (hit.valid) { hv.cell.fromArray(hit.cell); hv.face = hit.face; hv.id = hit.id; hv.T = hit.T; hv.P = hit.P; }
            }
            if (__app.pov.active) __app.pov.update(dt);
            __app.test.step(steps);
            await __app.gpu.fence();
            await new Promise((r) => setTimeout(r, 0));   // (the frame's probes land)
            if (++window.__pov.count % PROGRESS_EVERY === 0) console.log(`· ${window.__pov.count} frames (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
            if (done()) return i + 1;
          }
          return n;
        },
      };
    }, { steps, dt });
    let failures = 0;
    const check = (name, ok, info = '') => {
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`);
      return ok;
    };
    return {
      page, errors, allowed, boot, check, secs,
      failures: () => failures,
      // Drops the body in (at `at`, feet in grid cells, else where it looks) and runs frames until it stands.
      async enter(at = null) {
        const t = Date.now();
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        await page.evaluate(async (at) => {
          await __app.pov.enter({ swoop: 0, hint: false, ...(at ? { at: new __app.THREE.Vector3(...at) } : {}) });
          __app.pov.test.assumeLocked = true;   // (headless has no pointer lock)
        }, at);
        const frames = await page.evaluate(() => __pov.frames(60, () => __app.pov.mode === 'on' && __app.pov.player?.onGround));
        const s = await page.evaluate(() => ({ mode: __app.pov.mode, onGround: !!__app.pov.player?.onGround, pos: __app.pov.player?.pos.toArray() ?? [] }));
        return { ...s, frames, s: (Date.now() - t) / 1000 };
      },
      async close() {
        await browser?.close();
        await vite.close();
      },
    };
  } catch (e) {
    await browser?.close();
    await vite.close();
    throw e;
  }
}
