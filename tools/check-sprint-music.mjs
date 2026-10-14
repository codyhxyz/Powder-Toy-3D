// CPU-only recorded-asset, loading, profile and transport checks. No browser/GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPRINT_MUSIC, sprintMusicProfile, createSprintMusic } from '../src/pov/sprintMusic.js';

const asset = readFileSync(new URL(`../public${SPRINT_MUSIC.url}`, import.meta.url));
assert.ok(asset.length > 1_000_000 && asset.length < 2_000_000, 'complete track, bounded download');
assert.equal(asset.toString('ascii', 0, 3), 'ID3');
assert.ok(asset.includes(Buffer.from(SPRINT_MUSIC.title)));
assert.ok(asset.includes(Buffer.from(SPRINT_MUSIC.artist)));
assert.equal(SPRINT_MUSIC.bpm, 172);

let previous = sprintMusicProfile(0);
assert.deepEqual(previous, { cutoffHz: 250, gain: 0 });
for (let i = 1; i <= 1000; i++) {
  const profile = sprintMusicProfile(i / 1000);
  assert.ok(profile.cutoffHz > previous.cutoffHz && profile.gain > previous.gain);
  assert.ok(profile.gain - previous.gain < 0.003, 'no gain threshold/pop near rest');
  previous = profile;
}
assert.equal(previous.cutoffHz, 10000);
assert.ok(previous.gain < 0.5);
for (const rush of [NaN, Infinity, -1]) assert.deepEqual(sprintMusicProfile(rush), sprintMusicProfile(0));
assert.deepEqual(sprintMusicProfile(2), sprintMusicProfile(1));
assert.equal(sprintMusicProfile(1, false).gain, 0);

const param = value => ({ value, calls: [], resets: [],
  setTargetAtTime(...args) { this.calls.push(args); },
  cancelScheduledValues() {},
  setValueAtTime(value, time) { this.value = value; this.resets.push([value, time]); },
});
const node = (extra = {}) => ({ ...extra, connect(to) { this.output = to; return to; } });
function fixture() {
  const input = node(), filter = node({ frequency: param(0), Q: param(0) }), gain = node({ gain: param(1) });
  const sources = [];
  const ctx = {
    currentTime: 12,
    async decodeAudioData(bytes) {
      assert.deepEqual(Buffer.from(bytes), asset, 'decode the actual bundled recording');
      return { duration: 87.211542 };
    },
    createBufferSource() {
      const source = node({ playbackRate: param(1), offsets: [], stops: [],
        start(time, offset) { this.offsets.push(offset); }, stop(time) { this.stops.push(time); }, disconnect() {} });
      sources.push(source);
      return source;
    },
    createBiquadFilter: () => filter,
    createGain: () => gain,
  };
  return { ctx, input, filter, gain, sources };
}
const savedFetch = globalThis.fetch, savedWarn = console.warn;
try {
  let complete;
  globalThis.fetch = url => {
    assert.equal(url, SPRINT_MUSIC.url);
    return new Promise(resolve => { complete = resolve; });
  };
  const { ctx, input, filter, gain, sources } = fixture();
  const music = createSprintMusic(ctx, input);
  assert.equal(music.stats().ready, false);
  music.update(1);
  assert.equal(sources.length, 0, 'effects startup does not wait for the music download');
  complete({ ok: true, arrayBuffer: async () => asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength) });
  assert.equal(await music.ready, true);
  assert.equal(sources.length, 0, 'download completion never starts playback on its own');
  assert.ok(music.stats().duration > 87);
  music.update(1, false);
  assert.equal(sources.length, 0, 'a disabled track cannot start after a late download');
  music.update(0.2);
  const source = sources[0];
  assert.equal(source.loop, true);
  assert.equal(source.buffer, music.buffer);
  assert.equal(source.output, filter);
  assert.equal(filter.output, gain);
  assert.equal(gain.output, input);
  assert.deepEqual(gain.gain.resets.at(-1), [0, 12], 'late recording starts with a fade-in');
  for (const rush of [0.2, 0.4, 0.7, 1, 0.3, 0, 1]) music.update(rush);
  assert.equal(sources.length, 1, 'speed changes never restart the recording');
  assert.equal(source.playbackRate.calls.length, 0, 'original pitch and tempo');
  assert.equal(filter.frequency.calls.at(-1)[2], 0.18);
  const count = gain.gain.calls.length;
  music.update(1);
  assert.equal(gain.gain.calls.length, count);
  music.update(1, false);
  assert.deepEqual(gain.gain.calls.at(-1), [0, 12, 0.025]);
  assert.equal(music.stats().playing, false);
  ctx.currentTime += 0.25;
  music.update(1);
  assert.equal(sources.length, 2);
  assert.equal(sources[1].offsets.at(-1), 0.25, 'resume at transport position, not the start');
  music.update(0);
  assert.deepEqual(gain.gain.calls.at(-1), [0, 12.25, 0.025]);
  music.update(1, true, false);
  assert.equal(music.stats().playing, false);
  assert.equal(sources[1].stops.at(-1), 12.37);

  console.warn = () => {};
  for (const failure of ['http', 'decode']) {
    const f = fixture();
    globalThis.fetch = async () => ({ ok: failure !== 'http', status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    if (failure === 'decode') f.ctx.decodeAudioData = async () => { throw new Error('bad recording'); };
    const failed = createSprintMusic(f.ctx, f.input);
    assert.equal(await failed.ready, false);
    failed.update(1);
    assert.equal(f.sources.length, 0);
    assert.equal(failed.stats().ready, false);
    assert.ok(failed.stats().error, 'failed music stays silent without breaking sound effects');
  }
} finally { globalThis.fetch = savedFetch; console.warn = savedWarn; }
console.log(`PASS recorded sprint music: ${SPRINT_MUSIC.artist} — ${SPRINT_MUSIC.title}; asset, async load/failure, filter, fades and transport`);
