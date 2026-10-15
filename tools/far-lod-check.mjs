// CPU contracts evaluated from generated WGSL: liquid-only fullscreen hits,
// depth ownership and exterior sea. No browser/GPU is used.
// usage: node tools/far-lod-check.mjs
import assert from 'node:assert/strict';
import { gridLayout } from '../src/sim.js';
import { farFrag, farLayout, farDetailDepthFrag } from '../src/shaders/far.js';

const g = gridLayout(128, 128, 128), L = farLayout([1024, 384, 1024]);
const shader = farFrag(g, L);
// WGSL's boolean expressions are JS's.
const ocean = new Function('tSea', 'tHit', 'cached', 'seaOut', 'NO_HIT',
  `return ${shader.match(/let ocean = ([\s\S]*?);/)[1]};`);
const noHit = 1e9;
assert(ocean(17.89, noHit, 0, true, noHit), 'the sea or plain past the world shows');
assert(!ocean(60, 40, 0, true, noHit), 'a liquid surface in front of the sea hides it');
assert(!ocean(17.89, noHit, 0, false, noHit), 'missing dry terrain never becomes an interior sea or rock plane');
assert(!ocean(noHit, noHit, 0, true, noHit), 'no sea crossing, no sea');
assert(ocean(17.89, noHit, 53.67, true, noHit), 'near exterior water hides a meshed bed behind it');
assert(!ocean(60, noHit, 53.67, true, noHit), 'water behind a mesh is hidden');
assert(!ocean(17.89, noHit, 53.67, false, noHit), 'a dry interior edit in a meshed chunk is not flooded');
const discards = new Function('cached', 'tHit', 'ocean', 'NO_HIT',
  `return ${shader.match(/if \((cached > 0\.0 && tHit == NO_HIT && !ocean)\) \{ discard; \}/)[1]};`);
assert(discards(53.67, noHit, false, noHit), 'nothing liquid in front of a mesh: the pixel is the mesh\'s');
assert(!discards(53.67, 40, false, noHit), 'liquid in front of a mesh draws');
assert(!discards(53.67, noHit, true, noHit), 'the sea in front of a mesh draws');
assert(!discards(0, noHit, false, noHit), 'no mesh: the sky draws');

for (const curved of [false, true]) {
  const code = farFrag(g, L, false, { curved });
  assert(code.includes('let ocean = seaOut &&'), 'interior no-hit rays cannot use the ocean backdrop in either presentation');
  assert(code.includes('t1 = min(t1, cached);'), 'march stops at reconstructed mesh distance');
  // Trace is independent of mesh readiness: opaque must never stop a ray.
  const body = code.match(/fn farTraceMatter\(p: vec3f\) -> f32 \{([\s\S]*?)\n\}/)[1];
  assert(!body.includes('detailAt'), 'unready and ready chunks have the same opaque exclusion');
  const trace = new Function('farSample', 'p', body.replace(/\blet\b/g, 'const'));
  assert.equal(trace(() => ({ r: 0.3, g: 0.4 })), 0.7, 'mixed shallow water still crosses .5');
  assert.equal(trace(() => ({ r: 0.7, g: 0 })), 0, 'opaque-only terrain never stops fullscreen rays');
  assert.equal(trace(() => ({ r: 0.7, g: 0.2 })), 0, 'opaque-dominant terrain cannot become a coarse hit');
  assert.equal(trace(() => ({ r: 0, g: 0.7 })), 0.7, 'open liquid still crosses .5');
  const entry = code.slice(code.indexOf('@fragment fn fs(v: FarVarying)'));
  assert(!entry.includes('farShadeMaterial(') && !entry.includes('ALBEDO(') && !entry.includes('giIrradiance('), 'neither normal nor cut entry can shade opaque terrain');
  assert(entry.includes('if (cut)') && entry.includes('col = farBody(') && entry.includes('col = farLiquid('), 'normal and cut retain liquid shading');
  assert(entry.includes('if (plain) { col = farShadeBed(FAR_OCEAN_BED'), 'exterior plain retained');
  assert(entry.includes('col = farSky(ro, rd);'), 'sky retained');
  assert(!/ID_JITTER|ID_DITHER|ID_SALT|p \+ j - n \* dot/.test(code), 'no spatial or temporal material-address noise');
  assert(code.includes('let q = p;'), 'underwater bed lookup is unwarped');
  assert.equal((code.match(/farElement\(/g) ?? []).length, 2, 'farElement is only defined and called for underwater bed');
  const mesh = farFrag(g, L, true, { curved });
  assert(mesh.includes('i32(v.element)'), 'mesh vertex material ID remains authoritative');
  assert(!/ID_JITTER|ID_DITHER|ID_SALT/.test(mesh));

  // Execute the real root body over discontinuous opaque-to-water transitions.
  // Guarded interpolation falls back to the high bracket at a material jump.
  const rootBody = code.match(/fn farRoot\([^\n]+\) -> f32 \{([\s\S]*?)\n\}/)[1];
  const root = new Function('farTraceMatter', `
    const FAR_ROOT_STEPS = 4, FAR_ISO = .5, FAR_FLAT_EPS = 1e-5,
      FAR_ROOT_SPLIT_LO = .15, FAR_ROOT_SPLIT_HI = .85;
    const mix = (a,b,t) => a+(b-a)*t, clamp = (v,a,b) => Math.max(a,Math.min(b,v)), max = Math.max;
    const farPath = (ro,rd,t) => t, ro = 0, rd = 1, ta0 = 0, tb0 = 1, fa0 = 0, fb0 = .7;
    ${rootBody.replace(/\blet\b/g, 'const').replace(/\bvar\b/g, 'let')}`);
  for (let i = 1; i < 100; i++) {
    const boundary = i / 100;
    const field = t => trace(() => t < boundary ? { r: .7, g: 0 } : { r: .3, g: .4 });
    const hit = root(field);
    assert(hit >= boundary && field(hit) > 0, 'root cannot interpolate back onto opaque terrain at a water transition');
  }
  const linear = root(t => .7 * t);
  assert(Math.abs(linear - .5 / .7) < 1e-12, 'continuous liquid field retains its interpolated surface');
  assert(code.includes('let fe = farTraceMatter(farPath(ro, rd, ts));'));
  assert(code.includes('farRoot(ro, rd, tm, ts, fm, fe)'), 'root upper bound matches the sampled point');
  if (curved) assert(code.includes('t = warpExit(gFarRay, vec3f(lo.x, 0.0, lo.y)'), 'bent dry-chunk skipping follows the curved ray');
}
// Current prepass contract: rasterized depth, reconstructed through inverse projection.
const depth = farDetailDepthFrag(g);
assert(depth.includes('return vec4f(v.position.z, 0.0, 0.0, 1.0);'), 'prepass writes rasterized depth');
assert(shader.includes('P.clipToWorld * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, cached, 1.0)'));
assert(shader.includes('cached = length(q.xyz / q.w - ro);'));
assert(/if \(all\(v\.world\.xz >= winLo\.xz\) && all\(v\.world\.xz < winLo\.xz \+ GRID_XZ\)\) \{ discard; \}/.test(depth), 'prepass leaves window columns to the volume');
assert(shader.includes('const FAR_MAX_STEPS: i32 = 624;'), 'march bound follows the taller world');
assert(shader.indexOf('let ocean =') < shader.indexOf('if (ocean)'), 'sea is decided before drawing');
assert(shader.indexOf('let ocean =') < shader.indexOf('tHit == NO_HIT && !ocean) { discard; }'), 'sea is decided before leaving the mesh its pixel');
console.log('PASS: liquid-only flat/curved normal/cut paths, no ID address noise, water-transition roots, exterior sea, dry pits, raster depth and taller-world march bound');
