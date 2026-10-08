import * as THREE from 'three';
import { prelude, quadVert } from './common.js';
import { BODY_WIDTH } from '../pov/constants.js';

// GPU passes for the POV axe, gun and physgun (src/pov/tools/*.tool.js).
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

// Physgun: a damped spring on loose matter around a hold point.
//   v ← mix(v, v_spring, grip) + g·GRAV·steps
// v_spring = (hold − cell)·SPRING (capped at PULL_MAX) is the velocity that
// closes the gap; grip = 1 − (1 − GRIP)^steps relaxes the current velocity
// toward it at GRIP per sim step, which is the damping. The gravity term pays
// back what the react pass takes away over the frame's steps, so a held ball
// neither sinks nor (for gases) rises. Everything fades with distance:
// full strength inside CORE·RADIUS, nothing at RADIUS.
export const PHYS = {
  RADIUS: 3.5,       // cells, reach of the beam around the hold point
  CORE: 0.5,         // share of RADIUS held at full strength
  SPRING: 0.15,      // 1/step: velocity toward the hold point per cell of distance
  PULL_MAX: 0.6,     // cells/step, fastest the spring drags matter in
  GRIP: 0.35,        // per step: share of the gap to the spring velocity closed (damping)
  FLING: 0.9,        // cells/step: speed a right-click throws the held matter at
  HOLD_MIN: 3.5 + BODY_WIDTH,   // cells from the eye: the ball stays clear of the body
  HOLD_MAX: 32,      // cells from the eye
  WHEEL_STEP: 1,     // cells of hold distance per wheel notch
};
export const PHYS_MODE = { HOLD: 0, FLING: 1 };

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = (prefix, obj) =>
  Object.entries(obj).map(([k, v]) => `#define ${prefix}_${k} ${v < 0 ? `(${f(v)})` : f(v)}`).join('\n');

const head = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
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

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, t, 0);
  vec4 b = texelFetch(tB, t, 0);
  oA = a; oB = b;
  ivec3 p = cellFromFrag(t);
  if (p.y >= NY) return;
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
`;

// Put a SCRAP slug in one cell, if that cell holds air or a gas.
export const gunFrag = (g) => /* glsl */ `
${head(g)}
uniform ivec3 uCell;    // the muzzle cell
uniform vec3 uVel;      // cells/step

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, t, 0);
  vec4 b = texelFetch(tB, t, 0);
  oA = a; oB = b;
  if (cellFromFrag(t) != uCell) return;
  int id = eid(a);
  if (id != E_EMPTY && KIND[id] != K_GAS) return;
  oA = vec4(float(E_SCRAP), AMBIENT, SPAWNLIFE[E_SCRAP], fract(a.w));
  oB = vec4(uVel, b.w);
}
`;

// Hold loose matter (powders, liquids, gases; never solids or air) around
// uHold, or fling it along uFling.
export const physgunFrag = (g) => /* glsl */ `
${head(g)}
${defines('PHYS', PHYS)}
${Object.entries(PHYS_MODE).map(([k, v]) => `#define PHYS_MODE_${k} ${v}`).join('\n')}
uniform vec3 uHold;     // grid cells
uniform float uSteps;   // sim steps per frame
uniform float uGravity; // cells/step² (sim.gravity)
uniform int uMode;
uniform vec3 uFling;    // cells/step

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, t, 0);
  vec4 b = texelFetch(tB, t, 0);
  oA = a; oB = b;
  ivec3 p = cellFromFrag(t);
  if (p.y >= NY) return;
  vec3 d = uHold - (vec3(p) + 0.5);
  float r = length(d);
  if (r >= PHYS_RADIUS) return;
  int id = eid(a);
  int k = KIND[id];
  if (k != K_POWDER && k != K_LIQUID && k != K_GAS) return;
  if (uMode == PHYS_MODE_FLING) { oB.xyz = clamp(uFling, -V_MAX, V_MAX); return; }
  float w = 1.0 - smoothstep(PHYS_RADIUS * PHYS_CORE, PHYS_RADIUS, r);
  vec3 vs = d * PHYS_SPRING;
  float s = length(vs);
  if (s > PHYS_PULL_MAX) vs *= PHYS_PULL_MAX / s;
  float grip = w * (1.0 - pow(1.0 - PHYS_GRIP, uSteps));
  vec3 v = mix(b.xyz, vs, grip);
  v.y += uGravity * GRAV[id] * uSteps * w;
  oB.xyz = clamp(v, -V_MAX, V_MAX);
}
`;

// A pass material for the current simulation. Grids can be rebuilt (a size
// change makes a new sim), so callers keep one per sim: see toolPass.
function passMaterial(frag, g, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: frag(g),
    uniforms: { tA: { value: null }, tB: { value: null }, ...uniforms },
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
