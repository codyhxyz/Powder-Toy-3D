// CPU only: numerical oracles, generated WGSL reflection, resource contracts.
// Not a WGSL compiler, GPU correctness, or integrated feature-completion claim.
import assert from 'node:assert/strict';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { gridDims } from '../src/shaders/common.js';
import { opticsShader, opticsBindings, opticsFieldBindings, OPTICS_STATE_LAYOUT } from '../src/shaders/hybrid/optics.js';
import { interfaceEnergy, opticalTransmission, walkOpticalCells, traceOpticalReference,
  opticalFieldDensity, opticalFieldSegment, validateOpticsLimits, validateOpticsResources,
  createHybridOptics } from '../src/gfx/hybrid/optics.js';
const close = (a, b, tol = 1e-8) => assert(Math.abs(a - b) < tol, `${a} != ${b}`);
const white = a => a.forEach(v => close(v, 1));
const water = { id: 1, ior: 1.33, sigma: [0, 0, 0] };
const oil = { id: 2, ior: 1.47, sigma: [0, 0, 0] };
const glass = { id: 3, ior: 1.5, sigma: [0, 0, 0] };
for (const from of [1, 1.33, 1.47, 1.5]) for (const to of [1, 1.33, 1.47, 1.5]) {
  for (const cosine of [0, 0.1, 0.5, 1]) { const e = interfaceEnergy(cosine, from, to); close(e.reflected + e.transmitted, 1); }
}
assert.equal(interfaceEnergy(0.1, 1.5, 1).reflected, 1);
assert.deepEqual(opticalTransmission([0, 1, 2], 2), [1, Math.exp(-2), Math.exp(-4)]);
let cells = [];
const dda = walkOpticalCells([-1, 0.5, 0.5], [1, 0, 0], [12, 1, 1], { visit: (c, a, b) => { cells.push(c[0]); close(b-a, 1); } });
assert.deepEqual(cells, Array.from({ length: 12 }, (_, i) => i)); assert(!dda.exhausted);
assert(walkOpticalCells([-1, 0.5, 0.5], [1, 0, 0], [12, 1, 1], { maxSteps: 2 }).exhausted);
cells = [];
walkOpticalCells([0, 0, 0], [1, 1, 1], [3, 3, 3], { visit: c => { cells.push(c); } });
assert.deepEqual(cells, [[0,0,0], [1,1,1], [2,2,2]]);
const run = (extra = {}, origin = [-1, 0.5, 0.5], direction = [1, 0, 0]) => traceOpticalReference(origin, direction, [8, 1, 1], {
  sample: ([x]) => x === 1 ? water : x === 2 ? oil : x === 3 ? glass : null, ...extra,
});
let r = run(); assert.equal(r.termination, 'escape'); assert.equal(r.interfaces, 4); close(r.thickness, 3); white(r.color);
r = run({}, [1.25, 0.5, 0.5]); assert.equal(r.interfaces, 3); close(r.thickness, 2.75); white(r.color);
r = run({ sample: () => water }); assert.equal(r.interfaces, 2); close(r.thickness, 8); white(r.color);
r = run({ sample: () => water }, [1.25, 0.5, 0.5]); assert.equal(r.interfaces, 1); close(r.thickness, 6.75); white(r.color);
for (const budget of [{ maxSteps: 1 }, { maxInterfaces: 1 }]) { r = run(budget); assert.equal(r.termination, 'budget'); white(r.color); }
// The optical budget must not hide distant cells before the first interface.
r = traceOpticalReference([-1,0.5,0.5], [1,0,0], [384,1,1], {
  sample: ([x]) => x === 380 ? water : null, maxSteps: 4,
});
assert(r.interfaces >= 1); assert(r.segments.some(s => s.id === water.id));
white(r.color);
// Beer-Lambert, both submerged and exiting; no interface reflection for IOR=1.
r = run({ sample: () => ({ ...water, ior: 1, sigma: [0.1,0.2,0.3] }) }, [0,0.5,0.5]);
r.color.forEach((v, i) => close(v, Math.exp(-(i+1)*0.1*8)));
let hidden = 0;
r = run({ sample: ([x]) => x === 1 ? water : x === 3 ? { id: 8, opaque: true } : null,
  worldHit: () => { hidden++; return [0.2,0.3,0.4]; } });
assert.equal(hidden, 1); assert.equal(r.termination, 'opaque'); assert(r.color.every(v => v > 0 && v < 1));
const media = [];
run({ mediaSegment: (p, d, length) => { media.push({ p: [...p], length }); return [0,0,0,0]; } });
assert(media.length > 0); assert(media.every(({p}) => p[0] >= 4), 'pre-entry segment belongs to screen media');
// TIR follows reflected direction; opaque hit callback is still available.
r = traceOpticalReference([1.5,0.8,0.5], [1,0.2,0], [8,1,1], { sample: () => glass, maxInterfaces: 1 });
assert.equal(r.termination, 'budget'); assert.equal(r.interfaces, 1); white(r.color);
assert(r.segments.some(s => s.direction[1] < 0), 'TIR must reflect into the medium');
// Field is affine within each tetra, and roots are not cell-boundary geometry.
const field = ([x]) => x === 0 ? 0.2 : x === 1 ? 1 : 0;
close(opticalFieldDensity([0.75,0.75,0.75], field), 0.4);
const root = opticalFieldSegment([0.5,0.75,0.75], [1,0,0], 0.5, field);
// First event is a tetra diagonal; next event is the iso crossing at x=.875.
close(root, 0.25);
const iso = opticalFieldSegment([0.75,0.75,0.75], [1,0,0], 0.25, field);
close(iso, 0.125); close(opticalFieldDensity([0.75+iso,0.75,0.75], field), 0.5);
for (let n = 0; n < 100; n++) {
  const p = [0.51 + n * 0.003, 0.65, 0.82], d = [0.6,0.2,-0.1];
  const len = opticalFieldSegment(p, d, 0.18, field);
  assert(len > 0 && len <= 0.18);
  const a = opticalFieldDensity(p, field), b = opticalFieldDensity(p.map((v,i) => v+d[i]*len), field);
  const mid = opticalFieldDensity(p.map((v,i) => v+d[i]*len*0.5), field); close(mid, (a+b)*0.5);
}
const g = gridDims({ nx: 32, ny: 32, nz: 32 });
for (const fieldBinding of [null, 2, 14]) {
  const code = opticsShader(g, { fieldBinding });
  const reflection = new WgslReflect(code);
  assert.equal(reflection.textures.length, fieldBinding === null ? 2 : 4);
  assert.equal(reflection.storage.length, 3); assert.equal(reflection.uniforms.length, 3);
  const layout = [...opticsBindings(), ...(fieldBinding === null ? [] : opticsFieldBindings(fieldBinding))];
  for (const t of reflection.textures) { const e = layout.find(e => e.binding === t.binding); assert(e); assert.equal(t.group, 2); }
  assert.equal(OPTICS_STATE_LAYOUT.filter(e => e.buffer?.type === 'read-only-storage').length, 2);
  assert.doesNotMatch(code, /out\.fallback\s*[|]?=\s*(1|2|4|32|64|256)u/, 'ordinary transport cannot require legacy');
  assert.match(code, /sum \+= transmission \* opticsWorldHit\(h\)/);
  assert.match(code, /sum \+= transmission \* opticsEnvironment\(p, rd, 1\.0\)/);
  assert.match(code, /floor\(a\.w\)/); assert.match(code, /incandescence\(a\.y\)/);
  if (fieldBinding !== null) { assert.match(code, /segment = opticsFieldSegment/); assert.match(code, /textureLoad\(opticsThin/); }
}
validateOpticsLimits({}, opticsFieldBindings());
assert.throws(() => validateOpticsLimits({maxSampledTexturesPerShaderStage:32}, Array.from({length:15}, (_,i) => ({binding:i+2, texture:{}}))), /maxSampledTextures/);
assert.throws(() => validateOpticsLimits({}, Array.from({length: 15}, (_,i) => ({binding:i+2, texture:{}}))), /maxSampledTextures/);
assert.throws(() => validateOpticsLimits({}, Array.from({length: 6}, (_,i) => ({binding:i+2, buffer:{type:'read-only-storage'}}))), /maxStorageBuffers/);
assert.throws(() => validateOpticsLimits({}, [{binding:2, buffer:{type:'storage'}}]), /read-only/);
assert.throws(() => createHybridOptics({}, {}), /worldHit/);
const texture = format => ({format, width:16, height:16, usage:20, createView(){ return {}; }});
const color = texture('rgba16float'), depth = texture('depth32float');
const output = {color:texture('rgba16float'), metadata:texture('rgba32float'), fallback:texture('r32uint')};
validateOpticsResources({color, depth}, output);
assert.throws(() => validateOpticsResources({color, depth}, {...output,color}), /alias/);
assert.throws(() => validateOpticsResources({color, depth}, {...output,metadata:texture('rgba16float')}), /metadata/);
console.log('hybrid optics CPU: energy, submerged/mixed/TIR/Beer paths, bounded tails, opaque/media hooks, tetra roots, WGSL/layout reflection and resource limits passed (no GPU validation)');
