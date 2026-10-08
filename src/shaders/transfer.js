import { prelude } from './common.js';

// Exact cell transfer (src/pov/tools/transfer.js): taking cells out of the grid
// and putting them back with nothing lost or duplicated.
//
// A transfer is a short list of slots (cells), uploaded as tSlots:
//   row 0, texel i = (cell xyz, wanted element id or -1 for any)
//   row 1, texel r = the r-th cell's contents to place (state A), puts only
// A slot qualifies when its cell passes the transfer's filter: for a take, the
// cell holds a wanted element of an allowed kind (and, when breaking, a solid
// that can break); for a put, the cell is empty air. Of the qualifying slots
// only the first uLimit act, in slot order, so the caller decides which cells
// go first (nearest the aim) and how many at most (what the load can hold).
//
// Two passes read the same state and evaluate the same rule:
//   transferProbeFrag  TRANSFER_SLOTS × 1 target, read back by the CPU: per slot,
//                      what was taken (state A, debris id when breaking) or the
//                      rank of the item placed there, else id/rank -1
//   transferApplyFrag  full grid (sim.pass): the acting cells become air at
//                      ambient (take) or the placed item (put)
// so the CPU learns exactly what the grid gained or lost, however the world
// moves while the readback is in flight.

export const TRANSFER_SLOTS = 256;      // cells one transfer can touch (= texels read back)
export const TRANSFER_TAKE = 0;         // uMode
export const TRANSFER_PUT = 1;

const slotLib = (g) => /* glsl */ `
${prelude(g)}
#define TRANSFER_SLOTS ${TRANSFER_SLOTS}
#define MODE_TAKE ${TRANSFER_TAKE}
#define MODE_PUT ${TRANSFER_PUT}
uniform sampler2D tA;
uniform sampler2D tB;
uniform sampler2D tSlots;
uniform int uCount;     // slots in use
uniform int uLimit;     // at most this many qualifying slots act (in slot order)
uniform int uMode;      // MODE_TAKE or MODE_PUT
uniform int uKinds;     // take: bit (1 << kind) for each element kind it may take
uniform bool uBreak;    // take: solids come out as their debris (BREAKINTO)

ivec3 slotCell(int i) { return ivec3(floor(texelFetch(tSlots, ivec2(i, 0), 0).xyz + 0.5)); }

bool qualifies(int i) {
  vec4 s = texelFetch(tSlots, ivec2(i, 0), 0);
  ivec3 c = ivec3(floor(s.xyz + 0.5));
  if (!inGrid(c)) return false;
  int id = eid(texelFetch(tA, atlas(c), 0));
  if (uMode == MODE_PUT) return id == E_EMPTY;
  int want = int(floor(s.w + 0.5));
  if (id == E_EMPTY || (want >= 0 && id != want)) return false;
  if ((uKinds & (1 << KIND[id])) == 0) return false;
  return !uBreak || BREAKINTO[id] >= 0;
}

// The slot's rank among the qualifying slots before it, or -1 if it doesn't act.
int actingRank(int i) {
  if (!qualifies(i)) return -1;
  int r = 0;
  for (int j = 0; j < i; j++) if (qualifies(j)) r++;
  return r < uLimit ? r : -1;
}
`;

export const transferProbeFrag = (g) => /* glsl */ `
${slotLib(g)}
out vec4 oC;
void main() {
  int i = int(gl_FragCoord.x);
  oC = vec4(-1.0, 0.0, 0.0, 0.0);
  if (i >= uCount) return;
  int r = actingRank(i);
  if (r < 0) return;
  if (uMode == MODE_PUT) { oC = vec4(float(r), 0.0, 0.0, 0.0); return; }
  vec4 a = texelFetch(tA, atlas(slotCell(i)), 0);
  int id = eid(a);
  oC = vec4(float(uBreak ? BREAKINTO[id] : id), a.yzw);
}
`;

export const transferApplyFrag = (g) => /* glsl */ `
${slotLib(g)}
uniform ivec3 uBoxMin;   // bounds of the slots' cells (inclusive): every other cell copies through
uniform ivec3 uBoxMax;
uniform vec3 uVel;       // put: velocity of the placed cells, cells/step
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, f, 0);
  vec4 b = texelFetch(tB, f, 0);
  oA = a; oB = b;
  ivec3 p = cellFromFrag(f);
  if (p.y >= NY || any(lessThan(p, uBoxMin)) || any(greaterThan(p, uBoxMax))) return;
  int slot = -1;
  for (int i = 0; i < uCount; i++) if (slotCell(i) == p) { slot = i; break; }
  if (slot < 0) return;
  int r = actingRank(slot);
  if (r < 0) return;
  if (uMode == MODE_PUT) {
    oA = texelFetch(tSlots, ivec2(r, 1), 0);
    oB = vec4(uVel, b.w);
  } else {
    // air at ambient, keeping the cell's random seed and the air pressure
    oA = vec4(float(E_EMPTY), AMBIENT, 0.0, fract(a.w));
    oB = vec4(0.0, 0.0, 0.0, b.w);
  }
}
`;
