import { lib } from './render.js';

export const MAX_SIGNS = 64;

// Sign probe: one fragment per sign (target is MAX_SIGNS × 1, RGBA32F).
//
// tSigns (MAX_SIGNS × 2 float texture):
//   row 0 = (anchor xyz in grid coords, unused)  the point on the face the sign is pinned to
//   row 1 = (cell xyz to sample, unused)          the attached voxel (or the one above a floor sign)
//
// Output per sign: (transmittance camera → anchor, element id or -1, temperature °C, air pressure).
// Transmittance is 0 as soon as an opaque voxel is in the way; liquids and glass attenuate it
// with the same Beer–Lambert extinction the renderer uses; gases and fire don't block.
export const signProbeFrag = (g) => /* glsl */ `
${lib(g)}
uniform sampler2D tB;
uniform sampler2D tSigns;
uniform vec3 uCam;
uniform int uCount;
out vec4 oC;

float sightLine(vec3 ro, vec3 target) {
  vec3 dv = target - ro;
  float tEnd = length(dv);
  if (tEnd < 1e-3) return 1.0;
  vec3 rd = safeDir(dv / tEnd);
  vec3 bh = boxHit(ro, rd);
  float t0 = max(bh.x, 0.0);
  // stop just short of the face the sign sits on, so the attached voxel only
  // counts when the ray actually passes through it (camera behind the face)
  float t1 = min(bh.y, tEnd - 0.02);
  if (t1 <= t0) return 1.0;

  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  float tau = 0.0;

  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell) || tEnter >= t1) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int ax = argmin3(tMax);
    float seg = min(tMax[ax], t1) - tEnter;
    int id = eid(cellA(cell));
    if (id != E_EMPTY) {
      int rc = RCLASS[id];
      // ignore rays that only graze a voxel edge
      if (rc == R_OPAQUE && seg > 0.03) return 0.0;
      if (rc == R_LIQUID || rc == R_GLASS) tau += dot(SIGMA[id], vec3(1.0 / 3.0)) * seg;
    }
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return exp(-tau);
}

void main() {
  int i = int(gl_FragCoord.x);
  if (i >= uCount) { oC = vec4(1.0, -1.0, AMBIENT, 0.0); return; }
  vec3 anchor = texelFetch(tSigns, ivec2(i, 0), 0).xyz;
  ivec3 c = ivec3(floor(texelFetch(tSigns, ivec2(i, 1), 0).xyz + 0.5));
  float tr = sightLine(uCam, anchor);
  if (outside(c)) { oC = vec4(tr, -1.0, AMBIENT, 0.0); return; }
  vec4 a = cellA(c);
  oC = vec4(tr, float(eid(a)), a.y, texelFetch(tB, atlas(c), 0).w);
}
`;
