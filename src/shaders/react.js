import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims } from './common.js';
import { inertNearGLSL } from './activity.js';
import { ELEMENTS } from '../elements.js';
import { electricReactGLSL } from '../electricity.js';
import { simModesGLSL, SIM_MODE_FIELDS } from '../simModes.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// The softest breakable solid: a cell carrying less kinetic energy than this
// can't break anything, which lets almost every cell skip the impact check.
const HARD_MIN = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));

// Reactions pair each cell with one face neighbour per step (see the reactions
// block): along one of the 3 axes, toward + or − by a parity, so a given
// touching pair is partners once every RX_PAIRINGS steps, and a reaction's
// chance per step becomes chance·RX_PAIRINGS per pairing.
export const RX_PAIRINGS = 3 * 2;
export const FACES = 6;   // a cell's face neighbours: the react pass's P.faces
const RX_SALT = 0x52;   // keeps a pair's random stream apart from the cells' own (seed3 salt)

export const ReactParams = uniformStruct('ReactParams', {
  frame: 'u32',
  gravity: 'f32',
  // FACES at runtime: a loop to it can't be unrolled. Unrolled, the GPU compiler
  // inlines every call in every loop body six times over, and ANGLE/Metal took
  // a minute to build this pass cold (docs/webgpu.md D3).
  faces: 'u32',
  rays: 'u32',   // the rays layer stepped: its deposits are in rayDeposit
  // simulation modes (src/simModes.js): gravMode, edge, and
  ...SIM_MODE_FIELDS,
  airMode: 'u32',       // AIR_*
  ambientHeat: 'u32',   // heat in the air (off: air holds its ambient, airT(), and matter trades no heat with it)
});

// Group 2 (docs/webgpu.md C4, D3): what fast particles left in each cell this
// step (raysLayer.js, docs/particles.md), heat and air pressure, two i32 per
// slot in fixed point (physics.js RAY_DEPOSIT_SCALE).
export const REACT_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];

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
//     With a flame touching it, a fuel burns from its flash point (elements.js
//     flash), and air touching a flame and a fuel past its flash point catches.
//   - Growth: plant grows into water; moss creeps over damp bare rock and
//     fungus rots damp wood, sawdust and plant (activity.js growers). Each
//     moss or fungus cell first updates its damp (its ctype).
//     Dust suspended in air goes off as one instead (physics.js DUST_*).
//   - Singularities (physics.js SING_*) hold a vacuum, swallow what touches
//     them and grow, burst when full and evaporate when starved.
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
//   - Simulation modes (src/simModes.js): past a void edge a neighbour is
//     still air at ambient with no pressure, past a loop edge the far side's
//     cell; with radial gravity the forces use the pull's vector and the
//     normal force, friction and liquid flow its dominant axis (the move's
//     frame, gravFrame); the air modes still, empty or freeze the air's
//     pressure and wind; ambient heat off holds air at AMBIENT and stops
//     matter trading heat with it. Vertical gravity applies no frame, so it
//     runs exactly what it ran before.
// One workgroup per brick of the DRAWN list (indirect), a thread per cell,
// reading the copy the header names (H.src) and writing every cell of the
// brick to the other (H.dst): the copy-through that keeps both copies right.
// A quiet brick is one uniform branch for the workgroup. At the end, the
// brick's word in marks.foams says whether any cell of it now holds a foaming
// liquid, the aeration list's input (docs/webgpu.md D3, G4).
export const reactFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${ReactParams.wgsl}
@group(3) @binding(1) var<uniform> P: ReactParams;
@group(2) @binding(0) var<storage, read> rayDeposit: array<i32>;   // per slot: heat, pressure (fixed point)
${inertNearGLSL}
${electricReactGLSL}
${simModesGLSL}

// The face neighbours (activity.js FACES: +x, -x, +y, -y, +z, -z).
fn DIRS(i: i32) -> vec3i { return FACES(i); }
// the DIRS index of a unit axis vector
fn faceOf(d: vec3f) -> i32 {
  if (d.x > 0.5) { return 0; }
  if (d.x < -0.5) { return 1; }
  if (d.y > 0.5) { return 2; }
  if (d.y < -0.5) { return 3; }
  if (d.z > 0.5) { return 4; }
  return 5;
}

const HARD_MIN: f32 = ${HARD_MIN.toFixed(1)};   // the softest breakable solid's hardness
const RX_PAIRINGS: f32 = ${RX_PAIRINGS.toFixed(1)};   // steps per cycle of partner choices (RX_PAIRINGS)
const RX_SALT: u32 = ${RX_SALT}u;

// The product of an \`into\` (elements.js mechanisms specs): one draw from s
// when it is a weighted list, none when it is a single element. -1 = SAME.
fn pickOut(sp: i32, s: ptr<function, u32>) -> i32 {
  let at = SPEC(sp);
  if (at.y == 1) { return i32(OUT(at.x).x); }
  let r = rnd(s);
  for (var k = 0; k < at.y - 1; k++) {
    if (r < OUT(at.x + k).y) { return i32(OUT(at.x + k).x); }
  }
  return i32(OUT(at.x + at.y - 1).x);
}
// What a product's ctype is: for LAVA, what it sets back into (of_, or the
// element it came from); nothing for anything else.
fn ctypeOf(prod: i32, of_: i32, self_: i32) -> f32 {
  if (prod != E_LAVA) { return 0.0; }
  return f32(select(self_, of_, of_ >= 0));
}
// Air pressure from gas set free: puff volumes (at ambient) per volume, scaled
// from water flashing to steam (physics.js STEAM_BOIL_PUFF), as fizz is.
fn puffP(puff: f32) -> f32 { return STEAM_BOIL_PUFF * puff / STEAM_EXPANSION; }

// Kinetic energy a cell (id, T, v) carries along the unit axis n: ½·ρ·vn², or
// 0 when it is moving away or can't move.
fn impactKE(id: i32, T: f32, v: vec3f, n: vec3f) -> f32 {
  let vn = dot(v, n);
  if (movable(id) && vn > 0.0) { return 0.5 * densityOf(id, T) * vn * vn; }
  return 0.0;
}

// A projectile (density m, speed u along the axis) breaks a solid of hardness
// H into debris of density M. The fracture takes H of its kinetic energy, then
// it hits the loose debris head on with the move pass's collision rule
// (move.js collide). Returns the projectile's speed along the axis and the
// debris's, both afterwards.
fn shatter(m: f32, u: f32, H: f32, M: f32) -> vec2f {
  let u1 = sqrt(max(u * u - 2.0 * H / m, 0.0));
  if (u1 <= COLLIDE_V) { return vec2f(u1, 0.0); }   // slow contact: the debris just supports it
  let inv = 1.0 / (m + M);
  let vc = m * u1 * inv;
  return vec2f(vc - RESTITUTION * M * inv * u1, min(vc + RESTITUTION * m * inv * u1, V_MAX));
}

// Heat flowing into a cell (id a at Ta) from a face neighbour (b at Tb) per
// step: min(cond_a, cond_b)·ΔT, capped at a share of the energy that would
// bring the smaller-capacity cell to the other's temperature (physics.js
// COND_FLUX_SHARE). Flux and cap are symmetric in the pair, so what one cell
// gains the other loses.
fn condFlux(a: i32, Ta: f32, b: i32, Tb: f32) -> f32 {
  let dT = Tb - Ta;
  let lim = abs(dT) * min(CAP(a), CAP(b)) * COND_FLUX_SHARE;
  return clamp(min(COND(a), COND(b)) * dT, -lim, lim);
}

// The oxygen in the gas around a cell over air's: 1 in air (flames are burning
// air), O2_PER_AIR in pure oxygen (physics.js).
fn oxyShare(nAir: i32, nOxy: i32) -> f32 {
  if (nAir + nOxy > 0) { return (f32(nAir) + O2_PER_AIR * f32(nOxy)) / f32(nAir + nOxy); }
  return 1.0;
}
// A flame of temperature T (°C) in air burns this hot with that much oxygen
// (OXY_FLAME_GAIN in kelvin, all oxygen).
fn oxyFlameT(T: f32, oxy: f32) -> f32 {
  let gain = 1.0 + (OXY_FLAME_GAIN - 1.0) * (oxy - 1.0) / (O2_PER_AIR - 1.0);
  return (T + KELVIN) * gain - KELVIN;
}

// Latent heat with no bank (elements.js LIFE_BANK false: the cell's life holds
// something else): the heat crossing Tp this step goes into the change, which
// happens with that heat over L as its chance. On average that is the bank.
fn latentChance(T: ptr<function, f32>, Tp: f32, C: f32, L: f32, rising: bool, s: ptr<function, u32>) -> bool {
  var e = (Tp - *T) * C;
  if (rising) { e = (*T - Tp) * C; }
  if (e <= 0.0) { return false; }
  *T = Tp;
  return rnd(s) * L < e;
}

// Singularity (physics.js SING_*). What it swallows: any matter but the wall
// and void (which drains it instead; another singularity merges), its partner
// in the reactions' pairing.
const SING_SALT: u32 = 0x5au;   // its stream (the reactions' is RX_SALT)
fn singEats(j: i32) -> bool { return j != E_EMPTY && j != E_WALL && j != E_VOID && j != E_SINGULARITY; }
// The vacuum one of mass m holds.
fn singVacuum(m: f32) -> f32 { return max(P_MIN, -SING_P_PER_MASS * m); }
// Of two touching singularities (mass, cell), does the first take the second?
// The heavier does; of two alike, the one first in the grid.
fn cellKey(c: vec3i) -> i32 { return c.x + NX * (c.y + NY * c.z); }
fn singTakes(ma: f32, a: vec3i, mb: f32, b: vec3i) -> bool { return ma > mb || (ma == mb && cellKey(a) < cellKey(b)); }

// Latent heat bookkeeping. acc is energy banked toward a transition at Tp.
// rising: transition happens when heated past Tp (melting, boiling).
fn latent(T: ptr<function, f32>, acc: ptr<function, f32>, Tp: f32, C: f32, L: f32, rising: bool) -> bool {
  if (rising) {
    if (*T > Tp) { *acc += (*T - Tp) * C; *T = Tp; }
    else if (*acc > 0.0) { let r = min(*acc, (Tp - *T) * C); *acc -= r; *T += r / C; }
  } else {
    if (*T < Tp) { *acc += (Tp - *T) * C; *T = Tp; }
    else if (*acc > 0.0) { let r = min(*acc, (*T - Tp) * C); *acc -= r; *T -= r / C; }
  }
  return *acc >= L;
}

// Cell p's step. Returns whether what it becomes foams (gfx/materials.js FOAMS).
fn reactCell(p: vec3i, quiet: bool) -> bool {
  let faces = i32(P.faces);
  let a = fetchA(p);
  let b = fetchB(p);
  let dirty = fetchF(p) & FLAG_DIRTY;   // the move pass's mark (shaders/common.js nearChange)
  // quiet brick (shaders/activity.js): nothing here can change, keep it as is.
  // Its cells were inert when the activity map was built, so their neighbour
  // tests passed then, and still do unless something around them is dirty.
  var rayDep = vec2f(0.0);
  if (P.rays != 0u) {
    let s = slotOf(p) * 2u;
    rayDep = vec2f(i32ToF32(rayDeposit[s]), i32ToF32(rayDeposit[s + 1u])) / RAY_DEPOSIT_SCALE;
  }
  if (quiet && all(rayDep == vec2f(0.0))) {
    writeState(p, a, b, ownFlags(a, b) | FLAG_NEAR | dirty);
    return FOAMS(eid(a));
  }
  let id = eid(a);
  var T = a.y;
  var life = a.z;
  var ctype = floor(a.w);
  let seed = fract(a.w);
  var v = b.xyz;
  let P0 = b.w;
  var rs = seed3(p, P.frame, 0x7au);

  var na: array<vec4f, 6>;
  var nb: array<vec4f, 6>;
  var nid: array<i32, 6>;
  for (var i = 0; i < faces; i++) {
    let q = edgeCell(p + DIRS(i));   // (past a loop edge: the far side)
    if (inGrid(q)) {
      na[i] = fetchA(q);
      nb[i] = fetchB(q);
    } else if (P.edge == EDGE_VOID) {
      na[i] = VOID_AIR_A();   // open: still air at ambient, no pressure (simModes.js)
      nb[i] = vec4f(0.0);
    } else {
      na[i] = vec4f(f32(E_WALL), T, 0.0, 0.0);   // insulating, pressure-reflecting box
      nb[i] = vec4f(0.0, 0.0, 0.0, P0);
    }
    nid[i] = eid(na[i]);
  }

  // ---- breaking (impacts and blasts), from this pass's input state ----
  // As a projectile: every breakable neighbour I hit hard enough breaks, and
  // each costs me its hardness, then a collision with its debris.
  var dvBreak = vec3f(0.0);
  if (movable(id) && 0.5 * densityOf(id, a.y) * dot(b.xyz, b.xyz) >= HARD_MIN) {
    let m = densityOf(id, a.y);
    for (var i = 0; i < faces; i++) {
      let s = nid[i];
      if (BREAKINTO(s) < 0) { continue; }
      let n = vec3f(DIRS(i));
      if (impactKE(id, a.y, b.xyz, n) < HARD(s)) { continue; }
      let u = dot(b.xyz, n);
      dvBreak -= n * (u - shatter(m, u, HARD(s), densityOf(BREAKINTO(s), a.y)).x);
    }
  }
  // As a breakable solid: the same test from my side. Every neighbour that
  // hits me hard enough pays my hardness, so the fracture work I get as heat is
  // one hardness per hit, and the debris takes each hit's momentum.
  var broke = false;
  var fractureE = 0.0;   // kinetic energy dissipated breaking me
  var vDebris = vec3f(0.0);
  if (BREAKINTO(id) >= 0) {
    let M = densityOf(BREAKINTO(id), a.y);
    for (var i = 0; i < faces; i++) {
      let n = -vec3f(DIRS(i));   // from the neighbour toward me
      if (impactKE(nid[i], na[i].y, nb[i].xyz, n) < HARD(id)) { continue; }
      let u = dot(nb[i].xyz, n);
      vDebris += n * shatter(densityOf(nid[i], na[i].y), u, HARD(id), M).y;
      fractureE += HARD(id);
      broke = true;
    }
    // a blast: the pressure difference across me along any axis (solid
    // neighbours hold no air: 0)
    var pa: array<f32, 6>;
    for (var i = 0; i < faces; i++) { pa[i] = select(0.0, nb[i].w, KIND(nid[i]) != K_SOLID); }
    let dP = max(abs(pa[0] - pa[1]), max(abs(pa[2] - pa[3]), abs(pa[4] - pa[5])));
    if (dP > HARD(id) * P_BREAK_PER_HARD) { broke = true; }
  }

  // ---- what sets off an explosive or crushes a cell, from this pass's input ----
  // a hit (elements.js blast.shock): matter and I closing at speed u, a
  // neighbour running into me or me into it, landing included (the move pass
  // left it as it was: common.js impactActs, shockActs), with ½·μ·u² of
  // kinetic energy. Cells of my own element don't count.
  var shocked = false;
  if (BLAST(id).z > 0.0) {
    let m = densityOf(id, a.y);
    let meSolid = KIND(id) == K_SOLID;
    for (var i = 0; i < faces; i++) {
      let j = nid[i];
      let u = dot(b.xyz - nb[i].xyz, vec3f(DIRS(i)));
      if (j == id || isGasLike(j) || u <= 0.0) { continue; }
      let mj = densityOf(j, na[i].y);
      var ke: f32;
      if (meSolid) { ke = hitKE(mj, m, true, u); } else { ke = hitKE(m, mj, KIND(j) == K_SOLID, u); }
      shocked = shocked || ke >= BLAST(id).z;
    }
  }
  // the highest air pressure on me: my own, and my open neighbours' (a solid holds none)
  var pOn = select(P0, P_MIN, KIND(id) == K_SOLID);
  var touchAir = false;
  for (var i = 0; i < faces; i++) {
    if (KIND(nid[i]) != K_SOLID) { pOn = max(pOn, nb[i].w); }
    touchAir = touchAir || nid[i] == E_EMPTY || nid[i] == E_OXYGEN || nid[i] == E_FIRE;
  }
  // an explosive that needs air (blast.air) goes off only touching it, or a
  // flame: the flame front is where fuel and air mix (a fireball draws air in)
  let blastAir = BLAST_LIT(id).y == 0.0 || touchAir;
  // set off by a hit or a blast's pressure: an explosive goes off rather than break
  let setOff = blastAir && (shocked || (BLAST(id).w > 0.0 && pOn > BLAST(id).w));

  // ---- reactions (elements.js REACTIONS), decided from this pass's input ----
  // This step every cell's partner is its face neighbour along axis
  // frame % 3: toward + where its world coordinate plus the parity
  // (frame / 3) % 2 is even, else toward −. Partners are mutual, so a cell
  // reacts with at most one, and both cells of a pair evaluate the same
  // predicate on the same input, with one random stream seeded at the pair's
  // base cell: they agree, without a race. A reaction takes precedence over
  // everything else a cell might do this step (both sides know it; neither
  // knows the other's breaking or burning).
  var reacted = false;
  var rxOut = id;
  var rxT = 0.0;
  var rxP = 0.0;
  let ax = i32(P.frame % 3u);
  let par = i32((P.frame / 3u) & 1u);
  let w = p + H.origin;   // world cell: the pairing doesn't depend on where the window is
  let base = ((w[ax] + par) & 1) == 0;
  let k = 2 * ax + select(1, 0, base);   // the partner's DIRS index
  let pk = edgeCell(p + DIRS(k));         // ...and cell
  let pb = select(pk, p, base);           // the pair's base cell
  // A singularity swallows its partner (any matter it has no reaction with),
  // on a draw of the pair's own stream, so both cells agree (physics.js SING_*).
  var ss = seed3(pb, P.frame, SING_SALT);
  var eats = nid[k] == E_SINGULARITY && singEats(id);
  if (id == E_SINGULARITY) { eats = singEats(nid[k]); }
  let swallow = eats && inGrid(pk) && rxAt(id, nid[k]) == 0 && rnd(&ss) < SING_EAT * RX_PAIRINGS;
  if (RX_ANY) {
    let rx = rxAt(id, nid[k]);
    if (rx > 0 && inGrid(pk)) {
      let r = (rx - 1) >> 1u;
      let isA = ((rx - 1) & 1) == 0;
      var ps = seed3(pb, P.frame, RX_SALT);
      if (rxGate(r, a.y, na[k].y) && rnd(&ps) < RX(r).x * RX_PAIRINGS) {
        let ida = select(nid[k], id, isA);
        let idb = select(id, nid[k], isA);
        var oa = pickOut(RX_INTO(r).x, &ps);
        var ob = pickOut(RX_INTO(r).y, &ps);
        if (oa < 0) { oa = ida; }   // SAME
        if (ob < 0) { ob = idb; }
        reacted = true;
        rxOut = select(ob, oa, isA);
        // the heat, shared so both products warm alike; the gas, half each
        rxT = RX(r).w / (CAP(oa) + CAP(ob));
        rxP = 0.5 * puffP(RX_PUFF(r));
      }
    }
  }

  // ---- heat conduction (energy conserving) ----
  let C = CAP(id);
  var dE = 0.0;
  // (ambient heat off: matter trades no heat with the air, simModes.js)
  for (var i = 0; i < faces; i++) {
    if (P.ambientHeat != 0u || (id != E_EMPTY && nid[i] != E_EMPTY)) { dE += condFlux(id, T, nid[i], na[i].y); }
  }
  T += (dE + rayDep.x) / C;   // (and what particles left: photons absorbed, fissions)
  // the open world above the box slowly pulls air back to ambient; gases radiate
  T += (airT() - T) * select(RAD(id), AIR_AMBIENT_PULL, id == E_EMPTY);

  // ---- air pressure ----
  let solid = KIND(id) == K_SOLID;
  var Pr = P0;
  var gradP = vec3f(0.0);
  if (!solid) {
    var lap = 0.0;
    var front = 0.0;
    var pn: array<f32, 6>;
    for (var i = 0; i < faces; i++) {
      let open = KIND(nid[i]) != K_SOLID;
      pn[i] = select(P0, nb[i].w, open);   // walls reflect pressure
      lap += pn[i] - P0;
      front = max(front, pn[i]);
    }
    // (air mode no update: it stays as it is, simModes.js)
    var spread = P0;
    if (P.airMode != AIR_NO_UPDATE) { spread = max(P0 + P_DIFFUSE * lap, front * P_FRONT) * P_DECAY; }
    Pr = spread + rayDep.y;
    gradP = 0.5 * vec3f(pn[0] - pn[1], pn[2] - pn[3], pn[4] - pn[5]);
  } else {
    Pr = 0.0;
  }
  // a singularity holds its vacuum, and the open cells touching it SING_RING
  // of it (the front rule spreads only positive pressure, so this is its reach)
  if (id == E_SINGULARITY) { Pr = singVacuum(life); }
  else if (!solid) {
    for (var i = 0; i < faces; i++) {
      if (nid[i] == E_SINGULARITY) { Pr = min(Pr, SING_RING * singVacuum(na[i].z)); }
    }
  }

  // ---- forces ----
  if (!solid) {
    let rho = max(densityOf(id, T) * RHO_SCALE, RHO_MIN);
    // (matter feels the air's pressure unless the air mode stills or empties
    // it: in TPT particles feel pressure only through the air's velocity, simModes.js)
    if (P.airMode == AIR_ON || P.airMode == AIR_NO_UPDATE) { v -= gradP * P_ACCEL / rho; }
    // Gravity's pull here (simModes.js gravDir: down, or radial), and the
    // frame the rules below are written in (down = -y, its face below fd):
    // with radial gravity turned so that -y is the pull's dominant axis
    // (gravFrame, as the move turns its blocks); else the grid's own, applied
    // as no matrix at all.
    let radial = P.gravMode == GRAV_RADIAL;
    var gv = vec3f(0.0, -1.0, 0.0);
    var GF = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);   // (F is the flags)
    var fd = 3;
    if (radial) {
      gv = gravDir(vec3f(p) + 0.5);
      GF = gravFrame(gv);
      fd = faceOf(vec3f(0.0, -1.0, 0.0) * GF);
    }
    // air, and cloud (air carrying droplets), is buoyant by its temperature
    if (id == E_EMPTY || id == E_CLOUD) {
      let lift = P.gravity * clamp((T - airT()) / (airT() + KELVIN), AIR_BUOY_LO, AIR_BUOY_HI);
      if (radial) { v -= gv * lift; } else { v.y += lift; }
    }
    if (id != E_EMPTY) {
      if (radial) { v += gv * (P.gravity * GRAV(id)); } else { v.y -= P.gravity * GRAV(id); }
    }
    v *= 1.0 - DRAG(id);
    var bF = b.xyz;       // this cell's and the one below's velocity, in the frame
    var nbF = nb[fd].xyz;
    if (radial) {
      v = GF * v;
      bF = GF * bF;
      nbF = GF * nbF;
    }
    // Normal force: a powder or liquid at rest on what it can't push aside
    // (the floor, a solid, or a grain or liquid that isn't falling itself) is
    // held up, so gravity can't start it moving down. One already moving down
    // (falling, landing, knocked from above) isn't at rest: it keeps feeling
    // gravity, and the move pass lands it with its splash, scatter and heat.
    // (The box's floor is a wall face, nid[fd]; past a void edge it is air.)
    let d = densityOf(id, a.y);
    let held = (KIND(id) == K_POWDER || KIND(id) == K_LIQUID) && bF.y >= 0.0 && (KIND(nid[fd]) == K_SOLID
      || (!canMove(id, nid[fd], d, densityOf(nid[fd], na[fd].y), 0) && nbF.y >= 0.0));
    if (held) { v.y = max(v.y, 0.0); }
    // grains only feel friction while resting on something (pressed on it by gravity)
    let supported = P.gravity > 0.0 && (KIND(nid[fd]) == K_SOLID || KIND(nid[fd]) == K_POWDER);
    if (supported) {
      let fr = 1.0 - FRICTION(id);
      v.x *= fr;
      v.z *= fr;
    }

    // Liquids: hydrostatic head drives spreading, surface tension stops it.
    // Both push only a liquid that has somewhere to go, a side neighbour it
    // can move into; boxed in, its speed just decays to a stop. (A lower
    // diagonal needs no push: the move pass topples into it regardless.)
    // Without gravity there is no head and nothing to rest on.
    if (KIND(id) == K_LIQUID && P.gravity > 0.0 && (supported || KIND(nid[fd]) == K_LIQUID)) {
      var open = false;
      for (var i = 0; i < faces; i++) {
        if ((i >> 1u) != (fd >> 1u)) { open = open || canMove(id, nid[i], d, densityOf(nid[i], na[i].y), 2); }
      }
      let up = nid[fd ^ 1];
      let head = KIND(up) == K_LIQUID || KIND(up) == K_POWDER;   // weight above us
      let onLiquid = !supported;                                  // surface of a pool
      let f = FLOW(id);
      let hv = length(v.xz);
      if (head || onLiquid) {
        // keep flowing in some direction until the level evens out
        let want = select(f * FLOW_SURFACE, f, head);
        if (open && hv < want * FLOW_KICK) {
          let ang = rnd(&rs) * 6.2831853;
          let h = vec2f(cos(ang), sin(ang)) * want;
          v.x = h.x;
          v.z = h.y;
        }
      } else {
        // a thin film on dry ground: cohesion pulls it toward neighbouring
        // liquid, so films gather into puddles with clean edges
        var coh = vec3f(0.0);
        var alone = true;
        for (var i = 0; i < faces; i++) {
          if ((i >> 1u) != (fd >> 1u) && KIND(nid[i]) == K_LIQUID) { coh += vec3f(DIRS(i)); alone = false; }
        }
        if (radial) { coh = GF * coh; }
        let h = v.xz * FILM_KEEP + select(vec2f(0.0), coh.xz * f * FILM_COHESION, open);
        v.x = h.x;
        v.z = h.y;
        if (open && alone && rnd(&rs) < DROPLET_WANDER) {
          // isolated droplets wander until they meet others
          let ang = rnd(&rs) * 6.2831853;
          let w2 = vec2f(cos(ang), sin(ang)) * f * DROPLET_SPEED;
          v.x = w2.x;
          v.z = w2.y;
        }
      }
    }
    if (radial) { v = v * GF; }   // (out of the frame)
    if (JITTER(id) > 0.0) {
      let j0 = rnd(&rs);
      let j1 = rnd(&rs);
      let j2 = rnd(&rs);
      v += (vec3f(j0, j1, j2) - 0.5) * JITTER(id);
    }
    v += dvBreak;
    v = clamp(v, vec3f(-V_MAX), vec3f(V_MAX));
    // the air mode (simModes.js): still air, or the wind as it was
    if (id == E_EMPTY && (P.airMode == AIR_VELOCITY_OFF || P.airMode == AIR_OFF)) { v = vec3f(0.0); }
    if (id == E_EMPTY && P.airMode == AIR_NO_UPDATE) { v = b.xyz; }
    // a held cell's leftover creep stops dead (physics.js REST_V)
    if (held) { v *= step(vec3f(REST_V), abs(v)); }
  } else {
    v = vec3f(0.0);
  }

  // ---- electricity: sparks, switches, sensors (src/electricity.js) ----
  electric(id, &T, &life, &ctype, &na, &nid, faces, &rs);

  // ---- reactions & phase changes ----
  var nidOut = id;
  var reset = false;   // new element: take its spawn life

  var nAir = 0;
  var nFire = 0;
  var nAcid = 0;
  var nPlant = 0;
  var nBurning = 0;
  var nCloud = 0;
  var nVoid = 0;
  var nOxy = 0;
  var nOxyFire = 0;
  var nCO2 = 0;
  var nGas = 0;
  var nWetMoss = 0;
  var nWetFungus = 0;
  var nFlash = 0;
  var flashFlame = 0.0;
  var wetMoss = vec3<bool>(false);   // axes holding damp moss, bare rock (mossSite)
  var bed = vec3<bool>(false);
  var flame = 0.0;
  var closing = 0.0;   // snow neighbours' closing speed on me, summed (storm charge)
  var cloneOf = 0;
  var surface = false;   // a non-gas neighbour to condense onto (the box's floor counts, its sides and lid don't)
  for (var i = 0; i < faces; i++) {
    let j = nid[i];
    let wet = floor(na[i].w) >= 1.0;
    if (j == E_MOSS && wet) { nWetMoss++; wetMoss[i >> 1u] = true; }
    if (j == E_FUNGUS && wet) { nWetFungus++; }
    if (mossBed(j)) { bed[i >> 1u] = true; }
    if (j == E_EMPTY) { nAir++; }
    if (j == E_CLOUD) { nCloud++; }
    if (!isGasLike(j) && (inGrid(p + DIRS(i)) || i == 3)) { surface = true; }
    if (j == E_FIRE) { nFire++; }
    if (j == E_OXYGEN) { nOxy++; }
    if (j == E_FIRE && floor(na[i].w) == f32(E_OXYGEN)) { nOxyFire++; }   // a flame burning in oxygen
    if (j == E_CO2) { nCO2++; }
    if (isGasLike(j)) { nGas++; }
    if (ACIDIC(j)) { nAcid++; }
    if (j == E_PLANT) { nPlant++; }
    if (j == E_VOID) { nVoid++; }
    if (j == E_SNOW) { closing += max(dot(b.xyz - nb[i].xyz, vec3f(DIRS(i))), 0.0); }
    if ((j == E_CLONE || (j == E_PCLN && na[i].z == SWITCH_ON)) && na[i].w >= 1.0) { cloneOf = i32(floor(na[i].w)); }   // a powered clone only while on
    if (IGNITE(j) > 0.0 && INTO(j)[PH_BLAST] < 0 && na[i].y >= IGNITE(j)) { nBurning++; flame = max(flame, FLAMET(j)); }   // (explosives go off instead)
    else if (FLASH(j) < IGNITE(j) && INTO(j)[PH_BLAST] < 0 && na[i].y >= FLASH(j)) { nFlash++; flashFlame = max(flashFlame, FLAMET(j)); }
  }
  // past its flash point a fuel's vapour carries a flame along it: air (or
  // oxygen) touching a flame and such a fuel catches as if the fuel were burning
  if (nFire > 0 && nFlash > 0) { nBurning += nFlash; flame = max(flame, flashFlame); }
  let oxy = oxyShare(nAir + nFire - nOxyFire, nOxy + nOxyFire);
  let smothered = nCO2 > 0 && f32(nCO2) >= CO2_SMOTHER * f32(nGas);

  if (reacted) {
    T += rxT;
    Pr += rxP;
    if (rxOut != id) { nidOut = rxOut; reset = true; ctype = 0.0; }
  } else if (broke && !setOff) {
    // debris keeps my temperature, life (fuel, banked latent heat) and ctype,
    // takes the fracture work as heat and flies off with the hits' momentum;
    // it reacts as itself from the next step
    nidOut = BREAKINTO(id);
    T += fractureE * KE_TO_HEAT / CAP(nidOut);
    v = clamp(vDebris, vec3f(-V_MAX), vec3f(V_MAX));
  } else if (id == E_WATER) {
    // signed accumulator: + toward boiling, - toward freezing
    var up = max(life, 0.0);
    var dn = max(-life, 0.0);
    let boil = latent(&T, &up, 100.0, C, L_BOIL, true);
    let freeze = latent(&T, &dn, 0.0, C, L_FUSE, false);
    life = up - dn;
    if (boil) { nidOut = E_STEAM; life = 0.0; Pr += STEAM_BOIL_PUFF; }
    else if (freeze) { nidOut = E_ICE; life = 0.0; }
    if (nPlant > 0 && rnd(&rs) < PLANT_GROW * f32(nPlant)) { nidOut = E_PLANT; reset = true; }
  } else if (id == E_ICE || id == E_SNOW) {
    if (latent(&T, &life, 0.0, C, L_FUSE, true)) { nidOut = E_WATER; life = 0.0; }
  } else if (id == E_STEAM) {
    if (latent(&T, &life, 100.0, C, L_BOIL, false)) { nidOut = select(E_CLOUD, E_WATER, surface); life = 0.0; }
  } else if (id == E_CLOUD) {
    // liquid water, as droplets: the same latent heats as a pool (signed accumulator)
    var up = max(life, 0.0);
    var dn = max(-life, 0.0);
    let boil = latent(&T, &up, 100.0, C, L_BOIL, true);
    let freeze = latent(&T, &dn, 0.0, C, L_FUSE, false);
    life = up - dn;
    if (boil) { nidOut = E_STEAM; life = 0.0; }
    else if (freeze) { nidOut = E_SNOW; life = 0.0; }
    else {
      // thick cloud coalesces into raindrops; the edges evaporate into the
      // unsaturated air, the faster the warmer (saturation vapour pressure)
      let rain = CLOUD_RAIN * max(f32(nCloud) - CLOUD_RAIN_NB, 0.0);
      let es = exp(MAGNUS_A * (T / (T + MAGNUS_B) - airT() / (airT() + MAGNUS_B)));
      let r = rnd(&rs);
      if (r < rain) { nidOut = E_WATER; life = 0.0; }
      else if (r < rain + CLOUD_EVAP * max(f32(nAir) - CLOUD_EVAP_NB, 0.0) * es) { nidOut = E_EMPTY; reset = true; T -= CLOUD_EVAP_COOL; }
    }
    // storm charge (physics.js CHARGE_*): freezing cloud struck by falling
    // snow; the strike that spends it is src/lightning.js's
    if (nidOut == E_CLOUD && T <= CHARGE_T_MAX && rnd(&rs) < CHARGE_RATE * closing) { ctype = min(ctype + 1.0, CHARGE_MAX); }
    if (nidOut != E_CLOUD) { ctype = 0.0; }   // the charge goes with the droplets
  } else if (id == E_LAVA) {
    var ct = i32(ctype);
    if (ct <= 0 || ct >= NE) { ct = E_STONE; }
    if (T < MELT(ct) - LAVA_FREEZE_BELOW) { nidOut = ct; reset = true; ctype = 0.0; }
  } else if (id == E_FIRE) {
    life -= FIRE_BURN + FIRE_BURN_SPREAD * rnd(&rs);
    if (life <= 0.0 || T < FIRE_MIN_T || smothered) {
      if (rnd(&rs) < FIRE_TO_SMOKE) { nidOut = E_SMOKE; } else { nidOut = E_EMPTY; }
      reset = true;
      ctype = 0.0;
    }
  } else if (id == E_SMOKE) {
    life -= SMOKE_FADE;
    if (life <= 0.0) { nidOut = E_EMPTY; reset = true; }
  } else if (ACIDIC(id)) {
    // acid, and caustic gas: used up by what they eat
    var victims = 0;
    for (var i = 0; i < faces; i++) { if (acidEats(nid[i])) { victims++; } }
    life -= ACID_USE * f32(victims);
    if (life <= 0.0) {
      if (rnd(&rs) < ACID_TO_SMOKE) { nidOut = E_SMOKE; } else { nidOut = E_EMPTY; }
      reset = true;
    }
  } else if (id == E_EMPTY) {
    // flames lick out of anything burning next to us
    if (nBurning > 0 && !smothered && rnd(&rs) < FLAME_SPREAD * f32(nBurning)) {
      nidOut = E_FIRE; reset = true; ctype = 0.0;
      T = max(T, flame * (FLAME_T_MIN + FLAME_T_SPREAD * rnd(&rs)));
    } else if (cloneOf > 0 && rnd(&rs) < CLONE_RATE) {
      nidOut = cloneOf; reset = true; T = SPAWNT(cloneOf);
      ctype = select(0.0, f32(E_STONE), cloneOf == E_LAVA);
      v = vec3f(0.0, select(SPAWN_DROP_V, 0.0, KIND(cloneOf) == K_GAS), 0.0);
    } else if (nWetMoss > 0 && mossSite(wetMoss, bed) && rnd(&rs) < MOSS_GROW * f32(nWetMoss)) {
      nidOut = E_MOSS; reset = true; ctype = 0.0;   // its damp comes in next step
    }
  } else if (id == E_MOSS || id == E_FUNGUS) {
    ctype = dampOf(T, &na);
  } else if (id == E_FUSE) {
    // Safety fuse: a black-powder core in a tarred jute sheath. The powder
    // carries its own oxidiser, so it burns with or without air, at a steady
    // speed (physics.js FUSE_*). life is 1 unlit; lit, it runs down by
    // FUSE_BURN a step, and the front passes into each fuse neighbour once
    // it is down to FUSE_HANDOFF. The sheath doesn't heat up as it burns; a
    // flame lights the core as it does gunpowder (its blast.flame).
    if (life >= 1.0) {
      var light = T >= IGNITE(id) || (nFire > 0 && rnd(&rs) < BLAST_LIT(E_GUNPOWDER).x);
      for (var i = 0; i < faces; i++) {
        light = light || (nid[i] == E_FUSE && na[i].z <= FUSE_HANDOFF) || (!isGasLike(nid[i]) && na[i].y >= IGNITE(id));
      }
      if (light) { life = 1.0 - FUSE_BURN; }
    } else {
      // At the fuse's end (no fuse beside it that burns out later), once the
      // front reaches it, the burning powder spits out of it as hot as
      // gunpowder burns: that lights the charge by touch. Burnt out, it leaves
      // a puff of smoke from the sheath, or at the end, flame.
      var end = true;
      for (var i = 0; i < faces; i++) { end = end && !(nid[i] == E_FUSE && na[i].z > life); }
      life -= FUSE_BURN;
      if (end && life <= FUSE_HANDOFF) { T = max(T, BLAST(E_GUNPOWDER).y); }
      if (life <= 0.0) { nidOut = select(E_SMOKE, E_FIRE, end); reset = true; }
    }
  } else if (id == E_OXYGEN) {
    // flames lick into oxygen as into air, as much more often as it holds more
    // oxygen, and hotter
    if (nBurning > 0 && !smothered && rnd(&rs) < FLAME_SPREAD * O2_PER_AIR * f32(nBurning)) {
      nidOut = E_FIRE; reset = true; ctype = f32(E_OXYGEN);
      T = max(T, oxyFlameT(flame, O2_PER_AIR) * (FLAME_T_MIN + FLAME_T_SPREAD * rnd(&rs)));
    }
  } else if ((id == E_CLONE || id == E_PCLN) && ctype < 1.0) {
    for (var i = 0; i < faces; i++) {
      let j = nid[i];
      if (cloneable(j)) { ctype = f32(j); break; }
    }
  } else if (id == E_SINGULARITY) {
    // Its mass is its life. It gains what it swallows (its partner, which
    // goes on the same draw: below) and a lighter singularity touching it, or
    // is taken by a heavier one; it evaporates as 1/m². Full, it bursts;
    // starved, it winks out with what little is left.
    var m = life;
    var taken = false;
    for (var i = 0; i < faces; i++) {
      if (nid[i] == E_SINGULARITY) {
        if (singTakes(life, p, na[i].z, p + DIRS(i))) { m += na[i].z; } else { taken = true; }
      }
    }
    if (swallow) { m += densityOf(nid[k], na[k].y) / DENS(E_WATER); }
    m -= SING_EVAP / max(m * m, SING_MASS_MIN);
    life = m;
    if (taken) { nidOut = E_EMPTY; reset = true; }
    else if (m < SING_MASS_MIN || m >= SING_MASS_MAX) {
      nidOut = E_FIRE; reset = true; T = SING_BURST_T;
      Pr = SING_BURST_P_PER_MASS * max(m, 0.0);
    }
  }

  // phase changes from the table (elements.js cold, hot). With latent heat,
  // life is a signed bank as water's is (+ toward hot, − toward cold), or, if
  // life holds something else, the change is stochastic (latentChance).
  if (!reacted && nidOut == id && (INTO(id)[PH_HOT] >= 0 || INTO(id)[PH_COLD] >= 0)) {
    var up = max(life, 0.0);
    var dn = max(-life, 0.0);
    var goHot = false;
    var goCold = false;
    let bank = LIFE_BANK(id);
    if (INTO(id)[PH_HOT] >= 0) {
      if (HOT(id).y == 0.0) { goHot = T >= HOT(id).x; }
      else if (bank) { goHot = latent(&T, &up, HOT(id).x, C, HOT(id).y, true); }
      else { goHot = latentChance(&T, HOT(id).x, C, HOT(id).y, true, &rs); }
    }
    if (INTO(id)[PH_COLD] >= 0 && !goHot) {
      if (COLD(id).y == 0.0) { goCold = T <= COLD(id).x; }
      else if (bank) { goCold = latent(&T, &dn, COLD(id).x, C, COLD(id).y, false); }
      else { goCold = latentChance(&T, COLD(id).x, C, COLD(id).y, false, &rs); }
    }
    if (bank && (HOT(id).y > 0.0 || COLD(id).y > 0.0)) { life = up - dn; }
    if (goHot || goCold) {
      let ph = select(PH_COLD, PH_HOT, goHot);
      nidOut = pickOut(INTO(id)[ph], &rs);
      ctype = ctypeOf(nidOut, OF(id)[ph], id);
      reset = true;
      Pr += puffP(select(COLD(id).z, HOT(id).z, goHot));
    }
  }
  // crushed by air pressure (elements.js crush)
  if (!reacted && nidOut == id && INTO(id)[PH_CRUSH] >= 0 && pOn > CRUSH_P(id)) {
    nidOut = pickOut(INTO(id)[PH_CRUSH], &rs);
    ctype = ctypeOf(nidOut, OF(id)[PH_CRUSH], id);
    reset = true;
  }

  // melting (stone, sand, metal, glass → lava that remembers what it was)
  if (!reacted && nidOut == id && MELT(id) > 0.0 && T > MELT(id)) {
    nidOut = E_LAVA; ctype = f32(MELTINTO(id)); life = 0.0;
  }

  // dust clouds (physics.js DUST_*): suspended dust between its lean and rich
  // limits goes off as one when lit by a flame, a hot touch or its own heat.
  // Settled, lean or rich, it burns as any fuel does (combustion, below).
  if (!reacted && nidOut == id && id == E_DUST) {
    var nFuel = 0;
    var hotTouch = false;
    for (var i = 0; i < faces; i++) {
      if (nid[i] == E_DUST) { nFuel++; }
      hotTouch = hotTouch || (!isGasLike(nid[i]) && na[i].y >= IGNITE(id));
    }
    let suspended = length(b.xyz) > DUST_LIFT_V;
    let cloud = suspended && f32(nFuel) >= DUST_MEC_NB && f32(nAir) >= DUST_RICH_AIR;
    if (cloud && (T >= IGNITE(id) || hotTouch || (nFire > 0 && rnd(&rs) < DUST_FIRE))) {
      nidOut = E_FIRE; reset = true; T = max(T, DUST_FLAME_T); Pr += DUST_P;
    }
  }

  // explosives (elements.js blast) and combustion
  if (!reacted && nidOut == id && INTO(id)[PH_BLAST] >= 0) {
    // It goes off at its ignition point, or the moment it touches something
    // that hot (an ember, hot metal, lava, a splinter heated by a shot); a
    // flame's touch flickers, so a flame next to it only might (blast.flame
    // per step). Or by a hard enough hit, or a blast's pressure (setOff).
    var lit = false;
    if (blastAir) {
      if (IGNITE(id) > 0.0) {
        var hotTouch = false;
        for (var i = 0; i < faces; i++) { hotTouch = hotTouch || (!isGasLike(nid[i]) && na[i].y >= IGNITE(id)); }
        lit = T >= IGNITE(id) || hotTouch;
      }
      lit = lit || setOff || (nFire > 0 && BLAST_LIT(id).x > 0.0 && rnd(&rs) < BLAST_LIT(id).x);
    }
    if (lit) {
      nidOut = pickOut(INTO(id)[PH_BLAST], &rs);
      ctype = ctypeOf(nidOut, OF(id)[PH_BLAST], id);
      reset = true; T = BLAST(id).y; Pr += BLAST(id).x;
    }
  } else if (!reacted && nidOut == id && IGNITE(id) > 0.0 && id != E_FUSE) {   // a fuse burns by its own rule
    if ((T >= IGNITE(id) || (nFire > 0 && T >= FLASH(id))) && (nAir > 0 || nFire > 0 || nOxy > 0) && !smothered) {
      // as fast as oxygen reaches it, so its heat comes out as much faster
      life -= BURNRATE(id) * oxy;
      T = max(T, min(T + BURNHEAT(id) * oxy / C, oxyFlameT(FLAMET(id), oxy)));
      Pr += BURN_P;
      if (life <= 0.0) {
        if (LEAVES_ASH(id) && rnd(&rs) < ASH_SHARE) { nidOut = E_ASH; } else { nidOut = E_FIRE; }
        reset = true;
        T = max(T, BURNT_MIN_T);
      }
    }
  }

  // damp fungus rots wood, sawdust and plant into more fungus
  if (!reacted && nidOut == id && nWetFungus > 0 && fungusFood(id) && T < DAMP_DRY_T && rnd(&rs) < FUNGUS_GROW * f32(nWetFungus)) {
    nidOut = E_FUNGUS; reset = true;
  }

  // acid (and caustic gas) eats its neighbours; what fizzes (limestone) sets its gas free as a puff
  if (!reacted && nidOut == id && nAcid > 0 && acidEats(id)) {
    if (rnd(&rs) < ACID_USE * f32(nAcid)) {
      if (rnd(&rs) < ACID_TO_SMOKE) { nidOut = E_SMOKE; } else { nidOut = E_EMPTY; }
      reset = true;
      Pr += puffP(FIZZ(id));
    }
  }

  // swallowed by the singularity it is partnered with (the draw above); its
  // heat goes in with it
  if (swallow && id != E_SINGULARITY) { nidOut = E_EMPTY; reset = true; T = airT(); ctype = 0.0; }

  // Void (elements.js VOID) drains whatever can move the step it touches it
  if (nVoid > 0 && id != E_EMPTY && KIND(id) != K_SOLID) {
    nidOut = E_EMPTY; reset = true; T = airT(); v = vec3f(0.0); ctype = 0.0;
  }

  if (nidOut != id) {
    if (CONDUCTS(id) && !CONDUCTS(nidOut) && nidOut != E_LAVA) { ctype = 0.0; }   // its spark goes with it
    if (reset) { life = SPAWNLIFE(nidOut); }
    if (grower(nidOut) || grower(id)) { ctype = 0.0; }   // a new grower's damp comes in next step; an old one's goes
    if (KIND(nidOut) == K_SOLID) { v = vec3f(0.0); }
    if (nidOut == E_FIRE) { life = FIRE_LIFE_MIN + FIRE_LIFE_SPREAD * rnd(&rs); }
  }

  // simModes.js: ambient heat off holds the air at ambient; pressure off holds it at 0
  if (P.ambientHeat == 0u && nidOut == E_EMPTY) { T = airT(); }
  if (P.airMode == AIR_PRESSURE_OFF || P.airMode == AIR_OFF) { Pr = 0.0; }
  T = clamp(T, CELL_TEMP_MIN, CELL_TEMP_MAX);
  let outA = vec4f(f32(nidOut), T, life, ctype + seed);
  let outB = vec4f(v, clamp(Pr, P_MIN, P_MAX));
  // the rest test on what this cell becomes, its neighbours as this pass saw
  // them (the activity map redoes the neighbour test where one has changed: dirty)
  var flags = ownFlags(outA, outB) | dirty;
  if ((flags & FLAG_SELF) != 0u && inertNear(p, outA, &na)) { flags |= FLAG_NEAR; }
  if (nearChange(a, outA)) { flags |= FLAG_DIRTY; }
  writeState(p, outA, outB, flags);
  return FOAMS(nidOut);
}

var<workgroup> wgFoams: atomic<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  // workgroup w: brick w % UNIT_B of the DRAWN list's entry w / UNIT_B
  let w = foldId(wg, nwg);
  if (w >= act[ACT_COUNT + CNT_DRAWN] * UNIT_B) { return; }   // the whole workgroup
  let brick = act[ACT_DRAWNL + w / UNIT_B] * UNIT_B + w % UNIT_B;
  if (reactCell(cellOf(brick * 64u + li), quietBrick(brick))) { atomicOr(&wgFoams, 1u); }
  workgroupBarrier();
  if (li == 0u) { atomicStore(&marks[MARK_FOAMS + brick], atomicLoad(&wgFoams)); }
}
`;

/** tools/check-wgsl.mjs, and the pipeline a grid needs (the start menu's warm-up, docs/webgpu.md B5). */
export const WGSL_CHECK = [{
  name: 'react',
  kind: 'compute',
  code: (g) => reactFrag(g),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, REACT_LAYOUT],
  dispatch: (g) => fold(gridDims(g).nbricks),   // at most every brick (indirect)
}];
