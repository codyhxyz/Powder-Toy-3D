import { createPacker, decodeTempCode } from '../../net/codec.js';
import { ELEMENTS, E, K } from '../../elements.js';
import { BODY_HEIGHT } from '../constants.js';

// The NPCs' picture of the world: the sim's cells read back to the CPU a few
// times a second (the multiplayer packer, net/codec.js: element id and a
// temperature code per cell, read asynchronously so it never stalls a frame).
// It is up to REFRESH_S old, which is fine for deciding and aiming; the bodies
// themselves collide against their own fresh probes (player.js).
//
// Queries are in grid cells. Outside the box: the side walls and the floor are
// solid (OUTSIDE), above it is open air, as for the player's body.
//
// raycast() is Amanatides & Woo's voxel traversal ("A Fast Voxel Traversal
// Algorithm for Ray Tracing", 1987), stepping cell by cell along the ray.

const REFRESH_S = 0.5;                 // s between readbacks
export const OUTSIDE = -1;             // id of the box walls and floor
const KIND = ELEMENTS.map((e) => e.kind);
const HOT_T = 300;                     // °C: hotter than this burns a body that touches it (lava, fire, a torch's mark)

export function createWorldModel({ renderer, getSim }) {
  const packer = createPacker(renderer);
  let ids = null, temps = null, nx = 0, ny = 0, nz = 0;
  let age = Infinity, busy = false, version = 0;

  function ingest({ bytes, dims }, g) {
    [nx, ny, nz] = dims;
    const n = nx * ny * nz;
    if (!ids || ids.length !== n) { ids = new Uint8Array(n); temps = new Uint8Array(n); }
    // the atlas layout (shaders/common.js atlas()): layer y is tile (y % tx, y / tx), x across, z down
    for (let y = 0; y < ny; y++) {
      const tx0 = (y % g.tx) * nx, tz0 = Math.floor(y / g.tx) * nz;
      for (let z = 0; z < nz; z++) {
        const row = ((tz0 + z) * g.width + tx0) * 4;
        const out = (y * nz + z) * nx;
        for (let x = 0; x < nx; x++) {
          ids[out + x] = bytes[row + x * 4];
          temps[out + x] = bytes[row + x * 4 + 1];
        }
      }
    }
  }

  const inBox = (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < nx && y < ny && z < nz;
  function id(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!ids) return E.EMPTY;
    if (y >= ny) return E.EMPTY;
    if (x < 0 || z < 0 || y < 0 || x >= nx || z >= nz) return OUTSIDE;
    return ids[(y * nz + z) * nx + x];
  }
  const kind = (i) => (i === OUTSIDE ? K.SOLID : KIND[i]);
  // what stops a body: solids and powders (player.js blocks())
  const blocks = (x, y, z) => { const i = id(x, y, z); return i !== E.EMPTY && (kind(i) === K.SOLID || kind(i) === K.POWDER); };
  const isLiquid = (x, y, z) => { const i = id(x, y, z); return i !== OUTSIDE && kind(i) === K.LIQUID; };
  function T(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    return ids && inBox(x, y, z) ? decodeTempCode(temps[(y * nz + z) * nx + x]) : 20;
  }

  // The first cell along the ray (origin, unit dir) that `stops(id)` within
  // maxDist: { valid, cell, face, id, dist, point }. face is the struck face as
  // the god view's pick numbers it (axis·2, +1 for the negative side). The floor
  // (y < 0) answers as cell y = −1, id OUTSIDE, face +y.
  const STOPS_PICK = (i) => i !== E.EMPTY && kind(i) !== K.GAS;   // what the crosshair pick stops at
  function raycast(origin, dir, maxDist, stops = STOPS_PICK, out = {}) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
    const tdx = sx ? Math.abs(1 / dir.x) : Infinity, tdy = sy ? Math.abs(1 / dir.y) : Infinity, tdz = sz ? Math.abs(1 / dir.z) : Infinity;
    let tx = sx ? ((sx > 0 ? x + 1 - origin.x : origin.x - x) * tdx) : Infinity;
    let ty = sy ? ((sy > 0 ? y + 1 - origin.y : origin.y - y) * tdy) : Infinity;
    let tz = sz ? ((sz > 0 ? z + 1 - origin.z : origin.z - z) * tdz) : Infinity;
    let t = 0, face = -1;
    out.valid = false;
    for (let guard = 0; guard < 4096 && t <= maxDist; guard++) {
      const i = y >= ny ? E.EMPTY : id(x, y, z);
      if (face >= 0 && stops(i)) {
        out.valid = true; out.id = i; out.face = face; out.dist = t;
        out.cell = { x, y: Math.max(y, -1), z };
        out.point = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
        return out;
      }
      if (y >= ny + BODY_HEIGHT && sy >= 0) break;   // gone out the open top
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; face = sx > 0 ? 1 : 0; }
      else if (ty < tz) { y += sy; t = ty; ty += tdy; face = sy > 0 ? 3 : 2; }
      else { z += sz; t = tz; tz += tdz; face = sz > 0 ? 5 : 4; }
    }
    return out;
  }

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
    for (let yy = Math.min(Math.floor(y), ny - 1); yy >= -1; yy--) {
      if (yy < 0) return 0;   // the floor
      const i = id(x, yy, z);
      if (i === E.EMPTY || kind(i) === K.GAS) continue;
      return yy + 1;
    }
    return 0;
  }

  // Is anything that burns a body (very hot) within r cells of p?
  function hotNear(p, r) {
    if (!ids) return false;
    for (let y = Math.floor(p.y - r); y <= p.y + r; y++)
      for (let z = Math.floor(p.z - r); z <= p.z + r; z++)
        for (let x = Math.floor(p.x - r); x <= p.x + r; x++)
          if (inBox(x, y, z) && decodeTempCode(temps[(y * nz + z) * nx + x]) > HOT_T) return true;
    return false;
  }

  // The nearest cell within r of p whose id passes want(id), by a box scan: { x, y, z, id } or null.
  function nearest(p, r, want) {
    if (!ids) return null;
    let best = null, bd = Infinity;
    const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(nx - 1, Math.floor(p.x + r));
    const y0 = Math.max(0, Math.floor(p.y - r)), y1 = Math.min(ny - 1, Math.floor(p.y + r));
    const z0 = Math.max(0, Math.floor(p.z - r)), z1 = Math.min(nz - 1, Math.floor(p.z + r));
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const i = ids[(y * nz + z) * nx + x];
          if (!want(i)) continue;
          const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2 + (z + 0.5 - p.z) ** 2;
          if (d < bd) { bd = d; best = { x, y, z, id: i }; }
        }
    return best && bd <= r * r ? best : null;
  }

  return {
    // call every frame: starts a readback when the last is REFRESH_S old
    update(dt) {
      age += dt;
      if (busy || age < REFRESH_S) return;
      const sim = getSim();
      if (!sim) return;
      const job = packer.pack(sim);
      if (!job) return;
      busy = true;
      const g = sim.g;
      job.then((r) => { ingest(r, g); r.release(); age = 0; version++; })
        .catch((err) => console.error('NPC world readback failed', err))
        .finally(() => { busy = false; });
    },
    get ready() { return !!ids; },
    get version() { return version; },   // bumps with every readback
    get dims() { return [nx, ny, nz]; },
    id, kind, blocks, isLiquid, T, raycast, sees, standAt, hotNear, nearest,
  };
}
