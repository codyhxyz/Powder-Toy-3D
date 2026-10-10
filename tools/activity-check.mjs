// Activity-map check (docs/scaling.md D8): the brick pass builds the inert map
// from the activity flags the state writers leave (shaders/activity.js
// inertFrag); this runs the reference pass that computes it from the state
// alone (inertRefFrag) beside it at every map build, and the quiet map from
// each, and counts the bricks where they differ. They must never differ.
//
// Each scene loads from a seeded Math.random, then steps; between stretches of
// steps it runs the state writers (every brush tool, an undo, a codec
// pack/unpack, a full-grid copy), so their flags are checked too.
// usage: node tools/activity-check.mjs [--port 5191] [--scenes lab,volcano,island] [--size 128]
//          [--steps 600] [--noskip]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const scenes = opt('scenes', 'lab,volcano,island').split(',');
const size = opt('size', '128');
const STEPS = +opt('steps', '600');          // steps per scene, in stretches between the writers
const STRETCHES = 6;                         // stretches of steps per scene
const SEED = 12345;                          // Math.random seed (mulberry32, as tools/regress.mjs)

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
await ctx.addInitScript((seed) => {
  let s = seed;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__reseed = () => { s = seed; };
  // hold the app's frame loop: only this script steps the sim
  window.requestAnimationFrame = () => 0;
}, SEED);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
// errors, and WebGL's own complaints (GL errors arrive as warnings)
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:/.test(t)) errors.push(t.slice(0, 300));
});
await page.goto(`http://localhost:${port}/?size=${size}&preset=empty`);
await page.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });

const results = [];
for (const scene of scenes) {
  const r = await page.evaluate(async ({ scene, steps, stretches, noskip }) => {
    const a = window.__app, sim = a.sim, R = a.renderer;
    a.settings.paused = true;
    const { inertRefFrag } = await import('/src/shaders/activity.js');
    const { rawMat, makeFieldTarget } = await import('/src/sim.js');
    const { createPacker, createUnpacker } = await import('/src/net/codec.js');
    const { E } = await import('/src/elements.js');
    const g = sim.g, w = g.bwidth, h = g.bheight;
    const tex = sim.actInert.texture;
    const refInert = makeFieldTarget(w, h, 1, tex.type, tex.minFilter);
    const refQuiet = makeFieldTarget(w, h, 1, tex.type, tex.minFilter);
    const ref = rawMat(inertRefFrag(g), { tA: { value: null }, tB: { value: null }, tRx: { value: sim.reactionTable } });
    const px = () => new Uint8Array(w * h * 4);
    const bufs = { inert: px(), quiet: px(), refInert: px(), refQuiet: px() };
    const read = (t, buf) => R.readRenderTargetPixels(t, 0, 0, w, h, buf);
    const bricks = (g.nx / 4) * (g.ny / 4) * (g.nz / 4);
    const stat = { builds: 0, inertDiff: 0, quietDiff: 0, permissive: 0, strict: 0, inertShare: 0, quietShare: 0, firstDiff: null };
    // after every map build, the reference maps from the same state
    const build = sim.updateActivity.bind(sim);
    sim.updateActivity = () => {
      build();
      ref.uniforms.tA.value = sim.stateA;
      ref.uniforms.tB.value = sim.stateB;
      sim.run(ref, refInert);
      const q = sim.mats.quiet, keep = q.uniforms.tInert.value;
      q.uniforms.tInert.value = refInert.texture;
      sim.run(q, refQuiet);
      q.uniforms.tInert.value = keep;
      read(sim.actInert, bufs.inert); read(sim.actQuiet, bufs.quiet);
      read(refInert, bufs.refInert); read(refQuiet, bufs.refQuiet);
      let di = 0, dq = 0, ni = 0, nq = 0;
      for (let i = 0; i < bufs.inert.length; i += 4) {
        const a1 = bufs.inert[i] > 127, b1 = bufs.refInert[i] > 127, a2 = bufs.quiet[i] > 127, b2 = bufs.refQuiet[i] > 127;
        if (a1 !== b1) { di++; if (a1) stat.permissive++; else stat.strict++; }
        if (a2 !== b2) dq++;
        ni += b1; nq += b2;
      }
      stat.builds++;
      stat.inertDiff += di; stat.quietDiff += dq;
      stat.inertShare += ni / bricks; stat.quietShare += nq / bricks;
      if ((di || dq) && !stat.firstDiff) stat.firstDiff = { frame: sim.frame, inert: di, quiet: dq };
    };
    // the state writers, between stretches of steps
    const c = [g.nx / 2, g.ny * 0.6, g.nz / 2];
    const tools = { erase: -1, heat: -2, cool: -3, blast: -4 };   // elements.js tool ids
    const V3 = sim.mats.paint.uniforms.uCenter.value.constructor;
    const stroke = (tool, at, radius = 5, replace = false) => sim.paint({ center: new V3(...at), radius, shape: 0, tool, rate: 1, replace });
    const writers = [
      () => { stroke(E.SAND, [c[0], c[1], c[2]]); stroke(E.WATER, [c[0] + 12, c[1], c[2]]); },
      () => { stroke(tools.heat, [c[0], 6, c[2]], 8); stroke(tools.cool, [c[0] - 14, 6, c[2] + 6], 6); },
      () => { stroke(tools.erase, [c[0], 4, c[2]], 6); stroke(tools.blast, [c[0] + 8, 8, c[2] - 8], 6); },
      () => { sim.snapshot(); stroke(E.STONE, [c[0], c[1] + 6, c[2]], 4, true); sim.undo(); },
      async () => {
        const packer = createPacker(R), unpacker = createUnpacker();
        const shot = await packer.pack(sim);
        unpacker.unpack(sim, shot.bytes); shot.release();
      },
      () => { const [A, B] = sim.readState(); sim.load(A, B); },
    ];
    sim.skipQuiet = !noskip;
    window.__reseed();
    a.loadPreset(scene, false);
    sim.frame = 0;
    const per = Math.round(steps / stretches);
    for (let k = 0; k < stretches; k++) {
      for (let i = 0; i < per; i++) sim.step();
      if (k < stretches - 1) await writers[k % writers.length]();
    }
    sim.updateActivity = build;
    refInert.dispose(); refQuiet.dispose(); ref.dispose();
    stat.inertShare /= stat.builds; stat.quietShare /= stat.builds;
    return stat;
  }, { scene, steps: STEPS, stretches: STRETCHES, noskip: args.includes('--noskip') });
  results.push({ scene, ...r });
  console.log(`${scene} ${size}: ${r.builds} maps, inert share ${(r.inertShare * 100).toFixed(1)}%, quiet ${(r.quietShare * 100).toFixed(1)}%;`
    + ` bricks differing: inert ${r.inertDiff} (${r.permissive} flag-inert only, ${r.strict} reference-inert only), quiet ${r.quietDiff}`
    + (r.firstDiff ? `; first at frame ${r.firstDiff.frame}` : ''));
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(results.some((r) => r.inertDiff || r.quietDiff) || errors.length ? 1 : 0);
