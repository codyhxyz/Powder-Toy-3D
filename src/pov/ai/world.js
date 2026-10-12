import { decodeTempCode, TEXEL_BYTES } from '../../net/codec.js';
import { ELEMENTS, E, K } from '../../elements.js';
import { cellTexel } from '../../sim.js';
import { BRICK, SUPER_TEX, TILE, prelude, STATE_OPTS, LAYOUT, gridDims, atlasDims } from '../../shaders/common.js';
import { uniformStruct } from '../../gpu/params.js';
import { fold } from '../../gpu/kernels.js';
import { BODY_HEIGHT } from '../constants.js';
import { deswizzle, columnTops, ID_BITS } from './deswizzle.js';

// The NPCs' picture of the world (and the vehicles' terrain, and Teleportitis's
// safe spots): the sim's cells read back to the CPU a few times a second (the
// multiplayer packer, net/codec.js: element id and a temperature code per cell,
// read asynchronously so it never stalls a frame). It is up to REFRESH_S old,
// plus however many frames the readback takes, which is fine for deciding and
// aiming; the bodies themselves collide against their own fresh probes
// (player.js).
//
// One model per renderer, shared: createWorldModel gives each consumer (the
// NPCs, the vehicles, each body with Teleportitis) a view of it with its own
// refresh clock, and the views together start at most one readback per
// REFRESH_S: a readback that lands restarts every view's clock. A view holds
// nothing; the model (its worker, its cells) lives as long as the renderer
// does, as one consumer's model did before.
//
// The de-swizzle (deswizzle.js: the atlas's bytes into row-major cells, ~5 ms
// on Dam Valley's 3.1M cells) runs in a worker (world-worker.js), on the main
// thread where there's none (node checks). Queries keep the last cells until
// the next ones arrive whole.
//
// Queries are in grid cells. Outside the box: the side walls and the floor are
// solid (OUTSIDE), above it is open air, as for the player's body.
//
// raycast() is Amanatides & Woo's voxel traversal ("A Fast Voxel Traversal
// Algorithm for Ray Tracing", 1987), stepping cell by cell along the ray
// (voxelRay, which walks any grid).

const REFRESH_S = 0.5;                 // s between readbacks
export const OUTSIDE = -1;             // id of the box walls and floor
const KIND = ELEMENTS.map((e) => e.kind);
// what a body stands on, by id (standAt): anything but air and gases
const STANDS = Uint8Array.from({ length: 256 }, (_, i) => (i !== E.EMPTY && KIND[i] !== K.GAS ? 1 : 0));
const HOT_T = 300;                     // °C: hotter than this burns a body that touches it (lava, fire, a torch's mark)
const TEMP_C = Float64Array.from({ length: 256 }, (_, code) => decodeTempCode(code));   // °C of each temperature code
if (TEXEL_BYTES !== Uint32Array.BYTES_PER_ELEMENT) throw new Error('world model: deswizzle.js reads a packed texel as one 32-bit word');

// ---- the GPU readback: the one place the model touches the GPU
//
// readCells(renderer, sim) → null when no capture buffer is free (call again
// on a later frame), else a Promise of { bytes, g, dims, release }:
//   bytes: Uint8Array, g.width × g.height texels of TEXEL_BYTES in the state's
//          atlas layout (sim.js cellTexel(g, x, y, z) is cell (x, y, z)'s texel);
//          per texel byte 0 is the element id, byte 1 the temperature code
//          (net/codec.js decodeTempCode), bytes 2 and 3 are unused here
//   g:     the grid layout it was captured with (sim.g at the call)
//   dims:  [nx, ny, nz]
//   release(back?): the caller's, once done with bytes. The caller may transfer
//          bytes.buffer to a worker; it then passes what comes back as `back`
//          (the same length), which goes back into the ring.
// It captures the state as it is at the call and resolves any number of frames
// later. A rejected readback has released itself.
//
// On WebGPU (docs/webgpu.md C2, G4) one kernel packs every cell's two bytes into
// its atlas texel's word of a scratch buffer, and the readback service copies
// the buffer at the call (B7) and, once it lands, the mapped range into one of
// PACK_SLOTS pooled ArrayBuffers (mapped memory can't be transferred to a
// worker). The temperature code is net/codec.js's: its thresholds come from
// decodeTempCode, so this kernel and the multiplayer packer can't disagree.
// (The packer itself is U12's to port: once both are in, this can be a thin
// wrapper over it again.)
const PACK_SLOTS = 3;                  // captures in flight at once
const TEMP_CODES = 256;
// the temperature at which each code starts: code c covers [decode(c − ½), decode(c + ½)) (codec.js's rounding), +∞ past the last
const TEMP_STARTS = Array.from({ length: TEMP_CODES }, (_, i) => (i + 1 < TEMP_CODES ? decodeTempCode(i + 0.5) : Infinity));
const PackParams = uniformStruct('PackParams', { starts: `array<vec4f, ${TEMP_CODES / 4}>` });
const PACK_LAYOUT = [{ binding: 0, buffer: { type: 'storage' } }];
// One thread per cell: its element id in byte 0 of its atlas texel's word, its
// temperature code in byte 1 (air as ambient, as the codec sends it).
export const packCellsFrag = (g) => {
  const at = atlasDims(g);
  return /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${PackParams.wgsl}
@group(3) @binding(1) var<uniform> P: PackParams;
@group(2) @binding(0) var<storage, read_write> packed: array<u32>;   // a word per atlas texel (sim.js cellTexel)
const STW: i32 = ${at.stw};               // supertiles per atlas row
const ATLAS_W: u32 = ${at.width}u;        // texels per atlas row
const TILES: i32 = ${SUPER_TEX / TILE};   // brick tiles per supertile edge
const TILE: u32 = ${TILE}u;               // texels per brick tile edge

// codec.js's temperature code of T: how many codes start at or below it, past the first
fn tempCode(T: f32) -> u32 {
  var lo = 0u;
  var hi = ${TEMP_CODES}u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (P.starts[mid / 4u][mid % 4u] <= T) { lo = mid + 1u; } else { hi = mid; }
  }
  return min(lo, ${TEMP_CODES - 1}u);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let a = fetchAs(s);
  let id = eid(a);
  var T = a.y;
  if (id == E_EMPTY) { T = AMBIENT; }
  // its brick's tile in the atlas, and its place in the tile (a brick's slots are its tile's texels in order)
  let b = cellOf(s) >> vec3u(2u);
  let st = b / SUPER_B;
  let k = b - st * SUPER_B;
  let i = st.x + STX * (st.z + STZ * st.y);
  let tile = vec2i((i % STW) * TILES + k.x, (i / STW) * TILES + k.z + SUPER_B.z * k.y);
  let l = s & 63u;
  packed[(u32(tile.y) * TILE + (l >> 3u)) * ATLAS_W + u32(tile.x) * TILE + (l & 7u)] = u32(id) | (tempCode(T) << 8u);
}
`;
};

const PACK_STARTS = Array.from({ length: TEMP_CODES / 4 }, (_, i) => TEMP_STARTS.slice(4 * i, 4 * i + 4));
const packers = new WeakMap();         // device → its pack kernels and scratch (per grid size), the free byte buffers
export function readCells(renderer, sim) {
  const gpu = sim.gpu, g = sim.g;
  let p = packers.get(gpu);
  if (!p) packers.set(gpu, (p = { layout: gpu.layout('pov pack', PACK_LAYOUT), grids: new Map(), pool: [], busy: 0 }));
  if (p.busy >= PACK_SLOTS) return null;
  const key = `${g.nx}x${g.ny}x${g.nz}`;
  let q = p.grids.get(key);
  if (!q) {
    const buffer = gpu.createBuffer({ label: `pov pack ${key}`, size: g.width * g.height * TEXEL_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    q = {
      kernel: gpu.kernel({ name: 'povPack', code: packCellsFrag(g), params: PackParams, layouts: [sim.L.TABLES, sim.L.STATE_RO, p.layout] }),
      buffer, group: gpu.bindGroup(p.layout, [{ binding: 0, resource: { buffer } }], `pov pack ${key}`),
    };
    p.grids.set(key, q);
  }
  if (q.kernel.state !== 'ready') return null;   // (still building: call again later)
  const bytes = g.width * g.height * TEXEL_BYTES;
  sim._dispatch(q.kernel, fold(Math.ceil(g.slots / 64)), { bind: [sim.tables, sim.bindRO, q.group], header: sim.header(), params: { starts: PACK_STARTS } });
  // the copy is recorded now (B7): the bytes are the state at this call
  let into = p.pool.pop();
  if (into?.byteLength !== bytes) into = new ArrayBuffer(bytes);
  const read = gpu.readback.buffer(q.buffer, 0, bytes, { into });
  p.busy++;
  const dims = [g.nx, g.ny, g.nz];
  let released = false;
  const release = (back) => {
    if (released) return;
    released = true;
    p.busy--;
    const buf = back?.buffer ?? back ?? into;
    if (buf && !buf.detached && buf.byteLength === bytes && p.pool.length < PACK_SLOTS) p.pool.push(buf);
  };
  return read.then((buf) => ({ bytes: new Uint8Array(buf), g, dims, release }), (err) => { release(); throw err; });
}

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'povPack', kind: 'compute', code: (g) => packCellsFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, PACK_LAYOUT], dispatch: (g) => fold(Math.ceil(gridDims(g).slots / 64)) },
];

// The atlas's brick table for grid g (deswizzle.js): the texel of each brick's
// first cell, bricks numbered (by·BZ + bz)·BX + bx, and the offset from it of
// each brick row (ly, lz), at ly·BRICK + lz. Every brick is laid out alike.
const gridKey = (g) => `${g.nx},${g.ny},${g.nz},${g.width},${g.stw}`;
function atlasRows(g) {
  const BX = g.nx / BRICK, BY = g.ny / BRICK, BZ = g.nz / BRICK;
  const table = new Int32Array(BX * BY * BZ), rowOff = new Int32Array(BRICK * BRICK);
  let k = 0;
  for (let by = 0; by < BY; by++) for (let bz = 0; bz < BZ; bz++) for (let bx = 0; bx < BX; bx++) table[k++] = cellTexel(g, bx * BRICK, by * BRICK, bz * BRICK);
  const t0 = cellTexel(g, 0, 0, 0);
  for (let ly = 0; ly < BRICK; ly++) for (let lz = 0; lz < BRICK; lz++) rowOff[ly * BRICK + lz] = cellTexel(g, 0, ly, lz) - t0;
  return { brick: BRICK, table, rowOff };
}

// Amanatides & Woo's walk over any grid: idAt(x, y, z) is the id of the cell at
// integer coordinates; top is the grid's height (a ray climbing a body's height
// past it is out the open top). The first cell after the origin's along the ray
// (origin, unit dir) within maxDist whose id `stops`: out = { valid, cell, face,
// id, dist, point }, face as raycast() numbers it. (The world model's raycast;
// the camera's arm walks the player's probe with it, cameraArm.js.)
export function voxelRay(idAt, top, origin, dir, maxDist, stops, out = {}) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
  const tdx = sx ? Math.abs(1 / dir.x) : Infinity, tdy = sy ? Math.abs(1 / dir.y) : Infinity, tdz = sz ? Math.abs(1 / dir.z) : Infinity;
  let tx = sx ? ((sx > 0 ? x + 1 - origin.x : origin.x - x) * tdx) : Infinity;
  let ty = sy ? ((sy > 0 ? y + 1 - origin.y : origin.y - y) * tdy) : Infinity;
  let tz = sz ? ((sz > 0 ? z + 1 - origin.z : origin.z - z) * tdz) : Infinity;
  let t = 0, face = -1;
  out.valid = false;
  for (let guard = 0; guard < 4096 && t <= maxDist; guard++) {
    const i = y >= top ? E.EMPTY : idAt(x, y, z);
    if (face >= 0 && stops(i)) {
      out.valid = true; out.id = i; out.face = face; out.dist = t;
      out.cell = { x, y: Math.max(y, -1), z };
      out.point = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
      return out;
    }
    if (y >= top + BODY_HEIGHT && sy >= 0) break;   // gone out the open top
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; face = sx > 0 ? 1 : 0; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; face = sy > 0 ? 3 : 2; }
    else { z += sz; t = tz; tz += tdz; face = sz > 0 ? 5 : 4; }
  }
  return out;
}

const models = new WeakMap();          // renderer → its one shared model

function createModel(renderer) {
  // cells: id | temperature code << 8 per cell, (y, z, x) row-major; words: the same buffer, two cells a word
  let cells = null, words = null, cellsKey = '', nx = 0, ny = 0, nz = 0;
  // each column's stand height (deswizzle.js columnTops), made with the cells it goes with
  let tops = null;
  let busy = false, epoch = 0, version = 0, idVersion = 0, packed = null;
  let rows = null, rowsKey = '';
  let worker = null, workerFailed = false, sentKey = '', spare = null, inflight = null;
  const rowsFor = (g) => { const key = gridKey(g); if (key !== rowsKey) { rows = atlasRows(g); rowsKey = key; } return rows; };

  // A capture has landed: the cells it made, what changed (deswizzle.js), the sim state it was of.
  function take(next, key, dims, diff, state, nextTops) {
    words = next; cells = new Uint16Array(next.buffer); cellsKey = key;
    if (nextTops) tops = nextTops;   // (none: nothing changed, the last ones hold)
    [nx, ny, nz] = dims;
    if (diff) version++;
    if (diff & ID_BITS) idVersion++;
    packed = state;
    epoch++;
  }

  function ingestHere({ bytes, g, dims, release }, state) {
    const key = gridKey(g), fresh = key !== cellsKey;
    const next = fresh ? new Uint32Array((dims[0] * dims[1] * dims[2]) / 2) : words;
    const diff = deswizzle(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2), rowsFor(g), dims, next);
    release();
    let nextTops = null;
    if (fresh || diff) {
      const cols = dims[0] * dims[2];
      nextTops = columnTops(new Uint16Array(next.buffer), dims, STANDS, new Uint16Array(cols));
    }
    take(next, key, dims, fresh ? ~0 : diff, state, nextTops);
  }

  function startWorker() {
    if (worker || workerFailed || typeof Worker !== 'function') return worker;
    try {
      worker = new Worker(new URL('./world-worker.js', import.meta.url), { type: 'module' });
    } catch (err) { fail(err); return null; }
    worker.onmessage = ({ data }) => {
      const job = inflight;
      if (!job) return;   // an answer after fail(): its capture was already given up
      inflight = null;
      job.release(data.bytes);
      if (words?.length === data.out.length) spare = words;   // the cells nothing queries any more: the next capture's out
      take(data.out, job.key, data.dims, data.diff, job.state, data.tops);
      busy = false;
    };
    worker.onerror = worker.onmessageerror = (err) => { err.preventDefault?.(); fail(err); };
    return worker;
  }
  // The worker is gone: the main thread de-swizzles from now on, against the cells it has.
  function fail(err) {
    console.error('World model worker failed: reading on the main thread', err);
    worker?.terminate();
    worker = null; workerFailed = true; spare = null;
    if (inflight) { inflight.release(new Uint8Array(inflight.length)); inflight = null; busy = false; }
  }
  function send(r, state) {
    const { bytes, g, dims, release } = r;
    const key = gridKey(g), n = (dims[0] * dims[1] * dims[2]) / 2;
    const msg = { dims, bytes, out: spare?.length === n ? spare : new Uint32Array(n) };
    spare = null;
    if (key !== sentKey) { msg.rows = rowsFor(g); msg.stands = STANDS; sentKey = key; }
    const job = { key, state, release, length: bytes.byteLength };   // (bytes is detached once sent)
    try {
      worker.postMessage(msg, [bytes.buffer, msg.out.buffer]);
      inflight = job;
    } catch (err) {   // nothing was transferred
      fail(err);
      ingestHere(r, state);
      busy = false;
    }
  }

  // Start a readback (one at a time), unless nothing was written since the last.
  function refresh(getSim) {
    if (busy) return;
    const sim = getSim();
    if (!sim) return;
    const state = `${sim.id}:${sim.version}:${sim.origin.toArray()}`;
    if (state === packed) { epoch++; return; }   // nothing written since the last capture: as good as a fresh one
    const job = readCells(renderer, sim);
    if (!job) return;
    busy = true;
    job.then((r) => {
      if (startWorker()) send(r, state);        // busy until the worker answers
      else { ingestHere(r, state); busy = false; }
    }).catch((err) => { busy = false; console.error('NPC world readback failed', err); });
  }

  const inBox = (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < nx && y < ny && z < nz;
  function id(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!cells) return E.EMPTY;
    if (y >= ny) return E.EMPTY;
    if (x < 0 || z < 0 || y < 0 || x >= nx || z >= nz) return OUTSIDE;
    return cells[(y * nz + z) * nx + x] & 0xff;
  }
  const kind = (i) => (i === OUTSIDE ? K.SOLID : KIND[i]);
  // what stops a body: solids and powders (player.js blocks())
  const blocks = (x, y, z) => { const i = id(x, y, z); return i !== E.EMPTY && (kind(i) === K.SOLID || kind(i) === K.POWDER); };
  const isLiquid = (x, y, z) => { const i = id(x, y, z); return i !== OUTSIDE && kind(i) === K.LIQUID; };
  function T(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    return cells && inBox(x, y, z) ? TEMP_C[cells[(y * nz + z) * nx + x] >> 8] : 20;
  }

  // The first cell along the ray (origin, unit dir) that `stops(id)` within
  // maxDist: { valid, cell, face, id, dist, point }. face is the struck face as
  // the god view's pick numbers it (axis·2, +1 for the negative side). The floor
  // (y < 0) answers as cell y = −1, id OUTSIDE, face +y.
  const STOPS_PICK = (i) => i !== E.EMPTY && kind(i) !== K.GAS;   // what the crosshair pick stops at
  const raycast = (origin, dir, maxDist, stops = STOPS_PICK, out = {}) => voxelRay(id, ny, origin, dir, maxDist, stops, out);

  // Can an eye at a see a point at b? (nothing that stops the pick between them)
  const SCRATCH = {};
  function sees(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return !raycast(a, { x: dx / d, y: dy / d, z: dz / d }, d - 0.5, STOPS_PICK, SCRATCH).valid;
  }

  // The highest cell a body could stand on in column (x, z) at or below y: the
  // feet's y (the top of what blocks, or of a liquid's surface), or -Infinity.
  function standAt(x, z, y = ny) {
    const from = Math.min(Math.floor(y), ny - 1);
    // the column's top (columnTops) is the answer when it is at or below where the search starts
    x = Math.floor(x); z = Math.floor(z);
    if (tops && x >= 0 && z >= 0 && x < nx && z < nz) {
      const top = tops[z * nx + x];
      if (top - 1 <= from) return top;
    }
    for (let yy = from; yy >= -1; yy--) {
      if (yy < 0) return 0;   // the floor
      const i = id(x, yy, z);
      if (i === E.EMPTY || kind(i) === K.GAS) continue;
      return yy + 1;
    }
    return 0;
  }

  // Is anything that burns a body (very hot) within r cells of p?
  function hotNear(p, r) {
    if (!cells) return false;
    for (let y = Math.floor(p.y - r); y <= p.y + r; y++)
      for (let z = Math.floor(p.z - r); z <= p.z + r; z++)
        for (let x = Math.floor(p.x - r); x <= p.x + r; x++)
          if (inBox(x, y, z) && TEMP_C[cells[(y * nz + z) * nx + x] >> 8] > HOT_T) return true;
    return false;
  }

  // The nearest cell within r of p whose id passes want(id), by a box scan: { x, y, z, id } or null.
  function nearest(p, r, want) {
    if (!cells) return null;
    let best = null, bd = Infinity;
    const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(nx - 1, Math.floor(p.x + r));
    const y0 = Math.max(0, Math.floor(p.y - r)), y1 = Math.min(ny - 1, Math.floor(p.y + r));
    const z0 = Math.max(0, Math.floor(p.z - r)), z1 = Math.min(nz - 1, Math.floor(p.z + r));
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const i = cells[(y * nz + z) * nx + x] & 0xff;
          if (!want(i)) continue;
          const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2 + (z + 0.5 - p.z) ** 2;
          if (d < bd) { bd = d; best = { x, y, z, id: i }; }
        }
    return best && bd <= r * r ? best : null;
  }

  return {
    refresh,
    get epoch() { return epoch; },
    get ready() { return !!cells; },
    get version() { return version; },
    get idVersion() { return idVersion; },
    get dims() { return [nx, ny, nz]; },
    queries: { id, kind, blocks, isLiquid, T, raycast, sees, standAt, hotNear, nearest },
  };
}

// A view of the renderer's world model for one consumer. getSim: the sim to
// read (every consumer passes the app's).
export function createWorldModel({ renderer, getSim }) {
  let model = models.get(renderer);
  if (!model) models.set(renderer, (model = createModel(renderer)));
  let age = 0, seen = -1;   // s since a capture landed, as this view's update() has counted them
  return {
    // call every frame: starts a readback when the last landed REFRESH_S ago
    // (any view's; until the first lands, at once)
    update(dt) {
      if (seen !== model.epoch) { seen = model.epoch; age = 0; }
      age += dt;
      if (model.epoch === 0 || age >= REFRESH_S) model.refresh(getSim);
    },
    get ready() { return model.ready; },
    get version() { return model.version; },       // bumps when a readback finds any cell's id or temperature changed
    get idVersion() { return model.idVersion; },   // bumps when it finds any cell's id changed (what blocks a body or a vehicle)
    get dims() { return model.dims; },
    ...model.queries,
  };
}
