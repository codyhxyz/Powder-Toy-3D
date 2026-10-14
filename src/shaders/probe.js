import { prelude, STATE_OPTS, LAYOUT, STAGE } from './common.js';
import { brickInfoWGSL } from './bindings.js';
import { ddaGLSL } from './gfx/core.js';
import { materialsGLSL } from '../gfx/materials.js';
import { uniformStruct } from '../gpu/params.js';

export const MAX_SIGNS = 64;

// The sign probe (src/signs.js; docs/webgpu.md G4): one workgroup of
// MAX_SIGNS threads, a sign each. Group 2:
//   brick     the brick map (src/derived.js), read for which bricks hold matter
//   signData  2 · MAX_SIGNS vec4f: the anchors (xyz in grid coordinates: the
//             point on the face the sign is pinned to), then the cells to
//             sample (the attached voxel, or the one above a floor sign)
//   result    the sign ring (gpu.readback.ring): MAX_SIGNS vec4f a slot
// Output per sign: (transmittance camera → anchor, element id or -1,
// temperature °C, air pressure). Transmittance is 0 as soon as an opaque
// voxel is in the way; liquids and glass attenuate it with the same
// Beer–Lambert extinction the renderer uses; gases and fire don't block.
// A walk of the state alone: the prelude, the materials' table accessors and
// core.js's DDA helpers, no lighting group (shaders/gfx/lib.js's bare probe).
export const SignParams = uniformStruct('SignParams', {
  cam: 'vec3f',    // the eye, grid cells
  count: 'i32',    // signs in signData
  slot: 'u32',     // the ring slot
});
const ro = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } });
export const SIGN_LAYOUT = [ro(0), ro(1), { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];

export const signProbeFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${materialsGLSL()}
${ddaGLSL(g)}
${brickInfoWGSL}
${SignParams.wgsl}
@group(3) @binding(1) var<uniform> P: SignParams;
const MAX_SIGNS: u32 = ${MAX_SIGNS}u;
@group(2) @binding(0) var<storage, read> brick: array<BrickInfo>;
@group(2) @binding(1) var<storage, read> signData: array<vec4f>;
@group(2) @binding(2) var<storage, read_write> result: array<vec4f>;

fn sightLine(ro: vec3f, toward: vec3f) -> f32 {
  let dv = toward - ro;
  let tEnd = length(dv);
  if (tEnd < 1e-3) { return 1.0; }
  let rd = safeDir(dv / tEnd);
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, 0.0);
  // stop just short of the face the sign sits on, so the attached voxel only
  // counts when the ray actually passes through it (camera behind the face)
  let t1 = min(bh.y, tEnd - 0.02);
  if (t1 <= t0) { return 1.0; }
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var tEnter = t0;
  var lastB = vec3i(-1);
  var occ = false;
  var tau = 0.0;
  for (var i = 0; i < MAX_STEPS; i++) {
    if (outside(cell) || tEnter >= t1) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) { lastB = bc; occ = brickMatter(brick[brickId(bc)].info); }
    if (!occ) { skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter); continue; }
    let ax = argmin3(tMax);
    let seg = min(tMax[ax], t1) - tEnter;
    let id = eid(fetchA(cell));
    if (id != E_EMPTY) {
      let rc = RCLASS(id);
      // ignore rays that only graze a voxel edge
      if (rc == R_OPAQUE && seg > 0.03) { return 0.0; }
      if (rc == R_LIQUID || rc == R_GLASS) { tau += dot(SIGMA(id), vec3f(1.0 / 3.0)) * seg; }
    }
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return exp(-tau);
}

@compute @workgroup_size(${MAX_SIGNS})
fn main(@builtin(local_invocation_index) i: u32) {
  var o = vec4f(1.0, -1.0, AMBIENT, 0.0);
  if (i32(i) < P.count) {
    let anchor = signData[i].xyz;
    let c = vec3i(floor(signData[MAX_SIGNS + i].xyz + 0.5));
    let tr = sightLine(P.cam, anchor);
    o = vec4f(tr, -1.0, AMBIENT, 0.0);
    if (!outside(c)) {
      let a = fetchA(c);
      o = vec4f(tr, f32(eid(a)), a.y, fetchB(c).w);
    }
  }
  result[P.slot * MAX_SIGNS + i] = o;
}
`;

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'signProbe', kind: 'compute', code: signProbeFrag, params: SignParams, warm: false,
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, SIGN_LAYOUT], dispatch: () => [1, 1, 1] },
];
