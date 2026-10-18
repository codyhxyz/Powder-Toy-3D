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
test.after(() => d.dispose());
