// CPU-only regression: execute generated WGSL crossing/root bodies, not a
// duplicate solver. Texture stand-ins sample thin slab/grain control lattices.
// Usage: node tools/check-reflection-roots.mjs [--naga]
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { volumeFrag, WGSL_CHECK } from '../src/shaders/render.js';
import { DETAIL } from '../src/gfx/detail.js';

function body(code, name) {
  const declaration = code.indexOf(`fn ${name}(`);
  assert(declaration >= 0, name);
  const start = code.indexOf('{', declaration);
  let depth = 1, end = start;
  while (depth && ++end < code.length) {
    if (code[end] === '{') depth++;
    if (code[end] === '}') depth--;
  }
  assert.equal(depth, 0, name);
  return code.slice(start + 1, end);
}
const clean = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const f = Math.fround;
const mix = (a, b, w) => f(f(a * f(1 - w)) + f(b * w));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rayAt = (ro, rd, t) => ro.map((v, i) => f(v + f(rd[i] * t)));
const select = (a, b, condition) => condition ? b : a;

// Hat and cubic B-spline reconstruction of one nonzero control point.
// A slab is constant in y/z; a grain has a single nonzero 3D texel.
const hat = (x) => Math.max(0, 1 - Math.abs(x));
function spline(x) {
  x = Math.abs(x);
  return x < 1 ? (4 - 6 * x * x + 3 * x ** 3) / 6 : x < 2 ? (2 - x) ** 3 / 6 : 0;
}
function field(shape, amplitude, kernel, p) {
  return f(amplitude * kernel(p[0] - 8.5)
    * (shape === 'slab' ? 1 : kernel(p[1] - 8.5) * kernel(p[2] - 8.5)));
}

function compile(code, name, args) {
  // Only these bodies' WGSL declaration syntax and vector ray expression
  // need translation. Scalar branch/iteration/root arithmetic stays generated.
  const js = body(code, name).replace(/\bvar\b/g, 'let')
    .replace(/: bool\b/g, '').replace(/ro \+ rd \* tm/g, 'rayAt(ro, rd, tm)');
  return `function ${name}(${args}) { ${js} }`;
}
function evaluator(code, sample, thin, close) {
  const reads = { linear: 0, cubic: 0, thin: 0, near: 0 };
  const constants = Object.fromEntries(['SURF_ISO', 'NO_HIT', 'SURF_ROOT_STEPS', 'SURF_ROOT_SPLIT_LO', 'SURF_ROOT_SPLIT_HI'].map((name) => {
    const match = code.match(new RegExp(`const ${name}: (?:f32|i32) = ([\\d.e+-]+);`));
    assert(match, name);
    return [name, Number(match[1])];
  }));
  const env = {
    ...constants, rayAt, mix, clamp, select, max: Math.max,
    CH_CUBIC: [1, 0, 1, 0], tFT: 0, tFS: 1,
    surfField: (p) => { reads.linear++; return Array(4).fill(sample(hat, p)); },
    fieldCubic: (_t, p) => { reads.cubic++; return Array(4).fill(sample(spline, p)); },
    fieldTex: () => { reads.thin++; return Array(4).fill(thin); },
    cubicClose: () => { reads.near++; return close; },
  };
  const functions = [
    compile(code, 'reflCross', 'ro, rd, ch, ta0, tb0, phiA, phiB'),
    compile(code, 'surfRoot', 'ro, rd, ch, ta0, tb0, fa0, fb0'),
    compile(code, 'surfCross', 'ro, rd, ch, into, ta, tm, tb, phiA, phiM, phiB'),
    compile(code, 'surfChannel', 'p, ch'), compile(code, 'cubicShare', 'p, ch'),
  ].join('\n');
  return { ...new Function(...Object.keys(env), `${functions}; return { reflCross, surfCross };`)(...Object.values(env)), reads, ...constants };
}

const fixtures = [
  { name: 'thin slab', shape: 'slab', amplitude: 0.8, ro: [7.5, 8.5, 8.5], rd: [1, 0, 0], hit: true },
  { name: 'lone grain', shape: 'grain', amplitude: 1.5, ro: [7.5, 8.5, 8.5], rd: [1, 0, 0], hit: true },
  { name: 'oblique grain', shape: 'grain', amplitude: 1.5, ro: [7.5, 8, 8.25], rd: [1, 0.5, 0.25], hit: true },
  { name: 'endpoint root', shape: 'slab', amplitude: 0.5, ro: [7.5, 8.5, 8.5], rd: [1, 0, 0], hit: true },
  { name: 'below iso', shape: 'grain', amplitude: 0.4, ro: [7.5, 8.5, 8.5], rd: [1, 0, 0], hit: false },
  { name: 'leaving', shape: 'slab', amplitude: 0.8, ro: [8.5, 8.5, 8.5], rd: [1, 0, 0], hit: false },
  { name: 'already inside', shape: 'slab', amplitude: 0.8, ro: [8.25, 8.5, 8.5], rd: [0.25, 0, 0], hit: false },
  { name: 'starts on iso', shape: 'slab', amplitude: 1, ro: [8, 8.5, 8.5], rd: [0.5, 0, 0], hit: false },
  // Preserve the existing endpoint-only reflection test, not primary-ray
  // midpoint probing: a feature wholly between two below-iso ends is missed.
  { name: 'unbracketed interior grain', shape: 'grain', amplitude: 1.5, ro: [7.5, 8.5, 8.5], rd: [2, 0, 0], hit: false },
];
let variants = 0, cases = 0, negativeControls = 0;
for (const grid of [{ nx: 32, ny: 32, nz: 32 }, { nx: 160, ny: 96, nz: 160 }]) {
  for (const detail of [{}, Object.fromEntries(DETAIL.map((d) => [d.define, true]))]) {
    for (const curved of [false, true]) {
      const code = volumeFrag(grid, { detail, curved });
      const reflection = clean(body(code, 'reflectHit'));
      assert.match(reflection, /reflCross\(ro, rd, c, tEnter, tExit, phiA\[c\], phiB\[c\]\)/);
      assert.doesNotMatch(reflection, /surfCross\(|surfRoot\(|surfChannel\(/);
      assert.match(reflection, /for \(var c = 1; c < 4; c\+\+\)/);
      assert.match(reflection, /surfField\(hp \+ e.xyy\)\[ch\], surfField\(hp \+ e.yxy\)\[ch\], surfField\(hp \+ e.yyx\)\[ch\]/);
      // Call allowlist proves the new solver cannot reach cubic or near-detail
      // sampling indirectly either: surfField -> fieldTex -> trilinear texture.
      const calls = [...clean(body(code, 'reflCross')).matchAll(/\b(\w+)\(/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(calls)].sort(), ['clamp', 'mix', 'surfField']);
      assert.equal(clean(body(code, 'surfField')), 'return fieldTex(tFS, p);');
      assert.match(clean(body(code, 'fieldTex')), /^let q = clamp\(.+; return textureSampleLevel\(t, linearClamp, q \/ vec3f\(GRID\), 0.0\);$/);
      assert.match(body(code, 'surfRoot'), /surfChannel\(ro \+ rd \* tm, ch\)/, 'primary root stays cubic-aware');
      for (const fixture of fixtures) for (const ch of [1, 2, 3]) {
        const { shape, amplitude, ro, rd, hit, name } = fixture;
        const sample = (kernel, p) => field(shape, amplitude, kernel, p);
        const phiA = sample(hat, ro), phiB = sample(hat, rayAt(ro, rd, 1));
        let baseline;
        for (const [thin, close] of [[0, 0], [1, 0], [0, 1], [0.4, 0.25]]) {
          const e = evaluator(code, sample, thin, close);
          const t = e.reflCross(ro, rd, ch, 0, 1, phiA, phiB);
          if (baseline === undefined) baseline = t;
          assert.equal(t, baseline, `${name}: thin/near-independent`);
          assert.deepEqual(e.reads, { linear: hit ? e.SURF_ROOT_STEPS : 0, cubic: 0, thin: 0, near: 0 });
          if (hit) {
            assert(t >= 0 && t <= 1, name);
            assert(Math.abs(sample(hat, rayAt(ro, rd, t)) - e.SURF_ISO) < 0.002, `${name}: trilinear root ${t}`);
          } else assert.equal(t, e.NO_HIT, name);
          // Negative control is the actual unchanged primary generated path
          // with the old reflection arguments (tm=tb, phiM=phiB).
          const old = e.surfCross(ro, rd, ch, true, 0, 1, 1, phiA, phiB, phiB);
          if (ch === 2 && (thin === 1 || close === 1) && ['thin slab', 'lone grain', 'oblique grain'].includes(name)) {
            assert(e.reads.cubic > 0, 'old path must exercise cubic sampling');
            assert(Math.abs(sample(hat, rayAt(ro, rd, old)) - e.SURF_ISO) > 0.02, `${name}: old path must fail root residual`);
            negativeControls++;
          }
          if (!hit) assert.equal(old, e.NO_HIT, `${name}: unchanged miss`);
          if (ch !== 2 || (thin === 0 && close === 0)) assert.equal(t, old, `${name}: unchanged noncubic path`);
          cases++;
        }
      }
      variants++;
    }
  }
}
console.log(`PASS ${variants} generated variants, ${cases} crossing/miss cases; no cubic/thin/near-detail root reads`);
console.log(`PASS ${negativeControls} old-path negative controls reject trilinear/cubic mismatch; primary cubic roots retained`);

if (process.argv.includes('--naga')) {
  const dir = mkdtempSync(join(tmpdir(), 'reflection-roots-'));
  let validated = 0;
  try {
    for (const check of WGSL_CHECK().filter((c) => c.name.startsWith('volume.'))) {
      for (const grid of [{ nx: 64, ny: 64, nz: 64 }, { nx: 160, ny: 96, nz: 160 }]) {
        const path = join(dir, `${check.name}-${grid.nx}.wgsl`);
        writeFileSync(path, check.code(grid));
        const run = spawnSync('naga', [path], { encoding: 'utf8', timeout: 120_000 });
        assert.ifError(run.error);
        assert.equal(run.status, 0, `${path}\n${run.stdout}\n${run.stderr}`);
        validated++;
      }
    }
    console.log(`PASS Naga: ${validated} complete volume shaders (all registered views/detail levels, straight/curved, cube/wide)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
