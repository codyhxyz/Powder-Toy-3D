// CPU-only: the seamless world's march (src/shaders/world/march.js) for every material view and the
// realistic view's detail levels, at a small map's and the big maps' physics window: naga validates
// each module, and the bind budget holds (4 groups, 8 storage buffers, 16 sampled textures a stage).
// No GPU, no browser. node tools/world-march-cpu-check.mjs [--dump DIR]
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { worldMarchFrag, WORLD_MARCH_LAYOUTS, MarchParams, physParams, physSlotOf, MARCH_STAGES, marchSplits, compositeWGSL, COMPOSITE_LAYOUT, GBUF_BYTES_PER_PIXEL } from '../src/shaders/world/march.js';
import { cellSlot, ringOf } from '../src/shaders/common.js';
import { MAPS } from '../src/maps.js';
import { REALISTIC_LEVELS } from '../src/shaders/render.js';
import { VIEWS, isMaterialView } from '../src/views.js';
import { nagaSpawn } from './naga.mjs';

const dump = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;
if (dump) mkdirSync(dump, { recursive: true });
const grids = { lab: { nx: 128, ny: 64, nz: 128 }, window: { nx: 128, ny: 128, nz: 128 } };
const materialViews = VIEWS.map((v) => v.key).filter(isMaterialView);
// each case's whole march, and its split stages (shaders/world/march.js MARCH_STAGES) where it splits
const base = [
  ...Object.entries(REALISTIC_LEVELS).map(([k, d]) => ['realistic', k, d()]),
  ...materialViews.filter((v) => v !== 'realistic').map((v) => [v, 'balanced', REALISTIC_LEVELS.balanced()]),
];
const cases = base.flatMap(([v, k, d]) => [[v, k, d, 'whole'], ...(marchSplits(d) ? MARCH_STAGES.map((st) => [v, k, d, st]) : [])]);
let n = 0;
for (const [gname, g] of Object.entries(grids)) {
  for (const [view, level, detail, stage] of cases) {
    const name = `march.${view}.${level}${stage === 'whole' ? '' : `.${stage}`}.${gname}`;
    const code = worldMarchFrag(g, { view, detail, stage });
    const res = [...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g)];
    assert(res.every((r) => Number(r[1]) < 4), `${name}: groups`);
    const storage = res.filter((r) => r[3]?.startsWith('storage')).map((r) => r[4]);
    const textures = res.filter((r) => r[5].startsWith('texture_')).map((r) => r[4]);
    assert(storage.length <= 8, `${name}: ${storage.length} storage buffers (${storage.join(', ')})`);
    assert(textures.length <= 16, `${name}: ${textures.length} textures`);
    // every declared binding is in the layouts the pipeline is made with
    const layouts = WORLD_MARCH_LAYOUTS(undefined, stage);
    const layoutTextures = layouts.flat().filter((e) => e.texture || e.storageTexture).length;
    assert(layoutTextures <= 16, `${name}: its layouts hold ${layoutTextures} textures`);
    for (const r of res) {
      const [grp, b] = [Number(r[1]), Number(r[2])];
      assert(layouts[grp].some((e) => e.binding === b), `${name}: group ${grp} binding ${b} (${r[4]}) has no layout entry`);
    }
    if (dump) writeFileSync(`${dump}/${name}.wgsl`, code);
    const t = performance.now();
    const run = nagaSpawn(code, `${name}.wgsl`);
    if (run.error || run.status !== 0) {
      console.error(`${name}:\n${(run.stderr || run.stdout || String(run.error)).slice(0, 4000)}`);
      process.exit(1);
    }
    n++;
    if (gname === 'lab') console.log(`ok ${name}  ${(code.length / 1024).toFixed(0)} KB  naga ${(performance.now() - t).toFixed(0)} ms  storage ${storage.length} textures ${textures.length}`);
  }
}
assert(MarchParams.size > 0);
{
  const run = nagaSpawn(compositeWGSL(), 'composite.wgsl');
  if (run.error || run.status !== 0) { console.error(`composite:\n${run.stderr || run.stdout}`); process.exit(1); }
  assert.equal(COMPOSITE_LAYOUT.length, 2);
  n++;
  console.log(`ok composite; split G-buffer ${GBUF_BYTES_PER_PIXEL} B/pixel`);
}

// physSlot (the march's run-time slot in physics' window) is the prelude's slotOf, for every map's window
// at an origin in its world
let rnd = 12345;
const rand = (n) => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return rnd % n; };
const windows = [[64, 64, 64], [128, 128, 128], [256, 96, 128], [128, 384, 128], [128, 64, 128], [32, 32, 32]];
let slots = 0;
for (const [nx, ny, nz] of windows) for (const ringed of [false, true]) {
  // (ringed: the window's grid laid out by ring addressing, shaders/common.js ringOf; sim.js g.ring)
  const g = { nx, ny, nz, nbricks: nx * ny * nz / 64 }, origin = { x: 16 * rand(64), y: 0, z: 16 * rand(64) };
  if (ringed) Object.defineProperty(g, 'ring', { get: () => ringOf(g, origin) });
  const pp = physParams({ origin, g });
  for (let i = 0; i < 4000; i++) {
    const c = [rand(nx), rand(ny), rand(nz)];
    assert.equal(physSlotOf(pp, [c[0] + origin.x, c[1] + origin.y, c[2] + origin.z]), cellSlot(g, ...c), `physSlot ${nx}x${ny}x${nz} at ${c}`);
    slots++;
  }
}
// every map's world fits the march's brick key (x and z: 11 bits of bricks, y: 10)
for (const m of MAPS.filter((x) => x.dims)) {
  const [x, y, z] = m.dims;
  assert(x / 4 <= 2048 && z / 4 <= 2048 && y / 4 <= 1024, `${m.key}: ${m.dims} fits the brick key`);
}
console.log(`PASS physSlot = slotOf on ${slots} cells of ${windows.length} windows, ringed and not; every map's world fits the brick key`);
console.log(`PASS ${n} world march modules validate (naga), bind budget holds; no GPU/browser`);
