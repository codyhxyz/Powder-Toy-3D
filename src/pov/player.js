import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { PHYS } from '../physics.js';
import { quadVert, stateUniforms } from '../shaders/common.js';
import { povProbeFrag, povCouplingFrag, povFieldFrag, PROBE, PROBE_OUTSIDE } from '../shaders/povBody.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT, BODY_DENS } from './constants.js';
import { createVitals, CELL_METERS, SAFE_FALL_M, LETHAL_FALL_M } from './vitals.js';
import { povEvents } from './events.js';
import { createPerkSet } from './perks.js';
import { createStatusSet } from './status.js';
import { wound, createBodyWorld } from './stains.js';
import { createKick } from './kick.js';
import { createMeat, EAT_CELLS_MAX } from './meat.js';

// The first-person body: an upright AABB (BODY_WIDTH × BODY_HEIGHT × BODY_WIDTH
// cells) moving through the voxel grid in real time.
//
// Every frame a small GPU pass (shaders/povBody.js) copies the cells around the
// body into a PROBE-sized target that is read back asynchronously, so the body
// always sees the world a frame or two late. From those cells it collides
// (solids and powders block, with an automatic step up 1-cell ledges), floats
// by Archimedes, feels drag in liquids the way move.js does, gets thrown by
// pressure gradients with the sim's own a = −∇P·P_ACCEL/ρ, and hands what it
// touches to vitals.js. A second pass pushes loose matter out of the body's way.
// The body's perks (perks.js) change its moves here (Lukki, Sand Swimmer,
// Fleet Foot, Rocket Boots, Big Tank, Slow Fall, Shrink) and reach into the
// world through a third pass (Freeze Field, Revenge Explosion), and through the
// engine's own brush and the coupling pass (Rain Cloud). A held pogo stick
// (tools/pogo.tool.js calls holdPogo() every frame) turns its landings into bounces.
//
// Units: positions in grid cells (feet = bottom centre of the box), velocities
// in cells/s, time in s. The sim runs on its own, much faster clock: about 240
// steps/s, with V_MAX = 1 cell/step (240 cells/s) and gravity 0.025 cells/step²
// (≈ 1440 cells/s², 44× this body's). Where the body meets the sim (pressure,
// the coupling pass) it converts with the measured step rate.

// ---- body ----
// Its size is the body's own (the Shrink perk scales it): createPlayer keeps H (height), HW (half
// the footprint) and EYE (eye height) from BODY_HEIGHT, BODY_WIDTH and EYE_HEIGHT × perks.size.
// What changes with size is what physics says does (Shrink, below).
const EPS = 1e-4;                      // cells: faces this close to a cell boundary don't overlap it

// ---- gravity and moving: Noita's player ----
// The numbers are the Noita player's own (data/entities/player.xml,
// CharacterPlatformingComponent), in pixels and 60 Hz frames, scaled by body
// height: Mina is NOITA_BODY_PX tall, this body BODY_HEIGHT cells. Velocity
// isn't pushed by forces; every frame it closes a fixed share of the gap to the
// speed you ask for, which is what makes Noita's movement feel fluid.
const NOITA_FPS = 60;
const NOITA_BODY_PX = 11;              // px, Mina head to feet
export const PX = BODY_HEIGHT / NOITA_BODY_PX; // cells per Noita pixel (the flask scales Noita's units by it)
const GRAVITY = 350 * PX;              // cells/s² (175, 5.4 g) at the default sim gravity (pixel_gravity)...
const SIM_GRAVITY_REF = 0.025;         // ...which is this many cells/step² (sim.js GRAVITY_DEFAULT); the setting scales it
const SPRINT_SPEED = 57 * PX;          // cells/s (8.6 m/s): Mina's run (velocity_max_x)
const WALK_SPEED = SPRINT_SPEED / 3;   // cells/s (2.9 m/s): Noita has no walk; holding sprint runs as Mina does
const MOVE_EASE = 0.15;                // share of the gap to the wished speed closed per Noita frame, ground and air (accel_x)
const JUMP_SPEED = 95 * PX;            // cells/s: a 1.9 m jump (jump_velocity_y)
const STEP_HEIGHT = 1.1;               // cells: ledges up to this are stepped onto (1 cell + slack)
// Crouch (input.crouch, held): Source's duck (gamemovement.cpp). The hull goes
// from 72 units to 36 and the eye from 64 to 28; it takes TIME_TO_DUCK 0.4 s
// down and TIME_TO_UNDUCK 0.2 s back up; a ducked player on the ground moves
// at PLAYER_DUCKING_MULTIPLIER a third of the speed and doesn't sprint.
// Standing back up needs the room for it. Not while swimming.
const CROUCH_HEIGHT = 36 / 72;          // × the body's height, crouched
const CROUCH_EYE = 28 / 64;             // × the eye's height, crouched
const CROUCH_DOWN_S = 0.4;              // s to crouch
const CROUCH_UP_S = 0.2;                // s to stand back up
const CROUCH_SPEED = 1 / 3;             // × the speed on the ground, crouched
const STEP_DOWN = 1.1;                 // cells: walking off a ledge this low follows the ground down
const MAX_SPEED = 350 * PX;            // cells/s (52 m/s): Noita's fastest fall (velocity_max_y), past a lethal one
const SUBSTEP = 0.4;                   // cells: longest move per collision substep
const MAX_DT = 0.1;                    // s: longer frames are simulated as this long

// ---- jetpack: Noita's levitation. Hold jump in the air to climb; the tank
// drains while it fires and refills fast on the ground, slowly in the air.
// The tank and recharge are the Noita player's own (data/entities/player.xml,
// CharacterDataComponent: fly_time_max, fly_recharge_spd_ground,
// fly_recharge_spd, flying_in_air_wait_frames, flying_recharge_removal_frames;
// fly_speed_max_up, fly_speed_change_spd, fly_velocity_x).
const JET_FUEL_S = 3;                  // s of thrust on a full tank (fly_time_max)
const JET_REFILL_GROUND = 6;           // s of thrust regained per s, feet on the ground: full in 0.5 s (fly_recharge_spd_ground)
const JET_REFILL_AIR = 0.4;            // s of thrust regained per s in the air, not firing (fly_recharge_spd)
const JET_AIR_WAIT_S = 38 / NOITA_FPS; // s off the jet before the air recharge starts (flying_in_air_wait_frames)
const JET_TAP_S = 8 / NOITA_FPS;       // s of fuel every press burns at least, so tapping can't hover for free (flying_recharge_removal_frames)
const JET_RISE = 95 * PX;              // cells/s (14 m/s): the climb the jet eases toward (fly_speed_max_up)
const LEVITATE_RISE = 1.75;            // × the jet's climb while Levitating (Noita's Faster Levitation: 75% faster)
const JET_EASE = 0.25;                 // share of the gap to JET_RISE closed per Noita frame, gravity off while it fires (fly_speed_change_spd)
const JET_FLY_SPEED = 52 * PX;         // cells/s: horizontal speed while the jet fires (fly_velocity_x)

// ---- Slow Fall: a canopy's quadratic air drag on the way down, a = k·v², so the body comes down at
// most at the terminal speed √(g/k). One stack lands it at a round parachute's rate (the US Army
// T-11's 19 ft/s) at the default gravity; each further stack multiplies the drag area (perks.js
// slowFallArea). Drag goes with area over mass, so a smaller body (Shrink) drifts down slower
// still. It acts only while descending in air, so a jump still rises and the jetpack still climbs
// (Noita's ease is untouched): it just makes the way down a glide.
const SLOW_FALL_DESCENT = 5.8 / CELL_METERS;            // cells/s (5.8 m/s): terminal descent with one stack
const SLOW_FALL_K = GRAVITY / SLOW_FALL_DESCENT ** 2;   // 1/cell: the canopy's drag constant at one stack and the default gravity

// ---- Shrink: a body s times the size (perks.js size). Gravity is the world's, not the body's, so
// the moves follow dynamic similarity (Alexander's: bodies of different sizes move alike at equal
// Froude numbers v²/gL): run, walk, jump, swim and jet speeds scale by √s, and a jump still clears
// the same number of body heights. Mass goes with volume (s³) and surfaces with area (s²), so:
// an impulse (a blow, a gun's recoil) throws it 1/s³ as fast; liquid form drag (area/mass) is 1/s
// and viscous drag (Stokes: size/mass) 1/s² as strong, so lava traps it worse; a canopy's drag is
// 1/s; its skin warms and cools 1/s as fast (vitals.js). Blasts already scale: the pressure push is
// the mean gradient over the body's own cells, about ΔP across the body over its length.
// STEP_HEIGHT stays a cell (the grid's grain), so a small body still climbs a 1-cell ledge.

// ---- rope (tools/hook.tool.js sets one with tether()): a one-sided distance
// constraint to an anchor, Box2D's rope joint (Erin Catto's b2RopeJoint, the
// max-distance joint; Jakobsen 2001, "Advanced Character Physics", the same
// rope as a projection): past its length the body can't move away from the
// anchor (the outward part of its velocity is taken away: a rope doesn't
// bounce) and a Baumgarte term pulls it back to length. Gravity and the
// constraint make the pendulum: a swing comes for free. Reeling, the winch
// takes up the slack and the closing speed eases toward the reel speed the
// Noita way, a share per frame (Titanfall 2's grapple: the line retracts and
// draws the pilot to the hook) and the speed across the rope is damped by the
// same share Noita settles a run with, so the reel zips you in instead of
// winding you into an orbit (angular momentum would spin a body up as the rope
// shortens). Let go of the reel and the speed across the rope is yours again:
// the swing.
export const ROPE_REEL_SPEED = JET_RISE;   // cells/s (14 m/s): the fastest the body moves itself, the jet's climb
const ROPE_EASE = JET_EASE;            // share of the gap to the reel speed closed per Noita frame (fly_speed_change_spd)
const ROPE_SWAY_EASE = MOVE_EASE;      // share of the speed across the rope taken per Noita frame while reeling (accel_x)
const ROPE_HAND_BELOW_EYE = 1;         // cells under the eye the rope pulls at (× size): the hand holding it, shoulder high
const ROPE_SLACK = 0.05;               // cells short of its length at which the rope counts as taut
const ROPE_BAUMGARTE = 0.2;            // share of the overshoot past the length corrected per s·(1/dt): Box2D's b2_baumgarte

// ---- liquids ----
const WADE_SHARE = 0.15;               // submerged share of the body that counts as "in" liquid
const SWIM_SHARE = 0.5;                // submerged share from which you swim rather than walk
// Drag when fully submerged. Form drag is quadratic and scales with the
// liquid's density over the body's (½·ρ·Cd·A/m ≈ 1 /m for a flailing person feet
// first in water, where the two densities are about equal);
// viscous drag is linear and scales with the liquid's own per-step damping
// (elements.js drag: water 0.01, oil 0.03, lava 0.2), so lava is a trap.
const FORM_DRAG = 1.0 * CELL_METERS;        // 1/cell, × DENS[liquid] / BODY_DENS
const VISCOUS_DRAG = 15;                    // 1/s per unit of the liquid's elements.js drag (water 0.15/s, lava 3/s)
const SWIM_SPEED = 3;                  // cells/s, horizontal swimming
const SWIM_ACCEL = 15;                 // cells/s²
const SWIM_UP = 0.35;                  // × GRAVITY, thrust of swimming up (jump)...
const SWIM_DOWN = 0.35;                // ...and down (down)
const HEAD_LIQUID_SHARE = 0.5;         // liquid share around the eye that puts the head under
const BURY_SHARE = 0.6;                // share of the head's cells holding powder or solid that buries it

// ---- pressure ----
const RHO_BODY = Math.max(BODY_DENS * PHYS.RHO_SCALE, PHYS.RHO_MIN);   // the sim's inertia for the body's density
const PRESSURE_MAX_SPEED = 60;         // cells/s (18 m/s): a blast throws you this fast at most

// ---- body → sim coupling (shaders/povBody.js) ----
const DISPLACE_PUSH_FLUID = 0.8;       // cells/step outward on liquids and gases in the body, at full speed (a pool churns at ~FLOW)...
const DISPLACE_FULL_SPEED = 6;         // ...reached at this body speed (cells/s); a body standing still is porous to liquid
const DISPLACE_PUSH_POWDER = 0.3;      // cells/step outward on grains in the body, always (a leg and a grain can't share a cell)
const DISPLACE_LIFT = 1;               // upward share of the push per unit of downward heading (a body landing in water throws it up)
const DISPLACE_AHEAD = 1;              // forward share of the push per unit of horizontal heading (a wading body shoves water ahead)

// ---- probe ----
const PROBE_INFLIGHT = 3;               // readbacks in flight at once
const LATENCY_INIT = 0.05;             // s, readback latency assumed before the first one lands
const LATENCY_EASE = 0.2;              // share of each new latency sample in the running estimate
const DT_EASE = 0.1;                   // share of each frame in the smoothed frame time (step rate)
const CONTACT_REACH = 0.5;             // cells beyond the body's faces that count as touching it
const UNKNOWN = -2;                    // id of a cell outside the probed box

// ---- events ----
const LAND_EVENT_SPEED = 3;            // cells/s: softer touchdowns aren't reported as 'land'

// ---- perks (perks.js holds their sizes) ----
const LUKKI_REACH = 0.5;               // cells beyond the body's sides and top a wall or ceiling still holds a Lukki
const FREEZE_RATE = 600;               // °C/s the Freeze Field draws out of liquids and fire (the Cool brush: 30 °C a frame)...
const FREEZE_T = -20;                  // ...down to this, as cold as fresh ice
const FREEZE_CLEAR = 1;                // cells around the body, from the feet up, it leaves liquid (you stand on the ice it makes, not in it)
const REVENGE_INNER = BODY_HEIGHT / 2 + 1;   // cells from the body's middle where the blast's shell starts: the body sits in its eye
const REVENGE_SHELL_MIN = 1;           // cells: the shell is at least this thick
const REVENGE_COOLDOWN = 1;            // s between Revenge Explosions
// Rain Cloud: real CLOUD cells (the engine rains them where they're thick, CLOUD_RAIN_NB, and thins
// them at their edges) kept over the head. A breeze carries the cloud with the body (the coupling
// pass on CLOUD only), and the brush tops its sphere up to CLOUD_FILL where rain and evaporation
// took it. So no body can flood the world: new cloud comes at CLOUD_SEED_RATE at most, and a body
// stops seeding while CLOUD_BUDGET cells of its own cloud may still be alive (counted down with
// the cloud's measured life).
const CLOUD_GAP = 2;                   // cells between the crown and the cloud's underside
const CLOUD_FILL = 0.85;               // share of the air in its sphere it keeps cloud: thick enough to rain (5 of 6 neighbours on average)
const CLOUD_SEED_RATE = 150;           // cells/s of new cloud at most, per body: a radius-4 cloud gathers in about 2 s
const CLOUD_LIFE_S = 67;               // s: e-folding life of painted cloud, measured on the GPU (41% left after 60 s: 60 / ln(1/0.41))
const CLOUD_BUDGET = 6000;             // cells: the most of its own cloud a body keeps alive at once (a trail it outran included)
const CLOUD_SPAWN = ELEMENTS[E.CLOUD].spawn;   // the brush's chance per air cell at rate 1 (elements.js spawn)
// The movement perks (Fleet Foot, Rocket Boots) multiply speeds; these caps keep the body inside
// its probe (PROBE: 16 cells across, 32 tall; the probe leads the body by its velocity × the
// readback latency) at low frame rates. Both are speeds the body already reaches without perks.
const PERK_SPEED_H = PRESSURE_MAX_SPEED; // cells/s sideways at most: what a blast throws the body
const PERK_SPEED_V = MAX_SPEED;        // cells/s upward at most: Noita's fastest fall

// ---- pogo stick: Commander Keen 4's (Omnispeak ck_keen.c and ck_phys.c, 70 tics/s). Keen's
// pogo bounces on every landing; holding jump through a bounce keeps gravity low for its 24-tic
// timer, so it goes higher. Simulated tic by tic, Keen's full jump (−40 for 18 tics) rises 1124
// units, a bounce with jump released 750 and one with it held 1518. Here a press of jump timed
// to the landing takes the next bounce one Keen step higher (held − released), and a run of
// timed presses climbs, as Super Mario 64's triple jump climbs with three timed presses; a
// landing without one drops back to the released bounce. Heights are shares of this body's
// own jump (JUMP_SPEED), so they hold whatever the gravity setting.
const POGO_REST = 750 / 1124;          // × jump height: a bounce with no timed press (Keen, jump released)
const POGO_STEP = (1518 - 750) / 1124; // × jump height each timed press adds (Keen's held bounce over its released one)
const POGO_STEPS = 3;                  // timed presses in a row to the top bounce (SM64's triple jump)
const KEEN_TICS = 70;                  // Keen's clock, tics/s
const POGO_WINDOW_S = (24 - 9) / KEEN_TICS;   // s: a press this close to a landing (before or after) is timed: Keen's
                                       // bounce heeds the button until its timer's last 9 tics (0.21 s)

// share of a gap closed over dt by an ease of `share` per Noita frame (frame-rate independent)
const ease = (share, dt) => 1 - (1 - share) ** (NOITA_FPS * dt);

const KIND = ELEMENTS.map((e) => e.kind);
const DENS = ELEMENTS.map((e) => e.dens);
const DRAG = ELEMENTS.map((e) => e.drag);
const fallSpeed = (m) => Math.sqrt(2 * GRAVITY * m / CELL_METERS);   // cells/s after falling m metres
const SAFE_IMPACT = fallSpeed(SAFE_FALL_M);
const LETHAL_IMPACT = fallSpeed(LETHAL_FALL_M);

const solidId = (id) => id === PROBE_OUTSIDE || id === UNKNOWN || (id >= 0 && KIND[id] === K.SOLID);
const isPowder = (id) => id >= 0 && KIND[id] === K.POWDER;
const buries = (id) => solidId(id) || isPowder(id);   // what fills the head and chokes it, swimming through it or not
const isLiquid = (id) => id >= 0 && KIND[id] === K.LIQUID;

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
}

// quiet: a body that isn't the player's (an NPC, npc.js) doesn't announce its jet on povEvents.
// perks: its perk set (perks.js). id: an NPC's id (npc.js), carried as `by` on
// the povEvents its body sends (gibs, eating); the player's has none.
export function createPlayer({ renderer, getSim, quiet = false, perks = createPerkSet(), id = null }) {
  const listeners = {};
  let kicker = null;   // the kick (kick.js), made once the body is
  let rope = null;     // { anchor (Vector3, grid; the setter keeps it current), length, reel (cells/s, 0 holds), hard, brace }
  let revengeWait = 0, revengeDue = false;
  // pogo: the tool's hold (renewed every frame), the climb, and the jump button's timing
  let pogoHold = false, pogoStep = 0, bounceTimed = false;
  let prevJump = false, jumpHeldS = 0, sinceJumpPress = Infinity, sinceBounce = Infinity;
  let gibDue = false;   // vitals.js GIB_HEALTH: the body bursts into meat at the next update (it needs the sim)
  const meat = createMeat({ renderer, getSim });
  const by = id ? { by: id } : {};
  const emit = (name, data) => {
    // Revenge Explosion: a hurt sets one off at the next update (it needs the sim), once a cooldown at most
    if (name === 'hurt' && perks.has('REVENGE_EXPLOSION') && revengeWait <= 0) { revengeDue = true; revengeWait = REVENGE_COOLDOWN; }
    if (name === 'wound') wound(p, data.amount, statusCtx);   // a blow, fall or blast bleeds (stains.js)
    if (name === 'gib') gibDue = true;
    (listeners[name] || []).forEach((fn) => fn(data));
  };
  const vitals = createVitals(emit, perks);
  // the body's size (Shrink): resize() sets these from perks.size every frame,
  // and from the crouch (0 standing … 1 crouched: crouchStep)
  let size = 1, gait = 1, H = BODY_HEIGHT, HW = BODY_WIDTH / 2, EYE = EYE_HEIGHT;
  let crouch = 0;
  const crouchShare = (c, share) => 1 + c * (share - 1);
  const ropeHandY = () => EYE - ROPE_HAND_BELOW_EYE * size;   // cells above the feet the rope pulls at
  function resize() {
    size = perks.size;
    gait = Math.sqrt(size);             // × speeds: Froude similarity
    H = BODY_HEIGHT * size * crouchShare(crouch, CROUCH_HEIGHT);
    HW = BODY_WIDTH / 2 * size;
    EYE = EYE_HEIGHT * size * crouchShare(crouch, CROUCH_EYE);
  }
  // Sand Swimmer: powders don't block the body; it swims through them as through a liquid
  let sandSwim = false;
  const blocks = (id) => solidId(id) || (!sandSwim && isPowder(id));

  const PN = PROBE.X * PROBE.Y * PROBE.Z;
  // Readbacks in flight, one requested per frame, so a fresh probe lands every
  // frame even when each one takes several frames to come back.
  const slots = [...Array(PROBE_INFLIGHT)].map(() => ({
    target: new THREE.WebGLRenderTarget(PROBE.X, PROBE.Y * PROBE.Z, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    }),
    buf: new Float32Array(PN * 4), busy: false,
  }));
  // the last probe that landed (seq orders them: readbacks may resolve out of order)
  let probe = { buf: new Float32Array(PN * 4), origin: [0, 0, 0], valid: false, seq: -1 };
  let generation = 0, seq = 0;
  let latency = LATENCY_INIT;
  const shifted = [0, 0];   // grid cells (x, z) the window has moved over the world in all (windowShifted)

  let mats = null, matKey = '';
  let lastSim = null, lastFrame = 0, dtSmooth = 1 / 60;

  const contactId = new Int32Array(PN), contactT = new Float32Array(PN), contactSpark = new Float32Array(PN);
  const eatCells = [];   // cooked meat touching the body this frame ([x, y, z]), to eat (meat.js)
  const env = { contactId, contactT, contactSpark, contactN: 0, headInLiquid: false, liquidId: E.WATER, buriedId: -1, pressure: 0 };

  const p = {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    onGround: false, inLiquid: false, headInLiquid: false, liquidId: -1,
    submerged: 0,                 // share of the body under liquid, 0..1
    jetFuel: 1,                   // jetpack tank, 0..1
    jetting: false,               // the jetpack is firing this frame
    jetBurnS: 0,                  // s the current press has fired
    jetIdleS: 0,                  // s since the jet last fired
    pogoing: false,               // bouncing on a held pogo stick this frame
    get pogoStep() { return pogoStep; },   // timed presses in a row (0..POGO_STEPS): how high it bounces
    perks,                        // its perks (perks.js)
    get size() { return size; },  // × the plain body's size (Shrink)
    get height() { return H; },   // cells, feet to crown
    get width() { return 2 * HW; },   // cells, the square footprint's side
    get eyeHeight() { return EYE; },  // cells above the feet
    get crouch() { return crouch; },  // 0 standing … 1 crouched
    speedScale: 1,                // × walking and running speed: a class's (classes.js; the Bulwark is slow)
    get health() { return vitals.health; },
    get shield() { return vitals.shield; },             // Energy Shield left (base lives, 0..shieldMax)
    get shieldMax() { return vitals.shieldMax; },
    get shieldCharging() { return vitals.shieldCharging; },
    get breath() { return vitals.breath; },
    get feel() { return vitals.feel; },
    get dead() { return vitals.dead; },
    get cause() { return vitals.cause; },
    get skinT() { return vitals.skinT; },
    get gibbed() { return vitals.gibbed; },   // burst into meat (vitals.js GIB_HEALTH): the body is gone
    set skinT(T) { vitals.skinT = T; },   // a drink trades heat with it (ingest.js)
    stepRate: 0,                  // sim steps/s, as measured
    get kickPose() { return kicker.pose; },   // the kick's progress 0..1 while it shows (figure.js s.kick), else null
    get rope() { return rope; },  // the rope it hangs on (tether), or null
    team: null,                   // a team game's side ('red' | 'blue' | 'infected', src/game), or null
  };
  // statuses (status.js; the built-in ones, Burning's fire and Bleeding: stains.js)
  const bodyWorld = createBodyWorld({ renderer, getSim });
  const statusCtx = { world: bodyWorld, renderer, getSim, hurt: (amount, cause, opts) => vitals.hurt(amount, cause, false, opts) };
  p.status = createStatusSet(p, statusCtx);
  kicker = createKick({ body: p, getSim, cellAt: (x, y, z) => (probe.valid && g ? idAt(x, y, z) : UNKNOWN), unknown: UNKNOWN });
  const impulse = new THREE.Vector3();
  const vB = new THREE.Vector3();

  // ---------------------------------------------------------------- probe
  function ensureMats(sim) {
    const g = sim.g;
    const key = `${g.nx}x${g.ny}x${g.nz}`;
    if (key === matKey) return;
    mats?.probe.dispose();
    mats?.couple.dispose();
    mats?.field.dispose();
    mats = {
      probe: rawMat(povProbeFrag(g), { tA: { value: null }, tB: { value: null }, uBoxLo: { value: new THREE.Vector3() } }),
      couple: rawMat(povCouplingFrag(g), {
        ...stateUniforms(), uFrame: { value: 0 },
        uMin: { value: new THREE.Vector3() }, uMax: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() },
        uPushFluid: { value: 0 }, uPushPowder: { value: 0 }, uLift: { value: 0 }, uAhead: { value: new THREE.Vector2() },
        uOnly: { value: -1 },
      }),
      field: rawMat(povFieldFrag(g), {
        ...stateUniforms(),
        uCenter: { value: new THREE.Vector3() }, uInner: { value: 0 }, uOuter: { value: 0 },
        uFeet: { value: new THREE.Vector3() }, uClear: { value: 0 },
        uCool: { value: 0 }, uFloor: { value: FREEZE_T }, uPressure: { value: 0 },
      }),
    };
    matKey = key;
  }

  function requestProbe(sim) {
    const slot = slots.find((s) => !s.busy);
    if (!slot) return;
    // centre the box where the body will be when the result lands, but keep
    // the body as it is now (and a cell around it) inside, so a fast body
    // never outruns its probe for good
    const lead = [p.vel.x * latency, p.vel.y * latency, p.vel.z * latency];
    bounds();
    const origin = [0, 1, 2].map((a) => {
      const size = PROBE_SIZE[a];
      const want = Math.round((lo[a] + hi[a]) / 2 + lead[a] - size / 2);
      return Math.min(Math.max(want, c1(hi[a]) + 2 - size), c0(lo[a]) - 1);
    });
    const u = mats.probe.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.uBoxLo.value.set(...origin);
    sim.run(mats.probe, slot.target);
    slot.busy = true;
    const gen = generation, mySeq = seq++, t0 = performance.now(), asked = [...shifted];
    renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, PROBE.X, PROBE.Y * PROBE.Z, slot.buf).then(() => {
      slot.busy = false;
      if (gen !== generation || mySeq < probe.seq) return;
      latency += ((performance.now() - t0) / 1000 - latency) * LATENCY_EASE;
      const old = probe.buf;
      // the cells it read, in the grid as it is now (the window may have moved since)
      const at = [origin[0] + asked[0] - shifted[0], origin[1], origin[2] + asked[1] - shifted[1]];
      probe = { buf: slot.buf, origin: at, valid: true, seq: mySeq };
      slot.buf = old;
    }).catch(() => { slot.busy = false; });
  }

  const PROBE_SIZE = [PROBE.X, PROBE.Y, PROBE.Z];
  let g = null;   // grid layout of the current sim
  function local(x, y, z) {
    const o = probe.origin;
    const lx = x - o[0], ly = y - o[1], lz = z - o[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= PROBE.X || ly >= PROBE.Y || lz >= PROBE.Z) return -1;
    return ((ly * PROBE.Z + lz) * PROBE.X + lx) * 4;
  }
  function idAt(x, y, z) {
    if (y < 0 || x < 0 || z < 0 || x >= g.nx || z >= g.nz) return PROBE_OUTSIDE;   // floor and box walls
    if (y >= g.ny) return E.EMPTY;                                                 // open above the box
    const i = local(x, y, z);
    return i < 0 ? UNKNOWN : Math.round(probe.buf[i]);
  }
  const field = (x, y, z, c, dflt) => { const i = local(x, y, z); return i < 0 ? dflt : probe.buf[i + c]; };
  const tAt = (x, y, z) => field(x, y, z, 1, PHYS.AMBIENT);
  const pAt = (x, y, z) => field(x, y, z, 2, 0);
  const sparkAt = (x, y, z) => field(x, y, z, 3, 0);   // a live cell's spark, 0..1 (povBody.js cellSpark)

  // Cell index range a span [lo, hi] overlaps.
  const c0 = (lo) => Math.floor(lo + EPS);
  const c1 = (hi) => Math.ceil(hi - EPS) - 1;

  // Is the body's footprint inside the grid? In a world larger than the grid
  // (docs/scaling.md D11) the cells beyond it aren't loaded yet: a body there
  // (respawned far away) waits for the window to come to it.
  function inGrid() {
    return p.pos.x - HW >= -EPS && p.pos.x + HW <= g.nx + EPS && p.pos.z - HW >= -EPS && p.pos.z + HW <= g.nz + EPS;
  }

  // Is the body's box (and a cell around it) inside the probed box?
  function covered() {
    if (!probe.valid) return false;
    const o = probe.origin;
    return c0(p.pos.x - HW) - 1 >= o[0] && c1(p.pos.x + HW) + 1 < o[0] + PROBE.X
      && c0(p.pos.z - HW) - 1 >= o[2] && c1(p.pos.z + HW) + 1 < o[2] + PROBE.Z
      && c0(p.pos.y) - 1 >= o[1] && c1(p.pos.y + H) + 1 < o[1] + PROBE.Y;
  }

  // ---------------------------------------------------------------- collision
  const lo = [0, 0, 0], hi = [0, 0, 0];
  function bounds() {
    lo[0] = p.pos.x - HW; hi[0] = p.pos.x + HW;
    lo[1] = p.pos.y; hi[1] = p.pos.y + H;
    lo[2] = p.pos.z - HW; hi[2] = p.pos.z + HW;
  }
  const cell = [0, 0, 0];
  // Is any cell of layer i (along axis) across the body's cross-section blocking?
  function layerHit(axis, i) {
    const u = (axis + 1) % 3, w = (axis + 2) % 3;
    for (let a = c0(lo[u]); a <= c1(hi[u]); a++)
      for (let b = c0(lo[w]); b <= c1(hi[w]); b++) {
        cell[axis] = i; cell[u] = a; cell[w] = b;
        const id = idAt(cell[0], cell[1], cell[2]);
        if (blocks(id)) return id;
      }
    return null;
  }
  // Move along one axis by up to d, stopping at the first blocking layer.
  // Returns the distance moved and what stopped it (null if nothing).
  const hit = { d: 0, id: null };
  function sweep(axis, d) {
    bounds();
    hit.d = d; hit.id = null;
    if (d > 0) {
      for (let i = Math.ceil(hi[axis] - EPS), last = Math.ceil(hi[axis] + d - EPS) - 1; i <= last; i++) {
        const id = layerHit(axis, i);
        if (id !== null) { hit.d = Math.max(0, i - hi[axis]); hit.id = id; break; }
      }
    } else if (d < 0) {
      for (let i = Math.floor(lo[axis] + EPS) - 1, last = Math.floor(lo[axis] + d + EPS); i >= last; i--) {
        const id = layerHit(axis, i);
        if (id !== null) { hit.d = Math.min(0, i + 1 - lo[axis]); hit.id = id; break; }
      }
    }
    return hit;
  }
  const comp = ['x', 'y', 'z'];

  // Crouch toward `want`. On the ground the body shrinks from the top; in the
  // air the feet tuck up to the head (Source's crouch-jump). It stands back up
  // only into room: on the ground the head needs the space above, in the air
  // the feet drop back if they can, else the head rises.
  function crouchStep(dt, want) {
    if (crouch === (want ? 1 : 0)) return;
    const next = want ? Math.min(1, crouch + dt / CROUCH_DOWN_S) : Math.max(0, crouch - dt / CROUCH_UP_S);
    const dh = BODY_HEIGHT * size * crouchShare(next, CROUCH_HEIGHT) - H;
    if (dh < 0) {
      if (!p.onGround) p.pos.y -= dh;
    } else if (p.onGround) {
      if (sweep(1, dh).id !== null) return;   // no room to stand: stay down
    } else if (sweep(1, -dh).id === null) p.pos.y -= dh;
    else if (sweep(1, dh).id !== null) return;
    crouch = next;
    resize();
  }

  // A blocked horizontal move: step up onto a ledge up to STEP_HEIGHT high
  // if the body fits there. Returns true if it stepped.
  function tryStep(axis, d) {
    const top = Math.floor(p.pos.y + EPS) + 1;
    const lift = top - p.pos.y;
    if (lift > STEP_HEIGHT) return false;
    if (sweep(1, lift).id !== null) return false;   // no headroom
    const y0 = p.pos.y;
    p.pos.y = top;
    const s = sweep(axis, d);
    if (Math.abs(s.d) < EPS) { p.pos.y = y0; return false; }
    p.pos[comp[axis]] += s.d;
    return true;
  }

  // Powder piling up around the feet (or stale cells) lifts the body out of it,
  // if only the bottom STEP_HEIGHT holds blocking cells and there's headroom.
  function rise() {
    bounds();
    let topBlock = -Infinity;
    for (let y = c0(lo[1]); y <= c1(hi[1]); y++)
      for (let x = c0(lo[0]); x <= c1(hi[0]); x++)
        for (let z = c0(lo[2]); z <= c1(hi[2]); z++) {
          const id = idAt(x, y, z);
          if (id !== UNKNOWN && blocks(id)) topBlock = Math.max(topBlock, y);
        }
    if (topBlock === -Infinity) return;
    const lift = topBlock + 1 - p.pos.y;
    if (lift > STEP_HEIGHT) return;   // buried, not standing in it
    if (sweep(1, lift).id === null) p.pos.y += lift;
  }

  // ---------------------------------------------------------------- environment
  const liqCount = new Float32Array(ELEMENTS.length);
  const env2 = { sub: 0, buoy: 0, densL: 0, dragL: 0, gx: 0, gy: 0, gz: 0, pMean: 0, loose: false };
  function sense() {
    bounds();
    const bx0 = c0(lo[0]), bx1 = c1(hi[0]), bz0 = c0(lo[2]), bz1 = c1(hi[2]);
    const by0 = c0(lo[1]), by1 = c1(hi[1]);
    liqCount.fill(0);
    let sub = 0, buoy = 0, densSum = 0, dragSum = 0, liqN = 0;
    // liquid per layer, over the footprint and a ring around it: the coupling
    // pass pushes liquid out of the body itself, into the ring
    for (let y = by0; y <= by1; y++) {
      const h = Math.min(y + 1, hi[1]) - Math.max(y, lo[1]);
      if (h <= 0) continue;
      let open = 0, liq = 0, dens = 0;
      for (let x = bx0 - 1; x <= bx1 + 1; x++)
        for (let z = bz0 - 1; z <= bz1 + 1; z++) {
          const id = idAt(x, y, z);
          if (solidId(id)) continue;
          open++;
          if (isLiquid(id) || (sandSwim && isPowder(id))) {
            // a swimmer in sand floats in it as in water of its own density: neither bobbing up nor sinking
            liq++; dens += isPowder(id) ? BODY_DENS : DENS[id]; dragSum += DRAG[id]; liqCount[id]++;
          }
        }
      if (!open) continue;
      sub += h * liq / open;
      buoy += h * dens / open;
      densSum += dens; liqN += liq;
    }
    env2.sub = sub / H;
    env2.buoy = buoy / (H * BODY_DENS);
    env2.densL = liqN ? densSum / liqN : 0;
    env2.dragL = liqN ? dragSum / liqN : 0;
    let best = -1;
    for (let i = 0; i < liqCount.length; i++) if (liqCount[i] > 0 && (best < 0 || liqCount[i] > liqCount[best])) best = i;
    p.liquidId = best;

    // head: liquid around the eye, or powder/solid in the eye's own cells
    const ye = Math.floor(p.pos.y + EYE);
    let open = 0, liq = 0, n = 0, buried = 0;
    const buriedCount = {};
    for (let x = bx0 - 1; x <= bx1 + 1; x++)
      for (let z = bz0 - 1; z <= bz1 + 1; z++) {
        const id = idAt(x, ye, z);
        if (id === UNKNOWN) continue;
        if (!solidId(id)) { open++; if (isLiquid(id)) liq++; }
        if (x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1) {
          n++;
          if (buries(id) && id !== PROBE_OUTSIDE) { buried++; buriedCount[id] = (buriedCount[id] || 0) + 1; }
        }
      }
    env.headInLiquid = open > 0 && liq / open >= HEAD_LIQUID_SHARE && p.liquidId >= 0;
    env.liquidId = p.liquidId;
    env.buriedId = -1;
    if (n && buried / n >= BURY_SHARE) {
      env.buriedId = +Object.keys(buriedCount).reduce((a, b) => (buriedCount[a] >= buriedCount[b] ? a : b));
    }

    // pressure over the body: mean (blast damage) and mean gradient (push);
    // solids reflect pressure, as in react.js
    let pn = 0, pSum = 0, gx = 0, gy = 0, gz = 0;
    let loose = false;
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++)
        for (let z = bz0; z <= bz1; z++) {
          const id = idAt(x, y, z);
          if (id >= 0 && id !== E.EMPTY && KIND[id] !== K.SOLID) loose = true;
          if (solidId(id)) continue;
          const P0 = pAt(x, y, z);
          const q = (dx, dy, dz) => (solidId(idAt(x + dx, y + dy, z + dz)) ? P0 : pAt(x + dx, y + dy, z + dz));
          gx += 0.5 * (q(1, 0, 0) - q(-1, 0, 0));
          gy += 0.5 * (q(0, 1, 0) - q(0, -1, 0));
          gz += 0.5 * (q(0, 0, 1) - q(0, 0, -1));
          pSum += P0; pn++;
        }
    env2.gx = pn ? gx / pn : 0; env2.gy = pn ? gy / pn : 0; env2.gz = pn ? gz / pn : 0;
    env.pressure = pn ? pSum / pn : 0;
    env2.loose = loose;

    // contact: cells touching or inside the body
    let cn = 0;
    eatCells.length = 0;
    for (let y = c0(lo[1] - CONTACT_REACH); y <= c1(hi[1] + CONTACT_REACH); y++)
      for (let x = c0(lo[0] - CONTACT_REACH); x <= c1(hi[0] + CONTACT_REACH); x++)
        for (let z = c0(lo[2] - CONTACT_REACH); z <= c1(hi[2] + CONTACT_REACH); z++) {
          const id = idAt(x, y, z);
          if (id < 0) continue;
          contactId[cn] = id;
          contactT[cn] = tAt(x, y, z);
          contactSpark[cn] = sparkAt(x, y, z);   // status.js shock
          cn++;
          if (id === E.COOKED_MEAT && eatCells.length < EAT_CELLS_MAX) eatCells.push([x, y, z]);
        }
    env.contactN = cn;
  }

  // ---------------------------------------------------------------- coupling
  function couple(sim, stepRate) {
    if (!env2.loose || stepRate <= 0) return;
    const u = mats.couple.uniforms;
    bounds();
    u.uMin.value.set(lo[0], lo[1], lo[2]);
    u.uMax.value.set(hi[0], hi[1], hi[2]);
    u.uVel.value.copy(p.vel).divideScalar(stepRate).clampScalar(-PHYS.V_MAX, PHYS.V_MAX);
    const speed = p.vel.length();
    u.uPushFluid.value = DISPLACE_PUSH_FLUID * Math.min(1, speed / DISPLACE_FULL_SPEED);
    u.uPushPowder.value = DISPLACE_PUSH_POWDER;
    u.uLift.value = speed > EPS ? DISPLACE_LIFT * Math.max(0, -p.vel.y) / speed : 0;
    u.uAhead.value.set(p.vel.x, p.vel.z).multiplyScalar(speed > EPS ? DISPLACE_AHEAD / speed : 0);
    u.uFrame.value = sim.frame;
    u.uOnly.value = -1;
    // it changes only cells whose centres are in the body's box (shaders/povBody.js),
    // so only those are rebuilt and woken (Simulation.touch)
    sim.touchCentres(lo, hi);
    sim.pass(mats.couple);
  }

  // ---------------------------------------------------------------- perk fields
  // Lukki: a wall or ceiling within reach of the body's sides or top
  function clinging() {
    bounds();
    for (let y = c0(lo[1]); y <= c1(hi[1] + LUKKI_REACH); y++)
      for (let x = c0(lo[0] - LUKKI_REACH); x <= c1(hi[0] + LUKKI_REACH); x++)
        for (let z = c0(lo[2] - LUKKI_REACH); z <= c1(hi[2] + LUKKI_REACH); z++) {
          const id = idAt(x, y, z);
          if (id !== UNKNOWN && blocks(id)) return true;
        }
    return false;
  }

  // One pass of shaders/povBody.js povFieldFrag over a shell around the body's middle.
  function perkField(sim, { inner, outer, cool = 0, pressure = 0, clear = 0 }) {
    const u = mats.field.uniforms;
    u.uCenter.value.set(p.pos.x, p.pos.y + H / 2, p.pos.z);
    u.uInner.value = inner;
    u.uOuter.value = outer;
    u.uFeet.value.copy(p.pos);
    u.uClear.value = clear;
    u.uCool.value = cool;
    u.uPressure.value = pressure;
    const c = u.uCenter.value;
    sim.touchCentres([c.x - outer, c.y - outer, c.z - outer], [c.x + outer, c.y + outer, c.z + outer]);
    sim.pass(mats.field);
  }

  // Rain Cloud: its sphere over the head, as the probe saw it; the breeze; the brush
  const cloudAt = new THREE.Vector3();
  let cloudOwed = 0;   // cells of its own cloud that may still be alive
  const cloud = { air: 0, cloud: 0, cells: 0, known: 0 };
  function rainCloud(sim, dt, r, stepRate) {
    const c = cloudAt.set(p.pos.x, p.pos.y + H + CLOUD_GAP + r, p.pos.z);
    cloud.air = 0; cloud.cloud = 0; cloud.cells = 0; cloud.known = 0;
    for (let y = Math.floor(c.y - r); y <= Math.floor(c.y + r) && y < g.ny; y++)
      for (let x = Math.floor(c.x - r); x <= Math.floor(c.x + r); x++)
        for (let z = Math.floor(c.z - r); z <= Math.floor(c.z + r); z++) {
          if ((x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 + (z + 0.5 - c.z) ** 2 > r * r) continue;
          cloud.cells++;
          const id = idAt(x, y, z);
          if (id === UNKNOWN) continue;   // (a big cloud reaches past the probe's top)
          cloud.known++;
          if (id === E.EMPTY) cloud.air++; else if (id === E.CLOUD) cloud.cloud++;
        }
    if (!cloud.known) return;
    // the sphere's cells past the probe are taken to hold what the probed ones do
    const whole = cloud.cells / cloud.known;
    cloud.air *= whole; cloud.cloud *= whole;
    // the breeze: what's there moves with the body (cloud only: rain falls out of it freely)
    if (cloud.cloud && stepRate > 0) {
      const u = mats.couple.uniforms;
      u.uMin.value.set(c.x - r, c.y - r, c.z - r);
      u.uMax.value.set(c.x + r, c.y + r, c.z + r);
      u.uVel.value.copy(p.vel).divideScalar(stepRate).clampScalar(-PHYS.V_MAX, PHYS.V_MAX);
      u.uPushFluid.value = 0; u.uPushPowder.value = 0; u.uLift.value = 0; u.uAhead.value.set(0, 0);
      u.uFrame.value = sim.frame;
      u.uOnly.value = E.CLOUD;
      sim.touchCentres([c.x - r, c.y - r, c.z - r], [c.x + r, c.y + r, c.z + r]);
      sim.pass(mats.couple);
    }
    // the brush: top the air up to CLOUD_FILL, at the seed rate at most, within the budget
    const want = Math.min(CLOUD_FILL * (cloud.air + cloud.cloud) - cloud.cloud, CLOUD_SEED_RATE * dt, CLOUD_BUDGET - cloudOwed);
    if (!(want > 0) || !cloud.air) return;
    sim.paint({ center: c, radius: r, shape: 0, tool: E.CLOUD, rate: want / (cloud.air * CLOUD_SPAWN), replace: false });
    cloudOwed += Math.min(want, cloud.air);
  }

  // Freeze Field and Rain Cloud every frame; a Revenge Explosion when one is due
  function fields(sim, dt, stepRate) {
    const r = vitals.dead ? 0 : perks.freezeRadius;
    if (r > 0 && dt > 0) perkField(sim, { inner: 0, outer: r, cool: FREEZE_RATE * dt, clear: HW + FREEZE_CLEAR });
    cloudOwed *= Math.exp(-dt / CLOUD_LIFE_S);
    const cr = vitals.dead ? 0 : perks.cloudRadius;
    if (cr > 0 && dt > 0) rainCloud(sim, dt, cr, stepRate);
    if (!revengeDue) return;
    revengeDue = false;
    const pressure = perks.revengePressure;
    if (!(pressure > 0)) return;
    perkField(sim, { inner: REVENGE_INNER, outer: Math.max(perks.revengeRadius, REVENGE_INNER + REVENGE_SHELL_MIN), pressure });
    emit('revenge', { point: p.pos.clone().setY(p.pos.y + H / 2) });
  }

  // ---------------------------------------------------------------- update
  const wish = new THREE.Vector2();
  function update(dtIn, input = {}) {
    const sim = getSim();
    if (!sim) return;
    const dt = Math.min(Math.max(dtIn, 0), MAX_DT);
    revengeWait = Math.max(0, revengeWait - dt);
    kicker.update(dt);
    sandSwim = perks.has('SAND_SWIMMER') && !vitals.dead;
    resize();
    if (sim !== lastSim) {
      lastSim = sim; lastFrame = sim.frame;
      g = sim.g;
      generation++; probe.valid = false;
      ensureMats(sim);
    }
    // sim steps since last frame → step rate (0 while paused)
    const steps = Math.max(0, sim.frame - lastFrame);
    lastFrame = sim.frame;
    if (dt > 0) dtSmooth += (dt - dtSmooth) * DT_EASE;
    const stepRate = steps / dtSmooth;
    p.stepRate = stepRate;

    const ready = covered() && inGrid();
    requestProbe(sim);
    if (gibDue) {
      gibDue = false;
      const point = p.pos.clone().setY(p.pos.y + H / 2);
      meat.gib(p.pos, p.vel, stepRate, (placed, lost) => povEvents.emit('body:gib', { point, cells: placed, lost, ...by }));
    }
    meat.update();
    if (vitals.gibbed) return;   // nothing left of the body to move, feel or push
    if (!ready || dt === 0) return;

    sense();
    const alive = !vitals.dead;
    const sub = env2.sub;
    p.submerged = sub;
    const wasIn = p.inLiquid;
    p.inLiquid = sub >= WADE_SHARE;
    p.headInLiquid = env.headInLiquid;
    if (p.inLiquid && !wasIn) emit('splash', { speed: p.vel.length() });

    const v = p.vel;
    const v0 = v.clone();   // an axis that runs into unprobed cells keeps this (its time didn't pass)
    const stalled = [false, false, false];
    const grav = GRAVITY * sim.gravity / SIM_GRAVITY_REF;
    const swimming = sub >= SWIM_SHARE;

    // the jump button's timing (the pogo's timed presses)
    const jumpDown = alive && !!input.jump;
    const pressed = jumpDown && !prevJump;
    prevJump = jumpDown;
    jumpHeldS = jumpDown ? jumpHeldS + dt : 0;
    sinceJumpPress = pressed ? 0 : sinceJumpPress + dt;
    sinceBounce += dt;
    const pogoing = alive && pogoHold && !swimming;   // it doesn't bounce off liquid: it sinks in
    pogoHold = false;
    p.pogoing = pogoing;
    if (!pogoing) pogoStep = 0;

    crouchStep(dt, alive && !!input.crouch && !swimming);

    // controls
    wish.set(alive ? input.move?.x ?? 0 : 0, alive ? input.move?.z ?? 0 : 0);
    if (wish.length() > 1) wish.normalize();
    const vh = new THREE.Vector2(v.x, v.z);
    let jumpedNow = false;
    // Fleet Foot and Rocket Boots: ×2 a stack, up to what the probe keeps up with; a class's speedScale on foot
    // Shrink: × gait (√size); the jet's own speeds too
    // Crouched: no sprint, and a third of the speed on the ground
    const sprinting = alive && input.sprint && crouch === 0;
    const footSpeed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * p.speedScale * p.status.moveScale * gait
      * (p.onGround ? crouchShare(crouch, CROUCH_SPEED) : 1);
    const jetFly = JET_FLY_SPEED * gait;
    const runSpeed = p.jetting ? Math.min(jetFly * perks.jetRate, Math.max(jetFly, PERK_SPEED_H))
      : sprinting ? Math.min(footSpeed * perks.sprintRate, Math.max(footSpeed, PERK_SPEED_H)) : footSpeed;
    const swingingOnRope = !!rope?.hard && !p.onGround && !swimming;
    if (swingingOnRope) {
      // on a rope in the air: Noita's ease only ever adds speed toward the wished
      // direction (it never brakes), so a swing keeps its momentum and can be pumped
      if (wish.lengthSq() > 0) {
        const dir = wish.clone().normalize();
        const want = runSpeed * wish.length(), along = vh.dot(dir);
        if (along < want) vh.addScaledVector(dir, (want - along) * ease(MOVE_EASE, dt));
      }
    } else if (!swimming && (p.onGround || wish.lengthSq() > 0 || vh.length() <= runSpeed)) {
      // Noita: ease toward the wished speed, on the ground and in the air alike.
      // With no input in the air faster than a run (a blast), keep the momentum.
      vh.lerp(wish.clone().multiplyScalar(runSpeed), ease(MOVE_EASE, dt));
      if (p.onGround && alive && input.jump && !pogoing) { v.y = JUMP_SPEED * gait; p.onGround = false; jumpedNow = true; }
    } else if (swimming && wish.lengthSq() > 0) {
      // strokes: accelerate toward the wished speed, never brake
      const dir = wish.clone().normalize();
      const add = Math.min(Math.max(SWIM_SPEED * gait * wish.length() - vh.dot(dir), 0), SWIM_ACCEL * dt);
      vh.addScaledVector(dir, add);
    }
    v.x = vh.x; v.z = vh.y;
    if (alive && p.inLiquid) {
      if (input.jump && swimming) v.y += SWIM_UP * GRAVITY * dt;
      if (input.down) v.y -= SWIM_DOWN * GRAVITY * dt;
    }

    // pogo: every landing bounces; a press timed to it climbs a step, a landing without one drops back
    const bounceSpeed = (step) => Math.sqrt(2 * grav * (POGO_REST + POGO_STEP * step) * JUMP_SPEED * JUMP_SPEED / (2 * GRAVITY));
    if (pogoing && p.onGround) {
      bounceTimed = sinceJumpPress <= POGO_WINDOW_S;
      pogoStep = bounceTimed ? Math.min(POGO_STEPS, pogoStep + 1) : 0;
      if (bounceTimed) sinceJumpPress = Infinity;   // the press is used up
      // + half a frame of gravity: each step below takes a whole frame's off before moving
      // (semi-implicit Euler), which would cost the apex v·dt/2 and make it hang on the frame
      // rate. The typical frame (dtSmooth), not this one, so one slow frame doesn't skew it.
      v.y = bounceSpeed(pogoStep) + grav * dtSmooth / 2;
      p.onGround = false; jumpedNow = true; sinceBounce = 0;
      emit('pogo', { step: pogoStep, timed: bounceTimed, speed: v.y });
    } else if (pogoing && pressed && !bounceTimed && sinceBounce <= POGO_WINDOW_S && v.y > 0 && pogoStep < POGO_STEPS) {
      // pressed just after the bounce: this one still climbs (same apex as if it had been on time)
      const before = bounceSpeed(pogoStep);
      pogoStep++;
      v.y = Math.sqrt(Math.max(0, v.y * v.y + bounceSpeed(pogoStep) ** 2 - before * before));
      bounceTimed = true; sinceJumpPress = Infinity;
      emit('pogo', { step: pogoStep, timed: true, late: true, speed: v.y });
    }

    // jetpack: thrust while jump is held in the air (swimming strokes instead). On a pogo a tap is
    // a bounce, so the jet waits until jump has been held past the bounce's window.
    // Lukki: while a limb touches a wall or ceiling the jet fires on an empty tank, and the tank holds
    // Rocket Boots: climbs faster; Big Tank: a bigger tank (the same refill rates fill it slower, as in Noita)
    const tankS = JET_FUEL_S * perks.fuelRate;
    // Levitating (Levitatium, potions.js): Noita's Faster Levitation, 75% faster, and here the tank holds
    const levitating = p.status.has('LEVITATING');
    const jetRise = Math.min(JET_RISE * gait * perks.jetRate * (levitating ? LEVITATE_RISE : 1), Math.max(JET_RISE * gait, PERK_SPEED_V));
    const jetWants = alive && !!input.jump && (!pogoing || jumpHeldS > POGO_WINDOW_S);
    const clings = jetWants && !p.onGround && !swimming && ((perks.has('LUKKI') && clinging()) || levitating);
    const jet = jetWants && !p.onGround && !jumpedNow && !swimming && (p.jetFuel > 0 || clings);
    if (jet) {
      if (!clings) p.jetFuel = Math.max(0, p.jetFuel - dt / tankS);
      p.jetBurnS += dt;
      p.jetIdleS = 0;
      if (v.y < jetRise) v.y += (jetRise - v.y) * ease(JET_EASE, dt);
    } else {
      if (p.jetting && p.jetBurnS < JET_TAP_S && !clings) p.jetFuel = Math.max(0, p.jetFuel - (JET_TAP_S - p.jetBurnS) / tankS);
      p.jetBurnS = 0;
      p.jetIdleS += dt;
    }
    if (jet !== p.jetting) { p.jetting = jet; if (!quiet) povEvents.emit('player:jet', { on: jet }); }

    // gravity and buoyancy (Archimedes over the submerged share)
    v.y += (env2.buoy - (jet ? 0 : 1)) * grav * dt;   // the jet holds you up as Noita's does
    // Slow Fall: the canopy's drag on the way down, taken implicitly (v' = v − k·v'·|v'|·dt, solved
    // for v'), so it settles on √(g/k) exactly at any frame rate
    const canopy = perks.slowFallArea;
    if (canopy > 0 && v.y < 0 && !p.inLiquid) {
      const kd = SLOW_FALL_K * canopy / size * dt;   // drag ∝ area/mass: 1/size (Shrink)
      v.y = (1 - Math.sqrt(1 - 4 * kd * v.y)) / (2 * kd);
    }
    // drag in liquid, scaled by how much of the body is in it
    if (sub > 0 && env2.densL > 0) {
      const k = (VISCOUS_DRAG * env2.dragL / (size * size) + FORM_DRAG * env2.densL / BODY_DENS * v.length() / size) * sub;   // (Shrink: Stokes 1/s², form 1/s)
      v.multiplyScalar(Math.exp(-k * dt));
    }

    // pressure: a = −∇P·P_ACCEL/ρ per step², for each step the sim took
    if (steps > 0) {
      const k = -PHYS.P_ACCEL / RHO_BODY * steps * stepRate;   // (cells/step² per unit ∇P) × steps × (steps/s) → cells/s
      const before = v.length();
      v.x += env2.gx * k; v.y += env2.gy * k; v.z += env2.gz * k;
      const after = v.length();
      if (after > PRESSURE_MAX_SPEED && after > before) v.setLength(Math.max(PRESSURE_MAX_SPEED, before));
    }
    // an impulse is a plain body's change of velocity: momentum over its mass. A smaller body
    // (Shrink, mass ∝ size³) takes the same momentum, so it's thrown 1/size³ as fast; what the
    // smaller mass adds stops at a blast's throw (PRESSURE_MAX_SPEED: the probe keeps up)
    if (size < 1 && impulse.lengthSq() > 0) {
      const plain = vB.copy(v).add(impulse).length();
      v.addScaledVector(impulse, 1 / size ** 3);
      const cap = Math.max(PRESSURE_MAX_SPEED, plain);
      if (v.length() > cap) v.setLength(cap);
    } else v.add(impulse);
    impulse.set(0, 0, 0);
    if (rope && alive) pullRope(v, dt);
    if (v.length() > MAX_SPEED) v.setLength(MAX_SPEED);

    // move, with collisions
    const wasGround = p.onGround;
    const jumped = v.y > 0 && wasGround;
    rise();
    p.onGround = false;
    let landSpeed = 0, slam = 0, slamId = -1;
    const n = Math.max(1, Math.ceil(v.length() * dt / SUBSTEP));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      const vy = v.y;
      const ry = sweep(1, vy * h);
      p.pos.y += ry.d;
      if (ry.id === UNKNOWN) stalled[1] = true;
      else if (ry.id !== null) {
        if (vy < 0) { p.onGround = true; landSpeed = Math.max(landSpeed, -vy); }
        else { slam = Math.max(slam, vy); slamId = ry.id; }
        v.y = 0;
      }
      for (const axis of [0, 2]) {
        const c = comp[axis];
        const d = v[c] * h;
        if (!d) continue;
        const r = sweep(axis, d);
        if (r.id === null) { p.pos[c] += d; continue; }
        if (r.id === UNKNOWN) { p.pos[c] += r.d; stalled[axis] = true; continue; }
        const id = r.id, moved = r.d;
        p.pos[c] += moved;
        if ((p.onGround || wasGround || p.inLiquid) && tryStep(axis, d - moved)) continue;
        if (Math.abs(v[c]) > slam) { slam = Math.abs(v[c]); slamId = id; }
        v[c] = 0;
      }
    }
    stalled.forEach((st, a) => { if (st) v[comp[a]] = v0[comp[a]]; });
    // follow the ground down small ledges
    if (!p.onGround && wasGround && !jumped && !swimming) {
      const r = sweep(1, -STEP_DOWN);
      if (r.id !== null && r.id !== UNKNOWN) { p.pos.y += r.d; p.onGround = true; v.y = Math.min(v.y, 0); }
    }

    if (p.onGround) p.jetFuel = Math.min(1, p.jetFuel + dt * JET_REFILL_GROUND / tankS);
    else if (p.jetIdleS > JET_AIR_WAIT_S) p.jetFuel = Math.min(1, p.jetFuel + dt * JET_REFILL_AIR / tankS);

    // landing and impacts. Landings never hurt, as in Noita (no fall damage);
    // being thrown into a wall or ceiling (a blast) still does. On a pogo the
    // spring takes landings and head bonks up to the top bounce's own speed:
    // those are bounces ('pogo'), not landings.
    const pogoSafe = pogoing ? bounceSpeed(POGO_STEPS) + grav * MAX_DT : 0;   // (+ what a longest frame's step adds)
    if (p.onGround && !wasGround && landSpeed > Math.max(LAND_EVENT_SPEED, pogoSafe)) emit('land', { speed: landSpeed });
    if (slam > 0) vitals.impact(slam, Math.max(SAFE_IMPACT, pogoSafe), LETHAL_IMPACT, 0, slamId >= 0 ? slamId : -1);

    env.size = size;   // (a smaller body's skin warms and cools faster)
    vitals.update(dt, env);
    p.status.update(dt, env);
    eat();
    couple(sim, stepRate);
    fields(sim, dt, stepRate);
  }

  // The rope's pull on velocity v this frame (see ROPE_*).
  const ropeDir = new THREE.Vector3(), ropeCross = new THREE.Vector3();
  function pullRope(v, dt) {
    ropeDir.set(rope.anchor.x - p.pos.x, rope.anchor.y - p.pos.y - ropeHandY(), rope.anchor.z - p.pos.z);
    const dist = ropeDir.length();
    if (dist < EPS) return;
    ropeDir.divideScalar(dist);   // toward the anchor
    const braced = rope.brace && p.onGround;   // a light catch: the ground holds the body (tug.js brace)
    if (rope.reel > 0 && !braced) {
      rope.length = Math.min(rope.length, dist);   // the winch takes up the slack
      const closing = v.dot(ropeDir);
      // across the rope: damped toward still; along it: eased toward the reel speed
      const across = ropeCross.copy(v).addScaledVector(ropeDir, -closing);
      v.addScaledVector(across, -ease(ROPE_SWAY_EASE, dt));
      if (closing < rope.reel) v.addScaledVector(ropeDir, (rope.reel - closing) * ease(ROPE_EASE, dt));
    }
    if (!rope.hard) return;
    const closing = v.dot(ropeDir);
    if (dist >= rope.length - ROPE_SLACK && closing < 0) v.addScaledVector(ropeDir, -closing);
    if (dist > rope.length) v.addScaledVector(ropeDir, (dist - rope.length) * ROPE_BAUMGARTE / dt);
  }

  // Cooked meat touching the body is eaten, as a pickup, while it isn't at
  // full health (Quake's T_Heal, items.qc: a full body leaves a health box
  // where it is); raw meat isn't.
  function eat() {
    const want = vitals.eatWant();
    if (!want || !eatCells.length) return;
    const point = p.pos.clone().setY(p.pos.y + H / 2);
    meat.eat(eatCells, want, (n) => {
      vitals.eat(n);
      emit('eat', { cells: n });
      povEvents.emit('body:eat', { point, cells: n, ...by });
    });
  }

  function spawn(feet) {
    rope = null;
    crouch = 0;
    resize();
    p.pos.copy(feet);
    p.vel.set(0, 0, 0);
    impulse.set(0, 0, 0);
    p.onGround = false; p.inLiquid = false; p.headInLiquid = false; p.liquidId = -1; p.submerged = 0;
    p.jetFuel = 1; p.jetBurnS = 0; p.jetIdleS = 0;
    p.pogoing = false; pogoStep = 0; bounceTimed = false; prevJump = false; jumpHeldS = 0; sinceJumpPress = Infinity; sinceBounce = Infinity;
    if (p.jetting) { p.jetting = false; if (!quiet) povEvents.emit('player:jet', { on: false }); }
    generation++; probe.valid = false;   // wait for cells around the new spot
    vitals.reset();
    p.status.clearAll('spawn');
    gibDue = false;
  }

  function dispose() {
    generation++;
    bodyWorld.dispose();
    slots.forEach((s) => s.target.dispose());
    mats?.probe.dispose();
    mats?.couple.dispose();
    mats?.field.dispose();
    mats = null; matKey = '';
    for (const k in listeners) delete listeners[k];
  }

  // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md D11):
  // the grid moved the other way under the body, which stays put in the world.
  // Every probe holds the cells it read: the last one moves back with the
  // grid, and the ones in flight do when they land (requestProbe), so the
  // body never waits for a fresh one.
  function windowShifted(dx, dz) {
    p.pos.x -= dx;
    p.pos.z -= dz;
    meat.windowShifted(dx, dz);
    probe.origin = [probe.origin[0] - dx, probe.origin[1], probe.origin[2] - dz];
    shifted[0] += dx;
    shifted[1] += dz;
  }

  return Object.assign(p, {
    spawn, update, dispose, windowShifted,
    applyImpulse(dv) { impulse.add(dv); },
    ownBlast() { vitals.ownBlast(); },
    // a jump to another spot (Teleportitis, potions.js): health and statuses kept, the probe re-read there
    teleport(feet) {
      p.pos.copy(feet); p.vel.set(0, 0, 0); impulse.set(0, 0, 0); p.onGround = false;
      generation++; probe.valid = false;
    },
    heal(amount) { if (!vitals.dead) vitals.health = Math.min(1, vitals.health + amount); },   // Regeneration (potions.js)   // a blast it set off (a rocket, a bomb): it hurts this body less (vitals.js)
    // a blow from outside the sim (an NPC's axe): the Energy Shield takes it first;
    // { lethal: true } takes all the health there is, through the shield (a backstab);
    // { shielded: false } passes the shield (a drink hurts from inside: ingest.js)
    hurt(amount, cause, { lethal = false, shielded = true } = {}) { vitals.hurt(amount, cause, true, { shielded, lethal }); },
    holdPogo() { pogoHold = true; },   // a pogo stick in hand: call every frame it's held (tools/pogo.tool.js)
    // Kick along unit dir (kick.js): a body ability, the player's key and an NPC alike. The result, or null while it recovers.
    kick(dir) { return kicker.kick(dir); },
    get kicker() { return kicker; },   // for checks (kicker.walked: the cells the last kick's ray crossed)
    // Hang on a rope (see ROPE_*): { anchor, length, reel, hard, brace }, kept by reference (the setter
    // moves anchor and changes reel); null lets go. The point it pulls at: ropeHand().
    tether(r) { rope = r; },
    ropeHand(out = new THREE.Vector3()) { return out.set(p.pos.x, p.pos.y + ropeHandY(), p.pos.z); },
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
      return () => { listeners[name] = listeners[name].filter((f) => f !== fn); };
    },
  });
}
