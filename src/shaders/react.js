import { prelude, stateOutGLSL } from './common.js';
import { quietGLSL, inertNearGLSL } from './activity.js';
import { ELEMENTS } from '../elements.js';
import { electricReactGLSL } from '../electricity.js';

// The softest breakable solid: a cell carrying less kinetic energy than this
// can't break anything, which lets almost every cell skip the impact check.
const HARD_MIN = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));

// React pass: everything that only changes a cell in place, using its six
// face neighbours.
//   - Heat conduction. Flux between two cells uses min(cond_a, cond_b), so it
//     is symmetric and total energy (Σ cap·T) is conserved; dividing by the
//     cell's own heat capacity gives the temperature change. Each face's flux
//     is capped (physics.js COND_FLUX_SHARE), so whatever an element's
//     cond/cap, a cell never overshoots its neighbours' temperatures.
//   - Phase changes with latent heat. Water/ice/steam pin their temperature
//     at the transition point and bank the excess energy in an accumulator
//     until a full latent heat has been absorbed (or released). Ice in water
//     holds it at 0°C, a pot boils at 100°C. Steam condenses into water on a
//     surface and into cloud in open air; cloud boils back to steam, freezes
//     into snow, rains where it is thick and evaporates at its edges.
//   - Combustion: flammables above their ignition temperature that touch air
//     burn fuel, release heat and spawn flames into adjacent air; with a flame
//     touching them, from their flash point.
//   - Growth: plant grows into water; moss creeps over damp bare rock and
//     fungus rots damp wood, sawdust and plant (activity.js growers). Each
//     moss or fungus cell first updates its damp (its ctype).
//   - Air pressure: diffuses through non-solid cells, and a shock front also
//     propagates one cell per step with exponential falloff (each cell takes
//     at least a decayed copy of its strongest open neighbour). Plain
//     diffusion would need ~L² steps to get through a sand pile; the front
//     gets there in L steps. Walls block it. The gradient accelerates matter
//     (a = -∇P / ρ), so explosions throw things outward.
//   - Forces: gravity, buoyancy (hot air rises), drag, brownian jitter. A
//     powder or liquid at rest on what's below it feels a normal force that
//     cancels gravity, and liquids are only pushed sideways where they can
//     go, so resting matter comes to a full stop: a fixed point the activity
//     map can skip (activity.js).
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
//   - Electricity (src/electricity.js): sparks hop between conductors, one
//     face a step, losing what each cell's resistance costs and heating it;
//     batteries and sensors start them, switches gate them.
//   - The activity flags (shaders/common.js FLAG): the rest test on the cell's
//     new state, its neighbours as this pass saw them (activity.js).
export const reactFrag = (g) => /* glsl */ `
${prelude(g)}
uniform uint uFrame;
uniform float uGravity;
// What fast particles left in each cell this step (raysLayer.js, docs/particles.md):
// heat (energy) and air pressure, in a target laid out like the state.
uniform sampler2D tRayDep;
uniform bool uRays;
${stateOutGLSL}
${quietGLSL}
${inertNearGLSL}
${electricReactGLSL}

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

// Heat flowing into a cell (id a at Ta) from a face neighbour (b at Tb) per
// step: min(cond_a, cond_b)·ΔT, capped at a share of the energy that would
// bring the smaller-capacity cell to the other's temperature (physics.js
// COND_FLUX_SHARE). Flux and cap are symmetric in the pair, so what one cell
// gains the other loses.
float condFlux(int a, float Ta, int b, float Tb) {
  float dT = Tb - Ta;
  float lim = abs(dT) * min(CAP[a], CAP[b]) * COND_FLUX_SHARE;
  return clamp(min(COND[a], COND[b]) * dT, -lim, lim);
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
  if (!inGrid(p)) { writeState(vec4(0.0), vec4(0.0), 0u); return; }   // a texel holding no cell

  vec4 a = fetchA(p);
  vec4 b = fetchB(p);
  uint dirty = fetchF(p) & FLAG_DIRTY;   // the move pass's mark (shaders/common.js nearChange)
  // quiet brick (shaders/activity.js): nothing here can change, keep it as is.
  // Its cells were inert when the activity map was built, so their neighbour
  // tests passed then, and still do unless something around them is dirty.
  vec2 rayDep = uRays ? texelFetch(tRayDep, atlas(p), 0).xy : vec2(0.0);
  if (quietCell(p) && rayDep == vec2(0.0)) { writeState(a, b, ownFlags(a, b) | FLAG_NEAR | dirty); return; }
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
      na[i] = fetchA(q);
      nb[i] = fetchB(q);
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
  for (int i = 0; i < 6; i++) dE += condFlux(id, T, nid[i], na[i].y);
  T += (dE + rayDep.x) / C;   // (and what particles left: photons absorbed, fissions)
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
    P = max(P0 + P_DIFFUSE * lap, front * P_FRONT) * P_DECAY + rayDep.y;
    gradP = 0.5 * vec3(pn[0] - pn[1], pn[2] - pn[3], pn[4] - pn[5]);
  } else {
    P = 0.0;
  }

  // ---- forces ----
  if (!solid) {
    float rho = max(densityOf(id, T) * RHO_SCALE, RHO_MIN);
    v -= gradP * P_ACCEL / rho;
    // air, and cloud (air carrying droplets), is buoyant by its temperature
    if (id == E_EMPTY || id == E_CLOUD) v.y += uGravity * clamp((T - AMBIENT) / (AMBIENT + KELVIN), AIR_BUOY_LO, AIR_BUOY_HI);
    if (id != E_EMPTY) v.y -= uGravity * GRAV[id];
    v *= 1.0 - DRAG[id];
    // Normal force: a powder or liquid at rest on what it can't push aside
    // (the floor, a solid, or a grain or liquid that isn't falling itself) is
    // held up, so gravity can't start it moving down. One already moving down
    // (falling, landing, knocked from above) isn't at rest: it keeps feeling
    // gravity, and the move pass lands it with its splash, scatter and heat.
    float d = densityOf(id, a.y);
    bool held = (KIND[id] == K_POWDER || KIND[id] == K_LIQUID) && b.y >= 0.0 && (p.y == 0 || KIND[nid[3]] == K_SOLID
      || (!canMove(id, nid[3], d, densityOf(nid[3], na[3].y), 0) && nb[3].y >= 0.0));
    if (held) v.y = max(v.y, 0.0);
    // grains only feel friction while resting on something
    bool supported = p.y == 0 || KIND[nid[3]] == K_SOLID || KIND[nid[3]] == K_POWDER;
    if (supported) v.xz *= 1.0 - FRICTION[id];

    // Liquids: hydrostatic head drives spreading, surface tension stops it.
    // Both push only a liquid that has somewhere to go, a side neighbour it
    // can move into; boxed in, its speed just decays to a stop. (A lower
    // diagonal needs no push: the move pass topples into it regardless.)
    if (KIND[id] == K_LIQUID && (supported || KIND[nid[3]] == K_LIQUID)) {
      bool open = false;
      for (int i = 0; i < 6; i++)
        if (DIRS[i].y == 0) open = open || canMove(id, nid[i], d, densityOf(nid[i], na[i].y), 2);
      int up = nid[2];
      bool head = KIND[up] == K_LIQUID || KIND[up] == K_POWDER;   // weight above us
      bool onLiquid = !supported;                                  // surface of a pool
      float f = FLOW[id];
      float hv = length(v.xz);
      if (head || onLiquid) {
        // keep flowing in some direction until the level evens out
        float want = head ? f : f * FLOW_SURFACE;
        if (open && hv < want * FLOW_KICK) {
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
        v.xz = v.xz * FILM_KEEP + (open ? coh * f * FILM_COHESION : vec2(0.0));
        if (open && alone && rnd(rs) < DROPLET_WANDER) {
          // isolated droplets wander until they meet others
          float ang = rnd(rs) * 6.2831853;
          v.xz = vec2(cos(ang), sin(ang)) * f * DROPLET_SPEED;
        }
      }
    }
    if (JITTER[id] > 0.0) v += (vec3(rnd(rs), rnd(rs), rnd(rs)) - 0.5) * JITTER[id];
    v += dvBreak;
    v = clamp(v, -V_MAX, V_MAX);
    // a held cell's leftover creep stops dead (physics.js REST_V)
    if (held) v *= step(REST_V, abs(v));
  } else {
    v = vec3(0.0);
  }

  // ---- electricity: sparks, switches, sensors (src/electricity.js) ----
  electric(id, T, life, ctype, na, nid, rs);

  // ---- reactions & phase changes ----
  int nidOut = id;
  bool reset = false;   // new element: take its spawn life

  int nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0, nCloud = 0;
  int nWetMoss = 0, nWetFungus = 0, nFlash = 0;
  float flashFlame = 0.0;
  bvec3 wetMoss = bvec3(false), bed = bvec3(false);   // axes holding damp moss, bare rock (mossSite)
  float flame = 0.0;
  int cloneOf = 0;
  bool surface = false;   // a non-gas neighbour to condense onto (the box's floor counts, its sides and lid don't)
  for (int i = 0; i < 6; i++) {
    int j = nid[i];
    bool wet = floor(na[i].w) >= 1.0;
    if (j == E_MOSS && wet) { nWetMoss++; wetMoss[i >> 1] = true; }
    if (j == E_FUNGUS && wet) nWetFungus++;
    if (mossBed(j)) bed[i >> 1] = true;
    if (j == E_EMPTY) nAir++;
    if (j == E_CLOUD) nCloud++;
    if (!isGasLike(j) && (inGrid(p + DIRS[i]) || i == 3)) surface = true;
    if (j == E_FIRE) nFire++;
    if (j == E_ACID) nAcid++;
    if (j == E_PLANT) nPlant++;
    if ((j == E_CLONE || (j == E_PCLN && na[i].z == SWITCH_ON)) && na[i].w >= 1.0) cloneOf = int(floor(na[i].w));   // a powered clone only while on
    if (IGNITE[j] > 0.0 && j != E_GUNPOWDER && na[i].y >= IGNITE[j]) { nBurning++; flame = max(flame, FLAMET[j]); }
    else if (FLASH[j] < IGNITE[j] && na[i].y >= FLASH[j]) { nFlash++; flashFlame = max(flashFlame, FLAMET[j]); }
  }
  // past its flash point a fuel's vapour carries a flame along it: air
  // touching a flame and such a fuel catches as if the fuel were burning
  if (nFire > 0 && nFlash > 0) { nBurning += nFlash; flame = max(flame, flashFlame); }

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
    if (latent(T, life, 100.0, C, L_BOIL, false)) { nidOut = surface ? E_WATER : E_CLOUD; life = 0.0; }
  } else if (id == E_CLOUD) {
    // liquid water, as droplets: the same latent heats as a pool (signed accumulator)
    float up = max(life, 0.0), dn = max(-life, 0.0);
    bool boil = latent(T, up, 100.0, C, L_BOIL, true);
    bool freeze = latent(T, dn, 0.0, C, L_FUSE, false);
    life = up - dn;
    if (boil) { nidOut = E_STEAM; life = 0.0; }
    else if (freeze) { nidOut = E_SNOW; life = 0.0; }
    else {
      // thick cloud coalesces into raindrops; the edges evaporate into the
      // unsaturated air, the faster the warmer (saturation vapour pressure)
      float rain = CLOUD_RAIN * max(float(nCloud) - CLOUD_RAIN_NB, 0.0);
      float es = exp(MAGNUS_A * (T / (T + MAGNUS_B) - AMBIENT / (AMBIENT + MAGNUS_B)));
      float r = rnd(rs);
      if (r < rain) { nidOut = E_WATER; life = 0.0; }
      else if (r < rain + CLOUD_EVAP * max(float(nAir) - CLOUD_EVAP_NB, 0.0) * es) { nidOut = E_EMPTY; reset = true; T -= CLOUD_EVAP_COOL; }
    }
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
    for (int i = 0; i < 6; i++) if (acidEats(nid[i])) victims++;
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
    } else if (nWetMoss > 0 && mossSite(wetMoss, bed) && rnd(rs) < MOSS_GROW * float(nWetMoss)) {
      nidOut = E_MOSS; reset = true; ctype = 0.0;   // its damp comes in next step
    }
  } else if (id == E_MOSS || id == E_FUNGUS) {
    ctype = dampOf(T, na);
  } else if ((id == E_CLONE || id == E_PCLN) && ctype < 1.0) {
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (cloneable(j)) { ctype = float(j); break; }
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
    } else if ((T >= IGNITE[id] || (nFire > 0 && T >= FLASH[id])) && (nAir > 0 || nFire > 0)) {
      life -= BURNRATE[id];
      T = max(T, min(T + BURNHEAT[id] / C, FLAMET[id]));
      P += BURN_P;
      if (life <= 0.0) {
        nidOut = (LEAVES_ASH[id] && rnd(rs) < ASH_SHARE) ? E_ASH : E_FIRE;
        reset = true;
        T = max(T, BURNT_MIN_T);
      }
    }
  }

  // damp fungus rots wood, sawdust and plant into more fungus
  if (nidOut == id && nWetFungus > 0 && fungusFood(id) && T < DAMP_DRY_T && rnd(rs) < FUNGUS_GROW * float(nWetFungus)) {
    nidOut = E_FUNGUS; reset = true;
  }

  // acid eats its neighbours; what fizzes (limestone) sets its gas free as a puff
  if (nidOut == id && nAcid > 0 && acidEats(id)) {
    if (rnd(rs) < ACID_USE * float(nAcid)) {
      nidOut = rnd(rs) < ACID_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true;
      P += STEAM_BOIL_PUFF * FIZZ[id] / STEAM_EXPANSION;
    }
  }

  if (nidOut != id) {
    if (CONDUCTS[id] && !CONDUCTS[nidOut] && nidOut != E_LAVA) ctype = 0.0;   // its spark goes with it
    if (reset) life = SPAWNLIFE[nidOut];
    if (grower(nidOut) || grower(id)) ctype = 0.0;   // a new grower's damp comes in next step; an old one's goes
    if (KIND[nidOut] == K_SOLID) v = vec3(0.0);
    if (nidOut == E_FIRE) life = FIRE_LIFE_MIN + FIRE_LIFE_SPREAD * rnd(rs);
  }

  T = clamp(T, CELL_TEMP_MIN, CELL_TEMP_MAX);
  vec4 outA = vec4(float(nidOut), T, life, ctype + seed), outB = vec4(v, clamp(P, P_MIN, P_MAX));
  // the rest test on what this cell becomes, its neighbours as this pass saw
  // them (the activity map redoes the neighbour test where one has changed: dirty)
  uint flags = ownFlags(outA, outB) | dirty;
  if ((flags & FLAG_SELF) != 0u && inertNear(p, outA, na)) flags |= FLAG_NEAR;
  if (nearChange(a, outA)) flags |= FLAG_DIRTY;
  writeState(outA, outB, flags);
}
`;
