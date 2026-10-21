// CPU-only check of the shared world model (src/pov/ai/world.js), no browser or
// GPU: a stand-in for readCells (world.js cellsSource, readCells's contract:
// null while its 3 buffers are out, the capture at the call) fills a pooled
// buffer with a fake sim's cells in the state's atlas layout (sim.js
// cellTexel), junk in the bytes the model doesn't read, and lands 1 to 3 frames
// late (as the readback service's staging buffers do). Checked, on the main thread and
// through the worker (world-worker.js, run here by a stand-in Worker with real
// transfers, so a buffer the model forgot to hand back is detached):
// - every cell's id() and T() is the sim's;
// - the NPCs, the vehicles and two bodies with Teleportitis, each ticking its
//   own view every frame, start at most one readback per 0.5 s refresh;
// - version bumps only when a capture finds a change, idVersion only for ids;
//   a sim nobody writes isn't read;
// - while the worker holds a capture, queries read the previous one;
// - a consumer gone leaves the others reading; one made later starts no read;
// - a World's moved window is read at once for a view that asks soon (the
//   vehicles'), and only then; the copy carries its window's origin and world;
// - a new sim's grid; a worker that breaks mid-capture (the main thread takes over);
// - standAt() (the column tops, deswizzle.js columnTops) answers as the cell-by-cell
//   scan it replaced, for every column and at random heights, in and out of the box.
// usage: node tools/world-model-node-check.mjs [--bench]
import { gridLayout, cellTexel } from '../src/sim.js';
import { decodeTempCode } from '../src/net/codec.js';
import { E, K, ELEMENTS } from '../src/elements.js';
import { createWorldModel, cellsSource } from '../src/pov/ai/world.js';
import { columnTops } from '../src/pov/ai/deswizzle.js';

let fails = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };
const DT = 1 / 60;

// a fake sim: its cells row-major (y, z, x), and a version bumped by every write
function fakeSim(nx, ny, nz, seed) {
  const g = gridLayout(nx, ny, nz), n = nx * ny * nz;
  const ids = new Uint8Array(n), temps = new Uint8Array(n), texel = new Int32Array(n);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) { ids[i] = rnd() < 0.5 ? E.EMPTY : (rnd() * ELEMENTS.length) | 0; temps[i] = (rnd() * 256) | 0; }
  for (let y = 0, i = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) texel[i++] = cellTexel(g, x, y, z);
  return {
    id: seed, version: 0, g, ids, temps, texel, stateA: null, origin: { toArray: () => [0, 0, 0] },
    run() {}, write() { this.version++; },
    cell: (i) => [i % nx, Math.floor(i / (nx * nz)), Math.floor(i / nx) % nz],
  };
}

// a fake renderer, readCells's stand-in (world.js cellsSource): a capture of the sim at the call
// into one of SLOTS pooled buffers (null while they are all out), landing `lag()` frames later;
// release(back) puts `back` (or the buffer) back in the pool, so a buffer the model forgot to hand
// back after a transfer is caught detached at its next use. A new grid starts a fresh pool, and a
// buffer of the old one released late is dropped (as net/codec.js createPacker's generations do).
const SLOTS = 3;
function fakeRenderer(getSim) {
  const pending = [];
  let pool = [], out = 0, grid = '', generation = 0;
  const r = {
    reads: 0, lag: () => 1 + ((Math.random() * 3) | 0),
    readCells(sim) {
      const g = sim.g, size = g.width * g.height * 4, key = `${g.nx},${g.ny},${g.nz}`;
      if (key !== grid) { grid = key; generation++; pool = []; out = 0; }
      if (out >= SLOTS) return null;
      const buf = pool.pop() ?? new Uint8Array(size), gen = generation;
      if (buf.byteLength !== size) return Promise.reject(new Error(`a readback into a ${buf.byteLength}-byte buffer (detached?)`));
      out++; r.reads++;
      for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;   // the texels' life and ctype bytes
      for (let i = 0; i < sim.ids.length; i++) { buf[sim.texel[i] * 4] = sim.ids[i]; buf[sim.texel[i] * 4 + 1] = sim.temps[i]; }
      let released = false;
      const release = (back) => {
        if (released) return;
        released = true;
        if (gen === generation) { out--; pool.push(back ?? buf); }
      };
      const job = { bytes: buf, g, dims: [g.nx, g.ny, g.nz], release };
      return new Promise((resolve) => pending.push({ left: r.lag(), resolve: () => resolve(job) }));
    },
    frame() { for (let i = pending.length - 1; i >= 0; i--) if (--pending[i].left <= 0) { pending[i].resolve(); pending.splice(i, 1); } },
  };
  return r;
}
cellsSource.read = (renderer, sim) => renderer.readCells(sim);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

// a stand-in Worker: the real world-worker.js (a fresh module each), messages structured-cloned with their transfers
let workers = 0, breakNext = false, probe = null;
class FakeWorker {
  constructor(url) {
    const scope = { postMessage: (data, transfer) => { const copy = structuredClone(data, { transfer }); setImmediate(() => this.onmessage?.({ data: copy })); } };
    this.loaded = (async () => { globalThis.self = scope; await import(`${url.href}?worker=${workers++}`); return scope; })();
  }
  postMessage(data, transfer) {
    const copy = structuredClone(data, { transfer });   // detaches the sender's buffers
    this.loaded.then((scope) => setImmediate(() => {
      if (breakNext) { breakNext = false; this.onerror?.({ message: 'the worker broke (check)', preventDefault() {} }); return; }
      probe?.();
      scope.onmessage({ data: copy });
    }));
  }
  terminate() {}
}

// every cell's id() and T() against the sim's (as captured: call when no write is pending)
function sameCells(m, sim, label) {
  const [nx, ny, nz] = m.dims;
  let bad = nx === sim.g.nx && ny === sim.g.ny && nz === sim.g.nz ? 0 : 1;
  for (let y = 0, i = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++)
    if (m.id(x, y, z) !== sim.ids[i] || m.T(x, y, z) !== decodeTempCode(sim.temps[i])) bad++;
  check(label, bad === 0, `${nx * ny * nz} cells, ${bad} differ`);
}

// standAt() against the scan it replaced (world.js before columnTops), read off the sim's own cells
function refStandAt(sim, x, z, y = sim.g.ny) {
  const { nx, ny, nz } = sim.g;
  x = Math.floor(x); z = Math.floor(z);
  for (let yy = Math.min(Math.floor(y), ny - 1); yy >= -1; yy--) {
    if (yy < 0) return 0;
    if (x < 0 || z < 0 || x >= nx || z >= nz) return yy + 1;   // the box's walls
    const i = sim.ids[(yy * nz + z) * nx + x];
    if (i === E.EMPTY || ELEMENTS[i].kind === K.GAS) continue;
    return yy + 1;
  }
  return 0;
}
function sameStand(m, sim, label) {
  const { nx, ny, nz } = sim.g;
  let bad = 0, n = 0, s = 11;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++, n++) if (m.standAt(x, z) !== refStandAt(sim, x, z)) bad++;
  for (let k = 0; k < 20000; k++, n++) {
    const x = rnd() * (nx + 8) - 4, z = rnd() * (nz + 8) - 4, y = rnd() * (ny + 8) - 4;
    if (m.standAt(x, z, y) !== refStandAt(sim, x, z, y)) bad++;
  }
  check(label, bad === 0, `${n} queries, ${bad} differ`);
}
// a sim shaped like a world: ground of solids, powders and liquids under air with some gas
function terrainSim(nx, ny, nz, seed) {
  const sim = fakeSim(nx, ny, nz, seed);
  const pick = (kind) => ELEMENTS.findIndex((e, i) => i !== E.EMPTY && e.kind === kind);
  const ground = [pick(K.SOLID), pick(K.POWDER), pick(K.LIQUID)], gas = pick(K.GAS);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const h = Math.floor(ny * (0.3 + 0.12 * Math.sin(x / 9 + seed) + 0.1 * Math.cos(z / 7)));
    for (let y = 0; y < ny; y++) {
      const i = (y * nz + z) * nx + x;
      sim.ids[i] = y < h ? ground[(x + z + y) % 3] : (y < h + 3 && (x * z + y) % 7 === 0 ? gas : E.EMPTY);
    }
  }
  return sim;
}

async function suite(useWorker) {
  const how = useWorker ? 'worker' : 'main thread';
  console.log(`== ${how}`);
  globalThis.Worker = useWorker ? FakeWorker : undefined;
  let sim = fakeSim(64, 32, 48, 7);
  const getSim = () => sim, r = fakeRenderer(getSim);
  // the consumers: the NPCs (npc.js createAi), the vehicles (vehicles/index.js), two bodies with Teleportitis (potions.js)
  const npc = createWorldModel({ renderer: r, getSim }), veh = createWorldModel({ renderer: r, getSim });
  const views = [npc, veh, createWorldModel({ renderer: r, getSim }), createWorldModel({ renderer: r, getSim })];
  const frame = async (n, change = null) => {
    for (let i = 0; i < n; i++) { change?.(); for (const v of views) v.update(DT); r.frame(); await settle(); }
  };

  await frame(1);
  check(`${how}: the first update reads at once, once for every view`, r.reads === 1, `${r.reads}`);
  await frame(4);
  check(`${how}: every view ready once it lands`, views.every((v) => v.ready));
  sameCells(npc, sim, `${how}: every cell's id and T`);
  sameStand(npc, sim, `${how}: standAt, every column and random heights`);

  r.reads = 0;
  await frame(20 * 60, () => sim.write());
  check(`${how}: a sim written every frame, 4 views: ≤ 1 readback per 0.5 s`, r.reads <= 41 && r.reads >= 30, `${r.reads} in 20 s`);

  let v0 = npc.version;
  const i0 = npc.idVersion;
  r.reads = 0;
  await frame(60);   // one more catches the writes made after the last capture started
  r.reads = 0;
  await frame(180);
  check(`${how}: nobody writes: no readback, version unchanged`, r.reads === 0 && npc.version === v0, `${r.reads} in 3 s`);
  await frame(120, () => sim.write());
  check(`${how}: written but unchanged: read, version unchanged`, r.reads >= 3 && npc.version === v0 && npc.idVersion === i0, `${r.reads} reads`);
  sim.temps[1234] ^= 0x5a; sim.write();
  await frame(60);
  check(`${how}: a temperature changes: version +1, idVersion not`, npc.version === v0 + 1 && npc.idVersion === i0);
  check(`${how}: and reads back`, npc.T(...sim.cell(1234)) === decodeTempCode(sim.temps[1234]));
  const boxAt = (i) => { const [x, y, z] = sim.cell(i); return { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z }; };
  check(`${how}: temperature-only capture leaves local material revisions unchanged`, !npc.hasIdChanges(boxAt(1234), i0));
  v0 = npc.version;
  sim.ids[777] = sim.ids[777] === E.WATER ? E.SAND : E.WATER; sim.write();
  await frame(60);
  check(`${how}: an id changes: version and idVersion +1`, npc.version === v0 + 1 && npc.idVersion === i0 + 1);
  check(`${how}: every view sees the same versions`, views.every((v) => v.version === npc.version && v.idVersion === npc.idVersion));
  sameCells(npc, sim, `${how}: every cell after the changes`);
  sameStand(npc, sim, `${how}: standAt after the changes`);
  check(`${how}: a material change invalidates its brick, not a distant brick`,
    npc.hasIdChanges(boxAt(777), i0) && !npc.hasIdChanges(boxAt(sim.ids.length - 1), i0));
  const since = npc.idVersion;
  const edits = [0, 1, 2, 3, sim.ids.length / 2 + 1234, sim.ids.length - 1];
  for (const i of edits) {
    const before = npc.idVersion;
    sim.ids[i] = sim.ids[i] === E.WATER ? E.SAND : E.WATER; sim.write();
    await frame(60);
    check(`${how}: material locality records packed cell ${i}`, npc.hasIdChanges(boxAt(i), before));
  }
  check(`${how}: local changes survive multiple captures skipped by a consumer (both packed words and grid edges)`,
    edits.every(i => npc.hasIdChanges(boxAt(i), since)) && !npc.hasIdChanges(boxAt(777), since));
  check(`${how}: caught-up consumers and immutable outside walls stay clean`,
    !npc.hasIdChanges(boxAt(0), npc.idVersion) && !npc.hasIdChanges({ x0: -8, x1: -1, y0: 0, y1: 8, z0: 0, z1: 8 }, since));
  // Origin/sim replacement with identical dimensions and bytes must invalidate
  // every region, including ones with only empty cells or outside walls.
  const emptyBrick = { x0: 0, x1: 3, y0: 0, y1: 3, z0: 0, z1: 3 };
  const outside = { x0: -8, x1: -1, y0: 0, y1: 8, z0: 0, z1: 8 };
  for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
    sim.ids[(y * sim.g.nz + z) * sim.g.nx + x] = E.EMPTY;
  sim.write();
  await frame(60);
  for (const changeIdentity of [() => { sim.id++; }, () => { sim.origin = { toArray: () => [16, 0, 0] }; }]) {
    const before = npc.idVersion;
    changeIdentity();
    await frame(60);
    check(`${how}: same-size identity/origin reset invalidates material locality`,
      npc.idVersion > before && npc.hasIdChanges(boxAt(777), before));
    check(`${how}: reset invalidates all-air and outside-only regions`,
      npc.hasIdChanges(emptyBrick, before) && npc.hasIdChanges(outside, before));
  }
  // A World's window moves (the vehicles' view asks soon, vehicles/index.js): read at once, not
  // REFRESH_S after the last; the copy says which window of which world it is (vehicles/worldCells.js).
  {
    const tick = async (soon) => { for (const v of views) v.update(DT, soon && v === veh); r.frame(); await settle(); };
    const landed = async () => { const n = r.reads; sim.write(); for (let i = 0; i < 60 && r.reads === n; i++) await tick(false); for (let i = 0; i < 4; i++) await tick(false); };
    const SOON_FRAMES = 6;   // 0.1 s: well inside the 0.5 s refresh
    sim.g.windowed = true; sim.world = [256, 32, 256];
    await landed();
    sim.origin = { toArray: () => [32, 0, 16] };
    let reads = r.reads;
    for (let i = 0; i < SOON_FRAMES; i++) await tick(false);
    check(`${how}: a moved window waits for the refresh when no view asks soon`, r.reads === reads, `${r.reads - reads} reads`);
    await landed();
    sim.origin = { toArray: () => [48, 0, 16] };
    reads = r.reads;
    for (let i = 0; i < SOON_FRAMES; i++) await tick(true);
    check(`${how}: a moved window is read at once for a view that asks soon`, r.reads === reads + 1 && veh.at.origin.join() === '48,0,16' && veh.at.world.join() === '256,32,256',
      `${r.reads - reads} reads, at ${veh.at.origin}`);
    sim.g.windowed = false; sim.world = null; sim.origin = { toArray: () => [0, 0, 0] };
    await landed();
    check(`${how}: a box's copy has no world`, veh.at.world === null && veh.at.origin.join() === '0,0,0');
  }

  if (useWorker) {
    const at = sim.cell(4321), before = npc.id(...at), v = npc.version, seen = [];
    sim.ids[4321] = before === E.STONE ? E.SAND : E.STONE; sim.write();
    probe = () => seen.push([npc.id(...at), npc.version]);
    for (let i = 0; i < 60 && npc.id(...at) !== sim.ids[4321]; i++) await frame(1);
    probe = null;
    check(`${how}: while the worker holds a capture, queries read the previous one`,
      seen.length === 1 && seen[0][0] === before && seen[0][1] === v && npc.id(...at) === sim.ids[4321] && npc.version === v + 1, JSON.stringify(seen));
  }

  views.splice(views.indexOf(veh), 1);   // the vehicles gone: vehicles.dispose() doesn't touch the model
  r.reads = 0;
  await frame(10 * 60, () => sim.write());
  check(`${how}: a consumer gone, the others keep reading`, r.reads >= 15 && r.reads <= 21, `${r.reads} in 10 s`);
  const late = createWorldModel({ renderer: r, getSim });
  const reads = r.reads;
  late.update(DT);
  check(`${how}: a view made later is ready at once, starts no read`, late.ready && late.version === npc.version && r.reads === reads);
  views.push(late);

  sim = fakeSim(32, 16, 32, 99);
  v0 = npc.version;
  await frame(60);
  check(`${how}: a new sim's grid`, npc.dims.join() === '32,16,32' && npc.version > v0, npc.dims.join());
  sameCells(npc, sim, `${how}: every cell of the new grid`);
  sameStand(npc, sim, `${how}: standAt on the new grid`);

  if (useWorker) {
    breakNext = true;
    const errs = [], err0 = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    sim.ids[5] = sim.ids[5] === E.STONE ? E.SAND : E.STONE;
    v0 = npc.version;
    const beforeFailure = npc.idVersion;
    await frame(120, () => sim.write());
    console.error = err0;
    check(`${how}: the worker breaks mid-capture: reported once, no readback fails after`,
      errs.length === 1 && errs[0].includes('World model worker failed'), errs.join(' | '));
    check(`${how}: the main thread takes over and reads the change`, npc.version === v0 + 1 && npc.id(...sim.cell(5)) === sim.ids[5]);
    check(`${how}: fallback preserves locality revisions`, npc.hasIdChanges(boxAt(5), beforeFailure) && !npc.hasIdChanges(boxAt(10000), beforeFailure));
  }
}

await suite(false);
await suite(true);

// Dam Valley's size, both ways
for (const useWorker of [false, true]) {
  globalThis.Worker = useWorker ? FakeWorker : undefined;
  const sim = fakeSim(256, 96, 128, 3), r = fakeRenderer(() => sim), m = createWorldModel({ renderer: r, getSim: () => sim });
  for (let i = 0; i < 6; i++) { m.update(DT); r.frame(); await settle(); }
  sameCells(m, sim, `256×96×128, ${useWorker ? 'worker' : 'main thread'}: every cell's id and T`);
}

// standAt on world-shaped ground, both ways: built, then a column dug out and one capped by a gas
for (const useWorker of [false, true]) {
  globalThis.Worker = useWorker ? FakeWorker : undefined;
  const how = `terrain 256×96×128, ${useWorker ? 'worker' : 'main thread'}`;
  const sim = terrainSim(256, 96, 128, useWorker ? 5 : 4), r = fakeRenderer(() => sim), m = createWorldModel({ renderer: r, getSim: () => sim });
  for (let i = 0; i < 6; i++) { m.update(DT); r.frame(); await settle(); }
  sameStand(m, sim, `${how}: standAt`);
  for (let y = 0; y < 96; y++) sim.ids[(y * 128 + 40) * 256 + 100] = E.EMPTY;   // a shaft to the floor
  sim.ids[(90 * 128 + 41) * 256 + 100] = ELEMENTS.findIndex((e) => e.kind === K.GAS);
  sim.write();
  for (let i = 0; i < 60; i++) { m.update(DT); r.frame(); await settle(); }
  check(`${how}: a dug shaft stands at the floor`, m.standAt(100, 40) === 0 && refStandAt(sim, 100, 40) === 0);
  sameStand(m, sim, `${how}: standAt after digging`);
}

if (process.argv.includes('--bench')) {
  // nav's walk asks every column's standAt (no y): the scan it did vs the column tops
  const sim = terrainSim(256, 96, 128, 4), { nx, ny, nz } = sim.g;
  const cells = new Uint16Array(sim.ids.length);
  for (let i = 0; i < cells.length; i++) cells[i] = sim.ids[i] | (sim.temps[i] << 8);
  const stands = Uint8Array.from({ length: 256 }, (_, i) => (i !== E.EMPTY && ELEMENTS[i]?.kind !== K.GAS ? 1 : 0));
  const tops = new Uint16Array(nx * nz);
  const time = (fn) => { for (let i = 0; i < 3; i++) fn(); const t = []; for (let i = 0; i < 15; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[7]; };
  const scan = time(() => { let s = 0; for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) s += refStandAt(sim, x, z); return s; });
  const built = time(() => columnTops(cells, [nx, ny, nz], stands, tops));
  console.log(`bench 256×96×128 terrain: every column's stand height, scan ${scan.toFixed(2)} ms, columnTops ${built.toFixed(2)} ms (median of 15)`);
}

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
