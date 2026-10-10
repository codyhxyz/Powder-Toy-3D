import { ELEMENTS, E } from '../elements.js';
import { SAVING_GRACE_HEALTH } from './perks.js';

// Health, breath and everything that hurts the first-person body. The player
// (player.js) measures the cells around the body every frame and hands them
// here; this module turns them into damage, a cause of death and the 0..1
// "feel" intensities the screen effects draw. Health and breath run 0..1.
//
// The body's perks (perks.js) change what it can take: Fire Immunity (no
// burns), Explosion Immunity (no blast or slam damage), Breathless (breath
// never drains), Extra Health (every hurt is divided by the larger maximum, so
// health stays 0..1), Saving Grace and Extra Life. Death takes the perks.
//
// Energy Shield is Halo's: a recharging layer over health, in the same units
// as a hurt before Extra Health divides it (1 = one base life). It takes what
// strikes the body (weapons, blasts, slams) first, and what's left of a blow
// goes on to health. What the body is in (heat, cold, acid) and choking get
// past it: a shield is a barrier outside the skin, not air or insulation. A
// lethal blow (the knife's backstab) ignores it, as a melee to the back kills
// through shields in Halo 2 and 3. Any hurt holds off the recharge for
// SHIELD_DELAY; then it fills in SHIELD_REFILL from empty. Its events (on the
// body's emitter): 'shield' { state: 'hit' | 'break' | 'recharge' | 'full', amount? }.

// One cell is about this many metres (pov/constants.js: the body is 5.5 cells ≈ 1.7 m).
export const CELL_METERS = 0.3;

// ---- skin temperature ----
// The skin trades heat with every cell touching or inside the body through the
// sim's own conductances (elements.js cond): flux per cell ∝ min(SKIN_COND,
// cond)·ΔT, so hot air (cond 0.0005) barely warms you, steam scalds and lava
// cooks. Blood flow pulls the skin back toward the core.
const BODY_T = 37;              // °C, core temperature (the skin starts here)
const SKIN_COND = 0.03;         // the body's conductance on the element table's scale (like water: bodies are mostly water)
const SKIN_EXCHANGE = 2;        // 1/s, skin temperature rate per unit of mean relative contact conductance
const SKIN_RECOVER = 1;         // 1/s, blood flow pulling the skin back to BODY_T
const SKIN_BURN_T = 48;         // °C, skin hotter than this burns...
const HEAT_DAMAGE = 0.006;      // ...health/s per °C above it
const SKIN_COLD_T = 15;         // °C, skin colder than this freezes...
const COLD_DAMAGE = 0.012;      // ...health/s per °C below it

// ---- contact ----
const ACID_DAMAGE = 0.6;        // health/s with the whole skin in acid (scales with the share of contact cells)

// ---- breath ----
const BREATH_TIME = 15;         // s of held breath, full to empty
const BREATH_RECOVER_TIME = 3;  // s to refill from empty
const SUFFOCATE_DAMAGE = 0.25;  // health/s once breath is gone (drowning, buried)

// ---- impacts ----
// Slams (a blast throwing the body into a wall or ceiling; landings never
// hurt): safe up to the speed of a fall of SAFE_FALL_M, lethal from that of
// LETHAL_FALL_M, with damage linear in impact energy (v²) between. The player converts these
// heights to impact speeds with its own gravity (impactSpeedFor).
export const SAFE_FALL_M = 3;
export const LETHAL_FALL_M = 15;

// ---- energy shield (Halo 3's, Halopedia "Energy shielding": regeneration starts 5 s after
// the last hit and takes 2 s from a total drain; its size per stack is in perks.js) ----
const SHIELD_DELAY = 5;         // s after the last hurt before the shield starts to refill
const SHIELD_REFILL = 2;        // s to refill from empty
const SHIELD_FULL_EPS = 1e-6;   // a shield this close to full counts as full

// ---- blasts ----
const BLAST_HURT_P = 8;         // air pressure (sim units) the body shrugs off...
const BLAST_DAMAGE = 0.4;       // ...health/s per unit above it
// Your own blast (a rocket or bomb you set off: ownBlast) hurts you less, the
// shooter games' rule (Quake III halves self-splash, G_Damage), so a rocket
// jump is a price, not a death: one at your feet costs about a quarter of your
// health (its full pressure would take ~2.4, measured by tools/weapons-check.mjs).
const SELF_BLAST_SHARE = 0.1;   // share of blast damage taken...
const SELF_BLAST_TIME = 1;      // ...for this many s after your own blast goes off

// ---- feel (0..1 screen-effect intensities) ----
const FEEL_HEAT_SPAN = 40;      // °C of skin above BODY_T for full heat glow
const FEEL_COLD_SPAN = 30;      // °C of skin below BODY_T for full frost
const FEEL_ACID_SHARE = 0.25;   // share of contact cells that are acid for a full acid tint
const FEEL_RATE = 6;            // 1/s, heat/cold/acid feel follows its target at this rate
const HURT_FEEL_GAIN = 4;       // hurt flash per unit of health lost...
const HURT_FEEL_FADE = 1.5;     // ...fading at this much per second

// ---- gibs: Quake's rule ----
// The blow that kills a body bursts it into meat (elements.js MEAT; player.js
// lays the cells) when it drives health to GIB_HEALTH or below: Quake III's
// GIB_HEALTH, -40 of 100 (bg_public.h; g_combat.c player_die), as Quake's
// PlayerDie (health < -40). Health is kept below zero for it. As in Quake III
// the corpse can still be gibbed (player_die keeps takedamage, "can still be
// gibbed"; body_die): violent damage (blasts, slams, blows) keeps taking its
// health down after death, so a blast that lasts several frames is one blow
// at any frame rate. Burns, cold, acid and drowning don't: a corpse left in a
// fire doesn't burst.
export const GIB_HEALTH = -0.4;

// ---- eating (Cruelty Squad: no regeneration; you heal by eating cooked gibs) ----
// Each COOKED_MEAT cell eaten heals this much (of the base 1, so Extra Health
// stretches it as it stretches hurts): a body's gibs, ~13 cells (player.js
// GIB_CELLS), heal a body from nothing about once over. Raw MEAT heals nothing.
export const EAT_HEAL = 0.08;

// 'hurt' events: continuous damage is batched until it adds up to this much
// health, or HURT_EVENT_INTERVAL passes, so the shell isn't flooded every frame.
const HURT_EVENT_MIN = 0.02;
const HURT_EVENT_INTERVAL = 0.5;   // s

const lower = (id) => ELEMENTS[id].name.toLowerCase();
const fmtT = (T) => `${Math.round(T).toLocaleString('en-US')} °C`;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const relCond = (id) => Math.min(SKIN_COND, ELEMENTS[id].cond) / SKIN_COND;

function heatCause(id, T) {
  if (id === E.LAVA) return `Killed by lava, ${fmtT(T)}`;
  if (id === E.FIRE || id === E.EMPTY) return 'Burned';
  return `Burned by ${lower(id)}, ${fmtT(T)}`;
}

export function createVitals(emit, perks = null) {
  const has = (key) => !!perks?.has(key);
  const shieldMax = () => perks?.shieldMax ?? 0;
  const v = {
    health: 1, breath: 1, skinT: BODY_T,
    shield: 0,                 // energy shield left, base lives (0..shieldMax)
    shieldWait: 0,             // s before it starts to refill
    shieldCharging: false,     // refilling now
    feel: { heat: 0, cold: 0, acid: 0, hurt: 0 },
    dead: false, cause: '',
    get shieldMax() { return shieldMax(); },
    gibbed: false,
    under: 0,          // health below zero (≤ 0): the overkill Quake's gib rule reads
  };
  let pending = 0, pendingCause = '', pendingAge = 0;
  let selfBlastT = 0;   // s left of your own blast's reduced damage

  v.reset = () => {
    v.health = 1; v.breath = 1; v.skinT = BODY_T;
    v.shield = shieldMax(); v.shieldWait = 0; v.shieldCharging = false;
    Object.assign(v.feel, { heat: 0, cold: 0, acid: 0, hurt: 0 });
    v.dead = false; v.cause = '';
    v.gibbed = false; v.under = 0;
    pending = 0; pendingCause = ''; pendingAge = 0;
  };

  function flushHurt() {
    if (pending > 0) emit('hurt', { amount: pending, cause: pendingCause });
    pending = 0; pendingAge = 0;
  }

  // Health below zero: the killing blow's overkill, and violent damage to the
  // corpse after it (GIB_HEALTH). Past GIB_HEALTH the body bursts: 'gib'.
  function overkill(amount, cause) {
    v.under -= amount;
    if (v.gibbed || v.under > GIB_HEALTH) return;
    v.gibbed = true;
    emit('gib', { cause });
  }

  // Take `amount` health. `burst` (an impact or a blast) is reported at once.
  // shielded: the Energy Shield takes it first (blows, blasts, slams);
  // lethal: it takes all the health there is, shield or not (a backstab);
  // violent: a blast, slam or blow (what the shield takes, or any burst), which can gib the
  // body and keeps hitting its corpse (GIB_HEALTH).
  function hurt(amount, cause, burst = false, { shielded = false, lethal = false, violent = shielded || burst } = {}) {
    if (!(amount > 0)) return;
    const maxHealth = perks?.maxHealth ?? 1;
    if (v.dead) {
      if (violent) overkill(amount / maxHealth, cause);
      return;
    }
    // any hurt holds the shield's refill off (Halo)
    v.shieldWait = SHIELD_DELAY;
    v.shieldCharging = false;
    if (lethal) amount = v.health * maxHealth;
    else if (shielded && v.shield > 0) {
      const took = Math.min(v.shield, amount);
      v.shield -= took;
      amount -= took;
      emit('shield', { state: v.shield > 0 ? 'hit' : 'break', amount: took });
      if (!(amount > 0)) return;
    }
    if (shielded) emit('wound', { amount, cause });   // a blow, fall or blast (not heat, cold, acid or choking): it bleeds
    amount /= maxHealth;
    const before = v.health;
    v.health = Math.max(0, v.health - amount);
    // Saving Grace: a blow that would kill from above the last sliver leaves the sliver
    if (v.health <= 0 && before > SAVING_GRACE_HEALTH && has('SAVING_GRACE')) v.health = SAVING_GRACE_HEALTH;
    v.feel.hurt = Math.min(1, v.feel.hurt + amount * HURT_FEEL_GAIN);
    pending += amount;
    pendingCause = cause;
    if (burst || pending >= HURT_EVENT_MIN) flushHurt();
    if (v.health <= 0) {
      flushHurt();
      // Extra Life: back on your feet where you fell, with your perks
      if (perks?.take('EXTRA_LIFE')) {
        v.health = 1; v.breath = 1; v.skinT = BODY_T;
        emit('revive', { cause });
        return;
      }
      v.dead = true;
      v.cause = cause;
      perks?.clear();
      emit('death', { cause });
      if (violent) overkill(amount - before, cause);
    }
  }
  v.hurt = hurt;

  // Heal by eating `cells` cells of cooked meat (EAT_HEAL each), up to full
  // health. How many cells would fill this body: eatWant().
  v.eat = (cells) => {
    if (v.dead || !(cells > 0)) return;
    v.health = Math.min(1, v.health + cells * EAT_HEAL / (perks?.maxHealth ?? 1));
  };
  v.eatWant = () => (v.dead ? 0 : Math.ceil((1 - v.health) * (perks?.maxHealth ?? 1) / EAT_HEAL - 1e-9));
  // a blast of your own just went off (see SELF_BLAST_SHARE)
  v.ownBlast = () => { selfBlastT = SELF_BLAST_TIME; };

  // The shield: Halo's refill after the delay; a smaller maximum (death took the perk) clips it.
  function shieldUpdate(dt) {
    const max = shieldMax();
    if (v.shield > max) v.shield = max;
    if (v.dead || max <= 0) { v.shieldCharging = false; return; }
    if (v.shieldWait > 0) { v.shieldWait = Math.max(0, v.shieldWait - dt); return; }
    if (v.shield >= max - SHIELD_FULL_EPS) { v.shield = max; return; }
    if (!v.shieldCharging) { v.shieldCharging = true; emit('shield', { state: 'recharge' }); }
    v.shield = Math.min(max, v.shield + max * dt / SHIELD_REFILL);
    if (v.shield >= max - SHIELD_FULL_EPS) { v.shield = max; v.shieldCharging = false; emit('shield', { state: 'full' }); }
  }

  // Impact on landing or slamming into something. speed: cells/s into the
  // surface; safe/lethal: impact speeds (cells/s) for SAFE_FALL_M and
  // LETHAL_FALL_M; fallCells: height fallen (vertical impacts), else 0.
  v.impact = (speed, safe, lethal, fallCells, surfaceId) => {
    if (speed <= safe || has('EXPLOSION_IMMUNITY')) return;   // slams only come from blasts (landings never hurt)
    const dmg = (speed * speed - safe * safe) / (lethal * lethal - safe * safe);
    const m = Math.round(fallCells * CELL_METERS);
    const cause = fallCells > 0 && m >= 1 ? `Fell ${m} m` : `Slammed into ${surfaceId >= 0 ? lower(surfaceId) : 'the wall'}`;
    hurt(dmg, cause, true, { shielded: true });
  };

  // env (measured by the player this frame):
  //   contactId, contactT: cells touching or inside the body (arrays, n = contactN)
  //   headInLiquid, liquidId: is the head under liquid, and which
  //   buriedId: powder or solid the head is buried in, or -1
  //   pressure: mean air pressure over the body
  v.update = (dt, env) => {
    const f = v.feel;
    f.hurt = Math.max(0, f.hurt - HURT_FEEL_FADE * dt);
    pendingAge += dt;
    if (pendingAge >= HURT_EVENT_INTERVAL) flushHurt();

    // skin temperature: exact exponential step toward the equilibrium of the
    // contact flux and blood flow (stable for any dt)
    const n = env.contactN;
    let kSum = 0, kT = 0, acid = 0, worst = 0, worstId = E.EMPTY, worstT = BODY_T;
    for (let i = 0; i < n; i++) {
      const id = env.contactId[i], T = env.contactT[i];
      const k = relCond(id);
      kSum += k; kT += k * T;
      const flux = k * Math.abs(T - v.skinT);
      if (flux > worst) { worst = flux; worstId = id; worstT = T; }
      if (ELEMENTS[id]?.acid) acid++;   // acid, caustic gas
    }
    // a smaller body (Shrink: env.size) has more skin per mass, so it trades heat 1/size as fast
    const exchange = SKIN_EXCHANGE / (env.size ?? 1);
    const kEnv = n ? exchange * kSum / n : 0;
    const k = kEnv + SKIN_RECOVER;
    const target = ((n ? exchange * kT / n : 0) + SKIN_RECOVER * BODY_T) / k;
    v.skinT = target + (v.skinT - target) * Math.exp(-k * dt);

    const acidShare = n ? acid / n : 0;
    const ease = 1 - Math.exp(-FEEL_RATE * dt);
    f.heat += (clamp01((v.skinT - BODY_T) / FEEL_HEAT_SPAN) - f.heat) * ease;
    f.cold += (clamp01((BODY_T - v.skinT) / FEEL_COLD_SPAN) - f.cold) * ease;
    f.acid += (clamp01(acidShare / FEEL_ACID_SHARE) - f.acid) * ease;

    shieldUpdate(dt);
    const blastShare = selfBlastT > 0 ? SELF_BLAST_SHARE : 1;
    selfBlastT = Math.max(0, selfBlastT - dt);
    const blast = env.pressure > BLAST_HURT_P && !has('EXPLOSION_IMMUNITY');
    const blown = () => hurt((env.pressure - BLAST_HURT_P) * BLAST_DAMAGE * blastShare * dt, 'Blown up', false, { shielded: true });
    if (v.dead) {
      if (blast) blown();   // the corpse can still be gibbed (GIB_HEALTH)
      return;
    }

    if (v.skinT > SKIN_BURN_T && !has('FIRE_IMMUNITY')) hurt((v.skinT - SKIN_BURN_T) * HEAT_DAMAGE * dt, heatCause(worstId, worstT));
    if (v.skinT < SKIN_COLD_T) hurt((SKIN_COLD_T - v.skinT) * COLD_DAMAGE * dt, 'Froze');
    if (acid) hurt(ACID_DAMAGE * acidShare * dt, 'Dissolved by acid');
    if (blast) blown();

    // breath
    const choking = (env.headInLiquid || env.buriedId >= 0) && !has('BREATHLESS');
    if (choking) {
      v.breath = Math.max(0, v.breath - dt / BREATH_TIME);
      if (v.breath <= 0) {
        hurt(SUFFOCATE_DAMAGE * dt, env.headInLiquid ? `Drowned in ${lower(env.liquidId)}` : `Buried in ${lower(env.buriedId)}`);
      }
    } else {
      v.breath = Math.min(1, v.breath + dt / BREATH_RECOVER_TIME);
    }
  };

  return v;
}

// Exposed for tests and tuning.
export const VITALS = { BODY_T, SKIN_BURN_T, SKIN_COLD_T, BREATH_TIME, BLAST_HURT_P, BLAST_DAMAGE, SHIELD_DELAY, SHIELD_REFILL };
