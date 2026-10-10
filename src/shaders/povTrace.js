import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { materialsGLSL } from '../gfx/materials.js';
import { coreGLSL } from './gfx/core.js';

// GPU passes for the gun's ballistic rounds (src/pov/ballistics.js).
//
// A round flies outside the sim, on the CPU, with real ballistics. Each frame
// traceFrag marches the stretch of path it will cover next through the grid,
// one fragment per round, and the CPU reads the answers back a frame or two
// later. Where a round strikes matter, handoffFrag turns it into a SCRAP cell
// in front of what it struck, and from then on the engine owns it.
//
// Units: grid cells, cells/step for the sim's velocities.

export const TRACE = {
  ROUNDS: 16,        // texels across the trace target: rounds traced per pass
  ROWS: 3,           // texel rows per round (see traceFrag's output)
  HANDOFF_WALK: 4,   // cells the handoff walks back from the struck face looking for air
};
// Face codes are axis * 2 + (1 if the ray steps +axis), as the pick pass's; the
// face's normal is minus that step. The floor is hit stepping down y.
export const TRACE_FACE_FLOOR = 2;
export const TRACE_MISS = -1;   // face of a segment that hit nothing

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// The grid walk of render.js's pickFrag, with its brick skipping (gfx/core.js),
// without the shading the renderer's lib() also brings: a smaller program.
const traceLib = (g) => `${prelude(g)}\n${materialsGLSL()}\n${coreGLSL(g)}`;

// One fragment per (round, row) of a TRACE.ROUNDS × TRACE.ROWS target. Every
// row marches the round's segment uFrom[i].xyz → uTo[i] the same way (the DDA
// and brick skipping of render.js's pickFrag) and writes its share of the
// answer: the first cell holding a liquid, powder or solid (air and gases let a
// round through).
//   row 0: (struck cell xyz, face), face TRACE_MISS if the segment is clear
//   row 1: (last air or gas cell before it xyz, element id); xyz −1 if unknown
//   row 2: (entry point xyz, share of the segment flown to it, 0..1)
// uFrom[i].w = 0 marks an idle texel. A segment that runs out through the
// floor (y = 0 is the floor, below the grid) strikes it: the engine treats
// what lies outside the box as WALL. Through the sides or the top it is clear.
export const traceFrag = (g) => /* glsl */ `
${traceLib(g)}
#define TRACE_ROUNDS ${TRACE.ROUNDS}
#define TRACE_FACE_FLOOR ${TRACE_FACE_FLOOR}
#define TRACE_MISS ${f(TRACE_MISS)}
#define TRACE_NUDGE 1e-3   // cells: how far back from a start point inside a cell the cell before it is looked for
uniform vec4 uFrom[TRACE_ROUNDS];   // xyz grid, w 1 = active
uniform vec3 uTo[TRACE_ROUNDS];
out vec4 oC;

void main() {
  int i = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
  vec4 miss = row == 0 ? vec4(0.0, 0.0, 0.0, TRACE_MISS) : vec4(-1.0, -1.0, -1.0, 0.0);
  oC = miss;
  vec4 from = uFrom[i];
  if (from.w < 0.5) return;
  vec3 ro = from.xyz;
  vec3 dv = uTo[i] - ro;
  float len = length(dv);
  if (len <= 0.0) return;
  vec3 rd = safeDir(dv / len);

  // the floor, where the segment would run out through it
  float tFloor = rd.y < 0.0 ? -ro.y / rd.y : -1.0;
  vec3 atFloor = ro + rd * tFloor;
  bool floorHit = tFloor >= 0.0 && tFloor <= len
    && atFloor.x >= 0.0 && atFloor.x < float(NX) && atFloor.z >= 0.0 && atFloor.z < float(NZ);

  vec3 bh = boxHit(ro, rd);
  float t0 = max(bh.x, 0.0);
  float tEnd = min(bh.y, len);
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + DDA_START_NUDGE))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  // the axis the first cell was entered across: the box face, or for a start
  // inside the box the one the path left the cell before it through
  vec3 back = floor(ro - rd * TRACE_NUDGE);
  vec3 moved = abs(back - vec3(cell));
  int ax = bh.x > 0.0 ? int(bh.z) : (moved.x > 0.0 ? 0 : moved.y > 0.0 ? 1 : moved.z > 0.0 ? 2 : -1);
  ivec3 lastB = ivec3(-1);
  int flags = 0;

  for (int k = 0; k < ${g.maxSteps}; k++) {
    if (t0 >= tEnd || tEnter > tEnd || outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; flags = brickInfo(bc); }
    if (flags == 0) { ax = skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    vec4 a = fetchA(cell);
    int id = eid(a);
    if (id != E_EMPTY && KIND[id] != K_GAS) {
      // entered from outside the box, or from an unknown side: no cell before it
      bool known = ax >= 0 && !(k == 0 && bh.x > 0.0);
      int axis = ax >= 0 ? ax : argmin3(-abs(rd));
      ivec3 prev = cell;
      if (known) prev[axis] -= istp[axis];
      int face = axis * 2 + (istp[axis] > 0 ? 1 : 0);   // normal = -step
      if (row == 0) oC = vec4(vec3(cell), float(face));
      else if (row == 1) oC = vec4(known ? vec3(prev) : vec3(-1.0), float(id));
      else oC = vec4(ro + rd * tEnter, tEnter / len);
      return;
    }
    ax = argmin3(tMax);
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (floorHit) {
    ivec3 under = ivec3(floor(atFloor.x), -1, floor(atFloor.z));
    if (row == 0) oC = vec4(vec3(under), float(TRACE_FACE_FLOOR));
    else if (row == 1) oC = vec4(vec3(under) + vec3(0.0, 1.0, 0.0), float(E_WALL));
    else oC = vec4(vec3(atFloor.x, 0.0, atFloor.z), tFloor / len);
  }
}
`;

// Hand a round to the sim: write one SCRAP cell, at uVel, into the first air
// cell (a gas cell if no air is in reach) found walking back along −uDir from
// the struck face's entry point uEntry: at most HANDOFF_WALK cells, and none
// that starts more than uReach cells back (where the round left the muzzle:
// the cells behind it are the shooter's). The walk re-reads the state this pass sees, so
// the slug never lands on matter that moved in since the trace; if the walk
// finds no room the slug is dropped (the pass changes nothing). Every
// fragment in the walk's bounding box (uLo..uHi) runs the same walk, so they
// agree on the one cell that takes the slug.
export const handoffFrag = (g) => /* glsl */ `
${prelude(g)}
#define HANDOFF_WALK ${TRACE.HANDOFF_WALK}
#define HANDOFF_NUDGE 1e-3   // cells: the walk starts this far back from the entry point, in the cell before the face
${stateOutGLSL}
uniform vec3 uEntry;   // grid cells
uniform vec3 uDir;     // unit heading of the round
uniform vec3 uVel;     // cells/step, the slug's velocity
uniform float uReach;  // cells back from uEntry the walk may enter a cell at
uniform vec3 uLo;      // the walk's bounding box, in cells
uniform vec3 uHi;

int idAt(ivec3 c) { return eid(fetchA(c)); }

void handoff(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 pc = vec3(p);
  if (any(lessThan(pc, uLo)) || any(greaterThan(pc, uHi))) return;

  // walk back: a DDA from just before the entry point along -uDir
  vec3 rd = -uDir;
  rd = vec3(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y, abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
  vec3 ro = uEntry + rd * HANDOFF_NUDGE;
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 c = ivec3(floor(ro));
  vec3 tMax = (vec3(c) + step(0.0, rd) - ro) / rd;
  ivec3 air = ivec3(-1), gas = ivec3(-1);
  float tEnter = 0.0;
  for (int k = 0; k < HANDOFF_WALK; k++) {
    if (tEnter > uReach || !inGrid(c)) break;
    int id = idAt(c);
    if (id == E_EMPTY) { air = c; break; }
    if (KIND[id] == K_GAS && gas.x < 0) gas = c;
    int ax = tMax.x <= tMax.y && tMax.x <= tMax.z ? 0 : (tMax.y <= tMax.z ? 1 : 2);
    tEnter = tMax[ax];
    c[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  ivec3 slot = air.x >= 0 ? air : gas;
  if (slot != p) return;
  oA = vec4(float(E_SCRAP), AMBIENT, SPAWNLIFE[E_SCRAP], fract(a.w));
  oB = vec4(uVel, b.w);
}
${copyThroughMain('handoff')}`;
