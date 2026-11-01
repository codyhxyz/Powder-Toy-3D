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
// roots are dark and the tips lit. That stands in for contact occlusion
// between blades (Ghost of Tsushima's grass darkens toward the root the same
// way, Wohllaib, GDC 2021). The shadow map and the field AO are read at the
// surface point as before, so a blade is in the shade the ground is in.
//
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

export const BLADES_ON = (detail = {}) => !!detail.DETAIL_GRASS_BLADES;

export const bladesWGSL = (detail = {}) => {
  if (!BLADES_ON(detail)) return '// (no grass blades: DETAIL_GRASS_BLADES is off)';
  const cells = (m) => (m / CELL_M).toFixed(6);
  return /* wgsl */ `
// ---- grass blades (gfx/blades.js) ----
var<private> gBladeSun: f32 = 1.0;   // the sun through the sward above a blade, set around its shadeSurf

const BLADE_Q: f32 = ${cells(0.012)};        // lattice pitch: a site every 1.2 cm
const BLADE_N: i32 = 2;                        // blades per site (~0.7 blades per cm^2: a lawn's sward)
const BLADE_R: f32 = 0.5 * GRASS_BLADE_M / CELL_M;   // a blade's half-width at its root, cells (5 mm wide)
const BLADE_TIP_R: f32 = 0.2;                  // its half-width at the tip, as a share of the root's
const BLADE_H: f32 = ${cells(0.08)};          // the sward's depth under the surface, cells (8 cm)
const BLADE_H_MIN: f32 = 0.55;                 // the shortest blade, as a share of BLADE_H
// where in its site a blade's root and tip may be (lattice units): far enough
// in that the whole blade stays in its site, so the walk tests only the sites
// the ray crosses, nearest first
const BLADE_ROOT_M: f32 = BLADE_R / BLADE_Q;
const BLADE_TIP_M: f32 = BLADE_R * BLADE_TIP_R / BLADE_Q;
const BLADE_ROT: f32 = 0.61;                   // the lattice's turn off the grid's axes, radians
const BLADE_FLAT: f32 = 0.6;                   // a blade's normal: share of the flat ribbon's (vs the round taper's)
const BLADE_STEPS: i32 = 24;                   // sites a ray walks; then it is on the ground among them
// the ground's slope (the normal's height): blades stand on ground up to 45 degrees
// steep and are gone by 60 degrees (a grass cliff stays the photo)
const BLADE_UP_NONE: f32 = 0.5;
const BLADE_UP_FULL: f32 = 0.7;
// light in the sward (Monsi & Saeki 1953): k LAI over its depth, for the sun
// (per unit of path, so divided by the sun's height) and for the sky
const BLADE_K_SUN: f32 = 1.5;
const BLADE_K_SKY: f32 = 2.0;
const BLADE_SUN_Y_MIN: f32 = 0.2;              // the sun's lowest height in that path (a long slant)
// colour: a blade is brighter than the sward's mean (the gaps' dark is in
// the mean the photo and the far view draw), varies blade to blade, and some
// have dry, straw-coloured tips; the ground is thatch
const BLADE_ALB_GAIN: f32 = 1.35;
const BLADE_ALB_VAR: f32 = 0.35;
const BLADE_HUE_VAR: vec3f = vec3f(0.12, 0.0, -0.1);
const BLADE_DRY_P: f32 = 0.15;                 // share of blades with dry tips
const BLADE_DRY_ALB: vec3f = vec3f(0.42, 0.36, 0.2);
const BLADE_THATCH_ALB: vec3f = vec3f(0.11, 0.085, 0.05);
const BLADE_SALT: u32 = 0x2545f491u;           // spreads the sites' hash streams apart

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
          hitN = normalize(mix(nRound, nFlat, BLADE_FLAT));
          var alb = ALBEDO(E_PLANT) * BLADE_ALB_GAIN * (1.0 + BLADE_ALB_VAR * (tone - 0.5)) * (1.0 + BLADE_HUE_VAR * (tone - 0.5));
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
  // depth into the sward (a share of BLADE_H) and the light that gets there
  let z = clamp(dd * tHit / BLADE_H, 0.0, 1.0);
  let sunY = max(dot(FU.sun, ng), BLADE_SUN_Y_MIN);
  gBladeSun = mix(1.0, exp(-BLADE_K_SUN * z / sunY), w);
  (*s).cav = mix((*s).cav, (*s).cav * exp(-BLADE_K_SKY * z), w);
  (*s).albedo = mix((*s).albedo, hitAlb, w);
  (*s).n = normalize(mix((*s).n, hitN, w));
  *bp = (*s).p + rd * (tHit * w);
  return true;
}
`;
};
