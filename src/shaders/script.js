import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { EDIT, EDIT_TEX_W, EDIT_SEARCH_STEPS } from '../console/world.js';

// The console's write pass (src/console, docs/console.md): applies a batch of
// cell edits scripts queued (sim.partCreate, partKill, partProperty,
// sim.pressure ...), like the stamp pass applies a construction. Copy-through,
// so it costs what one brush stroke does, and it is only drawn when scripts
// wrote something.
//
// tEdit holds uCount edits sorted by cell key ((z · NY + y) · NX + x), EDIT_TEX_W
// per row, in three blocks of uRows rows: (key, mask bits) / state A values /
// state B values (console/world.js packEdits). A cell inside the batch's box
// [uLo, uHi] binary-searches it for its own edit. The mask bits are
// console/world.js EDIT; a fresh cell (SPAWN) starts the way the brush starts
// one (shaders/passes.js paintFrag), at rest and with its seed kept.
export const scriptEditFrag = (g) => /* glsl */ `
${prelude(g)}
uniform highp sampler2D tEdit;
uniform int uCount;
uniform int uRows;
uniform ivec3 uLo;
uniform ivec3 uHi;
#define EDIT_TEX_W ${EDIT_TEX_W}
#define EDIT_SEARCH_STEPS ${EDIT_SEARCH_STEPS}
${Object.entries(EDIT).map(([k, v]) => `#define EDIT_${k} ${v}u`).join('\n')}
${stateOutGLSL}

vec4 editAt(int j, int part) { return texelFetch(tEdit, ivec2(j % EDIT_TEX_W, j / EDIT_TEX_W + part * uRows), 0); }

void scriptEdit(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  if (any(lessThan(p, uLo)) || any(greaterThan(p, uHi))) return;
  int key = (p.z * NY + p.y) * NX + p.x;
  int lo = 0, hi = uCount - 1, j = -1;
  for (int i = 0; i < EDIT_SEARCH_STEPS; i++) {
    if (lo > hi) break;
    int mid = (lo + hi) >> 1;
    int k = int(editAt(mid, 0).x);
    if (k == key) { j = mid; break; }
    if (k < key) lo = mid + 1; else hi = mid - 1;
  }
  if (j < 0) return;
  uint m = uint(editAt(j, 0).y);
  vec4 va = editAt(j, 1), vb = editAt(j, 2);
  int id = eid(a);
  if ((m & EDIT_IF_EMPTY) != 0u && id != E_EMPTY) return;
  if ((m & EDIT_IF_MATTER) != 0u && id == E_EMPTY) return;
  float seed = fract(a.w);
  if ((m & EDIT_SPAWN) != 0u) {
    int n = int(va.x + 0.5);
    float ctype = n == E_LAVA ? float(E_STONE) : 0.0;
    oA = n == E_EMPTY ? vec4(float(E_EMPTY), uAirT, 0.0, seed) : vec4(float(n), SPAWNT[n], SPAWNLIFE[n], ctype + seed);
    oB = vec4(0.0, 0.0, 0.0, b.w);
  }
  if ((m & EDIT_TYPE) != 0u) oA.x = float(int(va.x + 0.5));
  if ((m & EDIT_TEMP) != 0u) oA.y = va.y;
  if ((m & EDIT_LIFE) != 0u) oA.z = va.z;
  if ((m & EDIT_CTYPE) != 0u) oA.w = va.w + seed;
  if ((m & EDIT_VX) != 0u) oB.x = vb.x;
  if ((m & EDIT_VY) != 0u) oB.y = vb.y;
  if ((m & EDIT_VZ) != 0u) oB.z = vb.z;
  if ((m & EDIT_PRESSURE) != 0u) oB.w = vb.w;
}
${copyThroughMain('scriptEdit')}`;
