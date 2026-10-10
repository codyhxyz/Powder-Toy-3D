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

// ---- blasts ----
const BLAST_HURT_P = 8;         // air pressure (sim units) the body shrugs off...
const BLAST_DAMAGE = 0.4;       // ...health/s per unit above it

// ---- feel (0..1 screen-effect intensities) ----
const FEEL_HEAT_SPAN = 40;      // °C of skin above BODY_T for full heat glow
const FEEL_COLD_SPAN = 30;      // °C of skin below BODY_T for full frost
const FEEL_ACID_SHARE = 0.25;   // share of contact cells that are acid for a full acid tint
const FEEL_RATE = 6;            // 1/s, heat/cold/acid feel follows its target at this rate
const HURT_FEEL_GAIN = 4;       // hurt flash per unit of health lost...
const HURT_FEEL_FADE = 1.5;     // ...fading at this much per second

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
  const v = {
    health: 1, breath: 1, skinT: BODY_T,
    feel: { heat: 0, cold: 0, acid: 0, hurt: 0 },
    dead: false, cause: '',
  };
  let pending = 0, pendingCause = '', pendingAge = 0;

  v.reset = () => {
    v.health = 1; v.breath = 1; v.skinT = BODY_T;
    Object.assign(v.feel, { heat: 0, cold: 0, acid: 0, hurt: 0 });
    v.dead = false; v.cause = '';
    pending = 0; pendingCause = ''; pendingAge = 0;
  };

  function flushHurt() {
    if (pending > 0) emit('hurt', { amount: pending, cause: pendingCause });
    pending = 0; pendingAge = 0;
  }

  // Take `amount` health. `burst` (an impact or a blast) is reported at once.
  function hurt(amount, cause, burst = false) {
    if (v.dead || !(amount > 0)) return;
    amount /= perks?.maxHealth ?? 1;
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
    }
  }
  v.hurt = hurt;

  // Impact on landing or slamming into something. speed: cells/s into the
  // surface; safe/lethal: impact speeds (cells/s) for SAFE_FALL_M and
  // LETHAL_FALL_M; fallCells: height fallen (vertical impacts), else 0.
  v.impact = (speed, safe, lethal, fallCells, surfaceId) => {
    if (speed <= safe || has('EXPLOSION_IMMUNITY')) return;   // slams only come from blasts (landings never hurt)
    const dmg = (speed * speed - safe * safe) / (lethal * lethal - safe * safe);
    const m = Math.round(fallCells * CELL_METERS);
    const cause = fallCells > 0 && m >= 1 ? `Fell ${m} m` : `Slammed into ${surfaceId >= 0 ? lower(surfaceId) : 'the wall'}`;
    hurt(dmg, cause, true);
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
      if (id === E.ACID) acid++;
    }
    const kEnv = n ? SKIN_EXCHANGE * kSum / n : 0;
    const k = kEnv + SKIN_RECOVER;
    const target = ((n ? SKIN_EXCHANGE * kT / n : 0) + SKIN_RECOVER * BODY_T) / k;
    v.skinT = target + (v.skinT - target) * Math.exp(-k * dt);

    const acidShare = n ? acid / n : 0;
    const ease = 1 - Math.exp(-FEEL_RATE * dt);
    f.heat += (clamp01((v.skinT - BODY_T) / FEEL_HEAT_SPAN) - f.heat) * ease;
    f.cold += (clamp01((BODY_T - v.skinT) / FEEL_COLD_SPAN) - f.cold) * ease;
    f.acid += (clamp01(acidShare / FEEL_ACID_SHARE) - f.acid) * ease;

    if (v.dead) return;

    if (v.skinT > SKIN_BURN_T && !has('FIRE_IMMUNITY')) hurt((v.skinT - SKIN_BURN_T) * HEAT_DAMAGE * dt, heatCause(worstId, worstT));
    if (v.skinT < SKIN_COLD_T) hurt((SKIN_COLD_T - v.skinT) * COLD_DAMAGE * dt, 'Froze');
    if (acid) hurt(ACID_DAMAGE * acidShare * dt, 'Dissolved by acid');
    if (env.pressure > BLAST_HURT_P && !has('EXPLOSION_IMMUNITY')) hurt((env.pressure - BLAST_HURT_P) * BLAST_DAMAGE * dt, 'Blown up');

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
export const VITALS = { BODY_T, SKIN_BURN_T, SKIN_COLD_T, BREATH_TIME, BLAST_HURT_P };
