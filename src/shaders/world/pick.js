// The god view's pick over the whole map: the first non-gas cell along a ray through the world copy (W), in
// world cells. Physics' window pick (shaders/render.js pickFrag) sees only the window's 128 columns, so on a
// big map a click on what the far view draws found nothing, and a press there dragged on a plane near the
// world's floor (app.js requestPick). The world copy holds the whole map at cell detail, which the near march
// and the far summary both draw from, so this pick hits what the screen shows anywhere on the map.
// Touchstone: Minecraft's block outline reaches whatever you look at within reach, simulated or not.
//
// Same rays, ring and results as pickFrag (PickParams, PICK_LAYOUT: two vec4f a slot, (cell xyz, face) and
// (id, T, P, life)), flat rays only (gfx/worldView.js pick: a bent view's ray keeps the window's pick).
// Empty 4³ bricks are jumped (wcOccupied level 0), cells inside a brick with matter walked one by one.
// group 0 the tables, 1 the world copy (WORLD_COPY_LAYOUT), 2 the ring, 3 PickParams.
import { prelude, LAYOUT } from '../common.js';
import { ddaWalk } from '../dda.js';
import { PickParams, PICK_LAYOUT, PICK_BATCH } from '../render.js';
import { worldCopyWGSL, WORLD_COPY_LAYOUT } from './copy.js';

// Steps past the world's x + y + z cells a ray may take (brick jumps and the walk inside bricks).
const WORLD_PICK_SPARE_STEPS = 64;

export const worldPickFrag = (g) => {
  const dda = ddaWalk();
  const near = 'vec3i(NX, NY, NZ) - 1';
  if (!dda.includes(near)) throw new Error('world pick: shaders/dda.js ddaStart no longer clamps to the grid as expected');
  return /* wgsl */ `
${prelude(g, { state: false })}
${worldCopyWGSL()}
${dda.replace(near, 'WC.size - 1')}
${PickParams.wgsl}
@group(2) @binding(0) var<storage, read_write> picks: array<vec4f>;   // the ring: two per slot
@group(3) @binding(1) var<uniform> P: PickParams;
const PICK_FACE_FLOOR: i32 = 2;   // (render.js pickFrag's)
struct Pick {
  at: vec4f,     // (cell xyz, face); w = -1: a miss
  what: vec4f,   // (id, T, P, life)
}
fn worldBoxHit(ro: vec3f, rd: vec3f) -> vec3f {
  let t0 = (vec3f(0.0) - ro) / rd;
  let t1 = (vec3f(WC.size) - ro) / rd;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let n = max(max(tn.x, tn.y), tn.z);
  var axis = 2.0;
  if (tn.x >= tn.y && tn.x >= tn.z) { axis = 0.0; } else if (tn.y >= tn.z) { axis = 1.0; }
  return vec3f(n, min(min(tf.x, tf.y), tf.z), axis);
}
fn worldPickRay(ro: vec3f, rd0: vec3f, skipLiquids: bool) -> Pick {
  let rd = safeDir(normalize(rd0));
  let miss = Pick(vec4f(0.0, 0.0, 0.0, -1.0), vec4f(0.0, 0.0, 0.0, -1.0));
  let bh = worldBoxHit(ro, rd);
  let t0 = max(bh.x, 0.0);
  if (bh.y <= t0) { return miss; }
  var istp: vec3i;
  var tDelta: vec3f;
  var cell: vec3i;
  var tMax: vec3f;
  ddaStart(ro, rd, t0, &istp, &tDelta, &cell, &tMax);
  var ax = i32(bh.z);
  var tEnter = t0;
  let steps = WC.size.x + WC.size.y + WC.size.z + ${WORLD_PICK_SPARE_STEPS};
  for (var i = 0; i < steps; i++) {
    if (!wcInWorld(cell)) { break; }
    if (!wcOccupied(0u, cell)) {
      ax = skipBrick(cell >> vec3u(2u), ro, rd, istp, &cell, &tMax, &tEnter);
      continue;
    }
    let a = wcA(cell);
    let id = i32(floor(a.x + 0.5));
    if (!isGasLike(id) && (!skipLiquids || KIND(id) != K_LIQUID)) {
      let face = ax * 2 + select(0, 1, istp[ax] > 0);   // normal = -step
      return Pick(vec4f(vec3f(cell), f32(face)), vec4f(f32(id), a.y, 0.0, a.z));
    }
    ax = ddaStep(istp, tDelta, &cell, &tMax);
  }
  if (cell.y < 0 && rd.y < 0.0) {
    return Pick(vec4f(f32(cell.x), -1.0, f32(cell.z), f32(PICK_FACE_FLOOR)), vec4f(-1.0, 0.0, 0.0, 0.0));
  }
  return miss;
}
@compute @workgroup_size(${PICK_BATCH}) fn main(@builtin(local_invocation_index) i: u32) {
  if (i >= P.n) { return; }
  let r = worldPickRay(P.ro[i].xyz, P.rd[i].xyz, P.rd[i].w != 0.0);
  let s = P.slot[i / 4u][i % 4u] * 2u;
  picks[s] = r.at;
  picks[s + 1u] = r.what;
}
`;
};

export const WORLD_PICK_LAYOUTS = () => [LAYOUT.TABLES, WORLD_COPY_LAYOUT, PICK_LAYOUT];

export const WGSL_CHECK = () => [{
  name: 'worldPick', kind: 'compute', grids: ['128'], code: (g) => worldPickFrag(g),
  layouts: () => WORLD_PICK_LAYOUTS(), params: PickParams, dispatch: () => [1, 1, 1],
}];
