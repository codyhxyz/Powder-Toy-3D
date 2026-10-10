import { h } from '../ui/dom.js';

// The POV HUD: crosshair (with its bloom) and hitmarker, health and breath, the perks held (Noita's row of
// icons), screen effects for what the body feels, the pointer-lock prompt, the death screen and the entry hint. Styles
// in pov.css. update() runs every frame and only touches the DOM when a
// (rounded) value changes.

const BREATH_SHOWN_BELOW = 0.999;       // breath bar shows while breath is below this
const JET_SHOWN_BELOW = 0.999;          // jetpack fuel bar shows while the tank is below this
const HEALTH_LOW = 0.3;                 // the health bar turns urgent below this
const TRAIL_RATE = 1.6;                 // 1/s: the "damage taken" trail catches up with health this fast
const TRAIL_HOLD = 0.35;                // s the trail waits after a hit before it starts catching up
const FX_STEPS = 100;                   // effect opacities are rounded to 1/this (fewer style writes)
const HINT_S = 7;                       // s the entry hint stays up
const HURT_FLASH_GAIN = 0.85;           // opacity of the red flash at feel.hurt = 1
const CROSS_GAP_PX = 4;                 // px from the centre to the crosshair ticks at rest
const BLOOM_GAP_PX = 9;                 // px more at full bloom (just after a shot)
const GAP_STEPS = 2;                    // the gap is rounded to 1/this px (fewer style writes)

const round = (x) => Math.round(x * FX_STEPS) / FX_STEPS;
const key = (k) => h('kbd', { text: k });

export function createPovHud() {
  const fx = {
    heat: h('div.pov-fx.pov-heat'),
    frost: h('div.pov-fx.pov-frost'),
    acid: h('div.pov-fx.pov-acid'),
    hurt: h('div.pov-fx.pov-hurt'),
  };
  const cross = h('div.pov-cross', {}, h('i'), h('i'), h('i'), h('i'), h('b'));
  const hitmark = h('div.pov-hitmark');

  const healthFill = h('div.pov-fill'), healthTrail = h('div.pov-trail');
  const breathFill = h('div.pov-fill');
  const healthRow = h('div.pov-bar.pov-health', { 'aria-label': 'Health' },
    h('span.pov-ic', { html: '<svg viewBox="0 0 16 16"><path d="M8 14s-5.5-3.4-5.5-7.4A3 3 0 0 1 8 4.4a3 3 0 0 1 5.5 2.2C13.5 10.6 8 14 8 14z"/></svg>' }),
    h('div.pov-track', {}, healthTrail, healthFill));
  const breathRow = h('div.pov-bar.pov-breath', { 'aria-label': 'Breath' },
    h('span.pov-ic', { html: '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="9.5" r="3"/><circle cx="11" cy="6" r="2"/><circle cx="11.5" cy="12" r="1.2"/></svg>' }),
    h('div.pov-track', {}, breathFill));
  const jetFill = h('div.pov-fill');
  const jetRow = h('div.pov-bar.pov-jet', { 'aria-label': 'Jetpack' },
    h('span.pov-ic', { html: '<svg viewBox="0 0 16 16"><path d="M8 1.5c.6 2.4 4 4.2 4 8a4 4 0 0 1-8 0c0-1.7.9-2.7 1.6-3.4.2 1.2.8 2 1.6 2.3C6.8 6 7.3 3.6 8 1.5z"/></svg>' }),
    h('div.pov-track', {}, jetFill));
  const perkRow = h('div.pov-perks');   // above health, in the same panel
  const vitals = h('div.pov-vitals.panel', {}, perkRow, healthRow, breathRow, jetRow);

  const lock = h('div.pov-lock.panel', {}, h('b', { text: 'Click' }), ' to look around', h('span.pov-dot', { text: '·' }), key('F'), ' to leave');

  const deathCause = h('div.pov-cause');
  const deathCount = h('b');
  const death = h('div.pov-death', {},
    h('div.pov-died', { text: 'You died' }),
    deathCause,
    h('div.pov-respawn', {}, 'Back at the drop point in ', deathCount, h('span.pov-dot', { text: '·' }), 'click or ', key('Space'), ' now', h('span.pov-dot', { text: '·' }), key('F'), ' for god view'));

  const hint = h('div.pov-hint.panel', {},
    h('span', {}, key('W'), key('A'), key('S'), key('D'), ' move'),
    h('span', {}, key('Space'), ' jump, hold to fly'),
    h('span', {}, key('Shift'), ' sprint'),
    h('span', {}, key('C'), ' swim down'),
    h('span', {}, key('X'), ' kick'),
    h('span', {}, key('V'), ' third person'),
    h('span', {}, key('F'), ' leave'));

  const root = h('div.pov-hud', { 'aria-hidden': 'true' },
    fx.heat, fx.frost, fx.acid, fx.hurt, cross, hitmark, vitals, lock, death, hint);
  document.body.append(root);

  // DOM writes only on change
  const last = new Map();
  const set = (el, prop, v) => {
    const k = el;
    let m = last.get(k);
    if (!m) last.set(k, (m = {}));
    if (m[prop] === v) return;
    m[prop] = v;
    if (prop.startsWith('--')) el.style.setProperty(prop, v);
    else if (prop === 'text') el.textContent = v;
    else if (prop.startsWith('.')) el.classList.toggle(prop.slice(1), v);
    else el.style[prop] = v;
  };

  let trail = 1, trailHold = 0, lastHealth = 1;
  let perkVersion = -1, perkSet = null;
  let hintTimer = 0;

  return {
    show(v) {
      set(root, '.on', v);
      if (!v) { set(hint, '.show', false); clearTimeout(hintTimer); }
    },
    showHint() {
      set(hint, '.show', true);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => set(hint, '.show', false), HINT_S * 1000);
    },
    // s = { dt, health, breath, jetFuel (0..1), jetting, perks (pov/perks.js set), feel {heat, cold, acid, hurt}, 
    //       dead, cause, respawnIn (s), locked, swooping, aimInReach, aimValid, third }
    update(s) {
      const live = !s.dead && !s.swooping;
      set(cross, '.show', live);
      set(cross, '.reach', !!s.aimInReach);
      set(cross, '.third', !!s.third);
      set(vitals, '.show', live);
      // perks: an icon each, with its stacks, redrawn when the set changes
      if (s.perks && (s.perks !== perkSet || s.perks.version !== perkVersion)) {
        perkSet = s.perks; perkVersion = s.perks.version;
        perkRow.replaceChildren(...s.perks.list().map(({ perk, n }) => h('span.pov-perk', { title: `${perk.name}: ${perk.desc}`, style: { '--c': perk.color } },
          h('i', { text: perk.icon }), n > 1 ? h('b', { text: `×${n}` }) : null)));
      }
      set(lock, '.show', live && !s.locked);

      // health, with a trail that shows what the last hit took
      const hp = Math.max(0, Math.min(1, s.health));
      if (hp < lastHealth) trailHold = TRAIL_HOLD;
      if (hp > trail) trail = hp;
      lastHealth = hp;
      if (trailHold > 0) trailHold -= s.dt;
      else trail += (hp - trail) * (1 - Math.exp(-TRAIL_RATE * s.dt));
      set(healthFill, 'transform', `scaleX(${round(hp)})`);
      set(healthTrail, 'transform', `scaleX(${round(trail)})`);
      set(healthRow, '.low', hp < HEALTH_LOW);
      set(breathRow, '.show', s.breath < BREATH_SHOWN_BELOW);
      set(breathFill, 'transform', `scaleX(${round(Math.max(0, s.breath))})`);
      set(breathRow, '.low', s.breath < HEALTH_LOW);
      const fuel = s.jetFuel ?? 1;
      set(jetRow, '.show', fuel < JET_SHOWN_BELOW || !!s.jetting);
      set(jetFill, 'transform', `scaleX(${round(Math.max(0, fuel))})`);
      set(jetRow, '.low', fuel < HEALTH_LOW);

      // what the body feels
      const f = s.feel ?? {};
      set(fx.heat, 'opacity', String(round(f.heat ?? 0)));
      set(fx.frost, 'opacity', String(round(f.cold ?? 0)));
      set(fx.acid, 'opacity', String(round(f.acid ?? 0)));
      set(fx.hurt, 'opacity', String(round((f.hurt ?? 0) * HURT_FLASH_GAIN)));

      // death screen
      set(death, '.show', !!s.dead);
      if (s.dead) {
        set(hint, '.show', false);
        set(deathCause, 'text', s.cause || '');
        set(deathCount, 'text', `${Math.max(1, Math.ceil(s.respawnIn))} s`);
      }
    },
    // Shot feedback (feel.js), every POV frame: bloom 0..1 spreads the
    // crosshair, hit 0..1 is the hitmarker's opacity, broke brightens it.
    feedback({ bloom = 0, hit = 0, broke = false }) {
      const gap = Math.round((CROSS_GAP_PX + bloom * BLOOM_GAP_PX) * GAP_STEPS) / GAP_STEPS;
      set(cross, '--gap', `${gap}px`);
      set(hitmark, 'opacity', String(round(hit)));
      set(hitmark, '.broke', !!broke);
    },
    dispose() { root.remove(); },
  };
}
