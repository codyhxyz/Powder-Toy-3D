import * as THREE from 'three';
import { prelude, quadVert, stateOutGLSL, copyThroughMain, stateUniforms } from './common.js';
import { BODY_WIDTH } from '../pov/constants.js';
import { ELEMENTS, E } from '../elements.js';
import { PHYS as ENGINE } from '../physics.js';

// GPU passes for the POV axe, pickaxe, physgun, flamethrower, torch and rocket (src/pov/tools/*.tool.js).
//
// Each is a full-grid ping-pong pass run through sim.pass(mat), like the
// brush (paintFrag in passes.js): every texel copies its cell, and only the
// cells inside the tool's small region change. The tools only set up inputs
// the engine already understands (which element a cell holds, its velocity);
// the move and react passes do the physics from there.
//
// Units: cells, cells/step, and the sim's kinetic energy ½·DENS·|v|² (the
// unit of ELEMENTS[].hard, HARD[] in GLSL).

// Axe: one swing delivers AXE.ENERGY at the centre of a wide, shallow patch
// (an ellipsoid, flat along the swing) and less toward its rim:
//   E(r) = ENERGY · (1 − r²),   r = ellipsoid distance (0 centre, 1 rim).
// A breakable solid breaks where E ≥ its hardness. With ENERGY 24 that is
//   WOOD  (20)  r² ≤ 0.17: the hit cell and its four side neighbours
//   GLASS  (8)  r² ≤ 0.67: about 2.4 cells across, two layers deep
//   ICE    (6)  r² ≤ 0.75, PLANT (2) r² ≤ 0.92: nearly the whole patch
//   ROCK  (30), METAL (60): never.
export const AXE = {
  ENERGY: 24,        // sim KE units at the patch centre (below ROCK's 30, above WOOD's 20)
  RADIUS: 3,         // cells, half-width of the patch across the swing
  DEPTH: 1.5,        // cells, half-depth of the patch along the swing
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut (more energy goes into the fracture)
  SHOVE: 0.25,       // cells/step pushed into loose powder at the patch centre
};

// Pickaxe: the same blow (blowFrag below) from a heavier, pointed head, so
// more energy in a patch that is narrower for its depth: it bites into rock
// where the axe bounces off. With ENERGY 52, RADIUS 2.2, DEPTH 2.5:
//   ROCK  (30)  r² ≤ 0.42: the hit cell's 3×3 face, and the cell behind it and
//                its four side neighbours behind (14 cells a swing)
//   WOOD  (20)  r² ≤ 0.62, GLASS (8) r² ≤ 0.85: a little more than that
//   METAL (60): never.
export const PICK = {
  ENERGY: 52,        // sim KE units at the patch centre (above ROCK's 30, below METAL's 60)
  RADIUS: 2.2,       // cells, half-width of the patch across the swing
  DEPTH: 2.5,        // cells, half-depth of the patch along the swing
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut
  SHOVE: 0.25,       // cells/step pushed into loose powder at the patch centre
};

// Knife: the same blow from a blade, which is for bodies (tools/knife.tool.js), not cells. Its
// energy sits just over PLANT's and ICE's hardness (6) and under GLASS's (8), in a patch no
// bigger than the struck cell: it cuts a plant or chips ice where it lands and nothing harder.
export const KNIFE = {
  ENERGY: 7,         // sim KE units at the patch centre (above PLANT and ICE's 6, below GLASS's 8)
  RADIUS: 0.8,       // cells, half-width across the stab: the struck cell
  DEPTH: 1,          // cells, half-depth along it
  CHIP_MAX: 0.3,     // cells/step, fastest a chip leaves the cut
  SHOVE: 0.1,        // cells/step pushed into loose powder: a blade parts it, it doesn't shovel
};

// Physgun: a spring on the centre of mass of the loose matter near a hold
// point (powders, liquids, gases within RADIUS of it, fading toward RADIUS).
//
// physgunComFrag sums that matter (mass = DENS, times the falloff) into one
// texel: its centre of mass and how many cells it is. physgunFrag then moves
// it as one ball:
//   v_ball = carry + (hold − com)·SPRING
// carry is the hold point's own velocity, so the ball keeps up as you turn.
// Every cell of the ball (within the radius a sphere of that many cells,
// PACKING full, would have, plus CORE_PAD) gets exactly v_ball. Moving them in
// lockstep matters: the move pass treats a cell pushing slowly into the one
// above it as resting on it and stops it, so a per-cell spring that squeezes
// the ball would let its underside sag out of it every step. Cells outside
// the ball are pulled toward its centre at PULL per cell of distance (up to
// PULL_MAX) and settle onto it; their velocity relaxes toward that at GRIP per
// step (the damping), weighted by the falloff. The field bears the full weight
// of everything within RADIUS, so what it reaches floats while it's drawn in.
//
// Gravity: the pass runs once per frame, before the frame's N steps, and
// each step's react takes g·GRAV from the velocity after its move. The moves
// see on average (N − 1)/2 steps of it, so a held cell is launched at
//   v = v_mean + g·GRAV·(N − 1)/2
// and its velocity left at the frame's end is read back as the mean it had,
// v_end + g·GRAV·(N + 1)/2. In all, N steps of gravity per frame are paid back.
export const PHYS = {
  RADIUS: 5.5,       // cells, reach of the beam around the hold point
  CORE: 0.7,         // share of RADIUS the falloff holds at full strength (a ball of ~130 cells)
  PACKING: 0.6,      // share of a held ball's volume that is matter (moving cells leave gaps)
  CORE_PAD: 0.5,     // cells added to the ball's radius: what moves in lockstep
  SPRING: 0.25,      // 1/step: ball velocity per cell its centre is off the hold point
  PULL: 0.3,         // 1/step: speed toward the ball per cell a stray cell is outside it
  PULL_MAX: 0.6,     // cells/step, fastest strays are drawn in
  GRIP: 0.35,        // per step: share of a stray's velocity gap closed (damping)
  FLING: 0.9,        // cells/step: speed a right-click throws the held matter at
  HOLD_MAX: 32,      // cells from the eye
  GRAB_STANDOFF: 2,  // cells: the hold point starts this far in front of the aimed surface, so the ball forms in the open
  WHEEL_STEP: 1,     // cells of hold distance per wheel notch
};
// cells from the eye: the nearest hold point keeps the beam's reach clear of the body
PHYS.HOLD_MIN = PHYS.RADIUS + BODY_WIDTH;
export const PHYS_MODE = { HOLD: 0, FLING: 1 };

// Physgun blast (right-click with nothing held, the gravity gun's punt): one
// impulse into the loose matter in a cone from the muzzle along the aim. Every
// cell gets the same momentum, so it leaves at
//   Δv = IMPULSE / DENS · falloff
// (water and sand at V_MAX, metal dust 0.2 cells/step, gases capped at V_MAX),
// pointing away from the muzzle. falloff fades toward the cone's end and its
// rim. The cone stops BITE cells past the aimed face, so walls shield what's
// behind them. Solids don't move: there are no rigid bodies.
//
// The shove alone barely dents a pile or a pool: the struck layer runs into
// the still matter behind it, which has nowhere to go. So where the cone meets
// a surface it also leaves a pressure pulse (the air pressure the engine
// already carries, react.js), centred PULSE_DEPTH past the face: just under a
// water surface or inside a pile. The engine's pressure gradient then throws
// what lies above and around it up and out, a splash or a crater. The pulse is
// PULSE_SHARE of the pressure that breaks the weakest breakable solid
// (hard · P_BREAK_PER_HARD), so it never smashes one.
const WEAKEST_HARD = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));
export const BLAST = {
  IMPULSE: 16,       // DENS · cells/step given to each cell at full strength
  RANGE: 16,         // cells from the muzzle
  RADIUS0: 1,        // cells, the cone's radius at the muzzle
  SPREAD: 0.35,      // cells of radius gained per cell along it
  BITE: 1.5,         // cells past the aimed face it still pushes
  EDGE: 0.6,         // share of the radius / range held at full strength before fading
  COOLDOWN: 0.4,     // s between blasts
  PULSE_DEPTH: 1,    // cells past the aimed face the pulse is centred
  PULSE_RADIUS: 2.5, // cells, the pulse's reach (full strength inside EDGE of it)
  PULSE_SHARE: 0.8,  // share of the weakest solid's breaking pressure
};
BLAST.PULSE_P = BLAST.PULSE_SHARE * WEAKEST_HARD * ENGINE.P_BREAK_PER_HARD;

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = (prefix, obj) =>
  Object.entries(obj).map(([k, v]) => `#define ${prefix}_${k} ${v < 0 ? `(${f(v)})` : f(v)}`).join('\n');

const head = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
`;

// A melee blow (the axe, the pickaxe; P is AXE or PICK): break breakable
// solids in its patch into their debris, 1:1 (same cell, temperature, life and
// ctype: only the element changes), and nudge loose powder along the swing.
const blowFrag = (P) => (g) => /* glsl */ `
${head(g)}
${defines('BLOW', P)}
#define BLOW_REACH max(BLOW_RADIUS, BLOW_DEPTH)
uniform vec3 uCenter;   // grid cells: the centre of the struck cell
uniform vec3 uDir;      // unit swing direction

void blow(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uCenter;
  if (dot(d, d) >= BLOW_REACH * BLOW_REACH) return;
  float along = dot(d, uDir);
  vec3 across = d - along * uDir;
  float r2 = dot(across, across) / (BLOW_RADIUS * BLOW_RADIUS) + along * along / (BLOW_DEPTH * BLOW_DEPTH);
  if (r2 >= 1.0) return;
  float E = BLOW_ENERGY * (1.0 - r2);
  int id = eid(a);
  int into = BREAKINTO[id];
  if (KIND[id] == K_SOLID && into >= 0 && E >= HARD[id]) {
    oA.x = float(into);
    // what the cut doesn't use flies off with the chip: ½·DENS·v² = E − hard
    float v = min(sqrt(2.0 * (E - HARD[id]) / DENS[into]), BLOW_CHIP_MAX);
    oB.xyz = uDir * v;
  } else if (KIND[id] == K_POWDER) {
    oB.xyz = clamp(b.xyz + uDir * BLOW_SHOVE * (1.0 - r2), -V_MAX, V_MAX);
  }
}
${copyThroughMain('blow')}`;
export const axeFrag = blowFrag(AXE);
export const pickaxeFrag = blowFrag(PICK);
export const knifeFrag = blowFrag(KNIFE);

// A flame: a cone from a nozzle along a direction (P: FLAMER, the
// flamethrower's, or TORCH_FIRE, a thrown torch's). Air in the cone becomes
// engine FIRE at the flame's temperature, blown along it, and matter the flame
// touches is heated toward that temperature; the engine does the rest (wood
// and powder light, gunpowder goes off, ice and metal melt). Heat goes in as
//   T += (FLAME_T − T) · (1 − exp(−HEAT_RATE · dt / CAP)),
// so nothing gets hotter than the flame and a high heat capacity heats slowly.
// HEAT_RATE stands in for the hot spot a 30 cm cell can't resolve (as
// physics.js KE_TO_HEAT does for impacts): wood lights in a third of a second,
// a metal cell starts to melt in about ten.
//
// The flamethrower's is Team Fortress 2's Pyro's reach (≈ 6 m) and fills its
// whole cone with fire every frame, so the stream is one continuous jet; its
// fire is the hotter propane–air flame the blowtorch had.
export const FLAMER = {
  FLAME_T: 1900,     // °C, propane–air adiabatic flame temperature
  LENGTH: 20,        // cells (6 m)
  RADIUS0: 0.5,      // cells, the stream's radius at the nozzle
  SPREAD: 0.12,      // cells of radius gained per cell along it (≈ 2.9 at its end)
  SPAWN: 1,          // chance per frame an air cell in the stream becomes fire
  SPEED: 0.6,        // cells/step the fire leaves along the aim (≈ 43 m/s)
  HEAT_RATE: 0.15,   // 1/s × CAP: share of the gap to FLAME_T closed per second (see above)
  BITE: 1.5,         // cells past the struck face the flame heats into
};
// A burning torch lying where it was thrown (lamp.js): a small flame licking
// up off its head, hot enough to light wood and paper that touch it.
export const TORCH_FIRE = {
  FLAME_T: 900,      // °C, a pitch torch's flame
  LENGTH: 1.5,       // cells
  RADIUS0: 0.4,
  SPREAD: 0.3,
  SPAWN: 0.3,
  SPEED: 0.15,
  HEAT_RATE: 0.15,
  BITE: 1,
};

const flameFrag = (P) => (g) => /* glsl */ `
${head(g)}
${defines('FLM', P)}   // (FLM_: FLAME_ is the renderer's)
uniform vec3 uNozzle;   // grid cells
uniform vec3 uDir;      // unit direction
uniform float uReach;   // cells along it to the struck face (the flame stops there), ≤ FLM_LENGTH
uniform float uDt;      // s this frame
uniform uint uFrame;
#define FLM_RNG_SALT 0x70u   // keeps the flame's random draws apart from other passes'

void flame(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uNozzle;
  float along = dot(d, uDir);
  if (along < 0.0 || along > uReach + FLM_BITE) return;
  float r = length(d - along * uDir);
  float radius = FLM_RADIUS0 + FLM_SPREAD * along;
  if (r > radius) return;
  int id = eid(a);
  uint rs = seed3(p, uFrame, FLM_RNG_SALT);
  if (isGasLike(id)) {
    if (along > uReach || rnd(rs) > FLM_SPAWN) return;
    oA = vec4(float(E_FIRE), FLM_FLAME_T, SPAWNLIFE[E_FIRE], rnd(rs) * SEED_MAX);
    oB.xyz = uDir * FLM_SPEED;
  } else {
    float k = 1.0 - exp(-FLM_HEAT_RATE * uDt / CAP[id]);
    oA.y = a.y + max(FLM_FLAME_T - a.y, 0.0) * k;
  }
}
${copyThroughMain('flame')}`;
export const flamerFrag = flameFrag(FLAMER);
export const torchFireFrag = flameFrag(TORCH_FIRE);

const physGLSL = /* glsl */ `
${defines('PHYS', PHYS)}
${Object.entries(PHYS_MODE).map(([k, v]) => `#define PHYS_MODE_${k} ${v}`).join('\n')}
#define PHYS_SPAN int(ceil(PHYS_RADIUS))
#define FOUR_THIRDS_PI 4.18879
// what the beam can hold: loose matter, never solids or plain air
bool physHeld(int id) { int k = KIND[id]; return k == K_POWDER || k == K_LIQUID || k == K_GAS; }
float physFalloff(float r) { return 1.0 - smoothstep(PHYS_RADIUS * PHYS_CORE, PHYS_RADIUS, r); }
`;

// One texel: the held matter's centre of mass (xyz, grid cells) and its size
// in cells (w), falloff-weighted. Loops over the cube around the hold point.
export const physgunComFrag = (g) => /* glsl */ `
${prelude(g)}
${physGLSL}
uniform vec3 uHold;
out vec4 oC;

void main() {
  ivec3 c = ivec3(floor(uHold));
  vec3 sum = vec3(0.0);
  float mass = 0.0, cells = 0.0;
  for (int z = -PHYS_SPAN; z <= PHYS_SPAN; z++)
  for (int y = -PHYS_SPAN; y <= PHYS_SPAN; y++)
  for (int x = -PHYS_SPAN; x <= PHYS_SPAN; x++) {
    ivec3 q = c + ivec3(x, y, z);
    if (!inGrid(q)) continue;
    vec3 at = vec3(q) + 0.5;
    float r = length(at - uHold);
    if (r >= PHYS_RADIUS) continue;
    int id = eid(fetchA(q));
    if (!physHeld(id)) continue;
    float w = physFalloff(r);
    sum += at * DENS[id] * w;
    mass += DENS[id] * w;
    cells += w;
  }
  oC = vec4(mass > 0.0 ? sum / mass : uHold, cells);
}
`;

// Hold the matter around uHold as a ball (see PHYS), or fling it along uFling.
export const physgunFrag = (g) => /* glsl */ `
${head(g)}
${physGLSL}
uniform sampler2D tCom;   // physgunComFrag's texel
uniform vec3 uHold;       // grid cells
uniform vec3 uCarry;      // cells/step, the hold point's own velocity
uniform float uSteps;     // sim steps per frame
uniform float uGravity;   // cells/step² (sim.gravity)
uniform int uMode;
uniform vec3 uFling;      // cells/step

void physgun(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 at = vec3(p) + 0.5;
  float r = length(at - uHold);
  if (r >= PHYS_RADIUS) return;
  int id = eid(a);
  if (!physHeld(id)) return;
  if (uMode == PHYS_MODE_FLING) { oB.xyz = clamp(uFling, -V_MAX, V_MAX); return; }

  vec4 com = texelFetch(tCom, ivec2(0), 0);
  vec3 vBall = uCarry + (uHold - com.xyz) * PHYS_SPRING;
  float rBall = pow(com.w / (PHYS_PACKING * FOUR_THIRDS_PI), 1.0 / 3.0) + PHYS_CORE_PAD;
  vec3 toCom = com.xyz - at;
  float rc = length(toCom);
  bool inBall = rc < rBall;
  float w = inBall ? 1.0 : physFalloff(r);
  float g = uGravity * GRAV[id];   // the field carries the weight of all it reaches
  vec3 target = vBall;
  if (!inBall) target += toCom / max(rc, 1.0) * min((rc - rBall) * PHYS_PULL, PHYS_PULL_MAX);
  float grip = inBall ? 1.0 : w * (1.0 - pow(1.0 - PHYS_GRIP, uSteps));
  vec3 vMean = b.xyz + vec3(0.0, g * (uSteps + 1.0) * 0.5, 0.0);   // what it moved at last frame
  vec3 v = mix(vMean, target, grip) + vec3(0.0, g * (uSteps - 1.0) * 0.5, 0.0);
  oB.xyz = clamp(v, -V_MAX, V_MAX);
}
${copyThroughMain('physgun')}`;

// Blast the loose matter in the cone (see BLAST).
export const blastFrag = (g) => /* glsl */ `
${head(g)}
${defines('BLAST', BLAST)}
uniform vec3 uMuzzle;   // grid cells
uniform vec3 uDir;      // unit aim
uniform float uReach;   // cells along the aim it pushes, ≤ BLAST_RANGE
uniform vec3 uPulse;    // grid cells: the pressure pulse's centre...
uniform float uPulseP;  // ...and its pressure (0: the cone met no surface)

void blast(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  int id = eid(a);
  int k = KIND[id];
  float rp = length(vec3(p) + 0.5 - uPulse);
  if (k != K_SOLID && rp < BLAST_PULSE_RADIUS)
    oB.w = max(b.w, uPulseP * (1.0 - smoothstep(BLAST_EDGE, 1.0, rp / BLAST_PULSE_RADIUS)));
  vec3 d = vec3(p) + 0.5 - uMuzzle;
  float along = dot(d, uDir);
  if (along < 0.0 || along > uReach) return;
  float radius = BLAST_RADIUS0 + BLAST_SPREAD * along;
  float r = length(d - along * uDir);
  if (r > radius) return;
  if (k != K_POWDER && k != K_LIQUID && k != K_GAS) return;
  float w = (1.0 - smoothstep(BLAST_EDGE, 1.0, along / BLAST_RANGE)) * (1.0 - smoothstep(BLAST_EDGE, 1.0, r / radius));
  vec3 away = d / max(length(d), 1.0);
  oB.xyz = clamp(b.xyz + away * min(BLAST_IMPULSE / DENS[id], V_MAX) * w, -V_MAX, V_MAX);
}
${copyThroughMain('blast')}`;

// Rocket (rocket.tool.js): one blast where it strikes, adding no matter to the
// world. Its reach is Team Fortress 2's rocket's (146 HU ≈ 2.8 m ≈ 9 cells).
// Around the centre, r cells out:
//   - a solid within BREAK_RADIUS takes a blow of E(r) = ENERGY·(1 − (r/R)²)
//     and breaks into its debris where E beats its hardness (as the axe's
//     blow, blowFrag): ROCK (30) out to 0.82 R, METAL (60) out to 0.58 R. The
//     debris flies outward with what the break didn't use (CHIP_MAX at most).
//   - air and gas within FIRE_RADIUS turn to engine FIRE at the gunpowder
//     blast's temperature, blown outward (it burns out, as the blowtorch's).
//   - loose matter within PULSE_RADIUS is shoved outward, IMPULSE / DENS
//     (as the physgun's blast), and every non-solid cell there gets air
//     pressure PULSE_P, a blast the engine spreads (react.js): it throws
//     loose matter and bodies (player.js, which it can hurt) and breaks the
//     solids it beats. Both fade from full strength at EDGE of the radius.
// Each change turns a cell into its own debris, air into fire, or sets a
// velocity or a pressure: nothing is added that could plug what it opened.
export const ROCKET = {
  ENERGY: 90,        // sim KE units at the centre
  BREAK_RADIUS: 4,   // cells
  CHIP_MAX: 0.8,     // cells/step, fastest debris flies out
  FIRE_RADIUS: 2.5,  // cells
  FIRE_SPAWN: 0.6,   // chance an air cell in reach becomes fire
  FIRE_SPEED: 0.6,   // cells/step outward
  PULSE_RADIUS: 9,   // cells (TF2's 146 HU)
  PULSE_P: 140,      // air pressure at full strength: breaks wood (20 × 5 = 100), not rock (150)
  IMPULSE: 20,       // DENS · cells/step given to loose matter at full strength
  EDGE: 0.4,         // share of a radius held at full strength before fading
};
ROCKET.FIRE_T = ELEMENTS[E.GUNPOWDER].blast.T;   // °C, the gunpowder blast's (elements.js)

export const rocketFrag = (g) => /* glsl */ `
${head(g)}
${defines('ROCKET', ROCKET)}
#define ROCKET_RNG_SALT 0x72u   // keeps the rocket's random draws apart from other passes'
uniform vec3 uCenter;   // grid cells
uniform uint uFrame;

float rocketFade(float x) { return 1.0 - smoothstep(ROCKET_EDGE, 1.0, x); }

void rocket(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uCenter;
  float r = length(d);
  if (r >= ROCKET_PULSE_RADIUS) return;
  uint rs = seed3(p, uFrame, ROCKET_RNG_SALT);
  vec3 away = r > 0.5 ? d / r : normalize(vec3(rnd(rs) - 0.5, rnd(rs), rnd(rs) - 0.5) + vec3(0.0, 0.1, 0.0));
  int id = eid(a);
  if (KIND[id] == K_SOLID) {
    float x = r / ROCKET_BREAK_RADIUS;
    float E = ROCKET_ENERGY * (1.0 - x * x);
    int into = BREAKINTO[id];
    if (x >= 1.0 || into < 0 || E < HARD[id]) return;
    oA.x = float(into);
    oB.xyz = away * min(sqrt(2.0 * (E - HARD[id]) / DENS[into]), ROCKET_CHIP_MAX);
    id = into;
  } else if (isGasLike(id) && r < ROCKET_FIRE_RADIUS && rnd(rs) < ROCKET_FIRE_SPAWN) {
    oA = vec4(float(E_FIRE), ROCKET_FIRE_T, SPAWNLIFE[E_FIRE], rnd(rs) * SEED_MAX);
    oB.xyz = away * ROCKET_FIRE_SPEED;
    id = E_FIRE;
  } else if (!isGasLike(id)) {
    float w = rocketFade(r / ROCKET_PULSE_RADIUS);
    oB.xyz = clamp(b.xyz + away * min(ROCKET_IMPULSE / DENS[id], V_MAX) * w, -V_MAX, V_MAX);
  }
  oB.w = max(oB.w, ROCKET_PULSE_P * rocketFade(r / ROCKET_PULSE_RADIUS));
}
${copyThroughMain('rocket')}`;

// A pass material for the current simulation. Grids can be rebuilt (a size
// change makes a new sim), so callers keep one per sim: see toolPass.
function passMaterial(frag, g, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: frag(g),
    uniforms: { ...stateUniforms(), ...uniforms },
    depthTest: false,
    depthWrite: false,
  });
}

// toolPass(frag, uniforms) → (sim) => material, rebuilt when the sim is.
export function toolPass(frag, makeUniforms) {
  let simId = -1, mat = null;
  const get = (sim) => {
    if (sim.id !== simId) {
      mat?.dispose();
      mat = passMaterial(frag, sim.g, makeUniforms());
      simId = sim.id;
    }
    return mat;
  };
  get.dispose = () => { mat?.dispose(); mat = null; simId = -1; };
  return get;
}

// ---- viewmodel helpers (the held tools are drawn in cells, scaled to world) ----

// Shade of each box face for flat-lit stylised meshes (no scene lights):
// +x, −x, +y (top), −y, +z, −z.
const FACE_SHADE = [0.82, 0.62, 1.0, 0.45, 0.9, 0.7];

// A box with baked per-face shading.
export function shadedBox(w, h, d, color) {
  const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const base = new THREE.Color(color);
  const cols = [];
  const perFace = geo.attributes.position.count / FACE_SHADE.length;
  FACE_SHADE.forEach((s) => {
    for (let i = 0; i < perFace; i++) cols.push(base.r * s, base.g * s, base.b * s);
  });
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
}

// Soft round glow (muzzle flash, beam tip), white at the centre.
const GLOW_TEX_SIZE = 64;   // px
export function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = GLOW_TEX_SIZE;
  const x = c.getContext('2d');
  const r = GLOW_TEX_SIZE / 2;
  const grad = x.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grad;
  x.fillRect(0, 0, GLOW_TEX_SIZE, GLOW_TEX_SIZE);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Free a viewmodel subtree's geometry, materials and textures.
export function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    ms.forEach((m) => { m.map?.dispose(); m.dispose(); });
  });
  root.removeFromParent();
}
