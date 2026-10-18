// CPU-only: conservative final-field certificates, interpolation support, march
// equivalence, source contracts. --naga additionally validates generated WGSL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRICK_INFO, packBrickInfo, unpackBrickInfo } from '../../src/shaders/bindings.js';
import { brickFrag } from '../../src/shaders/passes.js';
import { volumeFrag, REALISTIC_LEVELS } from '../../src/shaders/render.js';
import { gridLayout } from '../../src/sim.js';
import { assertNaga } from './wgsl-grouping.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const core = read('src/shaders/gfx/core.js'), render = read('src/shaders/render.js');
const passes = read('src/shaders/passes.js'), derived = read('src/derived.js');
const strip = s => s.replace(/\/\/[^\n]*/g, '');
assert.match(passes, /air\.z = max\(1\.0 - sf\.x, max\(sf\.y, max\(sf\.z, sf\.w\)\)\)/);
assert.match(passes, /wgAir\[li\] = max\(wgAir\[li\], wgAir\[li \+ w\]\)/);
assert.match(passes, /BRICK_LIQUID_INTERIOR, wgAir\[0\]\.z < 0\.499/);
assert.match(core, /fn liquidInterior\(bc: vec3i\)/);
for (const axis of ['x', 'y', 'z']) assert(core.includes(`var ${axis} = -1; ${axis} <= 1; ${axis}++`));
assert.match(core, /brickOcc\(q\) & BRICK_LIQUID_INTERIOR/);
assert.match(core, /clamp\(bc \+ vec3i\(x, y, z\), vec3i\(0\), vec3i\(BX, BY, BZ\) - 1\)/);
assert(derived.indexOf('this.updateFields();') < derived.indexOf('this._dispatch(k.brick,'), 'certificates follow final fields');
assert.match(render, /liq != E_EMPTY && \(flags & BRICK_LIQUID_INTERIOR\) != 0u/);
assert.match(render, /interiorLiquid = liquidInterior\(bc\)/);
assert.match(render, /brickSurf\(flags\).*liq != E_EMPTY && interiorLiquid/);
const crossing = strip(render.slice(render.indexOf('var phiB = vec4f(0.0);'), render.indexOf('if (tCut < tEv)')));
assert.match(crossing, /phiStale = false;\s*} else {\s*phiStale = true;/, 'skipped samples cannot leak into surface boundaries');
// DDA, optics and body integration are outside the certificate branch.
assert(render.indexOf('absorbDeco(liq,') > render.indexOf('if (tCut < tEv)'));
assert.match(render, /thinBodySeg\(pm, tEv - tEnter\)/);
assert.match(render, /if \(brickMixed\(flags\)\)/);
assert.match(render, /liquidInterface\(hp, n0, n0, true/);
assert.match(render, /phiA = surfSample\(ro\); phiStale = false/);

const bit = BRICK_INFO.LIQUID_INTERIOR;
assert.equal(bit, 65536);
for (let bits = 0; bits < 32; bits++) for (let air = 0; air < 8; air++) for (const gas of [0, 1, 64]) {
  const w = packBrickInfo({ bits, air, gas, matter: true });
  assert.equal(w & bit, 0);
  assert.deepEqual(unpackBrickInfo(w | bit), unpackBrickInfo(w), 'certificate must not change material/air/gas decoding');
}

// Scalar twin of the writer's existing max reduction. Test all texels, not
// the 2³ air-pressure core: one bad corner is enough to reject the brick.
const N = 16, B = N / 4;
let seed = 0x12938;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const index = (x, y, z) => x + N * (y + N * z);
const field = Array.from({ length: N ** 3 }, () => [
  (515 + Math.floor(random() * 500)) / 1024,
  Math.floor(random() * 509) / 1024, Math.floor(random() * 509) / 1024, Math.floor(random() * 509) / 1024,
]);
const texel = (x, y, z) => field[index(...[x, y, z].map(v => clamp(v, 0, N - 1)))];
const brickSafe = b => {
  let violation = -Infinity;
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const v = texel(b[0] * 4 + x, b[1] * 4 + y, b[2] * 4 + z);
    violation = Math.max(violation, 1 - v[0], v[1], v[2], v[3]);
  }
  return violation < 0.499;
};
const interior = b => {
  if (!brickSafe(b)) return false;
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    if (!brickSafe(b.map((v, i) => clamp(v + [x, y, z][i], 0, B - 1)))) return false;
  }
  return true;
};
const weights = (f, cubic) => cubic
  ? [(1 - f) ** 3 / 6, (4 - 6 * f * f + 3 * f ** 3) / 6, (1 + 3 * f + 3 * f * f - 3 * f ** 3) / 6, f ** 3 / 6]
  : [1 - f, f];
function sample(p, cubic) {
  const c = p.map(v => clamp(v, 0.5, N - 0.5) - 0.5), i = c.map(Math.floor);
  const w = c.map((v, a) => weights(v - i[a], cubic));
  const out = [0, 0, 0, 0], taps = cubic ? 4 : 2, offset = cubic ? -1 : 0;
  for (let z = 0; z < taps; z++) for (let y = 0; y < taps; y++) for (let x = 0; x < taps; x++) {
    const v = texel(i[0] + x + offset, i[1] + y + offset, i[2] + z + offset);
    for (let ch = 0; ch < 4; ch++) out[ch] += v[ch] * w[0][x] * w[1][y] * w[2][z];
  }
  return out;
}
const safeValue = v => v[0] > 0.5 && v.slice(1).every(x => x < 0.5);
let probes = 0;
for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
  const b = [x, y, z];
  assert(interior(b));
  for (let k = 0; k < 50; k++) {
    // Includes exact brick faces/corners, near faces and clamped grid edges.
    const p = b.map(v => 4 * v + (k < 3 ? [0, 4, 1e-6][k] : 4 * random()));
    const linear = sample(p, false), cubic = sample(p, true);
    assert(safeValue(linear)); assert(safeValue(cubic));
    const mix = linear.map((v, ch) => { const w = random(); return (1 - w) * v + w * cubic[ch]; });
    assert(safeValue(mix));
    probes++;
  }
}

// Negative controls: center-only certification would skip real liquid exits
// and opaque entries through the neighbouring brick. Mutate just that brick
// (as an incremental edit does); no cached/dilated certificate may survive it.
for (const ch of [0, 1, 2, 3]) {
  const old = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 8; x < N; x++) {
    const k = index(x, y, z); old.push([k, field[k]]);
    field[k] = ch === 0 ? [0, 0, 0, 0] : [1, 0, 0, 0].map((v, c) => c === ch ? 4 : v);
  }
  assert(brickSafe([1, 1, 1]), 'negative control would accept the center alone');
  assert(!interior([1, 1, 1]), 'halo must reject an edited neighbour');
  const v = sample([8, 6, 6], false);
  assert(ch === 0 ? v[0] < 0.5 : v[ch] > 0.5, 'negative control must actually cross');
  for (const [k, v] of old) field[k] = v;
  assert(interior([1, 1, 1]), 'restoring the neighbour restores the certificate');
}
// Isovalue and safety-margin ties are never certified, even one corner cell.
for (const v of [[0.5, 0, 0, 0], [0.5005, 0, 0, 0], [1, 0.5, 0, 0], [1, 0, 0.4995, 0]]) {
  const k = index(4, 4, 4), old = field[k]; field[k] = v;
  assert(!brickSafe([1, 1, 1])); field[k] = old;
}

// Numerical ray replay: underwater starts, exact cell/brick ties, thin/close
// blend weights, exit into air and entry into each opaque channel. The fast
// march drops only certified field work and marks its entry sample stale.
function trace(start, blend, fast) {
  const surf = x => {
    const a = sample([x, 6.1, 6.3], false), b = sample([x, 6.1, 6.3], true);
    return a.map((v, ch) => ((ch === 0 || ch === 2) && v > 0.3 && v < 0.85) ? v * (1 - blend) + b[ch] * blend : v);
  };
  const root = (a, b, ch) => {
    let fa = surf(a)[ch] - 0.5, fb = surf(b)[ch] - 0.5;
    for (let k = 0; k < 5; k++) {
      const m = a + (b - a) * clamp(fa / (fa - fb), 0.15, 0.85), fm = surf(m)[ch] - 0.5;
      if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else { b = m; fb = fm; }
    }
    return a + (b - a) * clamp(fa / (fa - fb), 0, 1);
  };
  let a = start, phi = null, skipped = 0;
  while (a < N) {
    const cell = Math.floor(a), b = Math.min(cell + 1, N);
    if (fast && interior([Math.floor(cell / 4), 1, 1])) { phi = null; skipped++; a = b; continue; }
    const m = clamp(cell + 0.5, a, b), pa = phi ?? surf(a), pm = surf(m), pb = surf(b);
    let hit = null;
    for (let ch = 0; ch < 4; ch++) {
      const cross = (u, v) => ch === 0 ? u >= 0.5 && v < 0.5 : u < 0.5 && v >= 0.5;
      let t = null;
      if (cross(pa[ch], pm[ch])) t = root(a, m, ch);
      else if (m < b && cross(pm[ch], pb[ch])) t = root(m, b, ch);
      if (t !== null && (!hit || t < hit.t)) hit = { t, ch };
    }
    if (hit) return { hit, skipped };
    phi = pb; a = b;
  }
  return { hit: null, skipped };
}
let replayed = 0, skippedSegments = 0;
for (const ch of [0, 1, 2, 3]) {
  const old = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 12; x < N; x++) {
    const k = index(x, y, z); old.push([k, field[k]]);
    field[k] = ch === 0 ? [0, 0, 0, 0] : [1, 0, 0, 0].map((v, c) => c === ch ? 1 : v);
  }
  for (const start of [0, 0.25, 4, 4.999]) for (const blend of [0, 0.37, 1]) {
    const reference = trace(start, blend, false), optimized = trace(start, blend, true);
    assert.deepEqual(optimized.hit, reference.hit);
    assert.equal(optimized.hit.ch, ch);
    assert(optimized.skipped > 0, 'non-vacuous shortcut');
    skippedSegments += optimized.skipped; replayed++;
  }
  for (const [k, v] of old) field[k] = v;
}
console.log(`ok: ${replayed} exact event-distance/channel replays, ${skippedSegments} cell segments bypass field sampling`);

// How much deterministic work can be removed from the historical water slab?
// This is a static-field operation count, NOT a measured GPU speedup.
let eligible = 0;
for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  // Erode one brick around its faces (all 27 neighbours must be liquid).
  if (x >= 6 && x < 26 && z >= 6 && z < 26 && y >= 19 && y < 25) eligible++;
}
assert.equal(eligible, 2400);
console.log(`ok: source contracts, info-bit isolation, ${probes} trilinear/cubic/blended probes, halo/edit/tie negative controls`);
console.log(`static 88×88×32 slab: ${eligible} interior bricks eligible before blurred-edge erosion; no GPU timing claim`);

if (process.argv.includes('--naga')) {
  const g = gridLayout(128, 128, 128);
  const modules = { brick: brickFrag(g) };
  for (const level of ['off', 'balanced', 'full']) for (const curved of [false, true]) {
    modules[`realistic-${level}-${curved ? 'curved' : 'flat'}`] = volumeFrag(g, { view: 'realistic', detail: REALISTIC_LEVELS[level](), curved });
  }
  for (const [name, code] of Object.entries(modules)) {
    assertNaga(code, name);
    console.log(`ok: Naga ${name} (128³)`);
  }
}
