// Coarse sun-tile writer of the WORLD renderer (world/worldSunRings.js): a far
// tile's shadow from the scene's ground-twin heightfield instead of its CELL
// casters. Same texel ray as the full writer (worldSunWriter.js: from the
// tile's texel on the depth-zero plane toward the ground), same output (opaque
// depth, no translucent span, no tint), so every reader (the view's
// sunMapShadow, GI sources' sunShadowAt) reads it as it reads a full tile and
// no reader changes: the World view's module, its cold compile and its
// inlined copies (tools/check-world-volume-inlining.mjs) stay as they were.
// It reads no atlas page, so it can never be incomplete or ask for a brick.
import { WorldSunParams } from '../world/worldSun.js';
import { WORLD_SUN_COARSE_BIAS, WORLD_SUN_COARSE_STEP, WORLD_SUN_COARSE_NO_HIT, worldSunCoarseSteps } from '../world/worldSunRings.js';
import { worldSunWriterLayouts, WORLD_SUN_WORKGROUP } from './worldSunWriter.js';
import { BRICK } from './common.js';

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
// G0 the heightfield, G1 its shape; G2 and G3 are the full writer's (job and
// outputs, feedback), so a coarse job is recorded and decoded as a full one.
export function worldSunCoarseLayouts() {
  const [, , job, feedback] = worldSunWriterLayouts();
  return [
    [{ binding: 0, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 4 } }],
    [{ binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 16 } }],
    job, feedback,
  ];
}
export function worldSunCoarse(g) { return /* wgsl */ `
${WorldSunParams.wgsl}
struct WorldSunJob { tile: vec4i, control: vec4u }
// info: brick columns x and z, the highest column top (cells), unused
struct CoarseCasters { info: vec4f }
@group(0) @binding(0) var<storage, read> coarseTops: array<f32>;
@group(1) @binding(0) var<uniform> CC: CoarseCasters;
@group(2) @binding(0) var<uniform> WJ: WorldSunJob;
@group(2) @binding(1) var<uniform> WS: WorldSunParams;
@group(2) @binding(2) var sun0Out: texture_storage_2d_array<rgba32float,write>;
@group(2) @binding(3) var sun1Out: texture_storage_2d_array<r32float,write>;
@group(3) @binding(1) var<storage, read_write> worldRequests: array<atomic<u32>>;
const COARSE_BRICK: f32 = ${f(BRICK)};
const COARSE_BIAS: f32 = ${f(WORLD_SUN_COARSE_BIAS)};      // cells under the twin's surface (worldSunRings.js)
const COARSE_STEP: f32 = ${f(WORLD_SUN_COARSE_STEP)};      // cells along the ray between samples
const COARSE_STEPS: i32 = ${worldSunCoarseSteps([g.nx, g.ny, g.nz])};   // the world's diagonal in steps
const COARSE_NO_HIT: f32 = ${f(WORLD_SUN_COARSE_NO_HIT)};  // = shadowOptics.js SHADOW_NO_HIT
const COARSE_WORLD: vec2f = vec2f(${f(g.nx)}, ${f(g.nz)});
fn coarseColumn(c: vec2i) -> f32 {
  let n = vec2i(CC.info.xy);
  let k = clamp(c, vec2i(0), n - 1);
  return coarseTops[u32(k.x) + u32(n.x) * u32(k.y)];
}
// bilinear between brick-column centres, COARSE_BIAS under
fn coarseHeight(p: vec2f) -> f32 {
  let q = p / COARSE_BRICK - 0.5;
  let i = vec2i(floor(q));
  let w = q - floor(q);
  let a = mix(coarseColumn(i), coarseColumn(i + vec2i(1, 0)), w.x);
  let b = mix(coarseColumn(i + vec2i(0, 1)), coarseColumn(i + vec2i(1, 1)), w.x);
  return mix(a, b, w.y) - COARSE_BIAS;
}
// worldSunRings.js coarseSunDepth: the depth where the ray first goes under
// the surface, inside the slab the columns rise to; else the floor's, as the
// full writer's world walk ends (shadowOptics.js).
fn coarseTexel(ro: vec3f, rd: vec3f) -> f32 {
  let hi = vec3f(COARSE_WORLD.x, CC.info.z, COARSE_WORLD.y);
  var t0 = 0.0;
  var t1 = 1e30;
  for (var i = 0; i < 3; i++) {
    if (abs(rd[i]) < 1e-8) {
      if (ro[i] < 0.0 || ro[i] > hi[i]) { t1 = -1.0; }
    } else {
      let a = -ro[i] / rd[i];
      let b = (hi[i] - ro[i]) / rd[i];
      t0 = max(t0, min(a, b));
      t1 = min(t1, max(a, b));
    }
  }
  var hit = COARSE_NO_HIT;
  if (t0 < t1) {
    var tp = t0;
    let p0 = ro + rd * t0;
    var dp = p0.y - coarseHeight(p0.xz);
    if (dp <= 0.0) { hit = t0; }
    else {
      for (var k = 1; k <= COARSE_STEPS; k++) {
        let t = min(t0 + f32(k) * COARSE_STEP, t1);
        let p = ro + rd * t;
        let d = p.y - coarseHeight(p.xz);
        if (d <= 0.0) { hit = tp + (t - tp) * dp / (dp - d); break; }
        tp = t;
        dp = d;
        if (t >= t1) { break; }
      }
    }
  }
  if (hit == COARSE_NO_HIT && rd.y < 0.0 && ro.y >= 0.0) { hit = ro.y / -rd.y; }   // floor
  return hit;
}
// control: physicalSlot, explicit per-tile feedback word, epoch, reserved (as
// the full writer's). Status bit0: finished; bit1: a job of another epoch.
@compute @workgroup_size(${WORLD_SUN_WORKGROUP},${WORLD_SUN_WORKGROUP}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= vec2u(256u))) { return; }
  let u = vec3f(WS.worldToLight[0].x,WS.worldToLight[1].x,WS.worldToLight[2].x)*WS.depth.z;
  let v = vec3f(WS.worldToLight[0].y,WS.worldToLight[1].y,WS.worldToLight[2].y)*WS.depth.z;
  let sun = -vec3f(WS.worldToLight[0].z,WS.worldToLight[1].z,WS.worldToLight[2].z);
  let pixel = WJ.tile.xy*256 + vec2i(gid.xy);
  let xy = (vec2f(pixel)+0.5)*WS.depth.z;
  let ro = u*xy.x + v*xy.y + sun*WS.depth.x;
  let current = WJ.control.z == WS.version.x;
  atomicOr(&worldRequests[WJ.control.y], select(3u, 1u, current));
  if (!current) { return; }
  let t = coarseTexel(ro, -sun);
  let slot = WJ.control.x;
  let dst = vec2i(i32(slot%8u)*256,i32((slot/8u)%8u)*256)+vec2i(gid.xy);
  textureStore(sun0Out,dst,i32(slot/64u),vec4f(t,COARSE_NO_HIT,COARSE_NO_HIT,0.0));
  textureStore(sun1Out,dst,i32(slot/64u),vec4f(t,0.0,0.0,0.0));
}`; }
export const WGSL_CHECK = () => [[1024, 128, 1024], [2560, 320, 2560], [3072, 384, 1024]].map(([nx, ny, nz]) => ({
  name: `worldSun.coarse.${nx}x${ny}x${nz}`, kind: 'compute', grids: false, warm: false,
  code: () => worldSunCoarse({ nx, ny, nz }), layouts: worldSunCoarseLayouts, workgroupSize: [8, 8, 1], dispatch: () => [32, 32, 1],
}));
