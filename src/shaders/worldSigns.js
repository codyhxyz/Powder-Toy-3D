// Finite native sign consumer. BOX's probe and its layout remain untouched.
import { uniformStruct } from '../gpu/params.js';
import { MAX_SIGNS } from './probe.js';
import { lib } from './gfx/lib.js';
import { shadowOpticsWGSL } from './gfx/shadowOptics.js';
import { presentationNearWGSL } from './gfx/presentation.js';
import { worldVolumeLayouts } from './worldRenderBackend.js';

export const WORLD_SIGN_STRIDE = 32; // live vec4, completeness vec4
export const WORLD_SIGNS_BYTES = MAX_SIGNS * WORLD_SIGN_STRIDE;
export const WorldSignsParams = uniformStruct('WorldSignsParams', {
  cam: 'vec3f', count: 'u32', slot: 'u32', k: 'f32', anchor: 'vec2f', dir: 'vec2f',
  anchors: ['vec4f', MAX_SIGNS], cells: ['vec4f', MAX_SIGNS],
});
export function worldSignsLayouts() {
  const a = worldVolumeLayouts({ pick: true, paramsSize: WorldSignsParams.size });
  a[3].find(e => e.binding === 6).buffer.minBindingSize = WORLD_SIGNS_BYTES;
  return a;
}
// Export the actual arithmetic separately for CPU execution with reader leaves.
export const worldSignsArithmetic = /* wgsl */ `
fn signOpacity(id: i32, seg: f32) -> f32 {
  let rc = RCLASS(id);
  if (id != E_EMPTY && rc == R_OPAQUE && seg > 0.03) { return -1.0; }
  if (rc == R_LIQUID || rc == R_GLASS) { return dot(SIGMA(id), vec3f(1.0 / 3.0)) * seg; }
  return 0.0;
}
fn signSight(ro: vec3f, toward: vec3f) -> f32 {
  let dv = toward - ro;
  let tEnd = length(dv);
  if (tEnd < 1e-3) { return 1.0; }
  let rd = safeDir(dv / tEnd);
  let bh = boxHit(ro, rd);
  let t0 = max(bh.x, 0.0);
  let t1 = min(bh.y, tEnd - 0.02);
  if (t1 <= t0) { return 1.0; }
  var istp: vec3i; var tDelta: vec3f; var cell: vec3i; var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var tEnter = t0;
  var lastB = vec3i(-1); var occ = false; var tau = 0.0;
  for (var i = 0; i < NX + NY + NZ + 8; i++) {
    if (outside(cell) || tEnter >= t1) { return exp(-tau); }
    let bc = cell / BS;
    if (any(bc != lastB)) { lastB = bc; occ = brickMatter(brickAt(bc).info); }
    if (!occ) { skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter); continue; }
    let ax = argmin3(tMax);
    let seg = min(tMax[ax], t1) - tEnter;
    let dt = signOpacity(eid(fetchA(cell)), seg);
    if (dt < 0.0) { return 0.0; }
    tau += dt;
    tEnter = tMax[ax]; cell[ax] += istp[ax]; tMax[ax] += tDelta[ax];
  }
  worldIncomplete = true;
  return 0.0;
}
fn signSightCurved(ro: vec3f, toward: vec3f) -> f32 {
  let dv = warpPoint(toward) - ro;
  let tEnd = length(dv);
  if (tEnd < 1e-3) { return 1.0; }
  let t1 = tEnd - 0.02;
  var w = warpWalk(ro, dv / tEnd, 0.0);
  var tau = 0.0;
  for (var i = 0; i < 65536; i++) {
    if (w.t >= t1) { return exp(-tau); }
    var cell: vec3i; var p: vec3f; var d: vec3f; var len: f32; var axis: i32;
    if (!warpSegment(&w, &cell, &p, &d, &len, &axis)) { return exp(-tau); }
    if (w.t >= t1) { return exp(-tau); }
    let bc = cell / BS;
    if (!brickMatter(brickAt(bc).info)) { warpSkip(&w, bc, false); continue; }
    // Clip the last chord at the same displayed endpoint convention as BOX.
    let end = min(w.end, t1);
    let seg = length(warpAt(w.ray, end) - p);
    let dt = signOpacity(eid(fetchA(cell)), seg);
    if (dt < 0.0) { return 0.0; }
    tau += dt; warpAdvance(&w);
  }
  worldIncomplete = true;
  return 0.0;
}
`;
export const worldSignsEntry = /* wgsl */ `
@compute @workgroup_size(${MAX_SIGNS})
fn main(@builtin(local_invocation_index) i: u32) {
  worldBeginQuery();
  warpUse(P.k, P.anchor, P.dir);
  var o = vec4f(1.0, -1.0, AMBIENT, 0.0);
  if (i < P.count) {
    let c = vec3i(floor(P.cells[i].xyz + 0.5));
    var tr: f32;
    if (P.k == 0.0) { tr = signSight(P.cam, P.anchors[i].xyz); }
    else { tr = signSightCurved(P.cam, P.anchors[i].xyz); }
    o = vec4f(tr, -1.0, AMBIENT, 0.0);
    if (!outside(c)) { let a = fetchA(c); o = vec4f(tr, f32(eid(a)), a.y, fetchB(c).w); }
  }
  worldEndQuery();
  let at = (P.slot * ${MAX_SIGNS}u + i) * 2u;
  signOut[at] = o;
  signOut[at + 1u] = vec4f(select(1.0, -1.0, worldQueryIncomplete()), 0.0, 0.0, 0.0);
}
`;
export const worldSignsWGSL = g => `${lib(g, { backend: 'world' })}
${shadowOpticsWGSL({ backend: 'world' })}
${presentationNearWGSL()}
${WorldSignsParams.wgsl}
@group(3) @binding(0) var<uniform> P: WorldSignsParams;
@group(3) @binding(6) var<storage, read_write> signOut: array<vec4f>;
${worldSignsArithmetic}
${worldSignsEntry}`;
