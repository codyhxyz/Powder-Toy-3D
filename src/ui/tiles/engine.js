// CPU port of the GPU engine (shaders/move.js + shaders/react.js) that runs
// the dock tiles. Same element table, same rules, same constants (physics.js).
// A tile is a side-on slice, so z is dropped: the 2×2×2 Margolus block becomes
// 2×2, the six face neighbours become four, and random xz directions keep only
// their x part. Rows run bottom-up (y = 0 is the floor), as in the engine.
//
// New elements need nothing here: everything comes from their row in
// elements.js. Only an element with its own special case in react.js (water,
// fire, clone...) needs the same case added below; scripts/check-tile-engine.mjs
// flags any that are missing.
import { ELEMENTS, E, K, meltInto, breakInto } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { BOLT, STORM, boltPath, stormColumns, pickStrike } from '../../bolt.js';

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
export const MELT = col('melt');
export const IGNITE = col('ignite');
export const BURNRATE = col('burnRate');
export const BURNHEAT = col('burnHeat');
export const FLAMET = col('flameT');
export const SPAWNT = col('temp');
export const SPAWNLIFE = col('life');
export const SPAWNDENS = col('spawn');
export const RAD = col('rad');
export const MELTINTO = Int8Array.from(ELEMENTS, meltInto);
export const HARD = col('hard');
export const BREAKINTO = Int8Array.from(ELEMENTS, breakInto);
export const ACIDPROOF = ELEMENTS.map((e) => e.acidProof);
export const FIZZ = col('fizz');
export const LEAVES_ASH = ELEMENTS.map((e) => e.ash);
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
const randDir = () => Math.cos(rnd() * Math.PI * 2); // x part of a random xz direction
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
const TYPES = { id: Uint8Array, ctype: Uint8Array, mark: Uint8Array };
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1]; // +x, -x, up, down

export class World {
  constructor(nx, ny) {
    this.nx = nx; this.ny = ny;
    const n = nx * ny;
    for (const f of FIELDS) { const A = TYPES[f] || Float32Array; this[f] = new A(n); this['_' + f] = new A(n); }
    this.T.fill(AMBIENT);
    this.frame = 0;
    this.gravity = 0; // set from the game's gravity setting before stepping
    this.lastStrike = -Infinity; // storms (src/lightning.js): the last natural strike's frame
    this.strikes = 0;
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

  step() {
    this.frame++;
    this.move();
    this.react();
    if (this.frame % STORM.POLL_STEPS === 0) this.storm();
    if (this.sinkRow >= 0) for (let x = 0; x < this.nx; x++) this.erase(this.idx(x, this.sinkRow));
  }

  // ---- lightning (src/lightning.js, shaders/lightning.js boltFrag; one bolt: src/bolt.js) ----
  // A bolt from `from` to `to` ([x, y] cells, continuous), in the slice.
  strike(from, to, { strikeR = STORM.STRIKE_R, dischargeR = 0, rng = rnd } = {}) {
    const size = [this.nx, this.ny, 1];
    const segs = boltPath([from[0], from[1], 0.5], [to[0], to[1], 0.5], rng, size, true);
    for (let y = 0; y < this.ny; y++)
      for (let x = 0; x < this.nx; x++) {
        const i = this.idx(x, y), cx = x + 0.5, cy = y + 0.5;
        const id = this.id[i], open = isGasLike(id);
        let channel = false;
        for (const sg of segs) {
          const ax = sg.a[0], ay = sg.a[1], bx = sg.b[0] - ax, by = sg.b[1] - ay;
          const t = Math.min(1, Math.max(0, ((cx - ax) * bx + (cy - ay) * by) / Math.max(bx * bx + by * by, 1e-6)));
          if (Math.hypot(cx - ax - bx * t, cy - ay - by * t) < sg.r) { channel = true; break; }
        }
        if (channel) {
          if (open) {
            const P = this.P[i];
            this.put(x, y, E.PLASMA);
            this.P[i] = Math.min(P + BOLT.P, PHYS.P_MAX);
          } else this.T[i] = Math.min(this.T[i] + BOLT.E / CAP[id], PHYS.CELL_TEMP_MAX);
        }
        const r = Math.hypot(cx - to[0], cy - to[1]);
        if (!open && r < strikeR) {
          const f = 1 - smoothstep(strikeR * BOLT.STRIKE_CORE, strikeR, r);
          this.T[i] = Math.min(this.T[i] + BOLT.STRIKE_E * f / CAP[id], PHYS.CELL_TEMP_MAX);
        }
        if (open && r < strikeR + BOLT.STRIKE_P_REACH) this.P[i] = Math.min(Math.max(this.P[i], BOLT.STRIKE_P), PHYS.P_MAX);
        if (this.id[i] === E.CLOUD && Math.hypot(cx - from[0], cy - from[1]) < dischargeR) this.ctype[i] = 0;
      }
    return segs;
  }
  // a storm (src/lightning.js update): the most charged cloud cell at
  // breakdown strikes the nearest of the columns below it, rate-limited
  storm() {
    if (this.frame - this.lastStrike < STORM.MIN_STEPS) return;
    let best = -1, q = 0;
    for (let i = 0; i < this.id.length; i++)
      if (this.id[i] === E.CLOUD && this.ctype[i] >= PHYS.CHARGE_BREAKDOWN && this.ctype[i] > q) { q = this.ctype[i]; best = i; }
    if (best < 0) return;
    const by = (best / this.nx) | 0, origin = [best - by * this.nx + 0.5, by + 0.5, 0.5];
    const hits = stormColumns(origin, [this.nx, this.ny, 1], STORM.CANDIDATES, true).map(([x]) => {
      let top = -1, id = -1;
      for (let y = by - 1; y >= 0; y--) { const j = this.id[this.idx(x, y)]; if (!isGasLike(j)) { top = y; id = j; break; } }
      return { x, z: 0, top, id };
    });
    const pick = pickStrike(origin, hits);
    if (!pick) return;
    this.lastStrike = this.frame;
    this.strikes++;
    this.strike([origin[0], origin[1]], [pick.to[0], pick.to[1]], { dischargeR: STORM.DISCHARGE_R });
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
  // would particle i, at speed vn toward solid j, break it? (move.js breaks)
  breaks(i, j, vn) {
    const k = this.bk;
    return BREAKINTO[k[j]] >= 0 && 0.5 * this.bd[i] * vn * vn >= HARD[k[j]];
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
      } else {
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
      this.collide(i, j, vx);
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
    const nid = [0, 0, 0, 0], nT = [0, 0, 0, 0], nW = [0, 0, 0, 0], nP = [0, 0, 0, 0], pn = [0, 0, 0, 0];
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
            nid[q] = ID[j]; nT[q] = TT[j]; nW[q] = CT[j]; nP[q] = PP[j]; nVX[q] = VX[j]; nVY[q] = VY[j];
          } else { nid[q] = E.WALL; nT[q] = T; nW[q] = 0; nP[q] = P0; nVX[q] = 0; nVY[q] = 0; } // insulating, pressure-reflecting box
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

        // reactions and phase changes
        let out = id, reset = false;
        let nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0, flame = 0, cloneOf = 0, nCloud = 0, nVoid = 0;
        let closing = 0;   // snow neighbours' closing speed on me (storm charge)
        let surface = false;   // a non-gas neighbour to condense onto (the floor counts, the sides and lid don't)
        for (let q = 0; q < 4; q++) {
          const j = nid[q];
          if (j === E.EMPTY) nAir++;
          if (j === E.CLOUD) nCloud++;
          const qx = x + DX[q], qy = y + DY[q];
          if (!isGasLike(j) && ((qx >= 0 && qy >= 0 && qx < nx && qy < ny) || q === 3)) surface = true;
          if (j === E.FIRE) nFire++;
          if (j === E.ACID) nAcid++;
          if (j === E.PLANT) nPlant++;
          if (j === E.VOID) nVoid++;
          if (j === E.SNOW) closing += Math.max((VX[i] - nVX[q]) * DX[q] + (VY[i] - nVY[q]) * DY[q], 0);
          if (j === E.CLONE && nW[q] >= 1) cloneOf = nW[q];
          if (IGNITE[j] > 0 && j !== E.GUNPOWDER && nT[q] >= IGNITE[j]) { nBurning++; flame = Math.max(flame, FLAMET[j]); }
        }

        if (broke) {
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
          // storm charge (physics.js CHARGE_*): freezing cloud struck by falling snow
          if (out === E.CLOUD && T <= PHYS.CHARGE_T_MAX && rnd() < PHYS.CHARGE_RATE * closing) ctype = Math.min(ctype + 1, PHYS.CHARGE_MAX);
          if (out !== E.CLOUD) ctype = 0;
        } else if (id === E.LAVA) {
          let ct = ctype;
          if (ct <= 0 || ct >= NE) ct = E.STONE;
          if (T < MELT[ct] - PHYS.LAVA_FREEZE_BELOW) { out = ct; reset = true; ctype = 0; }
        } else if (id === E.FIRE) {
          life -= PHYS.FIRE_BURN + PHYS.FIRE_BURN_SPREAD * rnd();
          if (life <= 0 || T < PHYS.FIRE_MIN_T) { out = rnd() < PHYS.FIRE_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true; }
        } else if (id === E.SMOKE) {
          life -= PHYS.SMOKE_FADE;
          if (life <= 0) { out = E.EMPTY; reset = true; }
        } else if (id === E.ACID) {
          let victims = 0;
          for (let q = 0; q < 4; q++) if (acidEats(nid[q])) victims++;
          life -= PHYS.ACID_USE * victims;
          if (life <= 0) { out = rnd() < PHYS.ACID_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true; }
        } else if (id === E.EMPTY) {
          if (nBurning > 0 && rnd() < PHYS.FLAME_SPREAD * nBurning) {
            out = E.FIRE; reset = true; T = Math.max(T, flame * (PHYS.FLAME_T_MIN + PHYS.FLAME_T_SPREAD * rnd()));
          } else if (cloneOf > 0 && rnd() < PHYS.CLONE_RATE) {
            out = cloneOf; reset = true; T = SPAWNT[cloneOf];
            ctype = cloneOf === E.LAVA ? E.STONE : 0;
            vx = 0; vy = KIND[cloneOf] === K.GAS ? 0 : PHYS.SPAWN_DROP_V;
          }
        } else if (id === E.CLONE && ctype < 1) {
          for (let q = 0; q < 4; q++) {
            const j = nid[q];
            if (j !== E.EMPTY && j !== E.WALL && j !== E.CLONE) { ctype = j; break; }
          }
        }

        // melting (stone, sand, metal, glass → lava that remembers what it was)
        if (out === id && MELT[id] > 0 && T > MELT[id]) { out = E.LAVA; ctype = MELTINTO[id]; life = 0; }

        // combustion
        if (out === id && IGNITE[id] > 0) {
          if (id === E.GUNPOWDER) {
            // at its ignition point, or touching something that hot (not a gas: a flame only might)
            let hotTouch = false;
            for (let q = 0; q < 4; q++) hotTouch ||= !isGasLike(nid[q]) && nT[q] >= IGNITE[id];
            if (T >= IGNITE[id] || hotTouch || (nFire > 0 && rnd() < PHYS.GUNPOWDER_FIRE)) { out = E.FIRE; reset = true; T = PHYS.GUNPOWDER_T; P += PHYS.GUNPOWDER_P; }
          } else if (T >= IGNITE[id] && (nAir > 0 || nFire > 0)) {
            life -= BURNRATE[id];
            T = Math.max(T, Math.min(T + BURNHEAT[id] / C, FLAMET[id]));
            P += PHYS.BURN_P;
            if (life <= 0) {
              out = LEAVES_ASH[id] && rnd() < PHYS.ASH_SHARE ? E.ASH : E.FIRE;
              reset = true;
              T = Math.max(T, PHYS.BURNT_MIN_T);
            }
          }
        }

        // acid eats its neighbours; what fizzes (limestone) sets its gas free as a puff
        if (out === id && nAcid > 0 && acidEats(id)) {
          if (rnd() < PHYS.ACID_USE * nAcid) {
            out = rnd() < PHYS.ACID_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true;
            P += PHYS.STEAM_BOIL_PUFF * FIZZ[id] / PHYS.STEAM_EXPANSION;
          }
        }

        // void drains whatever can move the step it touches it
        if (nVoid > 0 && id !== E.EMPTY && KIND[id] !== K.SOLID) { out = E.EMPTY; reset = true; T = AMBIENT; vx = 0; vy = 0; ctype = 0; }

        if (out !== id) {
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
