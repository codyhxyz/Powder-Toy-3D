// Original arcade-racer DnB: D minor, 8 bars, fixed tempo. No samples/assets.
// Halo's layered score is the touchstone: intensity reveals the arrangement,
// rather than changing its pitch or tempo. All voices are rendered once.
export const SPRINT_MUSIC = Object.freeze({ bpm: 172, bars: 8, sampleRate: 32000, peak: 0.85 });
const TAU = Math.PI * 2;
const beat = 60 / SPRINT_MUSIC.bpm;
const duration = SPRINT_MUSIC.bars * 4 * beat;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function sprintMusicProfile(rush, enabled = true) {
  const r = Number.isFinite(rush) ? Math.max(0, Math.min(1, rush)) : 0;
  return {
    // Exponential frequency travel sounds even; the gain is continuous at rest.
    cutoffHz: 250 * 40 ** r,
    gain: enabled ? (0.22 + 0.24 * r) * r / (r + 0.08) : 0,
  };
}

export function renderSprintMusic(sampleRate = SPRINT_MUSIC.sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 24000 || sampleRate > 96000) {
    throw new RangeError('Sprint music sample rate must be 24000..96000 Hz');
  }
  const pcm = new Float32Array(Math.round(duration * sampleRate));
  let seed = 0x172d0b; // fixed local noise seed; no gameplay RNG consumption
  const noise = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 2147483648 - 1;
  };
  // Circular overlap-add preserves the tails across the bar-8/bar-1 seam.
  const add = (when, length, voice, level = 1) => {
    const start = Math.round(when * sampleRate), count = Math.ceil(length * sampleRate);
    for (let i = 0; i < count; i++) pcm[(start + i) % pcm.length] += level * voice(i / sampleRate, i);
  };
  const envelope = (t, length, attack = 0.004, release = 0.025) =>
    Math.min(1, t / attack) * Math.min(1, Math.max(0, (length - t) / release));
  const kick = (when, level = 1) => add(when, 0.25, (t) => {
    const phase = TAU * (49 * t + 5.8 * (1 - Math.exp(-t * 45)));
    return Math.sin(phase) * Math.exp(-t * 19) * envelope(t, 0.25, 0.001);
  }, level * 0.75);
  const snare = (when, level = 1) => {
    let low = 0;
    add(when, 0.19, (t) => {
      const n = noise(); low += 0.18 * (n - low);
      return ((n - low) * 0.7 * Math.exp(-t * 25)
        + Math.sin(TAU * 185 * t) * 0.32 * Math.exp(-t * 38)) * envelope(t, 0.19, 0.001);
    }, level * 0.7);
  };
  const hat = (when, open, level) => {
    let prev = 0;
    const length = open ? 0.15 : 0.045;
    add(when, length, (t) => {
      const n = noise(), high = (n - prev) * 0.5; prev = n;
      return high * Math.exp(-t * (open ? 25 : 85)) * envelope(t, length, 0.001, 0.012);
    }, level * 0.23);
  };
  const bass = (when, midi, length, level) => {
    const f = hz(midi);
    add(when, length, (t) => {
      const phase = TAU * f * t;
      return (Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.13 * Math.sin(3 * phase)
        + 0.06 * Math.sin(5 * phase)) * envelope(t, length, 0.009, 0.04);
    }, level * 0.32);
  };
  // Dm9 → Bbmaj7 → Fmaj7 → Cadd9, with inversions keeping the pad close.
  const chords = [[62, 65, 69, 76], [62, 65, 69, 70], [60, 64, 65, 69], [60, 64, 67, 74]];
  const roots = [38, 34, 29, 36];
  for (let section = 0; section < 4; section++) {
    const length = beat * 8 + 0.3;
    for (const note of chords[section]) {
      const f = hz(note);
      add(section * 8 * beat, length, (t) =>
        (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 1.003 * t))
        * envelope(t, length, 0.3, 0.45), 0.027);
    }
  }
  for (let bar = 0; bar < SPRINT_MUSIC.bars; bar++) {
    const start = bar * 4 * beat, section = Math.floor(bar / 2);
    // Two-step backbeat with alternating displaced kicks and quiet ghost notes.
    for (const [step, level] of [[0, 1], [bar % 2 ? 6 : 7, 0.8], [10, 0.9]]) kick(start + step * beat / 4, level);
    for (const step of [4, 12]) snare(start + step * beat / 4);
    for (const step of bar % 2 ? [3, 9, 14, 15] : [6, 11, 15]) snare(start + step * beat / 4, 0.18);
    for (let step = 0; step < 16; step++) {
      hat(start + step * beat / 4, step === 14, step % 2 ? 0.35 : step % 4 ? 0.8 : 0.6);
    }
    // A rolling, syncopated root/octave/fifth phrase; space left around snares.
    const phrase = [[0, 0, 2.7], [3, 12, 1.6], [6, 0, 2.5], [9, 7, 1.6], [11, 0, 2.6], [14, bar % 2 ? 7 : 12, 1.7]];
    for (const [step, interval, steps] of phrase) bass(start + step * beat / 4, roots[section] + interval, steps * beat / 4, interval ? 0.7 : 1);
    // Sparse answering melody, with a dotted-eighth echo rather than a siren.
    const notes = [chords[section][0] + 12, chords[section][2] + 12, chords[section][1] + 12];
    for (let j = 0; j < notes.length; j++) {
      const when = start + (bar % 2 ? [0.75, 2.25, 3.5] : [0.5, 1.75, 3])[j] * beat;
      const f = hz(notes[j]);
      const pluck = (t) => (Math.sin(TAU * f * t) + 0.2 * Math.sin(TAU * f * 2 * t))
        * Math.exp(-t * 11) * envelope(t, 0.45, 0.006);
      add(when, 0.45, pluck, 0.065);
      add(when + 0.75 * beat, 0.45, pluck, 0.025);
    }
  }
  // Remove DC and normalize once, not per note; preserve the break's dynamics.
  let mean = 0, peak = 0;
  for (const sample of pcm) mean += sample / pcm.length;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample - mean));
  const scale = SPRINT_MUSIC.peak / Math.max(peak, 1e-9);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (pcm[i] - mean) * scale;
  return pcm;
}

// Speed changes preserve the beat. Hidden/inactive/disabled stops the source;
// resuming seeks the same transport clock rather than restarting bar one.
export function createSprintMusic(ctx, input) {
  const pcm = renderSprintMusic();
  const buffer = ctx.createBuffer(1, pcm.length, SPRINT_MUSIC.sampleRate);
  buffer.getChannelData(0).set(pcm);
  const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  filter.type = 'lowpass';
  filter.Q.value = 0.5;
  filter.frequency.value = 250;
  gain.gain.value = 0;
  filter.connect(gain).connect(input);
  const epoch = ctx.currentTime;
  let source = null, playing = false;
  let target = sprintMusicProfile(0);
  return {
    buffer,
    update(rush, enabled = true, active = true) {
      const next = sprintMusicProfile(rush, enabled && active), t = ctx.currentTime;
      if (enabled && active && !playing) {
        source?.stop(); // cancel an old fade-out before replacing it at the same beat
        source?.disconnect();
        source = ctx.createBufferSource();
        source.buffer = buffer; source.loop = true;
        source.connect(filter);
        source.start(t, (t - epoch) % buffer.duration);
        playing = true;
      } else if ((!enabled || !active) && playing) {
        source.stop(t + 0.12); // ~5 fade constants: silence before releasing the audio work
        playing = false;
      }
      if (next.cutoffHz !== target.cutoffHz) filter.frequency.setTargetAtTime(next.cutoffHz, t, 0.18);
      if (next.gain !== target.gain) gain.gain.setTargetAtTime(next.gain, t, next.gain === 0 ? 0.025 : 0.12);
      target = next;
    },
    stats: () => ({ ...target, gainNow: gain.gain.value, cutoffNowHz: filter.frequency.value,
      bpm: SPRINT_MUSIC.bpm, duration: buffer.duration, playing, playbackRate: source?.playbackRate.value ?? 1 }),
  };
}
