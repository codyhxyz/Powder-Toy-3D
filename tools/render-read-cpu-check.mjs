// CPU-only regression for reflection occupancy and full-weight cubic reads.
// No browser/GPU. Optional Naga validation of complete generated volume shaders.
// Usage: node tools/render-read-cpu-check.mjs [--naga]
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { volumeFrag } from '../src/shaders/render.js';
import { DETAIL } from '../src/gfx/detail.js';
import { fieldBlurFrag, fieldPeakFrag } from '../src/shaders/fields.js';
import { CHANNELS, gauss5, bulkPeak, bulkPeakCubic, THIN_MIN_PEAK } from '../src/gfx/materials.js';

const clean = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
function body(code, name) {
  const declaration = code.indexOf(`fn ${name}(`);
  assert(declaration >= 0, name);
  const start = code.indexOf('{', declaration);
  let depth = 1, end = start;
  while (depth) { end++; if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return code.slice(start + 1, end);
}
const variants = [];
for (const g of [{ nx: 32, ny: 32, nz: 32 }, { nx: 160, ny: 96, nz: 160 }]) {
  for (const detail of [{}, Object.fromEntries(DETAIL.map((d) => [d.define, true]))]) {
    for (const curved of [false, true]) {
      variants.push(volumeFrag(g, { detail, curved }));
    }
  }
}
for (const code of variants) {
  const refl = clean(body(code, 'reflectHit'));
  assert.match(refl, /bid = brickId\(bc\); flags = brickInfoOf\(bid\); if \(brickOpaque\(flags\)\) \{ occM = occMaskOf\(bid\); \}/);
  assert(!/gThin\s*=/.test(refl), 'reflection must inherit gThin');
  assert.match(refl, /let id = occCellId\(occM, bid, cell\);/);
  assert.match(refl, /if \(id == E_EMPTY && \(flags & \(BRICK_SURF \| BRICK_MEDIA\)\) == 0u\) \{ stale = true; tEnter = tExit; ax = ddaStep\(istp, tDelta, &cell, &tMax\); continue; \}/);
  assert.match(refl, /if \(crispHit\(cell, id, ro, rd, tEnter, tExit, &th, &nh\)\) \{ return reflShade\(fetchA\(cell\), ro \+ rd \* th, nh\); \}/);
  assert.equal((refl.match(/fetchA\(cell\)/g) ?? []).length, 1);
  assert.equal((refl.match(/fetchA\(/g) ?? []).length, 3, 'keep both smooth material probes');
  assert.match(refl, /else if \(brickSurf\(flags\)\) \{ if \(stale\) \{ phiA = surfField\(ro \+ rd \* tEnter\); \}/);
  assert.match(refl, /phiA = phiB; stale = false; \} else \{ stale = true; \} tEnter = tExit; ax = ddaStep\(istp, tDelta, &cell, &tMax\);/);
  assert.match(refl, /for \(var i = 0; i < REFL_MAX_STEPS; i\+\+\)/);
  assert.equal(clean(body(code, 'surfSample')), clean(`
    let s = surfField(p);
    let band = CH_CUBIC * select(vec4f(0.0), vec4f(1.0), s > vec4f(CUBIC_LO)) * select(vec4f(0.0), vec4f(1.0), s < vec4f(CUBIC_HI));
    if (all(band == vec4f(0.0))) { return s; }
    var thin = vec4f(0.0);
    if (gThin) { thin = fieldTex(tFT, p); }
    let w = band * max(thin, vec4f(cubicClose(p)));
    if (all(w == vec4f(0.0))) { return s; }
    return mix(s, fieldCubic(tFS, p), w);
  `), 'surfSample band gate and mixing must remain unchanged');
  assert.match(code, /const SURF_ROOT_STEPS: i32 = 5;/);
  assert.equal((body(code, 'surfNormal').match(/surfChannel\(/g) ?? []).length, 10, 'six liquid + four opaque normal taps');
  assert.equal((body(code, 'fieldCubic').match(/textureSampleLevel\(/g) ?? []).length, 8);
}
console.log(`PASS generated shader invariants: ${variants.length} base/near, straight/curved, cube/wide variants`);

// Finite-field justification for eliding mix's unused input: unorm blur
// inputs <=1 and normalised weights give sv<=1 (allow rounding margin).
// The normalisation floor bounds phi by ~50; bulk<=1 and the peak floor
// bound the boost by 100. Their product stays well inside finite f16.
const grid = { nx: 32, ny: 32, nz: 32 };
const blur = clean(fieldBlurFrag(grid, true)), peak = clean(fieldPeakFrag(grid));
assert.match(blur, /const NORM_FLOOR: f32 = 0.02;/);
assert.match(blur, /let o0 = ok \* sv \/ max\(d, vec4f\(NORM_FLOOR\)\);/);
assert.match(peak, /let k = max\(vec4f\(1.0\), P.bulk \/ max\(acc, vec4f\(THIN_MIN_PEAK\)\)\);/);
assert.match(peak, /textureStore\(fieldThin, p, boosted \* smoothstep\(vec4f\(THIN_MASK_LO\), vec4f\(THIN_MASK_HI\), k\)\);/);
for (const smoothing of [0, 0.05, 0.25, 0.5, 1, 2, 10, 100]) for (const channel of CHANNELS) {
  const weights = gauss5(Math.max(channel.sigma * smoothing, 0.05));
  assert(weights.every((w) => Number.isFinite(w) && w >= 0));
  assert(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-6);
  const bulk = (channel.cubic ? bulkPeakCubic : bulkPeak)(weights);
  assert(Number.isFinite(bulk) && bulk >= 0 && bulk <= 1);
}
assert((1.01 / 0.02) * (1 / THIN_MIN_PEAK) < 65504, 'boosted surface remains finite in rgba16float');
console.log('PASS finite surface-field bound and [0,1] thin-mask writer contract');

// Execute the generated scalar WGSL bodies in JS with instrumented texture
// stand-ins (only let/var syntax needs translation). Compare to the old mix.
const f = Math.fround;
const mix = (a, b, w) => f(f(a * f(1 - w)) + f(b * w));
const jsBody = (name) => body(variants[0], name).replace(/\bvar\b/g, 'let');
const evaluate = new Function('CH_CUBIC', 'gThin', 'cubicClose', 'fieldTex', 'surfField', 'fieldCubic', 'mix', `
  const tFT = 0, tFS = 1, max = Math.max;
  function cubicShare(p, ch) { ${jsBody('cubicShare')} }
  return function surfChannel(p, ch) { ${jsBody('surfChannel')} };
`);
let scalarCases = 0;
for (const cubicChannel of [0, 1]) for (const thinEnabled of [false, true]) {
  for (const close of [0, f(0.25), f(1 - 2 ** -24), 1]) for (const mask of [0, f(0.4), 1]) {
    // Surface values can exceed 1 after boosting. Include half-float extremes:
    // the finite-field contract excludes NaN/Inf, not high finite density.
    for (const v of [0, 2 ** -24, f(0.3), f(0.85), 1, 100, 65504]) {
      for (const c of [0, 2 ** -24, f(0.55), 1, 100, 65504]) {
        const reads = { thin: 0, linear: 0, cubic: 0 };
        const channel = evaluate([cubicChannel], thinEnabled, () => close,
          () => { reads.thin++; return [mask]; },
          () => { reads.linear++; return [v]; },
          () => { reads.cubic++; return [c]; }, mix);
        const w = cubicChannel ? Math.max(thinEnabled ? mask : 0, close) : 0;
        const expected = w > 0 ? mix(v, c, w) : v;
        assert.equal(channel(null, 0), expected);
        assert.deepEqual(reads, {
          thin: Number(!!cubicChannel && thinEnabled && close !== 1),
          linear: Number(w !== 1), cubic: Number(w > 0),
        });
        // A backend may lower mix to a + w*(b-a), with cancellation at w=1.
        // Check an explicit absolute tolerance scaled to the input magnitude,
        // not bit identity or an unbounded NaN/Inf equivalence claim.
        if (w === 1) assert(Math.abs(f(v + f(c - v)) - c) <= 2 ** -23 * Math.max(1, v, c));
        scalarCases++;
      }
    }
  }
}
console.log(`PASS ${scalarCases} generated scalar/reference cases; full weight removes linear read, close=1 removes thin read`);

// Reference reflection traversal: real f32 DDA and compact 64-bit masks/packed
// byte ids, synthetic material hits/fields. This checks bookkeeping, not GPU
// root solving/shading. Old/new share only the unchanged stepping/field model.
const EMPTY = 0, SOLID = 1, GLASS = 2, BEVEL_MISS = 3, SMOOTH = 4, GAS = 5;
const OPAQUE = 1, SURF = 2, MEDIA = 4;
const key = (c) => c.join(',');
const bit = (c) => (c[0] & 3) | ((c[1] & 3) << 2) | ((c[2] & 3) << 4);
function packed(ids) {
  const mask = new Uint32Array(2), words = new Uint32Array(16);
  ids.forEach((id, k) => { if (id) { mask[k >> 5] |= 1 << (k & 31); words[k >> 2] |= id << ((k & 3) * 8); } });
  return { mask, words };
}
function occId(b, c) {
  const k = bit(c);
  return ((b.mask[k >> 5] >>> (k & 31)) & 1) ? (b.words[k >> 2] >>> ((k & 3) * 8)) & 255 : EMPTY;
}
for (let k = 0; k < 64; k++) for (const id of [1, 127, 128, 255]) {
  const ids = Array(64).fill(0); ids[k] = id;
  const b = packed(ids);
  for (let j = 0; j < 64; j++) assert.equal(occId(b, [j & 3, (j >> 2) & 3, j >> 4]), ids[j]);
}
const argmin = (v) => v[0] <= v[1] && v[0] <= v[2] ? 0 : v[1] <= v[2] ? 1 : 2;
const coverage = new Set();
function trace(world, ro, inputDir, budget, optimized, gThin) {
  const rd = inputDir.map((d) => Math.abs(d) < 1e-6 ? f(1e-6) : f(d));
  const step = rd.map(Math.sign), delta = rd.map((d) => f(Math.abs(f(1 / d))));
  let cell = ro.map(Math.floor), enter = 0, ax = 1, stale = false, lastB = '', cached;
  const next = () => cell.map((c, j) => f(f(c + Number(rd[j] >= 0) - ro[j]) / rd[j]));
  let tMax = next();
  const fieldCalls = [], visited = [], reads = { full: 0, masks: 0 };
  const field = (t) => { fieldCalls.push(t); return f(f(ro[0] + f(rd[0] * t)) / 16); };
  let phi = field(0);
  const result = (hit) => ({ hit, visited, fieldCalls, cell, tMax, enter, ax, stale, phi, gThin });
  const advance = (exit) => { enter = exit; ax = argmin(tMax); cell[ax] += step[ax]; tMax[ax] = f(tMax[ax] + delta[ax]); };
  for (let i = 0; i < budget; i++) {
    if (cell.some((c) => c < 0 || c >= 16)) break;
    const bc = cell.map((c) => Math.floor(c / 4)), bk = key(bc);
    const b = world.get(bk);
    if (bk !== lastB) { lastB = bk; cached = b; if (optimized && (b.flags & OPAQUE)) reads.masks++; }
    visited.push([i, [...cell], enter, ax, stale, phi]);
    if (!(b.flags & OPAQUE)) {
      coverage.add(b.flags ? 'skipBrick' : 'skipEmpty');
      // skipEmpty's distance=0/1 case is precisely skipBrick's box.
      const lo = bc.map((c) => c * 4), hi = lo.map((c) => c + 4);
      const tb = lo.map((c, j) => f(f((rd[j] >= 0 ? hi[j] : c) - ro[j]) / rd[j]));
      ax = argmin(tb); enter = tb[ax];
      cell = ro.map((r, j) => Math.floor(f(r + f(rd[j] * enter))));
      cell[ax] = step[ax] > 0 ? hi[ax] : lo[ax] - 1;
      tMax = next(); stale = true; continue;
    }
    const exit = Math.min(...tMax);
    const id = optimized ? occId(cached, cell) : (reads.full++, b.ids[bit(cell)]);
    if (optimized && id === EMPTY && !(b.flags & (SURF | MEDIA))) {
      coverage.add('fastEmpty'); stale = true; advance(exit); continue;
    }
    if ([SOLID, GLASS, BEVEL_MISS].includes(id)) {
      coverage.add(['', 'solid', 'glass', 'bevelMiss'][id]);
      if (id === SOLID) {
        if (optimized) reads.full++;
        return { state: result(['crisp', [...cell], enter, ax]), reads };
      }
      stale = true;
    } else if (b.flags & SURF) {
      if (id === EMPTY) coverage.add('smoothEmpty');
      if (stale) { coverage.add('refresh'); phi = field(enter); }
      const phiB = field(exit);
      if (phi < 0.5 && phiB >= 0.5) {
        coverage.add('smoothHit');
        return { state: result(['smooth', enter, exit, phi, phiB]), reads };
      }
      phi = phiB; stale = false;
    } else { stale = true; }
    advance(exit);
  }
  const floor = cell[1] < 0 && rd[1] < 0;
  coverage.add(floor ? 'floor' : 'envOrBudget');
  return { state: result([floor ? 'floor' : 'env']), reads };
}
let seed = 0x5a17;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
let traceCases = 0, fullSaved = 0;
for (let fixture = 0; fixture < 40; fixture++) {
  const world = new Map();
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const flags = fixture === 0 ? OPAQUE : fixture === 1 ? OPAQUE | SURF : Math.floor(random() * 8);
    const ids = Array.from({ length: 64 }, () => random() < 0.92 ? EMPTY : 1 + Math.floor(random() * 5));
    // Empty opaque bricks model conservative flags (including neighbouring fields).
    if (fixture < 2) ids.fill(EMPTY);
    world.set(key([x, y, z]), { flags, ids, ...packed(ids) });
  }
  for (const ro of [[0.5, 0.5, 0.5], [7.5, 7.5, 7.5], [15.5, 15.5, 15.5], [4, 8, 12]]) {
    const signs = Array.from({ length: 8 }, (_, n) => [0, 1, 2].map((j) => n & (1 << j) ? -1 : 1));
    for (const rd of [...signs, [1, 1, 0], [1, 0, 1], [0, 1, 1], [0, -1, 0], [1, f(1 - 2 ** -24), 1], [-0.3, 0.7, 1], [1, 0.1, 0.2]]) {
      for (const budget of [1, 2, 7, 64]) for (const thin of [false, true]) {
        const old = trace(world, ro, rd, budget, false, thin), now = trace(world, ro, rd, budget, true, thin);
        assert.deepEqual(now.state, old.state, `fixture=${fixture} ro=${ro} rd=${rd} budget=${budget}`);
        assert(now.reads.full <= old.reads.full);
        fullSaved += old.reads.full - now.reads.full;
        traceCases++;
      }
    }
  }
}
assert.deepEqual([...coverage].sort(), ['skipBrick', 'skipEmpty', 'fastEmpty', 'solid', 'glass', 'bevelMiss', 'smoothEmpty', 'refresh', 'smoothHit', 'floor', 'envOrBudget'].sort());
assert(fullSaved > 0);
console.log(`PASS ${traceCases} f32 reflection reference walks, all ties/signs/budgets; ${fullSaved} unnecessary full reads removed`);
console.log('PASS compact occupancy: all 64 mask positions, byte lanes and high ids');

if (process.argv.includes('--naga')) {
  const dir = mkdtempSync(join(tmpdir(), 'render-read-cpu-'));
  try {
    for (const [i, code] of variants.entries()) {
      const path = join(dir, `volume-${i}.wgsl`);
      writeFileSync(path, code);
      const run = spawnSync('naga', [path], { encoding: 'utf8', timeout: 120_000 });
      assert.ifError(run.error);
      assert.equal(run.status, 0, `${path}\n${run.stdout}\n${run.stderr}`);
    }
    console.log(`PASS Naga: ${variants.length} complete volume variants`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
