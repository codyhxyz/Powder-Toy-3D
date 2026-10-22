// Real-GPU check of co-op under Physics V2 (src/net/codec.js, tools/harness/net-native-check.*): a box
// of native cells packed by the host's kernels and written back by a guest's gives back every id, fill,
// foam, flux, fall, payload, burn, spark and phase bit for bit (the exact records carry the cells the
// texel can't, with their banks); only a texel's temperature code and colour seed are a guest's own, as
// a V1 guest's. The pool's flying matter comes back at its slots. One page, no app, one GPU slot.
// node tools/v2/net-native-browser-check.mjs [--port N]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

const vite = await startVite({ harness: true });
let browser, failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
try {
  browser = await launchBrowser();
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/net-native-check.html', { errors });
  const r = await page.evaluate(() => window.__harness.run('roundtrip'));
  console.log(JSON.stringify(r));
  ok(r.applied === true, 'the guest\'s native unpack applied');
  ok(r.differ === 0, `every cell is the host's but its texel temperature and seed (${r.differ} differ${r.firstBad ? `: ${JSON.stringify(r.firstBad)}` : ''})`);
  ok(r.records > 0 && r.exact === r.records, `${r.records} exact records land bit for bit, banks too`);
  ok(r.partialRecorded && r.fallingRecorded && r.burningRecorded && r.sparkRecorded && r.phaseRecorded, 'partial fill + flux + foam, a fall, a burn, a spark and a phase change are all recorded');
  ok(!r.fullRecorded && !r.restingRecorded, 'full water and resting sand ride their texels alone');
  ok(r.tempMax <= 4, `temperatures within the texel code's step (${r.tempMax} K)`);
  ok(r.flying === 3 && r.live === 3 && r.poolSame, 'the flying matter comes back at its slots, with its live count');
  ok(!errors.length, `no page errors ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser?.close();
  await vite.close();
}
process.exitCode = failures ? 1 : 0;
