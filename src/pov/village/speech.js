import { AudioContext } from 'three';

// Original animalese: short voiced syllables with vowel formants, not recorded
// Nintendo audio. THREE's shared context also obeys browser audio suspension.
export function createSpeech() {
  let voices = [], serial = 0, muted = false, played = 0;
  function stop() {
    serial++;
    for (const v of voices) { try { v.source.stop(); } catch { /* already ended */ } v.source.disconnect(); v.gain.disconnect(); }
    voices = [];
  }
  async function speak(text, pitch = 1) {
    stop();
    if (muted || document.hidden) return;
    const token = serial;
    try {
      const ctx = AudioContext.getContext();
      await ctx.resume();
      if (token !== serial || muted || document.hidden) return;
      const rate = ctx.sampleRate;
      let at = ctx.currentTime + 0.02;
      for (const letter of text.toLowerCase().slice(0, 140)) {
        if (!/[a-z]/.test(letter)) { at += 0.04; continue; }
        const code = letter.charCodeAt(0), duration = 0.055;
        const buffer = ctx.createBuffer(1, Math.ceil(rate * duration), rate), data = buffer.getChannelData(0);
        const frequency = (260 + code % 7 * 27) * pitch;
        const formants = [[700, 1200], [500, 1900], [300, 2300], [500, 900], [350, 800]][code % 5];
        for (let i = 0; i < data.length; i++) {
          const t = i / rate, envelope = Math.sin(Math.PI * i / data.length) ** 2;
          let value = 0;
          for (let h = 1; h <= 12; h++) {
            const hz = frequency * h;
            const weight = 0.08 / h + formants.reduce((s, f) => s + Math.exp(-(((hz - f) / 220) ** 2)), 0) * 0.25;
            value += Math.sin(2 * Math.PI * hz * t) * weight;
          }
          data[i] = value * envelope * 0.23;
        }
        const source = ctx.createBufferSource(), gain = ctx.createGain();
        source.buffer = buffer; gain.gain.value = 0.65;
        source.connect(gain).connect(ctx.destination); source.start(at); at += 0.073;
        const voice = { source, gain }; voices.push(voice); played++;
        source.onended = () => { source.disconnect(); gain.disconnect(); voices = voices.filter(v => v !== voice); };
      }
    } catch { /* Audio unavailable: the full dialogue remains readable. */ }
  }
  async function bonk() {
    if (muted || document.hidden) return;
    const token = serial;
    try {
      const ctx = AudioContext.getContext(); await ctx.resume();
      if (token !== serial || muted || document.hidden) return;
      const source = ctx.createOscillator(), gain = ctx.createGain(), at = ctx.currentTime;
      source.type = 'sine'; source.frequency.setValueAtTime(420, at);
      source.frequency.exponentialRampToValueAtTime(95, at + 0.16);
      source.frequency.exponentialRampToValueAtTime(180, at + 0.25);
      gain.gain.setValueAtTime(0.001, at); gain.gain.exponentialRampToValueAtTime(0.22, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.28);
      source.connect(gain).connect(ctx.destination); source.start(at); source.stop(at + 0.3);
      const voice = { source, gain }; voices.push(voice);
      source.onended = () => { source.disconnect(); gain.disconnect(); voices = voices.filter(v => v !== voice); };
    } catch { /* Silent when browser audio is unavailable. */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { speak, bonk, stop, get muted() { return muted; }, set muted(v) { muted = !!v; if (muted) stop(); }, get stats() { return { muted, queued: voices.length, played }; } };
}
