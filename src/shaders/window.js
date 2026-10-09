import { prelude, stateOutGLSL, copyThroughMain } from './common.js';

// Passes that move the window over the world (docs/scaling.md D11; driven by
// world/window.js through Simulation.shift and the store). All of them read and
// write the state through the prelude's accessors.
//
// Slab layout. A slab (the cells about to leave the window, or a set of stored
// bricks coming back) is exchanged with the CPU brick by brick, in the D5
// float layout: brick i's 64 cells are texels 64·i .. 64·i + 63, row-major in
// a STAGE_W-wide pair of RGBA32F textures (A and B), its cells x fastest,
// then y, then z (SLAB_CELL). world/store.js keeps bricks in the same order.

export const BRICK_CELLS = 64;                         // cells per 4³ brick
export const STAGE_BRICKS_PER_ROW = 16;                // bricks per staging-texture row
export const STAGE_W = BRICK_CELLS * STAGE_BRICKS_PER_ROW;   // texels per staging-texture row

const slabGLSL = /* glsl */ `
#define BRICK_CELLS ${BRICK_CELLS}
#define STAGE_W ${STAGE_W}
// local cell l of a brick (x fastest, then y, then z) and back
ivec3 slabCell(int l) { return ivec3(l % BS, (l / BS) % BS, l / (BS * BS)); }
int slabIndex(ivec3 c) { return c.x + BS * (c.y + BS * c.z); }
`;

// Shift: cell p takes the state of p + uShift, so the content moves by
// -uShift as the window moves by +uShift over the world. Cells whose source is
// outside the grid were uncovered: they become still air at ambient until the
// generator fills them. Padding texels (no cell) copy through.
export const shiftFrag = (g) => /* glsl */ `
${prelude(g)}
uniform ivec3 uShift;   // grid cells the window moved (a multiple of a supertile)
${stateOutGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  ivec3 q = inGrid(p) ? p + uShift : p;
  if (!inGrid(p) || inGrid(q)) { writeState(fetchA(q), fetchB(q)); return; }
  writeState(vec4(float(E_EMPTY), AMBIENT, 0.0, 0.0), vec4(0.0));
}
`;

// Stage: copies the slab of grid cells [uLo, uLo + 4·uBricks) into the staging
// textures (slab layout above), brick i at slab brick (i % bx, i / bx % by, i / bx / by).
export const stageFrag = (g) => /* glsl */ `
${prelude(g)}
${slabGLSL}
uniform ivec3 uLo;       // the slab's low corner, grid cells (brick-aligned)
uniform ivec3 uBricks;   // the slab's size in bricks
layout(location = 0) out vec4 oSA;
layout(location = 1) out vec4 oSB;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int t = f.x + STAGE_W * f.y;
  int i = t / BRICK_CELLS;
  ivec3 b = ivec3(i % uBricks.x, (i / uBricks.x) % uBricks.y, i / (uBricks.x * uBricks.y));
  ivec3 p = uLo + b * BS + slabCell(t - i * BRICK_CELLS);
  if (b.z >= uBricks.z || !inGrid(p)) { oSA = oSB = vec4(0.0); return; }
  oSA = fetchA(p);
  oSB = fetchB(p);
}
`;

// Edits: writes stored bricks back into the grid. tEditIdx holds, per grid
// brick (brickAtlas), its slot in tEditA/tEditB plus one (0: no edit); slot s
// is staging-layout brick s. Every other cell copies through.
export const editFrag = (g) => /* glsl */ `
${prelude(g)}
${slabGLSL}
uniform sampler2D tEditIdx;
uniform sampler2D tEditA;
uniform sampler2D tEditB;
${stateOutGLSL}
void edit(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  ivec3 bc = p / BS;
  int s = int(texelFetch(tEditIdx, brickAtlas(bc), 0).r + 0.5) - 1;
  if (s < 0) return;
  int t = s * BRICK_CELLS + slabIndex(p - bc * BS);
  ivec2 tx = ivec2(t % STAGE_W, t / STAGE_W);
  oA = texelFetch(tEditA, tx, 0);
  oB = texelFetch(tEditB, tx, 0);
}
${copyThroughMain('edit')}`;

// GI probes (shaders/gi.js) follow the cells: probe b takes probe b + uShift
// (bricks). Probes shifted in from outside take the nearest one inside, and
// converge from there as the gather blends in.
export const giShiftFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tGI0;   // the probe volume's four L1 SH bands (shaders/gi.js)
uniform sampler2D tGI1;
uniform sampler2D tGI2;
uniform sampler2D tGI3;
uniform ivec3 uShift;   // bricks the window moved
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { o0 = o1 = o2 = o3 = vec4(0.0); return; }
  ivec2 s = brickAtlas(clamp(bc + uShift, ivec3(0), ivec3(BX, BY, BZ) - 1));
  o0 = texelFetch(tGI0, s, 0);
  o1 = texelFetch(tGI1, s, 0);
  o2 = texelFetch(tGI2, s, 0);
  o3 = texelFetch(tGI3, s, 0);
}
`;

// The flow field (shaders/move.js moveFlowFrag, Simulation.flowV) follows the
// cells like the state: it is laid out like the state (atlas()), so texel
// p takes the flow of cell p + uShift; cells shifted in from outside are still.
export const flowShiftFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tFlowSrc;
uniform ivec3 uShift;   // grid cells the window moved
out vec4 oV;
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  ivec3 q = p + uShift;
  oV = inGrid(p) && inGrid(q) ? texelFetch(tFlowSrc, atlas(q), 0) : vec4(0.0);
}
`;
