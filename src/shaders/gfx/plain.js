// Plain view (hotkey 0): the original renderer, from before the smooth-surface
// pipeline (git 0b8c6ff). Every cell is a flat-coloured cube lit by the sun,
// sky and the glow of hot things, with corner AO and sun shadows. Liquids and
// glass tint what's behind them, gases are soft blobs and flames glow. It
// writes a finished colour (ACES curve applied here) and goes through post in
// raw mode, like the data views, so no bloom, exposure or film look.
//
// WGSL (the names are the GLSL version's, docs/webgpu.md W2), after the
// render library and surfaceGLSL (floorFwidth, so surfView must have run, as
// the tracer runs it before choosing a view). Like the GLSL it calls
// softBlob(cell, ro, rd, t0, t1) -> f32 and aces(x) -> vec3f, which the
// tracer (shaders/render.js) defines, and meshCutT(rd) -> f32 (the distance
// along the eye ray to the nearest opaque mesh, gfx/meshCut.js: the march
// stops there; docs/webgpu.md Sync log S1) and the decoration's lookups
// decoAt, decoTint, decoLinear and DECO_SIGMA (shaders/gfx/deco.js
// decoViewGLSL), which the view pastes before it. A function can't discard
// for its caller, so plainView returns what it drew (PlainOut): the caller
// discards where nothing was hit and writes the colour and frag_depth. The
// depth is that of the first thing hit through FU.viewProj · FU.model, the
// jittered camera, in WebGPU's [0, 1] (docs/webgpu.md F2, F4).
import { ELEMENTS } from '../../elements.js';
import { materialChecks } from './surface.js';

// Liquid tints from the original renderer. The smooth renderer later retuned
// SIGMA for its own optics; elements not listed use SIGMA.
const PLAIN_SIGMA = {
  WATER: [0.30, 0.075, 0.035],
  OIL: [0.35, 0.55, 0.9],
  ACID: [0.9, 0.06, 1.2],   // Noita's lime (elements.js ACID): green through, the rest stopped fast
  ICE: [0.12, 0.05, 0.025],
};
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vec3 = (v) => `vec3f(${v.map(f).join(', ')})`;
// four elements, so a comparison chain rather than an NE-entry table (docs/webgpu.md C6)
const sigmaGLSL = () => `fn PLAIN_SIGMA(id: i32) -> vec3f {
${ELEMENTS.filter((e) => PLAIN_SIGMA[e.key]).map((e) => `  if (id == E_${e.key}) { return ${vec3(PLAIN_SIGMA[e.key])}; }`).join('\n')}
  return SIGMA(id);
}`;

// g: the grid (kept for the GLSL's signature; the march's bound is the library's MAX_STEPS)
export const plainGLSL = (g) => /* wgsl */ `
${sigmaGLSL()}
const PLAIN_SUN: vec3f = vec3f(1.25, 1.15, 1.0);          // sun colour
const PLAIN_SKY_LO: vec3f = vec3f(0.05, 0.05, 0.06);      // sky gradient, horizon and below...
const PLAIN_SKY_HI: vec3f = vec3f(0.42, 0.52, 0.68);      // ...to straight up
const PLAIN_AMB_DOWN: vec3f = vec3f(0.07, 0.065, 0.06);   // sky fill on a face pointing down...
const PLAIN_AMB_UP: vec3f = vec3f(0.32, 0.38, 0.5);       // ...and pointing up
const PLAIN_LOCAL_MIN: f32 = 0.35;                        // glow light reaching a fully occluded corner
const PLAIN_HOT_FROM: f32 = 350.0;                        // °C: hot surfaces lose reflected light from here...
const PLAIN_HOT_TO: f32 = 1000.0;                         // ...to here, where emission dominates
const PLAIN_HOT_ALBEDO: f32 = 0.2;
const PLAIN_GLOW_FROM: f32 = 480.0;                       // °C, glow fades in from here...
const PLAIN_GLOW_TO: f32 = 800.0;                         // ...to here
const PLAIN_GLOW_TK: f32 = 1800.0;                        // K, glow brightness ∝ (T/this)^4...
const PLAIN_GLOW_GAIN: f32 = 2.5;
const PLAIN_GLOW_BASE: f32 = 0.08;                        // ...plus this
const PLAIN_LAVA_ALB: vec3f = vec3f(0.05, 0.03, 0.02);    // lava's crust, lit only by its own glow
const PLAIN_LAVA_FLICKER: f32 = 0.15;
const PLAIN_LAVA_HZ: f32 = 3.0;
const PLAIN_PLANT_VAR: f32 = 0.4;                         // extra leaf-to-leaf brightness spread
const PLAIN_SPEC_METAL: f32 = 48.0;                       // specular exponent and strength
const PLAIN_SPEC_METAL_K: f32 = 0.8;
const PLAIN_SPEC_WALL: f32 = 16.0;
const PLAIN_SPEC_WALL_K: f32 = 0.08;
const PLAIN_F0_LIQUID: f32 = 0.02;                        // Fresnel at normal incidence
const PLAIN_F0_GLASS: f32 = 0.045;
const PLAIN_F_INSIDE: f32 = 0.3;                          // interface seen from inside another medium
const PLAIN_GLINT_EXP: f32 = 400.0;
const PLAIN_GLINT_GAIN: f32 = 6.0;
const PLAIN_LIQ_NORMAL: f32 = 0.6;                        // occupancy gradient bends liquid normals this much
const PLAIN_MEDIUM_AMB: vec3f = vec3f(0.3, 0.35, 0.42);   // light inside liquids and glass
const PLAIN_MEDIUM_SUN: f32 = 0.6;
const PLAIN_SCATTER_LIQUID: f32 = 0.55;                   // deep liquid reads as its own colour
const PLAIN_SCATTER_GLASS: f32 = 0.15;
const PLAIN_GAS_AMB: vec3f = vec3f(0.3, 0.34, 0.4);
const PLAIN_GAS_SUN: f32 = 0.45;
const PLAIN_GAS_LONE: f32 = 0.3;                          // a lone gas cell is a faint wisp...
const PLAIN_GAS_DENSE: f32 = 3.0;                         // ...a dense plume thick cloud
const PLAIN_FIRE_GAIN: f32 = 2.2;
const PLAIN_FIRE_T: f32 = 1000.0;
const PLAIN_FIRE_LIFE: f32 = 0.6;                         // young flames glow brighter
const PLAIN_FIRE_ABSORB: f32 = 0.12;
const PLAIN_FLOOR_LO: vec3f = vec3f(0.075, 0.078, 0.085); // floor tile and grid line
const PLAIN_FLOOR_HI: vec3f = vec3f(0.14, 0.15, 0.17);
const PLAIN_FLOOR_AMB: vec3f = vec3f(0.3, 0.35, 0.45);
const PLAIN_FLOOR_GRID: f32 = 8.0;                        // cells per grid square
const PLAIN_EXPOSURE: f32 = 1.1;
const PLAIN_OPAQUE: f32 = 0.01;                           // stop once this little light gets through

fn plainSky(d: vec3f) -> vec3f { return mix(PLAIN_SKY_LO, PLAIN_SKY_HI, smoothstep(0.2, 1.0, d.y * 0.5 + 0.5)); }

fn plainGlow(tC: f32) -> vec3f {
  let k = (tC + 273.15) / PLAIN_GLOW_TK;
  return blackbody(tC) * smoothstep(PLAIN_GLOW_FROM, PLAIN_GLOW_TO, tC) * (k * k * k * k * PLAIN_GLOW_GAIN + PLAIN_GLOW_BASE);
}
// what element id at tC gives off: this view's own thermal glow, plus the
// element's luminescence as the realistic view has it (gfx/materials.js emission)
fn plainEmit(id: i32, tC: f32) -> vec3f { return plainGlow(tC) + EMIT(id); }

fn plainOccupied(c: vec3i) -> f32 {
  if (c.y < 0) { return 1.0; }
  if (outside(c)) { return 0.0; }
  let id = eid(fetchA(c));
  return select(1.0, 0.0, id == E_EMPTY || KIND(id) == K_GAS);
}
// smooth-ish normal for liquid surfaces from the occupancy gradient
fn plainLiquidNormal(c: vec3i, faceN: vec3f) -> vec3f {
  let gr = vec3f(
    plainOccupied(c + vec3i(1, 0, 0)) - plainOccupied(c - vec3i(1, 0, 0)),
    plainOccupied(c + vec3i(0, 1, 0)) - plainOccupied(c - vec3i(0, 1, 0)),
    plainOccupied(c + vec3i(0, 0, 1)) - plainOccupied(c - vec3i(0, 0, 1)));
  return normalize(faceN - gr * PLAIN_LIQ_NORMAL);
}

fn plainOpaque(cell: vec3i, id: i32, a: vec4f, hp: vec3f, n: vec3f, rd: vec3f) -> vec3f {
  let seed = fract(a.w);
  let T = a.y;
  var alb = decoTint(COLOR(id) * (1.0 + COLORVAR(id) * (seed * 2.0 - 1.0)), COLOR(id), decoAt(cell));   // TPT's deco (gfx/deco.js)
  var emit: vec3f;
  if (id == E_LAVA) {
    alb = PLAIN_LAVA_ALB;
    emit = plainGlow(T) * (1.0 - PLAIN_LAVA_FLICKER + PLAIN_LAVA_FLICKER * sin(FU.time * PLAIN_LAVA_HZ + seed * 40.0));
  } else {
    // hot surfaces read as glowing: the emission takes over from reflected light
    emit = plainEmit(id, T);
    alb *= mix(1.0, PLAIN_HOT_ALBEDO, smoothstep(PLAIN_HOT_FROM, PLAIN_HOT_TO, T));
  }
  if (id == E_PLANT) { alb *= 1.0 - PLAIN_PLANT_VAR * 0.5 + PLAIN_PLANT_VAR * fract(seed * 7.3); }
  let ndl = max(dot(n, FU.sun), 0.0);
  var sh = vec3f(1.0);
  if (FU.shadows != 0u && ndl > 0.0) { sh = sunShadow(hp, n); }
  let ao = faceAO(cell, vec3i(n), hp);
  let sky = mix(PLAIN_AMB_DOWN, PLAIN_AMB_UP, n.y * 0.5 + 0.5);
  let local = sampleLight(hp + n * 0.75) * FU.lightGain;
  var lamps = vec3f(0.0);
  if (FU.lampCount > 0) { lamps = lampLight(hp, n, n); }   // a torch or lantern
  var c = alb * (PLAIN_SUN * ndl * sh + sky * ao + local * (PLAIN_LOCAL_MIN + (1.0 - PLAIN_LOCAL_MIN) * ao) + lamps);
  if (id == E_METAL || id == E_WALL) {
    let hv = normalize(FU.sun - rd);
    let metal = id == E_METAL;
    c += PLAIN_SUN * sh * pow(max(dot(n, hv), 0.0), select(PLAIN_SPEC_WALL, PLAIN_SPEC_METAL, metal))
       * select(PLAIN_SPEC_WALL_K, PLAIN_SPEC_METAL_K, metal);
  }
  return c + emit;
}

// rd: the ray, for the grid lines' analytic fwidth (surface.js floorFwidth)
fn plainFloor(hp: vec3f, rd: vec3f) -> vec3f {
  let q = worldPos(hp).xz / PLAIN_FLOOR_GRID;
  let gq = abs(fract(q - 0.5) - 0.5) / max(floorFwidth(hp, rd) / PLAIN_FLOOR_GRID, vec2f(1e-4));
  let line = 1.0 - min(min(gq.x, gq.y), 1.0);
  let alb = mix(PLAIN_FLOOR_LO, PLAIN_FLOOR_HI, line);
  let n = vec3f(0.0, 1.0, 0.0);
  var sh = vec3f(1.0);
  if (FU.shadows != 0u) { sh = sunShadow(hp, n); }
  let ao = faceAO(vec3i(i32(floor(hp.x)), -1, i32(floor(hp.z))), vec3i(0, 1, 0), hp);
  let local = sampleLight(vec3f(hp.x, 0.5, hp.z)) * FU.lightGain;
  var lamps = vec3f(0.0);
  if (FU.lampCount > 0) { lamps = lampLight(vec3f(hp.x, 0.0, hp.z), n, n); }
  return alb * (PLAIN_SUN * max(FU.sun.y, 0.0) * sh + PLAIN_FLOOR_AMB * ao + local * (PLAIN_LOCAL_MIN + (1.0 - PLAIN_LOCAL_MIN) * ao) + lamps);
}

// What plainView drew: the finished colour (ACES applied; alpha = 1 − the
// mean transmittance), the frag_depth of the first thing hit, and whether
// anything was (else the caller discards, as the GLSL did).
struct PlainOut {
  color: vec4f,
  depth: f32,
  hit: bool,
}

fn plainView(ro: vec3f, rd: vec3f, t0: f32, bh: vec3f) -> PlainOut {
  let istp = vec3i(sign(rd));
  let tDelta = abs(1.0 / rd);
  var cell = clamp(vec3i(floor(ro + rd * (t0 + 1e-4))), vec3i(0), GRID - 1);
  var tMax = (vec3f(cell) + step(vec3f(0.0), rd) - ro) / rd;
  var tEnter = t0;
  var ax = i32(bh.z);

  var col = vec3f(0.0);
  var trans = vec3f(1.0);
  var tHit = -1.0;
  var prevId = E_EMPTY;
  var mediumLight = vec3f(1.0);
  var lastB = vec3i(-1);
  var occ = 0u;
  let tCut = meshCutT(rd);   // the nearest opaque mesh (gfx/meshCut.js): the march stops there
  var cut = false;

  for (var i = 0; i < MAX_STEPS; i++) {
    if (outside(cell)) { break; }
    if (tEnter >= tCut) { cut = true; break; }
    let bc = cell / BS;
    if (any(bc != lastB)) { lastB = bc; occ = brickOcc(bc); }
    if (!brickMatter(occ)) {
      ax = skipBrick(bc, ro, rd, istp, &cell, &tMax, &tEnter);
      prevId = E_EMPTY;
      continue;
    }
    let tExit = min(tMax.x, min(tMax.y, tMax.z));
    let seg = min(tExit, tCut) - tEnter;
    let a = fetchA(cell);
    let id = eid(a);
    var n = vec3f(0.0);
    n[ax] = -f32(istp[ax]);

    if (id != E_EMPTY) {
      let rc = RCLASS(id);
      if (tHit < 0.0) { tHit = tEnter; }
      let hp = ro + rd * tEnter;
      if (rc == R_OPAQUE) {
        col += trans * plainOpaque(cell, id, a, hp, n, rd);
        trans = vec3f(0.0);
        break;
      } else if (rc == R_LIQUID || rc == R_GLASS) {
        if (id != prevId) {
          // interface: Fresnel reflection of the sky and a sun glint
          var sn = n;
          if (rc == R_LIQUID) { sn = plainLiquidNormal(cell, n); }
          if (dot(sn, rd) > 0.0) { sn = n; }
          let cosi = clamp(-dot(sn, rd), 0.0, 1.0);
          let f0 = select(PLAIN_F0_GLASS, PLAIN_F0_LIQUID, rc == R_LIQUID);
          let fromAir = prevId == E_EMPTY || KIND(prevId) == K_GAS;
          let F = (f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0)) * select(PLAIN_F_INSIDE, 1.0, fromAir);
          let r = reflect(rd, sn);
          mediumLight = vec3f(1.0);
          if (FU.shadows != 0u) { mediumLight = sunShadow(hp, n); }
          col += trans * F * (plainSky(r) + PLAIN_SUN * mediumLight * pow(max(dot(r, FU.sun), 0.0), PLAIN_GLINT_EXP) * PLAIN_GLINT_GAIN);
          trans *= 1.0 - F;
        }
        let dp = decoAt(cell);   // painted: the deco colour, and opaque by its alpha (gfx/deco.js)
        let att = exp(-mix(PLAIN_SIGMA(id), vec3f(DECO_SIGMA), dp.a) * seg);
        let amb = PLAIN_MEDIUM_AMB + PLAIN_SUN * mediumLight * max(FU.sun.y, 0.0) * PLAIN_MEDIUM_SUN + sampleLight(hp) * FU.lightGain;
        let sc = mix(COLOR(id), decoLinear(dp.rgb), dp.a) * amb * select(PLAIN_SCATTER_GLASS, PLAIN_SCATTER_LIQUID, rc == R_LIQUID) + plainEmit(id, a.y);
        col += trans * (1.0 - att) * sc;
        trans *= att;
      } else if (rc == R_GAS) {
        // a soft blob per gas cell: lone cells are faint wisps, plumes thick cloud
        let life = select(1.0, clamp(a.z, 0.0, 1.0), id == E_SMOKE);
        let dens = life * softBlob(cell, ro, rd, tEnter, tExit) * (PLAIN_GAS_LONE + PLAIN_GAS_DENSE * brickGas(occ));
        let alpha = 1.0 - exp(-SIGMA(id).x * seg * dens);
        col += trans * alpha * decoTint(COLOR(id), COLOR(id), decoAt(cell)) * (PLAIN_GAS_AMB + PLAIN_SUN * PLAIN_GAS_SUN + sampleLight(hp) * FU.lightGain);
        trans *= 1.0 - alpha;
      } else if (rc == R_FIRE) {
        let T = a.y;
        let e = blackbody(T) * pow(T / PLAIN_FIRE_T, 2.0) * (1.0 - PLAIN_FIRE_LIFE + PLAIN_FIRE_LIFE * clamp(a.z, 0.0, 1.0))
              * PLAIN_FIRE_GAIN * softBlob(cell, ro, rd, tEnter, tExit);
        col += trans * e * seg;
        trans *= exp(-PLAIN_FIRE_ABSORB * seg);
      }
    }
    if (max(trans.x, max(trans.y, trans.z)) < PLAIN_OPAQUE) { break; }
    prevId = id;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }

  // floor of the box
  if (!cut && max(trans.x, max(trans.y, trans.z)) >= PLAIN_OPAQUE && cell.y < 0 && rd.y < 0.0) {
    let tf = -ro.y / rd.y;
    if (tHit < 0.0) { tHit = tf; }
    col += trans * plainFloor(ro + rd * tf, rd);
    trans = vec3f(0.0);
  }

  var o: PlainOut;
  o.hit = tHit >= 0.0;
  let alpha = 1.0 - dot(trans, vec3f(1.0 / 3.0));
  // finished colour; post (raw) only encodes it to sRGB
  o.color = vec4f(aces(col * PLAIN_EXPOSURE), alpha);
  let clip = FU.viewProj * FU.model * vec4f(ro + rd * max(tHit, 0.0), 1.0);
  o.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  return o;
}
`;

/** tools/check-wgsl.mjs: the material probes (shaders/gfx/surface.js materialChecks) */
export const WGSL_CHECK = () => materialChecks('plain');
