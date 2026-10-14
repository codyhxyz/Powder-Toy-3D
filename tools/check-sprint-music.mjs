// CPU-only PCM and audio-transport checks. No browser/GPU or audio hardware.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SPRINT_MUSIC, renderSprintMusic, sprintMusicProfile, createSprintMusic } from '../src/pov/sprintMusic.js';

const started = performance.now();
const pcm = renderSprintMusic();
const expectedDuration = SPRINT_MUSIC.bars * 4 * 60 / SPRINT_MUSIC.bpm;
assert.equal(pcm.length, Math.round(expectedDuration * SPRINT_MUSIC.sampleRate));
assert.ok(expectedDuration > 11 && expectedDuration < 12);
assert.deepEqual(pcm, renderSprintMusic(), 'noise and composition are deterministic');
assert.throws(() => renderSprintMusic(8000), RangeError);
let peak = 0, energy = 0, mean = 0;
for (const sample of pcm) {
  assert.ok(Number.isFinite(sample));
  peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; mean += sample;
}
const rms = Math.sqrt(energy / pcm.length);
assert.ok(peak <= SPRINT_MUSIC.peak + 1e-6 && peak > 0.8, `bounded normalized peak: ${peak}`);
assert.ok(rms > 0.1 && rms < 0.3, `non-silent, dynamic mix: ${rms}`);
assert.ok(Math.abs(mean / pcm.length) < 1e-6, 'DC removed');
const seam = Math.abs(pcm[0] - pcm.at(-1));
assert.ok(seam < 0.015, `continuous circular tail: ${seam}`);
// No dead air across the loop join, nor a one-bar metronome copied eight times.
for (let bar = 0; bar < 8; bar++) {
  const from = Math.round(pcm.length * bar / 8), to = Math.round(pcm.length * (bar + 1) / 8);
  let e = 0, difference = 0;
  for (let i = from; i < to; i++) {
    e += pcm[i] ** 2;
    if (bar) difference += Math.abs(pcm[i] - pcm[i - from]);
  }
  assert.ok(Math.sqrt(e / (to - from)) > 0.08, `bar ${bar + 1} has musical energy`);
  if (bar) assert.ok(difference / (to - from) > 0.02, `bar ${bar + 1} varies`);
}
let previous = sprintMusicProfile(0);
assert.deepEqual(previous, { cutoffHz: 250, gain: 0 });
for (let i = 1; i <= 1000; i++) {
  const profile = sprintMusicProfile(i / 1000);
  assert.ok(profile.cutoffHz > previous.cutoffHz && profile.gain > previous.gain);
  assert.ok(profile.gain - previous.gain < 0.003, 'no gain threshold/pop near rest');
  previous = profile;
}
assert.equal(previous.cutoffHz, 10000);
assert.ok(previous.gain < 0.5, 'modest maximum gain');
for (const rush of [NaN, Infinity, -1]) assert.deepEqual(sprintMusicProfile(rush), sprintMusicProfile(0));
assert.deepEqual(sprintMusicProfile(2), sprintMusicProfile(1));
assert.equal(sprintMusicProfile(1, false).gain, 0);

// Minimal Web Audio doubles verify scheduling and routing without starting a context.
const param = (value) => ({ value, calls: [], setTargetAtTime(...args) { this.calls.push(args); } });
const node = (extra = {}) => ({ ...extra, connect(to) { this.output = to; return to; } });
const input = node();
let starts = 0;
const source = node({ playbackRate: param(1), start() { starts++; } });
const filter = node({ frequency: param(0), Q: param(0) });
const gain = node({ gain: param(1) });
const ctx = {
  currentTime: 12,
  createBuffer: (channels, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
  createBufferSource: () => source,
  createBiquadFilter: () => filter,
  createGain: () => gain,
};
const music = createSprintMusic(ctx, input);
assert.equal(gain.gain.value, 0, 'transport starts muted');
assert.equal(source.loop, true);
assert.equal(source.output, filter);
assert.equal(filter.output, gain);
assert.equal(gain.output, input, 'routes to the supplied master/underwater/limiter input');
for (const rush of [0.2, 0.4, 0.7, 1, 0.3, 0, 1]) music.update(rush);
assert.equal(starts, 1, 'speed changes never restart the beat');
assert.equal(source.playbackRate.calls.length, 0, 'speed never changes pitch/tempo');
assert.equal(music.stats().playbackRate, 1);
assert.equal(music.stats().cutoffHz, 10000);
assert.equal(filter.frequency.calls.at(-1)[2], 0.18, 'smoothed cutoff');
const count = gain.gain.calls.length;
music.update(1);
assert.equal(gain.gain.calls.length, count, 'unchanged targets do not reschedule automation');
music.update(1, false);
assert.deepEqual(gain.gain.calls.at(-1), [0, 12, 0.025], 'option off fades immediately on audio clock');
assert.equal(music.stats().gain, 0);
music.update(1);
music.update(0); // inactive/dead/hidden paths supply zero attained rush
assert.deepEqual(gain.gain.calls.at(-1), [0, 12, 0.025], 'zero rush uses prompt mute fade');
assert.equal(starts, 1, 're-enabling preserves transport phase');
console.log(`Sprint music CPU checks passed: ${pcm.length} samples, ${expectedDuration.toFixed(3)}s @ ${SPRINT_MUSIC.bpm} BPM, peak=${peak.toFixed(3)}, RMS=${rms.toFixed(3)}, seam=${seam.toFixed(5)}; ${(performance.now() - started).toFixed(0)}ms total. No GPU used.`);
