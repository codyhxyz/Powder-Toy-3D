// Close-up detail (gfx/detail.js DETAIL_GRASS_BLADES, the Full level): meadow
// grass drawn as blades, not as a photo on its surface.
//
// The idea is Grimorium's (research/grimorium-graphics/text/Y8HRCXxI0BY.txt,
// 07:02): "When a ray enters it, the shader builds a little cluster of
// individual blades inside the voxel space and checks the ray against those
// instead", seeded by position so it is the same every frame and nothing is
// stored per cell. Ours is not a cube of grass but a smoothed surface, so the
// blades stand under it: the grass cells' surface is the top of the sward and
// the blades are rooted on the ground a canopy's depth below it (BLADE_H).
// They can never float: every blade runs from that ground up to at most the
// surface the march hit, and a ray that finds no blade lands on the ground.
//
// Where: at the view's one shading site (shaders/render.js), for a smooth
// surface whose material is meadow grass (E_PLANT, AP_GRASS): the ray goes on
// from the surface into the sward, through a 2D lattice of blade sites in the
// world's horizontal plane (blades grow up, whatever the slope), nearest site
// first, and the first blade it hits is what the pixel shows. Each site holds
// BLADE_N tapered blades (a round taper and a flat ribbon's facing, mixed),
// placed, leaned, sized and tinted by a hash of the site alone: fixed to the
// world, the same every frame (TAA sees still geometry), on every map.
//
// Light in the sward: the sun and the sky reach a point a depth z into it
// through the blades above it, Beer-Lambert as Monsi & Saeki's canopy model
// (1953: I = I0 exp(-k LAI), k ~ 0.5 for grass, a lawn's LAI ~ 3), so the
// roots are dark and the tips lit, standing in for contact occlusion between
// blades (Ghost of Tsushima's grass darkens toward the root the same way,
// Wohllaib, GDC 2021). The shadow map and the field AO are read at the
// surface point as before, so a blade is in the shade the ground is in.
//
// The mean matches the photo's, so the fade is invisible: the photo is a
// picture of a sward, its mean already holding the dark of its gaps. A
// blade's colour varies about the photo's own mean (BLADE_MEAN_ALB), and its
// light is divided by the light the ray's blades get on average (swardMean:
// where in the sward a ray like it meets a blade, and which side of the
// blades it sees, toward or away from the sun), so many blades average to
// the photo's shading, times BLADE.NEAR_SHADE. tools/grass-blades-cpu-check.mjs
// walks the real lattice to check that mean.

// Fade: the blades are the photo's ~5 mm blades (surface.js GRASS_BLADE_M),
// so they go by the same mip rule as the photo's normal-mapped ones
// (lodFade(GRASS_BLADE_F, fp): all there to ~1.8 m, gone by ~3.5 m at 1080p,
// 75 degrees). In the band the blade surface and the photo's are blended,
// one trace, no second path. Past it nothing runs past the footprint test.
//
// Intentional (look, 2026-11-01): the realistic look only. Cozy and Noita
// draw their own plants (gfx/cozy.js, gfx/noita.js), and the flat look
// (matDetail 0) has no texture to replace. Every map and scene with meadow
// grass gets it the same way: the switch is the material, not the map.

import { CELL_M } from '../../scale.js';
import { LOOK } from '../../gfx/materials.js';
import { TEXTURE_SET } from '../../gfx/textureSet.js';
import { E } from '../../elements.js';

export const BLADES_ON = (detail = {}) => !!detail.DETAIL_GRASS_BLADES;

// The sward, in cells (shared with tools/grass-blades-cpu-check.mjs, which walks it on the CPU).
export const BLADE = {
  Q: 0.012 / CELL_M,         // lattice pitch: a site every 1.2 cm
  N: 3,                      // blades per site (~2 blades per cm^2: a lawn's sward)
  R: 0.0025 / CELL_M,        // a blade's half-width at its root (5 mm wide: the photo's blades, surface.js GRASS_BLADE_M)
  TIP_R: 0.35,               // its half-width at the tip, as a share of the root's
  H: 0.08 / CELL_M,          // the sward's depth under the surface (8 cm)
  H_MIN: 0.75,               // the shortest blade, as a share of H
  // The normal: the flat ribbon's facing mixed with the round taper's, then bent toward the
  // ground's, as Ghost of Tsushima lights its blades (Wohllaib, GDC 2021): a meadow lit as a surface
  FLAT: 0.6,
  GROUND_N: 0.5,
  // light in the sward (Monsi & Saeki 1953, I = I0 exp(-k LAI)): k LAI over its whole depth, k ~ 0.5
  // for grass and a lawn's LAI ~ 3; for the sun per unit of path (over the sun's height), and the sky
  K_SUN: 1.5,
  K_SKY: 1.5,
  SUN_Y_MIN: 0.2,            // the sun's lowest height in that path (a long slant)
  // Up close a meadow reads a little darker than its photo's mean (its deepest gaps are seen, where
  // a photo's are averaged with the tips over a pixel): the blades' mean is this share of the photo's
  NEAR_SHADE: 0.92,
};
// What the blades' mean must equal: the photo's own mean as matOf draws it (gfx/textureSet.js mean,
// tinted by its look's texTint: it already holds the sward's own shading, its gaps' dark, as photographed)
const look = LOOK[E.PLANT];
export const BLADE_MEAN_ALB = TEXTURE_SET[look.texAsset].mean.map((m, k) => m * look.texTint[k]);
// the thatch on the ground among the blades (dead leaves and soil), and dry blade tips: straw, both
// scaled to a share of the green's luma so they change its hue, not its mean
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const BLADE_THATCH_SHARE = 0.6;   // the thatch's luma over the blades' (shaded litter under a sward)
const STRAW = [0.42, 0.36, 0.2];
const scaled = (c, l) => c.map((v) => v * l / lum(c));
export const BLADE_THATCH_ALB = scaled([0.16, 0.13, 0.07], BLADE_THATCH_SHARE * lum(BLADE_MEAN_ALB));
export const BLADE_DRY_ALB = scaled(STRAW, lum(BLADE_MEAN_ALB));
// The cosine a blade's bent normal keeps of the ground's: its own facing is near level, turned at
// random but always toward the eye (the side seen), so looking toward the sun the blades seen are
// their shaded sides and looking away their lit ones (the photo, a flat surface, has neither). The
// sun's share is that mean over the facings (BLADE_FACINGS below), against the
// ground's cosine; the sky's is a tilted plane's view of it.
export const BLADE_N_COS = BLADE.GROUND_N / Math.hypot(BLADE.GROUND_N, 1 - BLADE.GROUND_N);
export const BLADE_N_SKY = (1 + BLADE_N_COS) / 2;   // a tilted plane's share of the sky (view factor)
export const BLADE_MEAN_STEPS = 8;
// The facings averaged, in the eye's frame (x toward the eye, y across): the ribbon's turned over the
// half turn facing the eye (BLADE_COS_TURNS), mixed with the round taper's, which faces the eye turned
// by where across the blade the ray meets it (sin of its turn uniform: BLADE_COS_ACROSS), as the walk
// builds a blade's normal (the CPU check walks it)
export const BLADE_COS_TURNS = 8, BLADE_COS_ACROSS = 4;
export const BLADE_FACINGS = (() => {
  const out = [];
  for (let k = 0; k < BLADE_COS_TURNS; k++) for (let j = 0; j < BLADE_COS_ACROSS; j++) {
    const ph = ((k + 0.5) / BLADE_COS_TURNS - 0.5) * Math.PI;
    const al = Math.asin(((j + 0.5) / BLADE_COS_ACROSS) * 2 - 1);
    const x = (1 - BLADE.FLAT) * Math.cos(al) + BLADE.FLAT * Math.cos(ph);
    const y = (1 - BLADE.FLAT) * Math.sin(al) + BLADE.FLAT * Math.sin(ph);
    const d = Math.hypot(x, y);
    out.push([x / d, y / d]);
  }
  return out;
})();
// vh: the unit horizontal toward the eye; l: toward the sun (unit); the share of the ground's cosine
// (l.y) the blades seen get, on average
export function bladeCosShare(vh, l, b = BLADE) {
  const L = Math.hypot(b.GROUND_N, 1 - b.GROUND_N);
  const along = vh[0] * l[0] + vh[1] * l[2], across = -vh[1] * l[0] + vh[0] * l[2];
  let m = 0;
  for (const [x, y] of BLADE_FACINGS) m += Math.max((b.GROUND_N * l[1] + (1 - b.GROUND_N) * (x * along + y * across)) / L, 0);
  return m / BLADE_FACINGS.length / Math.max(l[1], b.SUN_Y_MIN);
}

// Expected light at the blade or ground a ray meets, over where in the sward it meets it, so a
// pixel's mean of many blades equals the photo's (the fade is then invisible). z is the depth share;
// a ray descends dz per unit z and crosses hs*H/dd cells sideways (hs: its horizontal speed, dd: its
// descent per unit of ray). Hits per unit z: the blades standing there (exist), each 2r across, over
// that sideways run, and the tips that start there seen end-on (pi r^2). Returns [sun, sky], each the
// mean of (albedo share) x (cosine share) x light over the hits and the ground. The CPU check walks the
// real lattice against it.
export function swardMean(dd, hs, sunY, cosShare, b = BLADE) {
  const nb = b.N / (b.Q * b.Q);
  const run = b.H * hs / dd;
  const hBar = 0.5 * (1 + b.H_MIN);
  const dz = 1 / BLADE_MEAN_STEPS;
  let pass = 1, sun = 0, sky = 0;
  const kSun = b.K_SUN / Math.max(sunY, b.SUN_Y_MIN);
  for (let i = 0; i < BLADE_MEAN_STEPS; i++) {
    const z = (i + 0.5) * dz;
    const exist = Math.min(z / (1 - b.H_MIN), 1);
    const r = b.R * (1 + (b.TIP_R - 1) * Math.min((1 - z) / hBar, 1));
    const lam = nb * (exist * 2 * r * run + (z < 1 - b.H_MIN ? Math.PI * r * r / (1 - b.H_MIN) : 0)) * dz;
    const p = pass * (1 - Math.exp(-lam));
    sun += p * cosShare * Math.exp(-kSun * z);
    sky += p * BLADE_N_SKY * Math.exp(-b.K_SKY * z);
    pass -= p;
  }
  sun += pass * BLADE_THATCH_SHARE * Math.exp(-kSun);
  sky += pass * BLADE_THATCH_SHARE * Math.exp(-b.K_SKY);
  return [sun, sky];
}

export const bladesWGSL = (detail = {}) => {
  if (!BLADES_ON(detail)) return '// (no grass blades: DETAIL_GRASS_BLADES is off)';
  const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(+x.toPrecision(7)));
  const v3 = (c) => `vec3f(${c.map(f).join(', ')})`;
  const b = BLADE;
  return /* wgsl */ `
// ---- grass blades (gfx/blades.js) ----
var<private> gBladeSun: f32 = 1.0;   // the sun through the sward above a blade, set around its shadeSurf

const BLADE_Q: f32 = ${f(b.Q)};
const BLADE_N: i32 = ${b.N};
const BLADE_R: f32 = ${f(b.R)};
const BLADE_TIP_R: f32 = ${f(b.TIP_R)};
const BLADE_H: f32 = ${f(b.H)};
const BLADE_H_MIN: f32 = ${f(b.H_MIN)};
// where in its site a blade's root and tip may be (lattice units): far enough
// in that the whole blade stays in its site, so the walk tests only the sites
// the ray crosses, nearest first
const BLADE_ROOT_M: f32 = BLADE_R / BLADE_Q;
const BLADE_TIP_M: f32 = BLADE_R * BLADE_TIP_R / BLADE_Q;
const BLADE_ROT: f32 = 0.61;                   // the lattice's turn off the grid's axes, radians
const BLADE_FLAT: f32 = ${f(b.FLAT)};
const BLADE_GROUND_N: f32 = ${f(b.GROUND_N)};
const BLADE_STEPS: i32 = 24;                   // sites a ray walks; then it is on the ground among them
// the ground's slope (the normal's height): blades stand on ground up to 45 degrees
// steep and are gone by 60 degrees (a grass cliff stays the photo)
const BLADE_UP_NONE: f32 = 0.5;
const BLADE_UP_FULL: f32 = 0.7;
const BLADE_K_SUN: f32 = ${f(b.K_SUN)};
const BLADE_K_SKY: f32 = ${f(b.K_SKY)};
const BLADE_SUN_Y_MIN: f32 = ${f(b.SUN_Y_MIN)};
const BLADE_NEAR_SHADE: f32 = ${f(b.NEAR_SHADE)};
const BLADE_MEAN_ALB: vec3f = ${v3(BLADE_MEAN_ALB)};   // the photo's mean (gfx/blades.js)
const BLADE_THATCH_SHARE: f32 = ${f(BLADE_THATCH_SHARE)};
const BLADE_THATCH_ALB: vec3f = ${v3(BLADE_THATCH_ALB)};
const BLADE_DRY_ALB: vec3f = ${v3(BLADE_DRY_ALB)};
const BLADE_N_SKY: f32 = ${f(BLADE_N_SKY)};
const BLADE_MEAN_STEPS: i32 = ${BLADE_MEAN_STEPS};
const BLADE_PI: f32 = 3.14159265;
// blade to blade: brightness and hue spread (zero mean), and dry tips (straw at the green's luma)
const BLADE_ALB_VAR: f32 = 0.35;
const BLADE_HUE_VAR: vec3f = vec3f(0.12, 0.0, -0.1);
const BLADE_DRY_P: f32 = 0.15;                 // share of blades with dry tips
const BLADE_SALT: u32 = 0x2545f491u;           // spreads the sites' hash streams apart

// gfx/blades.js BLADE_FACINGS and bladeCosShare, the same sum: vh the unit horizontal toward the eye,
// l toward the sun (a private array: docs/webgpu.md C6)
var<private> BLADE_FACINGS: array<vec2f, ${BLADE_FACINGS.length}> = array<vec2f, ${BLADE_FACINGS.length}>(${BLADE_FACINGS.map(([x, y]) => `vec2f(${f(x)}, ${f(y)})`).join(', ')});
fn bladeCosShare(vh: vec2f, l: vec3f) -> f32 {
  let L = length(vec2f(BLADE_GROUND_N, 1.0 - BLADE_GROUND_N));
  let along = dot(vh, l.xz);
  let across = -vh.y * l.x + vh.x * l.z;
  var m = 0.0;
  for (var k = 0; k < ${BLADE_FACINGS.length}; k++) {
    let d = BLADE_FACINGS[k];
    m += max((BLADE_GROUND_N * l.y + (1.0 - BLADE_GROUND_N) * (d.x * along + d.y * across)) / L, 0.0);
  }
  return m / ${BLADE_FACINGS.length}.0 / max(l.y, BLADE_SUN_Y_MIN);
}
// gfx/blades.js swardMean, the same sums: [sun, sky]
fn swardMean(dd: f32, hs: f32, sunY: f32, cosShare: f32) -> vec2f {
  let nb = f32(BLADE_N) / (BLADE_Q * BLADE_Q);
  let run = BLADE_H * hs / dd;
  let hBar = 0.5 * (1.0 + BLADE_H_MIN);
  let dz = 1.0 / f32(BLADE_MEAN_STEPS);
  let kSun = BLADE_K_SUN / max(sunY, BLADE_SUN_Y_MIN);
  var left = 1.0;
  var m = vec2f(0.0);
  for (var i = 0; i < BLADE_MEAN_STEPS; i++) {
    let z = (f32(i) + 0.5) * dz;
    let exist = min(z / (1.0 - BLADE_H_MIN), 1.0);
    let r = BLADE_R * (1.0 + (BLADE_TIP_R - 1.0) * min((1.0 - z) / hBar, 1.0));
    let tipEnd = select(0.0, BLADE_PI * r * r / (1.0 - BLADE_H_MIN), z < 1.0 - BLADE_H_MIN);
    let lam = nb * (exist * 2.0 * r * run + tipEnd) * dz;
    let p = left * (1.0 - exp(-lam));
    m += p * vec2f(cosShare * exp(-kSun * z), BLADE_N_SKY * exp(-BLADE_K_SKY * z));
    left -= p;
  }
  m += left * BLADE_THATCH_SHARE * vec2f(exp(-kSun), exp(-BLADE_K_SKY));
  return m;
}

fn bladeU(h: ptr<function, u32>) -> f32 {
  *h = pcg(*h);
  return u32ToF32(*h) * UINT_TO_UNIT;
}

// The share of a smooth hit's material that is meadow grass (gfx/surface.js MatPlan).
fn grassShare(pl: MatPlan) -> f32 {
  if (pl.count == 0 || pl.id0 != E_PLANT || appearanceOf(E_PLANT, pl.ct0) != AP_GRASS) { return 0.0; }
  var k = 1.0 - pl.flatK;
  if (pl.count == 2 && (pl.id1 != E_PLANT || appearanceOf(E_PLANT, pl.ct1) != AP_GRASS)) { k *= 1.0 - pl.w; }
  return k;
}

// The sward under smooth surface *s (its p, ng) seen along rd: the blade or
// ground the ray meets there replaces the surface by the share the fade and
// share give it. *bp is the point it meets (for the pixel's depth). True if
// anything changed. Sets gBladeSun for the shadeSurf that follows.
fn grassBlades(s: ptr<function, Surf>, rd: vec3f, share: f32, bp: ptr<function, vec3f>) -> bool {
  *bp = (*s).p;
  gBladeSun = 1.0;
  if (share <= 0.0 || FU.matDetail < 0.5 || FU.materialStyle != 0.0) { return false; }
  let ng = (*s).ng;
  let w = share * smoothstep(BLADE_UP_NONE, BLADE_UP_FULL, ng.y) * lodFade(GRASS_BLADE_F, footprint((*s).p));
  if (w <= 0.0) { return false; }
  // depth under the surface's plane per unit of ray (the plane through p with normal ng, measured upright)
  let dd = -dot(rd, ng) / ng.y;
  if (dd <= 0.0) { return false; }
  let tGround = BLADE_H / dd;
  // the lattice: world horizontal coordinates, turned by BLADE_ROT, in sites
  let cr = cos(BLADE_ROT);
  let sr = sin(BLADE_ROT);
  let wp = worldPos((*s).p);
  let lw = vec2f(cr * wp.x + sr * wp.z, -sr * wp.x + cr * wp.z) / BLADE_Q;
  let base = floor(lw);
  let x0 = lw - base;                          // where the ray starts in its site, [0, 1)^2
  let dl = vec2f(cr * rd.x + sr * rd.z, -sr * rd.x + cr * rd.z) / BLADE_Q;   // sites per unit of ray
  let ib = vec2i(base);
  var cl = vec2i(0);
  let stp = vec2i(select(vec2f(-1.0), vec2f(1.0), dl >= vec2f(0.0)));
  let inv = 1.0 / max(abs(dl), vec2f(1e-6));
  var tMax = select(x0, 1.0 - x0, dl >= vec2f(0.0)) * inv;
  let tDelta = inv;
  // plane height above p at a lattice point x (sites, from the start site's corner), cells
  let gx = vec2f(cr * ng.x + sr * ng.z, -sr * ng.x + cr * ng.z) / ng.y;   // the plane's rise per cell, lattice axes
  var tA = 0.0;
  var tHit = tGround;
  var hitN = ng;
  var hitU = 0.0;
  var hitAlb = vec3f(0.0);
  var found = false;
  for (var i = 0; i < BLADE_STEPS; i++) {
    let tB = min(min(tMax.x, tMax.y), tGround);
    var h = pcg((bitcast<u32>(ib.x + cl.x) * BLADE_SALT) ^ pcg(bitcast<u32>(ib.y + cl.y)));
    for (var k = 0; k < BLADE_N; k++) {
      let rx = vec2f(BLADE_ROOT_M) + (1.0 - 2.0 * BLADE_ROOT_M) * vec2f(bladeU(&h), bladeU(&h));
      let tx = vec2f(BLADE_TIP_M) + (1.0 - 2.0 * BLADE_TIP_M) * vec2f(bladeU(&h), bladeU(&h));
      let hgt = BLADE_H * (BLADE_H_MIN + (1.0 - BLADE_H_MIN) * bladeU(&h));
      let tone = bladeU(&h);
      let face = bladeU(&h) * 6.2831853;
      let dry = bladeU(&h);
      // root and tip relative to p, cells: lattice offsets back to the world's x and z
      let ro2 = (vec2f(cl) + rx - x0) * BLADE_Q;
      let to2 = (vec2f(cl) + tx - x0) * BLADE_Q;
      let rootY = -dot(gx, ro2) - BLADE_H;
      let R = vec3f(cr * ro2.x - sr * ro2.y, rootY, sr * ro2.x + cr * ro2.y);
      let T = vec3f(cr * to2.x - sr * to2.y, rootY + hgt, sr * to2.x + cr * to2.y);
      let E = T - R;
      // closest approach of the ray's stretch [tA, tB] in this site and the blade's axis
      let b = dot(rd, E);
      let c = dot(E, E);
      let d = -dot(rd, R);
      let e = -dot(E, R);
      let den = max(c - b * b, 1e-12);
      var u = clamp((e - b * d) / den, 0.0, 1.0);
      var t = clamp(b * u - d, tA, tB);
      u = clamp((b * t + e) / c, 0.0, 1.0);
      let off = rd * t - (R + E * u);
      let r = BLADE_R * mix(1.0, BLADE_TIP_R, u);
      let d2 = dot(off, off);
      if (d2 < r * r) {
        let sk = sqrt(r * r - d2);
        let th = max(t - sk, tA);
        if (th < tHit) {
          tHit = th; hitU = u; found = true;
          let ax = E * inverseSqrt(c);
          let v = -rd;
          var vp = v - ax * dot(v, ax);
          vp *= inverseSqrt(max(dot(vp, vp), 1e-12));
          let nRound = normalize(off + vp * sk + ax * 1e-6);
          let side = vec3f(cos(face), 0.0, sin(face));
          var nFlat = cross(ax, side);
          nFlat *= inverseSqrt(max(dot(nFlat, nFlat), 1e-12));
          nFlat = select(-nFlat, nFlat, dot(nFlat, v) >= 0.0);
          hitN = normalize(mix(normalize(mix(nRound, nFlat, BLADE_FLAT)), ng, BLADE_GROUND_N));
          var alb = BLADE_MEAN_ALB * (1.0 + BLADE_ALB_VAR * (tone - 0.5)) * (1.0 + BLADE_HUE_VAR * (tone - 0.5));
          if (dry < BLADE_DRY_P) { alb = mix(alb, BLADE_DRY_ALB, smoothstep(0.4, 1.0, u)); }
          hitAlb = alb;
        }
      }
    }
    if (found || tB >= tGround) { break; }
    tA = tB;
    if (tMax.x < tMax.y) { tMax.x += tDelta.x; cl.x += stp.x; } else { tMax.y += tDelta.y; cl.y += stp.y; }
  }
  if (!found) { hitAlb = BLADE_THATCH_ALB; hitN = ng; tHit = tGround; }
  // depth into the sward (a share of BLADE_H) and the light that gets there, over its mean for this
  // ray (swardMean): a pixel's many blades average to the photo's shading, times BLADE_NEAR_SHADE
  let z = clamp(dd * tHit / BLADE_H, 0.0, 1.0);
  let sunY = max(dot(FU.sun, ng), BLADE_SUN_Y_MIN);
  let hs = length(rd.xz);
  let vh = select(vec2f(0.0, 1.0), -rd.xz / hs, hs > 1e-6);
  let mean = swardMean(dd, hs, sunY, bladeCosShare(vh, FU.sun));
  let lit = BLADE_NEAR_SHADE * vec2f(exp(-BLADE_K_SUN * z / sunY), exp(-BLADE_K_SKY * z)) / max(mean, vec2f(1e-3));
  gBladeSun = mix(1.0, lit.x, w);
  (*s).cav = mix((*s).cav, (*s).cav * lit.y, w);
  (*s).albedo = mix((*s).albedo, hitAlb, w);
  (*s).n = normalize(mix((*s).n, hitN, w));
  *bp = (*s).p + rd * (tHit * w);
  return true;
}
`;
};
