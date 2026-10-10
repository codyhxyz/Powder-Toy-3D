// CPU port of the GPU engine (shaders/move.js + shaders/react.js) that runs
// the dock tiles. Same element table, same rules, same constants (physics.js).
// A tile is a side-on slice, so z is dropped: the 2×2×2 Margolus block becomes
// 2×2, the six face neighbours become four, and random xz directions keep only
// their x part. Rows run bottom-up (y = 0 is the floor), as in the engine.
//
// New elements need nothing here: everything comes from their row in
// elements.js, the shared mechanisms (cold, hot, crush, blast, REACTIONS)
// included. Only an element with its own special case in react.js (water,
// fire, clone...) needs the same case added below; scripts/check-tile-engine.mjs
// flags any that are missing.
import { ELEMENTS, E, K, meltInto, breakInto, meltPoint, mechanisms, PH } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { ELEC, SPARK_BORN, CONDUCTS, SPARK_COST, sparkPhase, sparkLevel, packSpark, takesSpark, conductsInto, tsnsSenses, powered, cloneable } from '../../electricity.js';

// ---- element table, as the GLSL arrays (elements.js elementsGLSL) ----
const col = (key) => Float32Array.from(ELEMENTS, (e) => e[key]);
export const NE = ELEMENTS.length;
export const KIND = Int8Array.from(ELEMENTS, (e) => e.kind);
export const DENS = col('dens');
export const COND = col('cond');
export const CAP = col('cap');
export const GRAV = col('grav');
export const DRAG = col('drag');
export const FRICTION = col('friction');
export const JITTER = col('jitter');
export const FLOW = col('flow');
export const SLIDE = col('slide');
export const MELT = Float32Array.from(ELEMENTS, meltPoint);
export const IGNITE = col('ignite');
export const BURNRATE = col('burnRate');
export const BURNHEAT = col('burnHeat');
export const FLAMET = col('flameT');
export const SPAWNT = col('temp');
export const SPAWNLIFE = col('life');
export const SPAWNDENS = col('spawn');
export const RAD = col('rad');
// (ids: Int16, so they hold 256 elements and BREAKINTO's -1)
export const MELTINTO = Int16Array.from(ELEMENTS, meltInto);
export const HARD = col('hard');
export const BREAKINTO = Int16Array.from(ELEMENTS, breakInto);
export const ACIDPROOF = ELEMENTS.map((e) => e.acidProof);
export const ACIDIC = ELEMENTS.map((e) => e.acid);
export const FIZZ = col('fizz');
export const LEAVES_ASH = ELEMENTS.map((e) => e.ash);
// the shared mechanisms' tables (elements.js mechanisms; the GLSL arrays of
// the same names): into[id·4 + PH.*] is a spec (-1 none), of[] what a LAVA
// product sets into (-1 itself), COLD/HOT [T, latent, puff], BLAST [P, T,
// shock, crushP], RX [chance, minT, maxT, heat, puff], RX_INTO [spec a, spec b]
const M = mechanisms();
const flat = (A, rows) => A.from(rows.flat());
export const INTO = flat(Int16Array, M.into), OF = flat(Int16Array, M.of);
export const COLD = flat(Float32Array, M.cold), HOT = flat(Float32Array, M.hot), BLAST = flat(Float32Array, M.blast);
export const BLAST_LIT = flat(Float32Array, M.blastLit);   // [flame, air]
const LIFE_BANK = M.lifeBank;   // latent heat banks in life (else the change is stochastic: latentChance)
export const CRUSH_P = Float32Array.from(M.crushP);
const OUT_ID = Int16Array.from(M.outs, (o) => o[0]), OUT_CUM = Float32Array.from(M.outs, (o) => o[1]);
const SPEC_AT = Int32Array.from(M.specs, (sp) => sp[0]), SPEC_N = Int32Array.from(M.specs, (sp) => sp[1]);
const RX = flat(Float32Array, M.rx.map((r) => r.slice(0, 5))), RX_INTO = flat(Int32Array, M.rx.map((r) => r.slice(5)));
const RX_LOOKUP = M.lookup, RX_ANY = M.rx.length > 0;
// Reaction partners (react.js): along one axis per step, toward + or − by a
// parity. A slice has 2 axes, not 3, so a touching pair is partners once every
// RX_PAIRINGS steps (react.js RX_PAIRINGS is 3·2).
const RX_AXES = 2, RX_PARITIES = 2;
const RX_PAIRINGS = RX_AXES * RX_PARITIES;
const RX_SALT = 0x52;   // (react.js)
// the softest breakable solid (react.js HARD_MIN)
const HARD_MIN = Math.min(...ELEMENTS.filter((e) => e.breakInto).map((e) => e.hard));

export const AMBIENT = PHYS.AMBIENT;

const isGasLike = (id) => KIND[id] === K.GAS || id === E.EMPTY;
const isFluid = (id) => KIND[id] === K.LIQUID || isGasLike(id);
const movable = (id) => KIND[id] !== K.SOLID;
// what acid eats: matter that isn't acid-proof (activity.js acidEats)
const acidEats = (id) => KIND[id] !== K.EMPTY && KIND[id] !== K.GAS && !ACIDPROOF[id];
const airDensity = (T) => 1 - Math.min(PHYS.AIR_DENS_HI, Math.max(PHYS.AIR_DENS_LO, (T - AMBIENT) / PHYS.AIR_DENS_SPAN));
// gases thin with heat the way air does; DENS is a gas's density at its spawn temperature (common.js)
export const densityOf = (id, T) => {
  if (id === E.EMPTY) return airDensity(T);
  return KIND[id] === K.GAS ? DENS[id] * airDensity(T) / airDensity(SPAWNT[id]) : DENS[id];
};
const rnd = Math.random;
// A pair's shared random stream (react.js seeds it with seed3 at the pair's
// base cell): the PCG hash (shaders/common.js pcg), so both cells of a pair
// draw the same numbers.
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const LCG_MUL = 1664525;   // (shaders/common.js)
const UINT_TO_UNIT = 1 / 4294967296;
const pairStream = { s: 0 };
const pairSeed = (cell, frame) => { pairStream.s = pcg(cell + pcg(Math.imul(frame, LCG_MUL) + RX_SALT)); };
const pairRnd = () => { pairStream.s = pcg(pairStream.s); return pairStream.s * UINT_TO_UNIT; };
// the product of spec sp (react.js pickOut): one draw from `draw` for a weighted list, -1 = SAME
function pickOut(sp, draw) {
  const at = SPEC_AT[sp], n = SPEC_N[sp];
  if (n === 1) return OUT_ID[at];
  const r = draw();
  for (let k = 0; k < n - 1; k++) if (r < OUT_CUM[at + k]) return OUT_ID[at + k];
  return OUT_ID[at + n - 1];
}
// a product's ctype (react.js ctypeOf): for LAVA, what it sets back into
const ctypeOf = (prod, of, self) => (prod === E.LAVA ? (of >= 0 ? of : self) : 0);
// air pressure from gas set free (react.js puffP)
const puffP = (puff) => PHYS.STEAM_BOIL_PUFF * puff / PHYS.STEAM_EXPANSION;
// a reaction's temperature gate, on the pair's hotter cell (activity.js rxGate)
const rxGate = (r, Ta, Tb) => { const Th = Math.max(Ta, Tb); return Th >= RX[r * 5 + 1] && Th <= RX[r * 5 + 2]; };
// a hit's kinetic energy, ½·μ·u² (common.js hitKE); would it set off an explosive on either side (shockActs);
// does a hit by i on solid j break j or set one off (impactActs)
const hitKE = (mi, mj, jSolid, u) => 0.5 * (jSolid ? mi : mi * mj / (mi + mj)) * u * u;
const shockActs = (i, j, ke) => i !== j && ((BLAST[i * 4 + 2] > 0 && ke >= BLAST[i * 4 + 2]) || (BLAST[j * 4 + 2] > 0 && ke >= BLAST[j * 4 + 2]));
const impactActs = (i, j, ke) => (BREAKINTO[j] >= 0 && ke >= HARD[j]) || shockActs(i, j, ke);
const randDir = () => Math.cos(rnd() * Math.PI * 2); // x part of a random xz direction
// the oxygen in the gas around a cell over air's, and how hot a flame burns with it (react.js oxyShare, oxyFlameT)
const oxyShare = (nAir, nOxy) => (nAir + nOxy > 0 ? (nAir + PHYS.O2_PER_AIR * nOxy) / (nAir + nOxy) : 1);
const oxyFlameT = (T, oxy) => (T + PHYS.KELVIN) * (1 + (PHYS.OXY_FLAME_GAIN - 1) * (oxy - 1) / (PHYS.O2_PER_AIR - 1)) - PHYS.KELVIN;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function canMove(a, b, da, db, dir) {
  if (!movable(a) || !movable(b)) return false;
  if (a === b && a !== E.EMPTY) return false;
  if (isGasLike(a) && isGasLike(b)) {
    if (dir === 0) return da > db - PHYS.GAS_DENS_TOL;
    if (dir === 1) return da < db + PHYS.GAS_DENS_TOL;
    return true;
  }
  if (!isFluid(a) && !isFluid(b)) return false; // grains don't sink into grains
  if (dir === 0) return da > db;
  if (dir === 1) return da !== db;
  return db < da;
}
function dragF(a, b, da, db) {
  const la = KIND[a] === K.LIQUID, lb = KIND[b] === K.LIQUID;
  if ((la && !isGasLike(b)) || (lb && !isGasLike(a)))
    return PHYS.DRAG_LIQUID_MIN + PHYS.DRAG_LIQUID_SPAN * Math.min(1, Math.max(0, PHYS.DRAG_LIQUID_DENS * Math.abs(da - db) / Math.max(da, db)));
  return 1;
}
const bounceR = (id) => (KIND[id] === K.LIQUID ? PHYS.BOUNCE_LIQUID : KIND[id] === K.POWDER ? 0 : PHYS.BOUNCE_GAS);
// heat a cell (id a at Ta) takes from a face neighbour per step, capped so it can't overshoot (react.js condFlux)
function condFlux(a, Ta, b, Tb) {
  const dT = Tb - Ta;
  const lim = Math.abs(dT) * Math.min(CAP[a], CAP[b]) * PHYS.COND_FLUX_SHARE;
  return Math.max(-lim, Math.min(lim, Math.min(COND[a], COND[b]) * dT));
}

// ---- breaking (react.js impactKE, shatter) ----
// kinetic energy a cell carries along an axis toward a neighbour, vn > 0 toward it
const impactKE = (id, T, vn) => (movable(id) && vn > 0 ? 0.5 * densityOf(id, T) * vn * vn : 0);
// projectile (density m, speed u) breaks a solid of hardness H into debris of
// density M: the fracture takes H, then it hits the debris head on (collide)
const shat = { u: 0, d: 0 };
function shatter(m, u, H, M) {
  const u1 = Math.sqrt(Math.max(u * u - 2 * H / m, 0));
  if (u1 <= PHYS.COLLIDE_V) { shat.u = u1; shat.d = 0; return shat; }
  const inv = 1 / (m + M), vc = m * u1 * inv;
  shat.u = vc - PHYS.RESTITUTION * M * inv * u1;
  shat.d = Math.min(vc + PHYS.RESTITUTION * m * inv * u1, PHYS.V_MAX);
  return shat;
}

// latent heat with no bank (react.js latentChance): the heat crossing Tp is the chance, over L, of the change
function latentChance(T, Tp, C, L, rising) {
  const e = rising ? (T - Tp) * C : (Tp - T) * C;
  lat.T = T;
  if (e <= 0) return false;
  lat.T = Tp;
  return rnd() * L < e;
}
// latent heat bookkeeping (react.js latent): returns true when the transition completes
const lat = { T: 0, acc: 0 };
function latent(T, acc, Tp, C, L, rising) {
  if (rising) {
    if (T > Tp) { acc += (T - Tp) * C; T = Tp; }
    else if (acc > 0) { const r = Math.min(acc, (Tp - T) * C); acc -= r; T += r / C; }
  } else {
    if (T < Tp) { acc += (Tp - T) * C; T = Tp; }
    else if (acc > 0) { const r = Math.min(acc, (T - Tp) * C); acc -= r; T -= r / C; }
  }
  lat.T = T; lat.acc = acc;
  return acc >= L;
}

const FIELDS = ['id', 'T', 'life', 'ctype', 'seed', 'mark', 'vx', 'vy', 'P'];
// ctype holds a conductor's spark (src/electricity.js), up to SPARK_CYCLE·(SPARK_V + 1)
const TYPES = { id: Uint8Array, ctype: Uint16Array, mark: Uint8Array };
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1]; // +x, -x, up, down

// ---- electricity (src/electricity.js electricReactGLSL): a cell's step ----
// T, life and ctype of element id, from its face neighbours' ids, temperatures,
// lives and ctypes; results in elecOut.
const elecOut = { T: 0, life: 0, ctype: 0 };
function electric(id, T, life, ctype, nid, nT, nL, nW) {
  const life0 = life;
  if (powered(id)) {
    // switch, powered clone: turning off counts down; on and off spread through
    // touching cells of the same element (off wins); a live P beside it
    // switches it on, a live N off
    if (life > 0 && life !== ELEC.SWITCH_ON) life -= 1;
    let offNb = false, onNb = false, pOn = false, nOff = false;
    for (let q = 0; q < 4; q++) {
      const j = nid[q];
      if (j === id) {
        if (nL[q] > 0 && nL[q] < ELEC.SWITCH_ON) offNb = true;
        if (nL[q] >= ELEC.SWITCH_ON) onNb = true;
      }
      if (CONDUCTS[j] && sparkPhase(nW[q]) > ELEC.SPARK_REST) { pOn ||= j === E.PSCN; nOff ||= j === E.NSCN; }
    }
    if (life0 === ELEC.SWITCH_ON && offNb) life = ELEC.SWITCH_ON - 1;
    else if (life0 === 0 && onNb) life = ELEC.SWITCH_ON;
    if (pOn && life0 < ELEC.SWITCH_ON) life = ELEC.SWITCH_ON;
    if (nOff) life = ELEC.SWITCH_ON - 1;
  } else if (id === E.TSNS) {
    let hot = false;
    for (let q = 0; q < 4; q++) hot ||= tsnsSenses(nid[q]) && nT[q] > T + PHYS.MATTER_REST_T;
    life = hot ? ELEC.TSNS_FIRE : 0;
  }
  if (CONDUCTS[id]) {
    let ph = sparkPhase(ctype), lv = sparkLevel(ctype);
    if (ph > 0) {
      ph--;
      if (ph <= ELEC.SPARK_REST) lv = 0;
    } else if (takesSpark(id, life0)) {
      let best = 0;
      for (let q = 0; q < 4; q++) {
        const j = nid[q];
        if (j === E.BATTERY || (j === E.TSNS && nL[q] >= ELEC.TSNS_FIRE)) best = ELEC.SPARK_V;
        else if (CONDUCTS[j] && sparkPhase(nW[q]) > ELEC.SPARK_REST && conductsInto(j, id)) best = Math.max(best, sparkLevel(nW[q]));
      }
      if (best > 0) {
        const c = SPARK_COST[id];
        const spent = Math.min(Math.floor(c) + (rnd() < c - Math.floor(c) ? 1 : 0), best);
        T += spent * ELEC.JOULE_PER_LEVEL / CAP[id];
        if (best > spent) { ph = SPARK_BORN; lv = best - spent; }
      }
    }
    ctype = packSpark(ph, lv);
  }
  elecOut.T = T; elecOut.life = life; elecOut.ctype = ctype;
}

export class World {
  constructor(nx, ny) {
    this.nx = nx; this.ny = ny;
    const n = nx * ny;
    for (const f of FIELDS) { const A = TYPES[f] || Float32Array; this[f] = new A(n); this['_' + f] = new A(n); }
    this.T.fill(AMBIENT);
    this.frame = 0;
    this.gravity = 0; // set from the game's gravity setting before stepping
    this.sinkRow = -1; // a row the Erase tool is held over (gas tiles)
    // scratch for one block
    this.bk = new Int32Array(4); this.bn = new Int32Array(4); this.bsrc = new Int32Array(4);
    this.bvx = new Float32Array(4); this.bvy = new Float32Array(4); this.bd = new Float32Array(4);
    this.bm = new Uint8Array(4); this.bs = new Uint8Array(4);
    this.tA = FIELDS.slice(0, 6).map((f) => new (TYPES[f] || Float32Array)(4));
  }
  idx(x, y) { return y * this.nx + x; }
  put(x, y, id, extra = {}) {
    const i = this.idx(x, y);
    this.id[i] = id;
    this.T[i] = extra.T ?? SPAWNT[id];
    this.life[i] = extra.life ?? SPAWNLIFE[id];
    this.ctype[i] = extra.ctype ?? (id === E.LAVA ? E.STONE : 0);
    this.seed[i] = extra.seed ?? rnd();
    this.mark[i] = extra.mark ?? 0;
    this.vx[i] = 0; this.vy[i] = 0;
  }
  copyFrom(o) { for (const f of FIELDS) this[f].set(o[f]); this.frame = o.frame; }
  clone() { const w = new World(this.nx, this.ny); w.copyFrom(this); w.sinkRow = this.sinkRow; return w; }

  // ---- brush (passes.js paintFrag), applied once per frame like the game ----
  brush(cx, cy, radius, fn) {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.ny - 1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.nx - 1, Math.ceil(cx + radius)); x++) {
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (r > radius) continue;
        fn(this.idx(x, y), 1 - smoothstep(radius * PHYS.TOOL_FALLOFF, radius + 0.001, r));
      }
  }
  heat(cx, cy, radius) {
    this.brush(cx, cy, radius, (i, f) => { this.T[i] = Math.min(this.T[i] + PHYS.TOOL_HEAT * f, PHYS.CELL_TEMP_MAX); });
  }
  pressure(cx, cy, radius, strength = 1) {
    this.brush(cx, cy, radius, (i, f) => { this.P[i] += PHYS.TOOL_PRESSURE * strength * f; });
  }
  // element brush (passes.js paintFrag, element branch, without replace)
  paint(cx, cy, radius, id, rate = 1) {
    this.brush(cx, cy, radius, (i) => {
      if (this.id[i] !== E.EMPTY || rnd() > SPAWNDENS[id] * rate) return;
      const y = (i / this.nx) | 0;
      this.put(i - y * this.nx, y, id);
      if (KIND[id] === K.POWDER || KIND[id] === K.LIQUID) this.vy[i] = PHYS.SPAWN_DROP_V;
    });
  }
  erase(i) { this.id[i] = E.EMPTY; this.T[i] = AMBIENT; this.life[i] = 0; this.ctype[i] = 0; this.vx[i] = 0; this.vy[i] = 0; }
  // Spark cell i with a full spark, if it conducts, can take one and is ready
  // (src/electricity.js sparkCell, the Spark tool and lightning's entry point).
  spark(i) {
    if (!takesSpark(this.id[i], this.life[i]) || sparkPhase(this.ctype[i]) !== 0) return false;
    this.ctype[i] = packSpark(SPARK_BORN, ELEC.SPARK_V);
    return true;
  }
  // the Spark tool (passes.js paintFrag)
  sparkBrush(cx, cy, radius) { this.brush(cx, cy, radius, (i) => this.spark(i)); }

  step() {
    this.frame++;
    this.move();
    this.react();
    if (this.sinkRow >= 0) for (let x = 0; x < this.nx; x++) this.erase(this.idx(x, this.sinkRow));
  }

  // ---- movement: Margolus 2×2 blocks, partition shifts every step (move.js) ----
  move() {
    const par = this.frame & 1;
    const bxN = (this.nx >> 1) + par, byN = (this.ny >> 1) + par;
    for (let by = 0; by < byN; by++)
      for (let bx = 0; bx < bxN; bx++) this.block(bx * 2 - par, by * 2 - par);
  }
  block(x0, y0) {
    const { bk: k, bn: n, bsrc: src, bvx: vx, bvy: vy, bd: d, bm: m, bs: s } = this;
    const [tId, tT, tLife, tCt, tSeed, tMark] = this.tA;
    let any = false;
    for (let i = 0; i < 4; i++) {
      const x = x0 + (i & 1), y = y0 + (i >> 1);
      n[i] = i; m[i] = 0; s[i] = 0;
      if (x >= 0 && y >= 0 && x < this.nx && y < this.ny) {
        const j = y * this.nx + x;
        src[i] = j; k[i] = this.id[j]; vx[i] = this.vx[j]; vy[i] = this.vy[j];
        d[i] = densityOf(k[i], this.T[j]);
        tId[i] = this.id[j]; tT[i] = this.T[j]; tLife[i] = this.life[j];
        tCt[i] = this.ctype[j]; tSeed[i] = this.seed[j]; tMark[i] = this.mark[j];
        if (movable(k[i])) any = true;
      } else {
        src[i] = -1; k[i] = E.WALL; vx[i] = 0; vy[i] = 0; d[i] = DENS[E.WALL];
      }
    }
    if (!any) return;

    this.vertical(0, 2); this.vertical(1, 3);
    if (rnd() < 0.5) { this.diagonal(2); this.diagonal(3); this.diagonal(0); this.diagonal(1); }
    else { this.diagonal(3); this.diagonal(2); this.diagonal(1); this.diagonal(0); }
    this.horizontal(0, 1); this.horizontal(2, 3);

    for (let i = 0; i < 4; i++) {
      const j = src[i];
      if (j < 0) continue;
      const o = n[i];
      this.id[j] = tId[o]; this.T[j] = tT[o]; this.life[j] = tLife[o];
      this.ctype[j] = tCt[o]; this.seed[j] = tSeed[o]; this.mark[j] = tMark[o];
      this.vx[j] = vx[i]; this.vy[j] = vy[i];
    }
  }
  // block cells i and j trade places
  swap(i, j) {
    const { bk: k, bn: n, bvx: vx, bvy: vy, bd: d, bm: m } = this;
    let t = k[i]; k[i] = k[j]; k[j] = t;
    t = n[i]; n[i] = n[j]; n[j] = t;
    t = vx[i]; vx[i] = vx[j]; vx[j] = t;
    t = vy[i]; vy[i] = vy[j]; vy[j] = t;
    t = d[i]; d[i] = d[j]; d[j] = t;
    m[i] = 1; m[j] = 1;
  }
  // would particle i, at speed vn toward solid j, break it or set off an explosive? (move.js breaks)
  breaks(i, j, vn) {
    const k = this.bk;
    return impactActs(k[i], k[j], 0.5 * this.bd[i] * vn * vn);
  }
  // particle i (velocity before: v0x, v0y) was stopped by solid j: a grain's
  // real impact turns the kinetic energy it lost into heat, shared by capacity
  // so both warm alike (move.js impactHeat)
  impactHeat(i, j, v0x, v0y, speed) {
    const { bk: k, bn: n, bvx: vx, bvy: vy, bd: d } = this;
    if (KIND[k[i]] !== K.POWDER || speed <= PHYS.COLLIDE_V) return;
    const lost = Math.max(0.5 * d[i] * (v0x * v0x + v0y * v0y - vx[i] * vx[i] - vy[i] * vy[i]), 0);
    const dT = lost * PHYS.KE_TO_HEAT / (CAP[k[i]] + CAP[k[j]]);
    const tT = this.tA[1];
    tT[n[i]] += dT; tT[n[j]] += dT;   // a box edge (j outside) takes its share away
  }
  // a particle tried to fall at vyIn and hit something
  land(i, vyIn) {
    const { bk: k, bvx: vx, bvy: vy } = this, id = k[i];
    vy[i] = 0;
    if (KIND[id] === K.LIQUID && vyIn < -PHYS.LAND_SPLASH_V) {
      let h = vx[i];
      const f = FLOW[id];
      if (h * h < f * f * PHYS.LAND_SPLASH_FLOW) h = randDir() * f;
      h += Math.sign(h) * -vyIn * PHYS.LAND_SPLASH_GAIN;
      vx[i] = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, h));
    } else if (KIND[id] === K.POWDER) {
      vx[i] = vx[i] * PHYS.LAND_POWDER_KEEP + randDir() * -vyIn * PHYS.LAND_POWDER_SCATTER;
    }
  }
  // i on the negative side, j on the positive side, along v (bvx or bvy)
  collide(i, j, v) {
    const d = this.bd, rel = v[i] - v[j];
    if (rel > PHYS.COLLIDE_V) {
      const mi = d[i], mj = d[j], inv = 1 / (mi + mj), vc = (mi * v[i] + mj * v[j]) * inv;
      v[i] = vc - PHYS.RESTITUTION * mj * inv * rel;
      v[j] = vc + PHYS.RESTITUTION * mi * inv * rel;
    } else if (rel > 0) {
      if (v[i] > 0) v[i] = 0;
      if (v[j] < 0) v[j] = 0;
    }
  }
  // 1. vertical exchange within one column (b = bottom, t = top)
  vertical(b, t) {
    const { bk: k, bvy: vy, bd: d, bs: s } = this;
    const mt = movable(k[t]), mb = movable(k[b]);
    const down = vy[t] < 0, up = vy[b] > 0;
    // held at rest by the normal force, it still presses on what's below, so it may topple (move.js)
    const held = vy[t] === 0 && GRAV[k[t]] * this.gravity > 0;
    if (!mt || !mb) {
      if (mt && down && !this.breaks(t, b, vy[t])) {
        const v0x = this.bvx[t], v0y = vy[t];
        this.land(t, vy[t]); s[t] = 1;
        this.impactHeat(t, b, v0x, v0y, -v0y);
      } else if (mt && held) s[t] = 1;
      if (mb && up && !this.breaks(b, t, vy[b])) {
        const v0x = this.bvx[b], v0y = vy[b];
        vy[b] = 0; s[b] = 1;
        this.impactHeat(b, t, v0x, v0y, v0y);
      }
    } else if (down || up) {
      const okDown = down && canMove(k[t], k[b], d[t], d[b], 0);
      const okUp = up && canMove(k[b], k[t], d[b], d[t], 1);
      if (okDown || okUp) {
        const pr = Math.max(okDown ? -vy[t] : 0, okUp ? vy[b] : 0) * dragF(k[t], k[b], d[t], d[b]);
        if (rnd() < pr) this.swap(t, b);
      } else if (!(vy[b] > vy[t] && shockActs(k[t], k[b], hitKE(d[t], d[b], false, vy[b] - vy[t])))) {
        // (a hit that sets off an explosive is left as it is: react sees it)
        const vt = vy[t];
        this.collide(b, t, vy);
        if (down) {
          if (KIND[k[t]] === K.LIQUID) { const after = vy[t]; this.land(t, vt); vy[t] += after; }
          s[t] = 1;
        } else if (held) s[t] = 1;
        if (up) s[b] = 1;
      }
    } else if (held && !canMove(k[t], k[b], d[t], d[b], 0)) s[t] = 1;
  }
  // 2. a blocked top cell topples diagonally (powders, liquids); a blocked bottom buoyant gas cell rises diagonally
  diagonal(i) {
    const { bk: k, bd: d, bm: m, bs: s } = this;
    if (!s[i] || m[i]) return;
    const top = (i & 2) !== 0, xi = i & 1, kd = KIND[k[i]];
    if (top ? !(kd === K.POWDER || kd === K.LIQUID) : !(kd === K.GAS && GRAV[k[i]] < 0)) return;   // buoyant gases (not cloud)
    if (kd === K.POWDER && rnd() > SLIDE[k[i]]) return;
    const c = 1 - xi, target = c + (top ? 0 : 2), path = c + (top ? 2 : 0);
    const passable = top ? isFluid(k[path]) && d[path] < d[i] : isFluid(k[path]);
    if (m[target] || !passable || !canMove(k[i], k[target], d[i], d[target], top ? 0 : 1)) return;
    this.swap(i, target); // the 3D engine scores up to three candidates; a slice has one
  }
  // 3. horizontal exchange between i and its +x neighbour j
  horizontal(i, j) {
    const { bk: k, bvx: vx, bd: d, bm: m } = this;
    if (m[i] || m[j]) return;
    const h0 = vx[i], h1 = vx[j], w0 = h0 > 0, w1 = h1 < 0;
    if (!w0 && !w1) return;
    const ok0 = w0 && canMove(k[i], k[j], d[i], d[j], 2);
    const ok1 = w1 && canMove(k[j], k[i], d[j], d[i], 2);
    if (ok0 || ok1) {
      const pr = Math.max(ok0 ? h0 : 0, ok1 ? -h1 : 0) * dragF(k[i], k[j], d[i], d[j]);
      if (rnd() < pr) this.swap(i, j);
    } else if (movable(k[i]) && movable(k[j])) {
      if (!(h0 > h1 && shockActs(k[i], k[j], hitKE(d[i], d[j], false, h0 - h1)))) this.collide(i, j, vx);
    } else {
      const vy = this.bvy;
      if (w0 && !this.breaks(i, j, h0)) { const v0y = vy[i]; vx[i] *= bounceR(k[i]); this.impactHeat(i, j, h0, v0y, h0); }
      if (w1 && !this.breaks(j, i, h1)) { const v0y = vy[j]; vx[j] *= bounceR(k[j]); this.impactHeat(j, i, h1, v0y, -h1); }
    }
  }

  // ---- react: heat, pressure, forces, reactions (react.js) ----
  react() {
    const { nx, ny } = this;
    const ID = this.id, TT = this.T, LIFE = this.life, CT = this.ctype, VX = this.vx, VY = this.vy, PP = this.P;
    const oID = this._id, oT = this._T, oLife = this._life, oCT = this._ctype, oVX = this._vx, oVY = this._vy, oP = this._P;
    const nid = [0, 0, 0, 0], nT = [0, 0, 0, 0], nW = [0, 0, 0, 0], nP = [0, 0, 0, 0], pn = [0, 0, 0, 0], nL = [0, 0, 0, 0];
    const nVX = [0, 0, 0, 0], nVY = [0, 0, 0, 0];
    const g = this.gravity;
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const id = ID[i];
        let T = TT[i], life = LIFE[i], ctype = CT[i], vx = VX[i], vy = VY[i];
        const P0 = PP[i];
        for (let q = 0; q < 4; q++) {
          const qx = x + DX[q], qy = y + DY[q];
          if (qx >= 0 && qy >= 0 && qx < nx && qy < ny) {
            const j = qy * nx + qx;
            nid[q] = ID[j]; nT[q] = TT[j]; nW[q] = CT[j]; nP[q] = PP[j]; nVX[q] = VX[j]; nVY[q] = VY[j]; nL[q] = LIFE[j];
          } else { nid[q] = E.WALL; nT[q] = T; nW[q] = 0; nP[q] = P0; nVX[q] = 0; nVY[q] = 0; nL[q] = 0; } // insulating, pressure-reflecting box
        }

        // breaking (impacts and blasts), from the input state
        // as a projectile: each breakable neighbour I hit hard enough costs me its hardness
        let dvx = 0, dvy = 0;
        const T0 = TT[i];
        if (movable(id) && 0.5 * densityOf(id, T0) * (vx * vx + vy * vy) >= HARD_MIN) {
          const m = densityOf(id, T0);
          for (let q = 0; q < 4; q++) {
            const sId = nid[q];
            if (BREAKINTO[sId] < 0) continue;
            const u = DX[q] * vx + DY[q] * vy;
            if (impactKE(id, T0, u) < HARD[sId]) continue;
            const du = u - shatter(m, u, HARD[sId], densityOf(BREAKINTO[sId], T0)).u;
            dvx -= DX[q] * du; dvy -= DY[q] * du;
          }
        }
        // as a breakable solid: the same test from my side, plus a blast across me
        let broke = false, fractureE = 0, dbx = 0, dby = 0;
        if (BREAKINTO[id] >= 0) {
          const M = densityOf(BREAKINTO[id], T0);
          for (let q = 0; q < 4; q++) {
            const u = -(DX[q] * nVX[q] + DY[q] * nVY[q]);   // the neighbour's speed toward me
            if (impactKE(nid[q], nT[q], u) < HARD[id]) continue;
            const ud = shatter(densityOf(nid[q], nT[q]), u, HARD[id], M).d;
            dbx -= DX[q] * ud; dby -= DY[q] * ud;
            fractureE += HARD[id];
            broke = true;
          }
          for (let q = 0; q < 4; q++) pn[q] = KIND[nid[q]] !== K.SOLID ? nP[q] : 0;
          if (Math.max(Math.abs(pn[0] - pn[1]), Math.abs(pn[2] - pn[3])) > HARD[id] * PHYS.P_BREAK_PER_HARD) broke = true;
        }

        // what sets off an explosive or crushes a cell, from the input (react.js)
        // a hit: matter and I closing at speed u (landing included), ½·μ·u², not my own element
        let shocked = false;
        const shock = BLAST[id * 4 + 2];
        if (shock > 0) {
          const m = densityOf(id, T0), meSolid = KIND[id] === K.SOLID;
          for (let q = 0; q < 4; q++) {
            const j = nid[q], u = DX[q] * (VX[i] - nVX[q]) + DY[q] * (VY[i] - nVY[q]);
            if (j === id || isGasLike(j) || u <= 0) continue;
            const mj = densityOf(j, nT[q]);
            if ((meSolid ? hitKE(mj, m, true, u) : hitKE(m, mj, KIND[j] === K.SOLID, u)) >= shock) shocked = true;
          }
        }
        // the highest air pressure on me: my own, and my open neighbours' (a solid holds none)
        let pOn = KIND[id] === K.SOLID ? PHYS.P_MIN : P0, touchAir = false;
        for (let q = 0; q < 4; q++) {
          if (KIND[nid[q]] !== K.SOLID) pOn = Math.max(pOn, nP[q]);
          if (nid[q] === E.EMPTY) touchAir = true;
        }
        // an explosive that needs air goes off only touching it; set off by a hit or a
        // blast's pressure, it goes off rather than break
        const blastAir = BLAST_LIT[id * 2 + 1] === 0 || touchAir;
        const crushP = BLAST[id * 4 + 3];
        const setOff = blastAir && (shocked || (crushP > 0 && pOn > crushP));

        // reactions (elements.js REACTIONS), decided from the input: this step
        // every cell's partner is its neighbour along axis frame % 2, toward +
        // where its coordinate plus the parity is even, else toward − (react.js)
        let reacted = false, rxOut = id, rxT = 0, rxP = 0;
        if (RX_ANY) {
          const ax = this.frame % RX_AXES, par = ((this.frame / RX_AXES) | 0) % RX_PARITIES;
          const base = (((ax === 0 ? x : y) + par) & 1) === 0;
          const q = 2 * ax + (base ? 0 : 1);
          const qx = x + DX[q], qy = y + DY[q];
          const v = RX_LOOKUP[id * NE + nid[q]];
          if (v > 0 && qx >= 0 && qy >= 0 && qx < nx && qy < ny) {
            const r = (v - 1) >> 1, isA = ((v - 1) & 1) === 0;
            pairSeed(base ? i : qy * nx + qx, this.frame);
            if (rxGate(r, T0, nT[q]) && pairRnd() < RX[r * 5] * RX_PAIRINGS) {
              const ida = isA ? id : nid[q], idb = isA ? nid[q] : id;
              let oa = pickOut(RX_INTO[r * 2], pairRnd), ob = pickOut(RX_INTO[r * 2 + 1], pairRnd);
              if (oa < 0) oa = ida;   // SAME
              if (ob < 0) ob = idb;
              reacted = true;
              rxOut = isA ? oa : ob;
              rxT = RX[r * 5 + 3] / (CAP[oa] + CAP[ob]);
              rxP = 0.5 * puffP(RX[r * 5 + 4]);
            }
          }
        }

        // heat conduction (energy conserving, each face capped)
        const C = CAP[id];
        let dE = 0;
        for (let q = 0; q < 4; q++) dE += condFlux(id, T, nid[q], nT[q]);
        T += dE / C;
        T += (AMBIENT - T) * (id === E.EMPTY ? PHYS.AIR_AMBIENT_PULL : RAD[id]);

        // air pressure
        const solid = KIND[id] === K.SOLID;
        let P = P0, gx = 0, gy = 0;
        if (!solid) {
          let lap = 0, front = 0;
          for (let q = 0; q < 4; q++) {
            pn[q] = KIND[nid[q]] !== K.SOLID ? nP[q] : P0;
            lap += pn[q] - P0;
            front = Math.max(front, pn[q]);
          }
          P = Math.max(P0 + PHYS.P_DIFFUSE * lap, front * PHYS.P_FRONT) * PHYS.P_DECAY;
          gx = 0.5 * (pn[0] - pn[1]);
          gy = 0.5 * (pn[2] - pn[3]);
        } else P = 0;

        // forces
        if (!solid) {
          const rho = Math.max(densityOf(id, T) * PHYS.RHO_SCALE, PHYS.RHO_MIN);
          vx -= gx * PHYS.P_ACCEL / rho;
          vy -= gy * PHYS.P_ACCEL / rho;
          if (id === E.EMPTY || id === E.CLOUD) vy += g * Math.min(PHYS.AIR_BUOY_HI, Math.max(PHYS.AIR_BUOY_LO, (T - AMBIENT) / (AMBIENT + PHYS.KELVIN)));
          if (id !== E.EMPTY) vy -= g * GRAV[id];
          vx *= 1 - DRAG[id];
          vy *= 1 - DRAG[id];
          // normal force: at rest on what can hold it up, gravity can't start it moving down (react.js)
          const d = densityOf(id, T0);
          const held = (KIND[id] === K.POWDER || KIND[id] === K.LIQUID) && VY[i] >= 0 && (y === 0 || KIND[nid[3]] === K.SOLID
            || (!canMove(id, nid[3], d, densityOf(nid[3], nT[3]), 0) && nVY[3] >= 0));
          if (held) vy = Math.max(vy, 0);
          const below = KIND[nid[3]];
          const supported = y === 0 || below === K.SOLID || below === K.POWDER;
          if (supported) vx *= 1 - FRICTION[id];
          if (KIND[id] === K.LIQUID && (supported || below === K.LIQUID)) {
            // pushed sideways only where it can go (react.js)
            const open = canMove(id, nid[0], d, densityOf(nid[0], nT[0]), 2) || canMove(id, nid[1], d, densityOf(nid[1], nT[1]), 2);
            const up = KIND[nid[2]];
            const head = up === K.LIQUID || up === K.POWDER;
            const onLiquid = !supported;
            const f = FLOW[id];
            if (head || onLiquid) {
              const want = head ? f : f * PHYS.FLOW_SURFACE;
              if (open && Math.abs(vx) < want * PHYS.FLOW_KICK) vx = randDir() * want;
            } else {
              const l = KIND[nid[0]] === K.LIQUID, r = KIND[nid[1]] === K.LIQUID;
              vx = vx * PHYS.FILM_KEEP + (open ? ((l ? 1 : 0) - (r ? 1 : 0)) * f * PHYS.FILM_COHESION : 0);
              if (open && !l && !r && rnd() < PHYS.DROPLET_WANDER) vx = randDir() * f * PHYS.DROPLET_SPEED;
            }
          }
          if (JITTER[id] > 0) { vx += (rnd() - 0.5) * JITTER[id]; vy += (rnd() - 0.5) * JITTER[id]; }
          vx += dvx; vy += dvy;
          vx = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, vx));
          vy = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, vy));
          // a held cell's leftover creep stops dead (physics.js REST_V)
          if (held) { if (Math.abs(vx) < PHYS.REST_V) vx = 0; if (Math.abs(vy) < PHYS.REST_V) vy = 0; }
        } else { vx = 0; vy = 0; }

        // electricity: sparks, switches, sensors (react.js electric)
        electric(id, T, life, ctype, nid, nT, nL, nW);
        T = elecOut.T; life = elecOut.life; ctype = elecOut.ctype;

        // reactions and phase changes
        let out = id, reset = false;
        let nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0, flame = 0, cloneOf = 0, nCloud = 0, nOxy = 0, nOxyFire = 0, nCO2 = 0, nGas = 0;
        let surface = false;   // a non-gas neighbour to condense onto (the floor counts, the sides and lid don't)
        for (let q = 0; q < 4; q++) {
          const j = nid[q];
          if (j === E.EMPTY) nAir++;
          if (j === E.CLOUD) nCloud++;
          const qx = x + DX[q], qy = y + DY[q];
          if (!isGasLike(j) && ((qx >= 0 && qy >= 0 && qx < nx && qy < ny) || q === 3)) surface = true;
          if (j === E.FIRE) nFire++;
          if (j === E.OXYGEN) nOxy++;
          if (j === E.FIRE && nW[q] === E.OXYGEN) nOxyFire++;   // a flame burning in oxygen (react.js)
          if (j === E.CO2) nCO2++;
          if (isGasLike(j)) nGas++;
          if (ACIDIC[j]) nAcid++;
          if (j === E.PLANT) nPlant++;
          if ((j === E.CLONE || (j === E.PCLN && nL[q] === ELEC.SWITCH_ON)) && nW[q] >= 1) cloneOf = nW[q];   // a powered clone only while on
          if (IGNITE[j] > 0 && INTO[j * 4 + PH.BLAST] < 0 && nT[q] >= IGNITE[j]) { nBurning++; flame = Math.max(flame, FLAMET[j]); }   // (explosives go off instead)
        }
        const oxy = oxyShare(nAir + nFire - nOxyFire, nOxy + nOxyFire);
        const smothered = nCO2 > 0 && nCO2 >= PHYS.CO2_SMOTHER * nGas;   // carbon dioxide puts flames out (react.js)

        if (reacted) {
          T += rxT;
          P += rxP;
          if (rxOut !== id) { out = rxOut; reset = true; ctype = 0; }
        } else if (broke && !setOff) {
          // debris keeps temperature, life and ctype, takes the fracture work as heat and the hits' momentum
          out = BREAKINTO[id];
          T += fractureE * PHYS.KE_TO_HEAT / CAP[out];
          vx = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, dbx));
          vy = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, dby));
        } else if (id === E.WATER) {
          let up = Math.max(life, 0), dn = Math.max(-life, 0);
          const boil = latent(T, up, 100, C, PHYS.L_BOIL, true); T = lat.T; up = lat.acc;
          const freeze = latent(T, dn, 0, C, PHYS.L_FUSE, false); T = lat.T; dn = lat.acc;
          life = up - dn;
          if (boil) { out = E.STEAM; life = 0; P += PHYS.STEAM_BOIL_PUFF; }
          else if (freeze) { out = E.ICE; life = 0; }
          if (nPlant > 0 && rnd() < PHYS.PLANT_GROW * nPlant) { out = E.PLANT; reset = true; }
        } else if (id === E.ICE || id === E.SNOW) {
          const melt = latent(T, life, 0, C, PHYS.L_FUSE, true); T = lat.T; life = lat.acc;
          if (melt) { out = E.WATER; life = 0; }
        } else if (id === E.STEAM) {
          const cond = latent(T, life, 100, C, PHYS.L_BOIL, false); T = lat.T; life = lat.acc;
          if (cond) { out = surface ? E.WATER : E.CLOUD; life = 0; }
        } else if (id === E.CLOUD) {
          let up = Math.max(life, 0), dn = Math.max(-life, 0);
          const boil = latent(T, up, 100, C, PHYS.L_BOIL, true); T = lat.T; up = lat.acc;
          const freeze = latent(T, dn, 0, C, PHYS.L_FUSE, false); T = lat.T; dn = lat.acc;
          life = up - dn;
          if (boil) { out = E.STEAM; life = 0; }
          else if (freeze) { out = E.SNOW; life = 0; }
          else {
            const rain = PHYS.CLOUD_RAIN * Math.max(nCloud - PHYS.CLOUD_RAIN_NB, 0);
            const es = Math.exp(PHYS.MAGNUS_A * (T / (T + PHYS.MAGNUS_B) - AMBIENT / (AMBIENT + PHYS.MAGNUS_B)));
            const r = rnd();
            if (r < rain) { out = E.WATER; life = 0; }
            else if (r < rain + PHYS.CLOUD_EVAP * Math.max(nAir - PHYS.CLOUD_EVAP_NB, 0) * es) { out = E.EMPTY; reset = true; T -= PHYS.CLOUD_EVAP_COOL; }
          }
        } else if (id === E.LAVA) {
          let ct = ctype;
          if (ct <= 0 || ct >= NE) ct = E.STONE;
          if (T < MELT[ct] - PHYS.LAVA_FREEZE_BELOW) { out = ct; reset = true; ctype = 0; }
        } else if (id === E.FIRE) {
          life -= PHYS.FIRE_BURN + PHYS.FIRE_BURN_SPREAD * rnd();
          if (life <= 0 || T < PHYS.FIRE_MIN_T || smothered) { out = rnd() < PHYS.FIRE_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true; ctype = 0; }
        } else if (id === E.SMOKE) {
          life -= PHYS.SMOKE_FADE;
          if (life <= 0) { out = E.EMPTY; reset = true; }
        } else if (ACIDIC[id]) {   // acid, and caustic gas
          let victims = 0;
          for (let q = 0; q < 4; q++) if (acidEats(nid[q])) victims++;
          life -= PHYS.ACID_USE * victims;
          if (life <= 0) { out = rnd() < PHYS.ACID_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true; }
        } else if (id === E.EMPTY) {
          if (nBurning > 0 && !smothered && rnd() < PHYS.FLAME_SPREAD * nBurning) {
            out = E.FIRE; reset = true; ctype = 0; T = Math.max(T, flame * (PHYS.FLAME_T_MIN + PHYS.FLAME_T_SPREAD * rnd()));
          } else if (cloneOf > 0 && rnd() < PHYS.CLONE_RATE) {
            out = cloneOf; reset = true; T = SPAWNT[cloneOf];
            ctype = cloneOf === E.LAVA ? E.STONE : 0;
            vx = 0; vy = KIND[cloneOf] === K.GAS ? 0 : PHYS.SPAWN_DROP_V;
          }
        } else if (id === E.OXYGEN) {
          // flames lick into oxygen as into air, more often and hotter (react.js)
          if (nBurning > 0 && !smothered && rnd() < PHYS.FLAME_SPREAD * PHYS.O2_PER_AIR * nBurning) {
            out = E.FIRE; reset = true; ctype = E.OXYGEN;
            T = Math.max(T, oxyFlameT(flame, PHYS.O2_PER_AIR) * (PHYS.FLAME_T_MIN + PHYS.FLAME_T_SPREAD * rnd()));
          }
        } else if ((id === E.CLONE || id === E.PCLN) && ctype < 1) {
          for (let q = 0; q < 4; q++) {
            const j = nid[q];
            if (cloneable(j)) { ctype = j; break; }
          }
        }

        // phase changes from the table (elements.js cold, hot): with latent
        // heat, life is a signed accumulator as water's is
        const hotSp = INTO[id * 4 + PH.HOT], coldSp = INTO[id * 4 + PH.COLD];
        if (!reacted && out === id && (hotSp >= 0 || coldSp >= 0)) {
          const hL = HOT[id * 3 + 1], cL = COLD[id * 3 + 1], bank = LIFE_BANK[id];
          let up = Math.max(life, 0), dn = Math.max(-life, 0), goHot = false, goCold = false;
          if (hotSp >= 0) {
            if (hL === 0) goHot = T >= HOT[id * 3];
            else if (bank) { goHot = latent(T, up, HOT[id * 3], C, hL, true); T = lat.T; up = lat.acc; }
            else { goHot = latentChance(T, HOT[id * 3], C, hL, true); T = lat.T; }
          }
          if (coldSp >= 0 && !goHot) {
            if (cL === 0) goCold = T <= COLD[id * 3];
            else if (bank) { goCold = latent(T, dn, COLD[id * 3], C, cL, false); T = lat.T; dn = lat.acc; }
            else { goCold = latentChance(T, COLD[id * 3], C, cL, false); T = lat.T; }
          }
          if (bank && (hL > 0 || cL > 0)) life = up - dn;
          if (goHot || goCold) {
            const ph = goHot ? PH.HOT : PH.COLD;
            out = pickOut(INTO[id * 4 + ph], rnd);
            ctype = ctypeOf(out, OF[id * 4 + ph], id);
            reset = true;
            P += puffP(goHot ? HOT[id * 3 + 2] : COLD[id * 3 + 2]);
          }
        }
        // crushed by air pressure (elements.js crush)
        if (!reacted && out === id && INTO[id * 4 + PH.CRUSH] >= 0 && pOn > CRUSH_P[id]) {
          out = pickOut(INTO[id * 4 + PH.CRUSH], rnd);
          ctype = ctypeOf(out, OF[id * 4 + PH.CRUSH], id);
          reset = true;
        }

        // melting (stone, sand, metal, glass → lava that remembers what it was)
        if (!reacted && out === id && MELT[id] > 0 && T > MELT[id]) { out = E.LAVA; ctype = MELTINTO[id]; life = 0; }

        // explosives (elements.js blast) and combustion
        if (!reacted && out === id && INTO[id * 4 + PH.BLAST] >= 0) {
          // at its ignition point, or touching something that hot (not a gas: a flame only might),
          // or by a hard enough hit, or a blast's pressure
          let lit = false;
          if (blastAir) {
            if (IGNITE[id] > 0) {
              let hotTouch = false;
              for (let q = 0; q < 4; q++) hotTouch ||= !isGasLike(nid[q]) && nT[q] >= IGNITE[id];
              lit = T >= IGNITE[id] || hotTouch;
            }
            const flame = BLAST_LIT[id * 2];
            lit = lit || setOff || (nFire > 0 && flame > 0 && rnd() < flame);
          }
          if (lit) {
            out = pickOut(INTO[id * 4 + PH.BLAST], rnd);
            ctype = ctypeOf(out, OF[id * 4 + PH.BLAST], id);
            reset = true; T = BLAST[id * 4 + 1]; P += BLAST[id * 4];
          }
        } else if (!reacted && out === id && IGNITE[id] > 0) {
          if (T >= IGNITE[id] && (nAir > 0 || nFire > 0 || nOxy > 0) && !smothered) {
            // as fast as oxygen reaches it, and hotter with more (react.js)
            life -= BURNRATE[id] * oxy;
            T = Math.max(T, Math.min(T + BURNHEAT[id] * oxy / C, oxyFlameT(FLAMET[id], oxy)));
            P += PHYS.BURN_P;
            if (life <= 0) {
              out = LEAVES_ASH[id] && rnd() < PHYS.ASH_SHARE ? E.ASH : E.FIRE;
              reset = true;
              T = Math.max(T, PHYS.BURNT_MIN_T);
            }
          }
        }

        // acid eats its neighbours; what fizzes (limestone) sets its gas free as a puff
        if (!reacted && out === id && nAcid > 0 && acidEats(id)) {
          if (rnd() < PHYS.ACID_USE * nAcid) {
            out = rnd() < PHYS.ACID_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true;
            P += puffP(FIZZ[id]);
          }
        }

        if (out !== id) {
          if (CONDUCTS[id] && !CONDUCTS[out] && out !== E.LAVA) ctype = 0;   // its spark goes with it
          if (reset) life = SPAWNLIFE[out];
          if (KIND[out] === K.SOLID) { vx = 0; vy = 0; }
          if (out === E.FIRE) life = PHYS.FIRE_LIFE_MIN + PHYS.FIRE_LIFE_SPREAD * rnd();
        }

        oID[i] = out;
        oT[i] = Math.max(PHYS.CELL_TEMP_MIN, Math.min(PHYS.CELL_TEMP_MAX, T));
        oLife[i] = life;
        oCT[i] = ctype;
        oVX[i] = vx; oVY[i] = vy;
        oP[i] = Math.max(PHYS.P_MIN, Math.min(PHYS.P_MAX, P));
      }
    for (const f of ['id', 'T', 'life', 'ctype', 'vx', 'vy', 'P']) { const t = this[f]; this[f] = this['_' + f]; this['_' + f] = t; }
  }
}
