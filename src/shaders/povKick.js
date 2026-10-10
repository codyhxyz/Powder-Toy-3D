import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { BODY_HEIGHT } from '../pov/constants.js';

// GPU passes for the kick (src/pov/kick.js) and the hook (src/pov/tools/hook.tool.js).
//
// Units: cells, cells/step, and the sim's kinetic energy ½·DENS·|v|² (the unit
// of ELEMENTS[].hard, HARD[] in GLSL), as in shaders/povTools.js.

// Kick: a boot's blow over a small round patch around the struck cell. Its
// size is Noita's kick (data/entities/player.xml KickComponent kick_radius,
// 3 px; a Noita pixel is half a cell at this body's height, player.js PX).
// Across the patch, r the distance from its centre over RADIUS:
//   w(r) = 1 − r²
// - a breakable solid takes E = ENERGY·w and breaks into its debris where E
//   beats its hardness (the axe's rule, povTools.js blowFrag). With ENERGY 16
//   (twice GLASS's 8, under WOOD's 20) a pane breaks around the boot, out to
//   r² ≤ 0.5 (the struck cell and its six face neighbours); ICE and PLANT (6)
//   a little wider; WOOD, ROCK and METAL never.
// - loose matter (powder, liquid) and the fresh debris get the struck lump's
//   velocity times w, so the momentum handed over is the lump's: kick.js sums
//   the same w-weighted mass from the body's probe and splits the boot's speed
//   between the lump and the body by inverse mass (pov/tug.js).
// kick.js keeps the CPU copy of these numbers; the GLSL gets them as defines.
const NOITA_BODY_PX = 11;                     // px, Noita's Mina head to feet (player.js)
const NOITA_PX = BODY_HEIGHT / NOITA_BODY_PX;  // cells per Noita pixel (player.js PX)
const NOITA_KICK_RADIUS_PX = 3;                // px (KickComponent kick_radius)
export const KICK = {
  RADIUS: NOITA_KICK_RADIUS_PX * NOITA_PX,   // cells (1.5)
  ENERGY: 16,        // sim KE units at the patch centre (between GLASS's 8 and WOOD's 20)
};
// w(r) on the CPU, matching the GLSL below: r = distance from the centre, cells
export const kickWeight = (r) => Math.max(0, 1 - (r * r) / (KICK.RADIUS * KICK.RADIUS));

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = (prefix, obj) => Object.entries(obj).map(([k, v]) => `#define ${prefix}_${k} ${f(v)}`).join('\n');

export const kickFrag = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
${defines('KICK', KICK)}
uniform vec3 uCenter;   // grid cells: the centre of the struck cell
uniform vec3 uShove;    // cells/step: the struck lump's velocity (along the kick)

void kick(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uCenter;
  float r2 = dot(d, d) / (KICK_RADIUS * KICK_RADIUS);
  if (r2 >= 1.0) return;
  float w = 1.0 - r2;
  int id = eid(a);
  int into = BREAKINTO[id];
  if (KIND[id] == K_SOLID && into >= 0 && KICK_ENERGY * w >= HARD[id]) {
    oA.x = float(into);
    oB.xyz = clamp(uShove * w, -V_MAX, V_MAX);
  } else if (KIND[id] == K_POWDER || KIND[id] == K_LIQUID) {
    oB.xyz = clamp(b.xyz + uShove * w, -V_MAX, V_MAX);
  }
}
${copyThroughMain('kick')}`;

// One texel: what the hook's anchor cell holds now (state A), read back so the
// rope lets go when its anchor stops being solid (it broke, melted or burned).
export const hookCellFrag = (g) => /* glsl */ `
${prelude(g)}
uniform vec3 uCell;   // grid cells, the anchor cell's corner
out vec4 oC;
void main() {
  ivec3 c = ivec3(floor(uCell + 0.5));
  oC = inGrid(c) ? fetchA(c) : vec4(-1.0);
}
`;
