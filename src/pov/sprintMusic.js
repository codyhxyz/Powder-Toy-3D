// Selected from the user's DJ Set/DnB, Laincore library; the recording, not a synthesized substitute.
export const SPRINT_MUSIC = Object.freeze({
  title: 'Megablast', artist: 'Downhill2k01', bpm: 172, url: '/music/sprint-megablast.mp3',
});

export function sprintMusicProfile(rush, enabled = true) {
  const r = Number.isFinite(rush) ? Math.max(0, Math.min(1, rush)) : 0;
  return {
    // Open in octaves, not equal Hz: muffled early, then the breaks emerge without another power-law delay.
    cutoffHz: 125 * 80 ** Math.max(0, (r - 0.2) / 0.8),
    gain: enabled ? (0.22 + 0.24 * r) * r / (r + 0.08) : 0,
  };
}

// Load independently of sound effects. Speed changes preserve the beat;
// hidden/inactive/disabled stops the source, then resumes at the same transport position.
export function createSprintMusic(ctx, input) {
  const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  filter.type = 'lowpass';
  filter.Q.value = 0.5;
  filter.frequency.value = sprintMusicProfile(0).cutoffHz;
  gain.gain.value = 0;
  filter.connect(gain).connect(input);
  let buffer = null, error = null, epoch = ctx.currentTime;
  let source = null, playing = false;
  let target = sprintMusicProfile(0);
  const ready = fetch(SPRINT_MUSIC.url)
    .then(response => {
      if (!response.ok) throw new Error(`Sprint music: HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then(bytes => ctx.decodeAudioData(bytes))
    .then(decoded => { buffer = decoded; epoch = ctx.currentTime; return true; })
    .catch(reason => {
      error = reason.message;
      console.warn('Sprint music could not load', reason);
      return false;
    });
  return {
    ready,
    get buffer() { return buffer; },
    update(rush, enabled = true, active = true) {
      const next = sprintMusicProfile(rush, enabled && active), t = ctx.currentTime;
      if (buffer && enabled && active && !playing) {
        source?.stop(); // cancel an old fade-out before replacing it at the same beat
        source?.disconnect();
        source = ctx.createBufferSource();
        source.buffer = buffer; source.loop = true;
        source.connect(filter);
        // A late download or re-enable fades in rather than starting at an already-open gain.
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0, t);
        target = { ...target, gain: 0 };
        source.start(t, (t - epoch) % buffer.duration);
        playing = true;
      } else if ((!enabled || !active) && playing) {
        source.stop(t + 0.12);
        playing = false;
      }
      if (next.cutoffHz !== target.cutoffHz) filter.frequency.setTargetAtTime(next.cutoffHz, t, 0.18);
      if (next.gain !== target.gain) gain.gain.setTargetAtTime(next.gain, t, next.gain === 0 ? 0.025 : 0.12);
      target = next;
    },
    stats: () => ({ ...target, gainNow: gain.gain.value, cutoffNowHz: filter.frequency.value,
      title: SPRINT_MUSIC.title, artist: SPRINT_MUSIC.artist, ready: !!buffer, error,
      bpm: SPRINT_MUSIC.bpm, duration: buffer?.duration ?? 0, playing, playbackRate: source?.playbackRate.value ?? 1 }),
  };
}
