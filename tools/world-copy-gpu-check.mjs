// GPU check of the world copy (docs/seamless-world.md "W"): Island's copy built on the GPU (the harness page
// tools/harness/world-copy-check.*: a 64-wide V2 window, the scene's chunks, trees, the window's cells), its
// words at a few thousand cells (half near the ground) against the CPU twin (tools/world-copy-cpu-check.mjs
// islandCpu: the census's), the allocator's integrity, the build time and memory; then the window refilled
// from another place and written back, its cells against the twin's there. One browser, through
// tools/browser.mjs (its slot rules: <= 25 s, never beside another, yields to the player).
// usage: node tools/world-copy-gpu-check.mjs [--samples 4000] [--port N]
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { islandCpu } from './world-copy-cpu-check.mjs';

const argv = process.argv.slice(2), opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const N = +opt('samples', 4000), WIN = 64, ORIGIN = [480, 0, 480], ORIGIN2 = [128, 0, 640];
const A = await islandCpu();
const [X, H, Z] = A.size;
let s = 12345;
const r = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
const samples = [];
for (let i = 0; i < N; i++) {
  const x = Math.floor(r() * X), z = Math.floor(r() * Z);
  const y = i % 2 ? Math.floor(r() * H) : Math.max(0, Math.min(H - 1, A.top(x, z) - 6 + Math.floor(r() * 12)));
  samples.push([x, y, z]);
}
// a sample in the first window's region (its cells are the window's: the fill, no trees planted there)
const inWin = ([x, , z]) => x >= ORIGIN[0] && x < ORIGIN[0] + WIN && z >= ORIGIN[2] && z < ORIGIN[2] + WIN;
for (let i = 0; i < 400; i++) samples.push([ORIGIN[0] + Math.floor(r() * WIN), Math.floor(r() * H), ORIGIN[2] + Math.floor(r() * WIN)]);
const t0 = Date.now();
const expect = samples.map(([x, y, z]) => A.cell(x, y, z));
const expectBare = samples.map(([x, y, z]) => A.column(x, z)(y));   // no trees: the window's fill
console.log(`cpu twin: ${samples.length} cells in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const vite = await startVite({ harness: true });
let failures = 0;
const ok = (c, what) => { if (!c) failures++; console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`); };
try {
  const browser = await launchBrowser();
  const errors = [];
  try {
    const page = await openHarness(browser, vite, '/tools/harness/world-copy-check.html', { errors });
    const res = await page.evaluate((a) => window.__harness.run('build', a), { win: WIN, origin: ORIGIN, origin2: ORIGIN2, samples });
    console.log(JSON.stringify({ setupMs: Math.round(res.setupMs), buildMs: Math.round(res.buildMs), wbMs: Math.round(res.wbMs), last: res.last, bytesMiB: +(res.bytes / 2 ** 20).toFixed(1) }));
    for (const [label, snap] of [['built', res.built], ['after writeback', res.after]]) {
      console.log(`${label}: ${JSON.stringify({ ...snap, words: undefined })}`);
      ok(snap.ctrl[2] === 0, `${label}: no brick went without a slot (OVER ${snap.ctrl[2]})`);
      ok(!snap.shared && !snap.freed && !snap.past, `${label}: slots unique, none freed or past the bump`);
      ok(snap.mixed === snap.ctrl[0] - snap.ctrl[1], `${label}: mixed bricks ${snap.mixed} = bump ${snap.ctrl[0]} - free ${snap.ctrl[1]}`);
    }
    // ids against the twin: outside the first window (built from the scene), inside it (the window's cells)
    const cmp = (words, pick, want) => {
      let n = 0, bad = 0, trees = 0;
      const ex = [];
      samples.forEach((p, i) => {
        if (!pick(p)) return;
        n++;
        const got = words[i] & 255, w = want[i];
        if (got !== w) { bad++; if (expect[i] !== expectBare[i]) trees++; if (ex.length < 6) ex.push(`${p}: gpu ${got} cpu ${w}`); }
      });
      return { n, bad, trees, ex };
    };
    const out = cmp(res.built.words, (p) => !inWin(p), expect);
    console.log(`built, outside the window: ${out.n} cells, ${out.bad} differ (${out.trees} where the twin has a tree) ${out.ex.join('; ')}`);
    ok(out.bad <= out.n * 0.005, 'built: the scene\'s cells match the twin at 99.5 % or better');
    const inn = cmp(res.built.words, inWin, expectBare);
    console.log(`built, inside the window: ${inn.n} cells, ${inn.bad} differ ${inn.ex.join('; ')}`);
    ok(inn.bad <= inn.n * 0.005, 'built: the window\'s cells (its V2 cores) match the twin');
    const moved = samples.map(([x, y, z]) => (inWin([x, y, z]) ? A.column(x - ORIGIN[0] + ORIGIN2[0], z - ORIGIN[2] + ORIGIN2[2])(y) : null));
    const wb = cmp(res.after.words, inWin, moved);
    console.log(`after writeback, inside the window: ${wb.n} cells, ${wb.bad} differ ${wb.ex.join('; ')}`);
    ok(wb.bad <= wb.n * 0.005, 'writeback: the window\'s new cells are in the copy');
    const still = res.after.words.filter((w, i) => !inWin(samples[i]) && w !== res.built.words[i]).length;
    ok(still === 0, `writeback: nothing outside the window changed (${still})`);
    if (res.failures.length) { failures++; console.log(`FAIL graphics: ${res.failures.join(' | ')}`); }
  } finally {
    if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.slice(0, 5).join(' | ')}`); }
    await browser.close();
  }
} finally {
  await vite.close();
}
console.log(failures ? `world-copy-gpu-check: ${failures} failure(s)` : 'world-copy-gpu-check: ok');
process.exit(failures ? 1 : 0);
