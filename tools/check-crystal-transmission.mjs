// Execute the production WGSL on the CPU: no browser or GPU slot required.
import assert from 'node:assert/strict';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { E, ELEMENTS, K, R } from '../src/elements.js';
import { crystalGLSL } from '../src/shaders/gfx/crystal.js';
import { noiseGLSL } from '../src/shaders/gfx/noise.js';
import { glslMod } from '../src/gpu/wgsl.js';
import { volumeFrag, shadowFrag } from '../src/shaders/render.js';

// wgsl_reflect 1.6.0's void calls bind arguments with setVariable, overwriting
// same-named caller variables. Use function-local bindings, as its value calls
// do. Remove this adapter when the interpreter fixes lexical argument scope.
class ShaderExec extends WgslExec {
  _call(node, context) {
    const fn = context.getFunction(node.name);
    if (!fn) return super._call(node, context);
    const values = node.args.map(arg => this.evalExpression(arg, context));
    const scope = context.clone();
    scope.currentFunctionName = node.name;
    fn.node.args.forEach((arg, i) => scope.createVariable(arg.name, values[i], arg));
    this._execStatements(fn.node.body, scope);
  }
}

const crystal = ELEMENTS[E.CRYSTAL];
assert.equal(crystal.kind, K.SOLID, 'optics must not change collision or physics');
assert.equal(crystal.render, R.GLASS);
assert.equal(ELEMENTS[E.CRYSTAL_DUST].render, R.OPAQUE);
assert(crystal.sigma[1] > crystal.sigma[0] && crystal.sigma[1] > crystal.sigma[2], 'transmission stays violet');

// Minimal state fixture; geometry, refraction, attenuation, noise, and the
// whole-run reconstruction below are the production functions, not JS ports.
const fixture = /* wgsl */ `
const E_CRYSTAL = 1;
const CH_LIQUID = 0;
const R_GLASS = 3;
fn outside(c: vec3i) -> bool { return any(c < vec3i(0)) || any(c >= vec3i(32)); }
fn worldPos(p: vec3f) -> vec3f { return p; }
fn eid(a: vec4f) -> i32 { return i32(a.x); }
fn isGasLike(id: i32) -> bool { return id == 0; }
fn SURFCH(id: i32) -> i32 { return -1; }
fn RCLASS(id: i32) -> i32 { return select(1, R_GLASS, id == E_CRYSTAL); }
fn fetchA(c: vec3i) -> vec4f {
  if (c.y == 2) { return vec4f(2.0, 20.0, 0.0, 0.0); }
  if (c.x == 16 && c.z == 16 && c.y >= 3 && c.y <= 7) { return vec4f(1.0, 20.0, 0.0, 0.0); }
  return vec4f(0.0);
}
${glslMod}
${noiseGLSL}
${crystalGLSL}
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  var s: Shard;
  s.o = vec3f(0.0);
  s.d = vec3f(0.0, 1.0, 0.0); s.a = s.d;
  s.u = vec3f(1.0, 0.0, 0.0); s.w = vec3f(0.0, 0.0, 1.0);
  s.r = 0.35; s.len = 3.0; s.span = 3.0; s.apex = vec3f(0.0, 3.0, 0.0);
  s.caps = CRYS_END_FRONT; s.ends = 0;
  var hp = vec3f(-s.r, 1.0, 0.0);
  var d = vec3f(1.0, 0.0, 0.0);
  var n = -d;
  var inside = false; var bend = true; var limit = 100.0;
  var sigma = vec3f(${crystal.sigma.map(x => x.toFixed(8)).join(', ')});
  switch id.x {
    case 1u: { d = normalize(vec3f(1.0, 0.3, 0.8)); }
    case 2u: { limit = 0.15; }
    case 3u: { hp.x = 0.0; inside = true; }
    case 4u: { d = normalize(vec3f(1.0, 0.3, 0.8)); bend = false; }
    case 5u: { sigma = vec3f(0.0); }
    case 6u: { hp = vec3f(0.0, 1.0, 0.0); d = s.a; inside = true; }
    default: {}
  }
  let path = crystalPath(s, hp, d, n, 1.434, sigma, inside, bend, limit);
  let j = id.x * 4u;
  result[j] = vec4f(path.through, path.frontF);
  result[j + 1u] = vec4f(path.p, path.distance);
  var clipped = 0.0;
  if (path.clipped != 0u) { clipped = 1.0; }
  result[j + 2u] = vec4f(path.d, clipped);
  result[j + 3u] = vec4f(path.glow, 0.0);
  if (id.x == 0u) {
    var nx: vec3f;
    let exit = shardBodyExit(s, vec3f(0.0, 1.0, 0.0), s.a, &nx);
    result[28] = vec4f(nx, exit);
    let root = shardBodyExit(s, vec3f(0.0, 1.0, 0.0), -s.a, &nx);
    result[29] = vec4f(nx, root);
  }
}
`;
const output = new Float32Array(30 * 4);
const exec = new ShaderExec(new WgslParser().parse(fixture));
exec.dispatchWorkgroups('main', 7, { 0: { 0: output } });
const record = (i, field) => Array.from(output.slice(i * 16 + field * 4, i * 16 + field * 4 + 4));
const near = (a, b, eps = 2e-5) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const f0 = ((1.434 - 1) / (1.434 + 1)) ** 2;
assert([...output].every(Number.isFinite), 'no NaNs at a facet, root, or internal reflection');
for (let c = 0; c < 3; c++) {
  near(record(0, 0)[c], (1 - f0) ** 2 * Math.exp(-crystal.sigma[c] * 0.7));
  near(record(2, 0)[c], (1 - f0) * Math.exp(-crystal.sigma[c] * 0.15));
  near(record(3, 0)[c], (1 - f0) * Math.exp(-crystal.sigma[c] * 0.35));
  near(record(5, 0)[c], (1 - f0) ** 2);
}
assert(record(0, 0)[0] > 0.5 && record(0, 0)[2] > 0.6, 'the background must remain visible through a normal-width prism');
near(record(0, 0)[3], f0);
near(record(0, 1)[3], 0.7);
assert(record(0, 1)[0] > 0.35, 'exit must restart outside the prism, not re-hit the front');
assert.deepEqual(record(0, 2), [1, 0, 0, 0]);
near(record(2, 1)[3], 0.15);
near(record(2, 2)[3], 1, 0.001);
assert(Math.abs(record(1, 2)[2] - record(4, 2)[2]) > 0.02, 'refraction must change the background ray');
const straight = [1, 0.3, 0.8].map(x => x / Math.hypot(1, 0.3, 0.8));
straight.forEach((v, c) => near(record(4, 2)[c], v));
near(output[28 * 4 + 3], 2, 0.001);
[0, -1, 0, 1].forEach((v, i) => near(output[29 * 4 + i], v));
assert(record(6, 1)[3] > 2, 'total internal reflection continues inside instead of leaking out');
for (let i = 0; i < 7; i++) for (let c = 0; c < 3; c++) {
  assert(record(i, 0)[c] >= 0 && record(i, 0)[c] <= 1);
  assert(record(i, 0)[c] + record(i, 3)[c] <= 1.00001, 'transmitted plus absorbed energy is bounded');
}

for (const curved of [false, true]) {
  const view = volumeFrag({ nx: 64, ny: 64, nz: 64 }, { curved });
  assert.match(view, /let path = crystalInterface\(shard/);
  assert.match(view, /ro = path\.p;/);
  assert.match(view, /rd = safeDir\(path\.d\);/);
  assert.match(view, /tCut -= th \+ path\.distance;/);
  if (curved) assert.match(view, /phiStale = true;\s*warpRestart\(&walk, ro, rd\);/);
}
const shadow = shadowFrag({ nx: 64, ny: 64, nz: 64 });
assert.match(shadow, /tau \+= meanSigma\(id\) \* max\(end - th, 0\.0\)/);
console.log('ok: actual WGSL transmission, violet absorption, refraction, inside-camera, TIR, mesh cut, bend-budget fallback, whole-run caps, and tinted sunlight');
