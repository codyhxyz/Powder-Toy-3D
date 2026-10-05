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
import { ELEMENTS, E, K, meltInto } from '../../elements.js';
import { PHYS } from '../../physics.js';

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

export const AMBIENT = PHYS.AMBIENT;

const isGasLike = (id) => KIND[id] === K.GAS || id === E.EMPTY;
const isFluid = (id) => KIND[id] === K.LIQUID || isGasLike(id);
const movable = (id) => KIND[id] !== K.SOLID;
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
    if (!mt || !mb) {
      if (mt && down) { this.land(t, vy[t]); s[t] = 1; }
      if (mb && up) { vy[b] = 0; s[b] = 1; }
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
        }
        if (up) s[b] = 1;
      }
    }
  }
  // 2. a blocked top cell topples diagonally (powders, liquids); a blocked bottom gas cell rises diagonally
  diagonal(i) {
    const { bk: k, bd: d, bm: m, bs: s } = this;
    if (!s[i] || m[i]) return;
    const top = (i & 2) !== 0, xi = i & 1, kd = KIND[k[i]];
    if (top ? !(kd === K.POWDER || kd === K.LIQUID) : kd !== K.GAS) return;
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
      if (w0) vx[i] *= bounceR(k[i]);
      if (w1) vx[j] *= bounceR(k[j]);
    }
  }

  // ---- react: heat, pressure, forces, reactions (react.js) ----
  react() {
    const { nx, ny } = this;
    const ID = this.id, TT = this.T, LIFE = this.life, CT = this.ctype, VX = this.vx, VY = this.vy, PP = this.P;
    const oID = this._id, oT = this._T, oLife = this._life, oCT = this._ctype, oVX = this._vx, oVY = this._vy, oP = this._P;
    const nid = [0, 0, 0, 0], nT = [0, 0, 0, 0], nW = [0, 0, 0, 0], nP = [0, 0, 0, 0], pn = [0, 0, 0, 0];
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
            nid[q] = ID[j]; nT[q] = TT[j]; nW[q] = CT[j]; nP[q] = PP[j];
          } else { nid[q] = E.WALL; nT[q] = T; nW[q] = 0; nP[q] = P0; } // insulating, pressure-reflecting box
        }

        // heat conduction (energy conserving)
        const C = CAP[id];
        let dE = 0;
        for (let q = 0; q < 4; q++) dE += Math.min(COND[id], COND[nid[q]]) * (nT[q] - T);
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
          if (id === E.EMPTY) vy += g * Math.min(PHYS.AIR_BUOY_HI, Math.max(PHYS.AIR_BUOY_LO, (T - AMBIENT) / (AMBIENT + PHYS.KELVIN)));
          else vy -= g * GRAV[id];
          vx *= 1 - DRAG[id];
          vy *= 1 - DRAG[id];
          const below = KIND[nid[3]];
          const supported = y === 0 || below === K.SOLID || below === K.POWDER;
          if (supported) vx *= 1 - FRICTION[id];
          if (KIND[id] === K.LIQUID && (supported || below === K.LIQUID)) {
            const up = KIND[nid[2]];
            const head = up === K.LIQUID || up === K.POWDER;
            const onLiquid = !supported;
            const f = FLOW[id];
            if (head || onLiquid) {
              const want = head ? f : f * PHYS.FLOW_SURFACE;
              if (Math.abs(vx) < want * PHYS.FLOW_KICK) vx = randDir() * want;
            } else {
              const l = KIND[nid[0]] === K.LIQUID, r = KIND[nid[1]] === K.LIQUID;
              vx = vx * PHYS.FILM_KEEP + ((l ? 1 : 0) - (r ? 1 : 0)) * f * PHYS.FILM_COHESION;
              if (!l && !r && rnd() < PHYS.DROPLET_WANDER) vx = randDir() * f * PHYS.DROPLET_SPEED;
            }
          }
          if (JITTER[id] > 0) { vx += (rnd() - 0.5) * JITTER[id]; vy += (rnd() - 0.5) * JITTER[id]; }
          vx = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, vx));
          vy = Math.max(-PHYS.V_MAX, Math.min(PHYS.V_MAX, vy));
        } else { vx = 0; vy = 0; }

        // reactions and phase changes
        let out = id, reset = false;
        let nAir = 0, nFire = 0, nAcid = 0, nPlant = 0, nBurning = 0, flame = 0, cloneOf = 0;
        for (let q = 0; q < 4; q++) {
          const j = nid[q];
          if (j === E.EMPTY) nAir++;
          if (j === E.FIRE) nFire++;
          if (j === E.ACID) nAcid++;
          if (j === E.PLANT) nPlant++;
          if (j === E.CLONE && nW[q] >= 1) cloneOf = nW[q];
          if (IGNITE[j] > 0 && j !== E.GUNPOWDER && nT[q] >= IGNITE[j]) { nBurning++; flame = Math.max(flame, FLAMET[j]); }
        }

        if (id === E.WATER) {
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
          if (cond) { out = E.WATER; life = 0; }
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
          for (let q = 0; q < 4; q++) {
            const j = nid[q];
            if (j !== E.EMPTY && j !== E.ACID && j !== E.WALL && j !== E.GLASS && j !== E.WATER && KIND[j] !== K.GAS) victims++;
          }
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
            if (T >= IGNITE[id] || (nFire > 0 && rnd() < PHYS.GUNPOWDER_FIRE)) { out = E.FIRE; reset = true; T = PHYS.GUNPOWDER_T; P += PHYS.GUNPOWDER_P; }
          } else if (T >= IGNITE[id] && (nAir > 0 || nFire > 0)) {
            life -= BURNRATE[id];
            T = Math.max(T, Math.min(T + BURNHEAT[id] / C, FLAMET[id]));
            P += PHYS.BURN_P;
            if (life <= 0) {
              out = id !== E.OIL && rnd() < PHYS.ASH_SHARE ? E.ASH : E.FIRE;
              reset = true;
              T = Math.max(T, PHYS.BURNT_MIN_T);
            }
          }
        }

        // acid eats its neighbours
        if (out === id && nAcid > 0 && id !== E.EMPTY && id !== E.ACID && id !== E.WALL && id !== E.GLASS
          && id !== E.WATER && KIND[id] !== K.GAS) {
          if (rnd() < PHYS.ACID_USE * nAcid) { out = rnd() < PHYS.ACID_TO_SMOKE ? E.SMOKE : E.EMPTY; reset = true; }
        }

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
