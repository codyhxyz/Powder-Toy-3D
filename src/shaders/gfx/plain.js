// Plain view (hotkey 0): the original renderer, from before the smooth-surface
// pipeline (git 0b8c6ff). Every cell is a flat-coloured cube lit by the sun,
// sky and the glow of hot things, with corner AO and sun shadows. Liquids and
// glass tint what's behind them, gases are soft blobs and flames glow. It
// writes a finished colour (ACES curve applied here) and goes through post in
// raw mode, like the data views, so no bloom, exposure or film look.
import { ELEMENTS } from '../../elements.js';

// Liquid tints from the original renderer. The smooth renderer later retuned
// SIGMA for its own optics; elements not listed use SIGMA.
const PLAIN_SIGMA = {
  WATER: [0.30, 0.075, 0.035],
  OIL: [0.35, 0.55, 0.9],
  ACID: [0.45, 0.04, 0.55],
  ICE: [0.12, 0.05, 0.025],
};
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vec3 = (v) => `vec3(${v.map(f).join(', ')})`;
const sigmaGLSL = () =>
  `const vec3 PLAIN_SIGMA[NE] = vec3[NE](${ELEMENTS.map((e) => vec3(PLAIN_SIGMA[e.key] ?? e.sigma)).join(', ')});`;

export const plainGLSL = (g) => /* glsl */ `
${sigmaGLSL()}
#define PLAIN_SUN vec3(1.25, 1.15, 1.0)          // sun colour
#define PLAIN_SKY_LO vec3(0.05, 0.05, 0.06)      // sky gradient, horizon and below...
#define PLAIN_SKY_HI vec3(0.42, 0.52, 0.68)      // ...to straight up
#define PLAIN_AMB_DOWN vec3(0.07, 0.065, 0.06)   // sky fill on a face pointing down...
#define PLAIN_AMB_UP vec3(0.32, 0.38, 0.5)       // ...and pointing up
#define PLAIN_LOCAL_MIN 0.35                     // glow light reaching a fully occluded corner
#define PLAIN_HOT_FROM 350.0                     // °C: hot surfaces lose reflected light from here...
#define PLAIN_HOT_TO 1000.0                      // ...to here, where emission dominates
#define PLAIN_HOT_ALBEDO 0.2
#define PLAIN_GLOW_FROM 480.0                    // °C, glow fades in from here...
#define PLAIN_GLOW_TO 800.0                      // ...to here
#define PLAIN_GLOW_TK 1800.0                     // K, glow brightness ∝ (T/this)^4...
#define PLAIN_GLOW_GAIN 2.5
#define PLAIN_GLOW_BASE 0.08                     // ...plus this
#define PLAIN_LAVA_ALB vec3(0.05, 0.03, 0.02)    // lava's crust, lit only by its own glow
#define PLAIN_LAVA_FLICKER 0.15
#define PLAIN_LAVA_HZ 3.0
#define PLAIN_PLANT_VAR 0.4                      // extra leaf-to-leaf brightness spread
#define PLAIN_SPEC_METAL 48.0                    // specular exponent and strength
#define PLAIN_SPEC_METAL_K 0.8
#define PLAIN_SPEC_WALL 16.0
#define PLAIN_SPEC_WALL_K 0.08
#define PLAIN_F0_LIQUID 0.02                     // Fresnel at normal incidence
#define PLAIN_F0_GLASS 0.045
#define PLAIN_F_INSIDE 0.3                       // interface seen from inside another medium
#define PLAIN_GLINT_EXP 400.0
#define PLAIN_GLINT_GAIN 6.0
#define PLAIN_LIQ_NORMAL 0.6                     // occupancy gradient bends liquid normals this much
#define PLAIN_MEDIUM_AMB vec3(0.3, 0.35, 0.42)   // light inside liquids and glass
#define PLAIN_MEDIUM_SUN 0.6
#define PLAIN_SCATTER_LIQUID 0.55                // deep liquid reads as its own colour
#define PLAIN_SCATTER_GLASS 0.15
#define PLAIN_GAS_AMB vec3(0.3, 0.34, 0.4)
#define PLAIN_GAS_SUN 0.45
#define PLAIN_GAS_LONE 0.3                       // a lone gas cell is a faint wisp...
#define PLAIN_GAS_DENSE 3.0                      // ...a dense plume thick cloud
#define PLAIN_FIRE_GAIN 2.2
#define PLAIN_FIRE_T 1000.0
#define PLAIN_FIRE_LIFE 0.6                      // young flames glow brighter
#define PLAIN_FIRE_ABSORB 0.12
#define PLAIN_FLOOR_LO vec3(0.075, 0.078, 0.085) // floor tile and grid line
#define PLAIN_FLOOR_HI vec3(0.14, 0.15, 0.17)
#define PLAIN_FLOOR_AMB vec3(0.3, 0.35, 0.45)
#define PLAIN_FLOOR_GRID 8.0                     // cells per grid square
#define PLAIN_EXPOSURE 1.1
#define PLAIN_OPAQUE 0.01                        // stop once this little light gets through

vec3 plainSky(vec3 d) { return mix(PLAIN_SKY_LO, PLAIN_SKY_HI, smoothstep(0.2, 1.0, d.y * 0.5 + 0.5)); }

vec3 plainGlow(float tC) {
  float k = (tC + 273.15) / PLAIN_GLOW_TK;
  return blackbody(tC) * smoothstep(PLAIN_GLOW_FROM, PLAIN_GLOW_TO, tC) * (k * k * k * k * PLAIN_GLOW_GAIN + PLAIN_GLOW_BASE);
}

float plainOccupied(ivec3 c) {
  if (c.y < 0) return 1.0;
  if (outside(c)) return 0.0;
  int id = eid(fetchA(c));
  return (id == E_EMPTY || KIND[id] == K_GAS) ? 0.0 : 1.0;
}
// smooth-ish normal for liquid surfaces from the occupancy gradient
vec3 plainLiquidNormal(ivec3 c, vec3 faceN) {
  vec3 gr = vec3(
    plainOccupied(c + ivec3(1, 0, 0)) - plainOccupied(c - ivec3(1, 0, 0)),
    plainOccupied(c + ivec3(0, 1, 0)) - plainOccupied(c - ivec3(0, 1, 0)),
    plainOccupied(c + ivec3(0, 0, 1)) - plainOccupied(c - ivec3(0, 0, 1)));
  return normalize(faceN - gr * PLAIN_LIQ_NORMAL);
}

vec3 plainOpaque(ivec3 cell, int id, vec4 a, vec3 hp, vec3 n, vec3 rd) {
  float seed = fract(a.w), T = a.y;
  vec3 alb = COLOR[id] * (1.0 + COLORVAR[id] * (seed * 2.0 - 1.0));
  vec3 emit;
  if (id == E_LAVA) {
    alb = PLAIN_LAVA_ALB;
    emit = plainGlow(T) * (1.0 - PLAIN_LAVA_FLICKER + PLAIN_LAVA_FLICKER * sin(uTime * PLAIN_LAVA_HZ + seed * 40.0));
  } else {
    // hot surfaces read as glowing: the emission takes over from reflected light
    emit = plainGlow(T);
    alb *= mix(1.0, PLAIN_HOT_ALBEDO, smoothstep(PLAIN_HOT_FROM, PLAIN_HOT_TO, T));
  }
  if (id == E_PLANT) alb *= 1.0 - PLAIN_PLANT_VAR * 0.5 + PLAIN_PLANT_VAR * fract(seed * 7.3);
  float ndl = max(dot(n, uSun), 0.0);
  vec3 sh = (uShadows && ndl > 0.0) ? sunShadow(hp, n) : vec3(1.0);
  float ao = faceAO(cell, ivec3(n), hp);
  vec3 sky = mix(PLAIN_AMB_DOWN, PLAIN_AMB_UP, n.y * 0.5 + 0.5);
  vec3 local = sampleLight(hp + n * 0.75) * uLightGain;
  vec3 c = alb * (PLAIN_SUN * ndl * sh + sky * ao + local * (PLAIN_LOCAL_MIN + (1.0 - PLAIN_LOCAL_MIN) * ao));
  if (id == E_METAL || id == E_WALL) {
    vec3 hv = normalize(uSun - rd);
    bool metal = id == E_METAL;
    c += PLAIN_SUN * sh * pow(max(dot(n, hv), 0.0), metal ? PLAIN_SPEC_METAL : PLAIN_SPEC_WALL) * (metal ? PLAIN_SPEC_METAL_K : PLAIN_SPEC_WALL_K);
  }
  return c + emit;
}

vec3 plainFloor(vec3 hp) {
  vec2 q = hp.xz / PLAIN_FLOOR_GRID;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q) * uPixScale, vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  vec3 alb = mix(PLAIN_FLOOR_LO, PLAIN_FLOOR_HI, line);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 sh = uShadows ? sunShadow(hp, n) : vec3(1.0);
  float ao = faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp);
  vec3 local = sampleLight(vec3(hp.x, 0.5, hp.z)) * uLightGain;
  return alb * (PLAIN_SUN * max(uSun.y, 0.0) * sh + PLAIN_FLOOR_AMB * ao + local * (PLAIN_LOCAL_MIN + (1.0 - PLAIN_LOCAL_MIN) * ao));
}

void plainView(vec3 ro, vec3 rd, float t0, vec3 bh) {
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int ax = int(bh.z);

  vec3 col = vec3(0.0), trans = vec3(1.0);
  float tHit = -1.0;
  int prevId = E_EMPTY;
  vec3 mediumLight = vec3(1.0);
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;

  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) {
      ax = skipBrick(bc, ro, rd, istp, cell, tMax, tEnter);
      prevId = E_EMPTY;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    float seg = tExit - tEnter;
    vec4 a = fetchA(cell);
    int id = eid(a);
    vec3 n = vec3(0.0);
    n[ax] = -float(istp[ax]);

    if (id != E_EMPTY) {
      int rc = RCLASS[id];
      if (tHit < 0.0) tHit = tEnter;
      vec3 hp = ro + rd * tEnter;
      if (rc == R_OPAQUE) {
        col += trans * plainOpaque(cell, id, a, hp, n, rd);
        trans = vec3(0.0);
        break;
      } else if (rc == R_LIQUID || rc == R_GLASS) {
        if (id != prevId) {
          // interface: Fresnel reflection of the sky and a sun glint
          vec3 sn = rc == R_LIQUID ? plainLiquidNormal(cell, n) : n;
          if (dot(sn, rd) > 0.0) sn = n;
          float cosi = clamp(-dot(sn, rd), 0.0, 1.0);
          float f0 = rc == R_LIQUID ? PLAIN_F0_LIQUID : PLAIN_F0_GLASS;
          bool fromAir = prevId == E_EMPTY || KIND[prevId] == K_GAS;
          float F = (f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0)) * (fromAir ? 1.0 : PLAIN_F_INSIDE);
          vec3 r = reflect(rd, sn);
          mediumLight = uShadows ? sunShadow(hp, n) : vec3(1.0);
          col += trans * F * (plainSky(r) + PLAIN_SUN * mediumLight * pow(max(dot(r, uSun), 0.0), PLAIN_GLINT_EXP) * PLAIN_GLINT_GAIN);
          trans *= 1.0 - F;
        }
        vec3 att = exp(-PLAIN_SIGMA[id] * seg);
        vec3 amb = PLAIN_MEDIUM_AMB + PLAIN_SUN * mediumLight * max(uSun.y, 0.0) * PLAIN_MEDIUM_SUN + sampleLight(hp) * uLightGain;
        vec3 sc = COLOR[id] * amb * (rc == R_LIQUID ? PLAIN_SCATTER_LIQUID : PLAIN_SCATTER_GLASS) + plainGlow(a.y);
        col += trans * (1.0 - att) * sc;
        trans *= att;
      } else if (rc == R_GAS) {
        // a soft blob per gas cell: lone cells are faint wisps, plumes thick cloud
        float dens = (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0) * softBlob(cell, ro, rd, tEnter, tExit)
                   * (PLAIN_GAS_LONE + PLAIN_GAS_DENSE * brickGas(occ));
        float alpha = 1.0 - exp(-SIGMA[id].x * seg * dens);
        col += trans * alpha * COLOR[id] * (PLAIN_GAS_AMB + PLAIN_SUN * PLAIN_GAS_SUN + sampleLight(hp) * uLightGain);
        trans *= 1.0 - alpha;
      } else if (rc == R_FIRE) {
        float T = a.y;
        vec3 e = blackbody(T) * pow(T / PLAIN_FIRE_T, 2.0) * (1.0 - PLAIN_FIRE_LIFE + PLAIN_FIRE_LIFE * clamp(a.z, 0.0, 1.0))
               * PLAIN_FIRE_GAIN * softBlob(cell, ro, rd, tEnter, tExit);
        col += trans * e * seg;
        trans *= exp(-PLAIN_FIRE_ABSORB * seg);
      }
    }
    if (max(trans.x, max(trans.y, trans.z)) < PLAIN_OPAQUE) break;
    prevId = id;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }

  // floor of the box
  if (max(trans.x, max(trans.y, trans.z)) >= PLAIN_OPAQUE && cell.y < 0 && rd.y < 0.0) {
    float tf = -ro.y / rd.y;
    if (tHit < 0.0) tHit = tf;
    col += trans * plainFloor(ro + rd * tf);
    trans = vec3(0.0);
  }

  if (tHit < 0.0) discard;
  float alpha = 1.0 - dot(trans, vec3(1.0 / 3.0));
  // finished colour; post (raw) only encodes it to sRGB
  gl_FragColor = vec4(aces(col * PLAIN_EXPOSURE), alpha);
  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(ro + rd * tHit, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}
`;
