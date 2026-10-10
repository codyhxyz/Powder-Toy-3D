import * as THREE from 'three';
import { prelude, quadVert, stateOutGLSL, copyThroughMain, stateUniforms } from './common.js';
import { BODY_WIDTH } from '../pov/constants.js';

// GPU passes for the POV axe, gun, physgun and blowtorch (src/pov/tools/*.tool.js).
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

// Gun: one SCRAP slug per shot, launched at V_MAX along the aim (see
// gun.tool.js). The pass only writes it if its cell holds air or a gas.

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
// (water 0.8 cells/step, sand 0.5, metal dust 0.1, gases capped at V_MAX),
// pointing away from the muzzle. falloff fades toward the cone's end and its
// rim. The cone stops BITE cells past the aimed face, so walls shield what's
// behind them. Solids don't move: there are no rigid bodies.
export const BLAST = {
  IMPULSE: 8,        // DENS · cells/step given to each cell at full strength
  RANGE: 16,         // cells from the muzzle
  RADIUS0: 1,        // cells, the cone's radius at the muzzle
  SPREAD: 0.35,      // cells of radius gained per cell along it
  BITE: 1.5,         // cells past the aimed face it still pushes
  EDGE: 0.6,         // share of the radius / range held at full strength before fading
  COOLDOWN: 0.4,     // s between blasts
};

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = (prefix, obj) =>
  Object.entries(obj).map(([k, v]) => `#define ${prefix}_${k} ${v < 0 ? `(${f(v)})` : f(v)}`).join('\n');

const head = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
`;

// Break breakable solids in the axe's patch into their debris, 1:1 (same
// cell, temperature, life and ctype: only the element changes), and nudge
// loose powder along the swing.
export const axeFrag = (g) => /* glsl */ `
${head(g)}
${defines('AXE', AXE)}
#define AXE_REACH max(AXE_RADIUS, AXE_DEPTH)
uniform vec3 uCenter;   // grid cells: the centre of the struck cell
uniform vec3 uDir;      // unit swing direction

void axe(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uCenter;
  if (dot(d, d) >= AXE_REACH * AXE_REACH) return;
  float along = dot(d, uDir);
  vec3 across = d - along * uDir;
  float r2 = dot(across, across) / (AXE_RADIUS * AXE_RADIUS) + along * along / (AXE_DEPTH * AXE_DEPTH);
  if (r2 >= 1.0) return;
  float E = AXE_ENERGY * (1.0 - r2);
  int id = eid(a);
  int into = BREAKINTO[id];
  if (KIND[id] == K_SOLID && into >= 0 && E >= HARD[id]) {
    oA.x = float(into);
    // what the cut doesn't use flies off with the chip: ½·DENS·v² = E − hard
    float v = min(sqrt(2.0 * (E - HARD[id]) / DENS[into]), AXE_CHIP_MAX);
    oB.xyz = uDir * v;
  } else if (KIND[id] == K_POWDER) {
    oB.xyz = clamp(b.xyz + uDir * AXE_SHOVE * (1.0 - r2), -V_MAX, V_MAX);
  }
}
${copyThroughMain('axe')}`;

// Blowtorch: a roofing torch's flame (propane in air), a cone from the nozzle
// along the aim. Air in the cone becomes engine FIRE at the flame's
// temperature, blown along the aim, and matter the flame touches is heated
// toward that temperature; the engine does the rest (wood and powder light,
// gunpowder goes off, ice and metal melt). Heat goes in as
//   T += (FLAME_T − T) · (1 − exp(−HEAT_RATE · dt / CAP)),
// so nothing gets hotter than the flame and a high heat capacity heats slowly.
// HEAT_RATE stands in for the hot spot at the flame's tip, which a 30 cm cell
// can't resolve (as physics.js KE_TO_HEAT does for impacts): wood lights in a
// third of a second, a metal cell starts to melt in about ten.
export const TORCH = {
  FLAME_T: 1900,     // °C, propane–air adiabatic flame temperature
  LENGTH: 4,         // cells (1.2 m), a roofing torch's flame
  RADIUS0: 0.6,      // cells, the flame's radius at the nozzle
  SPREAD: 0.2,       // cells of radius gained per cell along it
  SPAWN: 0.5,        // chance per frame an air cell in the flame becomes fire
  SPEED: 0.5,        // cells/step the flame's gas leaves along the aim (≈ 36 m/s)
  HEAT_RATE: 0.15,   // 1/s × CAP: share of the gap to FLAME_T closed per second (see above)
  BITE: 1,           // cells past the struck face the flame heats into
};

export const torchFrag = (g) => /* glsl */ `
${head(g)}
${defines('TORCH', TORCH)}
uniform vec3 uNozzle;   // grid cells
uniform vec3 uDir;      // unit aim
uniform float uReach;   // cells along the aim to the struck face (the flame stops there), ≤ TORCH_LENGTH
uniform float uDt;      // s this frame
uniform uint uFrame;
#define TORCH_RNG_SALT 0x70u   // keeps the torch's random draws apart from other passes'

void torch(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uNozzle;
  float along = dot(d, uDir);
  if (along < 0.0 || along > uReach + TORCH_BITE) return;
  float r = length(d - along * uDir);
  float radius = TORCH_RADIUS0 + TORCH_SPREAD * along;
  if (r > radius) return;
  int id = eid(a);
  uint rs = seed3(p, uFrame, TORCH_RNG_SALT);
  if (isGasLike(id)) {
    if (along > uReach || rnd(rs) > TORCH_SPAWN) return;
    oA = vec4(float(E_FIRE), TORCH_FLAME_T, SPAWNLIFE[E_FIRE], rnd(rs) * SEED_MAX);
    oB.xyz = uDir * TORCH_SPEED;
  } else {
    float k = 1.0 - exp(-TORCH_HEAT_RATE * uDt / CAP[id]);
    oA.y = a.y + max(TORCH_FLAME_T - a.y, 0.0) * k;
  }
}
${copyThroughMain('torch')}`;

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

void blast(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uMuzzle;
  float along = dot(d, uDir);
  if (along < 0.0 || along > uReach) return;
  float radius = BLAST_RADIUS0 + BLAST_SPREAD * along;
  float r = length(d - along * uDir);
  if (r > radius) return;
  int id = eid(a);
  int k = KIND[id];
  if (k != K_POWDER && k != K_LIQUID && k != K_GAS) return;
  float w = (1.0 - smoothstep(BLAST_EDGE, 1.0, along / BLAST_RANGE)) * (1.0 - smoothstep(BLAST_EDGE, 1.0, r / radius));
  vec3 away = d / max(length(d), 1.0);
  oB.xyz = clamp(b.xyz + away * min(BLAST_IMPULSE / DENS[id], V_MAX) * w, -V_MAX, V_MAX);
}
${copyThroughMain('blast')}`;

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
