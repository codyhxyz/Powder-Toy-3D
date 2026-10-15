// CPU regressions for opaque traversal, shading and optical continuation.
import assert from 'node:assert/strict';
import { volumeFrag } from '../src/shaders/render.js';
import { gridLayout } from '../src/sim.js';
import { allDetailDefines, detailDefaults, detailDefines } from '../src/gfx/detail.js';

const g = gridLayout(128, 128, 128);
const code = volumeFrag(g);
const helper = code.match(/fn surfInsideOpaque\(phi: vec4f\) -> i32 \{([\s\S]*?)\n\}/);
assert(helper, 'material views must recover an already-entered opaque field');
// This pure WGSL body is also JavaScript: execute the actual selector, not a copy.
const insideOpaque = new Function('phi', 'SURF_ISO', helper[1]);
const iso = Number(code.match(/const SURF_ISO: f32 = ([\d.]+);/)[1]);
const selectOpaque = (phi) => insideOpaque(Float32Array.from(phi), iso);
assert.equal(selectOpaque([0, 0, 0, 0]), -1);
assert.equal(selectOpaque([1, 0, 0, 0]), -1, 'liquid alone is not opaque');
assert.equal(selectOpaque([1, 0, 0, .6]), 3, 'denser liquid cannot hide rock');
assert.equal(selectOpaque([.9, .7, 0, .6]), 1, 'use the dominant opaque field');
assert.equal(selectOpaque([0, 0, .5, 0]), 2, 'an exact boundary must not fall through');
assert.equal(selectOpaque([0, .49, .49, .49]), -1);

const resumeExpression = code.match(/let resume = (min\(tEv \+ IFACE_NUDGE, min\(tExit, tCut\)\));/);
assert(resumeExpression, 'straight optical transitions must retain the rest of their cell');
const nudge = Number(code.match(/const IFACE_NUDGE: f32 = ([\d.]+);/)[1]);
const resume = new Function('tEv', 'tExit', 'tCut', 'IFACE_NUDGE', 'min', `return ${resumeExpression[1]}`);
const next = (event, exit = 1, cut = 1e9) => resume(event, exit, cut, nudge, Math.min);

// A water pocket and opaque wall share a cell after MAX_BENDS is spent.
// Advancing straight to the cell's exit loses BOTH the water exit and the wall.
const events = [{ t: .2, kind: 'enter' }, { t: .6, kind: 'exit' }, { t: .8, kind: 'opaque' }];
function trace(advance) {
  let start = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events.find(e => e.t >= start);
    if (!event) return 0;
    if (event.kind === 'opaque') return 1;
    start = advance(event.t);
  }
  return 0;
}
assert.equal(trace(() => 1), 0, 'old whole-cell advance produces a transparent wall hit');
assert.equal(trace(next), 1, 'same-cell continuation stops at the opaque wall');
assert.equal(next(.99), 1, 'do not advance into the next cell');
assert.equal(next(.2, 1, .21), .21, 'respect the nearer mesh cut');

for (const view of ['realistic', 'cozy']) for (const curved of [false, true]) {
  const shader = volumeFrag(g, { view, curved });
  assert.match(shader, /if \(phiStale\) \{ phiA = surfSample\(ro \+ rd \* tEnter\); \}[\s\S]*?let ic = surfInsideOpaque\(phiA\);/,
    'inside-opaque recovery is independent of sample staleness and liquid state');
  assert.match(shader, /let oc = surfInsideOpaque\(phiA\);/, 'bent rays retain opaque recovery');
  assert.match(shader, curved
    ? /mNext -= resume;[\s\S]*?walk\.t = mix\(walk\.t, walk\.end, resume \/ tExit\);[\s\S]*?walk\.boundary = false;/
    : /tEnter = resume;[\s\S]*?phiA = surfSample\(ro \+ rd \* tEnter\);[\s\S]*?continue;/);
  if (curved) {
    const advanceSample = new Function('mNext', 'resume',
      `${shader.match(/mNext -= resume;/)[0]} return mNext;`);
    const origin = next(.2), sample = .7;
    assert(Math.abs(origin + advanceSample(sample, origin) - sample) < 1e-12,
      'curved continuation retains the next gas sample position');
  }
}
// The boolean and kind must stay equivalent at every write, including camera
// cuts, refraction restarts and the grain alternate path. Shading must not
// reintroduce the loop-carried integer predicate that dropped pixels on Metal.
for (const view of ['realistic', 'cozy']) for (const curved of [false, true])
  for (const detail of [{}, detailDefines(detailDefaults()), allDetailDefines()]) {
    const shader = volumeFrag(g, { view, curved, detail });
    const body = shader.match(/fn traceView\([\s\S]*?\n\}/)[0];
    assert.match(body, /var stop = false;/);
    const writes = [...body.matchAll(/\bhitK = ([^;]+);/g)];
    assert.equal(writes.filter(w => w[1] === 'HIT_NONE').length, 1, 'only initialization clears the kind');
    const terminal = writes.filter(w => w[1] !== 'HIT_NONE');
    for (const write of terminal) {
      assert.match(write[1], /^(HIT_(SMOOTH|CRISP|GRAIN)|select\(HIT_SMOOTH, HIT_GRAIN, gAltGeom\))$/);
      assert(body.slice(write.index + write[0].length).startsWith(' stop = true;'),
        `terminal ${write[1]} must carry its shading marker`);
    }
    assert.equal((body.match(/stop = true;/g) ?? []).length, terminal.length,
      'bounds, mesh cuts and exhausted media must not become terminal surfaces');
    assert.equal((body.match(/if \(stop\) \{/g) ?? []).length, 2, 'gate material gathering and opaque compositing alike');
    assert(!body.includes('if (hitK != HIT_NONE)'), 'do not gate shading on the loop-carried integer kind');
  }
console.log('PASS: mixed opaque fields, optical continuation, mesh cuts and terminal shading markers across material variants');
