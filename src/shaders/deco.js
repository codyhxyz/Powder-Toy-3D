import { prelude } from './common.js';
import { quietGLSL } from './activity.js';
import { slotGLSL } from './move.js';
import { slabGLSL, STAGE_W } from './window.js';

// The decoration layer's passes (src/deco.js runs them): The Powder Toy's
// "deco", a colour painted onto matter that travels with it.
//
// Storage: one RGBA8 texel per cell, laid out like the state (atlas()), in a
// ping-pong pair beside it: (r, g, b) the colour in sRGB and a its strength,
// TPT's dcolour (src/simulation/Particle.h: one 0xAARRGGBB word per
// particle). 0 everywhere is "nothing decorated". The simulation never reads
// it; it only follows the cells:
//   - the move: every cell takes the decoration of the cell its content came
//     from, by the block pass's slots (decoGatherFrag), after the gather;
//   - an element change in place keeps it (TPT's transitions go through
//     Simulation::part_change_type, which leaves dcolour alone:
//     src/simulation/Simulation.cpp, "ideally transitions should use
//     create_part(i)"), so painted ice melts into painted water;
//   - a cell that empties loses it (kill_part), and so does a cell a write
//     outside the step gives a new element (the brush, a stamp: TPT's
//     create_part resets the particle to the element's defaults, dcolour 0,
//     src/simulation/Simulation.cpp create_part; decoScrubFrag).

// TPT's deco modes (src/simulation/SimulationData.h DECO_*), in the order the
// tools' ids run (elements.js DECO_TOOLS).
export const DECO_MODE = { SET: 0, CLEAR: 1, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, DIVIDE: 5, SMUDGE: 6 };
// How much one application of add, subtract, multiply or divide moves a
// channel, per unit of the colour and its alpha (TPT's `strength`,
// src/simulation/Editing.cpp Simulation::ApplyDecoration). TPT applies it once
// per frame while the mouse is down, as the brush does here.
export const DECO_STRENGTH = 0.01;
// Smudge reads the cells within SMUDGE_REACH along each axis whose taxicab
// distance is over SMUDGE_NEAR (TPT: a 5×5 square without its centre diamond,
// `abs(rx)+abs(ry) > 2`), averaged in linear light (TPT's default
// DECOSPACE_SRGB), and takes SMUDGE_FADE off an undecorated cell's alpha.
const SMUDGE_REACH = 2;
const SMUDGE_NEAR = 2;
const SMUDGE_FADE = 3 / 255;
const g = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

const decoGLSL = /* glsl */ `
uniform sampler2D tDeco;   // the decoration before this pass (src/deco.js)
out vec4 oD;
vec4 decoOf(ivec3 c) { return texelFetch(tDeco, atlas(c), 0); }
`;

// After the move's gather (tA: the state after the move, tSlots its slots):
// each cell takes the decoration of the cell its content came from, as the
// gather took it (shaders/move.js postMove; a block based in a quiet brick
// stayed put), and an empty cell has none. It draws every cell, as
// whitewater's field does (shaders/gfx/liquidDetail.js aerationFrag), so the
// two copies never need settling.
export const decoGatherFrag = (grid) => /* glsl */ `
${prelude(grid)}
${quietGLSL}
${slotGLSL}
${decoGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oD = vec4(0.0); return; }   // a texel holding no cell
  ivec3 q = p;
  if (!quietCell(blockBase(p))) { slotOf(p, q); q = edgeCell(q); }   // (past a loop edge: the far side's, as postMove reads it)
  oD = eid(fetchA(p)) == E_EMPTY || !inGrid(q) ? vec4(0.0) : decoOf(q);   // (from past a void edge: still air, unpainted)
}
`;

// After a write that isn't a step (tA: the state after it, tPrevA before):
// a cell that changed element or emptied loses its decoration (TPT's
// create_part and kill_part; see the top of this file).
export const decoScrubFrag = (grid) => /* glsl */ `
${prelude(grid)}
uniform sampler2D tPrevA;
${decoGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oD = vec4(0.0); return; }
  int id = eid(fetchA(p));
  oD = id == E_EMPTY || id != eid(texelFetch(tPrevA, atlas(p), 0)) ? vec4(0.0) : decoOf(p);
}
`;

// The deco brush: TPT's Simulation::ApplyDecoration (src/simulation/Editing.cpp)
// on every cell holding matter inside the brush (the shape and radius of the
// element brush, shaders/passes.js paintFrag). uColor is the picker's colour,
// sRGB, and its alpha, all 0..1 (TPT's colR..colA / 255); the target's 8 bits
// round as TPT's `+ .5f` does.
export const decoPaintFrag = (grid) => /* glsl */ `
${prelude(grid)}
uniform vec3 uCenter;
uniform float uRadius;
uniform int uShape;     // 0 sphere, 1 cube
uniform int uMode;      // DECO_MODE
uniform vec4 uColor;
${decoGLSL}
${Object.entries(DECO_MODE).map(([k, v]) => `#define DECO_${k} ${v}`).join('\n')}
#define DECO_STRENGTH ${g(DECO_STRENGTH)}
#define SMUDGE_REACH ${SMUDGE_REACH}
#define SMUDGE_NEAR ${SMUDGE_NEAR}
#define SMUDGE_FADE ${g(SMUDGE_FADE)}
// TPT's DECOSPACE_SRGB conversions (Editing.cpp), the IEC 61966-2-1 curve
vec4 srgbToLin(vec4 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec4(2.4)), step(0.04045, c)); }
vec4 linToSrgb(vec4 c) { return mix(c * 12.92, 1.055 * pow(c, vec4(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oD = vec4(0.0); return; }
  vec4 t = decoOf(p);
  oD = t;
  vec3 d = vec3(p) + 0.5 - uCenter;
  float r = uShape == 0 ? length(d) : max(abs(d.x), max(abs(d.y), abs(d.z)));
  if (r > uRadius || eid(fetchA(p)) == E_EMPTY) return;
  vec3 c = uColor.rgb * uColor.a * DECO_STRENGTH;
  if (uMode == DECO_SET) t = uColor;
  else if (uMode == DECO_CLEAR) t = vec4(0.0);
  else if (uMode == DECO_ADD) t.rgb += c;            // (TPT leaves alpha alone for these four)
  else if (uMode == DECO_SUBTRACT) t.rgb -= c;
  else if (uMode == DECO_MULTIPLY) t.rgb *= 1.0 + c;
  else if (uMode == DECO_DIVIDE) t.rgb /= 1.0 + c;
  else if (uMode == DECO_SMUDGE) {
    vec4 sum = vec4(0.0);
    float n = 0.0;
    for (int z = -SMUDGE_REACH; z <= SMUDGE_REACH; z++)
      for (int y = -SMUDGE_REACH; y <= SMUDGE_REACH; y++)
        for (int x = -SMUDGE_REACH; x <= SMUDGE_REACH; x++) {
          ivec3 o = ivec3(x, y, z);
          ivec3 q = p + o;
          if (abs(x) + abs(y) + abs(z) <= SMUDGE_NEAR || !inGrid(q)) continue;
          vec4 dq = decoOf(q);
          if (dq == vec4(0.0) || eid(fetchA(q)) == E_EMPTY) continue;
          sum += srgbToLin(dq);
          n += 1.0;
        }
    if (n == 0.0) return;
    vec4 s = linToSrgb(sum / n);
    if (t == vec4(0.0)) s.a -= SMUDGE_FADE;
    t = s;
  }
  oD = clamp(t, 0.0, 1.0);
}
`;

// Undo (Simulation.undo): cell p takes the snapshot's cell p + uShift (the
// grid cells the window moved since it was taken, shaders/window.js
// undoShiftFrag), or none with uBlank (a snapshot from before anything was
// decorated); cells the snapshot doesn't hold keep what they have.
export const decoUndoFrag = (grid) => /* glsl */ `
${prelude(grid)}
uniform sampler2D tSnap;
uniform ivec3 uShift;
uniform bool uBlank;
${decoGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  ivec3 q = p + uShift;
  oD = inGrid(p) && inGrid(q) ? (uBlank ? vec4(0.0) : texelFetch(tSnap, atlas(q), 0)) : decoOf(p);
}
`;

// A texture into the decoration, texel for texel (loads: src/deco.js upload).
export const decoCopyFrag = () => /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc;
out vec4 oD;
void main() { oD = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }
`;

// The World's window (world/window.js): the slab about to leave, staged in
// the slab layout of shaders/window.js (brick i's 64 cells at texels 64·i ..),
// one RGBA8 texel per cell, for the readback into the deco store.
export const decoStageFrag = (grid) => /* glsl */ `
${prelude(grid)}
${slabGLSL}
uniform ivec3 uLo;       // the slab's low corner, grid cells (brick-aligned)
uniform ivec3 uBricks;   // the slab's size in bricks
${decoGLSL}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int t = f.x + STAGE_W * f.y;
  int i = t / BRICK_CELLS;
  ivec3 b = ivec3(i % uBricks.x, (i / uBricks.x) % uBricks.y, i / (uBricks.x * uBricks.y));
  ivec3 p = uLo + b * BS + slabCell(t - i * BRICK_CELLS);
  oD = b.z >= uBricks.z || !inGrid(p) ? vec4(0.0) : decoOf(p);
}
`;

// ...and the stored bricks of a slab the window uncovers, written back:
// tEditIdx holds per grid brick (brickAtlas) its slot in tEditD plus one (0:
// none), slot s being slab-layout brick s. Every other cell keeps its own.
export const decoEditFrag = (grid) => /* glsl */ `
${prelude(grid)}
${slabGLSL}
uniform sampler2D tEditIdx;
uniform sampler2D tEditD;
${decoGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oD = vec4(0.0); return; }
  ivec3 bc = p / BS;
  int s = int(texelFetch(tEditIdx, brickAtlas(bc), 0).r + 0.5) - 1;
  if (s < 0) { oD = decoOf(p); return; }
  int t = s * BRICK_CELLS + slabIndex(p - bc * BS);
  oD = texelFetch(tEditD, ivec2(t % STAGE_W, t / STAGE_W), 0);
}
`;

export { STAGE_W };
