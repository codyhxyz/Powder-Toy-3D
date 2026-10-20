// CPU-only: a Factory batch's launch runs over the bricks its machine boxes touch
// (src/shaders/v2/blasts.js launchMark/launchCount/launchPrefix, apply as LAUNCH_MODE;
// src/v2/dynamics.js markLaunch/allocateLaunch), never a whole-grid plan clear, count
// or apply. The production driver records on a fake GPU with real uniform packing; an
// independent CPU model of the list checks that ranks cover exactly the batch's plans.
// A deck's carry leaves from its contact with the deck (PLAN.SLIDE). No browser, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { PARTICLE_CAP as CAP, GRAVITY, DT, CELL_M } from '../../src/v2/dynamics-reference.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { cellSlot } from '../../src/shaders/common.js';
import { ALLOCATION_STAGES, LIST_ARGS, LAUNCH_MODE, PLAN, launchControl, listControl, controlBufferWords, blastsWGSL, listsStageWGSL,
  SPAWN_PREFIX } from '../../src/shaders/v2/blasts.js';
import { assertNaga } from './wgsl-grouping.mjs';

function recorder() {
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
  const calls = [], clears = [];
  const copy = (b, offset, src) => new Uint8Array(b.bytes).set(new Uint8Array(src.buffer ?? src, src.byteOffset ?? 0, src.byteLength), offset);
  const gpu = {
    createBuffer(d) { return { ...d, bytes: new ArrayBuffer(d.size), destroy() {} }; },
    queue: { writeBuffer: copy }, write: copy, layout: (name, entries) => ({ name, entries }),
    bindGroup: (layout, entries) => ({ layout, entries }),
    kernel(d) { return { ...d, ready: Promise.resolve(), dispatch(frame, size, data) { d.params.pack(data.params); calls.push({ name: d.name, size, ...data }); } }; },
    frame: { clear(b) { clears.push(b); }, copy() {} }, readback: { buffer: (b, o, n) => Promise.resolve(b.bytes.slice(o, o + n)) },
  };
  const g = gridLayout(64, 32, 64), owner = { gpu, g, tick: 3, epoch: 0, sim: { origin: [0, 0, 0], header: () => ({}) },
    nativeDynamics: { head: nativeDynamicsHead, layout: { entries: V2_DYNAMICS_LAYOUT }, group: {} }, wake() {}, _params: () => ({ busyIn: 1, busyOut: 2 }) };
  owner.events = gpu.createBuffer({ size: g.slots * 4 });
  const d = new NativeDynamics(owner, { blastBatch: 2 });
  return { g, d, calls, clears };
}

test('a batch launches over its listed bricks: one mark a box, then count, prefix, apply over the list', async () => {
  const { g, d, calls, clears } = recorder(); await d.ready;
  // (dynamics.js make pads every buffer to 16 bytes)
  assert.equal(d.control.size, Math.ceil(controlBufferWords(g) * 4 / 16) * 16, 'the control buffer holds the launch words');
  assert(launchControl(g).marks >= listControl(g).words, 'past every other stage\'s words');
  d.markLaunch(4, [8, 5, 0], [11, 5, 3]); d.markLaunch(4, [12, 5, 0], [15, 7, 7]);
  d.allocateLaunch(4);
  assert.deepEqual(calls.map(c => c.name), ['v2blasts_launchMark', 'v2blasts_launchMark', 'v2lists_launch',
    ...ALLOCATION_STAGES.map(s => `v2blasts_${s}`), 'v2blasts_launchCount', 'v2blasts_launchPrefix', 'v2blasts_apply', 'v2blasts_children']);
  assert.deepEqual(calls[0].size, [1, 1, 1], 'a mark is one thread a box'); assert.deepEqual(calls[0].params.boxStart, [8, 5, 0]);
  assert.deepEqual(calls[0].params.boxSize, [4, 1, 4]); assert.deepEqual(calls[1].params.boxSize, [4, 3, 8]);
  const at = name => calls.find(c => c.name === name);
  assert.deepEqual(at('v2blasts_launchCount').size, { indirect: d.dispatchArgs, offset: LIST_ARGS.launchBricks }, 'count: a thread a listed brick');
  assert.deepEqual(at('v2blasts_launchPrefix').size, [1, 1, 1]);
  assert.deepEqual(at('v2blasts_apply').size, { indirect: d.dispatchArgs, offset: LIST_ARGS.launchCells }, 'apply: a workgroup a listed brick, never the grid');
  assert(calls.every(c => c.params.mode === LAUNCH_MODE));
  // red: the old path cleared the whole plan buffer and counted and applied over every cell
  assert.equal(clears.length, 0, 'nothing clears the whole plan buffer');
  assert(!calls.some(c => c.name === 'v2blasts_count' || c.name === 'v2blasts_allocate'), 'no whole-grid count or allocate');
  for (const c of calls) {
    const groups = Array.isArray(c.size) ? c.size[0] * c.size[1] * c.size[2] : 0;
    assert(groups * 64 < g.slots, `${c.name}: no dispatch spans the grid's cells`);
  }
  d.dispose();
});

test('the launch stages are naga-valid and read the list as the CPU model does', () => {
  const g = gridLayout(64, 32, 64), L = launchControl(g);
  const mark = blastsWGSL(g, nativeDynamicsHead, 'launchMark'), count = blastsWGSL(g, nativeDynamicsHead, 'launchCount');
  const prefix = blastsWGSL(g, nativeDynamicsHead, 'launchPrefix'), apply = blastsWGSL(g, nativeDynamicsHead, 'apply'), publish = listsStageWGSL(g, 'launch');
  for (const [name, code] of [['launchMark', mark], ['launchCount', count], ['launchPrefix', prefix], ['apply', apply], ['lists launch', publish]]) assertNaga(code, name);
  assert.match(mark, /if \(atomicExchange\(&control\[D_LAUNCH_MARKS\+b\],1u\)!=0u\) \{ continue; \}/);
  assert.match(mark, /for \(var s=b\*64u;s<b\*64u\+64u;s\+\+\) \{ plans\[s\]=DPlan\(vec3f\(0\),0u\); \}\s*dAppend\(D_LAUNCH_LIST,b\);/);
  assert.match(mark, /for \(var z=lo\.z;z<=hi\.z;z\+\+\) \{ for \(var y=lo\.y;y<=hi\.y;y\+\+\) \{ for \(var x=lo\.x;x<=hi\.x;x\+\+\) \{/, 'x, y, z order');
  assert(count.includes('atomicStore(&control[D_LAUNCH_COUNTS+t],n);'));
  assert(prefix.includes('atomicStore(&control[D_SPAWN_PREFIX+b],total); atomicStore(&control[D_SPAWN_COUNTS+b/64u],0u);'));
  assert(apply.includes(`if(P.mode==${LAUNCH_MODE}u && li==0u && t<D_SLOTS) { atomicStore(&control[D_LAUNCH_MARKS+t/64u],0u); }`), 'apply releases each listed brick');
  assert(apply.includes(`dListedCell(D_LAUNCH_LIST,wg,nwg,li),P.mode==${LAUNCH_MODE}u)`));
  assert(apply.includes(`const D_LAUNCH_MARKS: u32 = ${L.marks}u;`) && publish.includes(`control[${L.list}u] = n; control[${L.list + 1}u] = 0u;`));
  assert(apply.includes('let forcing=P.mode==15u || P.mode==' + LAUNCH_MODE + 'u;'), 'the listed run is forcing, as mode 15');
});

// The CPU model: mark → plan → count → prefix → dRank, against stale plans everywhere.
function launchModel(g, boxes, planned) {
  const plans = new Uint32Array(g.slots).fill(1);           // stale flags from every other writer
  const marks = new Uint8Array(g.nbricks), list = [];
  const brickOf = p => cellSlot(g, ...p) >> 6;
  for (const [i, box] of boxes.entries()) {
    const lo = box.lo.map(v => v >> 2), hi = box.hi.map(v => v >> 2);
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const b = brickOf([x * 4, y * 4, z * 4]);
      if (marks[b]) continue;
      marks[b] = 1; plans.fill(0, b * 64, b * 64 + 64); list.push(b);
    }
    for (const p of planned[i]) plans[cellSlot(g, ...p)] = 1;   // sparse: only planned cells
  }
  const counts = list.map(b => plans.subarray(b * 64, b * 64 + 64).reduce((n, f) => n + (f & 1), 0));
  const prefix = new Map(); let total = 0;
  list.forEach((b, i) => { prefix.set(b, total); total += counts[i]; });
  const ranks = [];
  for (const b of list) for (let s = b * 64; s < b * 64 + 64; s++) if (plans[s] & 1) {
    let r = prefix.get(b); for (let q = b * 64; q < s; q++) r += plans[q] & 1; ranks.push({ s, r });
  }
  return { list, total, ranks, marks };
}
test('ranks cover exactly the batch\'s plans: stale plans outside are never launched, a shared brick keeps both boxes\'', () => {
  const g = gridLayout(64, 32, 64);
  const boxes = [{ lo: [8, 5, 0], hi: [11, 5, 3] }, { lo: [10, 5, 2], hi: [13, 5, 5] }];   // they share bricks
  const planned = [[[8, 5, 0], [9, 5, 1], [11, 5, 3]], [[12, 5, 4], [13, 5, 5], [10, 5, 2]]];
  const m = launchModel(g, boxes, planned), fresh = new Set(planned.flat().map(p => cellSlot(g, ...p)));
  assert.equal(m.total, fresh.size, 'the total is the batch\'s planned cells, not the stale ones');
  assert.deepEqual(new Set(m.ranks.map(x => x.s)), fresh, 'every planned cell, and no stale one, is launched');
  assert.deepEqual(m.ranks.map(x => x.r).sort((a, b) => a - b), [...Array(fresh.size).keys()], 'ranks are 0..total-1, each once');
  assert.deepEqual(m.list, launchModel(g, boxes, planned).list, 'the list order is the recording\'s');
  // red: without marking, a later box's clear would erase the earlier box's plans in a shared brick
  const plansOf = (keepMarks) => {
    const plans = new Uint32Array(g.slots), marks = new Uint8Array(g.nbricks);
    for (const [i, box] of boxes.entries()) {
      const lo = box.lo.map(v => v >> 2), hi = box.hi.map(v => v >> 2);
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const b = cellSlot(g, x * 4, y * 4, z * 4) >> 6;
        if (keepMarks && marks[b]) continue; marks[b] = 1; plans.fill(0, b * 64, b * 64 + 64);
      }
      for (const p of planned[i]) plans[cellSlot(g, ...p)] = 1;
    }
    return plans.reduce((n, f) => n + f, 0);
  };
  assert.equal(plansOf(true), fresh.size); assert(plansOf(false) < fresh.size, 'the mark is what keeps a shared brick\'s plans');
});

test('a deck\'s carry leaves from its contact: one tick\'s slide, then it lands on the deck', () => {
  const g = gridLayout(64, 32, 64), apply = blastsWGSL(g, nativeDynamicsHead, 'apply');
  assert(apply.includes(`if (forcing && (plan.flags&${PLAN.SLIDE}u)!=0u && P.gravMode==0u) { particles[atomicLoad(&control[D_FREE+rank])].position=dSlideStart(t); }`));
  const lift = apply.match(/let lift=([0-9.e-]+)\*P\.gravity;/);
  assert(lift, 'the contact height is a share of one tick\'s fall at the dispatch\'s gravity');
  const fall = 0.5 * GRAVITY * DT * DT / CELL_M, h = Number(lift[1]) * GRAVITY;
  assert(h > 0 && h < fall, 'under one tick\'s fall from rest: the landing comes inside the tick');
  const crossing = Math.sqrt(h / fall);
  assert(crossing > 0.98, `it slides ${(crossing * 100).toFixed(1)}% of a tick at the deck's speed`);
  // red: from the cell's centre (the old launch) it glides half a cell of fall: ~18 cells at a belt's 144 cells/s
  const glide = 144 * Math.sqrt(2 * 0.5 * CELL_M / GRAVITY), slide = 144 * DT * crossing;
  assert(glide > 16 && slide < 2.5, `centre: ${glide.toFixed(1)} cells over the next decks; contact: ${slide.toFixed(2)} cells a tick`);
  assert(apply.includes('return vec3f(p+P.origin)+vec3f(dRandom(id,1u),lift,dRandom(id,2u));'), 'a uniformly random point of its floor: V1\'s chance rounding of a fraction of a cell');
  assert(SPAWN_PREFIX > 0 && CAP > 0);
});
