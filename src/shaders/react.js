import { prelude } from './common.js';
import { quietGLSL } from './activity.js';
import { ELEMENTS } from '../elements.js';

// The softest breakable solid: a cell carrying less kinetic energy than this
// can't break anything, which lets almost every cell skip the impact check.
const HARD_MIN = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));

// React pass: everything that only changes a cell in place, using its six
// face neighbours.
//   - Heat conduction. Flux between two cells uses min(cond_a, cond_b), so it
//     is symmetric and total energy (Σ cap·T) is conserved; dividing by the
//     cell's own heat capacity gives the temperature change.
//   - Phase changes with latent heat. Water/ice/steam pin their temperature
//     at the transition point and bank the excess energy in an accumulator
//     until a full latent heat has been absorbed (or released). Ice in water
//     holds it at 0°C, a pot boils at 100°C, steam rains back out.
//   - Combustion: flammables above their ignition temperature that touch air
//     burn fuel, release heat and spawn flames into adjacent air.
//   - Air pressure: diffuses through non-solid cells, and a shock front also
//     propagates one cell per step with exponential falloff (each cell takes
//     at least a decayed copy of its strongest open neighbour). Plain
//     diffusion would need ~L² steps to get through a sand pile; the front
//     gets there in L steps. Walls block it. The gradient accelerates matter
//     (a = -∇P / ρ), so explosions throw things outward.
//   - Forces: gravity, buoyancy (hot air rises), drag, brownian jitter.
//   - Breaking. A breakable solid (elements.js hard/breakInto) turns into its
//     debris when a neighbour runs into it carrying at least `hard` kinetic
//     energy along that axis (½·ρ·vn², vn its velocity toward the solid), or
//     when the air pressure difference across it exceeds hard·P_BREAK_PER_HARD.
//     The solid and the projectile evaluate the same predicate on the same
//     input (this pass's input state), so both sides agree without a race:
//     the projectile pays `hard` out of its kinetic energy and then hits the
//     loose debris (the move pass's collision rule), and the debris takes that
//     momentum and the fracture work as heat. The move pass that runs before
//     this one leaves a projectile that can break what it's touching unbounced
//     (move.js), so it reaches this check with its velocity intact.
export const reactFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
uniform uint uFrame;
uniform float uGravity;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
${quietGLSL}

const ivec3 DIRS[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));

// Latent heat bookkeeping. acc is energy banked toward a transition at Tp.
// rising: transition happens when heated past Tp (melting, boiling).
#define HARD_MIN ${HARD_MIN.toFixed(1)}   // the softest breakable solid's hardness

// Kinetic energy a cell (id, T, v) carries along the unit axis n: ½·ρ·vn², or
// 0 when it is moving away or can't move.
float impactKE(int id, float T, vec3 v, vec3 n) {
  float vn = dot(v, n);
  return movable(id) && vn > 0.0 ? 0.5 * densityOf(id, T) * vn * vn : 0.0;
}

// A projectile (density m, speed u along the axis) breaks a solid of hardness
// H into debris of density M. The fracture takes H of its kinetic energy, then
// it hits the loose debris head on with the move pass's collision rule
// (move.js collide). Returns the projectile's speed along the axis and the
// debris's, both afterwards.
vec2 shatter(float m, float u, float H, float M) {
  float u1 = sqrt(max(u * u - 2.0 * H / m, 0.0));
  if (u1 <= COLLIDE_V) return vec2(u1, 0.0);   // slow contact: the debris just supports it
  float inv = 1.0 / (m + M), vc = m * u1 * inv;
  return vec2(vc - RESTITUTION * M * inv * u1, min(vc + RESTITUTION * m * inv * u1, V_MAX));
}

bool latent(inout float T, inout float acc, float Tp, float C, float L, bool rising) {
  if (rising) {
    if (T > Tp) { acc += (T - Tp) * C; T = Tp; }
    else if (acc > 0.0) { float r = min(acc, (Tp - T) * C); acc -= r; T += r / C; }
  } else {
    if (T < Tp) { acc += (Tp - T) * C; T = Tp; }
    else if (acc > 0.0) { float r = min(acc, (T - Tp) * C); acc -= r; T -= r / C; }
  }
  return acc >= L;
}

void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (p.y >= NY) { oA = vec4(0.0); oB = vec4(0.0); return; }

  vec4 a = texelFetch(tA, atlas(p), 0);
  vec4 b = texelFetch(tB, atlas(p), 0);
  // quiet brick (shaders/activity.js): nothing here can change, keep it as is
  if (quietCell(p)) { oA = a; oB = b; return; }
  int id = eid(a);
  float T = a.y, life = a.z;
  float ctype = floor(a.w), seed = fract(a.w);
  vec3 v = b.xyz;
  float P0 = b.w;
  uint rs = seed3(p, uFrame, 0x7au);

  vec4 na[6];
  vec4 nb[6];
  int nid[6];
  for (int i = 0; i < 6; i++) {
    ivec3 q = p + DIRS[i];
    if (inGrid(q)) {
      na[i] = texelFetch(tA, atlas(q), 0);
      nb[i] = texelFetch(tB, atlas(q), 0);
    } else {
      na[i] = vec4(float(E_WALL), T, 0.0, 0.0); // insulating, pressure-reflecting box
      nb[i] = vec4(0.0, 0.0, 0.0, P0);
    }
    nid[i] = eid(na[i]);
  }

  // ---- breaking (impacts and blasts), from this pass's input state ----
  // As a projectile: every breakable neighbour I hit hard enough breaks, and
  // each costs me its hardness, then a collision with its debris.
  vec3 dvBreak = vec3(0.0);
  if (movable(id) && 0.5 * densityOf(id, a.y) * dot(b.xyz, b.xyz) >= HARD_MIN) {
    float m = densityOf(id, a.y);
    for (int i = 0; i < 6; i++) {
      int s = nid[i];
      if (BREAKINTO[s] < 0) continue;
      vec3 n = vec3(DIRS[i]);
      if (impactKE(id, a.y, b.xyz, n) < HARD[s]) continue;
      float u = dot(b.xyz, n);
      dvBreak -= n * (u - shatter(m, u, HARD[s], densityOf(BREAKINTO[s], a.y)).x);
    }
  }
  // As a breakable solid: the same test from my side. Every neighbour that
  // hits me hard enough pays my hardness, so the fracture work I get as heat is
  // one hardness per hit, and the debris takes each hit's momentum.
  bool broke = false;
  float fractureE = 0.0;   // kinetic energy dissipated breaking me
  vec3 vDebris = vec3(0.0);
  if (BREAKINTO[id] >= 0) {
    float M = densityOf(BREAKINTO[id], a.y);
    for (int i = 0; i < 6; i++) {
      vec3 n = -vec3(DIRS[i]);   // from the neighbour toward me
      if (impactKE(nid[i], na[i].y, nb[i].xyz, n) < HARD[id]) continue;
      float u = dot(nb[i].xyz, n);
      vDebris += n * shatter(densityOf(nid[i], na[i].y), u, HARD[id], M).y;
      fractureE += HARD[id];
      broke = true;
    }
    // a blast: the pressure difference across me along any axis (solid
    // neighbours hold no air: 0)
    float pa[6];
    for (int i = 0; i < 6; i++) pa[i] = KIND[nid[i]] != K_SOLID ? nb[i].w : 0.0;
    float dP = max(abs(pa[0] - pa[1]), max(abs(pa[2] - pa[3]), abs(pa[4] - pa[5])));
    if (dP > HARD[id] * P_BREAK_PER_HARD) broke = true;
  }

  // ---- heat conduction (energy conserving) ----
  float C = CAP[id];
  float dE = 0.0;
  for (int i = 0; i < 6; i++) dE += min(COND[id], COND[nid[i]]) * (na[i].y - T);
  T += dE / C;
  // the open world above the box slowly pulls air back to ambient; gases radiate
  T += (AMBIENT - T) * (id == E_EMPTY ? AIR_AMBIENT_PULL : RAD[id]);

  // ---- air pressure ----
  bool solid = KIND[id] == K_SOLID;
  float P = P0;
  vec3 gradP = vec3(0.0);
  if (!solid) {
    float lap = 0.0, front = 0.0;
    float pn[6];
    for (int i = 0; i < 6; i++) {
      bool open = KIND[nid[i]] != K_SOLID;
      pn[i] = open ? nb[i].w : P0;   // walls reflect pressure
      lap += pn[i] - P0;
      front = max(front, pn[i]);
    }
    P = max(P0 + P_DIFFUSE * lap, front * P_FRONT) * P_DECAY;
    gradP = 0.5 * vec3(pn[0] - pn[1], pn[2] - pn[3], pn[4] - pn[5]);
  } else {
    P = 0.0;
  }

  // ---- forces ----
  if (!solid) {
    float rho = max(densityOf(id, T) * RHO_SCALE, RHO_MIN);
    v -= gradP * P_ACCEL / rho;
    if (id == E_EMPTY) v.y += uGravity * clamp((T - AMBIENT) / (AMBIENT + KELVIN), AIR_BUOY_LO, AIR_BUOY_HI);
    else v.y -= uGravity * GRAV[id];
    v *= 1.0 - DRAG[id];
    // grains only feel friction while resting on something
    bool supported = p.y == 0 || KIND[nid[3]] == K_SOLID || KIND[nid[3]] == K_POWDER;
    if (supported) v.xz *= 1.0 - FRICTION[id];

    // Liquids: hydrostatic head drives spreading, surface tension stops it.
    if (KIND[id] == K_LIQUID && (supported || KIND[nid[3]] == K_LIQUID)) {
      int up = nid[2];
      bool head = KIND[up] == K_LIQUID || KIND[up] == K_POWDER;   // weight above us
      bool onLiquid = !supported;                                  // surface of a pool
      float f = FLOW[id];
      float hv = length(v.xz);
      if (head || onLiquid) {
        // keep flowing in some direction until the level evens out
        float want = head ? f : f * FLOW_SURFACE;
        if (hv < want * FLOW_KICK) {
          float ang = rnd(rs) * 6.2831853;
          v.xz = vec2(cos(ang), sin(ang)) * want;
        }
      } else {
        // a thin film on dry ground: cohesion pulls it toward neighbouring
        // liquid, so films gather into puddles with clean edges
        vec2 coh = vec2(0.0);
        if (KIND[nid[0]] == K_LIQUID) coh.x += 1.0;
        if (KIND[nid[1]] == K_LIQUID) coh.x -= 1.0;
        if (KIND[nid[4]] == K_LIQUID) coh.y += 1.0;
        if (KIND[nid[5]] == K_LIQUID) coh.y -= 1.0;
        bool alone = KIND[nid[0]] != K_LIQUID && KIND[nid[1]] != K_LIQUID
                  && KIND[nid[4]] != K_LIQUID && KIND[nid[5]] != K_LIQUID;
        v.xz = v.xz * FILM_KEEP + coh * f * FILM_COHESION;
        if (alone && rnd(rs) < DROPLET_WANDER) {
          // isolated droplets wander until they meet others
          float ang = rnd(rs) * 6.2831853;
          v.xz = vec2(cos(ang), sin(ang)) * f * DROPLET_SPEED;
        }
      }
    }
    if (JITTER[id] > 0.0) v += (vec3(rnd(rs), rnd(rs), rnd(rs)) - 0.5) * JITTER[id];
    v += dvBreak;
    v = clamp(v, -V_MAX, V_MAX);
  } else {
    v = vec3(0.0);
  }

  // ---- reactions & phase changes ----
  int nidOut = id;
  bool reset = false;   // new element: take its spawn life

  int nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0;
  float flame = 0.0;
  int cloneOf = 0;
  for (int i = 0; i < 6; i++) {
    int j = nid[i];
    if (j == E_EMPTY) nAir++;
    if (j == E_FIRE) nFire++;
    if (j == E_ACID) nAcid++;
    if (j == E_PLANT) nPlant++;
    if (j == E_CLONE && na[i].w >= 1.0) cloneOf = int(floor(na[i].w));
    if (IGNITE[j] > 0.0 && j != E_GUNPOWDER && na[i].y >= IGNITE[j]) { nBurning++; flame = max(flame, FLAMET[j]); }
  }

  if (broke) {
    // debris keeps my temperature, life (fuel, banked latent heat) and ctype,
    // takes the fracture work as heat and flies off with the hits' momentum;
    // it reacts as itself from the next step
    nidOut = BREAKINTO[id];
    T += fractureE * KE_TO_HEAT / CAP[nidOut];
    v = clamp(vDebris, -V_MAX, V_MAX);
  } else if (id == E_WATER) {
    // signed accumulator: + toward boiling, - toward freezing
    float up = max(life, 0.0), dn = max(-life, 0.0);
    bool boil = latent(T, up, 100.0, C, L_BOIL, true);
    bool freeze = latent(T, dn, 0.0, C, L_FUSE, false);
    life = up - dn;
    if (boil) { nidOut = E_STEAM; life = 0.0; P += STEAM_BOIL_PUFF; }
    else if (freeze) { nidOut = E_ICE; life = 0.0; }
    if (nPlant > 0 && rnd(rs) < PLANT_GROW * float(nPlant)) { nidOut = E_PLANT; reset = true; }
  } else if (id == E_ICE || id == E_SNOW) {
    if (latent(T, life, 0.0, C, L_FUSE, true)) { nidOut = E_WATER; life = 0.0; }
  } else if (id == E_STEAM) {
    if (latent(T, life, 100.0, C, L_BOIL, false)) { nidOut = E_WATER; life = 0.0; }
  } else if (id == E_LAVA) {
    int ct = int(ctype);
    if (ct <= 0 || ct >= NE) ct = E_STONE;
    if (T < MELT[ct] - LAVA_FREEZE_BELOW) { nidOut = ct; reset = true; ctype = 0.0; }
  } else if (id == E_FIRE) {
    life -= FIRE_BURN + FIRE_BURN_SPREAD * rnd(rs);
    if (life <= 0.0 || T < FIRE_MIN_T) { nidOut = rnd(rs) < FIRE_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true; }
  } else if (id == E_SMOKE) {
    life -= SMOKE_FADE;
    if (life <= 0.0) { nidOut = E_EMPTY; reset = true; }
  } else if (id == E_ACID) {
    int victims = 0;
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (j != E_EMPTY && j != E_ACID && j != E_WALL && j != E_GLASS && j != E_SHARDS && j != E_WATER
          && KIND[j] != K_GAS) victims++;
    }
    life -= ACID_USE * float(victims);
    if (life <= 0.0) { nidOut = rnd(rs) < ACID_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true; }
  } else if (id == E_EMPTY) {
    // flames lick out of anything burning next to us
    if (nBurning > 0 && rnd(rs) < FLAME_SPREAD * float(nBurning)) {
      nidOut = E_FIRE; reset = true; T = max(T, flame * (FLAME_T_MIN + FLAME_T_SPREAD * rnd(rs)));
    } else if (cloneOf > 0 && rnd(rs) < CLONE_RATE) {
      nidOut = cloneOf; reset = true; T = SPAWNT[cloneOf];
      ctype = cloneOf == E_LAVA ? float(E_STONE) : 0.0;
      v = vec3(0.0, KIND[cloneOf] == K_GAS ? 0.0 : SPAWN_DROP_V, 0.0);
    }
  } else if (id == E_CLONE && ctype < 1.0) {
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (j != E_EMPTY && j != E_WALL && j != E_CLONE) { ctype = float(j); break; }
    }
  }

  // melting (stone, sand, metal, glass → lava that remembers what it was)
  if (nidOut == id && MELT[id] > 0.0 && T > MELT[id]) {
    nidOut = E_LAVA; ctype = float(MELTINTO[id]); life = 0.0;
  }

  // combustion
  if (nidOut == id && IGNITE[id] > 0.0) {
    if (id == E_GUNPOWDER) {
      // It goes off at its ignition point, or the moment it touches something
      // that hot (an ember, hot metal, lava, a splinter heated by a shot); a
      // flame's touch flickers, so a flame next to it only might.
      bool hotTouch = false;
      for (int i = 0; i < 6; i++) hotTouch = hotTouch || (!isGasLike(nid[i]) && na[i].y >= IGNITE[id]);
      if (T >= IGNITE[id] || hotTouch || (nFire > 0 && rnd(rs) < GUNPOWDER_FIRE)) {
        nidOut = E_FIRE; reset = true; T = GUNPOWDER_T; P += GUNPOWDER_P;
      }
    } else if (T >= IGNITE[id] && (nAir > 0 || nFire > 0)) {
      life -= BURNRATE[id];
      T = max(T, min(T + BURNHEAT[id] / C, FLAMET[id]));
      P += BURN_P;
      if (life <= 0.0) {
        nidOut = (id != E_OIL && rnd(rs) < ASH_SHARE) ? E_ASH : E_FIRE;
        reset = true;
        T = max(T, BURNT_MIN_T);
      }
    }
  }

  // acid eats its neighbours
  if (nidOut == id && nAcid > 0 && id != E_EMPTY && id != E_ACID && id != E_WALL && id != E_GLASS
      && id != E_SHARDS && id != E_WATER && KIND[id] != K_GAS) {
    if (rnd(rs) < ACID_USE * float(nAcid)) { nidOut = rnd(rs) < ACID_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true; }
  }

  if (nidOut != id) {
    if (reset) life = SPAWNLIFE[nidOut];
    if (KIND[nidOut] == K_SOLID) v = vec3(0.0);
    if (nidOut == E_FIRE) life = FIRE_LIFE_MIN + FIRE_LIFE_SPREAD * rnd(rs);
  }

  T = clamp(T, CELL_TEMP_MIN, CELL_TEMP_MAX);
  oA = vec4(float(nidOut), T, life, ctype + seed);
  oB = vec4(v, clamp(P, P_MIN, P_MAX));
}
`;
