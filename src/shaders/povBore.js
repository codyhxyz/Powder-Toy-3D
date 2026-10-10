import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { STRIKE } from './povTrace.js';

// GPU passes for the two boring weapons: the burrower's drill and the laser
// cannon (src/pov/tools/burrower.tool.js, laser.tool.js). Both add nothing to
// the world: every cell they touch turns into its own debris, its own vapour,
// or the same matter hotter.
//
// Units: grid cells, cells/step, the sim's kinetic energy units (HARD) for the
// drill, and the engine's heat (CAP · °C per cell, a water cell's CAP = 1) for
// the laser.

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
// #defines for a constants block; the keys in `ints` stay integers (loop bounds, array sizes)
const defines = (prefix, obj, ints = []) =>
  Object.entries(obj).map(([k, v]) => `#define ${prefix}_${k} ${ints.includes(k) ? String(v) : v < 0 ? `(${f(v)})` : f(v)}`).join('\n');

// ---------------------------------------------------------------- burrower
// A drill is power-limited, so it advances at its power over the work a cell
// of advance takes (Teale 1965, "The concept of specific energy in rock
// drilling": rate of penetration = P / (SE · A), the specific energy SE times
// the face's area A). The engine's hardness already is that specific energy
// (elements.js: hard ≈ UCS / 5 MPa, after Teale), and a powder or liquid
// costs what it costs a round (povTrace.js strikeFrag: DENS · STRIKE.DRAG), so
// the work of one cell of advance is the sum over the bore's face disc:
//   W = Σ HARD (breakable solids) + Σ DENS · DRAG (powder, liquid)
//   v = min(FLIGHT, POWER / W)
// With POWER 9000 and a 3.5-cell bore (≈ 38 cells a slice):
//   sand 16 → 15 cells/s, sandstone 15 → 16, wood 20 → 12, rock 30 → 8,
//   metal 60 → 4 (1.2 m/s): metal is twice as slow as rock, as its hardness says.
// A solid that can't break (WALL, CLONE) on the bore's axis stops it.
export const BURROW = {
  RADIUS: 3.5,        // cells: the bore (a 2.1 m tunnel: the 1.7 m body walks through it)
  POWER: 9000,        // sim KE units a second the drill can spend cutting
  PROBE_AHEAD: 12,    // one-cell slices of the face read back ahead of the drill
  AXIS_CORE: 1,       // cells from the axis where an unbreakable solid stops the drill
  SPOIL_SPEED: 1,     // cells/step the cuttings are thrown back along the bore (V_MAX)
  SPOIL_LIFT: 0.5,    // cells/step up the conveyor throws them at the mouth, so they land well clear of it
  APRON: 7,           // cells past the mouth the conveyor still reaches (two bore radii)
  CONVEY_PAD: 1,      // cells past the bore's radius the conveyor still reaches (grains settled on the tunnel floor)
  PATH_MAX: 64,       // points of the bore's centre line the spoil conveyor follows (PATH_STEP apart)
};
const BURROW_SPAN = Math.ceil(BURROW.RADIUS) + 1;   // cells around a slice's centre its disc can reach

const burrowDefines = `${defines('BURROW', BURROW, ['PATH_MAX', 'PROBE_AHEAD'])}
#define BURROW_SPAN ${BURROW_SPAN}
#define STRIKE_DRAG ${f(STRIKE.DRAG)}`;

// One texel per slice k (BURROW.PROBE_AHEAD wide, one row): the face disc a
// cell deep, k + ½ cells ahead of uHead along uDir.
//   (work W of the slice, unbreakable solids near the axis, the id of the
//    matter nearest the axis or −1, breakable solids in it)
// Below the floor counts as unbreakable (the engine's WALL); out through the
// sides or top is open.
export const burrowProbeFrag = (g) => /* glsl */ `
${prelude(g)}
${burrowDefines}
uniform vec3 uHead;   // grid cells: the drill's nose
uniform vec3 uDir;    // unit heading
out vec4 oC;

void main() {
  int k = int(gl_FragCoord.x);
  vec3 c = uHead + uDir * (float(k) + 0.5);
  ivec3 ci = ivec3(floor(c));
  float work = 0.0, blocked = 0.0, solids = 0.0, axisId = -1.0, nearest = 1e9;
  for (int z = -BURROW_SPAN; z <= BURROW_SPAN; z++)
  for (int y = -BURROW_SPAN; y <= BURROW_SPAN; y++)
  for (int x = -BURROW_SPAN; x <= BURROW_SPAN; x++) {
    ivec3 q = ci + ivec3(x, y, z);
    vec3 d = vec3(q) + 0.5 - c;
    float along = dot(d, uDir);
    if (abs(along) > 0.5) continue;
    float r = length(d - along * uDir);
    if (r > BURROW_RADIUS) continue;
    if (!inGrid(q)) { if (q.y < 0 && r < BURROW_AXIS_CORE) blocked += 1.0; continue; }
    int id = eid(fetchA(q));
    int kind = KIND[id];
    if (kind == K_SOLID) {
      if (BREAKINTO[id] < 0) { if (r < BURROW_AXIS_CORE) blocked += 1.0; continue; }
      work += HARD[id];
      solids += 1.0;
    } else if (kind == K_POWDER || kind == K_LIQUID) {
      work += DENS[id] * STRIKE_DRAG;
    } else continue;
    if (r < nearest) { nearest = r; axisId = float(id); }
  }
  oC = vec4(work, blocked, axisId, solids);
}
`;

// The drill this frame. Inside the capsule round the nose's stretch
// uFrom → uTo (radius RADIUS), while uCut is 1:
//   breakable solid: becomes its debris in place (only the element changes:
//     strikeFrag's rule), thrown back along the bore at SPOIL_SPEED
//   powder or liquid: thrown back the same way
//   anything else: left as it is
// Along the bore behind it (the centre line uPath, mouth first), loose
// cuttings (powders) are carried back toward the mouth at SPOIL_SPEED: a
// tunnel-boring machine's muck conveyor, which runs the tunnel's length. In
// its first stretch and APRON cells past the mouth it throws them up and out
// (SPOIL_LIFT), a stacker's arc, so they heap up well clear of the mouth
// instead of damming it (a heap at the angle of repose right at the mouth
// fills it: tested). The tunnel stays open to walk through; nothing is added
// or taken away.
export const burrowFrag = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
${burrowDefines}
uniform vec3 uFrom;                  // grid cells: the nose's stretch this frame
uniform vec3 uTo;
uniform vec3 uDir;                   // unit heading
uniform int uCut;                    // 1: the nose cuts this frame
uniform vec4 uPath[BURROW_PATH_MAX]; // the bore's centre line, mouth first (w 1: a point)
uniform int uPathN;                  // points in uPath
uniform vec3 uLo;                    // the box of everything this pass may change
uniform vec3 uHi;

// distance from p to the segment a → b
float segDist(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float l2 = dot(ab, ab);
  float t = l2 > 0.0 ? clamp(dot(p - a, ab) / l2, 0.0, 1.0) : 0.0;
  return length(p - a - ab * t);
}

void burrow(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 pc = vec3(p);
  if (any(lessThan(pc, uLo)) || any(greaterThan(pc, uHi))) return;
  pc += 0.5;
  int id = eid(a);
  if (isGasLike(id)) return;
  int kind = KIND[id];
  if (uCut == 1 && segDist(pc, uFrom, uTo) <= BURROW_RADIUS) {
    if (kind == K_SOLID) {
      int into = BREAKINTO[id];
      if (into < 0) return;
      oA.x = float(into);
    }
    oB.xyz = -uDir * BURROW_SPOIL_SPEED;
    return;
  }
  if (kind != K_POWDER) return;
  float best = BURROW_RADIUS + BURROW_CONVEY_PAD;
  vec3 back = vec3(0.0);
  bool mouth = false;
  for (int i = 0; i + 1 < BURROW_PATH_MAX; i++) {
    if (i + 1 >= uPathN) break;
    vec3 a0 = uPath[i].xyz, a1 = uPath[i + 1].xyz;
    if (dot(a0 - a1, a0 - a1) <= 0.0) continue;
    vec3 dir = normalize(a0 - a1);
    if (i == 0) a0 += dir * BURROW_APRON;   // the first stretch reaches out past the mouth
    float d = segDist(pc, a0, a1);
    if (d < best) { best = d; back = dir; mouth = i == 0; }
  }
  if (best < BURROW_RADIUS + BURROW_CONVEY_PAD) oB.xyz = back * BURROW_SPOIL_SPEED + vec3(0.0, mouth ? BURROW_SPOIL_LIFT : 0.0, 0.0);
}
${copyThroughMain('burrow')}`;

// ---------------------------------------------------------------- laser
// The laser cannon: one instant beam along the aim, as Halo's Spartan Laser.
// A laser delivers its energy as heat, so its reach follows the lumped heat
// balance of laser drilling (Steen & Mazumder, "Laser Material Processing",
// the energy balance of cutting and drilling: the energy to remove a volume
// is ρ(c·ΔT + L)): the beam walks its axis from the muzzle, and every cell it
// enters costs the heat that takes the core's slice of that matter to VAPOR_T,
//   cost = CAP · (VAPOR_T − T) · π · CORE_RADIUS²
// in the engine's own heat units (latent heats left out). Air and gas cost
// nothing. ENERGY 1.25 M gives (from 20 °C):
//   rock / glass (CAP 0.5)  ≈ 119 cells (36 m)    metal (0.85) ≈ 70 cells (21 m)
//   wood (0.3) ≈ 198          water (1.0) ≈ 59
// A solid that neither breaks, melts nor burns (WALL, CLONE) stops it, as does
// the floor; the beam is at most LENGTH long.
//
// What it does where it reaches, by distance r from the axis:
//   core (r ≤ CORE_RADIUS): vaporised. Water, ice and snow become STEAM, what
//     burns becomes FIRE, everything else SMOKE (its vapour), all at VAPOR_T,
//     blown back out of the hole at PLUME_SPEED. Gas in the core is heated to VAPOR_T.
//   rim (r ≤ RIM_RADIUS): heated to RIM_T at the core's edge, falling to
//     RIM_EDGE_T at the rim's, and the engine does the rest by its own rules:
//     metal (1500 °C), glass and stone melt into lava, water boils, wood and
//     coal catch fire, ice melts. A solid that can't melt but whose debris can
//     (rock, limestone → stone) spalls into its debris first: thermal
//     spallation, how flame-jet drills break hard rock (Rauenzahn & Tester
//     1989, "Rock failure mechanisms of flame-jet thermal spallation drilling").
//     The stone then melts at 1200 °C: rock round the tunnel turns to lava.
//     The rim's heat isn't charged to ENERGY. It is hot and thick because the
//     engine's conduction is fast: a rim of 2400→1300 °C, 3 cells out, cooled
//     below stone's melt in under a second (tested: 21 lava cells, now ~300).
// Every power number is here, so the gun can be made weaker in one place.
export const LASER = {
  ENERGY: 1.25e6,     // heat units (CAP · °C) the beam delivers: see the reaches above
  CORE_RADIUS: 1.5,   // cells vaporised round the axis (a 0.9 m bore)
  RIM_RADIUS: 4,      // cells heated round the axis (the tunnel's wall)
  LENGTH: 192,        // cells, the longest beam (58 m)
  VAPOR_T: 3000,      // °C the core's vapour is made at (iron boils at 2862, basalt about 2900)
  RIM_T: 4500,        // °C at the core's edge
  RIM_EDGE_T: 1600,   // °C at the rim's edge (over stone's 1200 °C and metal's 1500 °C melt)
  PLUME_SPEED: 0.3,   // cells/step the vapour leaves back along the beam (the ablation plume)
  DAMAGE: 2,          // health taken from a body in the beam (a full health and a full shield)
};
LASER.CORE_AREA = Math.PI * LASER.CORE_RADIUS ** 2;   // cells in the core's slice
LASER.STEPS_MAX = Math.ceil(LASER.LENGTH * Math.sqrt(3)) + 2;   // DDA steps a LENGTH walk can take

const laserGLSL = /* glsl */ `
${defines('LASER', LASER, ['STEPS_MAX'])}
uniform vec3 uFrom;   // grid cells: where the beam leaves the body
uniform vec3 uDir;    // unit aim

// matter the beam can't touch: it neither breaks, melts nor burns
bool laserProof(int id) { return KIND[id] == K_SOLID && BREAKINTO[id] < 0 && MELT[id] <= 0.0 && IGNITE[id] <= 0.0; }

// How far along the axis the beam gets (cells from uFrom), and what stopped it
// (stopId: −1 if it ran out of energy or length). Every fragment walks it the
// same way, so they agree.
float laserReach(out int stopId) {
  stopId = -1;
  vec3 rd = vec3(abs(uDir.x) < 1e-6 ? 1e-6 : uDir.x, abs(uDir.y) < 1e-6 ? 1e-6 : uDir.y, abs(uDir.z) < 1e-6 ? 1e-6 : uDir.z);
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 c = ivec3(floor(uFrom));
  vec3 tMax = (vec3(c) + step(0.0, rd) - uFrom) / rd;
  float E = LASER_ENERGY, tEnter = 0.0;
  bool entered = false;
  for (int k = 0; k < LASER_STEPS_MAX; k++) {
    if (tEnter >= LASER_LENGTH) return LASER_LENGTH;
    if (!inGrid(c)) {
      if (c.y < 0) { stopId = E_WALL; return tEnter; }   // the floor
      if (entered) return LASER_LENGTH;   // out of the box (a ray never comes back into it): nothing more to touch
    } else {
      entered = true;
      vec4 a = fetchA(c);
      int id = eid(a);
      if (!isGasLike(id)) {
        if (laserProof(id)) { stopId = id; return tEnter; }
        float cost = CAP[id] * max(LASER_VAPOR_T - a.y, 0.0) * LASER_CORE_AREA;
        if (E < cost) { stopId = id; return tEnter + E / cost; }
        E -= cost;
      }
    }
    int ax = tMax.x <= tMax.y && tMax.x <= tMax.z ? 0 : (tMax.y <= tMax.z ? 1 : 2);
    tEnter = tMax[ax];
    c[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return min(tEnter, LASER_LENGTH);
}
`;

// One texel: (reach, what stopped it or −1, 0, 1), for the CPU (the beam's
// drawn length and the bodies in it).
export const laserReachFrag = (g) => /* glsl */ `
${prelude(g)}
${laserGLSL}
out vec4 oC;
void main() {
  int stopId;
  float reach = laserReach(stopId);
  oC = vec4(reach, float(stopId), 0.0, 1.0);
}
`;

// The beam (see LASER).
export const laserFrag = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
${laserGLSL}
uniform vec3 uLo;   // the box round the beam's whole length
uniform vec3 uHi;

void laser(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 pc = vec3(p);
  if (any(lessThan(pc, uLo)) || any(greaterThan(pc, uHi))) return;
  vec3 d = pc + 0.5 - uFrom;
  float along = dot(d, uDir);
  if (along < 0.0 || along > LASER_LENGTH) return;
  float r = length(d - along * uDir);
  if (r > LASER_RIM_RADIUS) return;
  int stopId;
  if (along > laserReach(stopId)) return;
  int id = eid(a);
  if (r <= LASER_CORE_RADIUS) {
    if (isGasLike(id)) { oA.y = max(a.y, LASER_VAPOR_T); return; }
    if (laserProof(id)) return;
    int into = (id == E_WATER || id == E_ICE || id == E_SNOW) ? E_STEAM : IGNITE[id] > 0.0 ? E_FIRE : E_SMOKE;
    oA = vec4(float(into), LASER_VAPOR_T, SPAWNLIFE[into], fract(a.w));   // keeps the cell's seed, clears its ctype
    oB.xyz = -uDir * LASER_PLUME_SPEED;
    return;
  }
  float T = mix(LASER_RIM_T, LASER_RIM_EDGE_T, (r - LASER_CORE_RADIUS) / (LASER_RIM_RADIUS - LASER_CORE_RADIUS));
  int into = BREAKINTO[id];
  if (KIND[id] == K_SOLID && MELT[id] <= 0.0 && IGNITE[id] <= 0.0 && into >= 0 && MELT[into] > 0.0) {
    oA.x = float(into);
    oB.xyz = vec3(0.0);
  }
  oA.y = max(a.y, T);
}
${copyThroughMain('laser')}`;
