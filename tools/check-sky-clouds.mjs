// CPU check: the cloud deck in the sky pass (gfx/overlays.js skyWGSL,
// shaders/gfx/clouds.js cloudSkyGLSL), on every map, small and big.
// - With Naga installed (CI: deploy.yml), the sky shader validates.
// - The clouds are the very deck their shadows fall from: the deck's WGSL
//   (cloudDensity, cloudShadow and their CLOUD_ constants) is in the sky
//   shader verbatim, as it is in the lighting the shadows are cast in (both
//   backends), and every CLOUD_ constant the sky declares, it declares once,
//   with the lighting's value where the lighting has it.
// - The sky reads the deck at cloudShadow's own slices: the same height,
//   point and optical-depth expressions (clouds.js sliceY, slicePoint, sliceDepth).
// - No shadows, no clouds: one switch (FrameUniforms' clouds) gates both, the
//   sky's lookup answering "no cloud" (transmittance 1, no light) before it
//   reads anything; the pass shows the deck only through that lookup; and the
//   game turns the switch on over every map (app.js build, after the wires'
//   attach), never off.
//   node tools/check-sky-clouds.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skyWGSL, SkyParams, WGSL_CHECK, SKY_CLOUD_LAYOUT } from '../src/gfx/overlays.js';
import { cloudDeckGLSL, CLOUDS_OFF, sliceY, slicePoint, sliceDepth, CLOUD } from '../src/shaders/gfx/clouds.js';
import { lightingGLSL } from '../src/shaders/gfx/lighting.js';

const sky = skyWGSL();
const strip = (code) => code.replace(/\/\/[^\n]*/g, '');
// A function's body (between its braces), by brace matching.
function body(code, name) {
  const at = code.search(new RegExp(`\\bfn ${name}\\s*\\(`));
  assert.ok(at >= 0, `fn ${name} is declared`);
  let i = code.indexOf('{', at), depth = 0;
  const start = i + 1;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i);
  }
  throw new Error(`fn ${name}: unbalanced braces`);
}
const consts = (code) => {
  const out = new Map();
  for (const m of strip(code).matchAll(/\bconst (CLOUD_\w+)\s*:\s*(\w+)\s*=\s*([^;]+);/g)) {
    assert.ok(!out.has(m[1]), `${m[1]} declared once`);
    out.set(m[1], `${m[2]} = ${m[3].trim()}`);
  }
  return out;
};

// 1. the same deck, the same constants
const lighting = { box: lightingGLSL(), world: lightingGLSL({ backend: 'world' }) };
assert.ok(sky.includes(cloudDeckGLSL), 'the sky shader holds the deck (cloudDensity, cloudShadow, their constants) verbatim');
for (const [backend, code] of Object.entries(lighting)) assert.ok(code.includes(cloudDeckGLSL), `the ${backend} lighting holds the same deck`);
const skyConsts = consts(sky), lightConsts = consts(lighting.box);
let shared = 0;
for (const [name, decl] of skyConsts) {
  if (!lightConsts.has(name)) continue;
  assert.equal(decl, lightConsts.get(name), `${name}: the sky's value is the shadows'`);
  shared++;
}
for (const name of ['CLOUD_BASE', 'CLOUD_THICK', 'CLOUD_COVER', 'CLOUD_SIGMA', 'CLOUD_SHADOW_N', 'CLOUD_SHAPE_A_F', 'CLOUD_SHAPE_B_F'])
  assert.ok(skyConsts.has(name) && lightConsts.has(name), `${name} in both`);
assert.match(skyConsts.get('CLOUD_SKY_FADE'), /^f32 = /, 'the horizon fade is a named constant');
assert.ok(CLOUD.skyFadeM < CLOUD.maxDistM, 'the fade ends where the deck stops being drawn');

// 2. the sky reads the deck at the shadows' slices
const shadow = body(sky, 'cloudShadow'), view = body(sky, 'cloudSky');
assert.ok(shadow.includes(sliceY('k')) && view.includes(sliceY('k')), 'the view ray meets the slices at the shadows\' heights');
assert.ok(shadow.includes(slicePoint('w', 'FU.sun', 'y')), 'the shadows read the slices along the sun');
assert.ok(view.includes(slicePoint('p', 'FU.sun', 'y')), 'a cloud is lit through the slices above it along the sun, as its shadow is cast');
assert.ok(shadow.includes(sliceDepth('od', 'FU.sun.y')) && view.includes(sliceDepth('od', 'FU.sun.y')), 'one optical depth along the sun');
assert.ok(/\bfor \(var k = 0; k < CLOUD_SHADOW_N; k\+\+\)/.test(view), 'every one of the shadows\' slices');
assert.ok(/cloudDensity\(p, /.test(view), 'the view reads cloudDensity, the shadows\' field');

// 3. no shadows, no clouds
const first = (b) => strip(b).trim().split('\n')[0].trim();
assert.equal(first(shadow), `if (${CLOUDS_OFF}) { return 1.0; }`, 'cloudShadow: off, full sun');
assert.ok(first(view).startsWith(`if (${CLOUDS_OFF} || `) && first(view).endsWith('{ return vec4f(0.0, 0.0, 0.0, 1.0); }'),
  'cloudSky: off, no cloud (transmittance 1, no light), before anything is read');
const fs = strip(body(sky, 'fs'));
assert.ok(!/cloudDensity|cloudShadow/.test(fs), 'the pass reads the deck only through its lookup');
assert.match(fs, /cloudOver\(skyColor\(rd\) \+ disc \* FU\.sunCol \* SKY_SUN_DISC \* step\(0\.0, rd\.y\), skyEye\(\), rd\)/, 'the sky and the sun\'s disc lie behind the deck');
assert.match(strip(body(sky, 'cloudOver')), /cloudSky\(ro, rd\)/);
assert.match(strip(body(sky, 'seaColor')), /mirroredSky\(d\)/, 'the sea past the edge mirrors the deck');
assert.match(strip(body(sky, 'mirroredSky')), /cloudOver\(/);
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.ok(!/uClouds\.value\s*=\s*false/.test(app), 'app.js never turns the deck (and its shadows) off');
const build = app.slice(app.indexOf('for (const w of live) w.attach?.(ctx);'));
assert.ok(build.length < app.length, 'app.js build attaches the wires');
assert.match(build.slice(0, 2000), /gfxUniforms\.uClouds\.value = true;/, 'after the wires\' attach, the deck is on over every map, a box\'s as a world\'s');
const world = readFileSync(new URL('../src/wire/world.js', import.meta.url), 'utf8');
assert.ok(!/uClouds\.value\s*=\s*false/.test(world), 'wire/world.js never turns it off');

// 4. the pass binds what it declares; its params pack the origin
const entry = WGSL_CHECK.find((e) => e.name === 'boxSky');
assert.deepEqual(entry.layoutNames, ['FRAME', 'SKY_CLOUDS']);
assert.equal(entry.layouts()[1], SKY_CLOUD_LAYOUT);
assert.match(sky, /@group\(1\) @binding\(0\) var tMediaNoise: texture_3d<f32>;/);
assert.match(sky, /@group\(1\) @binding\(1\) var linearRepeat: sampler;/);
const packed = new Float32Array(SkyParams.pack({ sea: 0, origin: [1536, 2, 512, 0] }));
assert.ok(packed.includes(1536) && packed.includes(512), 'SkyParams packs the origin');

let naga = false;
try { execFileSync('naga', ['--version'], { stdio: 'pipe' }); naga = true; } catch { /* not installed: CI has it */ }
if (naga) {
  const dir = mkdtempSync(join(tmpdir(), 'sky-clouds-'));
  try {
    const path = join(dir, 'sky.wgsl');
    writeFileSync(path, sky);
    execFileSync('naga', [path], { stdio: 'pipe' });   // CPU parsing/validation only
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`sky clouds CPU: the shadows' deck verbatim (${shared} shared constants equal), their slices, one switch off for both, on over every map${naga ? '; Naga validated the sky shader' : ''}`);
