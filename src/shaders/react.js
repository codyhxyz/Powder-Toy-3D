import { prelude } from './common.js';
import { quietGLSL } from './activity.js';

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
export const reactFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
uniform uint uFrame;
uniform float uGravity;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
${quietGLSL}

// salt that gives this pass its own random stream (seed3)
#define REACT_RNG_SALT 0x7au

// ---- heat ----
// latent heats of water, in °C of heating water (cap 1): 80 and 540 cal/g
#define L_FUSE 80.0
#define L_BOIL 540.0
#define WATER_MELT_T 0.0          // °C: ice ⇄ water
#define WATER_BOIL_T 100.0        // °C: water ⇄ steam
#define AIR_AMBIENT_PULL 0.002    // fraction of its gap to AMBIENT that air closes per step
#define TEMP_MAX 6000.0           // °C: hottest a cell can get (coldest is absolute zero)

// ---- pressure ----
#define PRESSURE_DIFFUSION 0.12   // fraction of the neighbour Laplacian taken per step
#define SHOCK_FALLOFF 0.88        // a shock front keeps this fraction per cell travelled
#define PRESSURE_DECAY 0.97       // fraction of pressure kept per step (the box leaks)
#define PRESSURE_MIN (-50.0)      // clamp on air pressure: strongest vacuum...
#define PRESSURE_MAX 200.0        // ...and strongest blast

// ---- forces ----
#define PRESSURE_ACCEL 0.06       // cells/step² per unit of pressure gradient, at unit inertia
#define INERTIA_PER_DENSITY 0.1   // a cell's inertia against pressure, per unit of density
#define INERTIA_MIN 0.25          // floor, so the lightest gases aren't flung arbitrarily fast
#define AIR_SINK_MAX 0.5          // cold air sinks at most this × gravity
#define AIR_RISE_MAX 2.0          // hot air rises at most this × gravity

// ---- liquids (speeds in units of the element's FLOW) ----
#define POOL_FLOW 0.6             // flow on a pool's surface (full FLOW under a head)
#define FLOW_REAIM_BELOW 0.5      // flow slower than this × the wanted speed gets a new direction
#define FILM_KEEP 0.5             // fraction of a film's horizontal velocity kept per step
#define FILM_COHESION 0.3         // pull toward each neighbouring liquid cell
#define DROPLET_WANDER_CHANCE 0.1 // per step, for a droplet with no liquid beside it
#define DROPLET_WANDER_SPEED 0.5

// ---- reactions (chances are per step) ----
#define BOIL_PRESSURE 1.5         // pressure released when water flashes to steam
#define PLANT_GROW_CHANCE 0.006   // water → plant, per plant neighbour
#define FIRE_DECAY 0.02           // life a flame loses per step...
#define FIRE_DECAY_JITTER 0.02    // ...plus up to this much more at random
#define FIRE_MIN_T 350.0          // °C: cooler flames go out
#define FIRE_SMOKE_CHANCE 0.35    // a dying flame leaves smoke (else air)
#define FIRE_LIFE_MIN 0.5         // a new flame's life: MIN + JITTER × rnd
#define FIRE_LIFE_JITTER 0.5
#define SMOKE_DECAY 0.003         // life smoke loses per step
#define ACID_WEAR 0.03            // life acid loses per step, per neighbour it is eating
#define ACID_DISSOLVE_CHANCE 0.03 // per acid neighbour
#define ACID_SMOKE_CHANCE 0.3     // spent acid, and what it eats, go up as smoke (else air)
#define FLAME_SPREAD_CHANCE 0.25  // air → fire, per burning neighbour
#define FLAME_T_MIN 0.85          // a new flame starts at (MIN + JITTER × rnd) × its source's flame temperature
#define FLAME_T_JITTER 0.15
#define CLONE_CHANCE 0.06         // a clone emits into adjacent air
#define CLONE_DROP_SPEED 0.3      // cells/step: a non-gas leaves the clone falling
#define GUNPOWDER_FIRE_CHANCE 0.7 // gunpowder ignites next to a flame (else at its ignition temperature)
#define GUNPOWDER_BLAST_T 2200.0  // °C: the flame a grain explodes into
#define GUNPOWDER_BLAST_P 60.0    // pressure the blast releases
#define BURN_PRESSURE 0.02        // pressure a burning cell adds per step (hot gases)
#define ASH_CHANCE 0.5            // burnt-out fuel leaves ash (else a flame; oil always a flame)
#define BURNOUT_MIN_T 600.0       // °C: burnt-out fuel's remains are at least this hot

const ivec3 DIRS[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));

// Latent heat bookkeeping. acc is energy banked toward a transition at Tp.
// rising: transition happens when heated past Tp (melting, boiling).
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
  uint rs = seed3(p, uFrame, REACT_RNG_SALT);

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
    P = max(P0 + PRESSURE_DIFFUSION * lap, front * SHOCK_FALLOFF) * PRESSURE_DECAY;
    gradP = 0.5 * vec3(pn[0] - pn[1], pn[2] - pn[3], pn[4] - pn[5]);
  } else {
    P = 0.0;
  }

  // ---- forces ----
  if (!solid) {
    float rho = max(densityOf(id, T) * INERTIA_PER_DENSITY, INERTIA_MIN);
    v -= gradP * PRESSURE_ACCEL / rho;
    if (id == E_EMPTY) v.y += uGravity * clamp((T - AMBIENT) / (AMBIENT + C_TO_K), -AIR_SINK_MAX, AIR_RISE_MAX);
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
        float want = head ? f : f * POOL_FLOW;
        if (hv < want * FLOW_REAIM_BELOW) {
          float ang = rnd(rs) * TAU;
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
        if (alone && rnd(rs) < DROPLET_WANDER_CHANCE) {
          // isolated droplets wander until they meet others
          float ang = rnd(rs) * TAU;
          v.xz = vec2(cos(ang), sin(ang)) * f * DROPLET_WANDER_SPEED;
        }
      }
    }
    if (JITTER[id] > 0.0) v += (vec3(rnd(rs), rnd(rs), rnd(rs)) - 0.5) * JITTER[id];
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

  if (id == E_WATER) {
    // signed accumulator: + toward boiling, - toward freezing
    float up = max(life, 0.0), dn = max(-life, 0.0);
    bool boil = latent(T, up, WATER_BOIL_T, C, L_BOIL, true);
    bool freeze = latent(T, dn, WATER_MELT_T, C, L_FUSE, false);
    life = up - dn;
    if (boil) { nidOut = E_STEAM; life = 0.0; P += BOIL_PRESSURE; }
    else if (freeze) { nidOut = E_ICE; life = 0.0; }
    if (nPlant > 0 && rnd(rs) < PLANT_GROW_CHANCE * float(nPlant)) { nidOut = E_PLANT; reset = true; }
  } else if (id == E_ICE || id == E_SNOW) {
    if (latent(T, life, WATER_MELT_T, C, L_FUSE, true)) { nidOut = E_WATER; life = 0.0; }
  } else if (id == E_STEAM) {
    if (latent(T, life, WATER_BOIL_T, C, L_BOIL, false)) { nidOut = E_WATER; life = 0.0; }
  } else if (id == E_LAVA) {
    int ct = int(ctype);
    if (ct <= 0 || ct >= NE) ct = E_STONE;
    if (T < MELT[ct] - LAVA_FREEZE_DROP) { nidOut = ct; reset = true; ctype = 0.0; }
  } else if (id == E_FIRE) {
    life -= FIRE_DECAY + FIRE_DECAY_JITTER * rnd(rs);
    if (life <= 0.0 || T < FIRE_MIN_T) { nidOut = rnd(rs) < FIRE_SMOKE_CHANCE ? E_SMOKE : E_EMPTY; reset = true; }
  } else if (id == E_SMOKE) {
    life -= SMOKE_DECAY;
    if (life <= 0.0) { nidOut = E_EMPTY; reset = true; }
  } else if (id == E_ACID) {
    int victims = 0;
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (j != E_EMPTY && j != E_ACID && j != E_WALL && j != E_GLASS && j != E_WATER && KIND[j] != K_GAS) victims++;
    }
    life -= ACID_WEAR * float(victims);
    if (life <= 0.0) { nidOut = rnd(rs) < ACID_SMOKE_CHANCE ? E_SMOKE : E_EMPTY; reset = true; }
  } else if (id == E_EMPTY) {
    // flames lick out of anything burning next to us
    if (nBurning > 0 && rnd(rs) < FLAME_SPREAD_CHANCE * float(nBurning)) {
      nidOut = E_FIRE; reset = true; T = max(T, flame * (FLAME_T_MIN + FLAME_T_JITTER * rnd(rs)));
    } else if (cloneOf > 0 && rnd(rs) < CLONE_CHANCE) {
      nidOut = cloneOf; reset = true; T = SPAWNT[cloneOf];
      ctype = cloneOf == E_LAVA ? float(E_STONE) : 0.0;
      v = vec3(0.0, KIND[cloneOf] == K_GAS ? 0.0 : -CLONE_DROP_SPEED, 0.0);
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
      if (T >= IGNITE[id] || (nFire > 0 && rnd(rs) < GUNPOWDER_FIRE_CHANCE)) {
        nidOut = E_FIRE; reset = true; T = GUNPOWDER_BLAST_T; P += GUNPOWDER_BLAST_P;
      }
    } else if (T >= IGNITE[id] && (nAir > 0 || nFire > 0)) {
      life -= BURNRATE[id];
      T = max(T, min(T + BURNHEAT[id] / C, FLAMET[id]));
      P += BURN_PRESSURE;
      if (life <= 0.0) {
        nidOut = (id != E_OIL && rnd(rs) < ASH_CHANCE) ? E_ASH : E_FIRE;
        reset = true;
        T = max(T, BURNOUT_MIN_T);
      }
    }
  }

  // acid eats its neighbours
  if (nidOut == id && nAcid > 0 && id != E_EMPTY && id != E_ACID && id != E_WALL && id != E_GLASS
      && id != E_WATER && KIND[id] != K_GAS) {
    if (rnd(rs) < ACID_DISSOLVE_CHANCE * float(nAcid)) { nidOut = rnd(rs) < ACID_SMOKE_CHANCE ? E_SMOKE : E_EMPTY; reset = true; }
  }

  if (nidOut != id) {
    if (reset) life = SPAWNLIFE[nidOut];
    if (KIND[nidOut] == K_SOLID) v = vec3(0.0);
    if (nidOut == E_FIRE) life = FIRE_LIFE_MIN + FIRE_LIFE_JITTER * rnd(rs);
  }

  T = clamp(T, -C_TO_K, TEMP_MAX);
  oA = vec4(float(nidOut), T, life, ctype + seed);
  oB = vec4(v, clamp(P, PRESSURE_MIN, PRESSURE_MAX));
}
`;
