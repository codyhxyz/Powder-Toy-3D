// CPU-only: one blast batch a tick (dynamics.js consumeMaterialEvents) serves every serviceable charge of
// the lowest blastBatch bricks together (a source a brick; V1 react.js has no cap). 1. The generated
// selection (pick's dPickSources, run here as JS) takes exactly the K lowest bricks holding marks, in brick
// order, with their masks, and clears the masks. 2. Replaying the real driver's recording over an abstract
// world of charges, tick after tick: every charge of a picked brick goes off that tick (a 64-charge pile in
// one tick, not eight a tick), nothing dropped when more than K bricks are queued, and a chain the block pass
// sets off resolves a tick a step. 3. The damage is V1's (dynamics-reference.js chargeBatchDamage, the CPU
// twin of planCharges/damageCharges): a solid breaks by V1's front against hard·P_BREAK_PER_HARD, not by an
// energy share; the front goes through the explosives it sets off for V1's steps a tick; a flame chain lights
// at V1's odds; charges are as strong as their blast.P. 4. An idle tick records 17 blast dispatches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { blastsWGSL, listsStageWGSL, listControl, RESET_SELECTION, CHARGES_MAX, SOURCE_WORDS } from '../../src/shaders/v2/blasts.js';
const NONE = 0xffffffff, BATCH_DEFAULT = 64;
// Straight-line integer WGSL with loops → JS (atomics as plain words).
const js = code => code.replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1')
  .replace(/var (\w+): array<u32, \d+>;/g, 'var $1=new Array(64).fill(0);')
  .replace(/atomicExchange\(&control\[([^\]]+)\],([^)]+)\)/g, 'xchg(control,$1,$2)')
  .replace(/atomicLoad\(&control\[([^\]]+)\]\)/g, 'control[$1]')
  .replace(/atomicStore\(&control\[([^\]]+)\],([^;]+)\);/g, 'control[$1]=$2;')
  .replace(/\bmin\(/g, 'Math.min(');
const body = code => { const s = code.trimEnd(), one = s.lastIndexOf('fn main() {');
  return one >= 0 ? s.slice(one + 'fn main() {'.length, -1) : s.slice(s.lastIndexOf('@compute')); };
const helpers = { select: (no, yes, c) => (c ? yes : no), xchg: (a, i, v) => { const o = a[i]; a[i] = v; return o; },
  firstTrailingBit: x => 31 - Math.clz32(x & -x) };
function runner(code, constants) {
  const names = Object.keys(constants);
  return Function('control', 'args', 'P', 'D_NONE', 'select', 'xchg', 'firstTrailingBit', ...names, js(body(code)));
}
function recorder() {
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
  const commands = [];
  const copy = (b, offset, src) => new Uint8Array(b.bytes).set(new Uint8Array(src.buffer ?? src, src.byteOffset ?? 0, src.byteLength), offset);
  const gpu = {
    createBuffer(d) { return { ...d, bytes: new ArrayBuffer(d.size), destroy() {} }; },
    queue: { writeBuffer: copy }, write: copy, layout: (name, entries) => ({ name, entries }),
    bindGroup: (layout, entries) => ({ layout, entries }),
    kernel(d) { return { ...d, ready: Promise.resolve(), dispatch(frame, size, data) {
      d.params.pack(data.params); // strict uniform packing of every recorded field
      commands.push({ stage: d.name.replace(/^v2(blasts|lists)_/, ''), code: d.code, size, params: data.params });
    } }; },
    frame: { clear() {}, copy(src, so, dst, dof, n) { commands.push({ copy: [src, so, dst, dof, n] }); } },
    readback: { buffer: (b, o, n) => Promise.resolve(b.bytes.slice(o, o + n)) },
  };
  const g = gridLayout(16, 8, 8), owner = { gpu, g, tick: 3, epoch: 0, sim: { origin: [0, 0, 0], header: () => ({}) },
    nativeDynamics: { head: nativeDynamicsHead, layout: { entries: V2_DYNAMICS_LAYOUT }, group: {} }, wake() {}, _params: () => ({ busyIn: 1, busyOut: 2 }) };
  owner.events = gpu.createBuffer({ size: g.slots * 4 });
  return { g, owner, commands };
}
const { g, owner, commands } = recorder();
const d = owner.dynamics = new NativeDynamics(owner); await d.ready;
const L = listControl(g), C = L.charges;
const constants = { LIST_EVENTS: L.lists.events, D_SERVE_MASKS: C.masks, D_CHARGES: C.slots, D_CHARGE_COUNT: C.count, D_CHARGES_MAX: CHARGES_MAX,
  D_SOURCE_INFO: C.info, D_SOURCE_OF: C.sourceOf, D_SOURCE_WORDS: SOURCE_WORDS };
// pick's selection, dPickSources, executed (the lanes after it read cells: the CPU twin covers them)
const pickCode = blastsWGSL(g, nativeDynamicsHead, 'pick');
function selectionBody(code) { const at = code.indexOf('fn dPickSources() -> u32 {'); let depth = 0, i = code.indexOf('{', at), start = i;
  for (; ; i++) { if (code[i] === '{') depth++; if (code[i] === '}' && --depth === 0) break; } return code.slice(start + 1, i); }
const pick = Function('control', 'args', 'P', 'D_NONE', 'select', 'xchg', 'firstTrailingBit', ...Object.keys(constants), js(selectionBody(pickCode)));
const runPick = (control, K) => pick(control, null, { substep: K }, NONE, helpers.select, helpers.xchg, helpers.firstTrailingBit, ...Object.values(constants));
// a picked source's charges: its brick's two mask words (pick copies them into the source's words)
const sourceSlots = (control, k) => { const b = control[C.slots + k], out = [];
  for (let l = 0; l < 64; l++) if ((control[C.info + k * SOURCE_WORDS + (l >> 5)] >>> (l & 31)) & 1) out.push(b * 64 + l); return out; };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

test('the generated selection takes the K lowest marked bricks in brick order, each with all its charges, and clears the masks', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = rng(seed), control = new Uint32Array(L.words), marked = new Map();
    const bricks = [...new Set(Array.from({ length: 1 + Math.floor(random() * 12) }, () => Math.floor(random() * g.nbricks)))];
    control[L.lists.events] = bricks.length; bricks.forEach((b, i) => { control[L.lists.events + 2 + i] = b; });
    for (const b of bricks) for (let l = 0; l < 64; l++) if (random() < 0.15) { const s = b * 64 + l; if (!marked.has(b)) marked.set(b, []); marked.get(b).push(s); control[C.masks + 2 * b + (l >> 5)] |= 1 << (l & 31); }
    const K = [1, 3, 8, 64][seed % 4], expected = [...marked.keys()].sort((a, b) => a - b).slice(0, K);
    runPick(control, K);
    assert.equal(control[C.count], expected.length);
    assert.deepEqual(Array.from(control.subarray(C.slots, C.slots + expected.length)), expected);
    expected.forEach((b, k) => { assert.deepEqual(sourceSlots(control, k), marked.get(b), 'every charge of the brick'); assert.equal(control[C.sourceOf + b], k + 1); });
    assert.equal(control[3], expected.length ? marked.get(expected[0])[0] : NONE);
    for (const b of bricks) assert.equal(control[C.masks + 2 * b] | control[C.masks + 2 * b + 1], 0, 'masks cleared for the next tick');
  }
});

// The driver's recording replayed over charges {slot, ready tick, armed}: select marks the ready ones,
// pick (generated) takes the batch, finishCharges serves it; a served chain link arms the next one,
// whose request the next tick's block pass makes (so it is ready the tick after).
function serve(world, ticks, K) {
  d.blastBatch = K; const served = [];
  const control = new Uint32Array(d.control.bytes), args = new Uint32Array(d.dispatchArgs.bytes);
  for (let tick = 0; tick < ticks; tick++) {
    commands.length = 0; d.consumeMaterialEvents(tick); const now = [];
    for (const c of commands) {
      if (c.stage === 'reset') runner(c.code, {})(control, args, c.params, NONE, helpers.select, helpers.xchg, helpers.firstTrailingBit);
      else if (c.stage === 'eventList') { const bricks = [...new Set(world.filter(w => w.ready <= tick && !w.done).map(w => w.slot >> 6))];
        control[L.lists.events + 1] = bricks.length; bricks.forEach((b, i) => { control[L.lists.events + 2 + i] = b; }); }
      else if (c.stage === 'events') { control[L.lists.events] = control[L.lists.events + 1]; control[L.lists.events + 1] = 0; }
      else if (c.stage === 'select') for (const w of world) { if (w.ready <= tick && !w.done) control[C.masks + 2 * (w.slot >> 6) + ((w.slot & 63) >> 5)] |= 1 << (w.slot & 31); }
      else if (c.stage === 'pick') runPick(control, c.params.substep);
      else if (c.stage === 'workArgs') runner(c.code, {})(control, args, c.params, NONE, helpers.select, helpers.xchg, helpers.firstTrailingBit);
      else if (c.stage === 'finishCharges' && args[8] * args[9] * args[10]) {
        for (let k = 0; k < control[C.count]; k++) for (const slot of sourceSlots(control, k)) { const w = world.find(x => x.slot === slot);
          assert.ok(w, `picked slot ${slot} is a queued charge (${world.map(x => x.slot)})`); w.done = true; now.push(w.slot);
          if (w.arms !== undefined) world.find(x => x.slot === w.arms).ready = tick + 1; }
        for (let k = 0; k < control[C.count]; k++) control[C.sourceOf + control[C.slots + k]] = 0;
        now.sort((a, b) => a - b);
      }
    }
    served.push(now);
  }
  return served;
}
// What the batch should serve: every ready charge of the K lowest bricks holding one, a tick.
function servedBricks(world, ticks, K) {
  const out = [];
  for (let tick = 0; tick < ticks; tick++) {
    const ready = world.filter(x => x.ready <= tick && !x.done), bricks = [...new Set(ready.map(x => x.slot >> 6))].sort((a, b) => a - b).slice(0, K);
    const now = ready.filter(x => bricks.includes(x.slot >> 6)).sort((a, b) => a.slot - b.slot);
    for (const w of now) { w.done = true; if (w.arms !== undefined) world.find(x => x.slot === w.arms).ready = tick + 1; }
    out.push(now.map(w => w.slot));
  }
  return out;
}
const charges = (slots, chain = false) => slots.map((slot, i) => ({ slot, ready: chain && i ? Infinity : 0, done: false, ...(chain && i + 1 < slots.length ? { arms: slots[i + 1] } : {}) }));
test('every charge of the lowest bricks a tick: a pile goes off at once (V1 react.js: no cap)', () => {
  for (const [seed, M, K] of [[1, 3, 1], [2, 8, 2], [3, 13, 8], [4, 30, BATCH_DEFAULT], [5, 200, BATCH_DEFAULT]]) {
    const random = rng(seed), slots = [...new Set(Array.from({ length: M }, () => Math.floor(random() * g.slots)))];
    const now = serve(charges(slots), 6, K), expected = servedBricks(charges(slots), 6, K);
    assert.deepEqual(now, expected, `charges served per tick: ${slots.length} queued, ${K} bricks a tick`);
  }
  // 64 charges in 16 bricks, and every cell of the grid's 16 bricks: one tick each (the old batch: eight a tick)
  const pile = serve(charges(Array.from({ length: 64 }, (_, i) => i * 16)), 3, BATCH_DEFAULT);
  assert.deepEqual(pile.map(t => t.length), [64, 0, 0], 'a 64-charge pile goes off in one tick');
  const block = serve(charges(Array.from({ length: g.slots }, (_, i) => i)), 3, BATCH_DEFAULT);
  assert.deepEqual(block.map(t => t.length), [g.slots, 0, 0], `a ${g.slots}-cell block of charges goes off in one tick`);
});
test('nothing is dropped when more bricks than a batch are queued: each charge once, the rest the next tick', () => {
  const slots = Array.from({ length: g.nbricks }, (_, i) => 3 + i * 64), served = serve(charges(slots), 4, 6);
  assert.deepEqual(served.map(t => t.length), [6, 6, 4, 0]);
  assert.deepEqual(served.flat().sort((a, b) => a - b), slots, 'every charge served exactly once');
});
test('a chain the block pass sets off spreads a tick a step: a charge set off this tick waits for the next', () => {
  const slots = [40, 41, 42, 43, 44], served = serve(charges(slots, true), 6, BATCH_DEFAULT);
  assert.deepEqual(served, [[40], [41], [42], [43], [44], []]);
});

test('a lone charge: the old plan\'s expressions, in the old order, from its own cell', () => {
  const plan = blastsWGSL(g, nativeDynamicsHead, 'plan'), now = blastsWGSL(g, nativeDynamicsHead, 'planCharges');
  for (const expression of ['let r2 = max(0.25,dot(delta,delta));', '/ (12.566370614359*r2);', 'received >= 0.01'])
    assert.ok(plan.includes(expression) && now.includes(expression), expression);
  assert.match(plan, /plan\.velocity = normalize\(delta\+vec3f\(0\.000001\)\)\*received;/);
  assert.match(now, /return normalize\(delta\+vec3f\(0\.000001\)\)\*received;/);
  // a source's share is from its charges' mean cell (one charge: that cell, exactly: Σ/1), in its sight and reach
  assert.match(now, /let delta=vec3f\(p\)-dSrcCentre\(k\);/);
  assert.match(pickCode, /let centre=vec3f\(base\)\+sum\/max\(count,1\.0\);/);
  assert.match(now, /if \(eligible && dSrcSteps\(k,p\)<=dSrcReach\(k\) && dSrcLine\(k,p,false\)\) \{ velocity=dSrcShare\(k,p\); \}/);
  assert.match(now, /if \(k==0u\) \{ plan\.velocity=velocity; \}/);
  assert.match(now, /if \(live\) \{ if \(n!=1u\) \{ plan\.velocity=vec3f\(0\); \} plans\[t\] = plan; \}/);
  assert.match(now, /wgEnergy\[li\]=length\(velocity\); workgroupBarrier\(\);/);
  assert.match(now, /var energy=0\.0; for \(var lane=0u;lane<64u;lane\+\+\) \{ energy \+= wgEnergy\[lane\]; \}/);
  const norm = blastsWGSL(g, nativeDynamicsHead, 'normalizeCharges');
  assert.match(blastsWGSL(g, nativeDynamicsHead, 'normalize'), /scale=min\(1\.0,budget\*0\.5\/max\(sum,0\.000001\)\);/);
  assert.match(norm, /let scale=min\(1\.0,budget\*0\.5\/max\(sum,0\.000001\)\);/);
  // plan writes a source's sums only where normalize reads them: the bricks within its reach
  assert.ok(now.includes('wgNear=select(0u,1u,brick<D_BRICKS && dSrcNearBrick(k,brick));') && norm.includes('if (!dSrcNearBrick(k,b)) { continue; }'));
  const damage = blastsWGSL(g, nativeDynamicsHead, 'damageCharges');
  assert.match(damage, /var energy=length\(plan\.velocity\)\*bitcast<f32>\(atomicLoad\(&control\[6\]\)\);/);
  assert.match(damage, /select\(normalize\(plan\.velocity\),normalize\(combined\+vec3f\(0\.000001\)\),n>1u\)/);
});
test('an idle tick records 17 blast dispatches, not 115, and no copies', () => {
  commands.length = 0; d.blastBatch = BATCH_DEFAULT; d.consumeMaterialEvents(9);
  assert.equal(commands.filter(c => !c.copy).length, 17); assert.equal(commands.filter(c => c.copy).length, 0);
  assert.equal(body(blastsWGSL(g, nativeDynamicsHead, 'reset')).trim(), RESET_SELECTION);
  assert.match(listsStageWGSL(g, 'workArgs'), /let hasWork=control\[3\]!=D_NONE/);
});
// V1 react.js setOff: a charge adds its blast.P as it goes off, and the explosive beside it, under more than
// its crushP, goes off rather than move ("a hit or pressure that sets it off wins over breaking it"). So the
// batch's pressure enters the air before its damage plans, and damage sets such an explosive off in place
// instead of throwing it (its ejecta in flight: tools/v2/airborne-react-check.mjs 9b').
test('the batch\'s pressure is in the air before its damage, which sets an explosive past its crushP off in place', () => {
  commands.length = 0; d.blastBatch = BATCH_DEFAULT; d.consumeMaterialEvents(11);
  const order = commands.filter(c => !c.copy).map(c => c.stage);
  const at = name => order.indexOf(name);
  assert.ok(at('normalizeCharges') < at('damageCharges') && at('damageCharges') < at('apply') && at('apply') < at('finishCharges'), order.join(' '));
  const norm = body(blastsWGSL(g, nativeDynamicsHead, 'normalizeCharges'));
  const finish = body(blastsWGSL(g, nativeDynamicsHead, 'finishCharges'));
  const damage = body(blastsWGSL(g, nativeDynamicsHead, 'damageCharges'));
  assert.match(finish, /if \(!dChargeServed\(s,before\)\) \{ continue; \}/);
  assert.ok(!/air\[/.test(finish), 'finishCharges adds no pressure of its own');
  // the pressure: a quarter of the source's energy acoustic, its brick raised at most to V1's P_MAX (react.js clamp)
  assert.match(norm, /let addedP2=2\.0\*[\d.e+]+\*budget\*0\.25\/[\d.e+]+;\n\s*if\(mAirPressure\(\)\) \{ a\.vp\.w=max\(a\.vp\.w,min\(sqrt\(a\.vp\.w\*a\.vp\.w\+addedP2\),([\d.e+]+)\)\); \}/);
  const cap = Number(norm.match(/addedP2\),([\d.e+]+)\)\)/)[1]);
  assert.ok(Math.abs(cap - PHYS.P_MAX * LEGACY_PRESSURE_PA) < 1e-6 * cap, `the cap is P_MAX: ${cap}`);
  // damage: past its crushP (the air's, or V1's front from the sources), set off and not planned to break or fly, before either
  const setOff = damage.indexOf('if (open && dCrush(id)>0.0 && mAirPressure() && (front>dCrush(id) || (energy>0.0 && dPressureOn(p,k)>dCrush(id)))) {');
  assert.ok(setOff > 0 && setOff < damage.indexOf('var kinetic=energy;'), 'the set-off comes before the break and the throw');
  assert.ok(damage.includes('events[t]|=1u; noteEvents(t,events[t]); dWake(p); plan.velocity=vec3f(0); plans[t]=plan; return;'));
  // BL-1: a solid breaks by V1's front against its strength (hard·P_BREAK_PER_HARD), never by an energy share
  assert.ok(damage.includes('front>dStrength(id)') && !damage.includes('dToughness('), 'damage breaks by pressure, not by energy against toughness');
});

// V1 react.js air pressure: each open cell takes max(its diffusion, P_FRONT of its strongest open neighbour),
// P_DECAY of it, a step; a charge going off adds its blast.P to its cell's (to P_MAX); an explosive goes off
// under more than its crushP, its own or an open neighbour's (setOff, pOn). Stepped here as V1 runs it, on a
// 3D grid of open air (walls reflect: a solid neighbour reads the cell's own), for each charge and target.
import { V1_FRONT, v1FrontOn, v1FrontSource, frontPerRootJ, dynamicsRows, LEGACY_PRESSURE_PA, chargeBatchDamage, blastPlan, addBlastPressure, specialBlastEnergy,
  v1FlameChainOdds, v1BlastReach, BLAST_REACH_MAX, BLAST_CHAIN_STEPS } from '../../src/v2/dynamics-reference.js';
import { LEGACY_STEPS_PER_TICK } from '../../src/v2/host.js';
import { ELEMENTS, E } from '../../src/elements.js';
import { PHYS } from '../../src/physics.js';
function v1Reach(source, crush, dir) {
  const N = 41, c = 20, at = (x, y, z) => x + N * (y + N * z), inside = v => v >= 0 && v < N;
  let P = new Float32Array(N ** 3); P[at(c, c, c)] = Math.min(PHYS.P_MAX, source);
  let reach = 0; const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let step = 1; step < 40; step++) {
    const next = new Float32Array(N ** 3);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const own = P[at(x, y, z)]; let lap = 0, front = 0;
      for (const [a, b, e] of faces) { const q = [x + a, y + b, z + e]; const pn = q.every(inside) ? P[at(...q)] : own; lap += pn - own; front = Math.max(front, pn); }
      next[at(x, y, z)] = Math.min(PHYS.P_MAX, Math.max(own + PHYS.P_DIFFUSE * lap, front * PHYS.P_FRONT) * PHYS.P_DECAY);
    }
    P = next;
    // the farthest cell along dir whose pOn (own or an open neighbour's) is over crush this step
    for (let d = 1; d < 20; d++) { const p = dir.map((u, a) => c + u * d); if (!p.every(v => inside(v) && inside(v - 1) && inside(v + 1))) break;
      let on = P[at(...p)]; for (const [a, b, e] of faces) on = Math.max(on, P[at(p[0] + a, p[1] + b, p[2] + e)]);
      if (on > crush) reach = Math.max(reach, dir.reduce((n, u) => n + Math.abs(u), 0) * d); }
  }
  return reach;
}
test('V1\'s pressure front, stepped as V1 runs it, reaches as far as its closed form (v1FrontOn), by taxicab steps', () => {
  assert.equal(V1_FRONT.KEEP, PHYS.P_FRONT * PHYS.P_DECAY);
  const closed = (source, crush) => { let d = 1; while (v1FrontOn(source, d) > crush) d++; return d - 1; };
  for (const [src, tgt] of [['NITRO', 'NITRO'], ['C4', 'NITRO'], ['TNT', 'NITRO'], ['GUNPOWDER', 'NITRO'], ['NITRO', 'C4'], ['C4', 'C4'], ['C4', 'TNT'], ['NITRO', 'TNT']]) {
    const source = ELEMENTS[E[src]].blast.P, crush = ELEMENTS[E[tgt]].blast.crushP;
    // along an axis, every taxicab step a cell; along a face diagonal, two a cell
    const axis = v1Reach(source, crush, [1, 0, 0]), diagonal = v1Reach(source, crush, [1, 1, 0]);
    assert.equal(axis, closed(source, crush), `${src} on ${tgt} along an axis`);
    assert.ok(diagonal <= closed(source, crush) && diagonal >= closed(source, crush) - 1, `${src} on ${tgt} on a diagonal: ${diagonal}`);
  }
  // a lone nitroglycerin cell 14 cells, one in a chain (its cell already holding pressure: P_MAX) 15; C-4 on C-4 8
  assert.equal(closed(v1FrontSource(E.NITRO, dynamicsRows[E.NITRO].energy, 0), ELEMENTS[E.NITRO].blast.crushP), 14);
  assert.equal(closed(v1FrontSource(E.NITRO, dynamicsRows[E.NITRO].energy, 50), ELEMENTS[E.NITRO].blast.crushP), 15);
  assert.equal(closed(v1FrontSource(E.C4, dynamicsRows[E.C4].energy, 0), ELEMENTS[E.C4].blast.crushP), 8);
  // a whole cell's front is its blast.P; a liquid's share of one by √fill (V2's pressure: p² ∝ J)
  for (const key of ['NITRO', 'C4', 'TNT', 'GUNPOWDER']) assert.ok(Math.abs(v1FrontSource(E[key], dynamicsRows[E[key]].energy, 0) - Math.min(PHYS.P_MAX, ELEMENTS[E[key]].blast.P)) < 1e-9, key);
  assert.ok(Math.abs(v1FrontSource(E.NITRO, dynamicsRows[E.NITRO].energy / 4, 0) - ELEMENTS[E.NITRO].blast.P / 2) < 1e-9);
});
// The batch's damage, V1's rules on the batch's sources: dynamics-reference.js chargeBatchDamage (the CPU twin
// of pick's sources, dSrcLine, dSrcPasses and damageCharges), on scenes as the GPU check builds them.
const KEY = p => p.join(',');
const scene = (dims, fill) => { const cells = new Map(); fill((p, key) => cells.set(KEY(p), E[key])); return { dims, cells }; };
const charge = (p, key) => ({ p, id: E[key], energy: dynamicsRows[E[key]].energy });
// the farthest cell along +x (from a charge at x0) a decision reaches, in a row of `wall`
function reachAlong(source, wall, decision) {
  const dims = [40, 4, 4], s = scene(dims, set => { for (let x = 1; x < 40; x++) set([x, 1, 1], wall); });
  const out = chargeBatchDamage({ ...s, charges: [charge([0, 1, 1], source)] });
  // a row of solid: only its first cell sees the charge (V1: a solid holds no pressure); so a wall per distance
  let far = 0;
  for (let x = 1; x < 40; x++) { const one = scene(dims, set => set([x, 1, 1], wall));
    if (chargeBatchDamage({ ...one, charges: [charge([0, 1, 1], source)] }).get(KEY([x, 1, 1]))?.[decision]) far = x; }
  return { far, row: out };
}
test('BL-1: a blast breaks a solid by V1\'s front against hard·P_BREAK_PER_HARD, at V1\'s reach (react.js:319-325)', () => {
  // V1 (audit part-blast.md, react.js stepped): C-4 breaks glass to 11 cells, wood to 5, rock to 2, metal never;
  // gunpowder breaks glass to 3 and never wood or metal
  const v1 = (P, strength) => { let d = 0; while (v1FrontOn(P, d + 1) > strength) d++; return d; };
  for (const [src, wall, cells] of [['C4', 'GLASS', 11], ['C4', 'WOOD', 5], ['C4', 'ROCK', 2], ['C4', 'METAL', 0], ['C4', 'BRICK', v1(200, 60)],
    ['GUNPOWDER', 'GLASS', 3], ['GUNPOWDER', 'WOOD', 0], ['GUNPOWDER', 'METAL', 0], ['NITRO', 'GLASS', 10], ['NITRO', 'WOOD', 4]]) {
    const { far, row } = reachAlong(src, wall, 'break');
    assert.equal(far, cells, `${src} breaks ${wall} to ${cells} cells (got ${far})`);
    // in a solid row only the face cell breaks: the rest is behind it
    assert.equal([...row.keys()].filter(k => row.get(k).break).length, Math.min(1, cells), `${src} into a ${wall} row`);
  }
  // the old rule (an energy share against toughness: blastPlan) broke metal 6 cells from one gunpowder cell
  const metal = [6, 1, 1], plan = blastPlan([0, 1, 1], [metal], () => false, dynamicsRows[E.GUNPOWDER].energy)[0];
  assert.ok(plan.energy >= dynamicsRows[E.METAL].toughness, `the old rule broke it: ${plan.energy} J`);
  assert.equal(chargeBatchDamage({ dims: [16, 4, 4], cells: new Map([[KEY(metal), E.METAL]]), charges: [charge([0, 1, 1], 'GUNPOWDER')] }).get(KEY(metal)), undefined);
});
test('BL-2: charges are as strong as their blast.P (elements.js EXPLOSIVE_P), never their placeholder density', () => {
  const J = key => dynamicsRows[E[key]].energy, P = key => ELEMENTS[E[key]].blast.P;
  for (const key of ['C4', 'NITRO', 'TNT', 'GUNPOWDER']) {
    assert.ok(Math.abs(J(key) / J('GUNPOWDER') - (P(key) / P('GUNPOWDER')) ** 2) < 1e-9, `${key}: energy ∝ blast.P²`);
    // its acoustic quarter raises a still brick to its blast.P (legacy), as V1's cell holds it
    assert.ok(Math.abs(addBlastPressure(0, J(key)) / LEGACY_PRESSURE_PA - P(key)) < 1e-6, `${key}: brick pressure`);
  }
  assert.ok(J('C4') / J('NITRO') < 1.25 && J('TNT') < J('NITRO'), `C-4 ${J('C4')}, nitroglycerin ${J('NITRO')}, TNT ${J('TNT')}`);
  for (const key of ['PROPANE', 'THERMITE']) assert.ok(Math.abs(J(key) - specialBlastEnergy(P(key))) < 1e-9, key);
});
test('BL-5: within a tick the front goes on through the explosives it sets off, V1\'s steps a tick (a step a cell)', () => {
  // a 6×6×6 C-4 block, its x=0 face going off (lit): this tick's damage sets off x=1..4 (V1: one layer a step,
  // LEGACY_STEPS_PER_TICK steps a tick), not x=1 alone
  const dims = [12, 10, 10], lo = 2, block = scene(dims, set => { for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) set([x + lo, y + lo, z + lo], 'C4'); });
  const layer = x => { const out = []; for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) out.push([x + lo, y + lo, z + lo]); return out; };
  let lit = layer(0), ticks = 0; const gone = new Set();
  while (lit.length && ticks < 10) {
    ticks++; for (const p of lit) { gone.add(KEY(p)); block.cells.delete(KEY(p)); }
    const out = chargeBatchDamage({ ...block, charges: lit.map(p => charge(p, 'C4')) });
    if (ticks === 1) assert.deepEqual([...new Set([...out].filter(([, v]) => v.setOff).map(([k]) => +k.split(',')[0] - lo))].sort(), [1, 2, 3, 4], 'the first tick sets off 4 layers');
    lit = [...out].filter(([, v]) => v.setOff).map(([k]) => k.split(',').map(Number));
    for (const p of lit) block.cells.set(KEY(p), E.C4);
  }
  assert.equal(gone.size, 216, 'the whole block goes off'); assert.equal(ticks, 3, 'in 3 ticks (V1: 6 steps, 1.5 ticks); the old batch took 6+');
  assert.equal(BLAST_CHAIN_STEPS, LEGACY_STEPS_PER_TICK);
  // a flame chain (gunpowder): V1's blast.flame a step, so the d-th cell along it is lit within the tick at
  // P(Binomial(steps, flame) ≥ d): 0.992, 0.916, 0.652, 0.240 (2.8 cells a tick, V1's 1/0.7 steps a cell)
  const flame = ELEMENTS[E.GUNPOWDER].blast.flame, odds = [1, 2, 3, 4, 5].map(d => v1FlameChainOdds(flame, d));
  assert.deepEqual(odds.map(x => +x.toFixed(3)), [0.992, 0.916, 0.652, 0.24, 0]);
  const trail = scene([16, 4, 4], set => { for (let x = 1; x < 16; x++) set([x, 1, 1], 'GUNPOWDER'); });
  const lights = chargeBatchDamage({ ...trail, charges: [charge([0, 1, 1], 'GUNPOWDER')] });
  for (let x = 1; x <= 5; x++) assert.equal(lights.get(KEY([x, 1, 1]))?.flame ?? 0, odds[x - 1], `trail cell ${x}`);
  // the emitted table is these odds
  const damage = blastsWGSL(g, nativeDynamicsHead, 'damageCharges');
  for (const x of odds.slice(0, 4)) assert.ok(damage.includes(String(x)), `dFlameOdds holds ${x}`);
  assert.ok(damage.includes(`const D_CHAIN: i32 = ${LEGACY_STEPS_PER_TICK};`));
});
test('the front\'s reach: where V1\'s front from P_MAX passes the floor every rule reads, and walls block it', () => {
  assert.equal(BLAST_REACH_MAX, 17); assert.equal(v1BlastReach(ELEMENTS[E.GUNPOWDER].blast.P), 9);
  const damage = blastsWGSL(g, nativeDynamicsHead, 'damageCharges');
  assert.ok(damage.includes(`const D_REACH_MAX: i32 = ${BLAST_REACH_MAX};`));
  // nitroglycerin on nitroglycerin: 14 cells from a lone cell, 15 from one in a chain (its brick already held a blast)
  const row = (prior, x) => chargeBatchDamage({ dims: [32, 4, 4], cells: new Map([[KEY([x, 1, 1]), E.NITRO]]), charges: [charge([0, 1, 1], 'NITRO')], prior: () => prior }).get(KEY([x, 1, 1]))?.setOff ?? false;
  assert.equal(row(0, 14), true); assert.equal(row(0, 15), false); assert.equal(row(40, 15), true); assert.equal(row(40, 16), false);
  // C-4 on C-4 (crushP 60) across open air: 8 cells
  const c4 = x => chargeBatchDamage({ dims: [32, 4, 4], cells: new Map([[KEY([x, 1, 1]), E.C4]]), charges: [charge([0, 1, 1], 'C4')] }).get(KEY([x, 1, 1]))?.setOff ?? false;
  assert.equal(c4(8), true); assert.equal(c4(9), false);
  // a wall between: shielded
  const walled = chargeBatchDamage({ dims: [32, 4, 4], cells: new Map([[KEY([3, 1, 1]), E.METAL], [KEY([6, 1, 1]), E.NITRO]]), charges: [charge([0, 1, 1], 'NITRO')] });
  assert.equal(walled.get(KEY([6, 1, 1])), undefined);
});
test.after(() => d.dispose());
