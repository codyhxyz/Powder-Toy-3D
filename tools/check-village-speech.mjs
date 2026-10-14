// CPU-only Web Audio scheduling: audible whiffs, contact thumps, layering and cancellation.
import assert from 'node:assert/strict';
import { AudioContext } from 'three';
import { createSpeech, punchImpact } from '../src/pov/village/speech.js';
import { PUNCH_CONTACT } from '../src/pov/village/actions.js';

const listeners = new Map(), sources = [], gains = [];
globalThis.document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn) };
const param = () => ({ value: 0, events: [], setValueAtTime(value, at) { this.events.push({ value, at }); },
  exponentialRampToValueAtTime(value, at) { this.events.push({ value, at }); } });
const node = () => ({ connect(to) { return to; }, disconnect() {} });
const source = () => {
  const s = { ...node(), frequency: param(), starts: [], stops: [],
    start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); } };
  sources.push(s); return s;
};
let resume = () => Promise.resolve();
AudioContext.setContext({
  currentTime: 10, sampleRate: 48000, destination: {}, resume: () => resume(),
  createBuffer: (_, length) => { const data = new Float32Array(length); return { getChannelData: () => data }; },
  createBufferSource: source, createOscillator: source,
  createBiquadFilter: () => ({ ...node(), frequency: param(), Q: param() }),
  createGain: () => { const n = { ...node(), gain: param() }; gains.push(n); return n; },
});
const speech = createSpeech();
try {
  await speech.swing(PUNCH_CONTACT);
  const swing = sources[0];
  assert.ok(swing.buffer.getChannelData(0).some(v => Math.abs(v) > 0.1), 'whoosh contains actual noise');
  assert.ok(Math.abs(gains[0].gain.events[1].at - (10 + PUNCH_CONTACT)) < 1e-8, 'whoosh peaks at fist contact');
  assert.equal(gains[0].gain.events[1].value, 0.55, 'whoosh supports rather than masks the impact');
  await speech.speak('Hey!');
  assert.equal(swing.stops.length, 0, 'animalese must not cut off the swing sound');
  await speech.bonk();
  const impact = sources.at(-1);
  assert.equal(impact.type, undefined, 'impact is layered PCM, not a pitched cartoon oscillator');
  assert.deepEqual(impact.buffer.getChannelData(0), punchImpact(48000));
  await speech.speak('Boing!');
  assert.equal(impact.stops.length, 0, 'next reply must not cut off the impact tail');
  await speech.speak('Hey!', 1, 0.24);
  assert.ok(sources.at(-3).starts[0] >= 10.26, 'resident reply starts after the impact rather than masking it');
  speech.muted = true;
  assert.ok(swing.stops.includes(undefined) && impact.stops.includes(undefined), 'mute stops both effects and speech');
  const mutedCount = sources.length;
  await speech.swing(); await speech.bonk(); await speech.speak('Hey!');
  assert.equal(sources.length, mutedCount, 'muted audio creates no sources');
  speech.muted = false;
  let release;
  resume = () => new Promise(resolve => { release = resolve; });
  const waiting = speech.swing();
  speech.stop(); release(); await waiting;
  assert.equal(sources.length, mutedCount, 'closing UI during audio resume cancels pending whoosh');
  resume = () => Promise.resolve();
  await speech.swing();
  document.hidden = true; listeners.get('visibilitychange')();
  assert.equal(speech.stats.queued, 0, 'hidden tab stops all voices');
  const hiddenCount = sources.length;
  await speech.swing(); await speech.bonk();
  assert.equal(sources.length, hiddenCount, 'hidden tab creates no effects');
} finally {
  speech.stop(); AudioContext.setContext(undefined); delete globalThis.document;
}
for (const rate of [22050, 44100, 48000, 96000]) {
  const data = punchImpact(rate), rms = (lo, hi) => {
    const samples = data.slice(Math.floor(lo * rate), Math.floor(hi * rate));
    return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  };
  assert.ok(data.every(v => Number.isFinite(v) && Math.abs(v) < 0.9), 'no clipped/nonfinite PCM');
  assert.ok(rms(0.005, 0.04) > 0.2, 'solid transient and low body');
  assert.ok(rms(0.16, 0.24) < rms(0.005, 0.04) * 0.02, 'impact decays, not a sustained note');
  assert.ok(Math.abs(data[0]) < 1e-8 && Math.abs(data.at(-1)) < 1e-6, 'silent endpoints avoid clicks');
}
console.log('PASS village swing/contact audio timing, speech layering, mute, visibility and asynchronous cancellation');
