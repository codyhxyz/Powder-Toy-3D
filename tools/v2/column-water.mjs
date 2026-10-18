// Column water: a CPU prototype of a cheaper liquid model (docs/v2/water-cost-first-principles.md).
// Not the GPU kernels, and not production physics: the same discipline as tools/v2/lean-sim.mjs
// (integer fill, a face owned by its -side column, integer transfers so mass is exact, a brick is busy
// when a rule was possible in it, idle after one quiet 8-tick cycle).
//
// The premise it drops: that bulk water must be simulated cell by cell in 3-D. The current model is
// a 3-D virtual-pipe network (Mei et al. 2007 is a 2-D heightfield method; W-Shadow 2009 made it 3-D by
// making cells compressible), so a lake discovers its own hydrostatic pressure by compressing, which
// is a sound wave, which is what forces SUB = 3 and COMP >= 3 g dt^2. Hydrostatic pressure in a column
// is a prefix sum, not a wave. So here:
//
//   RUN      a maximal vertical run of one liquid in a column. A supported run (solid or another
//            liquid under it) is PACKED: every cell full except its top, so its state is its mass M.
//            Its head is its surface, eta = bottom + M/FULL: the column's hydrostatic prefix sum, exact,
//            with no compression and no hidden mass (tall cells: Irving et al. 2006, Chentanez and
//            Mueller 2011). Mass leaves and arrives at the surface; interior cells are never written.
//   LID      only a run filled to a solid lid compresses (Chorin's artificial compressibility, 1967):
//            eta = lid + excess/(cap * COMP * FULL). Pipes, U-bend channels and full tanks keep
//            pressure through lids exactly as today, but at a single 60 Hz step (COMP >= 2 g dt^2 for
//            four horizontal faces; 3 g dt^2 here, the same 50 % margin lean-sim takes).
//   FALL     a run with air under it falls as a rigid run on R1's column-fall law (powder's).
//   SEGMENT  where two neighbouring columns are both open, their domains (a run plus the air above it
//            up to the next run or solid, or a dry floor) meet in a vertical face segment. One
//            depth-averaged flux per segment: the shallow-water momentum equation without advection,
//            with Audusse et al.'s (2004) hydrostatic reconstruction for the wet depth at the face,
//            so a lake at rest over any floor is exactly at rest. The flux lives in the existing f16
//            face lane of the segment's bottom cell; every other cell's lanes are free.
//   JET      unchanged R14: lateral outflow faster than 1 m/s into a cell over open air leaves as a
//            particle at sqrt(2 g H), H the head over the source and its immediate neighbours, which is
//            now the model's exact hydrostatic head rather than a decoded compressed fill.
//
// Kept from lean-sim: integer fill (1.0 = 2^16), dead band = yield, viscosity as damping (converted from
// per substep to per tick so the physical damping per second is unchanged), the film rule, particles.
// Dropped: substeps, the vertical flux lane, compression in open water.
//
// usage: node tools/v2/column-water.mjs           (runs the cost comparison; the gates run through the
//        outcome bench: node tools/outcomes.mjs --engine column --group liquids,controls)
import { fileURLToPath } from 'node:url';

export const AIR = 0, WALL = 1, SAND = 2, FLOUR = 3, WATER = 4, MUD = 5;
const isLiq = (e) => e === WATER || e === MUD;
const isPowder = (e) => e === SAND || e === FLOUR;

// one clock: 60 ticks/s, 0.3 m cells, 2 g (docs/v2.md 5.1; lean-sim's)
export const TICK_HZ = 60, CELL_M = 0.3, G_MS2 = 19.6;
export const G_CELLS = G_MS2 / CELL_M;            // cells/s²
export const G = G_CELLS / (TICK_HZ * TICK_HZ);   // cells/tick²
export const VT = 12 / CELL_M / TICK_HZ;          // R1's bulk run speed, 12 m/s (lean-sim VT_SAND), for falling runs
export const FULL = 1 << 16;
// a face's depth-averaged flux (quanta a tick per cell of wet face) gains this a tick per cell of head
const ACC = G * FULL;
// Wave speed is sqrt(g h_face); the explicit step is stable for c dt < 1/sqrt(2) on two horizontal axes,
// i.e. h < 27.5 cells at 60 Hz. Deeper faces accelerate as if H_CAP deep: real water is dispersive
// (deep-water waves of length L travel at sqrt(g L / 2 pi), not sqrt(g h)), so this is the deep-water
// limit for waves up to ~100 cells long, and the step stays stable at any depth (1.7x margin).
const H_CAP = Number(process.env.COLUMN_H_CAP ?? 16);   // (env override: stability experiments only)
// Covered runs only: stable iff COMP >= 2 g dt² (four horizontal faces, one step); 3 g dt² is lean-sim's
// 4/3 margin rounded up. Open water has no compression at all.
const COMP = 3 * G;
const QMIN = 0.5;                 // a segment flux under this snaps to 0 (lean-sim)
const FILM = FULL >> 3;           // no spill onto dry ground from under ⅛ of a cell (docs/v2.md 4.1)
const DEADQ = 2;                  // dead band in quanta of the stiffer side (lean-sim)
const V_JET = 1 / CELL_M;         // 1 m/s, R14's birth gate, in cells/s
const SUB_EQ = 3;                 // the substep model's substeps: its per-substep damping, per tick here
// v2Rows(): WATER damp 0.01, MUD damp 0.2 and yield 0.4 cells of head (src/shaders/v2.js YIELD)
const ROWS = {
  [WATER]: { yieldHead: 0, damp: 1 - (1 - 0.01) ** SUB_EQ },
  [MUD]: { yieldHead: 0.4, damp: 1 - (1 - 0.2) ** SUB_EQ },
};
export const QUIET_TICKS = 8;

// GPU cost model (bytes a tick), for the comparison only: see the doc's cost table. Uncached figures.
export const COST = {
  // current R13: 3 × (flux 16 + limit 40 + jets 20 + gather 36) + foam 16 + write-backs, per awake cell
  currentPerAwakeCell: 336, currentDispatches: 3 * 4 + 1,
  // proposed: 4 column passes (column, flux, limit, gather). Per awake brick, each pass reads its own and
  // its neighbours' 64-bit liquid and solid masks (16 B a brick): column 1, flux 3, limit 5, gather 5
  perAwakeBrick: 16 * (1 + 3 + 5 + 5),
  // per run: column reads top core 16 + bottom lanes 8, writes eta 4; gather reads/writes top 32, K 4
  perRun: 64,
  // per segment: flux lane r/w 8 + two etas 8; limit lane 4 + eta 4; gather lane 4 + sender K 4
  perSegment: 32,
  // per cell written (pack, fall, deposit): read + write its 16 B core
  perWrittenCell: 32,
  dispatches: 4,
};

export class World {
  constructor(nx, ny, nz) {
    Object.assign(this, { nx, ny, nz, n: nx * ny * nz, tick: 0 });
    this.id = new Uint8Array(this.n);
    this.fill = new Int32Array(this.n);
    this.vy = new Float32Array(this.n);    // a falling run's speed (cells/tick), at its bottom cell
    this.acc = new Float32Array(this.n);   // its fractional fall
    this.lanes = new Map();                // segment fluxes, keyed by axis·n + bottom cell (the f16 lanes)
    this.bx = Math.ceil(nx / 4); this.by = Math.ceil(ny / 4); this.bz = Math.ceil(nz / 4);
    this.busy = new Uint8Array(this.bx * this.by * this.bz);
    this.quietTicks = 0; this.idleAt = -1;
    this.parts = []; this.landed = 0; this.landKE = 0;
    this.work = { runs: 0, segments: 0, written: 0 };
  }
  at(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.id[this.at(x, y, z)] : WALL; }
  openAt(x, y, z) { const e = this.get(x, y, z); return e === AIR || isLiq(e); }
  set(x, y, z, e) { const i = this.at(x, y, z); this.id[i] = e; this.fill[i] = isLiq(e) ? FULL : 0; this.vy[i] = 0; this.acc[i] = 0; }
  mark(x, y, z) { if (this.inside(x, y, z)) this.busy[(x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2))] = 1; }
  box(x0, y0, z0, x1, y1, z1, e) { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, e); }
  mass() { let m = 0; for (let i = 0; i < this.n; i++) if (isLiq(this.id[i])) m += this.fill[i]; for (const p of this.parts) m += p.m; return m; }
  busyBricks() { let c = 0; for (const b of this.busy) c += b; return c; }
  writeCell(i, e, f) {
    if (this.id[i] === e && this.fill[i] === f) return false;
    this.id[i] = e; this.fill[i] = f; this.work.written++;
    return true;
  }

  // ---- runs and domains (on the GPU: the column pass, from the brick masks) ----
  // A column's open cells, bottom up, split into domains: a dry floor [y0, top), or a run [r0, r1) of one
  // liquid plus the air above it up to `top` (the next run or solid).
  domains(x, z) {
    const { ny } = this, out = [];
    let y = 0;
    while (y < ny) {
      if (!this.openAt(x, y, z)) { y++; continue; }
      const o0 = y; while (y < ny && this.openAt(x, y, z)) y++; const o1 = y;
      let d = null;
      for (let k = o0; k < o1; k++) {
        const i = this.at(x, k, z), e = this.id[i];
        if (!isLiq(e)) continue;
        if (d && d.liq === e && d.r1 === k) { d.r1 = k + 1; d.M += this.fill[i]; continue; }
        if (d) d.top = k; else if (k > o0) out.push({ x, z, o0, y0: o0, top: k, r0: o0, r1: o0, liq: 0, M: 0, dry: true });
        d = { x, z, o0, y0: k, top: o1, r0: k, r1: k + 1, liq: e, M: this.fill[i], dry: false };
        out.push(d);
      }
      if (d) d.top = o1; else out.push({ x, z, o0, y0: o0, top: o1, r0: o0, r1: o0, liq: 0, M: 0, dry: true });
    }
    for (const d of out) {
      if (d.dry) { d.eta = d.y0; d.stiff = 1 / FULL; continue; }
      d.supported = d.r0 === d.o0 || isLiq(this.get(x, d.r0 - 1, z));
      d.falling = !d.supported;
      d.cap = d.top - d.r0;
      if (d.falling) { d.eta = NaN; d.stiff = 1 / FULL; continue; }
      const room = d.cap * FULL;
      if (d.M <= room) { d.eta = d.r0 + d.M / FULL; d.stiff = 1 / FULL; }
      else { d.eta = d.top + (d.M - room) / (d.cap * COMP * FULL); d.stiff = 1 / (d.cap * COMP * FULL); }
    }
    return out;
  }
  allDomains() {
    const D = this.D = new Array(this.nx * this.nz);
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) D[z * this.nx + x] = this.domains(x, z);
    return D;
  }
  domainAt(x, z, y) {   // the domain of column (x, z) that holds height y (this tick's), or null
    if (x < 0 || z < 0 || x >= this.nx || z >= this.nz) return null;
    for (const d of this.D[z * this.nx + x]) if (y >= d.y0 && y < d.top) return d;
    return null;
  }

  // Pack a supported run: full cells from its bottom, the remainder in the next, air above; a covered run's
  // excess in its top cell. Only cells whose value changes are written (in steady flow: the surface).
  pack(d) {
    let rem = d.M;
    for (let k = d.r0; k < d.top; k++) {
      const f = k === d.top - 1 ? rem : Math.min(rem, FULL);
      const i = this.at(d.x, k, d.z);
      if (this.writeCell(i, f > 0 ? d.liq : AIR, f)) this.mark(d.x, k, d.z);
      this.vy[i] = 0; this.acc[i] = 0;
      rem -= f;
    }
    d.r1 = d.r0 + Math.min(d.cap, Math.ceil(d.M / FULL));
  }

  // ---- pass 1, column: settle supported runs, drop falling ones (one thread a column, bottom up) ----
  columnPass() {
    const { nx, nz } = this;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      for (const d of this.domains(x, z)) {
        if (d.dry) continue;
        this.work.runs++;
        if (d.supported) { this.pack(d); continue; }
        // R1 for a liquid run: v += g to the run speed, move whole cells, land on what is below
        const b = this.at(x, d.r0, z);
        const v = Math.min(this.vy[b] + G, VT);
        let a = this.acc[b] + v, dd = Math.floor(a); a -= dd;
        let fl = d.r0; while (fl - 1 >= d.o0 && this.id[this.at(x, fl - 1, z)] === AIR) fl--;
        let vNew = v;
        if (dd >= d.r0 - fl) {   // contact: it lands this tick and merges next tick (inelastic; splash KE recorded)
          dd = d.r0 - fl;
          this.landKE += 0.5 * (d.M / FULL) * (v * CELL_M * TICK_HZ) ** 2;
          vNew = 0; a = 0;
        }
        this.mark(x, d.r0, z);
        if (dd > 0) {
          for (let k = d.r0; k < d.r1; k++) {
            const s = this.at(x, k, z), t = this.at(x, k - dd, z);
            this.writeCell(t, this.id[s], this.fill[s]);
            this.vy[t] = 0; this.acc[t] = 0;
          }
          for (let k = Math.max(d.r1 - dd, d.r0); k < d.r1; k++) { this.writeCell(this.at(x, k, z), AIR, 0); }
          this.mark(x, d.r0 - dd, z); this.mark(x, d.r1 - 1, z);
        }
        const nb = this.at(x, d.r0 - dd, z);
        this.vy[nb] = vNew; this.acc[nb] = a;
      }
    }
  }

  // ---- passes 2-4, flux / limit / gather over face segments ----
  fluxPass() {
    const { nx, nz } = this, D = this.allDomains();
    const lanes = new Map(), segs = [];
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      for (let axis = 0; axis < 2; axis++) {
        const bx = x + (axis === 0 ? 1 : 0), bz = z + (axis === 1 ? 1 : 0);
        if (bx >= nx || bz >= nz) continue;
        const A = D[z * nx + x], B = D[bz * nx + bx];
        let i = 0, j = 0;
        while (i < A.length && j < B.length) {
          const s0 = Math.max(A[i].y0, B[j].y0), s1 = Math.min(A[i].top, B[j].top);
          if (s0 < s1) { const s = this.segment(A[i], B[j], s0, s1, axis, x, z, bx, bz, lanes); if (s) segs.push(s); }
          if (A[i].top < B[j].top) i++; else j++;
        }
      }
    }
    this.lanes = lanes;   // a lane survives only while its segment does (stale geometry clears it)
    return segs;
  }

  segment(dA, dB, s0, s1, axis, ax, az, bx, bz, lanes) {
    if (dA.falling || dB.falling || (dA.dry && dB.dry)) return null;
    if (!dA.dry && !dB.dry && dA.liq !== dB.liq) return null;
    this.work.segments++;
    const key = axis * this.n + this.at(ax, s0, az), uOld = this.lanes.get(key) ?? 0;
    const liq = dA.dry ? dB.liq : dA.liq, row = ROWS[liq];
    const ha = dA.dry ? 0 : Math.min(Math.max(dA.eta - s0, 0), s1 - s0);   // hydrostatic reconstruction
    const hb = dB.dry ? 0 : Math.min(Math.max(dB.eta - s0, 0), s1 - s0);
    let drive = dA.eta - dB.eta;
    // lean-sim's dead band: DEADQ quanta of the stiffer side, the yield, and never below the drive whose damped
    // steady flow moves under one quantum a tick (it would stall forever). That flow is v·h here, so the stall
    // drive grows as the wet face thins: 1.5·damp/(ACC·h), lean-sim's 1.5·damp/ACC at h = 1.
    const hFace = Math.max(ha, hb, 1 / FULL);
    const band = Math.max(DEADQ * Math.max(dA.stiff, dB.stiff), 1.5 * row.damp / (ACC * Math.min(hFace, 1)), row.yieldHead);
    if (Math.abs(drive) < band) drive = 0;
    let u = uOld;
    if (ha === 0) u = Math.min(u, 0);   // a dry side's stale outflow is dropped
    if (hb === 0) u = Math.max(u, 0);
    const hUp = drive > 0 ? ha : drive < 0 ? hb : u > 0 ? ha : hb;
    let v = u + ACC * drive * Math.min(1, H_CAP / Math.max(hUp, 1));
    if (drive === 0) v *= 0.5;
    if ((v > 0 && ha === 0) || (v < 0 && hb === 0)) v = 0;
    // film = the shallow-water dry tolerance (GeoClaw's dry_tolerance, Berger et al. 2011): a face whose upwind
    // wet depth is under FILM carries no flux. Today's rule (no spill onto dry ground from under a film's depth)
    // applied to every face, so a thin puddle stops as a whole rather than creeping for seconds at 2 cm deep.
    if (v > 0 && ha * FULL < FILM) v = 0;
    if (v < 0 && hb * FULL < FILM) v = 0;
    v *= 1 - row.damp;
    if (Math.abs(v) < QMIN) v = 0;
    if (v === 0) return null;   // (a blocked drive is not a possible rule: lean-sim marks only moving faces)
    lanes.set(key, v);
    this.mark(ax, s0, az); this.mark(bx, s0, bz);
    const src = v > 0 ? dA : dB, dst = v > 0 ? dB : dA;
    const [sx, sz, tx, tz] = v > 0 ? [ax, az, bx, bz] : [bx, bz, ax, az];
    return { src, dst, s0, s1, v, T: Math.abs(v) * (v > 0 ? ha : hb), h: v > 0 ? ha : hb, sx, sz, tx, tz, axis, sign: Math.sign(v) };
  }

  limitAndGather(segs) {
    // limit: never send more than the run holds (one K per sending run)
    for (const s of segs) s.src.out = (s.src.out ?? 0) + s.T;
    const sent = new Map();
    for (const s of segs) {
      const d = s.src, K = d.out > d.M ? d.M / d.out : 1;
      s.amt = Math.floor(s.T * K);
      sent.set(d, (sent.get(d) ?? 0) + s.amt);
    }
    for (const [d, total] of sent) {   // f64 rounding guard: never more than M in all (never fires in practice)
      if (total <= d.M) continue;
      let over = total - d.M;
      for (const s of segs) if (s.src === d && over > 0) { const c = Math.min(s.amt, over); s.amt -= c; over -= c; }
    }
    // gather: each run's mass changes at its surface; flows into air go in at the segment's rows
    const deposits = [], dirty = new Set();
    for (const s of segs) {
      if (!s.amt) continue;
      s.src.M -= s.amt; s.src.dM = (s.src.dM ?? 0) - s.amt; dirty.add(s.src);
      const d = s.dst;
      if (!d.dry && s.s0 < d.r1) { d.M += s.amt; d.dM = (d.dM ?? 0) + s.amt; dirty.add(d); continue; }
      // into the air: split over the wet rows of the face, each a particle (R14) or a deposit
      const rows = Math.max(1, Math.ceil(s.h));
      let left = s.amt;
      for (let r = 0; r < rows && left > 0; r++) {
        const y = s.s0 + r;
        const share = r === rows - 1 ? left : Math.min(left, Math.floor(s.amt * Math.min(1, s.h - r) / s.h));
        left -= share;
        if (!share) continue;
        const below = this.get(s.tx, y - 1, s.tz);
        const openBelow = y - 1 >= 0 && (below === AIR || (isLiq(below) && this.fill[this.at(s.tx, y - 1, s.tz)] < FULL / 16));
        const speed = Math.abs(s.v) / FULL * TICK_HZ;   // superficial discharge speed, cells/s
        if (openBelow && speed > V_JET && s.src.liq === WATER) {
          // R14: launch at sqrt(2 g H), H the head over the source and its immediate same-liquid neighbours
          let eta = s.src.eta;
          for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const qx = s.sx + ex, qz = s.sz + ez;
            if (qx === s.tx && qz === s.tz) continue;
            const q = this.domainAt(qx, qz, y);
            if (q && !q.dry && !q.falling && q.liq === s.src.liq && y < q.r1) eta = Math.max(eta, q.eta);
          }
          const vJet = Math.sqrt(2 * G_CELLS * Math.max(eta - (y + 0.5), 0));
          const dx = s.axis === 0 ? s.sign : 0, dz = s.axis === 1 ? s.sign : 0;
          this.parts.push({ x: s.tx + 0.5 - 0.5 * dx, y: y + 0.5, z: s.tz + 0.5 - 0.5 * dz, vx: dx * vJet, vy: 0, vz: dz * vJet, m: share });
          this.mark(s.sx, y, s.sz);
        } else deposits.push([s.tx, y, s.tz, share, s.src.liq]);
      }
    }
    for (const d of dirty) this.pack(d);
    for (const [x, y, z, m, liq] of deposits) {
      const i = this.at(x, y, z);
      if (this.id[i] === AIR) { this.id[i] = liq; this.fill[i] = 0; }
      if (this.id[i] !== liq) throw new Error(`column-water: deposit into ${this.id[i]} at ${x},${y},${z}`);
      this.fill[i] += m; this.work.written++; this.mark(x, y, z);
    }
  }

  // R4 particles: lean-sim's, unchanged
  particles() {
    const dt = 1 / TICK_HZ, keep = [];
    for (const p of this.parts) {
      p.vy -= G_CELLS * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(p.vx, p.vy, p.vz) * dt / 0.5));
      let landed = false;
      for (let k = 0; k < steps; k++) {
        const nx = p.x + p.vx * dt / steps, ny = p.y + p.vy * dt / steps, nz = p.z + p.vz * dt / steps;
        const hx = Math.floor(nx), hy = Math.floor(ny), hz = Math.floor(nz), he = this.get(hx, hy, hz);
        const be = this.get(hx, hy - 1, hz);
        const held = be === WALL || isPowder(be) || (isLiq(be) && this.fill[this.at(hx, hy - 1, hz)] >= FULL);
        const thin = isLiq(he) && (this.fill[this.at(hx, hy, hz)] < FULL / 2 || !held);
        if (he !== AIR && !thin) {
          const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z), c = this.at(cx, cy, cz);
          if (this.id[c] === AIR) { this.id[c] = WATER; this.fill[c] = 0; }
          if (this.id[c] !== WATER) throw new Error('column-water: particle landed in a non-water cell');
          this.fill[c] += p.m; this.mark(cx, cy, cz); landed = true; this.landed++; this.work.written++;
          break;
        }
        p.x = nx; p.y = ny; p.z = nz;
      }
      if (!landed) keep.push(p);
    }
    this.parts = keep;
  }

  step() {
    this.busy.fill(0);
    this.work = { runs: 0, segments: 0, written: 0 };
    this.columnPass();
    const segs = this.fluxPass();
    this.limitAndGather(segs);
    this.particles();
    const nb = this.busyBricks() + (this.parts.length ? 1 : 0);
    this.quietTicks = nb ? 0 : this.quietTicks + 1;
    if (this.quietTicks >= QUIET_TICKS && this.idleAt < 0) this.idleAt = this.tick - (QUIET_TICKS - 1);
    if (nb) this.idleAt = -1;
    this.tick++;
    return nb;
  }

  // Resident velocities (m/s), complete: each wet cell's horizontal velocity is the mean of the depth-averaged
  // fluxes on its faces (a MAC average); a falling run's cells fall at its speed; a packed run's cells rise or
  // sink with its surface in proportion to height (incompressible column). For the splash observable.
  velocities() {
    const { nx, ny, nz } = this, vel = new Float32Array(3 * this.n), toMs = CELL_M * TICK_HZ / FULL;
    for (const [key, v] of this.lanes) {
      const axis = key >= this.n ? 1 : 0, i0 = key - axis * this.n;
      const x = i0 % nx, z = Math.floor(i0 / nx) % nz, y0 = Math.floor(i0 / (nx * nz));
      const bx = x + (axis === 0 ? 1 : 0), bz = z + (axis === 1 ? 1 : 0);
      for (let y = y0; y < ny; y++) {
        let any = false;
        for (const [cx, cz] of [[x, z], [bx, bz]]) {
          const i = this.at(cx, y, cz);
          if (isLiq(this.id[i])) { vel[3 * i + axis * 2] += 0.5 * v * toMs; any = true; }
        }
        if (!any) break;
      }
    }
    if (this.D) for (const col of this.D) for (const d of col) {
      if (d.dry) continue;
      const b = this.at(d.x, d.r0, d.z);
      // falling: the run's speed; packed and open: the surface moves at dM/FULL cells a tick and the column
      // below it in proportion to height (continuity); a covered run's cells hold still
      const wTop = (d.dM ?? 0) / FULL * CELL_M * TICK_HZ, depth = d.eta - d.r0;
      for (let k = d.r0; k < d.r1; k++) {
        const vy = d.falling ? -this.vy[b] * CELL_M * TICK_HZ : d.M <= d.cap * FULL && depth > 0 ? wTop * Math.min(1, (k + 0.5 - d.r0) / depth) : 0;
        vel[3 * this.at(d.x, k, d.z) + 1] = vy;
      }
    }
    return vel;
  }

  run(ticks, every, report) { for (let t = 1; t <= ticks; t++) { const nb = this.step(); if (every && t % every === 0) report(t, nb); } }
}

// ---------------------------------------------------------------- cost comparison (CLI)
// Both models on the same scenes; awake bricks by the GPU's rule (busy in the 3³ neighbourhood within the
// last QUIET_TICKS ticks); bytes from COST. The current model is lean-sim's World (its CPU twin).
function awakeTracker(w) {
  const hist = [], { bx, by, bz } = w;
  return () => {
    hist.push(Uint8Array.from(w.busy)); if (hist.length > QUIET_TICKS) hist.shift();
    const any = new Uint8Array(bx * by * bz);
    for (const h of hist) for (let i = 0; i < h.length; i++) any[i] |= h[i];
    let awake = 0, cells = [];
    for (let y = 0; y < by; y++) for (let z = 0; z < bz; z++) for (let x = 0; x < bx; x++) {
      let a = 0;
      for (let dy = -1; dy <= 1 && !a; dy++) for (let dz = -1; dz <= 1 && !a; dz++) for (let dx = -1; dx <= 1 && !a; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X >= 0 && Y >= 0 && Z >= 0 && X < bx && Y < by && Z < bz && any[X + bx * (Z + bz * Y)]) a = 1;
      }
      if (a) { awake++; cells.push([x, y, z]); }
    }
    return { awake, bricks: cells };
  };
}
function wetInBricks(w, bricks, liq) {
  let n = 0;
  for (const [bxi, byi, bzi] of bricks) for (let y = byi * 4; y < Math.min(w.ny, byi * 4 + 4); y++) for (let z = bzi * 4; z < Math.min(w.nz, bzi * 4 + 4); z++) for (let x = bxi * 4; x < Math.min(w.nx, bxi * 4 + 4); x++) if (liq(w.id[w.at(x, y, z)])) n++;
  return n;
}

async function costMain() {
  const lean = await import('./lean-sim.mjs');
  const S = { nx: 64, ny: 32, nz: 64 };
  const scenes = {
    // a settled 24-deep lake that an edit or a neighbour woke: what it costs while awake, and to sleep again
    stillLakeWoken: { setup: (w, E) => w.box(0, 0, 0, 63, 23, 63, E.WATER), settle: true, wake: true, ticks: 60 },
    // a 4×4×8 block (128 cells) dropped from 6 cells over the centre of a settled 16-deep pool, measured 4 s
    // (equal mass in both models; a nozzle refilled when empty pours at a model-dependent rate)
    pourIntoPool: { setup: (w, E) => w.box(0, 0, 0, 63, 15, 63, E.WATER), settle: true, drop: (w, E) => w.box(30, 22, 30, 33, 29, 33, E.WATER), ticks: 240 },
    // a 16-wide, 24-deep block of water against one wall, released into an empty box, measured 4 s
    damBreak: { setup: (w, E) => w.box(0, 0, 0, 15, 23, 63, E.WATER), settle: false, ticks: 240 },
  };
  const rows = [];
  for (const [name, sc] of Object.entries(scenes)) {
    for (const model of ['current', 'column']) {
      const W = model === 'current' ? lean.World : World, E = model === 'current' ? lean : { WATER, AIR };
      const w = new W(S.nx, S.ny, S.nz);
      sc.setup(w, E);
      const m0 = w.mass();
      if (sc.settle) { let t = 0; while (t < 1200) { w.step(); t++; if (w.idleAt >= 0 && t > w.idleAt + QUIET_TICKS) break; } }
      const track = awakeTracker(w);
      if (sc.wake) w.busy.fill(1), track();
      if (sc.drop) sc.drop(w, E);
      const m1 = w.mass();
      let bytes = 0, peak = 0, dispatchTicks = 0, awakeSum = 0, wetAwakeSum = 0, t0 = Date.now(), idleTick = null;
      for (let t = 0; t < sc.ticks; t++) {
        w.step();
        if (sc.wake && t < QUIET_TICKS) w.busy.fill(1);   // the wake holds the region awake one offset cycle
        const { awake, bricks } = track();
        awakeSum += awake;
        let b;
        if (model === 'current') {
          const wet = wetInBricks(w, bricks, (e) => e === E.WATER);
          wetAwakeSum += wet;
          b = awake * 64 * COST.currentPerAwakeCell;
        } else {
          // runs and segments inside awake columns only: the GPU dispatches over awake bricks' columns
          b = awake * COST.perAwakeBrick + (awake ? w.work.runs * COST.perRun + w.work.segments * COST.perSegment + w.work.written * COST.perWrittenCell : 0);
        }
        if (awake) dispatchTicks++;
        bytes += b; peak = Math.max(peak, b);
        if (idleTick === null && awake === 0) idleTick = t;
      }
      const drift = w.mass() - m1;
      void m0;
      rows.push({ scene: name, model, ticks: sc.ticks, awakeTicks: dispatchTicks, meanMB: +(bytes / sc.ticks / 1e6).toFixed(3), perAwakeTickMB: +(bytes / Math.max(1, dispatchTicks) / 1e6).toFixed(3), peakMB: +(peak / 1e6).toFixed(3),
        dispatchesPerTick: +((dispatchTicks / sc.ticks) * (model === 'current' ? COST.currentDispatches : COST.dispatches)).toFixed(1),
        awakeBricksMean: +(awakeSum / sc.ticks).toFixed(0), wetAwakeCellsMean: model === 'current' ? +(wetAwakeSum / sc.ticks).toFixed(0) : undefined,
        currentIfDrySkipPerAwakeTickMB: model === 'current' ? +((wetAwakeSum / Math.max(1, dispatchTicks)) * COST.currentPerAwakeCell / 1e6).toFixed(3) : undefined,
        asleepAtTick: idleTick, massDrift: drift, wallS: +((Date.now() - t0) / 1000).toFixed(1) });
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await costMain();
