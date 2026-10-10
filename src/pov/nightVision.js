// Night Vision (the perk, pov/perks.js): goggles that switch themselves on in the dark, for the
// local player's view only. The picture itself is gfx/post.js's (an image intensifier's green
// phosphor, grain and vignette); this decides how much of it shows and how much light it adds.
//
// It works as a real intensifier tube's automatic brightness control (ABC) does: the gain is
// whatever brings the scene's mean brightness up to a set level, never more than the tube can
// give (perks.js nightGain, more with each stack), and in bright light the tube isn't needed at
// all. The scene's brightness is measured, not guessed: post.js's meter reads its log-average
// luminance (Reinhard et al. 2002, the auto-exposure key), so caves, nights and the shade under
// a storm cloud all turn it on, and walking back into daylight turns it off. No key, no setting.

// Middle grey: the exposed mean luminance the goggles hold the picture at (Reinhard's key value,
// photography's 18% grey).
const KEY = 0.18;
// The goggles switch on once the scene needs this much gain to reach the key (1 stop under it)...
const ON_GAIN = 2;
// ...and are fully on from this much (3 stops under).
const FULL_GAIN = 8;
// s for the gain and the switch to follow the light (e-folding): a tube's ABC and the eye's own
// first adjustment to the goggles both take a fraction of a second.
const ADAPT_S = 0.4;

const smooth01 = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

export function createNightVision(post) {
  let on = 0, gain = 1;
  const settings = post.settings;
  return {
    get on() { return on; },
    get gain() { return gain; },
    // every frame: maxGain is the local player's goggles' (perks.js nightGain; 0 without the perk)
    update(dt, maxGain) {
      settings.meter = maxGain > 0;
      const luma = post.sceneLuma;
      let wantOn = 0, wantGain = 1;
      if (maxGain > 0 && luma !== null) {
        const need = KEY / Math.max(luma * 2 ** settings.exposure, KEY / (FULL_GAIN * maxGain));
        wantGain = Math.min(maxGain, Math.max(1, need));
        wantOn = smooth01(Math.log2(need / ON_GAIN) / Math.log2(FULL_GAIN / ON_GAIN));
      }
      const k = 1 - Math.exp(-Math.max(dt, 0) / ADAPT_S);
      on += (wantOn - on) * k;
      gain += (wantGain - gain) * k;
      settings.night = on;
      settings.nightGain = gain;
    },
    // off at once (leaving first person)
    reset() { on = 0; gain = 1; settings.night = 0; settings.nightGain = 1; settings.meter = false; },
  };
}
