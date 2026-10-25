import { povEvents } from './events.js';

// Feel: what a shot, a blow or a blast does to the view. A
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

// Minecraft-style steady mining: the hands carry the swing, the view gets one small contact nod.
// Peak angles (rad), time to peak and total duration (s); no noise, roll or spring overshoot.
const TOOL_CONTACT = {
  pickaxe: { pitch: -0.6 * DEG, yaw: 0, attack: 0.04, duration: 0.26 },
  axe: { pitch: -0.35 * DEG, yaw: -0.15 * DEG, attack: 0.045, duration: 0.24 },
  shovel: { pitch: -0.18 * DEG, yaw: 0, attack: 0.035, duration: 0.14 },
};

// ---- trauma shake
export const SHAKE_SCALE = 1;           // global multiplier on the shake (0 turns it off)
const REDUCED_MOTION_SHAKE = 0.15;      // share of the shake (and kick) kept under prefers-reduced-motion
const TRAUMA_DECAY = 1.5;               // trauma lost per second (linear)
const SHAKE_ANGLE = 0.045;              // rad of pitch and yaw at full trauma
const SHAKE_ROLL = 0.6;                 // roll's share of SHAKE_ANGLE
// a rumble (a tool's own 'shake' event, the laser cannon's beam): trauma like the shake's, decaying
// as fast, but it only rolls the view. A roll turns the view about the crosshair, so a beam laid
// along the shot stays on it
const RUMBLE_ROLL = 1;                  // roll's share of SHAKE_ANGLE at full rumble: the pitch and yaw it gives up go into roll
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
// blasts: 'hurt' with cause 'Blown up' (pressure damage), and big sudden pushes from outside (player.knock)
const BLAST_CAUSE = 'Blown up';         // vitals.js's cause for pressure damage
const TRAUMA_PER_BLAST_HEALTH = 8;      // trauma per unit of health a blast takes
const TRAUMA_BLAST_MAX = 0.6;           // most trauma from one blast hurt event
const BLAST_DV_MIN = 18;                // cells/s of push from outside in one frame that counts as a blast
const BLAST_DV_FULL = 60;               // cells/s of change for TRAUMA_BLAST_DV
const TRAUMA_BLAST_DV = 0.8;
// optional: mean air pressure over the body, if the player exposes player.pressure
const PRESSURE_SHAKE_MIN = 4;           // sim pressure units the body doesn't feel
const PRESSURE_SHAKE_SPAN = 20;         // pressure above the minimum for the full rate
const TRAUMA_PRESSURE_RATE = 2.5;       // trauma per second at full pressure
// a bomb's blast ('blast' event): trauma at the eye, falling off with distance like an impact's
const TRAUMA_BOMB = 0.9;
const BOMB_FAR = 48;                    // cells: no shake from a blast this far away
// damage of any other kind ('hurt' amount, share of health)
const HURT_SHAKE_MIN = 0.05;            // smaller hits (and steady burning, batched at 0.02) don't shake
const TRAUMA_PER_HEALTH = 1.5;          // trauma per unit of health lost
const TRAUMA_HURT_MAX = 0.6;            // most trauma from one hurt event

// ---- drunk (a 'drunk' event, ingest.js: whiskey): a slow sway of the view, as Noita's
// Drunk blurs and spreads. Noita's levels: mildly boozed under 15 s of Drunkenness,
// drunk to 45 s, wasted past it; the sway grows to its full size at wasted.
const DRUNK_WASTED_S = 45;              // s of Drunkenness for the full sway (Noita's "Wasted")
const DRUNK_MAX_S = 120;                // s of Drunkenness kept at most (Noita poisons you past 60)
const DRUNK_EASE = 0.5;                 // 1/s: the sway follows the Drunkenness this fast (it comes on and wears off gently)
const DRUNK_ROLL = 4 * DEG;             // rad of roll at full sway...
const DRUNK_YAW = 2.5 * DEG;            // ...of yaw...
const DRUNK_PITCH = 1.5 * DEG;          // ...and of pitch
const DRUNK_FREQ = 2 * Math.PI * 0.25;  // rad/s: a sway every 4 s
const DRUNK_YAW_RATE = 0.5;             // the yaw sways at this share of the roll's rate, the pitch at twice it: a lazy figure eight
const DRUNK_PITCH_RATE = 2;
const DRUNK_SWAY_EPS = 1e-3;            // a sway this small, sober, is over (stops the redraws)

// ---- HUD feedback
const HIT_TIME = 0.18;                  // s the hitmarker shows
const HIT_FADE = 0.08;                  // s at the end of HIT_TIME over which it fades out
const BLOOM_PER_SHOT = 1;               // crosshair bloom added per shot (0..1 scale)
const BLOOM_DECAY = 5;                  // bloom lost per second (linear)
const BLOOM_PER_CAST = 0.5;             // crosshair bloom per wand cast: half a shot's (a cast has no recoil to recover from)
// sources whose hits into a body show the hitmarker (TF2's hit sound: blocks and terrain don't ding)
const HITMARKER_SOURCES = new Set(['gun', 'wand']);
// a wand's blast ('wand:blast', wands/runtime.js): the bomb's trauma, scaled by its radius against the bomb's
const WAND_BLAST_RADIUS_FULL = 6;       // cells: a blast this wide shakes like a bomb (catalog.js explosion)

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

  let trauma = 0, rumble = 0, time = 0;
  const punch = { pitch: 0, yaw: 0, vp: 0, vy: 0 };   // rad and rad/s
  let contact = null, contactTime = 0;
  let bloom = 0, hitT = 0, hitBroke = false;
  let drunk = 0, drunkSway = 0, drunkTime = 0;   // s of Drunkenness left; the sway's size (0..1); its clock
  let player = null, unbindPlayer = [];
  let live = false;                      // in the eyes and alive (events outside it are ignored)
  const eye = { x: 0, y: 0, z: 0 };      // grid, for impact distances
  const offsets = { pitch: 0, yaw: 0, roll: 0, punchPitch: 0, punchYaw: 0 };   // punch*: the view punch's share of pitch and yaw

  const addTrauma = (x) => { if (x > 0) trauma = Math.min(1, trauma + x); };
  const addRumble = (x) => { if (x > 0) rumble = Math.min(1, rumble + x); };
  const toolContact = (profile) => {
    // Fast shovel transfers share one nod instead of stacking or restarting it mid-motion.
    if (contact) return;
    contact = profile;
    contactTime = 0;
    globalThis.__app?.requestRender?.();
  };

  const offs = [
    povEvents.on('gun:fire', ({ by }) => {
      if (!live || by) return;   // an NPC's shot isn't the player's recoil
      addTrauma(TRAUMA_SHOT);
      bloom = Math.min(1, bloom + BLOOM_PER_SHOT);
    }),
    povEvents.on('impact', (e) => {
      if (!live) return;
      const tool = !e.by && TOOL_CONTACT[e.source];
      if (tool) toolContact(tool);
      else if (e.point) {
        const d = Math.hypot(e.point.x - eye.x, e.point.y - eye.y, e.point.z - eye.z);
        const near = 1 - smooth01((d - IMPACT_NEAR) / (IMPACT_FAR - IMPACT_NEAR));
        addTrauma(TRAUMA_IMPACT * clamp01((e.energy ?? 0) / IMPACT_ENERGY_FULL) * near);
      }
      // the hitmarker is the player's shots into a body only (TF2's hit sound: blocks and terrain don't ding)
      if (HITMARKER_SOURCES.has(e.source) && e.body && !e.by) { hitT = HIT_TIME; hitBroke = e.broke === true; }
    }),
    povEvents.on('tool:action', ({ tool, action, amount = 0, by }) => {
      if (live && !by && tool === 'shovel' && (action === 'chip' || (action === 'dig' && amount > 0))) toolContact(TOOL_CONTACT.shovel);
    }),
    povEvents.on('blast', ({ point }) => {
      if (!live || !point) return;
      const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      addTrauma(TRAUMA_BOMB * (1 - smooth01((d - IMPACT_NEAR) / (BOMB_FAR - IMPACT_NEAR))));
    }),
    povEvents.on('wand:fire', ({ by }) => {
      if (live && !by) bloom = Math.min(1, bloom + BLOOM_PER_CAST);
    }),
    povEvents.on('wand:blast', ({ point, radius = WAND_BLAST_RADIUS_FULL }) => {
      if (!live || !point) return;
      const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      addTrauma(TRAUMA_BOMB * clamp01(radius / WAND_BLAST_RADIUS_FULL) * (1 - smooth01((d - IMPACT_NEAR) / (BOMB_FAR - IMPACT_NEAR))));
    }),
    // a tool's own screen shake (the laser cannon's beam): trauma 0..1 of rumble, the player's only
    // (`level`: a sustained shake, held every frame the source lasts: the rumble is raised to it, not stacked)
    povEvents.on('shake', ({ trauma: x = 0, level = 0, by }) => {
      if (!live || by) return;
      addRumble(x);
      if (level > 0) rumble = Math.max(rumble, Math.min(1, level));
    }),
    povEvents.on('drunk', ({ seconds = 0, by }) => {
      if (!live || by) return;   // an NPC's drink isn't the player's head
      drunk = Math.min(DRUNK_MAX_S, drunk + seconds);
    }),
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

  return {
    offsets,
    get time() { return time; },         // s of POV frames seen (checks)
    get trauma() { return trauma; },
    get rumble() { return rumble; },
    get kick() { return punch.pitch; },   // the view punch's pitch (rad), for checks
    get punch() { return { pitch: punch.pitch, yaw: punch.yaw }; },
    get bloom() { return bloom; },
    get drunk() { return drunk; },       // s of Drunkenness left
    get drunkSway() { return drunkSway; },   // the drunk sway's size now, 0..1
    get hit() { return hitT; },
    addTrauma,
    // the body whose hurt events shake the view
    bindPlayer(p) {
      unbindPlayer.forEach((f) => f?.());
      player = p;
      unbindPlayer = p ? [p.on('hurt', onHurt)] : [];
    },
    // a fresh body (drop in, respawn): nothing carried over
    reset() {
      trauma = rumble = bloom = hitT = 0;
      drunk = drunkSway = 0;
      punch.pitch = punch.yaw = punch.vp = punch.vy = 0;
      contact = null; contactTime = 0;
      offsets.pitch = offsets.yaw = offsets.roll = offsets.punchPitch = offsets.punchYaw = 0;
    },
    // Every POV frame. s = { dt, live (in the eyes and alive), eye (grid) }.
    // Returns offsets {pitch, yaw, roll} (rad) for the camera, and punchPitch, punchYaw: the view punch's share.
    update({ dt, live: isLive, eye: e }) {
      live = !!isLive;
      time += dt;
      if (e) { eye.x = e.x; eye.y = e.y; eye.z = e.z; }

      // blasts: a sudden push from outside (player.knock: pressure and impulses), never the
      // body's own moves (a jump, the jet, a pogo bounce, a rope reel) or a landing ('land')
      if (player && live) {
        addTrauma(TRAUMA_BLAST_DV * clamp01(((player.knock ?? 0) - BLAST_DV_MIN) / (BLAST_DV_FULL - BLAST_DV_MIN)));
        if (typeof player.pressure === 'number') {
          addTrauma(TRAUMA_PRESSURE_RATE * dt * clamp01((player.pressure - PRESSURE_SHAKE_MIN) / PRESSURE_SHAKE_SPAN));
        }
      }

      if (punch.pitch ** 2 + punch.yaw ** 2 > PUNCH_EPS || punch.vp ** 2 + punch.vy ** 2 > PUNCH_EPS) {
        punch.pitch += punch.vp * dt; punch.yaw += punch.vy * dt;
        const damp = Math.max(0, 1 - PUNCH_DAMPING * dt);
        punch.vp *= damp; punch.vy *= damp;
        const spring = Math.min(PUNCH_SPRING * dt, PUNCH_SPRING_STEP_MAX);
        punch.vp -= punch.pitch * spring; punch.vy -= punch.yaw * spring;
        globalThis.__app?.requestRender?.();
      } else punch.pitch = punch.yaw = punch.vp = punch.vy = 0;
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
      rumble = Math.max(0, rumble - TRAUMA_DECAY * dt);
      const m = motionScale();
      const shake = trauma * trauma * SHAKE_ANGLE * m;
      const t = time * SHAKE_FREQ;
      offsets.punchPitch = punch.pitch * m;
      offsets.punchYaw = punch.yaw * m;
      offsets.pitch = offsets.punchPitch + shake * noise(t, SEED_PITCH);
      offsets.yaw = offsets.punchYaw + shake * noise(t, SEED_YAW);
      offsets.roll = (shake * SHAKE_ROLL + rumble * rumble * SHAKE_ANGLE * RUMBLE_ROLL * m) * noise(t, SEED_ROLL);

      if (contact) {
        contactTime += dt;
        const { pitch, yaw, attack, duration } = contact;
        const weight = contactTime < attack
          ? smooth01(contactTime / attack)
          : 1 - smooth01((contactTime - attack) / (duration - attack));
        offsets.pitch += pitch * weight * m;
        offsets.yaw += yaw * weight * m;
        // Like other view punches, the contact nod belongs to the eyes, not the third-person camera.
        offsets.punchPitch += pitch * weight * m;
        offsets.punchYaw += yaw * weight * m;
        if (contactTime >= duration) contact = null;
        globalThis.__app?.requestRender?.();
      }

      drunk = Math.max(0, drunk - dt);
      drunkSway += (clamp01(drunk / DRUNK_WASTED_S) - drunkSway) * (1 - Math.exp(-DRUNK_EASE * dt));
      if (drunk <= 0 && drunkSway < DRUNK_SWAY_EPS) drunkSway = 0;
      if (drunkSway > 0) {
        drunkTime += dt;
        const a = drunkTime * DRUNK_FREQ, k = drunkSway * m;
        offsets.roll += k * DRUNK_ROLL * Math.sin(a);
        offsets.yaw += k * DRUNK_YAW * Math.sin(a * DRUNK_YAW_RATE);
        offsets.pitch += k * DRUNK_PITCH * Math.sin(a * DRUNK_PITCH_RATE);
        globalThis.__app?.requestRender?.();
      }

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
