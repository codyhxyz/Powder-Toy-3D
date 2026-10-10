import { h } from '../ui/dom.js';

// The POV HUD: crosshair (with its bloom) and hitmarker, the Energy Shield (Halo's bar over health), health and breath, the perks held (Noita's row of
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
// The shield bar: Halo's, which flashes when a hit lands on it, pops and blinks red once it's
// broken, and sweeps back up as it refills (pov.css animates each state).
const SHIELD_HIT_MS = 160;              // ms a hit's flash lasts (pov.css .pov-shield.hit)
const SHIELD_POP_MS = 420;              // ms the break's pop lasts (pov.css .pov-shield.pop)
// Statuses (status.js): Noita's row of icons, each with its seconds left and a bar that runs down.
const STATUS_ENDING_S = 1.5;            // s left from which an icon blinks (about to wear off)
const STATUS_TINT = 0.4;                // opacity of the first-person tint while a stain with a screen colour is on

const round = (x) => Math.round(x * FX_STEPS) / FX_STEPS;
const key = (k) => h('kbd', { text: k });

export function createPovHud() {
  const fx = {
    heat: h('div.pov-fx.pov-heat'),
    frost: h('div.pov-fx.pov-frost'),
    acid: h('div.pov-fx.pov-acid'),
    stain: h('div.pov-fx.pov-stain'),
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
  const shieldFill = h('div.pov-fill');
  const shieldRow = h('div.pov-bar.pov-shield', { 'aria-label': 'Shield' },
    h('span.pov-ic', { html: '<svg viewBox="0 0 16 16"><path d="M8 1.5 13.5 3.6v4.1c0 3.3-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.5-5.5-6.8V3.6z"/></svg>' }),
    h('div.pov-track', {}, shieldFill));
  const perkRow = h('div.pov-perks');   // above health, in the same panel
  const statusRow = h('div.pov-statuses');   // above the perks
  const vitals = h('div.pov-vitals.panel', {}, statusRow, perkRow, shieldRow, healthRow, breathRow, jetRow);

  const lock = h('div.pov-lock.panel', {}, h('b', { text: 'Click' }), ' to look around', h('span.pov-dot', { text: '·' }), key('V'), ' to leave');

  const deathCause = h('div.pov-cause');
  const deathCount = h('b');
  const death = h('div.pov-death', {},
    h('div.pov-died', { text: 'You died' }),
    deathCause,
    h('div.pov-respawn', {}, 'Back at the drop point in ', deathCount, h('span.pov-dot', { text: '·' }), 'click or ', key('Space'), ' now', h('span.pov-dot', { text: '·' }), key('V'), ' for god view'));

  const hint = h('div.pov-hint.panel', {},
    h('span', {}, key('W'), key('A'), key('S'), key('D'), ' move'),
    h('span', {}, key('Space'), ' jump, hold to fly'),
    h('span', {}, key('Shift'), ' sprint'),
    h('span', {}, key('C'), ' swim down'),
    h('span', {}, key('F'), ' kick'),
    h('span', {}, key('Z'), ' zoom'),
    h('span', {}, key('F5'), ' third person'),
    h('span', {}, key('V'), ' god view'));

  const root = h('div.pov-hud', { 'aria-hidden': 'true' },
    fx.heat, fx.frost, fx.acid, fx.stain, fx.hurt, cross, hitmark, vitals, lock, death, hint);
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
  let lastShield = 0, shieldHitT = 0, shieldPopT = 0;
  let perkVersion = -1, perkSet = null;
  let statusVersion = -1, statusSet = null, statusIcons = [];
  const statusPeak = new Map();   // key → the most seconds it had left while on (its bar's full length)
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
    // s = { dt, health, breath, jetFuel (0..1), jetting, perks (pov/perks.js set), status (pov/status.js set), feel {heat, cold, acid, hurt},
    //       shield, shieldMax (base lives; no bar while shieldMax is 0), shieldCharging,
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
      // statuses: an icon each, its seconds left and a bar running down; redrawn when one comes or goes
      const st = s.status;
      if (st && (st !== statusSet || st.version !== statusVersion)) {
        statusSet = st; statusVersion = st.version;
        statusIcons = st.list().map(({ key, def }) => {
          const time = h('b'), bar = h('u');
          const el = h('span.pov-st', { title: def.name, style: { '--c': def.color } }, h('i', { text: def.icon }), time, bar);
          return { key, el, time, bar };
        });
        for (const k of [...statusPeak.keys()]) if (!st.has(k)) statusPeak.delete(k);
        statusRow.replaceChildren(...statusIcons.map((x) => x.el));
      }
      for (const x of statusIcons) {
        const left = st?.time(x.key) ?? 0;
        const peak = Math.max(statusPeak.get(x.key) ?? 0, left);
        statusPeak.set(x.key, peak);
        set(x.time, 'text', String(Math.ceil(left)));
        set(x.bar, 'transform', `scaleX(${peak > 0 ? round(left / peak) : 0})`);
        set(x.el, '.ending', left < STATUS_ENDING_S);
      }
      const screen = live ? st?.screen : null;
      if (screen) set(fx.stain, '--c', screen);
      set(fx.stain, 'opacity', screen ? String(STATUS_TINT) : '0');
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
      // the shield: flash on a hit, pop when it breaks, blink while empty, a sweep while it refills
      const sMax = s.shieldMax ?? 0, sh = sMax > 0 ? Math.max(0, Math.min(1, (s.shield ?? 0) / sMax)) : 0;
      const shAbs = s.shield ?? 0;   // compared unscaled, so another stack (a bigger maximum) isn't a hit
      if (sMax > 0 && shAbs < lastShield) {
        shieldHitT = SHIELD_HIT_MS / 1000;
        if (sh <= 0) shieldPopT = SHIELD_POP_MS / 1000;
      }
      lastShield = shAbs;
      shieldHitT = Math.max(0, shieldHitT - s.dt);
      shieldPopT = Math.max(0, shieldPopT - s.dt);
      set(shieldRow, '.show', sMax > 0);
      set(shieldFill, 'transform', `scaleX(${round(sh)})`);
      set(shieldRow, '.hit', shieldHitT > 0);
      set(shieldRow, '.pop', shieldPopT > 0);
      set(shieldRow, '.empty', sMax > 0 && sh <= 0);
      set(shieldRow, '.charging', !!s.shieldCharging);
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
