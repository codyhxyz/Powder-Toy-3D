import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../pov/constants.js';

export const WAND_COMMANDS = 64;
export const WAND_RAYS = 128;
export const WAND_EFFECTS = Object.freeze(Object.fromEntries([
  'dig', 'emit', 'heat', 'cool', 'pressure', 'erase', 'ignite', 'attract', 'repel', 'place',
].map((name, i) => [name, i])));

// One ordered command batch per state pass. Outside the union box, copy state
// and activity flags unchanged; no full-grid pass per projectile.
// ponytail: one full-grid copy plus <=64 tests inside the union; spatial bins
// are the upgrade if widely scattered commands make that union expensive.
export const wandApplyFrag = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
uniform sampler2D tCommands;
uniform int uCount;
uniform vec3 uLo, uHi;
void wand(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 pc = vec3(p) + 0.5;
  if (any(lessThan(pc, uLo)) || any(greaterThan(pc, uHi))) return;
  for (int i = 0; i < ${WAND_COMMANDS}; i++) {
    if (i >= uCount) break;
    vec4 cr = texelFetch(tCommands, ivec2(i, 0), 0);
    vec3 delta = pc - cr.xyz;
    float d2 = dot(delta, delta);
    if (d2 > cr.w * cr.w) continue;
    vec4 ep = texelFetch(tCommands, ivec2(i, 1), 0); // effect, power, material, temperature
    vec4 vf = texelFetch(tCommands, ivec2(i, 2), 0); // velocity/step, force/step
    vec3 dir = texelFetch(tCommands, ivec2(i, 3), 0).xyz;
    int effect = int(ep.x), id = eid(oA);
    vec3 radial = d2 > 1e-8 ? delta * inversesqrt(d2) : dir;
    if (effect == ${WAND_EFFECTS.dig}) {
      if (KIND[id] == K_SOLID && BREAKINTO[id] >= 0 && ep.y >= HARD[id]) {
        int debris = BREAKINTO[id];
        oA = vec4(float(debris), oA.y, SPAWNLIFE[debris], fract(oA.w));
        oB.xyz += vf.xyz;
      }
    } else if (effect == ${WAND_EFFECTS.emit} || effect == ${WAND_EFFECTS.place}) {
      if (isGasLike(id)) {
        int mat = int(ep.z);
        oA = vec4(float(mat), ep.w, SPAWNLIFE[mat], fract(oA.w));
        oB.xyz = vf.xyz;
      }
    } else if (effect == ${WAND_EFFECTS.heat}) oA.y += ep.y;
    else if (effect == ${WAND_EFFECTS.cool}) oA.y -= ep.y;
    else if (effect == ${WAND_EFFECTS.pressure}) oB.w += ep.y;
    else if (effect == ${WAND_EFFECTS.erase}) {
      if (id != E_WALL && id != E_CLONE) {
        oA = vec4(float(E_EMPTY), AMBIENT, 0.0, fract(oA.w));
        oB.xyz = vec3(0.0);
      }
    } else if (effect == ${WAND_EFFECTS.ignite}) {
      if (IGNITE[id] > 0.0) oA.y = max(oA.y, IGNITE[id] + max(ep.y, 1.0));
    } else if (movable(id)) {
      oB.xyz += radial * vf.w * (effect == ${WAND_EFFECTS.attract} ? -1.0 : 1.0);
    }
    oA.y = clamp(oA.y, CELL_TEMP_MIN, CELL_TEMP_MAX);
    oB.xyz = clamp(oB.xyz, vec3(-V_MAX), vec3(V_MAX));
    oB.w = clamp(oB.w, P_MIN, P_MAX);
  }
}
${copyThroughMain('wand')}`;

// State-only DDA: querying just-written matter does not depend on a possibly
// stale render brick map. Three small output rows; never read back the grid.
export const wandTraceFrag = (g) => /* glsl */ `
${prelude(g)}
const ivec3 GRID = ivec3(NX, NY, NZ);
uniform sampler2D tSegments; // from/active and to
out vec4 oC;
void main() {
  int i = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
  oC = vec4(0.0, 0.0, 0.0, -1.0);
  vec4 start = texelFetch(tSegments, ivec2(i, 0), 0);
  if (start.w < 0.5) return;
  vec3 ro = start.xyz, dv = texelFetch(tSegments, ivec2(i, 1), 0).xyz - ro;
  if (dot(dv, dv) < 1e-12) return;
  float enter = 0.0, leave = 1.0;
  vec3 ad = abs(dv);
  int axis = ad.x >= ad.y && ad.x >= ad.z ? 0 : (ad.y >= ad.z ? 1 : 2);
  // Clip in segment fractions, preserving exact zero direction components.
  for (int a = 0; a < 3; a++) {
    if (abs(dv[a]) < 1e-10) {
      if (ro[a] < 0.0 || ro[a] >= float(GRID[a])) return;
    } else {
      float t1 = -ro[a] / dv[a], t2 = (float(GRID[a]) - ro[a]) / dv[a];
      float lo = min(t1, t2);
      if (lo > enter) { enter = lo; axis = a; }
      leave = min(leave, max(t1, t2));
    }
  }
  if (enter > leave) return;
  bool crosses = enter < leave;
  ivec3 stepDir = ivec3(sign(dv));
  vec3 first = ro + dv * enter;
  ivec3 cell = ivec3(floor(first));
  // At an exact face, a negative ray starts in the cell on its left, not
  // the solid it is departing. Box entries still clamp roundoff to the grid.
  for (int a = 0; a < 3; a++) if (dv[a] < 0.0 && first[a] == float(cell[a])) cell[a]--;
  cell = clamp(cell, ivec3(0), GRID - 1);
  vec3 next = vec3(1e20), stride = vec3(1e20);
  for (int a = 0; a < 3; a++) if (stepDir[a] != 0) {
    next[a] = (float(cell[a]) + (dv[a] > 0.0 ? 1.0 : 0.0) - ro[a]) / dv[a];
    stride[a] = abs(1.0 / dv[a]);
  }
  for (int k = 0; k < ${g.maxSteps}; k++) {
    if (!crosses || enter > leave || !inGrid(cell)) break;
    int id = eid(fetchA(cell));
    if (id != E_EMPTY && KIND[id] != K_GAS) {
      if (row == 0) oC = vec4(vec3(cell), float(axis * 2 + (stepDir[axis] > 0 ? 1 : 0)));
      else if (row == 1) oC = vec4(ro + dv * enter, enter);
      else oC = vec4(0.0, 0.0, 0.0, float(id));
      return;
    }
    axis = next.x <= next.y && next.x <= next.z ? 0 : (next.y <= next.z ? 1 : 2);
    enter = next[axis]; cell[axis] += stepDir[axis]; next[axis] += stride[axis];
  }
  // The simulation's bottom is an indestructible floor; sides/top are open.
  if (dv.y < 0.0) {
    float t = -ro.y / dv.y;
    vec3 p = ro + dv * t;
    if (t >= 0.0 && t <= 1.0 && p.x >= 0.0 && p.x < float(NX) && p.z >= 0.0 && p.z < float(NZ)) {
      if (row == 0) oC = vec4(floor(p.x), -1.0, floor(p.z), 2.0);
      else if (row == 1) oC = vec4(p.x, 0.0, p.z, t);
      else oC = vec4(0.0, 0.0, 0.0, float(E_WALL));
    }
  }
}`;

export const wandClearanceFrag = (g) => /* glsl */ `
${prelude(g)}
const ivec3 GRID = ivec3(NX, NY, NZ);
uniform vec3 uFeet;
out vec4 oC;
void main() {
  oC = vec4(0.0);
  vec3 lo = uFeet - vec3(${BODY_WIDTH / 2}, 0.0, ${BODY_WIDTH / 2});
  vec3 hi = uFeet + vec3(${BODY_WIDTH / 2}, ${BODY_HEIGHT}, ${BODY_WIDTH / 2});
  if (any(lessThan(lo, vec3(0.0))) || any(greaterThan(hi, vec3(GRID)))) return;
  ivec3 first = ivec3(floor(lo)), last = ivec3(ceil(hi)) - 1;
  for (int z = 0; z < ${Math.ceil(BODY_WIDTH) + 1}; z++)
    for (int y = 0; y < ${Math.ceil(BODY_HEIGHT) + 1}; y++)
      for (int x = 0; x < ${Math.ceil(BODY_WIDTH) + 1}; x++) {
        ivec3 c = first + ivec3(x, y, z);
        if (any(greaterThan(c, last))) continue;
        int id = eid(fetchA(c));
        if (id != E_EMPTY && KIND[id] != K_GAS) return;
      }
  oC = vec4(1.0);
}`;
