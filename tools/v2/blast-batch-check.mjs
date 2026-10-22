// CPU-only: one blast batch a tick (dynamics.js consumeMaterialEvents) serves
// the lowest blastBatch serviceable charges together. 1. The generated pick
// (run here as JS) takes exactly the K lowest marked slots, in slot order, and
// clears the masks. 2. Replaying the real driver's recording over an abstract
// world of charges, tick after tick: the same charges per tick as the old
// eight batches (K per tick, 480/s at the default), nothing dropped when more
// than K are queued (each charge served once, the rest the next tick), and a
// chain resolves one step a tick (The Powder Toy). 3. One charge's plan,
// sums, scale and damage use today's expressions in today's order, so a lone
// charge is planned bit for bit as before. 4. An idle tick records 17 blast
// dispatches, not 115.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { blastsWGSL, listsStageWGSL, listControl, RESET_SELECTION, CHARGES_MAX } from '../../src/shaders/v2/blasts.js';
const NONE = 0xffffffff, BATCH_DEFAULT = 8;
// Straight-line integer WGSL with loops → JS (atomics as plain words).
const js = code => code.replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1')
  .replace(/var (\w+): array<u32, \d+>;/g, 'var $1=new Array(64).fill(0);')
  .replace(/atomicExchange\(&control\[([^\]]+)\],([^)]+)\)/g, 'xchg(control,$1,$2)')
  .replace(/atomicLoad\(&control\[([^\]]+)\]\)/g, 'control[$1]')
  .replace(/atomicStore\(&control\[([^\]]+)\],([^;]+)\);/g, 'control[$1]=$2;')
  .replace(/\bmin\(/g, 'Math.min(');
const body = code => { const s = code.trimEnd(); return s.slice(s.lastIndexOf('fn main() {') + 'fn main() {'.length, -1); };
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
const constants = { LIST_EVENTS: L.lists.events, D_SERVE_MASKS: C.masks, D_CHARGES: C.slots, D_CHARGE_COUNT: C.count, D_CHARGES_MAX: CHARGES_MAX };
const pickCode = blastsWGSL(g, nativeDynamicsHead, 'pick'), pick = runner(pickCode, constants);
const runPick = (control, K) => pick(control, null, { substep: K }, NONE, helpers.select, helpers.xchg, helpers.firstTrailingBit, ...Object.values(constants));
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

test('the generated pick takes the K lowest marked slots in slot order and clears the masks', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = rng(seed), control = new Uint32Array(L.words), marked = [];
    const bricks = [...new Set(Array.from({ length: 1 + Math.floor(random() * 12) }, () => Math.floor(random() * g.nbricks)))];
    control[L.lists.events] = bricks.length; bricks.forEach((b, i) => { control[L.lists.events + 2 + i] = b; });
    for (const b of bricks) for (let l = 0; l < 64; l++) if (random() < 0.15) { const s = b * 64 + l; marked.push(s); control[C.masks + 2 * b + (l >> 5)] |= 1 << (l & 31); }
    const K = [1, 3, 8, 64][seed % 4], expected = marked.sort((a, b) => a - b).slice(0, K);
    runPick(control, K);
    assert.equal(control[C.count], expected.length);
    assert.deepEqual(Array.from(control.subarray(C.slots, C.slots + expected.length)), expected);
    assert.equal(control[3], expected.length ? expected[0] : NONE);
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
        for (let k = 0; k < control[C.count]; k++) { const w = world.find(x => x.slot === control[C.slots + k]);
          assert.ok(w, `picked slot ${control[C.slots + k]} is a queued charge (${world.map(x => x.slot)})`); w.done = true; now.push(w.slot);
          if (w.arms !== undefined) world.find(x => x.slot === w.arms).ready = tick + 1; }
      }
    }
    served.push(now);
  }
  return served;
}
// The old eight batches over the same world: each batch served the lowest ready charge.
function servedBefore(world, ticks, batches) {
  const out = [];
  for (let tick = 0; tick < ticks; tick++) { const now = [];
    for (let n = 0; n < batches; n++) { const w = world.filter(x => x.ready <= tick && !x.done).sort((a, b) => a.slot - b.slot)[0]; if (!w) break;
      w.done = true; now.push(w.slot); if (w.arms !== undefined) world.find(x => x.slot === w.arms).ready = tick + 1; }
    out.push(now); }
  return out;
}
const charges = (slots, chain = false) => slots.map((slot, i) => ({ slot, ready: chain && i ? Infinity : 0, done: false, ...(chain && i + 1 < slots.length ? { arms: slots[i + 1] } : {}) }));
test('the same charges a tick (and a second) as the eight batches, lowest first', () => {
  for (const [seed, M] of [[1, 3], [2, 8], [3, 13], [4, 30]]) {
    const random = rng(seed), slots = [...new Set(Array.from({ length: M }, () => Math.floor(random() * g.slots)))];
    const now = serve(charges(slots), 6, BATCH_DEFAULT), before = servedBefore(charges(slots), 6, BATCH_DEFAULT);
    assert.deepEqual(now, before, `charges served per tick: ${slots.length} queued`);
    for (const tick of now) assert.ok(tick.length <= BATCH_DEFAULT);
  }
  const full = serve(charges(Array.from({ length: 60 }, (_, i) => i * 17)), 4, BATCH_DEFAULT); // inside the 1,024-slot grid
  assert.deepEqual(full.map(t => t.length), [8, 8, 8, 8], 'eight a tick: 480 charges a second at 60 Hz');
});
test('nothing is dropped when more than a batch is queued: each charge once, the rest the next tick', () => {
  const slots = Array.from({ length: 20 }, (_, i) => 3 + i * 11), served = serve(charges(slots), 4, BATCH_DEFAULT);
  assert.deepEqual(served.map(t => t.length), [8, 8, 4, 0]);
  assert.deepEqual(served.flat().sort((a, b) => a - b), slots, 'every charge served exactly once');
});
test('a chain spreads one step a tick (The Powder Toy): a charge set off this tick waits for the next', () => {
  const slots = [40, 41, 42, 43, 44], served = serve(charges(slots, true), 6, BATCH_DEFAULT);
  assert.deepEqual(served, [[40], [41], [42], [43], [44], []]);
  assert.deepEqual(servedBefore(charges(slots, true), 6, BATCH_DEFAULT), served, 'the old batches never chained within a tick either');
});

test('a lone charge: today\'s expressions, in today\'s order', () => {
  const plan = blastsWGSL(g, nativeDynamicsHead, 'plan'), now = blastsWGSL(g, nativeDynamicsHead, 'planCharges');
  for (const expression of ['let received = explosionEnergy * 0.5 * weight / (12.566370614359*r2);', 'let r2 = max(0.25,dot(delta,delta));'])
    assert.ok(plan.includes(expression) && now.includes(expression), expression);
  assert.match(plan, /plan\.velocity = normalize\(delta\+vec3f\(0\.000001\)\)\*received;/);
  assert.match(now, /return normalize\(delta\+vec3f\(0\.000001\)\)\*received;/);
  assert.match(now, /if \(k==0u\) \{ plan\.velocity=velocity; \}/);
  assert.match(now, /if \(live\) \{ if \(n!=1u\) \{ plan\.velocity=vec3f\(0\); \} plans\[t\] = plan; \}/);
  // sum's order: slot order within a brick, from 0 (lane order here)
  assert.match(blastsWGSL(g, nativeDynamicsHead, 'sum'), /for \(var s=t\*64u;s<\(t\+1u\)\*64u;s\+\+\) \{ energy \+= length\(plans\[s\]\.velocity\); \}/);
  assert.match(now, /wgEnergy\[li\]=length\(velocity\); workgroupBarrier\(\);/);
  assert.match(now, /var energy=0\.0; for \(var lane=0u;lane<64u;lane\+\+\) \{ energy \+= wgEnergy\[lane\]; \}/);
  // normalize's: bricks in order, then the same scale expression; control[6] is that scale
  const norm = blastsWGSL(g, nativeDynamicsHead, 'normalizeCharges');
  assert.match(blastsWGSL(g, nativeDynamicsHead, 'normalize'), /scale=min\(1\.0,budget\*0\.5\/max\(sum,0\.000001\)\);/);
  assert.match(norm, /for \(var b=0u;b<D_BRICKS;b\+\+\) \{ sum \+= bitcast<f32>/);
  assert.match(norm, /min\(1\.0,budget\*0\.5\/max\(sum,0\.000001\)\)/);
  // damagePlan's energy and direction for one charge
  const damage = blastsWGSL(g, nativeDynamicsHead, 'damageCharges');
  assert.match(blastsWGSL(g, nativeDynamicsHead, 'damagePlan'), /let energy=length\(plan\.velocity\)\*bitcast<f32>\(atomicLoad\(&control\[6\]\)\);/);
  assert.match(damage, /var energy=length\(plan\.velocity\)\*bitcast<f32>\(atomicLoad\(&control\[6\]\)\);/);
  assert.match(damage, /if \(n>1u && /);
  assert.match(damage, /select\(normalize\(plan\.velocity\),normalize\(combined\+vec3f\(0\.000001\)\),n>1u\)/);
  // the rest (allocate, apply, children) is shared and unchanged: one charge is planned as before
});
test('an idle tick records 17 blast dispatches, not 115, and no copies', () => {
  commands.length = 0; d.blastBatch = BATCH_DEFAULT; d.consumeMaterialEvents(9);
  assert.equal(commands.filter(c => !c.copy).length, 17); assert.equal(commands.filter(c => c.copy).length, 0);
  assert.equal(body(blastsWGSL(g, nativeDynamicsHead, 'reset')).trim(), RESET_SELECTION);
  assert.match(listsStageWGSL(g, 'workArgs'), /let hasWork=control\[3\]!=D_NONE/);
  assert.match(pickCode, /The Powder Toy/);
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
  // every charge finish serves, in its order, puts its pressure in first; finish no longer does
  assert.match(norm, /for \(var c=0u;c<n;c\+\+\) \{\n\s*let s=atomicLoad\(&control\[D_CHARGES\+c\]\); let before=loadMaterial\(s\);\n\s*if \(!dChargeServed\(s,before\) \|\| dEvaporates\(before\)\) \{ continue; \}\n\s*dChargePressure\(s,before\);/);
  assert.match(finish, /if \(!dChargeServed\(s,before\)\) \{ continue; \}/);
  assert.ok(!/air\[|dChargePressure/.test(finish), 'finishCharges adds no pressure of its own');
  // the pressure is what finish added before (the charge's energy, a quarter of it acoustic)
  const head = blastsWGSL(g, nativeDynamicsHead, 'normalizeCharges');
  assert.match(head, /let addedP2=2\.0\*[\d.e+]+\*dChargeEnergy\(m\)\*0\.25\/[\d.e+]+;\n\s*if\(mAirPressure\(\)\) \{ a\.vp\.w=sqrt\(a\.vp\.w\*a\.vp\.w\+addedP2\); \} a\.thermal\.z=0\.0; air\[b\]=a; noteAir\(b\);/);
  // damage: past its crushP, set off (served next tick) and not planned to break or fly, before either
  const setOff = damage.indexOf('if (energy>0.0 && dCrush(id)>0.0 && mAirPressure() && (dPressureOn(cellOf(t),k)>dCrush(id) || dChargeFrontOver(cellOf(t),dCrush(id)))) {');
  assert.ok(setOff > 0 && setOff < damage.indexOf('var kinetic=energy;'), 'the set-off comes before the break and the throw');
  assert.ok(damage.includes('events[t]|=1u; noteEvents(t,events[t]); dWake(cellOf(t)); plan.velocity=vec3f(0); plans[t]=plan; return;'));
});

// V1 react.js air pressure: each open cell takes max(its diffusion, P_FRONT of its strongest open neighbour),
// P_DECAY of it, a step; a charge going off adds its blast.P to its cell's (to P_MAX); an explosive goes off
// under more than its crushP, its own or an open neighbour's (setOff, pOn). Stepped here as V1 runs it, on a
// 3D grid of open air (walls reflect: a solid neighbour reads the cell's own), for each charge and target.
import { V1_FRONT, v1FrontOn, v1FrontSource, frontPerRootJ, dynamicsRows, LEGACY_PRESSURE_PA } from '../../src/v2/dynamics-reference.js';
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
// The emitted rule, executed: damageCharges' dChargeFrontOver and its table, translated to JS over stubs of
// the cells, the air and the batch (the batch's words as the pick leaves them).
const frontCode = blastsWGSL(g, nativeDynamicsHead, 'damageCharges');
function wgslFn(code, name) {
  const at = code.indexOf(`fn ${name}(`), open = code.indexOf('(', at), close = code.indexOf(')', open);
  const args = code.slice(open + 1, close).split(',').map(a => a.split(':')[0].trim());
  let depth = 0, i = code.indexOf('{', close), start = i;
  for (; ; i++) { if (code[i] === '{') depth++; if (code[i] === '}' && --depth === 0) break; }
  return { args, body: code.slice(start + 1, i) };
}
const toJs = body => body.replace(/\b(\d+)u\b/g, '$1').replace(/\bvar (\w+)=/g, 'let $1=').replace(/switch id \{/, 'switch (id) {')
  .replace(/atomicLoad\(&control\[([^\]]+)\]\)/g, 'control[$1]').replace(/abs\(p-q\)/, 'vabs(p,q)').replace(/\bf32\(/g, 'Number(');
function frontRule() {
  const table = wgslFn(frontCode, 'dFrontPerRootJ'), over = wgslFn(frontCode, 'dChargeFrontOver');
  const dFrontPerRootJ = Function('id', toJs(table.body));
  return (world) => Function('p', 'crush', 'control', 'D_CHARGE_COUNT', 'D_CHARGES', 'D_CHARGES_MAX', 'min', 'max', 'sqrt', 'pow', 'vabs',
    'loadMaterial', 'dChargeServed', 'dEvaporates', 'cellOf', 'dChargeEnergy', 'air', 'brickOfCell', 'cid', 'dShielded', 'dFrontPerRootJ', toJs(over.body))
    .bind(null)(world.p, world.crush, world.control, 0, 1, 64, Math.min, Math.max, Math.sqrt, Math.pow,
      (a, b) => ({ x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y), z: Math.abs(a.z - b.z) }),
      s => world.cells[s], () => true, () => false, s => world.at[s], m => m.energy, world.air, () => 0, core => core.id, world.shielded ?? (() => false), dFrontPerRootJ);
}
test('the batch\'s damage reads V1\'s front from its charges: a lone charge\'s reach, a chain\'s, walls, and only served charges', () => {
  assert.ok(frontCode.includes('fn dChargeFrontOver(p: vec3i, crush: f32) -> bool {'));
  const rule = frontRule(), Pa = LEGACY_PRESSURE_PA, nitro = dynamicsRows[E.NITRO], c4 = dynamicsRows[E.C4];
  // one charge at slot 0, at (10, 0, 10); brickPa: its brick's air after normalizeCharges added its share
  const added = e => 2 * 1.225 * 50 ** 2 * e * 0.25 / (4 * 0.3) ** 3;
  const world = (id, energy, target, crush, { prior = 0, shielded } = {}) => ({
    p: { x: target[0], y: target[1], z: target[2] }, crush, control: [1, 0], cells: [{ core: { id }, energy }], at: [{ x: 10, y: 0, z: 10 }],
    air: [{ vp: { w: Math.sqrt(prior * prior + added(energy)) } }], shielded });
  const nitroCrush = nitro.crush, c4Crush = c4.crush;
  // a lone nitroglycerin cell (nothing in its brick before): 14 taxicab cells on nitroglycerin, not 15
  assert.equal(rule(world(E.NITRO, nitro.energy, [24, 0, 10], nitroCrush)), true, '14 cells along x');
  assert.equal(rule(world(E.NITRO, nitro.energy, [17, 0, 17], nitroCrush)), true, '7 + 7');
  assert.equal(rule(world(E.NITRO, nitro.energy, [25, 0, 10], nitroCrush)), false, '15 cells');
  assert.equal(rule(world(E.NITRO, nitro.energy, [18, 0, 17], nitroCrush)), false, '8 + 7');
  // one in a chain: its brick already held a blast's pressure (V1's spread), so it goes off at P_MAX: 15 cells
  assert.equal(rule(world(E.NITRO, nitro.energy, [25, 0, 10], nitroCrush, { prior: 40 * Pa })), true, 'a chain: 15 cells');
  assert.equal(rule(world(E.NITRO, nitro.energy, [26, 0, 10], nitroCrush, { prior: 40 * Pa })), false, 'a chain: 16 cells');
  // a quarter-full cell of it: half the pressure (√ of its energy), 10 cells
  assert.equal(rule(world(E.NITRO, nitro.energy / 4, [20, 0, 10], nitroCrush)), true);
  assert.equal(rule(world(E.NITRO, nitro.energy / 4, [21, 0, 10], nitroCrush)), false);
  // C-4 on C-4 (crushP 60): 8 cells
  assert.equal(rule(world(E.C4, c4.energy, [18, 0, 10], c4Crush)), true);
  assert.equal(rule(world(E.C4, c4.energy, [19, 0, 10], c4Crush)), false);
  // a wall between them blocks it (V1: a solid holds no pressure)
  assert.equal(rule(world(E.NITRO, nitro.energy, [12, 0, 10], nitroCrush, { shielded: () => true })), false);
  // no charge in the batch: no front
  const unserved = world(E.NITRO, nitro.energy, [12, 0, 10], nitroCrush); unserved.control = [0, 0];
  assert.equal(rule(unserved), false);
});
test.after(() => d.dispose());
