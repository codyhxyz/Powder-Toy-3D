import { prelude, stateOutGLSL } from './common.js';
import { quietGLSL, inertNearGLSL } from './activity.js';
import { ELEMENTS } from '../elements.js';
import { electricReactGLSL } from '../electricity.js';

// The softest breakable solid: a cell carrying less kinetic energy than this
// can't break anything, which lets almost every cell skip the impact check.
const HARD_MIN = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));

// Reactions pair each cell with one face neighbour per step (see the reactions
// block): along one of the 3 axes, toward + or − by a parity, so a given
// touching pair is partners once every RX_PAIRINGS steps, and a reaction's
// chance per step becomes chance·RX_PAIRINGS per pairing.
export const RX_PAIRINGS = 3 * 2;
const RX_SALT = 0x52;   // keeps a pair's random stream apart from the cells' own (seed3 salt)

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
//     burn fuel, release heat and spawn flames into adjacent air. Oxygen
//     feeds them: they burn faster and hotter by the oxygen in the gas around
//     them (oxyShare, oxyFlameT), and flames spread into it as into air. A
//     flame burning in oxygen keeps E_OXYGEN as its ctype, and counts as
//     oxygen to the fuel it burns.
//     Carbon dioxide smothers them: where it makes up CO2_SMOTHER of the gas
//     around, flames go out, fuel stops burning and air doesn't catch.
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
//   - The shared mechanisms (elements.js; docs/elements.md): phase changes
//     from the table (cold, hot, with latent heat banked in life as water's
//     is; crush), reactions between touching pairs (REACTIONS: each cell
//     pairs with one face neighbour per step and both evaluate one predicate
//     on this pass's input, so they agree without a race, and a cell reacts
//     with at most one partner), and explosives (blast: set off by ignite, a
//     flame's touch, a hit of `shock` kinetic energy, or `crushP` air pressure).
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
#define RX_PAIRINGS ${RX_PAIRINGS.toFixed(1)}   // steps per cycle of partner choices (RX_PAIRINGS)
#define RX_SALT ${RX_SALT}u

// The product of an \`into\` (elements.js mechanisms specs): one draw from s
// when it is a weighted list, none when it is a single element. -1 = SAME.
int pickOut(int sp, inout uint s) {
  ivec2 at = SPEC[sp];
  if (at.y == 1) return int(OUT[at.x].x);
  float r = rnd(s);
  for (int k = 0; k < at.y - 1; k++) if (r < OUT[at.x + k].y) return int(OUT[at.x + k].x);
  return int(OUT[at.x + at.y - 1].x);
}
// What a product's ctype is: for LAVA, what it sets back into (of, or the
// element it came from); nothing for anything else.
float ctypeOf(int prod, int of, int self) { return prod == E_LAVA ? float(of >= 0 ? of : self) : 0.0; }
// Air pressure from gas set free: puff volumes (at ambient) per volume, scaled
// from water flashing to steam (physics.js STEAM_BOIL_PUFF), as fizz is.
float puffP(float puff) { return STEAM_BOIL_PUFF * puff / STEAM_EXPANSION; }

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

// The oxygen in the gas around a cell over air's: 1 in air (flames are burning
// air), O2_PER_AIR in pure oxygen (physics.js).
float oxyShare(int nAir, int nOxy) {
  return nAir + nOxy > 0 ? (float(nAir) + O2_PER_AIR * float(nOxy)) / float(nAir + nOxy) : 1.0;
}
// A flame of temperature T (°C) in air burns this hot with that much oxygen
// (OXY_FLAME_GAIN in kelvin, all oxygen).
float oxyFlameT(float T, float oxy) {
  float gain = 1.0 + (OXY_FLAME_GAIN - 1.0) * (oxy - 1.0) / (O2_PER_AIR - 1.0);
  return (T + KELVIN) * gain - KELVIN;
}

// Latent heat with no bank (elements.js LIFE_BANK false: the cell's life holds
// something else): the heat crossing Tp this step goes into the change, which
// happens with that heat over L as its chance. On average that is the bank.
bool latentChance(inout float T, float Tp, float C, float L, bool rising, inout uint s) {
  float e = rising ? (T - Tp) * C : (Tp - T) * C;
  if (e <= 0.0) return false;
  T = Tp;
  return rnd(s) * L < e;
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

  // ---- what sets off an explosive or crushes a cell, from this pass's input ----
  // a hit (elements.js blast.shock): matter and I closing at speed u, a
  // neighbour running into me or me into it, landing included (the move pass
  // left it as it was: common.js impactActs, shockActs), with ½·μ·u² of
  // kinetic energy. Cells of my own element don't count.
  bool shocked = false;
  if (BLAST[id].z > 0.0) {
    float m = densityOf(id, a.y);
    bool meSolid = KIND[id] == K_SOLID;
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      float u = dot(b.xyz - nb[i].xyz, vec3(DIRS[i]));
      if (j == id || isGasLike(j) || u <= 0.0) continue;
      float mj = densityOf(j, na[i].y);
      float ke = meSolid ? hitKE(mj, m, true, u) : hitKE(m, mj, KIND[j] == K_SOLID, u);
      shocked = shocked || ke >= BLAST[id].z;
    }
  }
  // the highest air pressure on me: my own, and my open neighbours' (a solid holds none)
  float pOn = KIND[id] == K_SOLID ? P_MIN : P0;
  bool touchAir = false;
  for (int i = 0; i < 6; i++) {
    if (KIND[nid[i]] != K_SOLID) pOn = max(pOn, nb[i].w);
    touchAir = touchAir || nid[i] == E_EMPTY;
  }
  // an explosive that needs air (blast.air) goes off only touching it
  bool blastAir = BLAST_LIT[id].y == 0.0 || touchAir;
  // set off by a hit or a blast's pressure: an explosive goes off rather than break
  bool setOff = blastAir && (shocked || (BLAST[id].w > 0.0 && pOn > BLAST[id].w));

  // ---- reactions (elements.js REACTIONS), decided from this pass's input ----
  // This step every cell's partner is its face neighbour along axis
  // uFrame % 3: toward + where its world coordinate plus the parity
  // (uFrame / 3) % 2 is even, else toward −. Partners are mutual, so a cell
  // reacts with at most one, and both cells of a pair evaluate the same
  // predicate on the same input, with one random stream seeded at the pair's
  // base cell: they agree, without a race. A reaction takes precedence over
  // everything else a cell might do this step (both sides know it; neither
  // knows the other's breaking or burning).
  bool reacted = false;
  int rxOut = id;
  float rxT = 0.0, rxP = 0.0;
  if (RX_ANY) {
    int ax = int(uFrame % 3u), par = int((uFrame / 3u) & 1u);
    ivec3 w = p + uOrigin;   // world cell: the pairing doesn't depend on where the window is
    bool base = ((w[ax] + par) & 1) == 0;
    int k = 2 * ax + (base ? 0 : 1);   // the partner's DIRS index
    int rx = rxAt(id, nid[k]);
    if (rx > 0 && inGrid(p + DIRS[k])) {
      int r = (rx - 1) >> 1;
      bool isA = ((rx - 1) & 1) == 0;
      uint ps = seed3(base ? p : p + DIRS[k], uFrame, RX_SALT);
      if (rxGate(r, a.y, na[k].y) && rnd(ps) < RX[r].x * RX_PAIRINGS) {
        int ida = isA ? id : nid[k], idb = isA ? nid[k] : id;
        int oa = pickOut(RX_INTO[r].x, ps), ob = pickOut(RX_INTO[r].y, ps);
        if (oa < 0) oa = ida;   // SAME
        if (ob < 0) ob = idb;
        reacted = true;
        rxOut = isA ? oa : ob;
        // the heat, shared so both products warm alike; the gas, half each
        rxT = RX[r].w / (CAP[oa] + CAP[ob]);
        rxP = 0.5 * puffP(RX_PUFF[r]);
      }
    }
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

  int nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0, nCloud = 0, nVoid = 0, nOxy = 0, nOxyFire = 0, nCO2 = 0, nGas = 0;
  float flame = 0.0;
  float closing = 0.0;   // snow neighbours' closing speed on me, summed (storm charge)
  int cloneOf = 0;
  bool surface = false;   // a non-gas neighbour to condense onto (the box's floor counts, its sides and lid don't)
  for (int i = 0; i < 6; i++) {
    int j = nid[i];
    if (j == E_EMPTY) nAir++;
    if (j == E_CLOUD) nCloud++;
    if (!isGasLike(j) && (inGrid(p + DIRS[i]) || i == 3)) surface = true;
    if (j == E_FIRE) nFire++;
    if (j == E_OXYGEN) nOxy++;
    if (j == E_FIRE && floor(na[i].w) == float(E_OXYGEN)) nOxyFire++;   // a flame burning in oxygen
    if (j == E_CO2) nCO2++;
    if (isGasLike(j)) nGas++;
    if (ACIDIC[j]) nAcid++;
    if (j == E_PLANT) nPlant++;
    if (j == E_VOID) nVoid++;
    if (j == E_SNOW) closing += max(dot(b.xyz - nb[i].xyz, vec3(DIRS[i])), 0.0);
    if ((j == E_CLONE || (j == E_PCLN && na[i].z == SWITCH_ON)) && na[i].w >= 1.0) cloneOf = int(floor(na[i].w));   // a powered clone only while on
    if (IGNITE[j] > 0.0 && INTO[j][PH_BLAST] < 0 && na[i].y >= IGNITE[j]) { nBurning++; flame = max(flame, FLAMET[j]); }   // (explosives go off instead)
  }
  float oxy = oxyShare(nAir + nFire - nOxyFire, nOxy + nOxyFire);
  bool smothered = nCO2 > 0 && float(nCO2) >= CO2_SMOTHER * float(nGas);

  if (reacted) {
    T += rxT;
    P += rxP;
    if (rxOut != id) { nidOut = rxOut; reset = true; ctype = 0.0; }
  } else if (broke && !setOff) {
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
    // storm charge (physics.js CHARGE_*): freezing cloud struck by falling
    // snow; the strike that spends it is src/lightning.js's
    if (nidOut == E_CLOUD && T <= CHARGE_T_MAX && rnd(rs) < CHARGE_RATE * closing) ctype = min(ctype + 1.0, CHARGE_MAX);
    if (nidOut != E_CLOUD) ctype = 0.0;   // the charge goes with the droplets
  } else if (id == E_LAVA) {
    int ct = int(ctype);
    if (ct <= 0 || ct >= NE) ct = E_STONE;
    if (T < MELT[ct] - LAVA_FREEZE_BELOW) { nidOut = ct; reset = true; ctype = 0.0; }
  } else if (id == E_FIRE) {
    life -= FIRE_BURN + FIRE_BURN_SPREAD * rnd(rs);
    if (life <= 0.0 || T < FIRE_MIN_T || smothered) { nidOut = rnd(rs) < FIRE_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true; ctype = 0.0; }
  } else if (id == E_SMOKE) {
    life -= SMOKE_FADE;
    if (life <= 0.0) { nidOut = E_EMPTY; reset = true; }
  } else if (ACIDIC[id]) {
    // acid, and caustic gas: used up by what they eat
    int victims = 0;
    for (int i = 0; i < 6; i++) if (acidEats(nid[i])) victims++;
    life -= ACID_USE * float(victims);
    if (life <= 0.0) { nidOut = rnd(rs) < ACID_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true; }
  } else if (id == E_EMPTY) {
    // flames lick out of anything burning next to us
    if (nBurning > 0 && !smothered && rnd(rs) < FLAME_SPREAD * float(nBurning)) {
      nidOut = E_FIRE; reset = true; ctype = 0.0; T = max(T, flame * (FLAME_T_MIN + FLAME_T_SPREAD * rnd(rs)));
    } else if (cloneOf > 0 && rnd(rs) < CLONE_RATE) {
      nidOut = cloneOf; reset = true; T = SPAWNT[cloneOf];
      ctype = cloneOf == E_LAVA ? float(E_STONE) : 0.0;
      v = vec3(0.0, KIND[cloneOf] == K_GAS ? 0.0 : SPAWN_DROP_V, 0.0);
    }
  } else if (id == E_OXYGEN) {
    // flames lick into oxygen as into air, as much more often as it holds more
    // oxygen, and hotter
    if (nBurning > 0 && !smothered && rnd(rs) < FLAME_SPREAD * O2_PER_AIR * float(nBurning)) {
      nidOut = E_FIRE; reset = true; ctype = float(E_OXYGEN);
      T = max(T, oxyFlameT(flame, O2_PER_AIR) * (FLAME_T_MIN + FLAME_T_SPREAD * rnd(rs)));
    }
  } else if ((id == E_CLONE || id == E_PCLN) && ctype < 1.0) {
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (cloneable(j)) { ctype = float(j); break; }
    }
  }

  // phase changes from the table (elements.js cold, hot). With latent heat,
  // life is a signed bank as water's is (+ toward hot, − toward cold), or, if
  // life holds something else, the change is stochastic (latentChance).
  if (!reacted && nidOut == id && (INTO[id][PH_HOT] >= 0 || INTO[id][PH_COLD] >= 0)) {
    float up = max(life, 0.0), dn = max(-life, 0.0);
    bool goHot = false, goCold = false, bank = LIFE_BANK[id];
    if (INTO[id][PH_HOT] >= 0) goHot = HOT[id].y == 0.0 ? T >= HOT[id].x
      : bank ? latent(T, up, HOT[id].x, C, HOT[id].y, true) : latentChance(T, HOT[id].x, C, HOT[id].y, true, rs);
    if (INTO[id][PH_COLD] >= 0 && !goHot) goCold = COLD[id].y == 0.0 ? T <= COLD[id].x
      : bank ? latent(T, dn, COLD[id].x, C, COLD[id].y, false) : latentChance(T, COLD[id].x, C, COLD[id].y, false, rs);
    if (bank && (HOT[id].y > 0.0 || COLD[id].y > 0.0)) life = up - dn;
    if (goHot || goCold) {
      int ph = goHot ? PH_HOT : PH_COLD;
      nidOut = pickOut(INTO[id][ph], rs);
      ctype = ctypeOf(nidOut, OF[id][ph], id);
      reset = true;
      P += puffP(goHot ? HOT[id].z : COLD[id].z);
    }
  }
  // crushed by air pressure (elements.js crush)
  if (!reacted && nidOut == id && INTO[id][PH_CRUSH] >= 0 && pOn > CRUSH_P[id]) {
    nidOut = pickOut(INTO[id][PH_CRUSH], rs);
    ctype = ctypeOf(nidOut, OF[id][PH_CRUSH], id);
    reset = true;
  }

  // melting (stone, sand, metal, glass → lava that remembers what it was)
  if (!reacted && nidOut == id && MELT[id] > 0.0 && T > MELT[id]) {
    nidOut = E_LAVA; ctype = float(MELTINTO[id]); life = 0.0;
  }

  // explosives (elements.js blast) and combustion
  if (!reacted && nidOut == id && INTO[id][PH_BLAST] >= 0) {
    // It goes off at its ignition point, or the moment it touches something
    // that hot (an ember, hot metal, lava, a splinter heated by a shot); a
    // flame's touch flickers, so a flame next to it only might (blast.flame
    // per step). Or by a hard enough hit, or a blast's pressure (setOff).
    bool lit = false;
    if (blastAir) {
      if (IGNITE[id] > 0.0) {
        bool hotTouch = false;
        for (int i = 0; i < 6; i++) hotTouch = hotTouch || (!isGasLike(nid[i]) && na[i].y >= IGNITE[id]);
        lit = T >= IGNITE[id] || hotTouch;
      }
      lit = lit || setOff || (nFire > 0 && BLAST_LIT[id].x > 0.0 && rnd(rs) < BLAST_LIT[id].x);
    }
    if (lit) {
      nidOut = pickOut(INTO[id][PH_BLAST], rs);
      ctype = ctypeOf(nidOut, OF[id][PH_BLAST], id);
      reset = true; T = BLAST[id].y; P += BLAST[id].x;
    }
  } else if (!reacted && nidOut == id && IGNITE[id] > 0.0) {
    if (T >= IGNITE[id] && (nAir > 0 || nFire > 0 || nOxy > 0) && !smothered) {
      // as fast as oxygen reaches it, so its heat comes out as much faster
      life -= BURNRATE[id] * oxy;
      T = max(T, min(T + BURNHEAT[id] * oxy / C, oxyFlameT(FLAMET[id], oxy)));
      P += BURN_P;
      if (life <= 0.0) {
        nidOut = (LEAVES_ASH[id] && rnd(rs) < ASH_SHARE) ? E_ASH : E_FIRE;
        reset = true;
        T = max(T, BURNT_MIN_T);
      }
    }
  }

  // acid (and caustic gas) eats its neighbours; what fizzes (limestone) sets its gas free as a puff
  if (!reacted && nidOut == id && nAcid > 0 && acidEats(id)) {
    if (rnd(rs) < ACID_USE * float(nAcid)) {
      nidOut = rnd(rs) < ACID_TO_SMOKE ? E_SMOKE : E_EMPTY; reset = true;
      P += puffP(FIZZ[id]);
    }
  }

  // Void (elements.js VOID) drains whatever can move the step it touches it
  if (nVoid > 0 && id != E_EMPTY && KIND[id] != K_SOLID) {
    nidOut = E_EMPTY; reset = true; T = AMBIENT; v = vec3(0.0); ctype = 0.0;
  }

  if (nidOut != id) {
    if (CONDUCTS[id] && !CONDUCTS[nidOut] && nidOut != E_LAVA) ctype = 0.0;   // its spark goes with it
    if (reset) life = SPAWNLIFE[nidOut];
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
