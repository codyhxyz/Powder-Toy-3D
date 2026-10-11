import { h } from '../ui/dom.js';
import { rankOf } from './medals.js';
import './feel.css';

// The player's own medals on screen (medals.js decides who earned what). Halo 3's
// way: each pops in at the bottom left, stacked above the motion tracker
// (tracker.js), newest at the bottom, and fades after a few seconds. A
// multi-kill or a spree is also a short line high in the centre, under the
// objective (game/hud.js owns the line above it). Halo 3's announcer calls
// each medal as it appears (Halopedia, "Double Kill"); here a deep, slow
// synthesized voice (the browser's speechSynthesis) calls the rarest medal of a
// kill, and stays silent where the browser has none. The stings are audio.js's
// ('game:medal'). Styles in feel.css.

const MEDAL_S = 3;              // s a medal stays (Halo 3's isn't documented; ours: long enough to read a stack)
const MEDAL_MAX = 6;            // medals shown at once; the oldest goes first
const LINE_S = 2.5;             // s the centre line stays
const LINE_KINDS = new Set(['multi', 'spree']);   // what earns the centre line
const VOICE_RATE = 0.8;         // × the voice's normal pace: slow, an arena announcer's
const VOICE_PITCH = 0.3;        // 0..2 (1 normal): deep
const VOICE_VOLUME = 0.9;       // 0..1
const VOICE_LANG = /^en/i;      // an English voice...
const VOICE_DEEP = /daniel|fred|ralph|alex|male|bruce|aaron|arthur/i;   // ...a deeper one where the system has it
const VOICE_AFTER_CANCEL_MS = 60;   // ms between cutting an older call and speaking (Chrome can drop a speak() in the cancel's tick)
const TEXT_GLYPH = '\uFE0E';       // variation selector 15: a symbol drawn as text, not as a colour emoji

export function createMedalHud() {
  const stack = h('div.feel-medals');
  const line = h('div.feel-line');
  const root = h('div.feel-medal-hud', { 'aria-hidden': 'true' }, stack, line);
  document.body.append(root);
  const shown = [];   // { el, at }
  let lineUntil = -Infinity;

  // the browser's voice, if it has one: every call is guarded, so a missing or broken one is silence
  const speech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speechSynthesis : null;
  let voice = null;
  function pickVoice() {
    try {
      const all = speech?.getVoices?.() ?? [];
      const en = all.filter((v) => VOICE_LANG.test(v.lang));
      voice = en.find((v) => VOICE_DEEP.test(v.name)) ?? en[0] ?? null;
    } catch { voice = null; }
  }
  try { pickVoice(); speech?.addEventListener?.('voiceschanged', pickVoice); } catch { /* no voices */ }
  let sayTimer = 0;
  function say(text) {
    if (!speech || document.hidden) return;
    const speak = () => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.rate = VOICE_RATE; u.pitch = VOICE_PITCH; u.volume = VOICE_VOLUME;
        speech.speak(u);
      } catch { /* silent */ }
    };
    clearTimeout(sayTimer);
    try {
      if (!speech.speaking && !speech.pending) { speak(); return; }
      speech.cancel();   // the newest medal, not a queue of old ones
      sayTimer = setTimeout(speak, VOICE_AFTER_CANCEL_MS);
    } catch { /* silent */ }
  }

  function popLine(text, now) {
    line.textContent = text;
    line.classList.remove('on');
    void line.offsetWidth;   // restart its pop
    line.classList.add('on');
    lineUntil = now + LINE_S;
  }

  function badge(m) {
    return h(`div.feel-medal.${m.kind}`, {},
      h('span.feel-badge', {}, h('b', { text: `${m.glyph ?? ''}${TEXT_GLYPH}` })),
      h('span.feel-name', { text: m.name }));
  }

  return {
    show(v) { root.classList.toggle('on', v); },
    clear() {
      for (const s of shown) s.el.remove();
      shown.length = 0;
      lineUntil = -Infinity;
      line.classList.remove('on');
      clearTimeout(sayTimer);
      try { speech?.cancel(); } catch { /* silent */ }
    },
    // the player's medals from one event ([{ key, name, kind, glyph }]), at wall time now (s)
    award(list, now) {
      if (!list.length) return;
      for (const m of list) {
        const el = badge(m);
        stack.append(el);
        shown.push({ el, at: now });
      }
      while (shown.length > MEDAL_MAX) shown.shift().el.remove();
      const top = list.reduce((a, b) => (rankOf(b.key) > rankOf(a.key) ? b : a));
      if (LINE_KINDS.has(top.kind)) popLine(top.name, now);
      say(top.name);
    },
    // a line in the centre on its own (a power-up taken)
    note(text, now) { popLine(text, now); },
    update(now) {
      while (shown.length && now - shown[0].at > MEDAL_S) shown.shift().el.remove();
      if (now > lineUntil && line.classList.contains('on')) line.classList.remove('on');
    },
    dispose() { this.clear(); root.remove(); },
  };
}
