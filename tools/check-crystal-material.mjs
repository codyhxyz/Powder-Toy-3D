// CPU regressions for crystal optics and secondary-ray geometry.
// Optional --naga validates the assembled production shaders without using a GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { crystalGLSL } from '../src/shaders/gfx/crystal.js';
import { lightingGLSL } from '../src/shaders/gfx/lighting.js';
import { surfaceGLSL, WGSL_CHECK } from '../src/shaders/gfx/surface.js';
import { lib, libChecks, LIB_VARIANTS } from '../src/shaders/gfx/lib.js';
import { volumeFrag, shadowFrag } from '../src/shaders/render.js';
import { allDetailDefines } from '../src/gfx/detail.js';

const lighting = lightingGLSL();
const trace = lighting.slice(lighting.indexOf('fn traceNearSteps('), lighting.indexOf('fn traceNear('));
assert.match(trace, /id == E_CRYSTAL/);
assert.match(trace, /shardHit\(crysShard\(cell\)/, 'secondary rays must intersect prisms, not cubes');
assert.match(trace, /min\(tMax\[axOut\], tLim\)/, 'do not shadow from beyond the lamp');
assert.match(trace, /if \(hit\).*return th;/, 'return the actual facet distance');
assert.doesNotMatch(trace, /crystalHit\(|gCrys\w*\s*=/, 'secondary rays must preserve primary material state');
assert.match(crystalGLSL, /next < t\) \{ t = next; \*n = sign\(dn\) \* m;/);
assert.match(crystalGLSL, /next < t\) \{ t = next; \*n = m;/, 'tip exits also provide their normals');

const surface = surfaceGLSL();
assert.match(surface, /shardExit\(s, gp, r, &exitN\)/);
assert.match(surface, /dot\(r, exitN\)/, 'interior facets follow the refracted viewing ray');
assert.match(surface, /exp\(-vec3f\(/, 'depth has wavelength-dependent absorption');
assert.match(surface, /CRYS_STRIA_ROUGH \* st \* lodFade/);
assert.doesNotMatch(surface, /CRYS_STRIA_GLOW/, 'growth marks must not become luminous stripes');

if (process.argv.includes('--naga')) {
  const grid = { nx: 64, ny: 64, nz: 64 };
  const modules = [
    ...[...WGSL_CHECK(), ...libChecks('crystal'), ...libChecks('lighting')]
      .map(check => [check.name, check.code(grid)]),
    ...Object.keys(LIB_VARIANTS).map(variant => [variant,
      lib(grid, { variant }) + '\n@compute @workgroup_size(1) fn main() {}']),
    ...[false, true].map(curved => [`volume-${curved ? 'curved' : 'straight'}`,
      volumeFrag(grid, { detail: allDetailDefines(), curved })]),
    ['shadow', shadowFrag(grid)],
  ];
  for (const [name, code] of modules) {
    const result = spawnSync('naga', ['--stdin-file-path', `${name}.wgsl`], {
      input: code, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
    console.log(`ok: ${name}`);
  }
}
console.log('ok: crystal prism shadows, primary-hit isolation, absorptive interiors, non-emissive growth marks');
