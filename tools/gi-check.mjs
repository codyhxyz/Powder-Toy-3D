// The GI probes (docs/webgpu.md E, J1 U9: shaders/gi.js, src/derived.js
// updateGI), in the harness (tools/harness/gi-check.*: a Simulation, its
// derived passes and their GI on their own device, no app). Stages, each a
// few seconds to a minute on SwiftShader at 32³, in one browser:
//   reference  the gather alone over a made-up giSrc, an empty box under the
//              sky, a sunlit cube and its bounce, and giSource's coverage and
//              light on small pieces of everything, against JS twins of the
//              march, the SH projection and the source (the probes' energy and
//              the light's direction checked on their own too)
//   parity     the checkerboard, the blend into the history, convergence,
//              history == textures, resetGI and the reset frame after it
//   lit        a lit room with the shadow map, sky, hot metal and an
//              overhang: convergence with bounces, sky visibility, colour
//   far        FrameUniforms.far on with a stand-in far field
//   lazy       no GI pipeline until asked (B5)
//   bench      ms per derived frame with and without the GI (--size N: N³, a
//              multiple of 32; 32 by default)
//
// usage: node tools/gi-check.mjs [--stage reference,parity,lit,far,lazy,bench] [--size N] [--port N]
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const STAGES = {
  reference: ['gather', 'sky', 'cube', 'bits'],
  parity: ['parity'],
  lit: ['lit'],
  far: ['far'],
  lazy: ['lazy'],
  bench: ['bench'],
};
const size = Number(opt('size') ?? 32);
if (!(size >= 32 && size % 32 === 0)) throw new Error(`--size ${opt('size')}: a multiple of 32`);
const stages = opt('stage')?.split(',') ?? Object.keys(STAGES);

const vite = await startVite({ harness: true });
const browser = await launchBrowser();
let failures = 0;
const t00 = Date.now();
try {
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/gi-check.html', { errors });
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}`);
  for (const stage of stages) {
    if (!STAGES[stage]) { failures++; console.log(`FAIL no stage ${stage} (have: ${Object.keys(STAGES).join(', ')})`); continue; }
    console.log(`\n${stage}`);
    for (const name of STAGES[stage]) {
      const t0 = Date.now();
      try {
        const r = await page.evaluate(([n, s]) => window.__harness.run(n, n === 'bench' ? { size: s } : undefined), [name, size]);
        for (const c of r.checks) {
          if (!c.ok) failures++;
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name}: ${c.name}${c.ok || !c.detail ? '' : `\n     ${c.detail}`}`);
        }
        if (r.changes) console.log(`     largest change over two frames, every second frame: ${r.changes.join(' ')}`);
        if (name === 'bench') {
          const b = r.info;
          console.log(`     ${b.size}³: a derived frame ${b.bricksMs} ms, with the GI ${b.withGiMs} ms: the GI ${b.giMs} ms (mean of ${b.frames}, fenced)`);
        }
      } catch (e) {
        failures++;
        console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
      }
      console.log(`     (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
  const pageFailures = await page.evaluate(() => window.__harness.failures);
  if (pageFailures.length) { failures++; console.log(`FAIL graphics failures: ${pageFailures.join(' | ')}`); }
  if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ')}`); }
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\n(${((Date.now() - t00) / 1000).toFixed(0)} s in all)`);
console.log(failures ? `\ngi-check: ${failures} failure(s)` : '\ngi-check: clean');
process.exit(failures ? 1 : 0);
