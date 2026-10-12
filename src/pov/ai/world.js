import { createPacker, decodeTempCode, TEXEL_BYTES } from '../../net/codec.js';
import { ELEMENTS, E, K } from '../../elements.js';
import { cellTexel } from '../../sim.js';
import { BRICK } from '../../shaders/common.js';
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
// On WebGPU (docs/webgpu.md C2, G4) it is the multiplayer packer's capture
// (net/codec.js createPacker): its kernel writes every cell's word at its
// atlas texel, the readback service copies it at the call (B7, so the bytes
// are the state at the call; only a grid's first capture, while its kernel
// builds, is taken once it is built), and the mapped range is copied into
// one of the packer's pooled byte buffers. One packer per device, whatever
// the grid: a new grid frees the old one's buffers. (The renderer is the
// WebGL build's; each simulation brings its own gpu.)
const packers = new WeakMap();         // gpu → its packer
export function readCells(renderer, sim) {
  let packer = packers.get(sim.gpu);
  if (!packer) packers.set(sim.gpu, (packer = createPacker()));
  const g = sim.g, job = packer.pack(sim);
  return job && job.then(({ bytes, dims, release }) => {
    let released = false;   // (exactly once: a second release would put its buffer in the pool twice)
    return { bytes, g, dims, release: (back) => { if (!released) { released = true; release(back); } } };
  });
}

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
