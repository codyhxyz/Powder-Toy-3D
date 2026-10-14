
// Transparent media: liquids (smooth surfaces) and crisp glass. WGSL (the
// names are the GLSL version's, docs/webgpu.md W2), pasted after surfaceGLSL
// (reflectTrace meets voxels with crispHit, the floor with floorAlb). The
// GLSL's inout parameters are pointers; sunShadow(p) of a point inside a
// volume is lighting.js's sunShadowAt.
export const liquidGLSL = /* wgsl */ `
fn fresnelSchlick(cosi: f32, ior: f32) -> f32 {
  var f0 = (1.0 - ior) / (1.0 + ior);
  f0 *= f0;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosi, 0.0, 1.0), 5.0);
}

// Ripples shade a surface; they must not send either ray through its wrong side.
fn liquidOpticalNormal(rd: vec3f, n: vec3f, geometric: vec3f, entering: bool, ior: f32) -> vec3f {
  let face = select(-geometric, geometric, entering);
  let optical = select(-n, n, entering);
  let rt = refract(rd, optical, select(ior, 1.0 / ior, entering));
  if (dot(rd, optical) >= 0.0 || dot(reflect(rd, optical), face) <= 0.0
      || (dot(rt, rt) > 1e-6 && dot(rt, face) >= 0.0)) { return geometric; }
  return n;
}

// The sun's highlight on a clear interface with normal n seen from v (toward
// the eye), GGX roughness rough, per unit of Fresnel (the callers multiply
// by theirs): the GGX lobe shadeSurf lights every other surface with
// (lighting.js ggxSpec, F0 = 1 here), lit by the sun's disc as Karis 2013's
// sphere light, as lampSpec lights the hand lamps' tubes: the point of the
// disc nearest the reflection ray (eq. 11), the lobe's normalisation put back
// for the disc's widening (eq. 10 and 14), the disc SUN_TAN_RADIUS across.
// (It was a Phong lobe, pow(r.l, 400) x 6: far wider and dimmer than a
// 0.02-rough mirror of the sun, and a different model from every other surface.)
fn sunGlint(n: vec3f, v: vec3f, rough: f32, sunVis: vec3f) -> vec3f {
  let r = reflect(-v, n);
  let toRay = dot(FU.sun, r) * r - FU.sun;
  let l = normalize(FU.sun + toRay * clamp(SUN_TAN_RADIUS / max(length(toRay), LAMP_SPEC_EPS), 0.0, 1.0));
  let a = max(rough * rough, GGX_ALPHA_MIN);
  let aS = a / clamp(a + LAMP_SPEC_WIDEN * SUN_TAN_RADIUS, 0.0, 1.0);
  return PI_L * FU.sunCol * sunVis * ggxSpec(n, v, l, rough, vec3f(1.0)) * (aS * aS);
}
// Radiance arriving along r = reflect(-v, n) at a clear interface (GGX
// roughness rough) at p: the sky plus the sun's highlight.
fn envReflect(p: vec3f, n: vec3f, v: vec3f, rough: f32, sunVis: vec3f) -> vec3f {
  return skyColor(reflect(-v, n)) + sunGlint(n, v, rough, sunVis);
}
// The same inside the grid, where the GI probes know what's overhead: the sky
// only as far as they say it is open toward r, their light (bounce, the rock
// around) for the rest, as surface.js's sharp environment does. So a pool in a
// cave mirrors the cave, not a sky it can't see. gi: the interface's probe,
// surfProbe(p, n) with n its normal on the side r leaves from.
fn envSky(gi: Probe, r: vec3f) -> vec3f { return mix(giRadiance(gi, r, 0.0), skyColor(r), giSkyVis(gi, r)); }
// ...and with the sun's highlight (sunGlint: n, v and rough as there, r = reflect(-v, n)).
fn envReflectGI(gi: Probe, n: vec3f, v: vec3f, rough: f32, sunVis: vec3f) -> vec3f {
  return envSky(gi, reflect(-v, n)) + sunGlint(n, v, rough, sunVis);
}

// Offsets off a transparent interface (cells): a ray restarts IFACE_NUDGE past
// it, and the sun's visibility and which liquid is there are read IFACE_PROBE
// to either side (half a cell: clear of the surface, still in its cell).
const IFACE_NUDGE: f32 = 0.03;
const IFACE_PROBE: f32 = 0.5;

// Light scattered toward the eye inside a liquid or glass, per unit
// (1 - transmittance): the scattered share of the extinction (SCATALB) of the
// light arriving at p. sunVis is the sun's visibility there, including its
// fade through the liquid above (the tracer refreshes it with depth); sky
// light fades the same way, but never below a floor, so shaded liquid
// still shows its body colour. Only as much sky light gets in as the sky is
// open above where the ray got in (gSkyIn), so a pool in a cave is lit by the
// cave alone.
const SKY_IN_FLOOR: f32 = 0.25;   // share of the sky light that reaches liquid in shade
const SUN_IN_GAIN: f32 = 0.6;     // sunlight scattered per unit of sun elevation
// The GI probes' sky visibility facing up where the ray last got into liquid
// or glass (skyInAt); the tracer sets it at each way in. 1 (open sky) for
// code without the probes: the far field's open sea.
var<private> gSkyIn: f32 = 1.0;
fn skyInAt(gi: Probe) -> f32 { return giSkyVis(gi, vec3f(0.0, 1.0, 0.0)); }
// the sky's and sun's share of it, the sky open by sky over where the light got in
// (gSkyIn here; the far field's liquids, shaders/far.js farInScatter, read their own)
fn liquidAmbientLight(sky: f32, sunVis: vec3f) -> vec3f {
  return skyAmbient(vec3f(0.0, 1.0, 0.0)) * sky * mix(vec3f(SKY_IN_FLOOR), vec3f(1.0), sunVis)
       + FU.sunCol * sunVis * max(FU.sun.y, 0.0) * SUN_IN_GAIN;
}
// the light scattered inside at p, per unit of scattering albedo (gfx/deco.js scatters its paint in it too)
fn interiorLight(p: vec3f, sunVis: vec3f) -> vec3f {
  return liquidAmbientLight(gSkyIn, sunVis) + sampleLight(p) * FU.lightGain;
}
fn interiorScatter(id: i32, p: vec3f, sunVis: vec3f, T: f32) -> vec3f {
  return SCATALB(id) * interiorLight(p, sunVis) + emission(id, T);
}

// Liquid in the air shows its colour. Water is clear (elements.js sigma: a
// cell of it lets 95-99% through), so a lone drop, a pour or spray, drawn
// truly, is a clear bead against the sky: from a player's view nearly
// invisible, a cloud of glass bubbles. Noita and The Powder Toy draw every
// liquid pixel in its body colour, however small, which is why their pours
// always read. So where the fields mark liquid a thin feature (the thin mask,
// shaders/fields.js: drops, streams, spray; never a pool's bulk), the light
// crossing it is absorbed and scattered as through THIN_BODY_CELLS of it: the
// blue-green a pool shows a few metres deep. Pools are left as they are.
const THIN_BODY_CELLS: f32 = 24.0;   // cells (7 m): water's body colour, the depth a deep pool shows
fn thinBodySeg(p: vec3f, seg: f32) -> f32 {
  var thin = 0.0;
  if (gThin) { thin = fieldTex(tFT, p)[CH_LIQUID]; }
  return mix(seg, max(seg, THIN_BODY_CELLS), thin);
}

// Beer–Lambert through a segment of length seg inside element id.
fn absorbSegment(id: i32, p: vec3f, seg: f32, sunVis: vec3f, T: f32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let att = exp(-SIGMA(id) * seg);
  *col += *trans * (1.0 - att) * interiorScatter(id, p, sunVis, T);
  *trans *= att;
}

// Which liquid is at p (the cell itself, else a neighbour), for absorption.
const LIQ_ID_PROBES: i32 = 7;   // cells tried: p's own, then its 6 face neighbours
fn liquidIdAt(p: vec3f, fallback: i32) -> i32 {
  let c = vec3i(floor(p));
  for (var i = 0; i < LIQ_ID_PROBES; i++) {
    var q = c;
    if (i > 0) { q[(i - 1) >> 1u] += select(1, -1, (i & 1) == 1); }
    if (outside(q)) { continue; }
    let id = eid(fetchA(q));
    if (SURFCH(id) == CH_LIQUID) { return id; }
  }
  return fallback;
}

// Wind ripples on open liquid: a slowly drifting two-octave value-noise
// height field tilts the normal of upward-facing surfaces by a few degrees
// (the surface itself doesn't move), breaking up an otherwise perfect mirror
// of the sky. Fades out before it would alias.
// (The height field itself, rippleH, lives in gfx/lighting.js: the sun's
// caustics are focused by the same ripples.)
const RIPPLE_SLOPE: f32 = 0.035;     // height-field slope per unit noise gradient
const RIPPLE_UP_LO: f32 = 0.6;       // n.y where ripples start ...
const RIPPLE_UP_HI: f32 = 0.9;       // ... and reach full strength
const RIPPLE_EPS: f32 = 0.1;         // finite-difference step, noise space
fn liquidRipple(p: vec3f, n: vec3f) -> vec3f {
  // fades out with the finer octave, by the material LOD (lodFade)
  let k = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y) * lodFade(RIPPLE_FREQ * RIPPLE_OCT2, footprint(p));
  if (k <= 0.0) { return n; }
  let q = worldPos(p).xz * RIPPLE_FREQ;   // anchored in the world
  let t = FU.time * RIPPLE_DRIFT;
  let h = rippleH(q, t);
  let g = vec2f(rippleH(q + vec2f(RIPPLE_EPS, 0.0), t) - h, rippleH(q + vec2f(0.0, RIPPLE_EPS), t) - h) / RIPPLE_EPS;
  return normalize(n - vec3f(g.x, 0.0, g.y) * RIPPLE_SLOPE * k);
}

// ---- reflections of the scene ----
// Where a liquid surface reflects a lot (grazing views: Fresnel climbs fast
// past ~60°), the reflected ray is traced through the grid to the first
// opaque thing (crisp voxels, opaque smooth surfaces, the floor); liquids,
// glass and media along it are skipped. Elsewhere the sky stands in, which is
// mostly what such a surface shows. Blended over a Fresnel range so the
// switch doesn't show.
// One traced reflection a pixel, the first the eye ray meets (a glass pane,
// a pool's surface); any after it show the probes' environment (envReflectGI),
// as Source's glass shows its env_cubemap. A second one lies behind the
// first's reflection, dimmed by its transmission. Far from the eye, traced
// reflections hand over to that environment too: Source's water does the same
// between $cheapwaterstartdistance and $cheapwaterenddistance (TF2, Garry's
// Mod), where its real-time reflection gives way to the cube map.
const REFL_F_LO: f32 = 0.04;      // Fresnel reflectance where traced reflections start ...
const REFL_F_HI: f32 = 0.1;       // ... and take over
// Pixel footprint (cells per pixel) over which traced reflections hand over to the environment.
const REFL_FP_LO: f32 = 0.2;      // (~66 m away at 1280×800) ...
const REFL_FP_HI: f32 = 0.35;     // (... ~115 m)
var<private> gReflTraced: bool = false;   // this pixel has traced its reflection
const REFL_MAX_STEPS: i32 = 32;   // DDA steps (cells or skipped bricks) before falling back to the sky
const REFL_START: f32 = 0.05;     // start offset off the surface, cells
const REFL_PROBE: f32 = 0.5;      // a smooth hit's element is looked up this far inside it, then twice that
const REFL_NORMAL_STEP: f32 = 0.5;   // forward-difference step of a reflected smooth hit's normal, cells
// What the reflection shows of a hit at hp (state a, normal n): the element lit
// as the near field lights its hits (lighting.js hitLight), plus the glow the
// view shows on it (materials.js cellEmission: the same skin temperature and
// emissivity) and a live conductor's or a lit lamp's light. Shadows and the
// probes' occlusion keep a cave's walls dark in its pool.
fn reflShade(a: vec4f, hp: vec3f, n: vec3f) -> vec3f {
  let id = eid(a);
  let ct = floor(a.w);
  return hitLight(hp + n * IFACE_PROBE, n, ALBEDO(id), cellEmission(id, a.y, ct) + sparkEmit(id, ct));
}
// Reflections bracket and shade the trilinear field, so refine that same
// field here, not surfRoot's cubic/near-detail surface. Entering crossings only.
fn reflCross(ro: vec3f, rd: vec3f, ch: i32, ta0: f32, tb0: f32, phiA: f32, phiB: f32) -> f32 {
  var fa = phiA - SURF_ISO;
  var fb = phiB - SURF_ISO;
  if (!(fa < 0.0 && fb >= 0.0)) { return NO_HIT; }
  var ta = ta0;
  var tb = tb0;
  for (var k = 0; k < SURF_ROOT_STEPS; k++) {
    let tm = mix(ta, tb, clamp(fa / (fa - fb), SURF_ROOT_SPLIT_LO, SURF_ROOT_SPLIT_HI));
    let fm = surfField(ro + rd * tm)[ch] - SURF_ISO;
    if ((fm < 0.0) == (fa < 0.0)) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp(fa / (fa - fb), 0.0, 1.0));
}

// env: what the ray sees if it meets nothing (envReflectGI at the interface).
// The pixel's first traced reflection (gReflTraced); later ones, and those far
// from the eye, return env.
fn reflectTrace(ro: vec3f, rd0: vec3f, env: vec3f) -> vec3f {
  let wf = 1.0 - smoothstep(REFL_FP_LO, REFL_FP_HI, footprint(ro));
  if (gReflTraced || wf <= 0.0) { return env; }
  gReflTraced = true;
  return mix(env, reflectHit(ro, rd0, env), wf);
}
fn reflectHit(ro: vec3f, rd0: vec3f, env: vec3f) -> vec3f {
  let rd = safeDir(rd0);
  var istp: vec3i;
  var tDelta: vec3f;
  var tMax: vec3f;
  var cell = vec3i(floor(ro));
  ddaInit(ro, rd, cell, &istp, &tDelta, &tMax);
  var tEnter = 0.0;
  var ax = 1;   // entry face axis: unknown in the start cell
  var lastB = vec3i(-1);
  var flags = 0u;
  var bid = 0u;
  var occM = vec2u(0u);
  var phiA = surfField(ro);
  var stale = false;
  for (var i = 0; i < REFL_MAX_STEPS; i++) {
    if (outside(cell)) { break; }
    let bc = cell / BS;
    if (any(bc != lastB)) {
      lastB = bc;
      bid = brickId(bc);
      flags = brickInfoOf(bid);
      if (brickOpaque(flags)) { occM = occMaskOf(bid); }
      // Keep gThin inherited from the primary march, as before.
    }
    // only bricks with something opaque can stop it
    if (!brickOpaque(flags)) {
      // an empty brick may sit in a larger empty region: cross all of it
      if (flags == 0u) { ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter); }
      else { ax = skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter); }
      stale = true;
      continue;
    }
    let tExit = min(tMax.x, min(tMax.y, tMax.z));
    let id = occCellId(occM, bid, cell);
    // Exactly the empty crisp-only body's stale update and single DDA step:
    // phiA is untouched, ties and the reflection iteration budget unchanged.
    // Smooth fields can reach empty cells, so never bypass a surface brick.
    if (id == E_EMPTY && (flags & (BRICK_SURF | BRICK_MEDIA)) == 0u) {
      stale = true;
      tEnter = tExit;
      ax = ddaStep(istp, tDelta, &cell, &tMax);
      continue;
    }
    if (isCrisp(id)) {
      if (RCLASS(id) != R_GLASS) {
        var nh = vec3f(0.0);
        nh[ax] = -f32(istp[ax]);
        var th = tEnter;
        if (crispHit(cell, id, ro, rd, tEnter, tExit, &th, &nh)) { return reflShade(fetchA(cell), ro + rd * th, nh); }
      }
      stale = true;
    } else if (brickSurf(flags)) {
      if (stale) { phiA = surfField(ro + rd * tEnter); }
      let phiB = surfField(ro + rd * tExit);
      var tOp = NO_HIT;
      var ch = -1;
      for (var c = 1; c < 4; c++) {
        let t = reflCross(ro, rd, c, tEnter, tExit, phiA[c], phiB[c]);
        if (t < tOp) { tOp = t; ch = c; }
      }
      if (ch > 0) {
        let hp = ro + rd * tOp;
        // forward difference: the field is SURF_ISO at hp
        let e = vec2f(REFL_NORMAL_STEP, 0.0);
        let gr = vec3f(surfField(hp + e.xyy)[ch], surfField(hp + e.yxy)[ch], surfField(hp + e.yyx)[ch]) - SURF_ISO;
        var n = -rd;
        if (dot(gr, gr) > 1e-10) { n = -normalize(gr); }
        let c1 = clamp(vec3i(floor(hp - n * REFL_PROBE)), vec3i(0), GRID - 1);
        var ah = fetchA(c1);
        if (SURFCH(eid(ah)) != ch) { ah = fetchA(clamp(vec3i(floor(hp - n * (2.0 * REFL_PROBE))), vec3i(0), GRID - 1)); }
        return reflShade(ah, hp, n);
      }
      phiA = phiB;
      stale = false;
    } else {
      stale = true;
    }
    tEnter = tExit;
    ax = ddaStep(istp, tDelta, &cell, &tMax);
  }
  if (cell.y < 0 && rd.y < 0.0) {
    // the floor, its grid lines as wide as the whole path from the eye makes
    // them, lit as every other reflected hit is (hitLight), not as the view lights it
    let hp = ro - rd * (ro.y / rd.y);
    return hitLight(vec3f(hp.x, IFACE_PROBE, hp.z), vec3f(0.0, 1.0, 0.0), floorAlb(hp, floorFwidthMirror(hp, rd, ro)), vec3f(0.0));
  }
  return env;
}

// Refraction at a smooth liquid surface. n = outward normal of the liquid.
// Updates the ray (restarting just past the interface) and returns true if
// the ray now travels inside the liquid (entering, or total internal reflection).
// mirror: trace the scene in the reflection (else the sky only).
fn liquidInterface(hp: vec3f, n0: vec3f, geometric: vec3f, entering: bool, id: i32, mirror: bool, ro: ptr<function, vec3f>, rd: ptr<function, vec3f>,
                   col: ptr<function, vec3f>, trans: ptr<function, vec3f>, mediumLight: ptr<function, vec3f>) -> bool {
  let ior = IOR(id);
  var n = liquidOpticalNormal(*rd, n0, geometric, entering, ior);
  if (entering) {
    if (dot(n, *rd) > 0.0) { n = -n; }
    let F = fresnelSchlick(-dot(n, *rd), ior);
    var ml = vec3f(1.0);
    if (FU.shadows != 0u) { ml = sunShadowAt(hp + n * IFACE_PROBE); }
    *mediumLight = ml;
    let r = reflect(*rd, n);
    let gi = surfProbe(hp, n);
    gSkyIn = skyInAt(gi);
    var env = envReflectGI(gi, n, -*rd, ROUGH(id), ml);
    var wr = 0.0;
    if (mirror) { wr = smoothstep(REFL_F_LO, REFL_F_HI, F); }
    if (wr > 0.0) { env = mix(env, reflectTrace(hp + n * REFL_START, r, env), wr); }
    *col += *trans * F * env;
    // a torch or lantern's highlight (lighting.js lampSpec: its own Fresnel, from the IOR's F0)
    if (FU.lampCount > 0) {
      let f0 = (1.0 - ior) / (1.0 + ior);
      *col += *trans * lampSpecSeen(hp, n, LampSpecIn(-*rd, ROUGH(id), vec3f(f0 * f0), vec3f(1.0, 0.0, 0.0), 0.0, true));
    }
    *trans *= 1.0 - F;
    let rt = refract(*rd, n, 1.0 / ior);
    *rd = rt;
    *ro = hp + rt * IFACE_NUDGE - geometric * IFACE_NUDGE;
    return true;
  }
  if (dot(n, *rd) < 0.0) { n = -n; }
  let rt = refract(*rd, -n, ior);
  if (dot(rt, rt) < 1e-6) {           // total internal reflection
    let rr = reflect(*rd, -n);
    *rd = rr;
    *ro = hp + rr * IFACE_NUDGE - geometric * IFACE_NUDGE;
    return true;
  }
  // Leaving, the face reflects Fx back inside. That light isn't lost: it
  // leaves the body elsewhere, showing what lies along the reflected ray, so
  // the face adds it as the glass panes' far faces do (render.js), from the
  // probe on the inner side (no sun highlight: the sun isn't seen from inside).
  let Fx = fresnelSchlick(dot(rt, n), ior);
  *col += *trans * Fx * envSky(surfProbe(hp, -n), reflect(*rd, n));
  *trans *= 1.0 - Fx;
  *rd = rt;
  *ro = hp + rt * IFACE_NUDGE + geometric * IFACE_NUDGE;
  return false;
}

// Source/Garry's Mod's glass rule: reflect the room, not a painted highlight.
// The transmitted ray crosses the analytic crystal and continues in the world.
fn crystalInterface(s: Shard, hp: vec3f, n: vec3f, rd: vec3f, inside: bool, liquid: i32, bend: bool, limit: f32,
                    T: f32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) -> CrystalPath {
  let eta = IOR(E_CRYSTAL) / select(IOR(liquid), 1.0, liquid == E_EMPTY);
  let path = crystalPath(s, hp, rd, n, eta, SIGMA(E_CRYSTAL) * mix(0.85, 1.15, s.seed), inside, bend, limit);
  let gi = surfProbe(hp, n);
  gSkyIn = skyInAt(gi);
  var sunVis = vec3f(1.0);
  if (FU.shadows != 0u) { sunVis = sunShadowAt(hp + n * IFACE_PROBE); }
  if (path.frontF > 0.0) {
    var env = envReflectGI(gi, n, -rd, ROUGH(E_CRYSTAL), sunVis);
    env = reflectTrace(hp + n * REFL_START, reflect(rd, n), env);
    *col += *trans * path.frontF * env;
    if (FU.lampCount > 0) {
      let f0 = pow((eta - 1.0) / (eta + 1.0), 2.0);
      let lit = lampShade(hp, n, n, true, LampSpecIn(-rd, ROUGH(E_CRYSTAL), vec3f(f0), s.u, 0.0, true));
      *col += *trans * lit.spec;
    }
  }
  *col += *trans * path.glow * interiorScatter(E_CRYSTAL, hp, sunVis, T);
  *trans *= path.through;
  return path;
}
`;
