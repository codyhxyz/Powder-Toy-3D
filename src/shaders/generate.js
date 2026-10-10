import { prelude, stateOutGLSL } from './common.js';

// World generation passes (docs/scaling.md D11, "Generator", "Scenes"): every
// world scene (world/scenes; the island's generator is one, world/generator.js
// and scenes/island.js) generates through its sceneCell(world cell, A, B), a
// pure function of the world cell and its uniforms, so any region (a window
// slab) generates seamlessly next to any other. These passes are the window's
// fill and diff for it (world/gpu.js); sceneGLSL is the scene's glsl(g),
// included after the prelude and nothing else, so a scene brings its own.

// Diff tolerances, over a slab about to leave the window (docs/scaling.md D11,
// "Leaving slabs"): one texel per brick of grid cells [uLo, uLo + 4·uBricks),
// DIFF_W per row in slab-brick order (shaders/window.js), r = 1 where the brick
// differs from what the scene makes there, so world/window.js keeps it.
// Air counts as unchanged while it is still air within AIR_REST_T of the
// generator's temperature: its seed, velocity and pressure don't matter.
// Matter needs the same element, ctype and seed (state A's w holds both),
// life within STORE_LIFE_TOL (or a half's step: it is stored packed) and temperature within STORE_MATTER_T; its
// velocity and pressure are ignored too. uOrigin (the prelude's) is the
// window's.
export const STORE_MATTER_T = 0.5;   // °C: drift a regenerated brick may lose (it is still quiet: well under AIR_REST_T)
export const STORE_LIFE_TOL = 1e-4;  // life/latent/fuel units: float slop only (life changes by reactions)
export const HALF_STEP_REL = 2 ** -10;   // a half's step is at most this share of its value: stored life is one (common.js PACK)
export const DIFF_W = 64;            // texels per row of the diff target
// the diff's uniforms, output and cell test
const diffHeadGLSL = /* glsl */ `uniform ivec3 uLo;       // the slab's low corner, grid cells (brick-aligned)
uniform ivec3 uBricks;   // the slab's size in bricks
out vec4 oC;
#define DIFF_W ${DIFF_W}
#define STORE_MATTER_T ${STORE_MATTER_T}
#define STORE_LIFE_TOL ${STORE_LIFE_TOL}
#define HALF_STEP_REL ${HALF_STEP_REL}
bool cellDiffers(vec4 a, vec4 gen) {
  int id = eid(a);
  if (id != eid(gen)) return true;
  if (id == E_EMPTY) return abs(a.y - gen.y) > AIR_REST_T;
  return a.w != storedW(gen.w) || abs(a.y - gen.y) > STORE_MATTER_T || abs(a.z - gen.z) > max(STORE_LIFE_TOL, abs(gen.z) * HALF_STEP_REL);
}`;

// Fill pass: writes the generated state of every cell of the grid inside
// [uFillMin, uFillMax) (window-local cells) and keeps the rest, so it can
// fill the slab a window shift uncovers as well as the whole grid. uOrigin
// (the prelude's) is the world cell of the grid's cell (0, 0, 0).
export const sceneFillFrag = (g, sceneGLSL) => /* glsl */ `
${prelude(g)}
${sceneGLSL}
uniform ivec3 uFillMin;
uniform ivec3 uFillMax;
#define GEN_ROUND_SALT 0x9e7u   // the generated state's rounding stream (one per world cell)
${stateOutGLSL}

void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  uvec4 raw = fetchRaw(p);
  uint f = fetchF(p);
  // padding texels (no cell) and cells outside the fill region copy through
  if (!inGrid(p) || any(lessThan(p, uFillMin)) || any(greaterThanEqual(p, uFillMax))) { writeStateRaw(raw, f); return; }
  vec4 A, B;
  sceneCell(uOrigin + p, A, B);
  // rounded from the world cell's own stream: a cell generates to the same
  // bits whenever its slab is filled (a regenerated brick is the fresh one)
  writeStateFrom(A, B, writtenFlags(f, unpackA(raw), unpackB(raw), A, B), seedWorld(uOrigin + p, 0u, GEN_ROUND_SALT));
}
`;

// Diff pass (the tolerances above).
export const sceneDiffFrag = (g, sceneGLSL) => /* glsl */ `
${prelude(g)}
${sceneGLSL}
${diffHeadGLSL}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int i = f.x + DIFF_W * f.y;
  ivec3 b = ivec3(i % uBricks.x, (i / uBricks.x) % uBricks.y, i / (uBricks.x * uBricks.y));
  oC = vec4(0.0);
  if (b.z >= uBricks.z) return;
  ivec3 o = uLo + b * BS;
  bool diff = false;
  for (int z = 0; z < BS && !diff; z++)
  for (int x = 0; x < BS && !diff; x++)
  for (int y = 0; y < BS; y++) {
    ivec3 p = o + ivec3(x, y, z);
    vec4 gA, gB;
    sceneCell(uOrigin + p, gA, gB);
    if (cellDiffers(fetchA(p), gA)) { diff = true; break; }
  }
  oC = vec4(diff ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;
