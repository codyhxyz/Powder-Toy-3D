// CPU interpretation/reference + real factories/Naga + fake native GPU.
// None of these are GPU execution, GPU==CPU, visual or performance evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WgslExec, WgslParser, VectorData, ScalarData } from 'wgsl_reflect/wgsl_reflect.module.js';
import { giSourceFrag, giGatherFrag, giKeyFrag, giSelectFrag, giArgsFrag, giSrcWGSL } from '../src/shaders/gi.js';
import { blurFrag } from '../src/shaders/passes.js';
import { WGSL_CHECK as GI_CHECK, worldGISource, worldGIGather, worldGIBirthWGSL } from '../src/shaders/worldGI.js';
import { WGSL_CHECK as GLOW_CHECK, worldGlow } from '../src/shaders/worldGlow.js';
import { createWorldGI } from '../src/gfx/worldGI.js';
import { createWorldGlow, worldGlowPlan } from '../src/gfx/worldGlow.js';
import { createWorldLightingHistory, selectWorldGI } from '../src/world/worldLightingHistory.js';
import { checkPipeline } from './check-sampler-budget.mjs';
import { lightingFixture } from './world-gi-glow-fixture.mjs';

class ShaderExec extends WgslExec {
  _dispatchWorkgroup(fn, id, context) {
    // Parser 1.6.0 represents @workgroup_size(64) as string "64";
    // dispatcher otherwise treats it as 6x4. Normalize AST metadata only.
    for (const a of fn.node.attributes ?? []) if (a.name === 'workgroup_size' && typeof a.value === 'string') a.value = [a.value];
    return super._dispatchWorkgroup(fn, id, context);
  }
  _callBuiltinFunction(node, context) {
    // 1.6.0 truncates its half builtin. Supply specified IEEE RNE semantics;
    // this checks production arithmetic/layout, NOT a GPU half implementation.
    if (node.name === 'pack2x16float') { const v = this.evalExpression(node.args[0], context).data; return new ScalarData(pair(v[0], v[1]), this.getTypeInfo('u32')); }
    return super._callBuiltinFunction(node, context);
  }
  // 1.6.0 generic vecNu constructors otherwise route uints through f32,
  // losing packed words even in a literal vec4u(0,0,0,0x1ff7fdff).
  _callConstructorVec(node, context) {
    const type = this.getTypeInfo(node.type), format = type.format?.name;
    if (!['u32', 'i32'].includes(format)) return super._callConstructorVec(node, context);
    const n = Number(type.name.at(-1)); let values = [];
    if (node.isVector) values = Array.from(node.vectorValue);
    else if (node.args) for (const arg of node.args) { const v = this.evalExpression(arg, context); values.push(...(v.data && v.data.length > 1 ? Array.from(v.data) : [v.value])); }
    if (!values.length) values = Array(n).fill(0); if (values.length === 1) values = Array(n).fill(values[0]);
    return new VectorData(format === 'u32' ? new Uint32Array(values.slice(0, n)) : new Int32Array(values.slice(0, n)), type).getSubData(this, node.postfix, context);
  }
  _makeCwiseData(values, type) {
    if (type.name.startsWith('vec') && ['u32', 'i32'].includes(type.format?.name)) return new VectorData(type.format.name === 'u32' ? new Uint32Array(values) : new Int32Array(values), type);
    return super._makeCwiseData(values, type);
  }
  // wgsl_reflect 1.6.0's void-call scope workaround, as other CPU gates use.
  _call(node, context) {
    const fn = context.getFunction(node.name); if (!fn) return super._call(node, context);
    const values = node.args.map(arg => this.evalExpression(arg, context)), scope = context.clone(); scope.currentFunctionName = node.name;
    fn.node.args.forEach((arg, i) => scope.createVariable(arg.name, values[i], arg)); this._execStatements(fn.node.body, scope);
  }
}
function naga(code, label) { const r = spawnSync('naga', ['--stdin-file-path', `${label}.wgsl`], { input: code, encoding: 'utf8' }); assert.equal(r.status, 0, `${label}: ${r.stdout}\n${r.stderr}`); }
const f = Math.fround, near = (a, b, e = 2e-6) => assert.ok(Math.abs(a - b) <= e * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function fnBody(code, name) { const at = code.indexOf(`fn ${name}(`); assert.ok(at >= 0); let end = code.indexOf('{', at), depth = 1; while (depth && ++end < code.length) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; } return code.slice(at, end + 1); }
// Independent IEEE binary16 conversion, round-to-nearest ties-to-even.
function half(v) {
  const b = new ArrayBuffer(4), d = new DataView(b); d.setFloat32(0, v, true); const x = d.getUint32(0, true), sign = x >>> 16 & 0x8000, e = (x >>> 23 & 255) - 127, m = x & 0x7fffff;
  if (e > 15) return sign | 0x7c00; if (e < -25) return sign;
  const sig = e < -14 ? m | 0x800000 : m, shift = e < -14 ? -e - 1 : 13;
  let q = sig >>> shift, tail = sig - q * 2 ** shift, midpoint = 2 ** (shift - 1);
  if (tail > midpoint || tail === midpoint && (q & 1)) q++;
  return sign | (e < -14 ? q : (e + 15) * 1024 + q);
}
const pair = (x, y) => (half(x) | half(y) << 16) >>> 0;

test('seven independent production GI/key/select/args and glow emissions remain byte-identical', () => {
  const g = { nx: 128, ny: 128, nz: 128 };
  // Independent clean production 2c5cb27d, including its new element constants, then the V2 merge:
  // V2 tip 7f9b2f1c's emissions, which the merge reproduces byte for byte. Then (Noita view):
  // only the shared appearance prelude's VARIANT_* labels changed.
  // Re-pinned 2026-10-17 (Smooth up close): the source and gather emissions changed only
  // in core.js's cubic helpers (fieldCubic, cubicFetch8, fieldCubicGrad, surfSample,
  // surfChannel, surfNormal, NORMAL_DIFF_SCALE for NORMAL_STEP_CUBIC), diffed function by
  // function against 40e1eb8c; the other five are unchanged.
  // Re-pinned 2026-10-20 (cold compile): source and gather changed only in lighting.js
  // causticGain's taps (CAUSTIC_TAPS, causticTaps), diffed against origin/main 7e5dc8a2; the other five unchanged.
  // Re-pinned 2026-10-20 (bounce light to the box's edge): only the gather changed, in GI_STEPS (12 → giSteps, 104
  // here), giAlong/giPast and the march's two lines that use them, diffed against origin/main 6a056d8d.
  const hashes = ['baec71a3f0f18792179ac5df380301ba03455be0fac9a0b650a66fcc11f84e2c', 'e42add413933739b32692df5c94478dfc6056fe1cd7a37d932c0624d704b6538', '1c1c1466266457d229a0f1ed0d59e5b054b3f6b3e4306dc23f695c656d4f63a8', '49c243e0fecd677ad02a487aace986634f1f43785e3626f74240ec2e2a40d28f', 'e57f139d63b575e2d8b5b7dee20033283e73efb40fc19e4f9b52f2645237e4e7', 'b7f2b431e07d44a6aeab03f55db2a30f28a3eff1643a6db5e6aaa0fe58e982c6', '8ebdc6e328ec9e086242a31194be0fd9e088fffe3f7cef3507552398c373796e'];
  [giSourceFrag(g), giGatherFrag(g), giKeyFrag(g), giSelectFrag(g), giArgsFrag(g), blurFrag(g), blurFrag(g, { last: true })].forEach((code, i) => assert.equal(createHash('sha256').update(code).digest('hex'), hashes[i]));
});
test('actual eight world GI/two glow modules validate Naga and default budgets', () => {
  let count = 0;
  for (const c of [...GI_CHECK(), ...GLOW_CHECK()]) {
    const code = c.code(), groups = c.layouts(); assert.deepEqual(checkPipeline({ code, groups, kind: 'compute' }).problems, [], c.name); naga(code, c.name); count++;
    if (c.name.startsWith('worldGI')) {
      assert.equal(groups.length, 4); assert.equal(groups.flat().filter(e => e.texture).length, 16);
      assert.ok(groups.flat().filter(e => e.buffer?.type.includes('storage')).length <= 8);
      assert.doesNotMatch(code, /fn farBeyond\(/); if (c.name.includes('gather')) assert.match(code, /GI_STEPS: i32 = (1064|1128)/);
    }
  }
  assert.equal(count, 10);
  console.log(`Naga: ${count} actual GI/glow modules passed; 16 sampled / <=8 storage / <=4 images`);
  const source = worldGISource({ nx: 3072, ny: 384, nz: 1024 });
  assert.ok(source.indexOf('head[6] == 0u') < source.indexOf('let pr = worldGIPreviousProbe'), 'liquid/media early exit before previous GI');
  assert.match(worldGIGather({ nx: 3072, ny: 384, nz: 1024 }), /worldGISourceStaged\(b\)/);
});
test('world gather is the original generated module minus unused texture mirrors only', () => {
  // Pre-deletion emissions, normalized ONLY by dropping output declarations/dst
  // and unwrapping textureStore(..., giBlend(...)) to the same giBlend calls.
  // Re-pinned at the V2 merge: only the shared marks and header layout lines changed
  // (MARK_OWNED, MARK_WORDS, Header format/capture, BRICK_LIQUID_INTERIOR).
  // Then 2026-10-17: worldAccess.js's request/page/address helpers took their
  // compile-cheap form (same results); nothing else in the module moved.
  // Later that day: worldPage/worldLightDescriptor read a page's channels from
  // its book entry (renderAtlas.js bookEntry) and the three WORLD_BOOK_* consts
  // arrived; again nothing else moved.
  // Then (Noita view): the shared appearance prelude gained VARIANT_* labels and
  // the surface artwork its Noita style; nothing else in the module moved.
  // Then Smooth up close's normals: surfSample, surfChannel and surfNormal (core.js),
  // fieldCubicGrad and worldAccess.js's worldBSplineD / worldFieldCubicGrad, and
  // NORMAL_DIFF_SCALE for NORMAL_STEP_CUBIC; diffed function by function against
  // 40e1eb8c, nothing else moved.
  // Then (2026-10-20) liquid.js's ripple roughness hand-off.
  // Then (2026-10-20, cold compile) lighting.js causticGain's five taps in a loop (causticTaps);
  // diffed against origin/main 7e5dc8a2, nothing else moved.
  // Then (2026-10-20, cold compile) worldAccess.js worldProbe's four bands share each tap's
  // lookup (unused here); diffed against origin/main 46ee20fe, nothing else moved.
  const hashes = ['c316e7a2d70583500a77a18daf3f912b7b8579a33d51726b2ccc04a6c049af2a', '623137bb024f1ec03c7981efccc4f1aebf003c975977a9e61b8dd3a681585984', '167cb6d7b69bd1e4b2d779e981b73f56bf1b1535e299e4c0e493ba1d938a46af', 'b4ed6a514293fda5a42a372a256209715a8a2fa65843175c1040dd198c388a15'];
  const gathers = GI_CHECK().filter(c => c.name.includes('gather'));
  gathers.forEach((c, i) => {
    const code = c.code(), groups = c.layouts();
    assert.equal(createHash('sha256').update(code).digest('hex'), hashes[i], c.name);
    assert.deepEqual(groups.slice(0, 3), GI_CHECK()[0].layouts().slice(0, 3));
    assert.deepEqual(groups[3].map(e => e.binding), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(groups.flat().filter(e => e.storageTexture).length, 0);
    assert.doesNotMatch(code, /worldGI[0-3]Out|textureStore\(/);
    assert.match(code, /worldGIHistory\[i\] = w;/);
    assert.match(code, /worldGIReport\(WGI.counts.x \+ probe\)/);
  });
});
test('final glow layout omits f32 dst and stores the identical final f32 expression directly', () => {
  const [float, final] = GLOW_CHECK(), code = final.code();
  assert.deepEqual(float.layouts()[0].map(e => e.binding), [0, 1, 2, 3]);
  assert.deepEqual(final.layouts()[0].map(e => e.binding), [0, 1, 3, 4]);
  assert.doesNotMatch(code, /\bdst\b|@binding\(2\)/);
  assert.equal(fnBody(code, 'glowLoad'), fnBody(float.code(), 'glowLoad'));
  assert.equal(fnBody(code, 'main'), fnBody(float.code(), 'main').replace('dst[i] = vec4f(s * LIGHT_BLUR_GAIN, 1.0);', 'textureStore(outGlow, vec2i(i32(i % 256u), i32(i / 256u)), 0, vec4f(s * LIGHT_BLUR_GAIN, 1.0));'));
});
test('executed production source packing preserves canonical air, half saturation, directions and mixed transport', () => {
  const cases = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [2, .25, .125, .5, .75, 1, -1, 0, 1], [1e6, -.01, 65504, 1, .07, .02, .2, -.4, .9], [.001, .0002, .5, .11, .35, .95, 0, 0, 0]];
  const code = `${giSrcWGSL}\n@group(0) @binding(0) var<storage,read> src:array<vec4f>; @group(0) @binding(1) var<storage,read_write> dst:array<vec4u>; @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) p:vec3u){let i=p.x;dst[i]=giSrcPack(src[3u*i].xyz,src[3u*i+1u].xyz,src[3u*i+2u].xyz);}`;
  naga(code, 'source.pack'); const input = new Float32Array(cases.flatMap(c => [c[0], c[1], c[2], 0, c[3], c[4], c[5], 0, c[6], c[7], c[8], 0])), output = new Uint32Array(cases.length * 4);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main', cases.length, { 0: { 0: input, 1: output } });
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i].map(f), q = c.slice(6).map(n => Math.floor(f(f(Math.max(-1, Math.min(1, n)) * 511) + 511) + .5));
    const clamp = n => Math.max(-65504, Math.min(65504, n));
    assert.deepEqual([...output.subarray(i * 4, i * 4 + 4)], [pair(clamp(c[0]), clamp(c[1])), pair(clamp(c[2]), c[3]), pair(c[4], c[5]), (q[0] | q[1] << 10 | q[2] << 20) >>> 0]);
  }
  assert.deepEqual([...output.subarray(0, 4)], [0, 0, 0, 0x1ff7fdff]);
});
test('executed original 32-ray world march reaches far sources beyond step12, true exterior only, sticky secondary unknown', () => {
  const production = worldGIGather({ nx: 512, ny: 512, nz: 512 });
  const start = production.indexOf('    let pc = vec3f(bc) + 0.5;'), end = production.indexOf('    var vis = 0.0;', start);
  assert.ok(start > 0 && end > start); const trace = production.slice(start, end);
  const constants = ['GI_RAYS', 'GI_STEPS', 'GI_NEAR_STEPS', 'GI_FAR_STRIDE', 'GI_T_MIN', 'GI_FACING', 'GOLDEN_ANGLE'].map(name => production.match(new RegExp(`const ${name}:[^;]+;`))?.[0]).join('\n');
  const code = `${giSrcWGSL}\n${constants}\nconst BS:i32=4; var<private> worldIncomplete:bool; var<private> testMode:u32;
fn worldGISourceStaged(b:vec3i)->vec4u {
  if(testMode==1u && b.x==30){worldIncomplete=true;}
  if(testMode!=2u && b.x==60){return giSrcPack(vec3f(2.0,1.0,0.5),vec3f(1.0),vec3f(0.0));}
  return giSrcPack(vec3f(0.0),vec3f(0.0),vec3f(0.0));
}
fn beyond(p:vec3f,d:vec3f)->vec3f{return vec3f(0.1,0.2,0.3);}
${fnBody(production, 'giDir')}
@group(0)@binding(0)var<storage,read_write> out:array<vec4f>;
@group(0)@binding(1)var<storage,read_write> status:array<u32>;
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id) gid:vec3u){
let ray=gid.x%32u;testMode=gid.x/32u;worldIncomplete=false;
let bc=vec3i(4,64,64);let bmax=vec3i(128);${trace}
out[gid.x]=vec4f(L,T);status[gid.x]=select(0u,1u,worldIncomplete);
}`;
  naga(code, 'world.gi.continuous'); const out = new Float32Array(96 * 4), flags = new Uint32Array(96);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main', 96, { 0: { 0: out, 1: flags } });
  let distantHits = 0, misses = 0;
  for (let mode = 0; mode < 3; mode++) for (let ray = 0; ray < 32; ray++) {
    const y = f(1 - f(f(2 * ray + 1) / 32)), radius = f(Math.sqrt(Math.max(f(1 - f(y * y)), 0))), angle = f(ray * f(2.399963229728653)), d = [f(radius * f(Math.cos(angle))), y, f(radius * f(Math.sin(angle)))];
    let q = [4.5, 64.5, 64.5], hit = false, missing = false, hitStep = -1;
    for (let k = 0; k < 392; k++) { q = q.map((v, a) => f(v + f(d[a] * (k < 6 ? 1 : 2)))); const b = q.map(Math.floor); if (b.some(v => v < 0 || v >= 128)) break; if (mode === 1 && b[0] === 30) missing = true; if (mode !== 2 && b[0] === 60) { hit = true; hitStep = k; break; } }
    const at = (mode * 32 + ray) * 4; for (let c = 0; c < 3; c++) near(out[at + c], hit ? [2, 1, .5][c] : [.1, .2, .3][c], 2e-5);
    assert.equal(flags[mode * 32 + ray], missing ? 1 : 0); if (missing) misses++; if (hit && hitStep > 12) distantHits++;
  }
  assert.ok(distantHits > 0 && misses > 0); console.log(`CPU production GI march: 96 rays, ${distantHits} real far-source hits, ${misses} sticky unknown rays`);
});
test('executed production Box march runs to the box edge, and its empty-brick leaps give the light of reading every brick', () => {
  // User's decision (2026-10-20): a small map's bounce rays reach the box's edge, as a big map's
  // reach the world's; they used to stop after 18 bricks (6 + 6 strides of 2) and take the sky.
  const B = [40, 16, 40], g = { nx: B[0] * 4, ny: B[1] * 4, nz: B[2] * 4 }, production = giGatherFrag(g);
  const start = production.indexOf('    let pc = vec3f(bc) + 0.5;'), end = production.indexOf('    var vis = 0.0;', start);
  assert.ok(start > 0 && end > start);
  // The far field's branch never runs (FrameUniforms.far is 0 everywhere since dc480f4f): the box's miss alone.
  const far = 'if (FU.far != 0u) { L += T * farBeyond(pc * f32(BS), q * f32(BS), d, &open); } else { L += T * beyond(pc * f32(BS), d); }';
  const trace = production.slice(start, end); assert.ok(trace.includes(far));
  const constants = ['GI_RAYS', 'GI_STEPS', 'GI_NEAR_STEPS', 'GI_FAR_STRIDE', 'GI_T_MIN', 'GI_FACING', 'GOLDEN_ANGLE', 'GI_STRIDE'].map(name => production.match(new RegExp(`const ${name}:[^;]+;`))?.[0]).join('\n');
  assert.match(constants, new RegExp(`GI_STEPS: i32 = ${B[0] + B[1] + B[2] + 8};`));
  // A floor, a lit far wall 36 bricks from the near probes, and scattered partly blocking bricks (half-exact values).
  const nb = B[0] * B[1] * B[2], id = (x, y, z) => x + B[0] * (y + B[1] * z), src = new Uint32Array(nb * 4), cells = new Map();
  const put = (x, y, z, rad, cov) => { const i = id(x, y, z); cells.set(i, { rad, cov }); src.set([pair(rad[0], rad[1]), pair(rad[2], cov[0]), pair(cov[1], cov[2]), 0x1ff7fdff], 4 * i); };
  for (let z = 0; z < B[2]; z++) for (let x = 0; x < B[0]; x++) put(x, 0, z, [.25, .25, .25], [1, 1, 1]);
  for (let z = 0; z < B[2]; z++) for (let y = 1; y < B[1]; y++) put(38, y, z, [3, 2, 1], [1, 1, 1]);
  let s = 11; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let k = 0; k < 60; k++) put(1 + Math.floor(rnd() * 36), 1 + Math.floor(rnd() * 14), Math.floor(rnd() * B[2]), [.5, .125, 2], [.25, .375, .625]);
  // brickDist as shaders/passes.js brickDistFrag leaves it: the Chebyshev distance to matter, capped at 8 (brickDistAt: less one)
  const dist = new Uint32Array(nb);
  for (let z = 0; z < B[2]; z++) for (let y = 0; y < B[1]; y++) for (let x = 0; x < B[0]; x++) {
    let d = 8;
    for (const i of cells.keys()) { const c = [i % B[0], Math.floor(i / B[0]) % B[1], Math.floor(i / (B[0] * B[1]))]; d = Math.min(d, Math.max(Math.abs(c[0] - x), Math.abs(c[1] - y), Math.abs(c[2] - z))); }
    dist[id(x, y, z)] = d;
  }
  const probes = [[2, 8, 20], [3, 2, 8], [2, 4, 30], [20, 12, 20], [36, 1, 1]];
  const code = `${giSrcWGSL}\n${constants}\nconst BS: i32 = 4; struct FrameU { far: u32 } const FU = FrameU(0u);
@group(0) @binding(0) var<storage, read> giSrc: array<vec4u>;
@group(0) @binding(1) var<storage, read> brickDist: array<u32>;
@group(0) @binding(2) var<storage, read> probes: array<vec4i>;
@group(0) @binding(3) var<storage, read_write> out: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> visits: array<u32>;
var<private> seen: u32;
fn brickId(b: vec3i) -> u32 { return u32(b.x + ${B[0]} * (b.y + ${B[1]} * b.z)); }
fn brickDistAt(b: vec3i) -> i32 { seen++; return i32(brickDist[brickId(b)]) - 1; }
fn beyond(p: vec3f, d: vec3f) -> vec3f { return select(vec3f(0.05, 0.1, 0.2), vec3f(0.3, 0.4, 0.6), d.y >= 0.0); }
${fnBody(production, 'giDir')}
${fnBody(production, 'giAlong')}
${fnBody(production, 'giPast')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
let ray = gid.x % 32u; let bc = probes[gid.x / 32u].xyz; let bmax = vec3i(${B.join(', ')}); seen = 0u;
${trace.replace(far, 'L += T * beyond(pc * f32(BS), d);')}
out[gid.x] = vec4f(L, T); visits[gid.x] = seen;
}`;
  naga(code, 'box.gi.leap');
  const n = probes.length * 32, run = (distances) => {
    const out = new Float32Array(n * 4), seen = new Uint32Array(n);
    new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main', n, { 0: { 0: src, 1: distances, 2: new Int32Array(probes.flatMap(p => [...p, 0])), 3: out, 4: seen } });
    return { out, seen: seen.reduce((a, v) => a + v, 0) };
  };
  // every brick read: brickDist as zero-filled (brickDistAt -1, "none stored", as before the derived passes ran)
  const leap = run(dist), every = run(new Uint32Array(nb));
  assert.deepEqual([...leap.out], [...every.out], 'the leaps change no ray\'s light or transmittance');
  assert.ok(leap.seen < every.seen, `leaps visit fewer bricks (${leap.seen} of ${every.seen})`);
  // and both against an independent JS march to the box's edge
  const tOf = k => (k < 6 ? k + 1 : 6 + (k + 1 - 6) * 2);
  let distantHits = 0;
  probes.forEach((bc, p) => { for (let ray = 0; ray < 32; ray++) {
    const y = f(1 - f(f(2 * ray + 1) / 32)), radius = f(Math.sqrt(Math.max(f(1 - f(y * y)), 0))), angle = f(ray * f(2.399963229728653)), d = [f(radius * f(Math.cos(angle))), y, f(radius * f(Math.sin(angle)))];
    const pc = bc.map(v => v + .5), d2 = d.map(v => v * v), L = [0, 0, 0]; let T = 1, wall = false;
    for (let k = 0; k < B[0] + B[1] + B[2] + 8; k++) {
      const t = tOf(k), b = pc.map((v, a) => Math.floor(f(v + f(d[a] * t))));
      if (b.some((v, a) => v < 0 || v >= B[a])) break;
      const c = cells.get(id(...b)); if (!c) continue;
      let a = c.cov[0] * d2[0] + c.cov[1] * d2[1] + c.cov[2] * d2[2]; if (a <= 0) continue;
      if (k >= 6) a = 1 - (1 - a) ** 2;
      for (let j = 0; j < 3; j++) L[j] += T * a * c.rad[j];
      if (b[0] === 38 && t > 18 && T > .5) wall = true;
      T *= 1 - a; if (T < .02) break;
    }
    if (T >= .02) for (let j = 0; j < 3; j++) L[j] += T * (d[1] >= 0 ? [.3, .4, .6] : [.05, .1, .2])[j];
    const at = (p * 32 + ray) * 4; for (let j = 0; j < 3; j++) near(leap.out[at + j], L[j], 2e-5); near(leap.out[at + 3], T, 2e-5);
    if (wall) distantHits++;
  } });
  assert.ok(distantHits > 0, 'some rays light their probe from the wall past the old 18-brick cap');
  console.log(`CPU production Box GI march: ${n} rays, leaps read ${leap.seen} of ${every.seen} bricks for identical light; ${distantHits} rays lit from 18+ bricks away`);
});
test('executed private source overlay resolves global keys independent of physical IDs and retains nonselected dependencies', () => {
  const production = worldGIGather({ nx: 3072, ny: 384, nz: 1024 });
  const code = `struct Params{counts:vec4u} const WGI=Params(vec4u(4u,0u,0u,0u));
@group(0)@binding(0)var<storage,read>worldGIJobs:array<vec4u>;
@group(0)@binding(1)var<storage,read>worldGISources:array<vec4u>;
@group(0)@binding(2)var<storage,read>query:array<vec4u>;
@group(0)@binding(3)var<storage,read_write>out:array<vec4u>;
fn worldBookIndex(b:vec3i)->u32{return u32(b.x);}
fn worldGISource(b:vec3i)->vec4u{return vec4u(0u,0u,0u,0x1ff7fdffu);}
${fnBody(production, 'worldGISourceStaged')}
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id) p:vec3u){out[p.x]=worldGISourceStaged(vec3i(i32(query[p.x].x),0,0));}`;
  naga(code, 'world.gi.overlay'); const indices = [2, 111, 100000, 18874367], q = [1, 2, 3, 111, 222, 100000, 18874367], jobs = new Uint32Array(indices.flatMap(n => [n, 0, 0, 0])), sources = new Uint32Array(indices.flatMap((n, i) => [i + 1, n, n + 1, 0x1ff7fdff])), output = new Uint32Array(q.length * 4);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main', q.length, { 0: { 0: jobs, 1: sources, 2: new Uint32Array(q.flatMap(n => [n, 0, 0, 0])), 3: output } });
  q.forEach((n, i) => { const slot = indices.indexOf(n); assert.deepEqual([...output.subarray(i * 4, i * 4 + 4)], slot < 0 ? [0, 0, 0, 0x1ff7fdff] : [...sources.subarray(slot * 4, slot * 4 + 4)]); });
});
test('executed original f32 blend writes exactly the packed halves used for four bands over many ticks', () => {
  const production = worldGIGather({ nx: 64, ny: 128, nz: 64 }), blend = fnBody(production, 'giBlend');
  const code = `${giSrcWGSL}\nstruct Params{counts:vec4u} const WGI=Params(vec4u(0u,1u,0u,0u)); @group(0) @binding(0) var<storage,read_write> worldGIHistory:array<vec2u>; @group(0) @binding(1) var<storage,read> incoming:array<vec4f>; @group(0) @binding(2) var<storage,read_write> result:array<vec4f>; ${blend}\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) p:vec3u){result[p.x]=giBlend(p.x,0u,incoming[p.x],0.4);}`;
  naga(code, 'gi.blend'); const history = new Uint32Array(8), input = new Float32Array([1.9, .03, .4, .8, -.4, -.8, .7, .2, .1, .3, -.5, .9, .7, .2, 1.8, -.1]), result = new Float32Array(16);
  for (let tick = 0; tick < 12; tick++) {
    // Fresh context: 1.6.0 retains old bindings across dispatch calls.
    new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main', 4, { 0: { 0: history, 1: input, 2: result } });
    for (let k = 0; k < 4; k++) assert.deepEqual([...history.subarray(k * 2, k * 2 + 2)], [pair(result[k * 4], result[k * 4 + 1]), pair(result[k * 4 + 2], result[k * 4 + 3])]);
  }
  assert.ok(result[0] > 1.89 && result[0] < 1.9);
});

test('executed production birth leaf uses original zero previous only for declared jobs and blend1 without resetting known bands',()=>{
  const source=worldGISource({nx:64,ny:128,nz:64});
  const previous=fnBody(source,'worldGIPreviousProbe');
  const code=`${worldGIBirthWGSL}
struct Probe { a:vec4f,b:vec4f,c:vec4f,d:vec4f }
const WORLD_GI:u32=16u;const tGI0:u32=0u;const tGI1:u32=1u;const tGI2:u32=2u;const tGI3:u32=3u;
var<private> loads:u32;var<private> missing:bool;
fn worldProbeLoad(band:u32,bc:vec3i,kind:u32)->vec4f { loads++;if(bc.x==2){missing=true;return vec4f(0.0);}return vec4f(8.0); }
@group(0)@binding(0)var<storage,read>worldGIJobs:array<vec4u>;
@group(0)@binding(1)var<storage,read_write>out:array<vec4f>;
${previous}
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id) p:vec3u){loads=0u;missing=false;let pr=worldGIPreviousProbe(p.x,vec3i(i32(p.x),0,0));out[p.x]=vec4f(pr.a.x,f32(loads),worldGIJobBlend(0.4,worldGIJobs[p.x].y),select(0.0,16.0,missing));}`;
  naga(code,'birth.previous');const out=new Float32Array(12);
  new ShaderExec(new WgslParser().parse(code)).dispatchWorkgroups('main',3,{0:{0:new Uint32Array([0,0,0,0,1,2,0,0,2,0,0,0]),1:out}});
  assert.deepEqual([...out],[8,4,f(.4),0,0,0,1,0,0,4,f(.4),16]);
  const production=worldGIGather({nx:64,ny:128,nz:64}),blend=fnBody(production,'giBlend');
  const blending=`${giSrcWGSL}\n${worldGIBirthWGSL}\nstruct Params{counts:vec4u}const WGI=Params(vec4u(0u,2u,0u,0u));
@group(0)@binding(0)var<storage,read_write>worldGIHistory:array<vec2u>;@group(0)@binding(1)var<storage,read_write>out:array<vec4f>;
${blend}
@compute@workgroup_size(1)fn main(@builtin(global_invocation_id)p:vec3u){out[p.x]=giBlend(0u,p.x,vec4f(1.0),worldGIJobBlend(0.4,select(0u,2u,p.x==1u)));}`;
  naga(blending,'birth.blend');const history=new Uint32Array(16).fill(pair(8,8)),result=new Float32Array(8);
  new ShaderExec(new WgslParser().parse(blending)).dispatchWorkgroups('main',2,{0:{0:history,1:result}});
  assert.deepEqual([...result.slice(4)],[1,1,1,1]);assert.ok(result[0]>5.19&&result[0]<5.21);
});

const weights = [.10, .22, .36, .22, .10].map(f);
function blurReference(values, dims, axis) {
  const out = new Float32Array(values.length);
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const p = [x, y, z], at = (x + dims[0] * (y + dims[1] * z)) * 4;
    for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 5; k++) { const q = [...p]; q[axis] += k - 2; if (q[axis] < 0 || q[axis] >= dims[axis]) continue; s = f(s + f(values[(q[0] + dims[0] * (q[1] + dims[1] * q[2])) * 4 + c] * weights[k])); } out[at + c] = f(s * f(1.15)); } out[at + 3] = 1;
  }
  return out;
}
function packGlowParams(pass, dims, i) { const raw = new ArrayBuffer(96), s = new Int32Array(raw), u = new Uint32Array(raw); s.set(pass.input.min); u.set([...pass.input.size, pass.input.size.reduce((a, n) => a * n, 1)], 4); s.set(pass.output.min, 8); u.set([...pass.output.size, pass.output.size.reduce((a, n) => a * n, 1)], 12); s.set(dims, 16); u[19] = pass.axis; u[20] = i; return u; }
test('executed actual six glow passes equal contiguous f32/half output across 32core/4brick boundaries and world exterior', () => {
  const dims = [16, 16, 16], all = new Float32Array(16 ** 3 * 4);
  for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const at = (x + 16 * (y + 16 * z)) * 4; all.set([f((x * 7 + y * 11 + z * 13) % 19 / 17), x === 7 ? 13 : .01, y === 0 ? 3 : .2, 0], at); }
  let reference = all; for (const axis of [0, 1, 2, 0, 1, 2]) reference = blurReference(reference, dims, axis);
  // Execute the actual final kernel too; capture its textureStore argument.
  // Independent half() below models conversion, not GPU texture rounding.
  for (const core of [[0, 0, 0], [1, 1, 1]]) {
    const plan = worldGlowPlan([64, 64, 64], core), n = plan.input.size.reduce((a, n) => a * n, 1), feedback = new Uint32Array(6); let src = new Float32Array(n * 4);
    for (let z = 0; z < plan.input.size[2]; z++) for (let y = 0; y < plan.input.size[1]; y++) for (let x = 0; x < plan.input.size[0]; x++) { const p = [x, y, z].map((v, k) => v + plan.input.min[k]), i = x + plan.input.size[0] * (y + plan.input.size[1] * z); src.set(all.subarray((p[0] + 16 * (p[1] + 16 * p[2])) * 4, (p[0] + 16 * (p[1] + 16 * p[2])) * 4 + 4), i * 4); }
    for (let i = 0; i < 6; i++) {
      const pass = plan.passes[i], p = packGlowParams(pass, dims, i), dst = new Float32Array(p[15] * 4), last = i === 5;
      const exec = new ShaderExec(new WgslParser().parse(worldGlow({ last })));
      if (last) {
        const call = exec._call;
        exec._call = function(node, context) {
          if (node.name !== 'textureStore') return call.call(this, node, context);
          const q = this.evalExpression(node.args[1], context).data;
          assert.equal(this.evalExpression(node.args[2], context).value, 0);
          dst.set(this.evalExpression(node.args[3], context).data, (q[0] + 256 * q[1]) * 4);
        };
      }
      exec.dispatchWorkgroups('main', Math.ceil(p[15] / 64), { 0: { 0: p, 1: src, ...(!last ? { 2: dst } : {}), 3: feedback } }); src = dst;
    }
    assert.deepEqual([...feedback], [1, 1, 1, 1, 1, 1]);
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = [x, y, z].map((v, k) => v + plan.output.min[k]), a = (x + 8 * (y + 8 * z)) * 4, b = (p[0] + 16 * (p[1] + 16 * p[2])) * 4; for (let c = 0; c < 4; c++) { near(src[a + c], reference[b + c], 2e-7); assert.equal(half(src[a + c]), half(reference[b + c])); } }
  }
});

test('native world GI global source barrier, sorted/reversed jobs, final submission AND completion pins, exact Atlas transport', async () => {
  const f = lightingFixture(), gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: f.snapshotProvider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
  f.device.createTexture = () => { throw new Error('GI must not allocate private texture mirrors'); };
  const c = await gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[2, 1, 1], [1, 1, 1]], gatherBricks: [[1, 1, 1], [2, 1, 1]] });
  assert.equal(f.state.pins, 1); const done = c.record(); assert.equal(f.state.pins, 1); await Promise.resolve(); assert.equal(f.state.pins, 1, 'early readback is not a submission fence');
  assert.deepEqual(f.events.filter(e => e.startsWith('dispatch:world GI ')), ['dispatch:world GI source', 'dispatch:world GI gather']);
  assert.ok(f.events.indexOf('previous-history-record') < f.events.indexOf('dispatch:world GI source'));
  assert.ok(f.events.indexOf('readback-boundary') > f.events.indexOf('dispatch:world GI gather'));
  f.tickets[0].submitted.resolve(); await Promise.resolve(); assert.equal(f.state.pins, 1); f.tickets[0].done.resolve(); assert.equal((await done).status, 'published'); assert.equal(f.state.pins, 0);
  const out = gi.snapshot(); assert.deepEqual(out.sources, [...out.sources].sort((a, b) => a - b)); const held = out.retain();
  const { source, history } = out.bindings();
  assert.deepEqual(Object.keys(out.bindings()).sort(), ['history', 'probeCount', 'source', 'token']);
  const cached = await gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1], [2, 1, 1]], gatherBricks: [[2, 1, 1], [1, 1, 1]] }); assert.equal(cached.status, 'cached'); cached.snapshot.release();
  const calls = [], atlas = { recordLightWrite(job, kind, { record }) { calls.push(kind); record({ copyBufferToTexture() {} }, { destinations: Array.from({ length: kind === 'gi' ? 4 : 1 }, () => ({})) }); f.device.queue.submit([]); } };
  const job = { kind: 'light', brick: [1, 1, 1], epoch: 1, sourceRevision: 1, sourceTick: 0, giTick: 0, dependencies: { source: { id: 7, version: 1 }, gi: { id: 7, version: 1 } } };
  await out.writeAtlas(atlas, job, 'source'); await out.writeAtlas(atlas, job, 'gi'); assert.deepEqual(calls, ['source', 'gi']);
  await assert.rejects(out.writeAtlas(atlas, { ...job, sourceRevision: 99 }, 'gi'), /provenance/);
  gi.dispose(); assert.equal(held.bindings().history.dead, false); assert.equal(source.dead, false); out.release(); held.release();
  assert.equal(source.dead, true); assert.equal(history.dead, true); assert.equal(f.state.pins, 0);
});

test('newer physics does not cancel a queued coherent owned cut; same-tick retry never seeds from its own output', async () => {
  const f = lightingFixture(), gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: f.snapshotProvider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
  const args = { lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]], gatherBricks: [[1, 1, 1]] };
  const c = await gi.prepare(args), done = c.record();
  // Source latest is separate from the owned admitted cut (state.current).
  f.state.latestPhysicsRevision = 27; await f.complete(); assert.equal((await done).status, 'published');
  const old = gi.snapshot(); assert.equal(old.token.sourceRevision, 1);
  // An uncommitted retry from a newer admitted immutable cut still reads tick-1,
  // NOT the first candidate's tick0 output. No authoritative history advances.
  f.state.current = 2; const retry = await gi.prepare(args), q = retry.record(); await f.complete(); assert.equal((await q).status, 'published');
  const next = gi.snapshot(); assert.equal(next.token.previousToken, old.token.previousToken); assert.equal(next.token.sourceRevision, 2); next.release(); old.release(); gi.dispose();
});
test('dispose during asynchronous cut acquisition releases its eventual pin without binding mutable input', async () => {
  const f = lightingFixture(); let resume; const gate = new Promise(r => { resume = r; });
  const provider = { ...f.snapshotProvider, async acquire(args) { await gate; return f.snapshotProvider.acquire(args); } };
  const gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: provider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
  const prep = gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]] }); gi.dispose(); resume(); await assert.rejects(prep, /disposed/); assert.equal(f.state.pins, 0); assert.equal(f.events.filter(e => e.startsWith('dispatch:')).length, 0);
});
test('GI incomplete/secondary misses, stale epoch, encode/readback/discard failures preserve old output and same-plan retry', async () => {
  for (const failure of ['missing', 'encodeFailure', 'readFailure', 'epoch', 'discard', 'historyFailure']) {
    const f = lightingFixture(), gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: f.snapshotProvider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
    const args = { lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]], gatherBricks: [[1, 1, 1]] };
    const first = await gi.prepare(args), d = first.record(); await f.complete(); assert.equal((await d).status, 'published'); const old = gi.snapshot();
    f.state.previousTick = 0; const nextArgs = { ...args, lightingTick: 1, reset: false };
    if (failure in f.state && failure !== 'epoch') f.state[failure] = true;
    const next = await gi.prepare(nextArgs), q = next.record(); assert.equal(f.state.pins, 1);
    if (failure === 'epoch') f.state.epoch++;
    if (failure === 'discard') {
      const t=f.tickets.at(-1);t.submitted.reject(new Error('encoders discarded'));
      await Promise.resolve();await Promise.resolve();
      assert.equal(f.state.pins,1);t.done.resolve();
    } else await f.complete();
    const result = await q; assert.equal(result.status, failure === 'missing' ? 'incomplete' : failure === 'epoch' ? 'stale' : 'failed');
    const retained = gi.snapshot(); assert.equal(retained.token, old.token); retained.release(); assert.equal(f.state.pins, 0);
    if (failure === 'epoch') f.state.epoch--; if (failure in f.state && failure !== 'epoch') f.state[failure] = false;
    const retry = await gi.prepare(nextArgs), r = retry.record(); await f.complete(); assert.equal((await r).status, 'published'); old.release(); gi.dispose();
  }
});
test('queued reset/dispose retains orphan commands and source pins until final completion, never assumes Frame rollback', async () => {
  const f = lightingFixture(), gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: f.snapshotProvider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
  const c = await gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]], gatherBricks: [[1, 1, 1]] }), done = c.record(); gi.reset(); gi.dispose(); assert.equal(f.state.pins, 1); await f.complete(); assert.equal((await done).status, 'stale'); assert.equal(f.state.pins, 0); assert.equal(f.textures.length, 0);
});
test('cold/unknown history, wrong clocks and public candidate aliases reject before publication', async () => {
  const f = lightingFixture(), gi = createWorldGI(f.gpu, { g: f.g, snapshotProvider: f.snapshotProvider, readerBindingProvider: f.readerBindingProvider, feedbackProvider: f.feedbackProvider });
  f.state.previousTick = 4; await assert.rejects(gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]] }), /previous history/); assert.equal(f.state.pins, 0);
  f.state.previousTick = -1; f.state.resetSeed = false; await assert.rejects(gi.prepare({ lightingTick: 0, reset: true, configVersion: 1, sourceBricks: [[1, 1, 1]] }), /reset seed/); gi.dispose();
});
test('native glow six-phase ordering, complete emission halo, cached handles, stale/unknown outputs and transport lifetime', async () => {
  const f = lightingFixture(), glow = createWorldGlow(f.gpu, { g: f.g, emissionProvider: f.emissionProvider, submissionProvider: f.submissionProvider }), args = { core: [0, 1, 0], lightingTick: 0, configVersion: 1 };
  const c = await glow.prepare(args), done = c.record(); assert.equal(f.state.pins, 1); assert.equal(f.events.filter(e => e.startsWith('dispatch:world glow ')).length, 6); await f.complete(); assert.equal((await done).status, 'published');
  const out = glow.snapshot(), cached = await glow.prepare(args); assert.equal(cached.status, 'cached'); cached.snapshot.release();
  let texture;
  await out.writeAtlas({ recordLightWrite(_job, _kind, { record }) { record({ copyTextureToTexture(source) { texture = source.texture; } }, { destinations: [{}] }); } },
    { kind: 'light', brick: [0, 8, 0], epoch: 1, sourceRevision: 1, glowTick: 0, dependencies: { glow: { id: 7, version: 1 } } });
  glow.reset(); assert.equal(texture.dead, false); out.release(); assert.equal(texture.dead, true);
  f.state.missing = true; const missing = await glow.prepare({ ...args, lightingTick: 1 }), q = missing.record(); await f.complete(); assert.equal((await q).status, 'incomplete'); assert.equal(glow.snapshot(), null); glow.dispose();
});
test('Glow Atlas copies use the retained final texture at exact XYZ-linear texels and fence its lifetime', async () => {
  const f = lightingFixture(), glow = createWorldGlow(f.gpu, { g: f.g, emissionProvider: f.emissionProvider, submissionProvider: f.submissionProvider });
  let finalView;
  const bind = f.device.createBindGroup;
  f.device.createBindGroup = desc => { const output = desc.entries.find(e => e.binding === 4); if (output) finalView = output.resource; return bind(desc); };
  const c = await glow.prepare({ core: [0, 1, 0], lightingTick: 0, configVersion: 1 }), completed = c.record();
  const intermediates = f.buffers.filter(b => b.label.startsWith('world glow f32 pass'));
  assert.deepEqual(intermediates.map(b => b.label), Array.from({ length: 5 }, (_, i) => 'world glow f32 pass' + i));
  await f.complete(); assert.equal((await completed).status, 'published');
  const out = glow.snapshot(); let texture;
  assert.equal('bindings' in out, false); assert.ok(intermediates.every(b => b.dead));
  let releaseFence; f.device.queue.onSubmittedWorkDone = () => new Promise(resolve => { releaseFence = resolve; });
  const destination = {}, calls = [];
  const atlas = { recordLightWrite(job, kind, { record }) {
    assert.equal(kind, 'glow'); record({ copyTextureToTexture(...args) { texture = args[0].texture; assert.equal(texture, finalView.texture); calls.push(args); } }, { destinations: [destination] });
    f.device.queue.submit([]);
  } };
  const job = { kind: 'light', brick: [1, 8, 4], epoch: 1, sourceRevision: 1, glowTick: 0, dependencies: { glow: { id: 7, version: 1 } } };
  for (const bad of [{ kind: 'cell' }, { epoch: 2 }, { sourceRevision: 2 }, { glowTick: 1 }, { dependencies: { glow: { id: 8, version: 1 } } }, { dependencies: { glow: { id: 7, version: 2 } } }]) {
    await assert.rejects(out.writeAtlas(atlas, { ...job, ...bad }), /provenance/);
  }
  assert.equal(calls.length, 0);
  const done = out.writeAtlas(atlas, job);
  assert.deepEqual(calls, [[{ texture, origin: [1, 1, 0] }, destination, [1, 1, 1]]]);
  glow.reset(); out.release(); assert.equal(texture.dead, false);
  releaseFence(); await done; assert.equal(texture.dead, true); glow.dispose();
});
test('GI/glow caches require complete cut provenance, including new epochs and dependencies',async()=>{
  for(const kind of ['gi','glow'])for(const changed of ['epoch','sourceRevision','fieldTick','dependencySetID','dependencyVersion']){
    const f=lightingFixture(),provider=kind==='gi'?f.snapshotProvider:f.emissionProvider;
    const original=provider.acquire;let vary=false;
    provider.acquire=async args=>{
      const p=await original(args);if(!vary)return p;
      return {...p,
        ...(changed==='sourceRevision'?{source:{...p.source,sourceRevision:2},field:{...p.field,sourceRevision:2}}:{}),
        ...(changed==='fieldTick'?{field:{...p.field,logicalFieldTick:18}}:{}),
        ...(changed==='dependencySetID'?{dependencySetID:8}:{}),
        ...(changed==='dependencyVersion'?{dependencyVersion:2}:{})};
    };
    const owner=kind==='gi'
      ?createWorldGI(f.gpu,{g:f.g,snapshotProvider:provider,readerBindingProvider:f.readerBindingProvider,feedbackProvider:f.feedbackProvider})
      :createWorldGlow(f.gpu,{g:f.g,emissionProvider:provider,submissionProvider:f.submissionProvider});
    const args=kind==='gi'?{lightingTick:0,reset:true,configVersion:1,sourceBricks:[[1,1,1]],gatherBricks:[[1,1,1]]}:{lightingTick:0,configVersion:1,core:[0,0,0]};
    const first=await owner.prepare(args),done=first.record();await f.complete();assert.equal((await done).status,'published');
    vary=true;if(changed==='epoch')f.state.epoch++;
    const next=await owner.prepare(args);
    assert.equal(next.status,'prepared',`${kind}/${changed} must not return the old handle`);
    next.cancel();assert.equal(f.state.pins,0);owner.dispose();
  }
});
test('a new epoch may restart lighting ticks without stale-cache tick regression',async()=>{
  for(const kind of ['gi','glow']){
    const f=lightingFixture();f.state.previousTick=0;
    const owner=kind==='gi'
      ?createWorldGI(f.gpu,{g:f.g,snapshotProvider:f.snapshotProvider,readerBindingProvider:f.readerBindingProvider,feedbackProvider:f.feedbackProvider})
      :createWorldGlow(f.gpu,{g:f.g,emissionProvider:f.emissionProvider,submissionProvider:f.submissionProvider});
    const args=kind==='gi'?{lightingTick:1,reset:false,configVersion:1,sourceBricks:[[1,1,1]]}:{lightingTick:1,configVersion:1,core:[0,0,0]};
    const c=await owner.prepare(args),done=c.record();await f.complete();assert.equal((await done).status,'published');
    f.state.epoch++;f.state.previousTick=-1;
    const next=await owner.prepare({...args,lightingTick:0,...(kind==='gi'?{reset:true}:{})});
    assert.equal(next.status,'prepared');next.cancel();owner.dispose();
  }
});
test('glow cache keys use the owned core plan, not caller arrays after acquire',async()=>{
  const f=lightingFixture(),acquire=f.emissionProvider.acquire;let resume;
  const gate=new Promise(resolve=>{resume=resolve;});
  f.emissionProvider.acquire=async args=>{const p=await acquire(args);await gate;return p;};
  const glow=createWorldGlow(f.gpu,{g:f.g,emissionProvider:f.emissionProvider,submissionProvider:f.submissionProvider});
  const core=[0,0,0],preparing=glow.prepare({core,lightingTick:0,configVersion:1});core[0]=1;resume();
  const c=await preparing,done=c.record();await f.complete();assert.equal((await done).status,'published');
  const next=await glow.prepare({core:[1,0,0],lightingTick:0,configVersion:1});
  assert.equal(next.status,'prepared');assert.deepEqual(next.plan.core,[1,0,0]);next.cancel();glow.dispose();
});
test('discarded final lighting tickets fence earlier submits even without a readback result',async()=>{
  for(const kind of ['gi','glow']){
    const f=lightingFixture(),provider=kind==='gi'?f.feedbackProvider:f.submissionProvider,reserve=provider.reserve;
    provider.reserve=()=>{const t=reserve();return {...t,record(...args){t.record(...args);return new Promise(()=>{});}};};
    const owner=kind==='gi'
      ?createWorldGI(f.gpu,{g:f.g,snapshotProvider:f.snapshotProvider,readerBindingProvider:f.readerBindingProvider,feedbackProvider:provider})
      :createWorldGlow(f.gpu,{g:f.g,emissionProvider:f.emissionProvider,submissionProvider:provider});
    const c=await owner.prepare(kind==='gi'?{lightingTick:0,reset:true,configVersion:1,sourceBricks:[[1,1,1]],gatherBricks:[[1,1,1]]}:{lightingTick:0,configVersion:1,core:[0,0,0]});
    const done=c.record(),t=f.tickets.at(-1);let settled=false;done.then(()=>{settled=true;});
    t.submitted.reject(new Error('final encoder discarded after an earlier prefix'));
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.ok(f.events.includes('completion-boundary'));assert.equal(settled,false);assert.equal(f.state.pins,1);
    const output=f.buffers.find(b=>b.label===(kind==='gi'?'private world GI sources':'world glow f32 pass0'));
    assert.equal(output.dead,false);t.done.resolve();
    assert.equal((await done).status,'failed');assert.equal(f.state.pins,0);assert.equal(output.dead,true);owner.dispose();
  }
});
test('original world-fixed checkerboard/background/source phases and lamp/change-driven scheduler never use origin/allocation', () => {
  const records = Array.from({ length: 8 }, (_, i) => ({ brick: [i & 1, i >> 1 & 1, i >> 2], matter: true, near: false, age: 50 }));
  for (let tick = 0; tick < 8; tick++) {
    const s = selectWorldGI({ records, lightingTick: tick }); assert.equal(s.gatherBricks.length, 1); assert.equal(s.sourceBricks.length, 2); assert.equal(s.gatherBricks[0].background, true);
    const near = selectWorldGI({ records: records.map(r => ({ ...r, near: true })), lightingTick: tick }); assert.equal(near.sourceBricks.length, 8); assert.equal(near.gatherBricks.length, 4);
  }
  const lit = selectWorldGI({ records, lightingTick: 0, lampSpheres: [{ pos: [0, 0, 0], radius: 50 }] }); assert.equal(lit.sourceBricks.length, 8); assert.equal(lit.gatherBricks.length, 4);
  assert.throws(() => selectWorldGI({ records: [{ brick: [0, 0, 0] }], lightingTick: 0 }), /complete world GI/);
});
test('world histories retain packed native backing across ticks/transfers and reject missing/reset-on-arrival/duplicate commit', async () => {
  const h = createWorldLightingHistory({ worldSize: [64, 128, 64], epoch: 1 }), records = [{ brick: [1, 1, 1], matter: true, near: true, age: 0 }];
  let refs = 0; const bits = { history: { label: 'known packed bands' } }, owned = { token: { epoch: 1, lightingTick: 0 }, sources: [529], probes: [529], retain() { refs++; return { ...owned, release() { refs--; }, bindings() { return bits; } }; } };
  const p = h.begin({ lightingTick: 0, globalKey: [1], records, mode: 2 }); p.commit(owned); assert.equal(h.lightingTick, 0); assert.equal(refs, 2); assert.throws(() => p.commit(owned), /duplicate/);
  const snapshot = h.capture({ lightingTick: 0, indices: [529] }); assert.equal(refs, 3); assert.throws(() => h.capture({ lightingTick: 0, indices: [530] }), /unknown world GI history/);
  const copies = []; snapshot.recordHistory({ direct() { return { copyBufferToBuffer(...a) { copies.push(a); } }; } }, { indices: [529], destination: {}, format: 'band-major-4x-vec2u' }); assert.equal(copies.length, 4); assert.deepEqual(copies.map(c => c[1]), [0, 8, 16, 24]);
  assert.throws(() => h.begin({ lightingTick: 1, globalKey: [1], records, mode: 2 }), /never on arrival/);
  const q = h.begin({ lightingTick: 1, globalKey: [1], records }); q.abort(); assert.equal(h.lightingTick, 0); h.dispose(); assert.equal(refs, 1); snapshot.release(); assert.equal(refs, 0);
});
