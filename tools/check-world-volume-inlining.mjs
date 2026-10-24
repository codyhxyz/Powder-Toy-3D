// CPU-only compile-cost guard for the big-map (World) volume shader. No GPU,
// no browser, no Naga.
//
// Metal inlines every call into the fragment's main, so a helper called from
// N sites is compiled N times. The World volume took 31 s cold once from
// ~1,700 inlined page requests (shaders/worldAccess.js, 2026-10-17), and its
// remaining hot spots are copies of whole marches. Measured with the CPU-only
// Metal recipe (memory: cold-shader-compile), base detail, ~5.4 s:
//   - the lamps' shadow-ray DDA (traceNearSteps): stubbing its copies saves
//     ~1.2 s; the beacon's copy inside crystalInterface, which only reads the
//     lamps' specular, cost ~0.4 s on its own (2026-10-21);
//   - the trilinear field read (worldFieldLinear, eight page lookups): a
//     single load in its place saves ~1.3 s.
//   - the view's far-air test (worldViewFarAir, world/worldViewRing.js): it
//     lives inside worldPage, the one request helper, so it has exactly
//     worldPage's copies and no call site of its own. It costs ~1 s at
//     balanced detail (6.4 -> 7.4 s, medians of 8 interleaved runs, noise
//     +-1 s, 2026-10-22); as a separate helper for the brick readers only it
//     cost ~0.2 s, but then a cell or field read beside a hit still asked.
// This check fails when a change adds copies of those, so a new call site is
// a decision (raise the ceiling here and say why) instead of a silent slower
// load after a deploy.
//
// usage: node tools/check-world-volume-inlining.mjs [--print]
import assert from 'node:assert/strict';
import { volumeFrag, REALISTIC_LEVELS } from '../src/shaders/render.js';
import { WORLD_SHADER_GRIDS } from '../src/shaders/worldRender.js';

// Inlined copies allowed in the fragment entry, per detail level the menu
// warms (shaders/render.js REALISTIC_LEVELS: balanced is the default, full
// every switch; the distance gate's base level is gone, 2026-10-23).
const CEILINGS = {
  balanced: { traceNearSteps: 3, worldFieldLinear: 71, worldFieldCubic: 12, worldPage: 177 },
  full: { traceNearSteps: 3, worldFieldLinear: 75, worldFieldCubic: 12, worldPage: 227 },
};
const ENTRY = 'fs';
const PRINT = process.argv.includes('--print');

// Function bodies by name (WGSL has no overloading), comments stripped.
function functions(code) {
  const out = new Map();
  const re = /\bfn\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index);
    let depth = 0, k = open;
    for (; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}' && --depth === 0) break;
    }
    out.set(m[1], code.slice(open, k + 1).replace(/\/\/[^\n]*/g, ''));
  }
  return out;
}
// Copies of every function inside one fully inlined `entry`: each textual call
// is one copy of the callee (a loop's body is compiled once unless unrolled).
export function inlinedCopies(code, entry = ENTRY) {
  const fns = functions(code);
  assert(fns.has(entry), `no entry ${entry}`);
  const calls = new Map();
  for (const [f, body] of fns) {
    const c = new Map();
    for (const g of fns.keys()) {
      if (g === f) continue;
      const n = body.match(new RegExp(`\\b${g}\\s*\\(`, 'g'))?.length ?? 0;
      if (n) c.set(g, n);
    }
    calls.set(f, c);
  }
  const memo = new Map();
  const within = (f) => {
    if (memo.has(f)) return memo.get(f);
    const r = new Map([[f, 1]]);
    for (const [g, n] of calls.get(f)) for (const [h, k] of within(g)) r.set(h, (r.get(h) ?? 0) + n * k);
    memo.set(f, r);
    return r;
  };
  return within(entry);
}

let checked = 0;
for (const g of WORLD_SHADER_GRIDS) for (const curved of [false, true]) for (const [level, ceiling] of Object.entries(CEILINGS)) {
  const code = volumeFrag(g, { backend: 'world', view: 'realistic', detail: REALISTIC_LEVELS[level](), curved });
  const copies = inlinedCopies(code);
  const tag = `world ${g.nx}x${g.ny}x${g.nz}${g.sourceAppearance ? ' source' : ''}${curved ? ' curved' : ''} ${level}`;
  if (PRINT) console.log(tag, Object.keys(ceiling).map((f) => `${f} ${copies.get(f) ?? 0}`).join(', '));
  for (const [f, max] of Object.entries(ceiling)) {
    assert((copies.get(f) ?? 0) <= max, `${tag}: ${copies.get(f)} inlined copies of ${f} (ceiling ${max}; see this file's header before raising it)`);
  }
  // The far-air test is the request helper's: only worldPage calls it.
  const fns = functions(code);
  assert.equal(copies.get('worldViewFarAir') ?? 0, copies.get('worldPage') ?? 0, `${tag}: worldViewFarAir must be inlined only through worldPage`);
  for (const [f, body] of fns) if (f !== 'worldPage') assert(!/\bworldViewFarAir\s*\(/.test(body), `${tag}: ${f} calls worldViewFarAir; keep the far-air test inside worldPage`);
  // A crystal face reads only the lamps' specular: the beam (diffuse only)
  // must stay out of its call, or its whole-window ray runs in the march.
  const crystal = fns.get('crystalInterface');
  assert(crystal && /lampLights\([^;]*,\s*false\)\s*;/.test(crystal), `${tag}: crystalInterface must call lampLights(..., beamOn = false)`);
  checked++;
}
// Small maps (Box) hold their whole window and ask for nothing: no view ring there.
for (const level of Object.keys(CEILINGS)) assert(!volumeFrag({ nx: 128, ny: 128, nz: 128 }, { view: 'realistic', detail: REALISTIC_LEVELS[level]() }).includes('worldViewFarAir'), `Box ${level}: the World view's far-air ring leaked into the small maps' shader`);
console.log(`world volume inlining: ${checked} variants within their inlined-copy ceilings (traceNearSteps, field reads, page lookups)`);
