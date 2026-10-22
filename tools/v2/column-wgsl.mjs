// CPU witness for column-run water (src/shaders/v2/columns.js): EXECUTES the emitted WGSL bodies of the
// model's col* functions on a CPU grid of production-format cells (16 B core + 4 B bank, the production
// energy/payload helpers of src/v2/layout.js). Not a second model. The finite syntax adapter below handles
// only the scalar subset those functions are written in (the check rejects bit operations and integer
// division in them); the codec helpers they call (records, lanes, the moved cores, foam, atomics) are JS
// twins of the bit layouts they name. f32 expressions run in f64 (integer custody does not depend on it).
// No GPU, browser or World variant of the application.
import { columnWaterWGSL, pairOrder, COLUMN, RADIAL } from '../../src/shaders/v2/columns.js';
import { ELEMENTS, E, K } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { v2Rows, SUMMARY } from '../../src/shaders/v2.js';
import { FOAM_ROWS } from '../../src/v2/foam.js';

export const TRANSLATED = ['colMove', 'colEta', 'colStiff', 'colDepth', 'colFlux', 'colDemand', 'colPack', 'colFall',
  'colFinish', 'colShockLand', 'colShockSpeed2', 'colV1FallSpeed', 'colShockOnFall', 'colKeepsFall', 'colExtent', 'colScan', 'colTransfer', 'colFluxes', 'colTransfers', 'colClearScratch', 'colLimit', 'colGravity',
  'colDampTick', 'colSwap', 'colSetLanes', 'colSetLane', 'colFill', 'colClass', 'colCell', 'colBusy', 'colAdvect', 'colSend', 'colPour', 'colOver', 'colEdgeFlux', 'colEdges', 'colDrain', 'colRemove', 'colCrown', 'colLayer', 'colDepthAt', 'colFloats', 'colFloor', 'colSends', 'colStratify',
  // radial gravity (columns.js RADIAL)
  'colRadInside', 'colRadPull', 'colRadAxis', 'colRadSign', 'colRadMass', 'colRadHead', 'colRadWetBelow', 'colRadCovered', 'colRadDemand',
  'colRadNote', 'colRadRuns', 'colRadTowardPlus', 'colRadColumn', 'colRadPairs', 'colRadPair', 'colRadFace', 'colRadPackAmount', 'colRadSendAmount'];
// the f32 functions (division allowed: never on integers)
export const FLOAT = ['colEta', 'colStiff', 'colDepth', 'colFlux', 'colDemand', 'colGravity', 'colDampTick', 'colLimit', 'colFall', 'colShockLand', 'colV1FallSpeed', 'colFluxes', 'colTransfers', 'colAdvect', 'colSend', 'colPour', 'colEdgeFlux', 'colEdges', 'colCrown', 'colLayer', 'colDepthAt', 'colSends',
  'colRadPull', 'colRadHead', 'colRadDemand'];

export function wgslFunction(code, name) {
  const at = code.indexOf(`fn ${name}(`);
  if (at < 0) throw new Error(`column-wgsl: no fn ${name}`);
  const open = code.indexOf('(', at), close = code.indexOf(')', open);
  const args = code.slice(open + 1, close).split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
  const start = code.indexOf('{', close);
  let depth = 1, end = start + 1;
  for (; depth; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return { args, body: code.slice(start + 1, end - 1) };
}
// Deliberately finite: the subset's spelling, not a WGSL interpreter.
export function syntax(body) {
  return body.replace(/\/\/[^\n]*/g, '')
    .replace(/\bloop\s*\{/g, 'for (;;) {')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(let|const) (\w+): (u32|i32|f32|bool|vec4u|vec3i)/g, '$1 $2')
    .replace(/\b(0x[0-9a-f]+|\d+)u\b/g, '$1').replace(/\b(\d+)i\b/g, '$1');
}
export function constants(code) {
  const out = {};
  for (const m of code.matchAll(/const (\w+): (u32|i32|f32) = ([^;]+);/g)) out[m[1]] = Number(m[3].replace(/u$/, ''));
  return out;
}

const f16 = Math.f16round;
const C = { AIR: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
const CLS = ELEMENTS.map(e => ({ [K.EMPTY]: C.AIR, [K.SOLID]: C.SOLID, [K.POWDER]: C.POWDER, [K.LIQUID]: C.LIQUID, [K.GAS]: C.GAS }[e.kind] ?? C.SOLID));
const ROWS = v2Rows();
const burns = id => (ELEMENTS[id]?.burnRate ?? 0) > 0;
const u = x => x >>> 0;

/** A CPU grid running the emitted column passes. Cells are x + nx (z + nz y); bricks of 4³ for activity. */
export class ColumnGrid {
  constructor(nx, ny, nz, { gravity = 19.6, gravMode = 0, edge = 0, stillRadial = false, deco = 0 } = {}) {
    // stillRadial: radial gravity as it was before columns.js RADIAL (liquids held still: the red variant)
    Object.assign(this, { nx, ny, nz, n: nx * ny * nz, tick: 0, stillRadial });
    this.cores = Array.from({ length: this.n }, () => new Uint32Array([L.makeMaterial(0, 20, 0).core[0], 0, 0, 0]));
    this.banks = new Int32Array(this.n);
    // the decoration plane V2 keeps beside the banks (shaders/v2/state.js auxLayout: RGBA8 a cell)
    this.deco = new Uint32Array(this.n);
    this.events = new Uint32Array(this.n);
    this.scratch = Array.from({ length: this.n }, () => new Uint32Array(4));
    this.demand = new Uint32Array(2 * this.n);
    this.bx = Math.ceil(nx / 4); this.by = Math.ceil(ny / 4); this.bz = Math.ceil(nz / 4);
    this.nb = this.bx * this.by * this.bz;
    this.busy = new Uint8Array(this.nb); this.busyIn = new Uint8Array(this.nb).fill(1);
    this.quiet = new Uint8Array(this.nb); this.awake = new Uint8Array(this.nb);
    this.quietTicks = 0; this.idleAt = -1;
    // the jets' per-brick marks, the particles in flight (the dynamics module's, as the prototype flies them)
    // support's brick summaries (v2ActLayout summary): 0 unknown; cleared by every write (noteState)
    this.summary = new Uint32Array(this.nb);
    // the boundary ledger (open edges): what left the box, its mass and its exact carried energy
    this.boundary = { mass: 0, energy: 0n };
    this.jetBricks = new Uint8Array(this.nb); this.parts = []; this.poolCap = 65536; this.landed = 0;
    this.P = { tick: 0, gravMode, gravity, edge, pairAxis: 0, pairParity: 0, deco };
    // loop edges (P.edge 2): mEdge wraps x and z (and y) around the box
    this.loop = edge === 2;
    this.ctx = this.#context();
  }
  at(x, y, z) { return x + this.nx * (z + this.nz * y); }
  material(i) { return { core: this.cores[i], bank: this.banks[i] }; }
  set(x, y, z, id, { T = 20, fill = L.FULL, ctype = 0 } = {}) {
    const i = this.at(x, y, z), m = L.makeMaterial(id, T, L.isLiquid(id) ? fill : L.FULL, ctype);
    this.cores[i] = new Uint32Array(m.core); this.banks[i] = m.bank; this.touch(i);
    // an edit wakes its brick for the next tick (the import's busyIn)
    this.markAt(x, y, z); this.busyIn[(x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2))] = 1;
  }
  brickOf(x, y, z) { return (x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2)); }
  touch(i) { const x = i % this.nx, z = Math.floor(i / this.nx) % this.nz, y = Math.floor(i / (this.nx * this.nz)); this.summary[this.brickOf(x, y, z)] = 0; }
  // v2support's summary of an awake brick, from its cells
  summarize(b) {
    const bx = b % this.bx, bz = Math.floor(b / this.bx) % this.bz, by = Math.floor(b / (this.bx * this.bz));
    let first = null;
    for (let y = by * 4; y < by * 4 + 4; y++) for (let z = bz * 4; z < bz * 4 + 4; z++) for (let x = bx * 4; x < bx * 4 + 4; x++) {
      const c = this.cores[this.at(x, y, z)], k = CLS[L.cid(c)];
      let code = SUMMARY.CLOSED;
      if (k === C.AIR) code = SUMMARY.AIR;
      if (k === C.LIQUID) code = L.cFill(c) === L.FULL && !(c[0] >>> 24) ? (SUMMARY.LIQUID | (L.cid(c) << 8) | ((L.cid(c) === E.LAVA ? L.ctypeOf(c) : 0) << 16)) >>> 0 : 0;
      if (first === null) first = code; else if (code !== first) { this.summary[b] = 0; return; }
    }
    this.summary[b] = first;
  }
  markAt(x, y, z) { if (x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz) this.busy[(x >> 2) + this.bx * ((z >> 2) + this.bz * (y >> 2))] = 1; }
  totals() {
    let mass = 0, energy = 0n, fuel = 0;
    for (const q of this.parts) { mass += L.cFill(q.m.core); energy += L.packetOwnedEnergy(q.m); if (!L.isConductor(L.cid(q.m.core))) fuel += L.payloadOf(q.m.core); }
    for (let i = 0; i < this.n; i++) {
      const m = this.material(i);
      energy += L.energyOf(m);
      if (L.isLiquid(L.cid(m.core))) { mass += L.cFill(m.core); if (!L.isConductor(L.cid(m.core))) fuel += L.payloadOf(m.core); }
    }
    return { mass, energy, fuel };
  }

  #context() {
    const g = this, code = columnWaterWGSL;
    const slotOf = p => g.at(p[0], p[1], p[2]);
    const ctx = {
      ...constants(code), NX: g.nx, NY: g.ny, NZ: g.nz, FULLU: L.FULL, MAX_FILL: L.MAX_FILL, C_AIR: C.AIR, C_SOLID: C.SOLID, C_POWDER: C.POWDER, C_LIQUID: C.LIQUID, C_GAS: C.GAS, P: g.P,
      vec3i: (x, y, z) => [x, y, z], Material: (core, bank) => ({ core, bank }),
      u32: x => Math.max(0, Math.trunc(x)), i32: Math.trunc, f32: Math.fround,
      min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
      clamp: (x, a, b) => Math.min(Math.max(x, a), b), select: (a, b, c) => (c ? b : a),
      slotOf, events: g.events,
      // shaders/v2/state.js decoStorageWGSL's twins
      decoOf: s => g.deco[s], setDeco: (s, d) => { g.deco[s] = d >>> 0; },
      loadCore: s => new Uint32Array(g.cores[s]), loadMaterial: s => ({ core: new Uint32Array(g.cores[s]), bank: g.banks[s] }),
      storeMaterial: (s, before, after) => {
        if (before.core.some((v, k) => v !== after.core[k]) || before.bank !== after.bank) g.touch(s);
        g.cores[s] = new Uint32Array(after.core); g.banks[s] = after.bank;
      },
      colProbe: (x, y, z) => {
        const code = g.summary[g.brickOf(x, y, z)];
        if (code === SUMMARY.CLOSED) return { kind: 0, read: false, id: 0, sub: 0, fill: 0 };
        if (code === SUMMARY.AIR) return { kind: 1, read: false, id: 0, sub: 0, fill: 0 };
        if ((code & 255) === SUMMARY.LIQUID) return { kind: 2, read: false, id: (code >>> 8) & 255, sub: code >>> 16, fill: L.FULL };
        const c = g.cores[slotOf([x, y, z])], k = CLS[L.cid(c)];
        if (k === C.AIR) return { kind: 1, read: true, id: 0, sub: 0, fill: 0 };
        if (k === C.LIQUID) return { kind: 2, read: true, id: L.cid(c), sub: L.cid(c) === E.LAVA ? L.ctypeOf(c) : 0, fill: L.cFill(c) };
        return { kind: 0, read: true, id: 0, sub: 0, fill: 0 };
      },
      probeOpen: p => p.kind !== 0, probeLiquid: p => (p.kind === 2 ? p.id : 0), probeSub: p => p.sub, probeFill: p => p.fill, probeRead: p => p.read,
      markBusy: p => g.markAt(p[0], p[1], p[2]),
      // the format's accessors (src/v2/layout.js), classes by element kind, rows by v2Rows()
      cid: L.cid, cFill: L.cFill, cTq: L.cTq, ctypeOf: L.ctypeOf, payloadOf: L.payloadOf, cAge: c => c[0] >>> 24,
      clsOf: c => CLS[L.cid(c)] ?? C.SOLID, isLiq: c => CLS[L.cid(c)] === C.LIQUID,
      isOpenC: c => { const k = CLS[L.cid(c)]; return k === C.AIR || k === C.LIQUID; },
      materialAmount: c => (L.cid(c) === 0 ? 0 : L.isLiquid(L.cid(c)) ? L.cFill(c) : L.FULL),
      conductsNative: L.isConductor, dampOf: id => ROWS[id].damp, yieldOf: id => ROWS[id].yieldHead, densOfE: id => ROWS[id].dens,
      vec2f: (a, b) => ({ x: a, y: b }),
      withPayload: (c, v) => L.withPayload({ core: c, bank: 0 }, v).core,
      withAge: (c, a) => { const o = new Uint32Array(c); o[0] = u((o[0] & 0xffffff) | (Math.min(a, 255) << 24)); return o; },
      zeroQ: c => { const k = CLS[L.cid(c)]; if (k !== C.AIR && k !== C.LIQUID) return c; return new Uint32Array([c[0], c[1], 0, u(c[3] & 0xffff0000)]); },
      // signed 64-bit energy as BigInt (the WGSL limbs' values)
      energyOf: L.energyOf, energySub: (a, b) => a - b, energyAdd: (a, b) => a + b, energyMul: (a, b) => BigInt(a) * BigInt(b),
      energyShare: (e, p, n, d) => L.share(e, p, n, d), shareUnsigned: (t, p, n, d) => Number(L.share(t, p, n, d)),
      energyFits: L.energyFits, withEnergy: L.withEnergy,
      // radial face demands (columns.js radSetDemand's layout: .y +x, .z +y, .w +z of the -side cell's slot)
      radSetDemand: (x, y, z, axis, n, coveredMinus, coveredPlus) => {
        g.scratch[slotOf([x, y, z])][1 + axis] = (Math.min(Math.trunc(Math.abs(n)), RADIAL.DEMAND_MAX) | (n < 0 ? RADIAL.BACK : 0) |
          (coveredMinus ? RADIAL.COVERED_MINUS : 0) | (coveredPlus ? RADIAL.COVERED_PLUS : 0)) >>> 0;
      },
      radDemandAt: (x, y, z, axis) => { const w = g.scratch[slotOf([x, y, z])][1 + axis], n = w & RADIAL.DEMAND_MAX; return w & RADIAL.BACK ? -n : n; },
      radCoveredAt: (x, y, z, axis, plus) => (g.scratch[slotOf([x, y, z])][1 + axis] & (plus ? RADIAL.COVERED_PLUS : RADIAL.COVERED_MINUS)) !== 0,
      // records (columns.js recMake's layout)
      colRec: (x, k, z) => new Uint32Array(g.scratch[slotOf([x, k, z])]),
      colPut: (x, k, z, r) => { g.scratch[slotOf([x, k, z])] = new Uint32Array(r); },
      recMake: (y0, top, r1, liq, sub, mass, falling, last) => new Uint32Array([u(y0 | (top << 16)), u(r1 | (liq << 16) | (sub << 24)), u(mass | (falling ? 0x80000000 : 0) | (last ? 0x40000000 : 0)), 0]),
      recY0: r => r[0] & 65535, recTop: r => r[0] >>> 16, recR1: r => r[1] & 65535, recLiq: r => (r[1] >>> 16) & 255, recSub: r => r[1] >>> 24,
      recMass: r => r[2] & 0x3fffffff, recFalling: r => (r[2] & 0x80000000) !== 0, recLast: r => (r[2] & 0x40000000) !== 0,
      recScratch: r => new Float32Array(new Uint32Array([r[3]]).buffer)[0],
      withRecScratch: (r, v) => { const o = new Uint32Array(r); o[3] = new Uint32Array(new Float32Array([v]).buffer)[0]; return o; },
      withRecTop: (r, top) => { const o = new Uint32Array(r); o[0] = u((o[0] & 65535) | (top << 16)); return o; },
      withRecLast: (r, last) => { const o = new Uint32Array(r); o[2] = u((o[2] & ~0x40000000) | (last ? 0x40000000 : 0)); return o; },
      withRecRun: (r, r1, liq, sub, mass) => { const o = new Uint32Array(r); o[1] = u(r1 | (liq << 16) | (sub << 24)); o[2] = u((o[2] & ~0x3fffffff) | mass); return o; },
      // lanes: x = low16 of z, y = high16 of z, z = low16 of w (qOf), f16 round to nearest
      laneOf: (c, axis) => { const h = new Float16Array(new Uint16Array([axis === 0 ? c[2] & 65535 : axis === 1 ? c[2] >>> 16 : c[3] & 65535]).buffer); return h[0]; },
      withLane: (c, axis, v) => {
        const o = new Uint32Array(c), bits = new Uint16Array(new Float16Array([f16(v)]).buffer)[0];
        if (axis === 0) o[2] = u((o[2] & 0xffff0000) | bits); else if (axis === 1) o[2] = u((o[2] & 65535) | (bits << 16)); else o[3] = u((o[3] & 0xffff0000) | bits);
        return o;
      },
      liquidSub: c => (L.cid(c) === E.LAVA ? L.ctypeOf(c) : 0),
      drainedCore: (c, left) => left === 0 ? new Uint32Array([u(c[0] & 0x00ffff00), 0, c[2], u(c[3] & 65535)]) : new Uint32Array([c[0], u((c[1] & 0xff000000) | left), c[2], c[3]]),
      receivedCore: (dst, src, fill) => {
        const burn = burns(L.cid(src)) ? (src[1] & 0x80000000) : 0;
        if (L.cid(dst) === 0) return new Uint32Array([u((dst[0] & 0x00ffff00) | L.cid(src)), u(fill | (L.ctypeOf(src) << 24) | burn), dst[2], u(dst[3] & 65535)]);
        return new Uint32Array([dst[0], u((dst[1] & 0xff000000) | fill | burn), dst[2], dst[3]]);
      },
      foamAgeOf: (dst, src, n, fill, agitate) => {
        const amount = L.cid(dst) === 0 ? 0 : L.cFill(dst);
        const mass = (dst[0] >>> 24) * amount + (src[0] >>> 24) * n;
        const gen = agitate ? Math.trunc(Math.min(Math.max(n / L.FULL * COLUMN.FOAM_ARRIVAL * FOAM_ROWS[L.cid(src)].gain, 0), COLUMN.FOAM_MAX_GAIN)) : 0;
        return Math.min(255, Math.floor(mass / fill) + gen);
      },
      foamDecay: (x, y, z) => {
        const s = slotOf([x, y, z]), c = g.cores[s];
        if (CLS[L.cid(c)] !== C.LIQUID) return;
        const foam = c[0] >>> 24; if (!foam) return;
        const period = L.cid(c) === E.SALTWATER ? 231 : 152, phase = (g.P.tick + s) % period;
        const loss = Math.floor((phase + 1) * foam / period) - Math.floor(phase * foam / period);
        g.cores[s] = ctx.withAge(c, foam - loss); g.touch(s);
        if (foam - loss) g.markAt(x, y, z);
      },
      noteEvents: () => {},
      colUpwind: (xa, za, xb, zb, y, axis, v) => {
        const d = axis === 0 ? [1, 0] : [0, 1], [ux, uz] = v > 0 ? g.edge([xa - d[0], za - d[1]]) : [xb, zb], p = [ux, y, uz];
        if (p[0] < 0 || p[2] < 0 || p[0] >= g.nx || p[2] >= g.nz) return 0;
        const c = g.cores[slotOf(p)], k = CLS[L.cid(c)];
        if (k !== C.AIR && k !== C.LIQUID) return 0;
        const up = ctx.laneOf(c, axis);
        return up * v > 0 ? up : 0;
      },
      colMarkJet: (x, y, z, axis, v) => {
        const s = slotOf([x, y, z]);
        g.cores[s] = ctx.withLane(ctx.withLane(ctx.zeroQ(g.cores[s]), axis, v), 1, COLUMN.JET_MARK); g.touch(s);
        g.jetBricks[(x >> 2) + g.bx * ((z >> 2) + g.bz * (y >> 2))] = 1;
      },
      colSink: (x, y, z, n, heat) => {
        g.boundary.mass += n; g.boundary.energy += heat;
        const s = slotOf([x, y, z]); if (L.cid(g.cores[s]) === 0) g.events[s] = 0;
      },
      colMarkCrown: (x, y, z, vx, vy, vz) => {
        const s = slotOf([x, y, z]);
        g.cores[s] = ctx.withLane(ctx.withLane(ctx.withLane(ctx.zeroQ(g.cores[s]), 0, vx), 2, vz), 1, COLUMN.JET_MARK - vy); g.touch(s);
        g.jetBricks[g.brickOf(x, y, z)] = 1;
      },
      // seed3/rnd's role: any deterministic hash of position and tick (the twin need not match its bits)
      colCrownAzimuth: (x, y, z) => { let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(g.P.tick, 2654435761) ^ COLUMN.CROWN_SALT; h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); return ((h ^ (h >>> 16)) >>> 8) / 16777216; },
      cos: Math.cos, sin: Math.sin,
      colPending: (x, y, z) => (g.events[slotOf([x, y, z])] & 1) !== 0,
      colDetonate: (x, y, z) => { g.events[slotOf([x, y, z])] |= 1; g.markAt(x, y, z); },
      colAwake: (x, z) => { for (let by = 0; by < g.by; by++) if (g.awake[(x >> 2) + g.bx * ((z >> 2) + g.bz * by)]) return true; return false; },
      colSetDemand: (x, y, z, axis, t, head) => { g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] = (Math.min(t, COLUMN.DEMAND_MAX) | (Math.min(255, Math.max(0, Math.round(head * COLUMN.HEAD_Q))) << 24)) >>> 0; },
      colDemandAt: (x, y, z, axis) => g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] & COLUMN.DEMAND_MAX,
      colSentHeadAt: (x, y, z, axis) => (g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] >>> 24) / COLUMN.HEAD_Q,
      colSetVelocity: (x, y, z, axis, v, head) => { g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] = (new Uint16Array(new Float16Array([v, head]).buffer)[0] | (new Uint16Array(new Float16Array([v, head]).buffer)[1] << 16)) >>> 0; },
      colVelocityAt: (x, y, z, axis) => new Float16Array(new Uint16Array([g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] & 65535]).buffer)[0],
      colFaceHeadAt: (x, y, z, axis) => new Float16Array(new Uint16Array([g.demand[2 * slotOf([x, y, z]) + (axis >> 1)] >>> 16]).buffer)[0],
      colLaunchHead: (xs, zs, xt, zt, rs, y) => {
        let eta = ctx.colEta(rs);
        const fresh = ctx.colAwake(xs, zs);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [nx, nz] = g.edge([xs + dx, zs + dz]);
          if (nx < 0 || nz < 0 || nx >= g.nx || nz >= g.nz || (nx === xt && nz === zt) || !(fresh || ctx.colAwake(nx, nz))) continue;
          for (let k = 0; ; k++) {
            const r = ctx.colRec(nx, k, nz);
            if (y >= ctx.recY0(r) && y < ctx.recTop(r)) {
              if (ctx.recLiq(r) === ctx.recLiq(rs) && ctx.recSub(r) === ctx.recSub(rs) && !ctx.recFalling(r) && y < ctx.recR1(r)) eta = Math.max(eta, ctx.colEta(r));
              break;
            }
            if (ctx.recLast(r)) break;
          }
        }
        return eta;
      },
    };
    for (const name of TRANSLATED) {
      const { args, body } = wgslFunction(code, name);
      // eslint-disable-next-line no-new-func
      ctx[name] = new Function('ctx', ...args, `with (ctx) { ${syntax(body)} }`).bind(null, ctx);
    }
    return ctx;
  }

  /** One tick: activity (the GPU's rule), the runs pass, the four pair dispatches. Returns busy bricks. */
  step() {
    const { bx, by, bz } = this;
    this.tick++; this.P.tick = this.tick;
    // v2activity: awake while busy within the 3³ neighbourhood in the last QUIET_TICKS ticks
    for (let y = 0; y < by; y++) for (let z = 0; z < bz; z++) for (let x = 0; x < bx; x++) {
      let near = false;
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const [X, Y, Z] = this.loop ? [(x + dx + bx) % bx, (y + dy + by) % by, (z + dz + bz) % bz] : [x + dx, y + dy, z + dz];
        if (X >= 0 && Y >= 0 && Z >= 0 && X < bx && Y < by && Z < bz && this.busyIn[X + bx * (Z + bz * Y)]) near = true;
      }
      const b = x + bx * (z + bz * y);
      this.quiet[b] = near ? 0 : Math.min(this.quiet[b] + 1, 255);
      this.awake[b] = this.quiet[b] < 8 ? 1 : 0;
    }
    this.busy.fill(0);
    this.particles();
    for (let b = 0; b < this.nb; b++) if (this.awake[b]) this.summarize(b);
    const cols = [];
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) if (this.ctx.colAwake(x, z)) cols.push([x, z]);
    if (this.P.gravMode !== 2) {
      // v2runs: settle each awake column; read its sleeping neighbours' records (the halo)
      this.onStage?.('v2runs');
      for (const [x, z] of cols) {
        this.ctx.colScan(x, z, true);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = this.edge([x + dx, z + dz]);
          if (this.#inside(n) && !this.ctx.colAwake(n[0], n[1])) this.ctx.colScan(n[0], n[1], false);
        }
      }
      for (const [axis, stage, parity] of pairOrder(this.tick)) {
        Object.assign(this.P, { pairAxis: axis, pairStage: stage, pairParity: parity });
        this.onStage?.('v2pairs');
        for (const [x, z] of cols) this.#pairThread(x, z, axis, stage, parity);
      }
      this.onStage?.('jets');
      this.jets();
    } else if (!this.stillRadial) {
      // radial gravity (columns.js RADIAL): v2runs writes every face's demand, v2pairs stage 0 each column's
      // y faces, the transfer stages the pairs' x and z faces
      this.onStage?.('v2runs');
      for (const [x, z] of cols) this.ctx.colRadRuns(x, z);
      for (const [axis, stage, parity] of pairOrder(this.tick)) {
        Object.assign(this.P, { pairAxis: axis, pairStage: stage, pairParity: parity });
        this.onStage?.('v2pairs');
        for (const [x, z] of cols) this.ctx.colRadPairs(x, z);
      }
    }
    let n = this.parts.length ? 1 : 0; for (const b of this.busy) n += b;
    this.busyIn = Uint8Array.from(this.busy);
    this.quietTicks = n ? 0 : this.quietTicks + 1;
    if (this.quietTicks >= 8 && this.idleAt < 0) this.idleAt = this.tick - 7;
    if (n) this.idleAt = -1;
    return n;
  }
  // v2pairs main (columns.js v2PairsKernel), on a grid without loop edges
  #pairThread(x, z, axis, stage, parity) {
    const ctx = this.ctx, asleep = ([a, b]) => this.#inside([a, b]) && !ctx.colAwake(a, b);
    const ends = (ax) => { const d = ax === 0 ? [1, 0] : [0, 1]; return [this.edge([x + d[0], z + d[1]]), this.edge([x - d[0], z - d[1]])]; };
    if (stage === 0) {
      for (const ax of [0, 2]) {
        const [next, prev] = ends(ax);
        if (this.#inside(next)) ctx.colFluxes(x, z, next[0], next[1], ax);
        if (asleep(prev)) ctx.colFluxes(prev[0], prev[1], x, z, ax);
      }
      return;
    }
    const [next, prev] = ends(axis);
    if (((axis === 0 ? x : z) & 1) === parity) {
      if (this.#inside(next)) ctx.colTransfers(x, z, next[0], next[1], axis);
      if (this.P.edge === 1 && !this.#inside(next)) ctx.colEdges(x, z);
      if (this.P.edge === 1 && !this.#inside(prev)) ctx.colEdges(x, z);
    }
    else if (asleep(prev)) ctx.colTransfers(prev[0], prev[1], x, z, axis);
  }
  #inside([x, z]) { return x >= 0 && z >= 0 && x < this.nx && z < this.nz; }
  // mEdge on a column: wrapped under loop edges, else as it is
  edge([x, z]) { return this.loop ? [((x % this.nx) + this.nx) % this.nx, ((z % this.nz) + this.nz) % this.nz] : [x, z]; }

  // jets.js's count, allocate and spawn: every marked cell of a marked brick, brick by brick, becomes a
  // particle carrying the whole cell but its air carrier; refused (pool or format), it loses its mark
  jets() {
    const ctx = this.ctx;
    for (let b = 0; b < this.nb; b++) {
      if (!this.jetBricks[b]) continue;
      this.jetBricks[b] = 0;
      const bx = b % this.bx, bz = Math.floor(b / this.bx) % this.bz, by = Math.floor(b / (this.bx * this.bz));
      for (let y = by * 4; y < Math.min(this.ny, by * 4 + 4); y++) for (let z = bz * 4; z < Math.min(this.nz, bz * 4 + 4); z++) for (let x = bx * 4; x < Math.min(this.nx, bx * 4 + 4); x++) {
        const i = this.at(x, y, z), c = this.cores[i];
        if (CLS[L.cid(c)] !== C.LIQUID || !L.cFill(c) || !(ctx.laneOf(c, 1) <= COLUMN.JET_MARK)) continue;
        const before = this.material(i), carried = L.energyOf(before) - BigInt(L.FULL) * BigInt(L.cTq(c));
        let m = { core: new Uint32Array([c[0], c[1], 0, (L.payloadOf(c) << 16) >>> 0]), bank: 0 };
        m.bank = Number(BigInt.asIntN(32, carried - L.packetOwnedEnergy(m)));
        const vx = ctx.laneOf(c, 0), vz = ctx.laneOf(c, 2), vy = COLUMN.JET_MARK - ctx.laneOf(c, 1), speed = Math.hypot(vx, vy, vz);
        const empty = { core: new Uint32Array([(c[0] & 0x00ffff00) >>> 0, 0, 0, 0]), bank: before.bank }, rest = L.energyOf(before) - carried;
        this.markAt(x, y, z);
        if (this.parts.length < this.poolCap && speed > 0 && L.packetOwnedEnergy(m) === carried && L.energyFits(empty, rest)) {
          const out = L.withEnergy(empty, rest);
          this.cores[i] = new Uint32Array(out.core); this.banks[i] = out.bank; this.touch(i);
          // jets.js spawn: the cell's decoration flies with it, and the air it leaves holds none
          const deco = this.P.deco ? this.deco[i] : 0; if (this.P.deco) this.deco[i] = 0;
          this.parts.push({ x: x + 0.5 - 0.499 * vx / speed, y: y + 0.5 - 0.499 * vy / speed, z: z + 0.5 - 0.499 * vz / speed, vx: vx / COLUMN.CELL_M, vy: vy / COLUMN.CELL_M, vz: vz / COLUMN.CELL_M, m, deco });
        } else { this.cores[i] = ctx.zeroQ(c); this.touch(i); }
      }
    }
  }
  // R4 flight (the prototype's): ballistic under g, half-cell sub-steps; a particle lands in the cell it is
  // in when the next is neither air nor a thin or unsupported liquid, joining it exactly
  particles() {
    const dt = 1 / COLUMN.TICK_HZ, gc = COLUMN.G_MS2 / COLUMN.CELL_M * this.P.gravity / COLUMN.G_MS2, keep = [];
    const cell = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) ? null : this.cores[this.at(x, y, z)];
    const kind = (c) => (c ? CLS[L.cid(c)] : C.SOLID);
    for (const q of this.parts) {
      q.vy -= gc * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(q.vx, q.vy, q.vz) * dt / 0.5));
      let landed = false;
      for (let k = 0; k < steps && !landed; k++) {
        const nx = q.x + q.vx * dt / steps, ny = q.y + q.vy * dt / steps, nz = q.z + q.vz * dt / steps;
        const [hx, hz] = this.edge([Math.floor(nx), Math.floor(nz)]), hy = Math.floor(ny), he = cell(hx, hy, hz), be = cell(hx, hy - 1, hz);
        const held = kind(be) === C.SOLID || kind(be) === C.POWDER || (kind(be) === C.LIQUID && L.cFill(be) >= L.FULL);
        const thin = kind(he) === C.LIQUID && (L.cFill(he) < L.FULL / 2 || !held);
        if (kind(he) !== C.AIR && !thin) landed = this.#land(q);
        else { q.x = nx; q.y = ny; q.z = nz; if (this.loop) { q.x = ((q.x % this.nx) + this.nx) % this.nx; q.z = ((q.z % this.nz) + this.nz) % this.nz; } }
      }
      // past an open edge a particle leaves the box, into the boundary ledger (the dynamics module's rule)
      const out = q.x < 0 || q.y < 0 || q.z < 0 || q.x >= this.nx || q.y >= this.ny || q.z >= this.nz;
      if (!landed && out && this.P.edge === 1) { this.boundary.mass += L.cFill(q.m.core); this.boundary.energy += L.packetOwnedEnergy(q.m); continue; }
      if (!landed) keep.push(q);
    }
    this.parts = keep;
  }
  #land(q) {
    const x = Math.floor(q.x), y = Math.floor(q.y), z = Math.floor(q.z);
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return false;
    const i = this.at(x, y, z), dst = this.material(i), id = L.cid(dst.core), src = q.m.core;
    if (id !== 0 && (id !== L.cid(src) || this.ctx.liquidSub(dst.core) !== this.ctx.liquidSub(src))) return false;
    const n = L.cFill(src), fill = (id ? L.cFill(dst.core) : 0) + n;
    if (fill > L.MAX_FILL) return false;
    let core = this.ctx.receivedCore(dst.core, src, fill);
    core = L.withPayload({ core, bank: 0 }, Math.min(65535, (id ? L.payloadOf(dst.core) : 0) + L.payloadOf(src))).core;
    const e = L.energyOf(dst) + L.packetOwnedEnergy(q.m), next = { core, bank: dst.bank };
    if (!L.energyFits(next, e)) return false;
    const out = L.withEnergy(next, e);
    // particles.js deposit: landing in air it brings its decoration back; into its own liquid the receiver keeps its
    if (id === 0 && this.P.deco) this.deco[i] = q.deco ?? 0;
    this.cores[i] = new Uint32Array(out.core); this.banks[i] = out.bank; this.touch(i);
    this.markAt(x, y, z); this.landed++;
    return true;
  }
}
