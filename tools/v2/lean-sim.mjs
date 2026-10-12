// v2 "lean" pitch evidence: a CPU prototype of the proposed minimal rule set, in 3D.
// Not the GPU kernels: the same rules, written sequentially but with the GPU's ownership
// discipline (column pass: a thread owns a column; block pass: a thread owns a 2x2x2 block
// and reads only its own 8 cells plus a start-of-tick occupancy snapshot; flux pass: a face
// is owned by its -side cell, transfers are integers so mass is exact).
//
// Rules under test (pitch-lean.md section 3):
//   R1 column fall   powders with air below fall as runs, at g with a terminal speed; a slab stays a slab
//   R2 block topple  8 partition offsets per 8 ticks; a supported grain topples into an in-block lower
//                    neighbour if it and the cell above it are air; "drop" 1 (45 deg) or 2 (63 deg, cohesive)
//   R3 liquid flux   integer fill + per-face flux accelerated by head difference (weakly compressible),
//                    outflow-limited, damped, snapped to 0 under a quantum; film rule over dry ground
//   REST             a brick is busy in a tick if any rule was *possible* in it (chance ignored);
//                    idle = no busy brick for 8 consecutive ticks (one full offset cycle)
//
// usage: node lean-sim.mjs [test ...]   tests: slab heap heapFlour utube puddle partial pipe hole throw
const ALL = ['slab', 'heap', 'heapFlour', 'utube', 'puddle', 'partial', 'pipe', 'hole', 'throw'];
const tests = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const AIR = 0, WALL = 1, SAND = 2, FLOUR = 3, WATER = 4;
const DROP = { [SAND]: 1, [FLOUR]: 2 };          // repose: topple needs this many empty cells below the target
const isPowder = (e) => e === SAND || e === FLOUR;
const MOORE = Number(process.env.MOORE ?? 0.5);   // share of positions whose grains may topple diagonally

// one clock: 60 ticks/s, 0.3 m cells, game gravity 2 g (19.6 m/s^2)
const TICK_HZ = 60, CELL_M = 0.3, G_MS2 = 19.6;
const G = G_MS2 / CELL_M / (TICK_HZ * TICK_HZ);   // cells/tick^2 = 0.01815
const VT_SAND = 12 / CELL_M / TICK_HZ;            // terminal 12 m/s = 0.667 cells/tick
// liquid
// Pipe model in physical units: a head difference of one cell accelerates a face's flow by g*dt^2 cells^3 per
// substep. Compression carries pressure through lids; it must be soft enough for explicit substeps:
// stable iff COMP >= 3*g*dt^2 (highest 3D mode), so more substeps buy a stiffer, more incompressible liquid.
const FULL = 1 << 16, SUB = Number(process.env.SUB ?? 3);
const DT_SUB = 1 / (TICK_HZ * SUB), G_CELLS = G_MS2 / CELL_M;
const ACC = G_CELLS * DT_SUB * DT_SUB * FULL;
const COMP = Number(process.env.COMP ?? 4 * G_CELLS * DT_SUB * DT_SUB);   // 33% margin over the bound
const DAMP = Number(process.env.DAMP ?? 0.01), QMIN = 0.5, FILM = FULL >> 3, DEADQ = Number(process.env.DEADQ ?? 2);
const V_JET = 1 / CELL_M;   // 1 m/s: slower lateral outflow over a drop stays in the grid and runs down the face

function hash(a, b, c, d) {   // pcg-ish, deterministic
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class World {
  constructor(nx, ny, nz) {
    Object.assign(this, { nx, ny, nz, n: nx * ny * nz, tick: 0 });
    this.id = new Uint8Array(this.n);
    this.fill = new Int32Array(this.n);
    this.qx = new Float32Array(this.n); this.qy = new Float32Array(this.n); this.qz = new Float32Array(this.n);
    this.vy = new Float32Array(this.n); this.acc = new Float32Array(this.n);
    this.occ = new Uint8Array(this.n);            // start-of-tick occupancy snapshot (1 bit per cell on the GPU)
    this.bx = Math.ceil(nx / 4); this.by = Math.ceil(ny / 4); this.bz = Math.ceil(nz / 4);
    this.busy = new Uint8Array(this.bx * this.by * this.bz);
    this.quietTicks = 0; this.idleAt = -1; this.moves = 0;
    this.parts = []; this.landed = 0;
  }
  at(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.id[this.at(x, y, z)] : WALL; }
  set(x, y, z, e) { const i = this.at(x, y, z); this.id[i] = e; this.fill[i] = e === WATER ? FULL : 0; }
  mark(x, y, z) { this.busy[(x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2))] = 1; }
  box(x0, y0, z0, x1, y1, z1, e) { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, e); }
  mass() { let m = 0; for (let i = 0; i < this.n; i++) if (this.id[i] === WATER) m += this.fill[i]; for (const p of this.parts) m += p.m; return m; }
  count(e) { let c = 0; for (let i = 0; i < this.n; i++) if (this.id[i] === e) c++; return c; }
  busyBricks() { let c = 0; for (const b of this.busy) c += b; return c; }

  step() {
    this.busy.fill(0);
    for (let i = 0; i < this.n; i++) this.occ[i] = this.id[i] !== AIR ? 1 : 0;
    const prevId = this.prevId ??= new Uint8Array(this.n); prevId.set(this.id);
    this.columnFall();
    this.blockTopple();
    for (let s = 0; s < SUB; s++) this.flux(s);
    this.particles();
    const nb = this.busyBricks() + (this.parts.length ? 1 : 0);
    // the mesher's work: bricks whose occupancy (ids) changed this tick (fill-only changes need no remesh)
    const rb = this.remeshMark ??= new Uint8Array(this.busy.length); rb.fill(0);
    for (let y = 0; y < this.ny; y++) for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) {
      const i = this.at(x, y, z); if (prevId[i] !== this.id[i]) rb[(x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2))] = 1;
    }
    let nr = 0; for (const b of rb) nr += b;
    this.remeshSum = (this.remeshSum ?? 0) + nr; this.remeshMax = Math.max(this.remeshMax ?? 0, nr);
    this.busySum = (this.busySum ?? 0) + nb; this.busyMax = Math.max(this.busyMax ?? 0, nb);
    this.quietTicks = nb ? 0 : this.quietTicks + 1;
    if (this.quietTicks >= 8 && this.idleAt < 0) this.idleAt = this.tick - 7;
    if (nb) this.idleAt = -1;
    this.tick++;
    return nb;
  }

  // R1: a thread per (x, z) column, bottom to top. Everything in [floor, y) is air.
  columnFall() {
    const { nx, ny, nz } = this;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let floor = 0;
      for (let y = 0; y < ny; y++) {
        const i = this.at(x, y, z), e = this.id[i];
        if (e === AIR) continue;
        if (!isPowder(e)) { floor = y + 1; continue; }
        if (y === floor) { if (this.vy[i] > 0) { this.vy[i] = 0; this.acc[i] = 0; this.mark(x, y, z); } floor = y + 1; continue; }
        this.mark(x, y, z);                                  // unsupported: a rule is possible
        const v = Math.min(this.vy[i] + G, VT_SAND);
        let a = this.acc[i] + v; const d = Math.floor(a); a -= d;
        let t = y - d, vNew = v;
        if (t <= floor) { if (t < floor) { vNew = 0; a = 0; } t = floor; }   // hit the run below: land
        if (t !== y) {
          const j = this.at(x, t, z);
          this.id[j] = e; this.vy[j] = vNew; this.acc[j] = a;
          this.id[i] = AIR; this.vy[i] = 0; this.acc[i] = 0; this.moves++;
          this.mark(x, t, z);
        } else { this.vy[i] = vNew; this.acc[i] = a; }
        floor = t + 1;
      }
    }
  }

  // R2: a thread per 2x2x2 block at one of 8 offsets (a fresh permutation of the 8 every 8 ticks).
  blockTopple() {
    const cyc = Math.floor(this.tick / 8), k = this.tick % 8;
    const perm = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let a = 7; a > 0; a--) { const b = Math.floor(hash(cyc, a, 91, 7) * (a + 1)); [perm[a], perm[b]] = [perm[b], perm[a]]; }
    const o = perm[k], ox = o & 1, oy = (o >> 1) & 1, oz = (o >> 2) & 1;
    const { nx, ny, nz } = this;
    for (let by = oy - 1; by < ny; by += 2) for (let bz = oz - 1; bz < nz; bz += 2) for (let bx = ox - 1; bx < nx; bx += 2) {
      // top layer of the block: y = by + 1; bottom: y = by
      const ty = by + 1, yb = by;
      if (ty < 0 || ty >= ny || yb < 0) continue;
      for (let c = 0; c < 4; c++) {
        const x = bx + (c & 1), z = bz + (c >> 1);
        if (!this.inside(x, ty, z)) continue;
        const i = this.at(x, ty, z), e = this.id[i];
        if (!isPowder(e) || this.get(x, yb, z) === AIR) continue;    // falling cells belong to R1
        const cands = []; let wsum = 0;
        for (let c2 = 0; c2 < 4; c2++) {
          if (c2 === c) continue;
          const x2 = bx + (c2 & 1), z2 = bz + (c2 >> 1);
          if (this.get(x2, yb, z2) !== AIR || this.get(x2, ty, z2) !== AIR) continue;
          const diag = x2 !== x && z2 !== z;
          // round heaps: each position hashes to a von Neumann (axis-only) or a Moore (axis + diagonal)
          // neighbourhood; a mix of the two settles to an octagon instead of a square or a diamond
          if (diag && MOORE < 1 && hash(x, ty, z, 4242) >= MOORE) continue;
          if (diag && this.get(x2, ty, z) !== AIR && this.get(x, ty, z2) !== AIR) continue;   // no squeezing between corners
          let ok = true;   // cohesion: more empty cells below the target, from the snapshot (read-only)
          for (let dd = 1; dd < DROP[e]; dd++) { const yy = yb - dd; if (yy < 0 || (this.inside(x2, yy, z2) && this.occ[this.at(x2, yy, z2)])) { ok = false; break; } }
          if (!ok) continue;
          const w = diag ? 0.7 : 1; cands.push([x2, z2, w]); wsum += w;
        }
        if (!cands.length) continue;
        this.mark(x, ty, z);                                     // possible
        let r = hash(x, ty, z, this.tick * 3 + 1) * wsum, pick = cands[0];
        for (const cd of cands) { r -= cd[2]; if (r <= 0) { pick = cd; break; } }
        const j = this.at(pick[0], yb, pick[1]);
        this.id[j] = e; this.id[i] = AIR; this.vy[j] = 0; this.acc[j] = 0; this.moves++;
        this.mark(pick[0], yb, pick[1]);
      }
    }
  }

  // R4: ballistic particles on the world clock (cells/s, g in cells/s^2); swept in half-cell steps;
  // a particle that would enter a solid or a liquid surface deposits its mass into the cell it was in
  particles() {
    const dt = 1 / TICK_HZ, keep = [];
    for (const p of this.parts) {
      p.vy -= G_CELLS * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(p.vx, p.vy, p.vz) * dt / 0.5));
      let landed = false;
      for (let k = 0; k < steps; k++) {
        const nx = p.x + p.vx * dt / steps, ny = p.y + p.vy * dt / steps, nz = p.z + p.vz * dt / steps;
        const hx = Math.floor(nx), hy = Math.floor(ny), hz = Math.floor(nz), he = this.get(hx, hy, hz);
        // it lands on solids, powders and liquid surfaces (a cell at least half full with something under it);
        // it flies through thin streams, spray and unsupported deposits, so a jet isn't caught by its own trail
        const be = this.get(hx, hy - 1, hz);
        const held = be === WALL || isPowder(be) || (be === WATER && this.fill[this.at(hx, hy - 1, hz)] >= FULL);
        const thin = he === WATER && (this.fill[this.at(hx, hy, hz)] < FULL / 2 || !held);
        if (he !== AIR && !thin) {
          const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z), c = this.at(cx, cy, cz);
          if (this.id[c] === AIR) this.id[c] = WATER;
          this.fill[c] += p.m; this.mark(cx, cy, cz); landed = true; this.landed++;
          (this.landX ??= []).push(cx);
          break;
        }
        p.x = nx; p.y = ny; p.z = nz;
      }
      if (!landed) keep.push(p);
    }
    this.parts = keep;
  }

  head(i) { if (this.id[i] !== WATER) return 0; const f = this.fill[i]; return f <= FULL ? f / FULL : 1 + (f - FULL) / (COMP * FULL); }
  wet(x, y, z) { return this.inside(x, y, z) && this.id[this.at(x, y, z)] === WATER; }
  open(x, y, z) { const e = this.get(x, y, z); return e === AIR || e === WATER; }

  // R3: (a) each cell updates the flux on its +x, +y, +z faces; (b) outflow limit K per cell;
  // (c) integer transfers, each face computed once. Pass order on the GPU: flux, limit, gather.
  flux() {
    const { nx, ny, nz } = this;
    const Q = [this.qx, this.qy, this.qz], D = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = this.at(x, y, z);
      for (let a = 0; a < 3; a++) {
        const [dx, dy, dz] = D[a], x2 = x + dx, y2 = y + dy, z2 = z + dz;
        const q = Q[a];
        if (!this.open(x, y, z) || !this.open(x2, y2, z2)) { q[i] = 0; continue; }
        const j = this.at(x2, y2, z2), wi = this.id[i] === WATER, wj = this.id[j] === WATER;
        if (!wi && !wj) { q[i] = 0; continue; }
        const pi = this.head(i), pj = this.head(j);
        // dead band: a head difference worth fewer than DEADQ fill quanta drives nothing and its flow decays
        // fast, so quantized fills reach an exact fixed point instead of a +-1 quantum limit cycle. In units of
        // quanta, not head: a compressed cell's quantum is 1/COMP times a free surface's
        let drive = pi - pj - (a === 1 ? 1 : 0);
        const stiff = Math.max(this.fill[i] > FULL ? 1 / COMP : 1, this.fill[j] > FULL ? 1 / COMP : 1) / FULL;
        // ...and never below the drive whose damped steady flow stays under one quantum (it would stall)
        if (Math.abs(drive) < Math.max(DEADQ * stiff, 1.5 * DAMP / ACC)) drive = 0;
        let v = q[i] + ACC * drive;
        if (drive === 0) v *= 0.5;
        if ((v > 0 && !wi) || (v < 0 && !wj)) v = 0;   // only a wet cell can be the source
        if (a !== 1) {   // film rule: no lateral outflow onto dry ground below a film's depth
          if (v > 0 && !wj && this.fill[i] < FILM && !this.wet(x2, y2 - 1, z2)) v = 0;
          if (v < 0 && !wi && this.fill[j] < FILM && !this.wet(x, y - 1, z)) v = 0;
        }
        v *= 1 - DAMP;
        if (Math.abs(v) < QMIN) v = 0;
        q[i] = v;
      }
    }
    // (b) outflow limit
    const K = this.K ??= new Float32Array(this.n);
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = this.at(x, y, z); let out = 0;
      if (this.id[i] === WATER) {
        for (let a = 0; a < 3; a++) {
          out += Math.max(Q[a][i], 0);
          const [dx, dy, dz] = D[a];
          if (this.inside(x - dx, y - dy, z - dz)) out += Math.max(-Q[a][this.at(x - dx, y - dy, z - dz)], 0);
        }
      }
      K[i] = this.id[i] !== WATER ? 0 : out > this.fill[i] ? this.fill[i] / out : 1;
    }
    // (c) integer transfers
    const dF = this.dF ??= new Int32Array(this.n); dF.fill(0);
    let any = false;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = this.at(x, y, z);
      for (let a = 0; a < 3; a++) {
        const v = Q[a][i]; if (!v) continue;
        const [dx, dy, dz] = D[a], j = this.at(x + dx, y + dy, z + dz);
        const T = v > 0 ? Math.trunc(v * K[i]) : -Math.trunc(-v * K[j]);
        // R4 handoff: a lateral outflow faster than V_JET into a cell over open air leaves
        // the grid as a ballistic particle carrying exactly the transferred mass; it re-enters where it lands
        if (T && a !== 1) {
          const src = T > 0 ? i : j, dst = T > 0 ? j : i, sgn = Math.sign(T);
          const [tx, ty, tz] = T > 0 ? [x + dx, y + dy, z + dz] : [x, y, z];
          const speed = Math.abs(T) / FULL * TICK_HZ * SUB;   // cells/s through a 1-cell face (the mass flow)
          // only over open air: the cell under the target is air or spray (< 1/16 full). A surface flow over a
          // body of liquid, or a submerged outflow, stays in the grid; the target itself may be wet (a stream)
          const below = this.get(tx, ty - 1, tz), open = below === AIR || (below === WATER && this.fill[this.at(tx, ty - 1, tz)] < FULL / 16);
          if (open && speed > V_JET) {
            dF[src] -= Math.abs(T); any = true; this.mark(x, y, z);
            // mass from the flux, speed from the head (Bernoulli): the pipe model's face flow isn't a velocity
            // the orifice cell itself is drained below hydrostatic, so take the static head of the wettest
            // cell feeding it (its own or a neighbour's): the tank's pressure just behind the hole
            const [sx, sy, sz] = T > 0 ? [x, y, z] : [x + dx, y + dy, z + dz];
            let hs = this.head(src);
            for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])
              if (this.wet(sx + ex, sy + ey, sz + ez)) hs = Math.max(hs, this.head(this.at(sx + ex, sy + ey, sz + ez)) - (ey > 0 ? -1 : ey < 0 ? 1 : 0));
            const vJet = Math.sqrt(2 * G_CELLS * Math.max(hs - 0.5, 0));
            this.parts.push({ x: tx + 0.5 - 0.5 * sgn * dx, y: ty + 0.5, z: tz + 0.5 - 0.5 * sgn * dz,
              vx: sgn * dx * vJet, vy: 0, vz: sgn * dz * vJet, m: Math.abs(T) });
            continue;
          }
        }
        if (T) { dF[i] -= T; dF[j] += T; any = true; this.mark(x, y, z); this.mark(x + dx, y + dy, z + dz); }
        else this.mark(x, y, z);   // a nonzero flux is a possible rule even if it moved < 1 quantum this substep
      }
    }
    if (!any) return;
    for (let i = 0; i < this.n; i++) if (dF[i]) {
      this.fill[i] += dF[i];
      if (this.fill[i] > 0) { if (this.id[i] === AIR) this.id[i] = WATER; }
      else if (this.id[i] === WATER) { this.id[i] = AIR; this.fill[i] = 0; this.qx[i] = this.qy[i] = this.qz[i] = 0; }
    }
  }
  run(ticks, every, report) { for (let t = 1; t <= ticks; t++) { const nb = this.step(); if (every && t % every === 0) report(t, nb); } }
}

const out = { params: { TICK_HZ, CELL_M, G_MS2, SUB, FULL, ACC: +ACC.toFixed(2), COMP: +COMP.toFixed(4), DAMP, DEADQ, FILM_FRACTION: FILM / FULL } };
console.log('params', JSON.stringify(out.params));
const log = (...a) => console.log(...a);
const sec = (t) => (t / TICK_HZ).toFixed(2) + ' s';

// ---- R1: a slab stays a slab, and falls at g --------------------------------------------------
if (tests.includes('slab')) {
  const w = new World(32, 40, 32);
  w.box(4, 30, 4, 27, 30, 27, SAND);                   // a 24x1x24 layer, as audit-physics E2
  const rows = [];
  w.run(90, 10, (t) => {
    let lo = 99, hi = -1, sum = 0, c = 0;
    for (let y = 0; y < w.ny; y++) for (let z = 0; z < w.nz; z++) for (let x = 0; x < w.nx; x++) if (w.get(x, y, z) === SAND) { lo = Math.min(lo, y); hi = Math.max(hi, y); sum += y; c++; }
    let tt = 0, v = 0, fallen = 0;     // ideal: same capped integration
    for (let k = 0; k < t; k++) { v = Math.min(v + G, VT_SAND); fallen += v; tt++; }
    rows.push({ tick: t, centreFallen: +(30 - sum / c).toFixed(2), ideal: +Math.min(fallen, 30).toFixed(2), thickness: hi - lo + 1 });
  });
  out.slab = rows; log('slab (24x1x24 sand from y=30):'); for (const r of rows) log(' ', JSON.stringify(r));
}

// ---- R2: heaps (round, angle by element, and they rest) --------------------------------------
function heap(e, name) {
  const w = new World(40, 24, 40);
  // pour 864 grains from a 6x6 nozzle, 2 layers per 4 ticks, like a hopper
  let poured = 0, t = 0, pourEnd = -1; const target = 864;
  while (poured < target || t < 4000) {
    if (poured < target && t % 4 === 0) for (let z = 17; z < 23; z++) for (let x = 17; x < 23; x++) if (w.get(x, 22, z) === AIR) { w.set(x, 22, z, e); poured++; }
    if (poured >= target && pourEnd < 0) pourEnd = t;
    w.step(); t++;
    if (poured >= target && w.idleAt >= 0 && t > w.idleAt + 8) break;
  }
  // height map + radial profile
  const H = []; let peak = 0, foot = 0;
  for (let z = 0; z < w.nz; z++) { const row = []; for (let x = 0; x < w.nx; x++) { let h = 0; for (let y = w.ny - 1; y >= 0; y--) if (w.get(x, y, z) === e) { h = y + 1; break; } row.push(h); peak = Math.max(peak, h); if (h) foot++; } H.push(row); }
  // radius of the footprint along the axis and the diagonal from the centre (19.5, 19.5)
  // footprint extent from the centre (19.5, 19.5) in 4 axis and 4 diagonal directions, averaged
  const ext = (dx, dz) => { let r = 0; for (let k = 0; k < 20; k++) { const x = Math.floor(19.5 + dx * (k + 0.5)), z = Math.floor(19.5 + dz * (k + 0.5)); if (H[z] && H[z][x] > 0) r = Math.hypot(dx, dz) * (k + 1); } return r; };
  const rAxis = (ext(1, 0) + ext(-1, 0) + ext(0, 1) + ext(0, -1)) / 4;
  const rDiag = (ext(1, 1) + ext(-1, -1) + ext(1, -1) + ext(-1, 1)) / 4;
  const map = H.slice(8, 32).map((r) => r.slice(6, 34).map((h) => (h ? (h > 9 ? '#' : String(h)) : '.')).join(''));
  const res = { element: name, bricks: w.busy.length, busyMean: +(w.busySum / t).toFixed(1), busyMax: w.busyMax, remeshMean: +(w.remeshSum / t).toFixed(1), remeshMax: w.remeshMax, grains: w.count(e), ticks: t, idleCertifiedAtTick: w.idleAt, idleAt: w.idleAt >= 0 ? sec(w.idleAt) : 'never', pourEnded: sec(pourEnd), idleAfterPour: w.idleAt >= 0 ? sec(w.idleAt - pourEnd) : 'never', peak, footprint: foot, rAxis: +rAxis.toFixed(2), rDiag: +rDiag.toFixed(2), diagOverAxis: +(rDiag / rAxis).toFixed(2), slope: +(peak / rAxis).toFixed(2), map };
  log(`heap ${name}:`, JSON.stringify({ ...res, map: undefined })); for (const l of map) log('   ' + l);
  return res;
}
if (tests.includes('heap')) out.heap = heap(SAND, 'sand (drop 1)');
if (tests.includes('heapFlour')) out.heapFlour = heap(FLOUR, 'flour (drop 2)');

// ---- R3: liquids ------------------------------------------------------------------------------
function levels(w, xs, z) { return xs.map((x) => { let top = 0; for (let y = 0; y < w.ny; y++) { const i = w.at(x, y, z); if (w.id[i] === WATER) top = y + Math.min(w.fill[i], FULL) / FULL; } return +top.toFixed(2); }); }
if (tests.includes('utube')) {
  // two 4x4 arms joined by a 20-long channel at the bottom (audit-liquids U-tube, at 32 high)
  const w = new World(30, 32, 6);
  w.box(0, 0, 0, 29, 31, 5, WALL);
  w.box(1, 1, 1, 4, 31, 4, AIR); w.box(25, 1, 1, 28, 31, 4, AIR); w.box(5, 1, 1, 24, 4, 4, AIR);
  w.box(1, 1, 1, 4, 25, 4, WATER); w.box(5, 1, 1, 24, 4, 4, WATER);
  const m0 = w.mass(); const rows = [];
  w.run(3600, 300, (t, nb) => rows.push({ tick: t, time: sec(t), left: levels(w, [2], 2)[0], right: levels(w, [26], 2)[0], busyBricks: nb, massDrift: w.mass() - m0 }));
  out.utube = { rows, idleAt: w.idleAt }; log('utube:'); for (const r of rows) log(' ', JSON.stringify(r)); log('  idle certified at tick', w.idleAt);
}
if (tests.includes('puddle')) {
  const w = new World(64, 10, 64);
  w.box(29, 4, 29, 34, 9, 34, WATER);   // a 6^3 block dropped 3 cells (audit-liquids puddle), on a 64x64 floor
  const m0 = w.mass(); const rows = [];
  w.run(1800, 150, (t, nb) => { let wet = 0, maxF = 0, minF = 1e9; for (let i = 0; i < w.n; i++) if (w.id[i] === WATER) { wet++; maxF = Math.max(maxF, w.fill[i]); minF = Math.min(minF, w.fill[i]); } rows.push({ tick: t, time: sec(t), wetCells: wet, fillMin: +(minF / FULL).toFixed(3), fillMax: +(maxF / FULL).toFixed(3), busyBricks: nb, massDrift: w.mass() - m0 }); });
  const map = []; for (let z = 6; z < 58; z += 2) { let s = ''; for (let x = 6; x < 58; x += 1) { let f = 0; for (let y = 0; y < 4; y++) { const i = w.at(x, y, z); if (w.id[i] === WATER) f += w.fill[i]; } s += f === 0 ? '.' : f >= FULL ? '#' : String(Math.min(9, Math.floor(10 * f / FULL))); } map.push(s); }
  out.puddle = { rows, idleAt: w.idleAt, map }; log('puddle:'); for (const r of rows) log(' ', JSON.stringify(r)); log('  idle certified at tick', w.idleAt); for (const l of map) log('   ' + l);
}
if (tests.includes('partial')) {
  // a 24x24 tank, 3 full layers + 150 cells' worth on top (audit-liquids "partial top layer")
  const w = new World(26, 10, 26);
  w.box(0, 0, 0, 25, 0, 25, WALL); w.box(0, 0, 0, 0, 9, 25, WALL); w.box(25, 0, 0, 25, 9, 25, WALL); w.box(0, 0, 0, 25, 9, 0, WALL); w.box(0, 0, 25, 25, 9, 25, WALL);
  w.box(1, 1, 1, 24, 3, 24, WATER);
  let k = 0; for (let z = 1; z < 25 && k < 150; z++) for (let x = 1; x < 25 && k < 150; x++, k++) w.set(x, 4, z, WATER);
  const m0 = w.mass(); const rows = [];
  w.run(1800, 150, (t, nb) => { let lo = 1e9, hi = 0; for (let z = 1; z < 25; z++) for (let x = 1; x < 25; x++) { const l = levels(w, [x], z)[0]; lo = Math.min(lo, l); hi = Math.max(hi, l); } rows.push({ tick: t, time: sec(t), surfaceMin: lo, surfaceMax: hi, busyBricks: nb, massDrift: w.mass() - m0 }); });
  out.partial = { rows, idleAt: w.idleAt }; log('partial:'); for (const r of rows) log(' ', JSON.stringify(r)); log('  idle certified at tick', w.idleAt);
}
if (tests.includes('pipe')) {
  // a 6x6 tank 27 deep with a 1x1 bore along its foot, 12 cells long, open into a basin (audit-liquids pipe)
  const w = new World(40, 31, 8);
  w.box(0, 0, 0, 39, 0, 7, WALL);
  w.box(0, 1, 0, 7, 30, 7, WALL); w.box(1, 1, 1, 6, 28, 6, AIR); w.box(1, 1, 1, 6, 27, 6, WATER);
  w.box(8, 1, 3, 19, 3, 5, WALL); w.box(7, 2, 4, 19, 2, 4, AIR);   // the pipe: a 1x1 bore at y=2 through the wall, 13 long
  const m0 = w.mass(); const rows = [];
  const tank = () => { let m = 0; for (let y = 1; y < 31; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 7; x++) { const i = w.at(x, y, z); if (w.id[i] === WATER) m += w.fill[i]; } return +(m / FULL).toFixed(1); };
  w.run(3600, 300, (t, nb) => rows.push({ tick: t, time: sec(t), tankCells: tank(), tankLevel: levels(w, [3], 3)[0], busyBricks: nb, massDrift: w.mass() - m0 }));
  out.pipe = { rows, idleAt: w.idleAt }; log('pipe:'); for (const r of rows) log(' ', JSON.stringify(r)); log('  idle certified at tick', w.idleAt);
}
if (tests.includes('hole')) {
  // 7x6 tank 19 deep, 1-cell hole at the foot of its +x wall; x-y slice through the hole at t = 1 s, 2 s
  // the tank stands on a 12-cell pedestal so the stream has room to arc
  const w = new World(40, 34, 8);
  w.box(0, 0, 0, 8, 32, 7, WALL); w.box(1, 13, 1, 7, 32, 6, AIR); w.box(1, 13, 1, 7, 31, 6, WATER); w.box(8, 14, 3, 8, 14, 3, AIR);
  const snaps = {}, m0 = w.mass();
  const snap = () => { const L = []; for (let y = 33; y >= 0; y--) { let s = ''; for (let x = 0; x < 40; x++) { const i = w.at(x, y, 3), e = w.id[i]; let c = e === WALL ? '#' : e === WATER ? (w.fill[i] >= FULL / 2 ? '~' : w.fill[i] >= FULL / 16 ? ',' : '.') : ' '; if (c === ' ' && w.parts.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)) c = '*'; s += c; } L.push(s); } return L; };
  w.run(30, 0); snaps['0.5s'] = snap(); w.run(90, 0); snaps['2s'] = snap();
  // Torricelli check: exit speed from the face flux at the hole vs sqrt(2 g h), h = level above the hole
  // the newest particles leave at the current exit speed; compare with sqrt(2 g h) for the current head
  const lvl = levels(w, [4], 3)[0], h = lvl - 14.5, vT = Math.sqrt(2 * G_CELLS * h);
  const fresh = w.parts.filter((p) => p.x < 10.5), vExit = fresh.length ? fresh.reduce((a, p) => a + p.vx, 0) / fresh.length : 0;
  const tFall = Math.sqrt(2 * 14.5 / G_CELLS), xIdeal = 9 + vExit * tFall;
  const lx = w.landX.slice(-20), xLand = lx.reduce((a, b) => a + b, 0) / lx.length + 0.5;
  snaps.torricelli = { bricks: w.busy.length, busyMean: +(w.busySum / w.tick).toFixed(1), busyMax: w.busyMax, remeshMean: +(w.remeshSum / w.tick).toFixed(1), remeshMax: w.remeshMax, headCells: +h.toFixed(2), exitCellsPerS: +vExit.toFixed(1), torricelliCellsPerS: +vT.toFixed(1), ratio: +(vExit / vT).toFixed(2), landX: +xLand.toFixed(1), parabolaX: +xIdeal.toFixed(1), particlesInFlight: w.parts.length, massDrift: w.mass() - m0 };
  log('  torricelli', JSON.stringify(snaps.torricelli));
  out.hole = snaps; log('hole, x-y slice through the hole (~ fill >= 1/2, , >= 1/16, . less):'); for (const k in snaps) if (Array.isArray(snaps[k])) { log('  at', k); for (const l of snaps[k]) log('   |' + l + '|'); }
}
if (tests.includes('throw')) {
  // ballistic particles (R4): integrate at the same clock, land into the first empty cell; no cap, no coin
  const g = G, res = [];
  for (const [vx, vy] of [[0.5, 0], [0.5, 0.5], [1.5, 0.3]]) {
    let x = 2, y = 26, ux = vx, uy = vy, t = 0;
    while (y > 0) { uy -= g; x += ux; y += uy; t++; }
    const ideal = (() => { let X = 2, Y = 26, UX = vx, UY = vy; while (Y > 0) { UY -= g; X += UX; Y += UY; } return X; })();
    res.push({ v: [vx, vy], landsAtX: +x.toFixed(2), ideal: +ideal.toFixed(2), ticks: t });
  }
  out.throw = res; log('throw (particles):', JSON.stringify(res));
}

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
writeFileSync(fileURLToPath(new URL(`./lean-sim.out${tests.length === ALL.length ? '' : '-' + tests.join('-')}.json`, import.meta.url)), JSON.stringify(out, null, 1));
