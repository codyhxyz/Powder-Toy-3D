// CPU only: execute the emitted scalar helper and the original full decoder.
import assert from 'node:assert/strict';
import { ELEMENTS, E, K } from '../src/elements.js';
import { PHASE_ROWS } from '../src/v2/phase.js';
import { lifeScale } from '../src/v2/layout.js';
import { compactDecodeWGSL } from '../src/shaders/compact.js';
import { SEED_MAX } from '../src/shaders/common.js';
import { gridLayout } from '../src/sim.js';
import { volumeFrag } from '../src/shaders/render.js';
import { DETAIL, DETAIL_FADE_HI } from '../src/gfx/detail.js';
import { MENISCUS_LAMBDA_MAX_M } from '../src/shaders/gfx/liquidDetail.js';

function body(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert(start >= 0, `missing actual ${name}`);
  const brace = source.indexOf('{', start);
  let end = brace + 1, depth = 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  return source.slice(brace + 1, end - 1);
}
function execute(source, name, args, env) {
  const js = body(source, name)
    .replace('var core = c;', 'var core = { ...c };') // WGSL value semantics
    .replace(/\blet\b/g, 'const').replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/>>/g, '>>>');
  return new Function(...Object.keys(env), `return function(${args}) { ${js} };`)(...Object.values(env));
}

const g = gridLayout(32, 32, 32);
const detail = { DETAIL_LIQ_FOAM: 1, DETAIL_LIQ_MENISCUS: 1, DETAIL_LIQ_RIPPLES: 1, DETAIL_MEDIA_STEP: 1 };
const code = format => volumeFrag(g, { fixedReadFormat: format, detail });
for (const opts of [{}, { fixedReadFormat: 0 }, { fixedReadFormat: 2, debug: true }, { fixedReadFormat: 3, debug: true }])
  assert(!volumeFrag(g, opts).includes('fn volumeId('), 'generic/legacy/debug accessors stay unchanged');
for (const format of [2, 3]) {
  const source = code(format);
  assert.equal((source.match(/\bvolumeId\(/g) ?? []).length, 17, 'one helper plus all 16 literal probes');
  assert(!source.includes('eid(fetchA('), 'representative volume uses scalar ID probes');
  assert(!body(source, 'volumeId').includes('compactTq'), 'no temperature decoding');
}
assert(!body(code(3), 'volumeId').includes('seed3'), 'physical nonzero fill is never dithered');
// The meniscus looks a wall up once in the code (a 0-2 round loop, not four
// unrolled rounds), through the scalar probe, and gfx/detail.js's fadeM is
// the shader's own fade: DETAIL_FADE_HI of the widest liquid's wavelength.
for (const format of [2, 3]) {
  const men = body(code(format), 'liquidMeniscus');
  assert.equal((men.match(/\bvolumeId\(/g) ?? []).length, 1, 'one wall probe in the meniscus');
}
const menFade = DETAIL.find((f) => f.define === 'DETAIL_LIQ_MENISCUS').fadeM;
assert(Math.abs(menFade / (DETAIL_FADE_HI * MENISCUS_LAMBDA_MAX_M) - 1) < 1e-3, `meniscus fadeM ${menFade} is the shader's fade`);
// fetchAs decodes cellOf(slotOf(p)), NOT p. Deliberately choose different
// coordinates to catch incorrect dither for aliased/out-of-grid coordinates.
const p = [-1, 4, 33], canonical = [31, 4, 1];
let core, thresholdBits, kindOverride = null, colourBits = 0, state = 0x93a10f27;
const random = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
const env = {
  KIND: id => kindOverride ?? ELEMENTS[id]?.kind ?? K.EMPTY,
  K_EMPTY: K.EMPTY, K_LIQUID: K.LIQUID, E_EMPTY: E.EMPTY,
  i32: x => x | 0, u32: x => x >>> 0, f32: Math.fround, max: Math.max, SEED_MAX,
  select: (a, b, test) => test ? b : a,
  vec4f: (x, y, z, w) => ({ x: Math.fround(x), y, z, w }),
  seed3: (position, tick, salt) => {
    assert.equal(position, canonical);
    assert.equal(tick, 0);
    assert([991, 4243].includes(salt));
    return salt === 4243 ? thresholdBits : colourBits;
  },
  COMPACT_HOT_T: PHASE_ROWS.map(r => r.hotQ),
  COMPACT_COLD_T: PHASE_ROWS.map(r => r.coldQ),
  COMPACT_CONDUCTS: ELEMENTS.map(e => e.elec > 0),
  COMPACT_LIFE_SCALE: ELEMENTS.map(e => lifeScale(e.id)),
  COMPACT_CTYPE_MASK: ELEMENTS.map(e => e.burnRate > 0 ? 127 : 255),
  fetchNativeCore: position => { assert.equal(position, p); return core; },
  slotOf: position => { assert.equal(position, p); return 73; },
  cellOf: slot => { assert.equal(slot, 73); return canonical; },
};
env.compactTq = execute(compactDecodeWGSL, 'compactTq', 'c', env);
const decode = execute(compactDecodeWGSL, 'compactA', 'p,c', env);
const normalize = execute(compactDecodeWGSL, 'compactProbeCore', 'c', env);
const ids = Object.fromEntries([2, 3].map(format => [format, execute(code(format), 'volumeId', 'p', env)]));
let cases = 0;
function check(c, threshold, override = null) {
  core = c; kindOverride = override;
  thresholdBits = ((threshold << 16) | (random() & 65535)) >>> 0;
  colourBits = random();
  const before = { ...c };
  for (const format of [2, 3]) {
    const expected = decode(canonical, format === 3 ? normalize(c) : c).x | 0;
    assert.equal(ids[format](p), expected, `id=${c.x & 255} fill=${c.y & 0xffffff} threshold=${threshold} format=${format}`);
    assert.deepEqual(c, before, 'reader must not mutate payload');
    cases++;
  }
}
assert.equal(E.EMPTY, 0, 'full decoder emits literal zero for empty');
for (let id = 0; id < 256; id++) {
  // Include arbitrary KIND outcomes for invalid IDs; the proof does not assume
  // one implementation of GPU robust table indexing outside the valid catalog.
  for (const kind of [null, K.EMPTY, K.LIQUID, ELEMENTS[E.WALL].kind])
    for (const threshold of [0, 1, 32767, 32768, 65534, 65535])
      for (const fill of [0, 1, Math.max(0, threshold - 1), threshold, threshold + 1, 65535, 65536, 65537, 1048576, 0xffffff])
        check({ x: ((random() & 0xffffff00) | id) >>> 0,
          y: ((random() & 0xff000000) | fill) >>> 0, z: random(), w: random() }, threshold, kind);
}
for (let threshold = 0; threshold < 65536; threshold++)
  for (const fill of [threshold, threshold + 1])
    check({ x: (E.WATER | (1173 << 8)) >>> 0, y: fill, z: random(), w: random() }, threshold);
for (let i = 0; i < 10000; i++) check({ x: random(), y: random(), z: random(), w: random() }, random() & 65535);
console.log(`Native volume IDs: ${cases} full-decoder equivalence checks; all dither thresholds, physical fill, arbitrary opaque fields, invalid-ID kinds and canonical coordinates passed; CPU only`);
