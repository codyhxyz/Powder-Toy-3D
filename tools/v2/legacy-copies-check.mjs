// CPU only: the legacy state's copies across engine switches (Simulation.pingPong).
// Real Simulation + PhysicsV2 over a recording device whose buffers hold bytes;
// dispatches record commands, not WGSL. No device/browser/launcher.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';

globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const N = 32, BYTES = { A: 16, B: 16, F: 4 }, FLOW_BYTES = 8;
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
// Every device's open frame is submitted (its retired buffers then go): what the app's microtask flush does.
const devices = [];
const submitAll = async () => { for (const gpu of devices) gpu.flush(); await settle(); };

function device() {
  const dispatches = [];
  const gpu = {
    testMode: false, failure: null, stats: { flushes: 0 }, L: { PARAMS: {}, EMPTY: { entries: [] } }, emptyGroup: {},
    fits: () => true, layout: (name, entries) => ({ name, entries }),
    bindGroup: (layout, entries, label) => ({ layout, entries, label }),
    createBuffer: desc => ({ ...desc, data: new Uint8Array(desc.size), destroyed: false, destroy() { this.destroyed = true; } }),
    queue: {
      writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    write(b, at, data) { this.queue.writeBuffer(b, at, data); },
    frame: {
      open: true,
      copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
      clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); },
    },
    flush() { this.stats.flushes++; },
    readback: {
      ring: (_name, bytes) => ({ next: () => 0, read: async () => new ArrayBuffer(bytes), close() {} }),
      buffer: async (b, at, n) => b.data.slice(at, at + n).buffer,
    },
    kernel: desc => ({
      name: desc.name, state: 'ready', ready: Promise.resolve(), build: () => Promise.resolve(),
      dispatch(_frame, _size, opts) { dispatches.push({ name: desc.name, header: opts.header, bind: opts.bind }); },
    }),
  };
  devices.push(gpu);
  return { gpu, dispatches };
}

// Every legacy state buffer a group holds: { buffer, copies } (labels `sim<id> A|B|F`).
const stateIn = (group, g) => (group?.entries ?? []).map(e => e.resource?.buffer)
  .filter(b => b && /^sim\d+ [ABF]$/.test(b.label))
  .map(b => ({ buffer: b, copies: b.size / (g.slots * BYTES[b.label.at(-1)]) }));
const simGroups = sim => [sim._bindRW, sim._bindRO, sim._bindAct, sim.bindBuild, sim._bindFlagsRO];
const ownerGroups = owner => [owner.groups.read, owner.groups.import, owner.groups.state];
// No group holds anything but the simulation's current buffers.
function boundToCurrent(sim, owner = null) {
  for (const group of [...simGroups(sim), ...(owner ? ownerGroups(owner) : [])]) {
    for (const { buffer } of stateIn(group, sim.g)) assert(buffer === sim.state[buffer.label.at(-1)], `${group.label} holds a replaced ${buffer.label}`);
  }
}
// No dispatch bound a destroyed buffer or indexed a copy its buffers lack.
function dispatchesValid(dispatches, g) {
  for (const d of dispatches) for (const group of d.bind ?? []) for (const { buffer, copies } of stateIn(group, g)) {
    assert(!buffer.destroyed, `${d.name} bound destroyed ${buffer.label}`);
    if (d.header) assert(d.header.src < copies && d.header.dst < copies, `${d.name} reads copy ${d.header.src} / writes ${d.header.dst} of ${copies}`);
  }
}
const sizes = sim => Object.fromEntries(Object.keys(BYTES).map(k => [k, sim.state[k].size]));
const of = (sim, copies) => Object.fromEntries(Object.entries(BYTES).map(([k, b]) => [k, copies * sim.g.slots * b]));
// Distinct bytes in copy c of every state buffer, and a read of copy c.
function fill(sim, c, seed) {
  for (const [k, b] of Object.entries(BYTES)) {
    const n = sim.g.slots * b, part = sim.state[k].data.subarray(c * n, (c + 1) * n);
    for (let i = 0; i < n; i++) part[i] = (i * 31 + seed + k.charCodeAt(0)) & 255;
  }
}
const copyOf = (sim, c) => Object.fromEntries(Object.entries(BYTES).map(([k, b]) => {
  const n = sim.g.slots * b;
  return [k, sim.state[k].data.slice(c * n, (c + 1) * n)];
}));
const zeros = bytes => bytes.every(v => v === 0);

// ---- a box booted on the native engine: one copy, never two until V1 steps ----
{
  const { gpu, dispatches } = device();
  const sim = new Simulation(gpu, N, N, N, { nativeStartup: true });
  assert.equal(sim.copies, 1);
  assert.deepEqual(sizes(sim), of(sim, 1), 'one copy of A, B and F');
  const flow = sim.flow;
  assert.equal(flow.size, sim.g.slots * FLOW_BYTES, 'the flow field stays: the renderer samples it under either engine');
  const first = { ...sim.state };
  const owner = new PhysicsV2(sim);
  for (const k of Object.keys(BYTES)) assert.equal(sim.state[k], first[k], 'a native boot allocates no second set');
  boundToCurrent(sim, owner);
  await owner.ready;
  await sim.ready;
  owner.activate();
  owner.ticks(3);
  sim.bindRW; sim.bindRO; sim.bindFlagsRO;   // (the legacy boundaries)
  fill(sim, 0, 7);
  // Undo under the native owner takes the one copy there is.
  sim.snapshot('native');
  assert.deepEqual(sim.history.at(-1).A.data, copyOf(sim, 0).A);
  assert.deepEqual(sim.history.at(-1).B.data, copyOf(sim, 0).B);
  dispatchesValid(dispatches, sim.g);

  // V2 → V1: the boundary builds kernels; the first step brings the other copy back zeroed, as a new grid's.
  await sim.prepareLegacy();
  owner.suspend();
  assert.equal(sim.copies, 1, 'suspension alone keeps one copy');
  const before = copyOf(sim, 0), old = { ...sim.state }, oldGroups = simGroups(sim);
  assert.equal(sim.forceAll, true, "suspend's whole-write note: the first map draws every unit");
  dispatches.length = 0;
  sim.step();
  assert.equal(sim.copies, 2);
  assert.deepEqual(sizes(sim), of(sim, 2));
  assert.equal(sim.cur, 1, 'the step ran its react into the other copy');
  const grown = { 0: copyOf(sim, 0), 1: copyOf(sim, 1) };
  for (const k of Object.keys(BYTES)) {
    assert.deepEqual(grown[0][k], before[k], `${k}: the current copy keeps its words`);
    assert(zeros(grown[1][k]), `${k}: the other copy starts zeroed (a native boot's never-written copy)`);
  }
  assert(simGroups(sim).every((group, i) => group !== oldGroups[i]), 'every state group is made again');
  boundToCurrent(sim, owner);
  dispatchesValid(dispatches, sim.g);
  assert(Object.values(old).slice(0, 3).every(b => !b.destroyed), 'a replaced buffer outlives the open frame');
  gpu.flush(); await settle();
  for (const k of Object.keys(BYTES)) assert(old[k].destroyed, `${k}: the replaced buffer goes once the queue is done`);
  const steps = [...new Set(dispatches.map(d => d.name))];
  assert(steps.includes('move') && steps.includes('react'));

  // V1 → V2: the current copy (now copy 1) becomes the one copy.
  fill(sim, sim.cur, 91);
  const current = copyOf(sim, sim.cur), two = { ...sim.state };
  dispatches.length = 0;
  owner.activate();
  assert.equal(sim.copies, 1);
  assert.equal(sim.cur, 0);
  for (const k of Object.keys(BYTES)) assert.deepEqual(copyOf(sim, 0)[k], current[k], `${k}: shrinking keeps the current copy`);
  boundToCurrent(sim, owner);
  assert.equal(sim.bindRO, owner.groups.read, 'readers bind the owner\'s new group');
  owner.ticks(2);
  sim.bindRW;
  dispatchesValid(dispatches, sim.g);
  gpu.flush(); await settle();
  for (const k of Object.keys(BYTES)) assert(two[k].destroyed);
  assert.equal(sim.flow, flow, 'the flow field is never remade');
  assert.equal(sim.state.flow, flow);

  // Copy tools and an out-of-place shift take both copies first.
  dispatches.length = 0;
  owner.suspend();
  sim.syncCopies();
  assert.equal(sim.copies, 2);
  dispatchesValid(dispatches, sim.g);
  const disposed = { ...sim.state };
  owner.dispose();
  sim.dispose();
  for (const k of Object.keys(BYTES)) assert(disposed[k].destroyed, `${k}: dispose frees the copies held now`);
}

// ---- a V1 box switched to the native engine: its other copy goes, the current one stays ----
{
  const { gpu, dispatches } = device();
  const sim = new Simulation(gpu, N, N, N);
  await sim.ready;
  assert.equal(sim.copies, 2, 'V1 keeps both copies');
  sim.step();
  assert.equal(sim.cur, 1);
  fill(sim, 1, 3);
  const current = copyOf(sim, 1);
  const owner = new PhysicsV2(sim);
  assert.equal(sim.copies, 1);
  assert.equal(sim.cur, 0);
  for (const k of Object.keys(BYTES)) assert.deepEqual(copyOf(sim, 0)[k], current[k]);
  boundToCurrent(sim, owner);
  await owner.ready;
  dispatches.length = 0;
  await sim.readCopies();   // (a copy tool: both again)
  assert.equal(sim.copies, 2);
  dispatchesValid(dispatches, sim.g);
}

// ---- a box with one copy shifts out of place into a second one ----
{
  const { gpu, dispatches } = device();
  const sim = new Simulation(gpu, N, N, N, { nativeStartup: true });
  await sim.ready;
  await sim.prepare('shift', 'flowShift');
  fill(sim, 0, 5);
  dispatches.length = 0;
  sim.shift(16, 0);
  assert.equal(sim.copies, 2);
  assert.equal(sim.cur, 1, 'the shift wrote the other copy');
  dispatchesValid(dispatches, sim.g);
}

// ---- windows and V1 never drop a copy ----
for (const opts of [{ nativeStartup: true, windowed: true }, { windowed: true }, {}]) {
  const { gpu } = device();
  const sim = new Simulation(gpu, N, N, N, opts);
  const first = { ...sim.state };
  assert.equal(sim.copies, 2, JSON.stringify(opts));
  await sim.ready;
  if (opts.windowed) {
    const owner = new PhysicsV2(sim);
    await owner.ready;
    owner.suspend(); owner.activate();
  } else {
    sim.step();
    sim.syncCopies();
  }
  for (const k of Object.keys(BYTES)) assert.equal(sim.state[k], first[k], `${JSON.stringify(opts)}: ${k} is never remade`);
}

await submitAll();

// The saving at 128³: one copy of A, B and F while the native engine owns a box.
const g = gridLayout(128, 128, 128), perSlot = BYTES.A + BYTES.B + BYTES.F, freed = g.slots * perSlot;
assert.equal(g.slots, 128 ** 3);
console.log(`legacy copies CPU: native box boots with one copy, V1 step/shift/copy tools take two, owner switch drops one, groups rebound, retired buffers freed after the queue; ${perSlot} B/slot × ${g.slots} slots = ${(freed / 1e6).toFixed(1)} MB freed at 128³`);
