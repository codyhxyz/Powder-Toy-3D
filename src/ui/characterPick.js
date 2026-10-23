import { h } from './dom.js';
import { GENDERS, bodiesFor } from '../pov/character.js';
import { liveYou } from './menu.js';

// Choose your character: the first thing a new player sees, before the start
// menu or the first loading screen (src/main.js). Animal Crossing asks on the
// train before you arrive, and the game remembers it; here it's the male or
// female wizard (public/you.webp, public/you-woman.webp). The answer is the
// player's gender (pov/character.js GENDERS), kept with the settings in
// this browser (app.js STORE), so every world dresses them from it: the wizard here, the village boy or girl in
// Animal Crossing. Settings → Character body changes it later.
// Pointed at, a card's character comes alive as on the loading screen (menu.js
// liveYou, Skyrim's): breathing and slowly turning, and holds still again when
// the pointer leaves. Built in the background once the screen is up; a phone
// (no hover) keeps the stills.
//   characterPicked()   a gender is already kept on this browser
//   chooseCharacter()   resolves with the screen's pick, once it's kept

const STORE = 'powder-toy-3d:settings';   // app.js STORE
const LEAVE_MS = 180;                     // the screen fades out this long after a pick (menu.css .cp.leaving)
const CHOICES = [
  { gender: 'male', label: 'Male wizard', src: '/you.webp', character: 'real' },
  { gender: 'female', label: 'Female wizard', src: '/you-woman.webp', character: 'woman' },
];
const HOVER = '(hover: hover) and (pointer: fine)';
const LIVE_IDLE_TIMEOUT_MS = 2000;   // the longest it waits for an idle moment to build them (menu.js YOU_IDLE_TIMEOUT_MS)
const LIVE_NO_IDLE_DELAY_MS = 200;   // its wait without requestIdleCallback (Safari)

function saved() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
}

export const characterPicked = () => GENDERS.includes(saved().gender);

// Keep the gender and the bodies it wears; app.js reads them when the game boots.
function remember(gender) {
  const s = saved();
  try { localStorage.setItem(STORE, JSON.stringify({ ...s, ...bodiesFor(gender, s.character) })); } catch { /* storage unavailable: app.js's defaults */ }
}

export function chooseCharacter() {
  return new Promise((resolve) => {
    const lives = [];
    const pick = (gender) => {
      remember(gender);
      for (const live of lives) live.stop();
      el.classList.add('leaving');
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      setTimeout(() => { el.remove(); resolve(gender); }, LEAVE_MS);
    };
    const el = h('div.cp', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-title' },
      h('h1.cp-title#cp-title', { text: 'Choose your character' }),
      h('div.cp-cards', {}, CHOICES.map((c) => {
        const still = h('img', { src: c.src, alt: '', width: 694, height: 1120, decoding: 'async' });
        const card = h('button.cp-card', { type: 'button', 'data-gender': c.gender, on: { click: () => pick(c.gender) } },
          still, h('span.cp-label', { text: c.label }));
        if (matchMedia(HOVER).matches) {
          const live = liveYou(card, still, { drag: false });
          lives.push(live);
          const go = () => live.start(c.character), hold = () => live.hold();
          card.addEventListener('pointerenter', go);
          card.addEventListener('focus', go);
          card.addEventListener('pointerleave', hold);
          card.addEventListener('blur', hold);
          const prepare = () => { if (card.isConnected) live.prepare(c.character); };
          if (self.requestIdleCallback) requestIdleCallback(prepare, { timeout: LIVE_IDLE_TIMEOUT_MS });
          else setTimeout(prepare, LIVE_NO_IDLE_DELAY_MS);
        }
        return card;
      })),
      h('p.cp-note', { text: 'You can change this later in Settings.' }));
    document.body.append(el);
    el.querySelector('button').focus({ preventScroll: true });
  });
}
