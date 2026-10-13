import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims } from './common.js';
import { frameBindings, RENDER_LAYOUT } from './bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { raysGLSL, RAYS } from '../rays.js';

// The fast-particle kernels (docs/particles.md, docs/webgpu.md G3; src/raysLayer.js
// runs them). Particles live in a list of RN = RAY_TEX² slots, one Particle
// (64 bytes) each, the WebGL build's four RGBA32F attachments as four vec4f:
//   l0  position (grid cells, continuous), kind (rays.js RAY_KIND; 0 = free)
//   l1  velocity (cells/step), life (steps left)
//   l2  photon: its energy share per RGB channel; neutron: x = energy (MeV).
//       w = the extra children it asks for this step (advance → spawn)
//   l3  this step's deposit: its cell's slot (−1 = none), heat, pressure;
//       w = the sweep it last saw an emitter in (spawn)
// A step (raysLayer.js step) is four dispatches, every one a thread per slot:
//   advance  each particle flies, interacts, asks for children; in place
//            (a thread reads and writes its own slot). It also clears the
//            brick bitset the deposit kernel fills
//   spawn    free slots take children and spontaneous neutrons, in place: a
//            free slot reads only its parents' kind and l2.w, and every free
//            slot holds l2.w = 0 after advance, so a parent that is itself a
//            free slot becoming a child in this dispatch reads as no parent
//            before its write and after it (a torn read too): the result
//            doesn't depend on the threads' order. Live slots aren't written
//            (their l2.w stays until the next advance zeroes it)
//   deposit  adds each slot's deposit into its cell (fixed-point atomicAdd,
//            physics.js RAY_DEPOSIT_SCALE; react.js reads it), marks the
//            bricks holding a particle (an atomicOr bitset the activity
//            build's quiet kernel reads), and appends every live slot to the
//            draw list with the counts: the sprites are drawn with
//            drawIndirect, so a near-empty list costs nothing
//   settle   after react: zeroes the deposits it added (the WebGL build's
//            re-draw of the same points with zeros), so the buffer is empty
//            between steps without clearing it
// The paint kernel puts painted particles in free slots of the next stretch
// of the list, in place; the deposit kernel without its deposits (P.deposit
// = 0) then lists them for the sprites. The counts (live particles, slots
// that saw an emitter this sweep) come in two sets that alternate: each
// compaction fills one and zeroes the other, so a dispatch needs no clear
// before it; the CPU reads a set back once a sweep (raysLayer.js count).

const RN = RAYS.RAY_TEX * RAYS.RAY_TEX;   // slots

// group 2 of every particle kernel (docs/webgpu.md C4): with the tables and
// the state read-only (LAYOUT.STATE_RO), 8 storage buffers
const rw = (binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } });
export const RAYS_LAYOUT = [rw(0), rw(1), rw(2), rw(3), rw(4)];
// The counts' layout: two sets of COUNT_WORDS u32, each the sprites'
// drawIndirect arguments (vertexCount, instanceCount, firstVertex,
// firstInstance) then the slots that saw an emitter.
export const COUNT_WORDS = 8;
export const COUNT = { VERTICES: 0, LIVE: 1, SEEN: 4 };
export const QUAD_VERTICES = 6;   // a particle's quad: two triangles

export const AdvanceParams = uniformStruct('AdvanceParams', { frame: 'u32' });
export const SpawnParams = uniformStruct('SpawnParams', {
  frame: 'u32',
  stride: 'i32',   // odd: the children's slot bijections
  phase: 'i32',    // the stripe's position: frame % cycle
  cycle: 'f32',    // steps to sweep the slots: a cell's emission probability is scaled by it
  stamp: 'f32',    // this sweep's number (l3.w of a free slot that saw an emitter)
});
export const RayPaintParams = uniformStruct('RayPaintParams', {
  center: 'vec3f', radius: 'f32',
  frame: 'u32',
  cursor: 'i32',   // the stretch's first slot, [0, RN)
  count: 'i32',    // its length
  kind: 'i32',     // rays.js RAY_KIND
  shape: 'i32',    // 0 sphere, 1 cube (passes.js paintUpdateWGSL)
});
export const DepositParams = uniformStruct('DepositParams', {
  stamp: 'f32',     // this sweep's number: the slots that saw an emitter in it are counted
  countSet: 'u32',  // the counts' set this compaction fills (the other is zeroed)
  deposit: 'u32',   // a step's: deposits and bricks too; 0 lists only (after paint)
});

const listGLSL = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${raysGLSL()}
const RTEX: i32 = ${RAYS.RAY_TEX};
const RN: i32 = ${RN};                // slots
const RSUB: i32 = ${RAYS.RAY_SUBSTEPS};
const RCHILD: i32 = ${RAYS.RAY_CHILDREN};
const BRICK_WORDS: u32 = ${Math.ceil(gridDims(g).nbricks / 32)}u;   // the brick bitset
const COUNT_WORDS: u32 = ${COUNT_WORDS}u;
const COUNT_LIVE: u32 = ${COUNT.LIVE}u;
const COUNT_SEEN: u32 = ${COUNT.SEEN}u;
const THIRD: f32 = 1.0 / 3.0;
const GRID_INSET: f32 = 0.001;        // keeps a painted particle's position inside the grid's last cell
struct Particle { l0: vec4f, l1: vec4f, l2: vec4f, l3: vec4f }
@group(2) @binding(0) var<storage, read_write> list: array<Particle>;
@group(2) @binding(1) var<storage, read_write> deposit: array<atomic<i32>>;   // per slot: heat, pressure (fixed point)
@group(2) @binding(2) var<storage, read_write> bricks: array<atomic<u32>>;    // a bit per brick holding a particle
@group(2) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;    // two sets of COUNT_WORDS
@group(2) @binding(4) var<storage, read_write> live: array<u32>;              // the live slots, for the sprites
fn kindOf(l0: vec4f) -> i32 { return i32(floor(l0.w + 0.5)); }
// The element a neutron sees in a cell: molten metal keeps what it melted from (its ctype).
fn matOf(a: vec4f) -> i32 {
  let id = eid(a);
  if (id == E_LAVA) {
    let ct = i32(floor(a.w));
    if (ct > 0 && ct < NE) { return ct; }
  }
  return id;
}
fn randDir(rs: ptr<function, u32>) -> vec3f {   // uniform on the sphere
  let z = 2.0 * rnd(rs) - 1.0;
  let d = randDir2(rs);
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * d.x, r * d.y, z);
}
// rays.js fastShare and neutronSpeed
fn fastShare(E: f32) -> f32 { return clamp(log(E / NEUT_E_THERMAL) / log(NEUT_E_FAST / NEUT_E_THERMAL), 0.0, 1.0); }
fn neutSpeed(E: f32) -> f32 { return clamp(NEUT_V * sqrt(E / NEUT_E_FAST), NEUT_V_THERMAL, RAY_V_MAX); }
fn maxOf(v: vec3f) -> f32 { return max(v.x, max(v.y, v.z)); }
`;

// a thread per slot (a folded dispatch of RN / 64 workgroups)
const slotMain = /* wgsl */ `@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = foldThread(wg, nwg, li);`;

// Advance, in place. Reads the state (fetchA).
export const raysAdvanceFrag = (g) => /* wgsl */ `
${listGLSL(g)}
${AdvanceParams.wgsl}
@group(3) @binding(1) var<uniform> P: AdvanceParams;
${slotMain}
  if (t < BRICK_WORDS) { atomicStore(&bricks[t], 0u); }   // (the deposit kernel marks them again)
  if (t >= u32(RN)) { return; }
  let j = i32(t);
  let l0 = list[t].l0;
  let l1 = list[t].l1;
  var l2 = list[t].l2;
  let l3 = list[t].l3;
  var kind = kindOf(l0);
  if (kind == RAY_NONE) {
    // no deposit, no children (the stamp carries on): free slots usually hold that already
    if (l2.w != 0.0 || any(l3.xyz != vec3f(-1.0, 0.0, 0.0))) {
      list[t].l2 = vec4f(l2.xyz, 0.0);
      list[t].l3 = vec4f(-1.0, 0.0, 0.0, l3.w);
    }
    return;
  }
  var rs = seedSlot(u32(j), P.frame, SALT_RAY);
  var pos = l0.xyz;
  var v = l1.xyz;
  var life = l1.w - 1.0;
  var alive = life > 0.0;
  var heat = 0.0;
  var pres = 0.0;
  var dep = -1.0;
  var extra = 0;
  for (var s = 0; s < RSUB; s++) {
    if (!alive) { break; }
    let np = pos + v / RAY_SUBSTEPS;
    let c = vec3i(floor(np));
    if (!inGrid(c)) { alive = false; break; }   // out of the box
    let a = fetchA(c);
    let id = eid(a);
    let len = length(v) / RAY_SUBSTEPS;
    if (kind == RAY_PHOTON) {
      let e = l2.rgb;
      if (RCLASS(id) != R_OPAQUE) {
        // clear matter: Beer-Lambert with the renderer's extinction, the loss as heat
        let left = e * exp(-SIGMA(id) * len);
        if (any(left != e)) { heat += dot(e - left, vec3f(THIRD)) * PHOTON_HEAT; dep = f32(slotOf(c)); }
        l2 = vec4f(left, l2.w);
        pos = np;
        if (maxOf(left) < PHOTON_E_MIN) { heat += dot(left, vec3f(THIRD)) * PHOTON_HEAT; dep = f32(slotOf(c)); alive = false; }
        continue;
      }
      dep = f32(slotOf(c));
      let r = REFLECT(id);
      if (r <= 0.0) { heat += dot(e, vec3f(THIRD)) * PHOTON_HEAT; alive = false; break; }
      // a metal: reflect off the faces crossed into it (the blocked ones of
      // the axis steps from the cell it's in), keep that share, the rest is heat
      let pc = vec3i(floor(pos));
      let d = c - pc;
      var flip = vec3<bool>(false);
      for (var i = 0; i < 3; i++) {
        if (d[i] == 0) { continue; }
        var q = pc;
        q[i] += d[i];
        flip[i] = !inGrid(q) || RCLASS(eid(fetchA(q))) == R_OPAQUE;
      }
      if (!any(flip)) { flip = d != vec3i(0); }   // a corner: back the way it came
      v = select(v, -v, flip);
      heat += dot(e, vec3f(THIRD)) * (1.0 - r) * PHOTON_HEAT;
      l2 = vec4f(e * r, l2.w);
      if (maxOf(l2.rgb) < PHOTON_E_MIN) { heat += dot(l2.rgb, vec3f(THIRD)) * PHOTON_HEAT; alive = false; }
      break;   // one interaction a step
    }
    // a neutron: transport through the cell's material (rays.js crossSections)
    pos = np;
    let n = nuclearOf(matOf(a));
    var E = l2.x;
    let w = fastShare(E);
    let ov = sqrt(NEUT_E_THERMAL / E);
    let ss = mix(n.sT, n.sF, w);
    let sa = max(n.aF, n.aT * ov);
    let sf = max(n.fF, n.fT * ov);
    let st = ss + sa + sf;
    if (st <= 0.0 || rnd(&rs) >= 1.0 - exp(-st * len)) { continue; }
    dep = f32(slotOf(c));
    let u = rnd(&rs) * st;
    if (u < sf) {
      // fission: this slot flies on as one of the ν new fast neutrons, the
      // spawn kernel starts the rest (2 plus a coin weighted ν − 2 in all)
      let nu = mix(n.nuT, n.nuF, w);
      var coin = 0;
      if (rnd(&rs) < fract(nu)) { coin = 1; }
      extra = clamp(i32(nu) - 1 + coin, 0, RCHILD);
      heat += FISSION_HEAT;
      pres += FISSION_P;
      E = NEUT_E_FAST;
      v = randDir(&rs) * neutSpeed(E);
      life = NEUT_LIFE;
    } else if (u < sf + sa) {
      heat += CAPTURE_HEAT;   // captured: its gamma rays heat the cell
      alive = false;
    } else {
      // isotropic scatter: off hydrogen it keeps a uniform share of its
      // energy; off a nucleus of mass A, at least α = ((A − 1)/(A + 1))²
      let x = rnd(&rs);
      if (rnd(&rs) < n.hShare) {
        E *= x;
      } else {
        var al = (n.mass - 1.0) / (n.mass + 1.0);
        al *= al;
        E *= al + (1.0 - al) * x;
      }
      E = max(E, NEUT_E_THERMAL);
      v = randDir(&rs) * neutSpeed(E);
    }
    l2.x = E;
    break;   // one interaction a step
  }
  if (!alive) { kind = RAY_NONE; }
  list[t] = Particle(vec4f(pos, f32(kind)), vec4f(v, life), vec4f(l2.xyz, f32(extra)), vec4f(dep, heat, pres, l3.w));
}
`;

// Spawn, in place on the free slots (see the top). A free slot j takes child
// k of slot (j − k·stride) mod RN if that one asked for k or more, else, on
// the stripe (docs/particles.md), the spontaneous fission of the cell at
// slot j + RN·phase. Reads the state (fetchA).
export const raysSpawnFrag = (g) => /* wgsl */ `
${listGLSL(g)}
${SpawnParams.wgsl}
@group(3) @binding(1) var<uniform> P: SpawnParams;
${slotMain}
  if (t >= u32(RN)) { return; }
  let j = i32(t);
  if (kindOf(list[t].l0) != RAY_NONE) { return; }
  let l3 = list[t].l3;
  var rs = seedSlot(u32(j), P.frame, SALT_RAY_SPAWN);
  for (var k = 1; k <= RCHILD; k++) {
    let pj = u32((j + k * (RN - P.stride)) % RN);   // (stride in [1, RN): no negative %)
    let p0 = list[pj].l0;
    if (kindOf(p0) == RAY_NONE || list[pj].l2.w < f32(k)) { continue; }
    // a fission neutron, from where its parent split
    let v = randDir(&rs) * neutSpeed(NEUT_E_FAST);
    list[t] = Particle(vec4f(p0.xyz, f32(RAY_NEUTRON)), vec4f(v, NEUT_LIFE), vec4f(NEUT_E_FAST, 0.0, 0.0, 0.0), l3);
    return;
  }
  let s = j + RN * P.phase;
  if (s >= i32(SLOTS)) { return; }
  let c = cellOf(u32(s));
  let rate = SF_RATE(matOf(fetchA(c)));
  if (rate <= 0.0) { return; }
  if (rnd(&rs) >= rate * P.cycle) {
    list[t].l3 = vec4f(l3.xyz, P.stamp);   // it saw an emitter this sweep
    return;
  }
  let at = vec3f(c) + vec3f(rnd(&rs), rnd(&rs), rnd(&rs));
  let v = randDir(&rs) * neutSpeed(NEUT_E_FAST);
  list[t] = Particle(vec4f(at, f32(RAY_NEUTRON)), vec4f(v, NEUT_LIFE), vec4f(NEUT_E_FAST, 0.0, 0.0, 0.0), vec4f(l3.xyz, P.stamp));
}
`;

// Paint particles, in place: free slots in [cursor, cursor + count) take a
// new particle of P.kind somewhere in the brush, flying in a random direction.
// A thread per slot of the stretch.
export const raysPaintFrag = (g) => /* wgsl */ `
${listGLSL(g)}
${RayPaintParams.wgsl}
@group(3) @binding(1) var<uniform> P: RayPaintParams;
${slotMain}
  if (t >= u32(P.count)) { return; }
  let j = (P.cursor + i32(t)) % RN;
  let s = u32(j);
  if (kindOf(list[s].l0) != RAY_NONE) { return; }
  var rs = seedSlot(u32(j), P.frame, SALT_RAY_PAINT);
  var d: vec3f;
  if (P.shape == 0) {
    d = randDir(&rs) * P.radius * pow(rnd(&rs), THIRD);
  } else {
    d = (vec3f(rnd(&rs), rnd(&rs), rnd(&rs)) * 2.0 - 1.0) * P.radius;
  }
  let p = clamp(P.center + d, vec3f(0.0), vec3f(f32(NX), f32(NY), f32(NZ)) - GRID_INSET);
  let photon = P.kind == RAY_PHOTON;
  var speed = neutSpeed(NEUT_E_FAST);
  var life = NEUT_LIFE;
  var l2 = vec4f(NEUT_E_FAST, 0.0, 0.0, 0.0);
  if (photon) {
    speed = min(PHOTON_V, RAY_V_MAX);
    life = PHOTON_LIFE;
    l2 = vec4f(1.0, 1.0, 1.0, 0.0);
  }
  list[s] = Particle(vec4f(p, f32(P.kind)), vec4f(randDir(&rs) * speed, life), l2, vec4f(-1.0, 0.0, 0.0, list[s].l3.w));
}
`;

// Deposit, bricks and the draw list (see the top). With P.deposit = 0 (after
// paint) only the draw list and the counts.
export const raysDepositFrag = (g) => /* wgsl */ `
${listGLSL(g)}
${DepositParams.wgsl}
@group(3) @binding(1) var<uniform> P: DepositParams;
${slotMain}
  if (t == 0u) {   // the other set starts over for the next compaction
    let o = (1u - P.countSet) * COUNT_WORDS;
    atomicStore(&counts[o + COUNT_LIVE], 0u);
    atomicStore(&counts[o + COUNT_SEEN], 0u);
  }
  if (t >= u32(RN)) { return; }
  let r = list[t];
  let base = P.countSet * COUNT_WORDS;
  if (P.deposit != 0u && r.l3.x >= 0.0) {
    let s = 2u * u32(r.l3.x);
    let heat = i32(floor(r.l3.y * RAY_DEPOSIT_SCALE + 0.5));
    let pres = i32(floor(r.l3.z * RAY_DEPOSIT_SCALE + 0.5));
    if (heat != 0) { atomicAdd(&deposit[s], heat); }
    if (pres != 0) { atomicAdd(&deposit[s + 1u], pres); }
  }
  if (r.l3.w == P.stamp) { atomicAdd(&counts[base + COUNT_SEEN], 1u); }
  if (kindOf(r.l0) == RAY_NONE) { return; }
  if (P.deposit != 0u) {
    let c = clamp(vec3i(floor(r.l0.xyz)), vec3i(0), vec3i(NX, NY, NZ) - 1);
    let b = brickId(c >> vec3u(2u));
    atomicOr(&bricks[b >> 5u], 1u << (b & 31u));
  }
  live[atomicAdd(&counts[base + COUNT_LIVE], 1u)] = t;
}
`;

// Settle, after react: the deposits this step added, zeroed.
export const raysSettleFrag = (g) => /* wgsl */ `
${listGLSL(g)}
${slotMain}
  if (t >= u32(RN)) { return; }
  let d = list[t].l3.x;
  if (d < 0.0) { return; }
  let s = 2u * u32(d);
  atomicStore(&deposit[s], 0);
  atomicStore(&deposit[s + 1u], 0);
}
`;

// ---- drawing them (the scene pass after the volume: src/wire/rays.js) ----
// Photons in their colour, neutrons a faint cyan, fast ones brighter. Each
// live particle is an instanced quad in the volume's space (FrameUniforms'
// model: grid cells → scene), drawIndirect over the draw list: a point
// RAY_POINT_CELLS across, at least POINT_MIN_PX and at most POINT_MAX_PX on
// screen, a round sprite, added to the scene (depth-tested, not written).
export const RAY_LOOK = {
  POINT_CELLS: 0.7,        // a point's diameter, cells
  POINT_MIN_PX: 1.5,       // ...and its limits on screen, px
  POINT_MAX_PX: 24,
  PHOTON_GLOW: 2.5,        // brightness of a white photon (additive, linear)
  NEUT_GLOW: 0.5,          // ...of a fast neutron; a thermal one is NEUT_THERMAL_GLOW of that
  NEUT_THERMAL_GLOW: 0.4,
  NEUT_COLOR: [0.015, 0.75, 1.0],   // TPT NEUT's #20E0FF, linear
};
export const RayDrawParams = uniformStruct('RayDrawParams', {
  pointPx: 'f32',      // px per (cell · 1/view distance): the projection's scale
  viewport: 'vec2f',   // the scene target, px
});
const lookWGSL = Object.entries(RAY_LOOK).map(([k, v]) => (Array.isArray(v)
  ? `const RAY_${k}: vec3f = vec3f(${v.map((x) => x.toFixed(3)).join(', ')});`
  : `const RAY_${k}: f32 = ${v.toFixed(3)};`)).join('\n');
// the draw list's group 1 (the vertex stage reads it)
export const RAYS_DRAW_LAYOUT = [
  { binding: 0, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } },
];
export const raysDrawWGSL = () => /* wgsl */ `
${frameBindings()}
${raysGLSL().split('\n').filter((l) => /^const (RAY_|NEUT_E)/.test(l)).join('\n')}
${lookWGSL}
${RayDrawParams.wgsl}
@group(3) @binding(1) var<uniform> P: RayDrawParams;
const VIEW_Z_MIN: f32 = 1e-3;   // view depth floor for the point size (world units)
struct Particle { l0: vec4f, l1: vec4f, l2: vec4f, l3: vec4f }
@group(1) @binding(0) var<storage, read> list: array<Particle>;
@group(1) @binding(1) var<storage, read> live: array<u32>;
struct RayOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,    // the sprite's corner, −1..1 (the GL point's coordinate)
  @location(1) color: vec3f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RayOut {
  // two triangles: corners 0 1 2, then 2 1 3
  var k = vi;
  if (vi == 3u) { k = 2u; } else if (vi == 4u) { k = 1u; } else if (vi == 5u) { k = 3u; }
  let uv = vec2f(f32(k & 1u), f32(k >> 1u)) * 2.0 - 1.0;
  let r = list[live[ii]];
  var o: RayOut;
  o.uv = uv;
  let kind = i32(floor(r.l0.w + 0.5));
  if (kind == RAY_NONE) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); o.color = vec3f(0.0); return o; }
  let clip = FU.viewProj * FU.model * vec4f(r.l0.xyz, 1.0);
  let size = clamp(P.pointPx * RAY_POINT_CELLS / max(clip.w, VIEW_Z_MIN), RAY_POINT_MIN_PX, RAY_POINT_MAX_PX);
  o.position = clip + vec4f(uv * size / P.viewport * clip.w, 0.0, 0.0);
  let fast = clamp(log(r.l2.x / NEUT_E_THERMAL) / log(NEUT_E_FAST / NEUT_E_THERMAL), 0.0, 1.0);
  if (kind == RAY_PHOTON) {
    o.color = r.l2.rgb * RAY_PHOTON_GLOW;
  } else {
    o.color = RAY_NEUT_COLOR * RAY_NEUT_GLOW * mix(RAY_NEUT_THERMAL_GLOW, 1.0, fast);
  }
  return o;
}
@fragment fn fs(v: RayOut) -> @location(0) vec4f {
  let r2 = dot(v.uv, v.uv);
  if (r2 > 1.0) { discard; }
  let k = 1.0 - r2;
  return vec4f(v.color * k * k, 1.0);
}
`;
// three's AdditiveBlending (source alpha, one): the sprite adds its light
const ADD = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'src-alpha', dstFactor: 'one' } };
/** The sprites' render pipeline (gpu.renderPipeline and WGSL_CHECK take the same). */
export const raysDrawPipeline = () => ({
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: 'rgba16float', blend: ADD }] },
  primitive: { topology: 'triangle-list' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less-equal' },
});

// The kernels, by name: [WGSL generator, params struct].
export const RAYS_KERNELS = {
  raysAdvance: [raysAdvanceFrag, AdvanceParams],
  raysSpawn: [raysSpawnFrag, SpawnParams],
  raysPaint: [raysPaintFrag, RayPaintParams],
  raysDeposit: [raysDepositFrag, DepositParams],
  raysSettle: [raysSettleFrag, null],
};
/** A thread per slot. */
export const raysDispatch = () => fold(RN / 64);

/** tools/check-wgsl.mjs (docs/webgpu.md I1); the kernels build when a layer wakes (raysLayer.js), not at warm-up. */
export const WGSL_CHECK = [
  ...Object.entries(RAYS_KERNELS).map(([name, [code, params]]) => ({
    name, kind: 'compute', code, params, warm: false,
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, RAYS_LAYOUT], dispatch: raysDispatch,
  })),
  {
    name: 'raysDraw', kind: 'render', grids: false, code: raysDrawWGSL, params: RayDrawParams, warm: false,
    layouts: () => [RENDER_LAYOUT.FRAME, RAYS_DRAW_LAYOUT], layoutNames: ['FRAME'], ...raysDrawPipeline(),
  },
];
