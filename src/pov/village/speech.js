import { AudioContext } from 'three';
import { PUNCH_CONTACT } from './actions.js';

// A body hit, not a pitched cartoon boing: bass weight + a short broadband
// skin/clothing crack (Halo-style melee). Seeded noise never touches game RNG.
export function punchImpact(rate) {
  const duration = 0.24, data = new Float32Array(Math.ceil(rate * duration));
  let seed = 1977, phase = 0, low = 0, body = 0;
  const lowK = 1 - Math.exp(-2 * Math.PI * 90 / rate), bodyK = 1 - Math.exp(-2 * Math.PI * 1800 / rate);
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    low += (noise - low) * lowK; body += (noise - body) * bodyK;
    phase += 2 * Math.PI * (52 + 105 * Math.exp(-t / 0.035)) / rate;
    const attack = Math.min(1, t / 0.0025), fade = (1 - t / duration) ** 2;
    const bass = 0.85 * Math.sin(phase) * Math.exp(-t / 0.075);
    const crack = (body - low) * 1.8 * Math.exp(-t / 0.022);
    data[i] = Math.tanh((bass + crack) * attack * fade) * 0.9;
  }
  return data;
}

// Original animalese: short voiced syllables with vowel formants, not recorded
// Nintendo audio. THREE's shared context also obeys browser audio suspension.
export function createSpeech() {
  let voices = [], serial = 0, effectSerial = 0, muted = false, played = 0;
  function stop(all = true) {
    serial++;
    if (all) effectSerial++;
    for (const v of voices.filter(v => all || !v.effect)) {
      try { v.source.stop(); } catch { /* already ended */ }
      v.source.disconnect(); v.gain.disconnect();
    }
    voices = all ? [] : voices.filter(v => v.effect);
  }
  async function speak(text, pitch = 1, delay = 0) {
    stop(false);
    if (muted || document.hidden) return;
    const token = serial;
    try {
      const ctx = AudioContext.getContext();
      await ctx.resume();
      if (token !== serial || muted || document.hidden) return;
      const rate = ctx.sampleRate;
      let at = ctx.currentTime + 0.02 + Math.max(0, delay);
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
  async function swing(contact = PUNCH_CONTACT) {
    if (muted || document.hidden) return;
    const token = effectSerial;
    try {
      const ctx = AudioContext.getContext(); await ctx.resume();
      if (token !== effectSerial || muted || document.hidden) return;
      // A short filtered air rush peaks as the fist extends, including on a miss.
      const duration = 0.17, buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      const at = ctx.currentTime + Math.max(0, contact - 0.065);
      source.buffer = buffer; filter.type = 'bandpass'; filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(1100, at); filter.frequency.exponentialRampToValueAtTime(320, at + duration);
      gain.gain.setValueAtTime(0.001, at); gain.gain.exponentialRampToValueAtTime(0.55, at + 0.065);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      source.connect(filter).connect(gain).connect(ctx.destination); source.start(at);
      const voice = { source, gain, effect: true }; voices.push(voice);
      source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); voices = voices.filter(v => v !== voice); };
    } catch { /* Silent when browser audio is unavailable. */ }
  }
  async function bonk() {
    if (muted || document.hidden) return;
    const token = effectSerial;
    try {
      const ctx = AudioContext.getContext(); await ctx.resume();
      if (token !== effectSerial || muted || document.hidden) return;
      const samples = punchImpact(ctx.sampleRate);
      const source = ctx.createBufferSource(), gain = ctx.createGain(), at = ctx.currentTime;
      source.buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      source.buffer.getChannelData(0).set(samples); gain.gain.value = 0.9;
      source.connect(gain).connect(ctx.destination); source.start(at);
      const voice = { source, gain, effect: true }; voices.push(voice);
      source.onended = () => { source.disconnect(); gain.disconnect(); voices = voices.filter(v => v !== voice); };
    } catch { /* Silent when browser audio is unavailable. */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { speak, swing, bonk, stop, get muted() { return muted; }, set muted(v) { muted = !!v; if (muted) stop(); }, get stats() { return { muted, queued: voices.length, played }; } };
}
