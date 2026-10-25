// The beam pre-pass (Laine & Karras 2010, "Efficient Sparse Voxel Octrees", NVIDIA TR, §6.2 "beam
// optimization": "render a coarse, conservative distance image and then use it to adjust the starting
// positions of individual rays"; they report 35–49 % fewer iterations a ray). research/voxel-traversal/
// KNOWLEDGE.md, "What we missed" 3.
//
// The split march's first stage ('world beam', shaders/world/march.js MARCH_STAGES): one fragment a tile of
// BEAM_TILE × BEAM_TILE pixels, into T (r32float, the G-buffer's tile-sized texture). It walks the cone of
// every ray through the tile (the four corners' rays through P.meshInv, the march's own jittered camera,
// widened by BEAM_PAD pixels) through W's occupancy, the 64³ and 16³ nodes and the 4³ bricks, and writes the
// distance up to which the cone meets no brick with matter. Conservative, not a guess: every brick a step
// passes is inside the box of the cone's piece it tested, and every node of that box was empty; it stops at
// the first box it can't prove empty (or after BEAM_STEPS steps), so for every ray of the tile every brick
// before that distance is empty. Recomputed every frame (no reuse: the camera, its jitter and the world
// change), and it ignores the window, the mesh cut and the near clip, which only shorten a pixel's ray.
//
// The lean march (stage 'march') then starts each pixel's ray there, the way its own walk would have got
// there (beamStartWGSL): it takes the empty node holding the ray's point at its tile's distance, the node
// skipEmpty would have jumped, and enters it where the ray enters it, the t the walk's previous jump left
// it at. From there the walk is the one it was (the jump, its landing cell and every hit after it are
// computed from the node's faces, the ray and the cell alone), with fewer trips of the count: the same
// picture. A point in a brick with matter (never, but for round-off) or outside the world keeps the
// ray's own start.

/** Pixels a side of a beam tile (L&K: "4×4 or 8×8 pixel blocks"). Measured 2026-10-25 (Lab default, M5): 4×4
 *  and 8×8 cut the march's loop trips alike (11.7 → 6.3 and 6.4 a pixel), but the 4×4 pass cost 0.34 ms on
 *  the Lab and 1.0 ms on the Island against 0.24 and 0.39 ms, which ate the gain. */
export const BEAM_TILE = 8;
// Pixels the tile's cone is widened by on each side: the march's rays are its fragment's interpolated
// far point, the beam's the corners' own, a few float steps apart (half a pixel already lies between a
// tile's edge and its last pixel centre)
const BEAM_PAD = 0.5;
// Steps a tile's walk takes at most (any stop is safe: it only gives less of a head start)
export const BEAM_STEPS = 64;
// Cells added to the cone's radius: the per-pixel walk's round-off (its floor() of a point, safeDir's nudge
// of an axis-parallel ray, the jump's never-backwards clamp) stays far inside this
export const BEAM_MARGIN = 0.02;
// The cone's slope widened by this share and at least BEAM_SLOPE_MIN (its corners' float round-off)
const BEAM_SLOPE_PAD = 1e-3;
const BEAM_SLOPE_MIN = 2e-5;
/** T's value where the cone never meets the world, or meets only empty space in it. */
export const BEAM_FAR = 1e30;
// A pixel's head start stays this far (a share of the exit's t, at least a cell's) inside the end of its
// span (the world's or the window's exit), so the point it starts from is inside the world
const BEAM_END_GAP = 1e-3;

/**
 * The beam stage's WGSL (after the prelude, frameBindings, W's readers and MarchParams as P): a full-screen
 * triangle into T, `fs` writing a tile's safe distance. The walk itself (beamMarch) reads only W's
 * wcOccupied and WC.size, so tools/beam-cpu-check.mjs runs it on a fixture world.
 */
export const beamMarchWGSL = /* wgsl */ `
// ---- the beam pre-pass (shaders/world/beam.js) ----
const BEAM_TILE: u32 = ${BEAM_TILE}u;
const BEAM_PAD: f32 = ${BEAM_PAD};
const BEAM_STEPS: i32 = ${BEAM_STEPS};
const BEAM_MARGIN: f32 = ${BEAM_MARGIN};
const BEAM_SLOPE_PAD: f32 = ${BEAM_SLOPE_PAD};
const BEAM_SLOPE_MIN: f32 = ${BEAM_SLOPE_MIN};
const BEAM_FAR: f32 = ${BEAM_FAR.toExponential()};
const BEAM_BRICK: i32 = 4;   // cells a side of W's level 0 (a brick); level l's node is BEAM_BRICK << 2l
const BEAM_TOP: i32 = 2;     // W's coarsest occupancy level (the 64³ node)
// The u range (along the cone's axis) in which the cone's extent on one axis, p + dv u ± (k u + BEAM_MARGIN),
// meets [0, size]: (first, last); first > last: never. Bounds, not the exact range: outside it the cone
// misses the world's slab on this axis.
fn beamAxis(p: f32, dv: f32, k: f32, size: f32) -> vec2f {
  var r = vec2f(0.0, BEAM_FAR);
  let hs = dv + k;   // the extent's high edge's slope ...
  let ls = dv - k;   // ... and its low edge's
  let h0 = p + BEAM_MARGIN;
  let l0 = p - BEAM_MARGIN;
  if (h0 < 0.0) {
    r.x = select(BEAM_FAR, -h0 / hs, hs > 0.0);
  } else if (hs < 0.0) {
    r.y = h0 / -hs;
  }
  if (l0 > size) {
    r.x = max(r.x, select(BEAM_FAR, (l0 - size) / -ls, ls < 0.0));
  } else if (ls > 0.0) {
    r.y = min(r.y, (size - l0) / ls);
  }
  return r;
}
// Whether every node of level l from lo to hi (node coordinates, at most 2 a side) is empty (W's occupancy:
// no brick with matter; outside the world, empty)
fn beamEmpty(l: u32, lo: vec3i, hi: vec3i, n: i32) -> bool {
  var occ = false;
  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        occ = occ | wcOccupied(l, vec3i(x, y, z) * n);
      }
    }
  }
  return !occ;
}
// The farthest u'' at which the cone's piece from u (its axis point c0) to u'' is still inside the box
// [bmin, bmax]: each face's bound (the far faces against the axis's lead edge, the near ones against the
// edge growing back from c0), k > 0
fn beamExit(cam: vec3f, c0: vec3f, dc: vec3f, k: f32, bmin: vec3f, bmax: vec3f) -> f32 {
  let pos = dc >= vec3f(0.0);
  let hiU = select((bmax - BEAM_MARGIN - c0) / k, (bmax - BEAM_MARGIN - cam) / (dc + k), pos);
  let loU = select((cam - BEAM_MARGIN - bmin) / (k - dc), (c0 - BEAM_MARGIN - bmin) / k, pos);
  let t = min(hiU, loU);
  return min(t.x, min(t.y, t.z));
}
// The cone from cam along unit dc with slope k (radius k u + BEAM_MARGIN at u along the axis): the u up to
// which it meets no brick with matter, BEAM_FAR if it never does. A ray inside the cone at its own t has
// come u = t cos(angle) <= t along the axis, so the same u is a safe t for it. Each step tries the
// coarsest level first (one above the last that worked): the box of the cone's piece from u to half a
// node on, its nodes (2 a side at most) all empty, then jumps to where the cone leaves their box.
fn beamMarch(cam: vec3f, dc: vec3f, k: f32) -> f32 {
  let size = vec3f(WC.size);
  let ax = beamAxis(cam.x, dc.x, k, size.x);
  let ay = beamAxis(cam.y, dc.y, k, size.y);
  let az = beamAxis(cam.z, dc.z, k, size.z);
  var u = max(ax.x, max(ay.x, az.x));
  let uOut = min(ax.y, min(ay.y, az.y));
  var top = BEAM_TOP;
  var done = u >= uOut;
  var it = 0;
  loop {
    if (done || it >= BEAM_STEPS) { break; }
    it++;
    var moved = false;
    var l = top;
    loop {
      let n = BEAM_BRICK << (2u * u32(l));
      let nf = f32(n);
      let u1 = u + 0.5 * nf;
      let r = k * u1 + BEAM_MARGIN;
      let c0 = cam + dc * u;
      let c1 = cam + dc * u1;
      let lo = vec3i(floor((min(c0, c1) - r) / nf));
      let hi = vec3i(floor((max(c0, c1) + r) / nf));
      if (all(hi - lo <= vec3i(1))) {
        if (beamEmpty(u32(l), lo, hi, n)) {
          u = max(u1, beamExit(cam, c0, dc, k, vec3f(lo) * nf, vec3f(hi + 1) * nf));
          top = min(l + 1, BEAM_TOP);
          moved = true;
          break;
        }
      }
      if (l == 0) { break; }
      l--;
    }
    if (!moved) { break; }
    done = u >= uOut;
  }
  return select(u, BEAM_FAR, done);
}
// The ray through pixel point px (framebuffer pixels, y down) of a res-sized target: the march's (its
// fragment's far point through P.meshInv, the jittered camera's), normalized
fn beamDir(px: vec2f, res: vec2f) -> vec3f {
  let ndc = vec2f(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0);
  let f = P.meshInv * vec4f(ndc, 1.0, 1.0);
  return normalize(f.xyz / f.w - FU.cam);
}
// Tile t's safe distance: the cone round its four corners' rays (it holds every ray between them: the
// pixels' far points lie in the corners' quadrilateral)
fn beamTile(t: vec2u) -> f32 {
  let res = P.sceneRes;
  let lo = vec2f(t * BEAM_TILE) - BEAM_PAD;
  let hi = vec2f((t + 1u) * BEAM_TILE) + BEAM_PAD;
  let d0 = beamDir(lo, res);
  let d1 = beamDir(vec2f(hi.x, lo.y), res);
  let d2 = beamDir(vec2f(lo.x, hi.y), res);
  let d3 = beamDir(hi, res);
  let dc = normalize(d0 + d1 + d2 + d3);
  let c = min(min(dot(dc, d0), dot(dc, d1)), min(dot(dc, d2), dot(dc, d3)));
  if (c <= 0.0) { return 0.0; }
  let k = max(sqrt(max(1.0 - c * c, 0.0)) / c * (1.0 + BEAM_SLOPE_PAD), BEAM_SLOPE_MIN);
  return beamMarch(FU.cam, dc, k);
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(select(-1.0, 3.0, i == 2u), select(-1.0, 3.0, i == 1u), 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) f32 {
  return beamTile(vec2u(floor(pos.xy)));
}`;

/**
 * The lean march's head start (after the march's core: outside, wcOccupied, ddaNext, the occupancy node
 * sizes; and gbT, T's binding): returns the axis the ray enters by, ax0 where it keeps its own start.
 * Exact: the state is the one the walk's jump into that node leaves (the cell it lands in, tEnter its entry t:
 * the previous node's exit face is this node's entry face, the same plane, the same float), and the next
 * trip jumps the node as the walk would. tMax is the cell's own (the jump overwrites it before a read).
 */
export const beamStartWGSL = /* wgsl */ `
const BEAM_TILE_PX: i32 = ${BEAM_TILE};
const BEAM_END_GAP: f32 = ${BEAM_END_GAP};
// (tb: the tile's safe distance, T's; the rest of the walk's start: tools/beam-cpu-check.mjs runs it)
fn beamStartAt(tb: f32, ro: vec3f, rd: vec3f, t0: f32, tEnd: f32, ax0: i32,
               cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  var ax = ax0;
  let t1 = min(tb, tEnd - BEAM_END_GAP * max(1.0, abs(tEnd)));
  if (t1 > t0) {
    let c = vec3i(floor(ro + rd * t1));
    // (the brick holds no matter: the beam's proof, kept as a guard against round-off)
    if (!outside(c) & !wcOccupied(0u, c)) {
      var n = BS;
      if (!wcOccupied(2u, c)) { n = OCC_NODE_2; } else if (!wcOccupied(1u, c)) { n = OCC_NODE_1; }
      let lo = c & vec3i(-n);
      let bmin = vec3f(lo);
      let bmax = vec3f(min(lo + n, GRID));
      let tn = (select(bmax, bmin, rd >= vec3f(0.0)) - ro) / rd;   // (the node's near faces)
      let tN = max(tn.x, max(tn.y, tn.z));
      let ea = select(select(2, 1, tn.y >= tn.z), 0, (tn.x >= tn.y) & (tn.x >= tn.z));   // (the axis it enters across)
      // the cell the walk's jump into the node lands in (shaders/dda.js ddaJumpBox): the point at the entry t,
      // floored, then on the entry axis the node's first cell (not the cell the head start's point is in:
      // the next jump's never-backwards clamp compares with it, and a ray along a brick's face can floor
      // to either side of it)
      let ce = select(vec3i(floor(ro + rd * tN)), select(vec3i(bmax) - 1, lo, rd >= vec3f(0.0)), axisMask(ea));
      if ((tN > t0) & all((ce & vec3i(-n)) == lo)) {
        *cell = ce;
        *tMax = ddaNext(ro, rd, ce);
        *tEnter = tN;
        ax = ea;
      }
    }
  }
  return ax;
}
fn beamStart(ro: vec3f, rd: vec3f, t0: f32, tEnd: f32, ax0: i32,
             cell: ptr<function, vec3i>, tMax: ptr<function, vec3f>, tEnter: ptr<function, f32>) -> i32 {
  return beamStartAt(textureLoad(gbT, vec2i(floor(gFragCoord)) / BEAM_TILE_PX, 0).x, ro, rd, t0, tEnd, ax0, cell, tMax, tEnter);
}`;
