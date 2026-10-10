import { povEvents } from './events.js';

// Feel: what a shot, a blow, a blast or a hard landing does to the view. A
// view punch that springs back, a trauma shake (Eiserloh: shake = trauma² × smooth
// noise, so bursts build up and small knocks stay small), the hitmarker and
// the crosshair bloom. Everything comes in through povEvents and the player's
// own events; the camera reads `offsets` and adds them on top of the look.
// Angles in radians, distances in grid cells, times in seconds.

// ---- view punch: Source's (source-sdk-2013 CBasePlayer::ViewPunch, CGameMovement::DecayPunchAngle).
// Tools throw it with a 'punch' event {pitch, yaw} (rad; viewmodel.js HIT has each tool's angles):
// the angle × PUNCH_VEL_GAIN goes into the punch's angular velocity and a damped spring brings it back.
const DEG = Math.PI / 180;
const PUNCH_VEL_GAIN = 20;              // 1/s: ViewPunch adds angle × this to the punch's angular velocity
const PUNCH_DAMPING = 9;                // 1/s: velocity damping (PUNCH_DAMPING)
const PUNCH_SPRING = 65;                // 1/s²: torsional spring back to zero (PUNCH_SPRING_CONSTANT)
const PUNCH_SPRING_STEP_MAX = 2;        // the spring's per-frame factor is clamped to this (Source's clamp)
const PUNCH_EPS = 0.001 * DEG * DEG;    // rad²: below this angle² and rate² the punch snaps to rest (Source's 0.001 deg²)

// ---- trauma shake
export const SHAKE_SCALE = 1;           // global multiplier on the shake (0 turns it off)
const REDUCED_MOTION_SHAKE = 0.15;      // share of the shake (and kick) kept under prefers-reduced-motion
const TRAUMA_DECAY = 1.5;               // trauma lost per second (linear)
const SHAKE_ANGLE = 0.045;              // rad of pitch and yaw at full trauma
const SHAKE_ROLL = 0.6;                 // roll's share of SHAKE_ANGLE
const SHAKE_FREQ = 22;                  // noise time scale (1/s): roughly how fast the view jitters
// smooth noise: three incommensurate sines per axis, weights sum to 1
const NOISE_RATES = [1.0, 2.3, 4.1];
const NOISE_WEIGHTS = [0.5, 0.3, 0.2];
const NOISE_SEED_RATES = [1.0, 1.7, 2.9];
const SEED_PITCH = 1, SEED_YAW = 7, SEED_ROLL = 13;   // per-axis phase seeds, so the axes don't move together

// trauma sources
const TRAUMA_SHOT = 0.32;               // per shot fired
// impacts near the player: energy (½·DENS·v², sim units) × falloff with distance
const IMPACT_ENERGY_FULL = 60;          // impact energy that gives the full TRAUMA_IMPACT up close
const TRAUMA_IMPACT = 0.5;              // trauma of a full-energy impact at the eye
const IMPACT_NEAR = 3;                  // cells: closer than this counts as at the eye
const IMPACT_FAR = 24;                  // cells: no shake from impacts this far away
// blasts: 'hurt' with cause 'Blown up' (pressure damage), and big sudden velocity changes
const BLAST_CAUSE = 'Blown up';         // vitals.js's cause for pressure damage
const TRAUMA_PER_BLAST_HEALTH = 8;      // trauma per unit of health a blast takes
const TRAUMA_BLAST_MAX = 0.6;           // most trauma from one blast hurt event
const BLAST_DV_MIN = 18;                // cells/s of velocity change in one frame that counts as a blast (a jump is ≈ 12)
const BLAST_DV_FULL = 60;               // cells/s of change for TRAUMA_BLAST_DV
const TRAUMA_BLAST_DV = 0.8;
// optional: mean air pressure over the body, if the player exposes player.pressure
const PRESSURE_SHAKE_MIN = 4;           // sim pressure units the body doesn't feel
const PRESSURE_SHAKE_SPAN = 20;         // pressure above the minimum for the full rate
const TRAUMA_PRESSURE_RATE = 2.5;       // trauma per second at full pressure
// a bomb's blast ('blast' event): trauma at the eye, falling off with distance like an impact's
const TRAUMA_BOMB = 0.9;
const BOMB_FAR = 48;                    // cells: no shake from a blast this far away
// hard landings ('land' speed, cells/s)
const LAND_TRAUMA_MIN = 13;             // softer than this (a jump lands at ≈ 12) doesn't shake
const LAND_TRAUMA_FULL = 55;            // cells/s for the full TRAUMA_LAND
const TRAUMA_LAND = 0.7;
// damage of any other kind ('hurt' amount, share of health)
const HURT_SHAKE_MIN = 0.05;            // smaller hits (and steady burning, batched at 0.02) don't shake
const TRAUMA_PER_HEALTH = 1.5;          // trauma per unit of health lost
const TRAUMA_HURT_MAX = 0.6;            // most trauma from one hurt event

// ---- HUD feedback
const HIT_TIME = 0.18;                  // s the hitmarker shows
const HIT_FADE = 0.08;                  // s at the end of HIT_TIME over which it fades out
const BLOOM_PER_SHOT = 1;               // crosshair bloom added per shot (0..1 scale)
const BLOOM_DECAY = 5;                  // bloom lost per second (linear)

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
function noise(t, seed) {
  let n = 0;
  for (let i = 0; i < NOISE_RATES.length; i++) n += Math.sin(t * NOISE_RATES[i] + seed * NOISE_SEED_RATES[i]) * NOISE_WEIGHTS[i];
  return n;
}

// hud: the POV HUD (hitmarker(broke), and setBloom(0..1) / setHit(0..1, broke) via update)
export function createFeel({ hud }) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motionScale = () => SHAKE_SCALE * (reduced?.matches ? REDUCED_MOTION_SHAKE : 1);

  let trauma = 0, time = 0;
  const punch = { pitch: 0, yaw: 0, vp: 0, vy: 0 };   // rad and rad/s
  let bloom = 0, hitT = 0, hitBroke = false;
  let player = null, unbindPlayer = [];
  let live = false;                      // in the eyes and alive (events outside it are ignored)
  const eye = { x: 0, y: 0, z: 0 };      // grid, for impact distances
  const prevVel = { x: 0, y: 0, z: 0 };
  let prevValid = false, prevGround = false;
  const offsets = { pitch: 0, yaw: 0, roll: 0 };

  const addTrauma = (x) => { if (x > 0) trauma = Math.min(1, trauma + x); };

  const offs = [
    povEvents.on('gun:fire', ({ by }) => {
      if (!live || by) return;   // an NPC's shot isn't the player's recoil
      addTrauma(TRAUMA_SHOT);
      bloom = Math.min(1, bloom + BLOOM_PER_SHOT);
    }),
    povEvents.on('impact', (e) => {
      if (!live) return;
      if (e.point) {
        const d = Math.hypot(e.point.x - eye.x, e.point.y - eye.y, e.point.z - eye.z);
        const near = 1 - smooth01((d - IMPACT_NEAR) / (IMPACT_FAR - IMPACT_NEAR));
        addTrauma(TRAUMA_IMPACT * clamp01((e.energy ?? 0) / IMPACT_ENERGY_FULL) * near);
      }
      if (e.source === 'gun' && !e.by) { hitT = HIT_TIME; hitBroke = e.broke === true; }   // the hitmarker is the player's shots only
    }),
    povEvents.on('blast', ({ point }) => {
      if (!live || !point) return;
      const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      addTrauma(TRAUMA_BOMB * (1 - smooth01((d - IMPACT_NEAR) / (BOMB_FAR - IMPACT_NEAR))));
    }),
    // a tool's own screen shake (the laser cannon's beam): trauma 0..1, the player's only
    povEvents.on('shake', ({ trauma: x = 0, by }) => { if (live && !by) addTrauma(x); }),
    povEvents.on('punch', ({ pitch = 0, yaw = 0 }) => {
      if (!live) return;
      punch.vp += pitch * PUNCH_VEL_GAIN;
      punch.vy += yaw * PUNCH_VEL_GAIN;
      globalThis.__app?.requestRender?.();
    }),
  ];

  function onHurt({ amount = 0, cause = '' }) {
    if (!live) return;
    if (cause === BLAST_CAUSE) addTrauma(Math.min(TRAUMA_BLAST_MAX, amount * TRAUMA_PER_BLAST_HEALTH));
    else if (amount >= HURT_SHAKE_MIN) addTrauma(Math.min(TRAUMA_HURT_MAX, amount * TRAUMA_PER_HEALTH));
  }
  function onLand({ speed = 0 }) {
    if (!live) return;
    addTrauma(TRAUMA_LAND * clamp01((speed - LAND_TRAUMA_MIN) / (LAND_TRAUMA_FULL - LAND_TRAUMA_MIN)));
  }

  return {
    offsets,
    get time() { return time; },         // s of POV frames seen (checks)
    get trauma() { return trauma; },
    get kick() { return punch.pitch; },   // the view punch's pitch (rad), for checks
    get punch() { return { pitch: punch.pitch, yaw: punch.yaw }; },
    get bloom() { return bloom; },
    get hit() { return hitT; },
    addTrauma,
    // the body whose hurt and land events shake the view
    bindPlayer(p) {
      unbindPlayer.forEach((f) => f?.());
      player = p;
      unbindPlayer = p ? [p.on('hurt', onHurt), p.on('land', onLand)] : [];
      prevValid = false;
    },
    // a fresh body (drop in, respawn): nothing carried over
    reset() {
      trauma = bloom = hitT = 0;
      punch.pitch = punch.yaw = punch.vp = punch.vy = 0;
      prevValid = false;
      offsets.pitch = offsets.yaw = offsets.roll = 0;
    },
    // Every POV frame. s = { dt, live (in the eyes and alive), eye (grid) }.
    // Returns offsets {pitch, yaw, roll} (rad) for the camera.
    update({ dt, live: isLive, eye: e }) {
      live = !!isLive;
      time += dt;
      if (e) { eye.x = e.x; eye.y = e.y; eye.z = e.z; }

      // blasts: a sudden velocity change the body's own moves can't make
      // (landings are 'land', so a frame that touches down is skipped)
      if (player && live) {
        const v = player.vel;
        const landed = player.onGround && !prevGround;
        if (prevValid && !landed) {
          const dv = Math.hypot(v.x - prevVel.x, v.y - prevVel.y, v.z - prevVel.z);
          addTrauma(TRAUMA_BLAST_DV * clamp01((dv - BLAST_DV_MIN) / (BLAST_DV_FULL - BLAST_DV_MIN)));
        }
        prevVel.x = v.x; prevVel.y = v.y; prevVel.z = v.z;
        prevGround = player.onGround;
        prevValid = true;
        if (typeof player.pressure === 'number') {
          addTrauma(TRAUMA_PRESSURE_RATE * dt * clamp01((player.pressure - PRESSURE_SHAKE_MIN) / PRESSURE_SHAKE_SPAN));
        }
      } else prevValid = false;

      if (punch.pitch ** 2 + punch.yaw ** 2 > PUNCH_EPS || punch.vp ** 2 + punch.vy ** 2 > PUNCH_EPS) {
        punch.pitch += punch.vp * dt; punch.yaw += punch.vy * dt;
        const damp = Math.max(0, 1 - PUNCH_DAMPING * dt);
        punch.vp *= damp; punch.vy *= damp;
        const spring = Math.min(PUNCH_SPRING * dt, PUNCH_SPRING_STEP_MAX);
        punch.vp -= punch.pitch * spring; punch.vy -= punch.yaw * spring;
        globalThis.__app?.requestRender?.();
      } else punch.pitch = punch.yaw = punch.vp = punch.vy = 0;
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
      const m = motionScale();
      const shake = trauma * trauma * SHAKE_ANGLE * m;
      const t = time * SHAKE_FREQ;
      offsets.pitch = punch.pitch * m + shake * noise(t, SEED_PITCH);
      offsets.yaw = punch.yaw * m + shake * noise(t, SEED_YAW);
      offsets.roll = shake * SHAKE_ROLL * noise(t, SEED_ROLL);

      bloom = Math.max(0, bloom - BLOOM_DECAY * dt);
      hitT = Math.max(0, hitT - dt);
      hud?.feedback({ bloom, hit: hitT > 0 ? Math.min(1, hitT / HIT_FADE) : 0, broke: hitBroke });
      return offsets;
    },
    dispose() {
      offs.forEach((f) => f());
      unbindPlayer.forEach((f) => f?.());
    },
  };
}
