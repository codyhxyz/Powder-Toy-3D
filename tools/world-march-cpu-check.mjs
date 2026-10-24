// CPU-only: the seamless world's march (src/shaders/world/march.js) for every material view and the
// realistic view's detail levels, at a small map's and the big maps' physics window: naga validates
// each module, and the bind budget holds (4 groups, 8 storage buffers, 16 sampled textures a stage).
// No GPU, no browser. node tools/world-march-cpu-check.mjs [--dump DIR]
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { worldMarchFrag, WORLD_MARCH_LAYOUTS, MarchParams } from '../src/shaders/world/march.js';
import { REALISTIC_LEVELS } from '../src/shaders/render.js';
import { VIEWS, isMaterialView } from '../src/views.js';
import { nagaSpawn } from './naga.mjs';

const dump = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;
if (dump) mkdirSync(dump, { recursive: true });
const grids = { lab: { nx: 128, ny: 64, nz: 128 }, window: { nx: 128, ny: 128, nz: 128 } };
const materialViews = VIEWS.map((v) => v.key).filter(isMaterialView);
const cases = [
  ...Object.entries(REALISTIC_LEVELS).map(([k, d]) => ['realistic', k, d()]),
  ...materialViews.filter((v) => v !== 'realistic').map((v) => [v, 'balanced', REALISTIC_LEVELS.balanced()]),
];
let n = 0;
for (const [gname, g] of Object.entries(grids)) {
  for (const [view, level, detail] of cases) {
    const name = `march.${view}.${level}.${gname}`;
    const code = worldMarchFrag(g, { view, detail });
    const res = [...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g)];
    assert(res.every((r) => Number(r[1]) < 4), `${name}: groups`);
    const storage = res.filter((r) => r[3]?.startsWith('storage')).map((r) => r[4]);
    const textures = res.filter((r) => r[5].startsWith('texture_')).map((r) => r[4]);
    assert(storage.length <= 8, `${name}: ${storage.length} storage buffers (${storage.join(', ')})`);
    assert(textures.length <= 16, `${name}: ${textures.length} textures`);
    // every declared binding is in the layouts the pipeline is made with
    const layouts = WORLD_MARCH_LAYOUTS();
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
console.log(`PASS ${n} world march modules validate (naga), bind budget holds; no GPU/browser`);
