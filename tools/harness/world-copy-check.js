// The world copy's harness page (docs/seamless-world.md "W"): a V2 window and the world copy of its scene on
// this page's device, no app. tools/world-copy-gpu-check.mjs drives it through window.__harness:
//   build { scene, seed, win, origin, samples, origin2 }
//     the window filled from the scene at `origin`, the copy built (the scene's chunks, trees and the window's
//     cells), its words at `samples` returned with the allocator's integrity; then the window refilled from
//     `origin2` (left at `origin`) and written back, the same samples and integrity again.
import { boot, ready, log, test, nativeSim } from './harness.js';
import { WorldCopy } from '/src/world/worldCopy.js';
import { WorldGenerator } from '/src/world/gpu.js';
import { WORLD_SCENES } from '/src/world/scenes/index.js';
import { WC_MIXED } from '/src/shaders/world/cellWord.js';

const h = await boot({ label: 'world-copy-check' });
const gpu = h.gpu;

async function snapshot(wc, samples) {
  const st = await wc.stats();
  const u32 = async (b, offset = 0, size = b.size - offset) => new Uint32Array(await gpu.readback.buffer(b, offset, size));
  const table = await u32(wc.buf.table), info = await u32(wc.buf.meta, 0, Math.ceil(wc.L.nBricks / 4) * 16);
  const pool = await u32(wc.buf.pool, 0, Math.max(16, Math.min(wc.buf.pool.size, st.bump * 256)));
  const [BX, BY] = wc.L.bricks;
  const cell = (x, y, z) => {
    const e = table[(x >> 2) + BX * ((y >> 2) + BY * (z >> 2))];
    if (!(e & WC_MIXED)) return e;
    return pool[((e & ~WC_MIXED) >>> 0) * 64 + ((x & 3) + 4 * ((y & 3) + 4 * (z & 3)))];
  };
  // integrity: slots unique, below the bump, not on the free list; used = mixed bricks
  const alloc = await u32(wc.buf.alloc);
  const ctrl = alloc.subarray(0, 4);
  const freeSet = new Set(alloc.subarray(4, 4 + ctrl[1]));
  const seen = new Set();
  let mixed = 0, shared = 0, freed = 0, past = 0, matter = 0;
  for (let i = 0; i < table.length; i++) {
    if (info[i] & (1 << 15)) matter++;
    const e = table[i];
    if (!(e & WC_MIXED)) continue;
    mixed++;
    const s = (e & ~WC_MIXED) >>> 0;
    if (seen.has(s)) shared++;
    if (freeSet.has(s)) freed++;
    if (s >= ctrl[0]) past++;
    seen.add(s);
  }
  return { stats: st, ctrl: [...ctrl], mixed, shared, freed, past, matter, words: samples.map(([x, y, z]) => cell(x, y, z)) };
}

test('build', async ({ scene: key = 'island', seed = 20261008, win = 64, origin = [480, 0, 480], origin2 = [128, 0, 640], samples = [] }) => {
  const scene = WORLD_SCENES.find((s) => s.key === key);
  const t0 = performance.now();
  const P0 = scene.params({ size: [1024, 128, 1024], seed });
  const sim = await nativeSim(gpu, win, P0.size[1], win, { windowed: true, world: P0.size });
  const gen = new WorldGenerator(sim, scene, P0, { regions: [[64, P0.size[1], 64]] });
  await gen.ready;
  sim.origin.x = origin[0]; sim.origin.y = origin[1]; sim.origin.z = origin[2];
  gen.fill(P0, origin);
  await gpu.fence();
  const tReady = performance.now();
  const wc = new WorldCopy(gpu, { size: P0.size });
  await wc.build({ sim, scene, P: P0, gen, wb: P0.size.map((n) => n / 4), candidates: new Map() });
  const tBuilt = performance.now();
  const built = await snapshot(wc, samples);
  // the window refilled from elsewhere (left where it is) and written back
  gen.fill(P0, origin2);
  const t1 = performance.now();
  wc.recordWriteback(gpu.frame, sim, null);
  await gpu.fence();
  const wbMs = performance.now() - t1;
  const after = await snapshot(wc, samples);
  const out = { setupMs: tReady - t0, buildMs: tBuilt - tReady, wbMs, last: wc.last, built, after, bytes: wc.bytes, failures: [...h.failures] };
  wc.dispose();
  return out;
});

log('world-copy-check: ready');
ready();
