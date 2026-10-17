// CPU-only: the air source's per-brick cache and its request census are exact.
// 1. Writer audit: in the generated WGSL of every native kernel, each store
//    that can change a cell core's x or y word (the id, temperature and the
//    payload the faces, buoyancy and vacuum read) is followed by noteState in
//    its function, and each store of a possibly nonzero request by
//    noteEvents. Writers outside WGSL helpers (restores, window scatters, mode
//    changes, dynamics restores) note every brick.
// 2. An f32 twin of the source's faces/buoyancy/vacuum over real loop/void/
//    solid neighbour topologies: the cached value equals a fresh read of every
//    cell after every tick, bit for bit. Dropping a neighbour side, clearing
//    the notes inside source, or a mode change without notes must break it.
// 3. A twin of the request census and the first blast select over noted
//    bricks only: the same counts, gas sources consumed, wakes and selection
//    as a scan of every cell. A writer that skips noteEvents must break it.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { NativeIntegration } from '../../src/v2/integration.js';
import { V2_KERNELS, v2BlockWGSL, v2BlockClassifyWGSL, nativeDynamicsHead, v2ActLayout } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { particlesWGSL, PARTICLE_STAGES } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES } from '../../src/shaders/v2/blasts.js';
import { airWGSL, AIR_STAGES } from '../../src/shaders/v2/air.js';
import { nativeWeatherCommitWGSL } from '../../src/v2/nativeWeather.js';
import { nativeForceCommitWGSL } from '../../src/v2/nativeForcing.js';
import { PHYS } from '../../src/physics.js';
import { LEGACY_PRESSURE_PA } from '../../src/v2/dynamics-reference.js';
import { EDGE } from '../../src/simModes.js';
import { jetsWGSL, JET_STAGES } from '../../src/shaders/v2/jets.js';

// ---- 1. writer audit
const g = gridLayout(16, 8, 8);
const params = { wgsl: 'struct AuditParams { tick: u32 }', name: 'AuditParams' };
const modules = [
  ...V2_KERNELS.map(k => [k.name, k.code(g)]),
  ['v2block production', v2BlockWGSL(g, contactWGSL, false)], ['v2block compact', v2BlockWGSL(g, contactWGSL, true)],
  ['v2blockClassify', v2BlockClassifyWGSL(g)],
  ...PARTICLE_STAGES.map(s => [`particles ${s}`, particlesWGSL(g, nativeDynamicsHead, s)]),
  ...BLAST_STAGES.map(s => [`blasts ${s}`, blastsWGSL(g, nativeDynamicsHead, s)]),
  ...AIR_STAGES.map(s => [`air ${s}`, airWGSL(g, nativeDynamicsHead, s)]),
  ...JET_STAGES.map(s => [`jets ${s}`, jetsWGSL(g, s)]),
  ...['material', 'sourcePlan', 'air'].map(s => [`weather ${s}`, nativeWeatherCommitWGSL(g, params, s)]),
  ...['plan', 'particles'].map(s => [`forcing ${s}`, nativeForceCommitWGSL(g, params, s)]),
];
const functions = code => code.replace(/\/\/[^\n]*/g, '').split(/\n(?=fn |@compute)/);
let coreWrites = 0, requestWrites = 0;
function audit(name, code) { for (const fn of functions(code)) {
  if (/\bvar cells\s*:/.test(fn)) continue; // contact's private per-block arrays
  for (const m of fn.matchAll(/(atomicStore\(&)?\bcells\[[^\]]*\](?:\.([xyzw]))?\s*(=(?!=)|,)/g)) {
    if (!m[1] && m[3] === ',') continue;
    const lane = m[2] ?? 'xyzw';
    if (!/[xy]/.test(lane)) continue; // face flux lanes: no cached value reads z or w
    if (/^fn storeCore\(/.test(fn)) { coreWrites++; continue; } // storeCell/storeMaterial note it
    assert.ok(fn.slice(m.index).includes('noteState('), `${name}: a core write without noteState: ${fn.slice(m.index, m.index + 80)}`);
    coreWrites++;
  }
  for (const m of fn.matchAll(/\bevents\[[^\]]*\]\s*(\|=|&=|=(?!=))\s*([^;]*);/g)) {
    if (m[1] === '&=' || m[2].trim() === '0u') continue; // clears keep "unnoted means zero"
    assert.ok(fn.slice(m.index).includes('noteEvents('), `${name}: a request store without noteEvents: ${m[0]}`);
    requestWrites++;
  }
} }
for (const [name, code] of modules) audit(name, code);
// Air stores: only the air tick's source and substeps settle or list what they write (the
// source sets the live word, reach notes every brick the substeps reach); every other store
// of a brick's air notes it (noteAir) in the same function.
let airWrites = 0;
function auditAir(name, code) { for (const fn of functions(code)) {
  for (const m of fn.matchAll(/\b(air|airOut)\[[^\]]*\](?:\.[a-z]+(?:\.[a-z]+|\[[^\]]*\])?)?\s*([-+*\/]?=)(?!=)/g)) {
    if (name === 'air source' || name === 'air step') continue;
    assert.ok(fn.includes('noteAir('), `${name}: an air store without noteAir: ${fn.slice(m.index, m.index + 60)}`);
    airWrites++;
  }
} }
for (const [name, code] of modules) auditAir(name, code);
assert.ok(airWrites >= 4, `the audit sees the air writers (${airWrites})`);
assert.throws(() => auditAir('red air', 'fn red() {\n  air[b].vp.w = 1.0;\n}'), /without noteAir/);
// red: the audit itself catches an unnoted core or request store
assert.throws(() => audit('red core', 'fn red() {\n  cells[s].y = 7u;\n}'), /without noteState/);
assert.throws(() => audit('red request', 'fn red() {\n  events[s] = request;\n}'), /without noteEvents/);
assert.ok(coreWrites >= 6 && requestWrites >= 3, `the audit sees the writers (${coreWrites} core, ${requestWrites} request)`);
// Writers behind the helpers note every brick (the integration, the restores, modes, a dynamics restore).
const notes = f => /noteAllCells/.test(f.toString());
for (const [what, f] of [['restore', PhysicsV2.prototype.restore], ['restoreState', PhysicsV2.prototype.restoreState],
  ['mode change', PhysicsV2.prototype._noteModes], ['window scatter', NativeIntegration.prototype.changed],
  ['dynamics restore', NativeDynamics.prototype.restoreDynamicState]]) assert.ok(notes(f), `${what} must note every brick`);
assert.match(NativeDynamics.prototype.restoreDynamicState.toString(), /noteAllCells\?\.\(\{events:true\}\)/);
// The generated protocol the twins below follow.
const source = airWGSL(g, nativeDynamicsHead, 'source'), reach = airWGSL(g, nativeDynamicsHead, 'reach');
assert.match(source, /var stale=atomicLoad\(&act2\[V2_STATE_DIRTY\+t\]\)!=0u;\s*for \(var axis=0u;axis<3u;axis\+\+\) \{ for \(var side=-1;side<=1;side\+=2\) \{\s*let q=aNeighbor\(t,axis,side\); if \(q!=D_NONE && atomicLoad\(&act2\[V2_STATE_DIRTY\+q\]\)!=0u\) \{ stale=true; \}/);
assert.match(source, /if \(atomicLoad\(&act2\[V2_EVENTS\+t\]\)!=0u\) \{/);
assert.match(source, /if \(pending==0u\) \{ atomicStore\(&act2\[V2_EVENTS\+t\],0u\); \}/);
assert.doesNotMatch(source.slice(source.lastIndexOf('@compute')), /atomic(Store|And|Exchange)\(&act2\[V2_STATE_DIRTY/, 'source never clears a note its neighbours still read');
assert.match(reach, /if \(axis==0u && atomicLoad\(&act2\[V2_STATE_DIRTY\+t\]\)!=0u\) \{ atomicStore\(&act2\[V2_STATE_DIRTY\+t\],0u\); \}/);
assert.match(blastsWGSL(g, nativeDynamicsHead, 'select'), /atomicLoad\(&act2\[V2_EVENTS\+t\/64u\]\) == 0u \|\| events\[t\] == 0u/);
const A = v2ActLayout(g);
assert.ok(A.events >= A.words && A.air === A.events + g.nbricks && A.allocated >= A.air + g.nbricks, 'the request and air notes sit after the saved activity words');

// ---- 2. the faces / buoyancy / vacuum cache
const fr = Math.fround;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const AIR = 0, SOLID = 1, GAS = 4, SING = 2; // twin classes; SING is a solid with vacuum mass in y
function box(dims) {
  const n = dims.map(b => b * 4), nb = dims[0] * dims[1] * dims[2];
  const brickOf = p => (p[0] >> 2) + dims[0] * ((p[1] >> 2) + dims[1] * (p[2] >> 2));
  const slot = p => brickOf(p) * 64 + (p[0] & 3) + 4 * ((p[1] & 3) + 4 * (p[2] & 3));
  const cellOf = s => { const b = Math.floor(s / 64), l = s % 64; return [(b % dims[0]) * 4 + (l & 3), (Math.floor(b / dims[0]) % dims[1]) * 4 + ((l >> 2) & 3), Math.floor(b / (dims[0] * dims[1])) * 4 + (l >> 4)]; };
  const inGrid = p => p.every((x, a) => x >= 0 && x < n[a]);
  const edge = (p, mode) => mode === EDGE.LOOP ? p.map((x, a) => ((x % n[a]) + n[a]) % n[a]) : p;
  return { dims, n, nb, brickOf, slot, cellOf, inGrid, edge };
}
const axis = a => [0, 1, 2].map(i => +(i === a));
const add = (p, d, k = 1) => p.map((x, i) => x + d[i] * k);
function derive(B, cells, b, modes) {
  const base = B.cellOf(b * 64).map(x => x & ~3);
  const cls = p => cells[B.slot(p)].cls;
  const open = p => { const q = B.edge(p, modes.edge); return B.inGrid(q) ? [AIR, GAS].includes(cls(q)) : modes.edge === EDGE.VOID; };
  const faces = [0, 0, 0];
  for (let a = 0; a < 3; a++) { const u = (a + 1) % 3, v = (a + 2) % 3;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const p = add(base, axis(a), 3); p[u] += i; p[v] += j;
      if (open(p) && open(add(p, axis(a)))) faces[a] = fr(faces[a] + fr(1 / 16)); } }
  const vac = c => c.cls === SING ? fr(fr(Math.max(PHYS.P_MIN, fr(fr(-PHYS.SING_P_PER_MASS * c.mass) / 256))) * LEGACY_PRESSURE_PA) : 0;
  let vacuum = 0, buoyancy = 0;
  for (let s = b * 64; s < b * 64 + 64; s++) {
    const c = cells[s]; vacuum = Math.min(vacuum, vac(c));
    if (c.cls === GAS) buoyancy = fr(buoyancy + fr(fr(fr(fr(c.tq * 0.25) - 273.25) - modes.ambient) / 64));
    if (c.cls === AIR || c.cls === GAS) { const p = B.cellOf(s);
      for (let a = 0; a < 3; a++) { const local = p[a] & 3; if (local !== 0 && local !== 3) continue;
        const q = add(p, axis(a), local === 3 ? 1 : -1); if (B.inGrid(q)) vacuum = Math.min(vacuum, fr(fr(PHYS.SING_RING) * vac(cells[B.slot(q)]))); } }
  }
  return new Uint32Array(new Float32Array([...faces, buoyancy, vacuum]).buffer).join();
}
// aNeighbor: the face neighbour brick in step's topology (mEdge), or none.
const neighbors = (B, b, modes, sides) => {
  const base = B.cellOf(b * 64).map(x => x & ~3), out = [];
  for (let a = 0; a < 3; a++) for (const side of sides) { const q = B.edge(add(base, axis(a), 4 * side), modes.edge); if (B.inGrid(q)) out.push(B.brickOf(q)); }
  return out;
};
function cacheRun(seed, dims, variant = {}) {
  const random = rng(seed), B = box(dims), modes = { edge: [EDGE.SOLID, EDGE.VOID, EDGE.LOOP][seed % 3], ambient: 20 };
  // rare, light singularities: a brick's vacuum then often comes from a neighbour's ring
  const cell = () => { const r = random(), cls = r < 0.45 ? AIR : r < 0.7 ? GAS : r < 0.97 ? SOLID : SING;
    return { cls, tq: Math.floor(random() * 4000), mass: Math.floor(random() * 5000) }; };
  const cells = Array.from({ length: B.nb * 64 }, cell), notes = new Uint8Array(B.nb).fill(1), cache = new Array(B.nb).fill(null);
  const sides = variant.sides ?? [-1, 1];
  for (let tick = 0; tick < 12; tick++) {
    // writes between a reach pass and the next source: cells (noted), sometimes a mode
    // sparse ticks expose a missed neighbour; dense ones churn whole bricks
    for (let k = random() < 0.6 ? 1 : Math.floor(random() * 24); k > 0; k--) { const s = Math.floor(random() * cells.length); cells[s] = cell(); notes[Math.floor(s / 64)] = 1; }
    if (random() < 0.15) { modes.ambient = Math.floor(random() * 60); if (!variant.silentModes) notes.fill(1); }
    for (let b = 0; b < B.nb; b++) {
      const stale = notes[b] || neighbors(B, b, modes, sides).some(q => notes[q]);
      if (stale) cache[b] = derive(B, cells, b, modes);
      if (variant.clearInSource) notes[b] = 0;
    }
    notes.fill(0); // reach, axis 0
    for (let b = 0; b < B.nb; b++) if (cache[b] !== derive(B, cells, b, modes)) return false;
  }
  return true;
}
const shapes = [[3, 2, 2], [2, 3, 2], [4, 2, 3], [1, 1, 3]];
let cacheRuns = 0;
for (let seed = 1; seed <= 24; seed++) for (const dims of shapes) { assert.ok(cacheRun(seed, dims), `cached faces drifted: seed ${seed}, dims ${dims}`); cacheRuns++; }
for (const [what, variant] of [['+ sides only', { sides: [1] }], ['no neighbours', { sides: [] }], ['notes cleared inside source', { clearInSource: true }], ['a silent mode change', { silentModes: true }]]) {
  let broke = false;
  for (let seed = 1; seed <= 24 && !broke; seed++) for (const dims of shapes) if (!cacheRun(seed, dims, variant)) { broke = true; break; }
  assert.ok(broke, `${what} must break the cache`);
}

// ---- 3. the request census (source) and the first select over noted bricks only
function censusRun(seed, variant = {}) {
  const random = rng(seed), B = box([3, 3, 2]), slots = B.nb * 64;
  const events = new Uint32Array(slots), flags = new Uint8Array(B.nb);
  const note = (s, v) => { if (v && !variant.forget) flags[Math.floor(s / 64)] = 1; };
  for (let tick = 0; tick < 16; tick++) {
    // block pass: a 2x2x2 block at an odd offset spans up to eight bricks
    for (let k = Math.floor(random() * 3); k > 0; k--) {
      const c0 = [0, 1, 2].map(a => 1 + 2 * Math.floor(random() * (B.n[a] / 2 - 1)));
      for (let i = 0; i < 8; i++) { const p = add(c0, [i & 1, (i >> 2) & 1, (i >> 1) & 1]); const s = B.slot(p);
        const v = random() < 0.3 ? 1 << Math.floor(random() * 3) : events[s]; events[s] = v; note(s, v); }
    }
    // column fall: a request moves down its column with the material
    if (random() < 0.5) { const p = [Math.floor(random() * B.n[0]), 1 + Math.floor(random() * (B.n[1] - 1)), Math.floor(random() * B.n[2])];
      const q = [p[0], Math.floor(random() * p[1]), p[2]], sp = B.slot(p), sq = B.slot(q), request = events[sp], below = events[sq];
      events[sp] = below; note(sp, below); events[sq] = request; note(sq, request); }
    // blasts serve and clear bits; nothing notes a clear
    for (let s = 0; s < slots; s++) if (events[s] && random() < 0.1) events[s] &= ~(1 << Math.floor(random() * 3));
    // first select: a scan of every slot vs noted bricks only
    const select = only => { let pending = 0, lowest = -1; const wakes = new Set();
      for (let s = 0; s < slots; s++) { if ((only && !flags[Math.floor(s / 64)]) || !events[s]) continue; pending++; wakes.add(s); if ((events[s] & 1) && lowest < 0) lowest = s; }
      return JSON.stringify([pending, lowest, [...wakes]]); };
    if (select(false) !== select(true)) return false;
    // air source: gas sources consumed, census, unnoting empty bricks
    const census = (words, only) => { let count = 0, pending = 0; const wakes = [], flagged = flags.slice();
      for (let b = 0; b < B.nb; b++) { if (only && !flagged[b]) continue; let left = 0;
        for (let s = b * 64; s < b * 64 + 64; s++) { if (words[s] & 2) { count++; words[s] &= ~2; } if (words[s]) { left++; pending++; wakes.push(s); } }
        if (only && left === 0) flagged[b] = 0; }
      return { key: JSON.stringify([count, pending, wakes, Array.from(words)]), flagged }; };
    const full = census(events.slice(), false), noted = census(events, true);
    if (full.key !== noted.key) return false;
    flags.set(noted.flagged);
  }
  return true;
}
for (let seed = 1; seed <= 40; seed++) assert.ok(censusRun(seed), `census over noted bricks differs: seed ${seed}`);
let forgot = false; for (let seed = 1; seed <= 40 && !forgot; seed++) forgot = !censusRun(seed, { forget: true });
assert.ok(forgot, 'a request store without noteEvents must break the census');
console.log(`air cache: ${coreWrites} core, ${requestWrites} request and ${airWrites} outside air stores noted across ${modules.length} modules; ${cacheRuns} f32 cache runs exact over 12 ticks; census and select exact over 40 runs; 7 red variants caught`);
