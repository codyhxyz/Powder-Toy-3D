// Co-op under Physics V2 on the GPU (src/net/codec.js), driven by tools/v2/net-native-browser-check.mjs:
// a box of native cells (water at full and partial fills with flux and foam, falling and resting sand,
// burning oil, smoke, stone, a sparked metal, a phase change) is packed by the host's kernels, framed,
// and written back by a guest's (unpackNative, then the exact records) into cleared cells. The owner
// here is the codec's view of PhysicsV2 (its cells, banks and readers), so only the codec kernels and
// the Simulation's own build: the check fits a GPU slot without V2's contact compile.
//   roundtrip()  returns the comparison's counts
import { boot, ready, log, test } from './harness.js';
import { Simulation } from '/src/sim.js';
import { E } from '/src/elements.js';
import { cellSlot } from '/src/shaders/common.js';
import { makeMaterial, withPayload, FULL } from '/src/v2/layout.js';
import * as codec from '/src/net/codec.js';

const h = await boot({ label: 'net native' });
const gpu = h.gpu;
const USAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const POOL = 65536, RECORD = 12;
const FALL_3_5 = 0xc0600000;   // -3.5 as f32: a powder falling at 3.5 m/s (shaders/v2/fall.js setFall)

test('roundtrip', async () => {
  const sim = new Simulation(gpu, 64, 64, 64, { nativeStartup: true });
  await sim.ready;
  const g = sim.g, buf = (label, size) => gpu.createBuffer({ label, size: Math.max(16, Math.ceil(size / 16) * 16), usage: USAGE });
  const cells = buf('cells', g.slots * 16), aux = buf('aux', g.slots * 4), act = buf('act', g.nbricks * 12);
  const particles = buf('pool', POOL * RECORD * 4), control = buf('control', 64), flight = buf('flight', (POOL + 1) * 32);
  const owner = { isReady: true, disposed: false, g, gpu, cells, aux, act, layout: { busy0: 0, busy1: g.nbricks, legacy: 2 * g.nbricks },
    liquidScratch: buf('scratch', 16), jetMask: buf('jets', 16), events: buf('events', 16),
    dynamics: { isReady: true, isIdle: false, disposed: false, renderState: { capacity: POOL }, particles, control, flight },
    sync() {}, noteAllCells() {}, wake() {} };
  owner.groups = { read: gpu.bindGroup(sim.L.STATE_RO, [{ binding: 0, resource: { buffer: cells } }, { binding: 1, resource: { buffer: sim.state.B } }], 'net native readers') };
  sim.compact = sim.compactOwner = owner;
  // the scene: air at 20 C, then the matter
  const core = new Uint32Array(g.slots * 4), bank = new Int32Array(g.slots);
  const air = makeMaterial(E.EMPTY, 20).core;
  for (let s = 0; s < g.slots; s++) core.set(air, s * 4);
  const put = (x, y, z, m, edit = (c) => c, b = 0) => { const s = cellSlot(g, x, y, z); core.set(edit(new Uint32Array(m.core)), s * 4); bank[s] = b; };
  for (let x = 8; x < 24; x++) for (let z = 8; z < 24; z++) {
    put(x, 1, z, makeMaterial(E.WATER, 18));                                                       // full, at rest
    put(x, 2, z, makeMaterial(E.WATER, 18, (x * 997 + z * 131) % FULL + 1), (c) => { c[2] = 0x3c003800; c[3] = (c[3] & 0xffff0000) | 0x3400; c[0] |= (x & 7) << 26; return c; }, -(x + z));   // partial, flowing, foamed
  }
  for (let y = 30; y < 34; y++) put(40, y, 40, makeMaterial(E.SAND, 20), (c) => { c[2] = FALL_3_5; c[0] |= 77 << 24; return c; });   // falling at 3.5 m/s, a fraction in
  for (let x = 40; x < 44; x++) put(x, 0, 44, makeMaterial(E.SAND, 25), (c) => { c[2] = 0x80000000; c[3] = 0x1234 << 16; return c; });  // at rest
  for (let x = 30; x < 33; x++) put(x, 5, 10, makeMaterial(E.OIL, 300, FULL), (c) => { c[1] |= 0x80000000; return withPayload({ core: c, bank: 0 }, 900).core; }, 12345);  // burning
  for (let x = 20; x < 23; x++) put(x, 40, 20, makeMaterial(E.SMOKE, 150), (c) => withPayload({ core: c, bank: 0 }, 700).core);
  for (let x = 0; x < 64; x++) put(x, 0, 0, makeMaterial(E.STONE, 20));
  put(50, 3, 50, makeMaterial(E.METAL, 20), (c) => { c[3] = (c[3] & 0xfffff000) | 3001; return c; });   // sparked
  put(51, 3, 50, makeMaterial(E.WATER, 0), (c) => { c[0] = (c[0] & 0xff0000ff) | (45000 << 8); return c; }, 777);   // freezing: a phase tag
  gpu.write(cells, 0, core); gpu.write(aux, 0, bank);
  // the pool: three flying records at scattered slots
  const pool = new Uint32Array(POOL * RECORD), flt = new Float32Array(pool.buffer);
  for (const [slot, id] of [[3, 11], [4097, 12], [65000, 13]]) {
    flt.set([10.5, 20.25, 30.75], slot * RECORD); pool[slot * RECORD + 3] = id; flt.set([1, -2, 0.5], slot * RECORD + 4);
    pool.set(makeMaterial(E.SAND, 20).core, slot * RECORD + 7);
  }
  gpu.write(particles, 0, pool);
  // host: pack, frame, decode
  const packer = codec.createPacker(), cap = await packer.pack(sim);
  const frame = await codec.encodeFrame(codec.FRAME_NATIVE_KEY, 1, cap.dims, cap.bytes, null, codec.nativeSection(cap.native));
  const d = await codec.decodeFrame(frame); cap.release();
  // guest: cleared cells, banks and pool, then the frame
  gpu.write(cells, 0, new Uint32Array(g.slots * 4)); gpu.write(aux, 0, new Uint32Array(g.slots)); gpu.write(particles, 0, new Uint32Array(POOL * RECORD));
  const applied = await codec.createUnpacker().unpack(sim, d.body, { native: d.native });
  await gpu.fence();
  const after = new Uint32Array(await gpu.readback.buffer(cells, 0, g.slots * 16)), banks = new Int32Array(await gpu.readback.buffer(aux, 0, g.slots * 4));
  const poolAfter = new Uint32Array(await gpu.readback.buffer(particles, 0, POOL * RECORD * 4)), live = new Uint32Array(await gpu.readback.buffer(control, 0, 16))[0];
  const recorded = new Set(); for (let i = 0; i < d.native.records.length; i += codec.NATIVE_RECORD_WORDS) recorded.add(d.native.records[i]);
  const liquid = new Set([E.WATER, E.OIL]);
  const mask = (w, k, id) => (k === 0 ? w & 0xff0000ff : k === 3 && !liquid.has(id) ? w & 0xffff : k === 2 && w === 0x80000000 ? 0 : w);
  let differ = 0, exact = 0, tempMax = 0, firstBad = null;
  for (let s = 0; s < g.slots; s++) {
    const c = core.subarray(s * 4, s * 4 + 4), n = after.subarray(s * 4, s * 4 + 4), id = c[0] & 255;
    if (recorded.has(s)) { if (c.some((v, k) => v !== n[k]) || bank[s] !== banks[s]) { differ++; firstBad ??= { s, c: [...c], n: [...n], bank: bank[s], got: banks[s] }; } else exact++; continue; }
    if (c.some((v, k) => mask(v, k, id) !== mask(n[k], k, id))) { differ++; firstBad ??= { s, c: [...c], n: [...n] }; }
    tempMax = Math.max(tempMax, Math.abs(((c[0] >>> 8) & 65535) - ((n[0] >>> 8) & 65535)) / 4);
  }
  const want = (x, y, z) => recorded.has(cellSlot(g, x, y, z));
  const poolSame = pool.every((v, i) => v === poolAfter[i]);
  return { applied, records: recorded.size, exact, differ, firstBad, tempMax, live, flying: d.native.particles.length / codec.NATIVE_PARTICLE_WORDS, poolSame,
    partialRecorded: want(9, 2, 9), fallingRecorded: want(40, 31, 40), restingRecorded: want(41, 0, 44), fullRecorded: want(9, 1, 9),
    burningRecorded: want(30, 5, 10), sparkRecorded: want(50, 3, 50), phaseRecorded: want(51, 3, 50), frameBytes: frame.byteLength };
});
log('net native harness ready');
ready();
