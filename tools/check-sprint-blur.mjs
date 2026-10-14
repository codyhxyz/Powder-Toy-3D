// CPU envelope and shader-contract checks; pixel assertions live in the post harness's sprintBlur test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPRINT_BLUR, sprintBlurStep } from '../src/gfx/sprintBlur.js';
import { POST_DEFAULTS, compositeWGSL } from '../src/gfx/post.js';

assert.equal(POST_DEFAULTS.sprintBlur, 0);
const settle = (fps, rush, initial = 0, seconds = 1) => {
  let value = initial;
  for (let i = 0; i < fps * seconds; i++) {
    const next = sprintBlurStep(value, rush, 1 / fps);
    assert.ok(next >= 0 && next <= 1);
    if (rush === 1) assert.ok(next >= value, 'monotone attack');
    if (rush === 0) assert.ok(next <= value, 'monotone release');
    value = next;
  }
  return value;
};
for (const fps of [20, 60, 144]) {
  assert.ok(Math.abs(settle(fps, 1) - settle(60, 1)) < 1e-10, 'time-based envelope');
  assert.ok(settle(fps, 0.2) < 0.041, 'launch is restrained');
  assert.ok(settle(fps, 1) > 0.998, 'full speed has full effect');
  assert.equal(settle(fps, 0, 1), 0, 'stopping returns to exact zero work');
}
for (const bad of [NaN, Infinity, -Infinity]) assert.ok(Number.isFinite(sprintBlurStep(bad, bad, bad)));
assert.equal(sprintBlurStep(0, 1, 0), 0);
assert.equal(sprintBlurStep(0, 1, -1), 0);
assert.ok(sprintBlurStep(1, 0, 0.1) < 1 - sprintBlurStep(0, 1, 0.1), 'release is faster than attack');
assert.ok(SPRINT_BLUR.taps <= 8, 'bounded single-pass bandwidth');
assert.ok(SPRINT_BLUR.length > 0 && SPRINT_BLUR.length < 0.1);
const shader = compositeWGSL();
assert.match(shader, /if \(P\.sprintBlur <= 0\.0\) \{ return original; \}/);
assert.match(shader, /if \(edge <= 0\.0\) \{ return original; \}/);
assert.ok(shader.indexOf('let streak = sprintBlur') < shader.indexOf('if (P.viewmodel'), 'hands are composited after blur');
assert.match(shader, /rad \+= streak\.rgb - c\.rgb/, 'disabled blur preserves existing sharpen/bloom path exactly');
assert.match(shader, /sum \+= sanitize\(tapRadiance\(tColor, smp, at, P\.packed\)\)/, 'blur uses the shared packed-aware radiance tap');
assert.match(shader, /let a = taaExpand\(textureLoad\(t,/, 'expand TAA texels before interpolation, not after');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(app, /settings\.sprintBlur && !REDUCED_MOTION\.matches/);
assert.match(app, /pov\?\.mode === 'on'/);
assert.match(app, /!pov\.player\?\.dead && !pov\.vehicles\.seated && pov\.camera\.zoom === 1/);
for (const key of ['sprintBlur', 'sprintMusic']) {
  assert.match(app, new RegExp(`type: 'seg', key: '${key}'`), 'independent controls');
  assert.ok(app.slice(app.indexOf('const PERSIST'), app.indexOf('const STORE')).includes(`'${key}'`), 'saved preference');
}
console.log('PASS sprint blur envelope, bounded taps, sharp center/HUD, reduced motion, scope/vehicle gating and settings');
