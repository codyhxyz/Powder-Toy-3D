// CPU structural regression: normal/cavity shading stays; relief ray loops
// cannot return through Full detail or an old saved detail_relief preference.
// This is not a GPU performance measurement.
import assert from 'node:assert/strict';
import { DETAIL, detailDefaults, detailDefines, allDetailDefines, setDetailLevel, detailLevelOf } from '../src/gfx/detail.js';
import { surfaceGLSL } from '../src/shaders/gfx/surface.js';
import { volumeFrag } from '../src/shaders/render.js';

assert(!DETAIL.some((f) => f.key === 'relief' || f.define === 'DETAIL_RELIEF'));
const settings = { ...detailDefaults(), detail_relief: true };
for (const level of ['off', 'balanced', 'full']) {
  setDetailLevel(settings, level);
  assert.equal(detailLevelOf(settings), level);
  assert(!('DETAIL_RELIEF' in detailDefines(settings)), 'old saved relief setting cannot reactivate tracing');
}
const full = allDetailDefines();
const g = { nx: 128, ny: 128, nz: 128 };
const executable = (code) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
for (const detail of [{}, detailDefines(detailDefaults()), full]) {
  const code = surfaceGLSL(detail);
  assert.doesNotMatch(code, /reliefHit|reliefHeight|reliefSun|reliefSky|gRel[A-Z]/);
  assert.match(code, /\(\*s\)\.n = bumpNormal\(\(\*s\)\.ng, m\.g\)/);
  assert.match(code, /\(\*s\)\.cav = clamp\(m\.cav, 0\.0, 1\.0\)/);
  assert.match(code, /m\.g = pl\.yzw/); // bark plate normals
  for (const component of ['sandSlumps', 'sandClumps', 'snowDrifts', 'snowClumps', 'powderLumps', 'ashLumps', 'rockCrags']) {
    assert(code.split(`${component}(`).length > 2, `${component} still feeds material shading`);
  }
  assert.equal(surfaceGLSL({ ...detail, DETAIL_RELIEF: 1 }), code);
  for (const curved of [false, true]) {
    const view = volumeFrag(g, { view: 'realistic', detail, curved });
    assert.doesNotMatch(view, /reliefHit|reliefHeight|reliefSun|reliefSky|gRel[A-Z]/);
    assert(executable(volumeFrag(g, { view: 'realistic', detail: { ...detail, DETAIL_RELIEF: 1 }, curved })) === executable(view),
      'legacy define only changes the diagnostic header, not executable WGSL');
  }
}
console.log('normal-mapped surfaces: material normals/cavity retained; no relief tracing at any detail level, including legacy preferences');
