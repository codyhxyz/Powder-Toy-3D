// Per-cell state hash over a fixed scenario, for proving a refactor bit-exact:
// run it against two builds and compare the printed lines (they must match).
//
// Each scene loads from a seeded Math.random, then steps, with the state
// writers in between (every brush tool, an undo, a codec pack/unpack, a
// readState/load round trip). After each stage it prints a hash of every
// cell's state in the D5 float layout (sim.readState(): A = id, °C, life,
// ctype + seed; B = velocity, pressure), taken in cell order through
// sim.cellTexel, so builds with different texel layouts compare too. Where
// the build has one, the renderer's flow field (sim.flowV) gets a hash too.
// usage: node tools/state-hash.mjs [--port 5191] [--scenes lab,volcano,island] [--sizes 128]
//          [--steps 200] [--noskip]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const scenes = opt('scenes', 'lab,volcano,island').split(',');
const sizes = opt('sizes', '128').split(',');
const STEPS = +opt('steps', '200');   // steps per stretch
const SEED = 12345;                   // Math.random seed (mulberry32, as tools/regress.mjs)

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
for (const size of sizes) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
  await ctx.addInitScript((seed) => {
    let s = seed;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__reseed = () => { s = seed; };
    window.requestAnimationFrame = () => 0;   // hold the app's frame loop: only this script steps the sim
  }, SEED);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  // errors, and WebGL's own complaints (GL errors arrive as warnings)
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:/.test(t)) errors.push(t.slice(0, 300));
  });
  await page.goto(`http://localhost:${port}/?size=${size}&preset=empty`);
  await page.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
  for (const scene of scenes) {
    const lines = await page.evaluate(async ({ scene, steps, noskip }) => {
      const a = window.__app, sim = a.sim, R = a.renderer, g = sim.g;
      a.settings.paused = true;
      const { createPacker, createUnpacker } = await import('/src/net/codec.js');
      const { E } = await import('/src/elements.js');
      const out = [];
      // FNV-1a over the 32-bit words of every cell's A and B, in cell order
      const hash = (label) => {
        const [A, B] = sim.readState();
        const ua = new Uint32Array(A.buffer), ub = new Uint32Array(B.buffer);
        let h = 0x811c9dc5;
        const mix = (w) => { for (let k = 0; k < 4; k++) { h ^= (w >>> (8 * k)) & 0xff; h = Math.imul(h, 0x01000193); } };
        for (let y = 0; y < g.ny; y++)
          for (let z = 0; z < g.nz; z++)
            for (let x = 0; x < g.nx; x++) {
              const i = sim.cellTexel(x, y, z) * 4;
              for (let k = 0; k < 4; k++) mix(ua[i + k]);
              for (let k = 0; k < 4; k++) mix(ub[i + k]);
            }
        // the renderer's flow field (sim.flowV: half floats, state atlas), where the build has one
        let flow = '';
        if (sim.flowV) {
          const t = sim.flowV, f = new Uint16Array(t.width * t.height * 4);
          R.readRenderTargetPixels(t, 0, 0, t.width, t.height, f);
          let hf = 0x811c9dc5;
          for (let y = 0; y < g.ny; y++)
            for (let z = 0; z < g.nz; z++)
              for (let x = 0; x < g.nx; x++) {
                const i = sim.cellTexel(x, y, z) * 4;
                for (let k = 0; k < 4; k++) { hf ^= f[i + k]; hf = Math.imul(hf, 0x01000193); }
              }
          flow = `  flow ${(hf >>> 0).toString(16).padStart(8, '0')}`;
        }
        out.push(`${label.padEnd(10)} ${(h >>> 0).toString(16).padStart(8, '0')}${flow}  frame ${sim.frame}`);
      };
      const V3 = sim.mats.paint.uniforms.uCenter.value.constructor;
      const c = [g.nx / 2, g.ny * 0.6, g.nz / 2];
      const stroke = (tool, at, radius = 5, replace = false) => sim.paint({ center: new V3(...at), radius, shape: 0, tool, rate: 1, replace });
      const run = (n) => { for (let i = 0; i < n; i++) sim.step(); };
      sim.skipQuiet = !noskip;
      window.__reseed();
      a.loadPreset(scene, false);
      sim.frame = 0;
      hash('load');
      run(steps); hash('steps');
      stroke(E.SAND, c); stroke(E.WATER, [c[0] + 12, c[1], c[2]]); stroke(E.LAVA, [c[0] - 12, c[1], c[2]], 3);
      stroke(E.ERASE, [c[0], 4, c[2]], 6); stroke(E.HEAT, [c[0], 6, c[2]], 8); stroke(E.COOL, [c[0] - 14, 6, c[2] + 6], 6);
      stroke(E.BLAST, [c[0] + 8, 8, c[2] - 8], 6);
      hash('brush');
      run(steps); hash('steps');
      sim.snapshot(); stroke(E.STONE, [c[0], c[1] + 6, c[2]], 4, true); hash('replace'); sim.undo(); hash('undo');
      run(steps / 2); hash('steps');
      const shot = await createPacker(R).pack(sim);
      createUnpacker().unpack(sim, shot.bytes); shot.release();
      hash('codec');
      run(steps / 2); hash('steps');
      const [A, B] = sim.readState(); sim.load(A, B); hash('reload');
      run(steps / 2); hash('steps');
      return out;
    }, { scene, steps: STEPS, noskip: args.includes('--noskip') });
    console.log(`# ${scene} ${size}${args.includes('--noskip') ? ' noskip' : ''}`);
    for (const l of lines) console.log(l);
  }
  await ctx.close();
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
