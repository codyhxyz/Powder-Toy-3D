import { E, K } from '../../elements.js';
import { OUTSIDE, voxelRay } from '../ai/world.js';

// The cells' copy (ai/world.js) in world cells, for the vehicles. Their rigid
// bodies, voxels and ray grounds live in the world's frame (a box's is its own
// grid: origin 0), so a World's window moving over the world (docs/scaling.md
// D11) moves nothing in Rapier, as Minecraft's entities keep world
// coordinates while chunks load and unload around the player. A query is
// shifted by the origin of the window the copy was read from, not the
// window's current one: the copy lands a readback after the window moves, and
// until then it still answers for the cells where they are.
//
// Past the copy's window, in x and z: the world's own edge is solid (the sim's
// window edge is, EDGE.SOLID, and the window stops there), and so is the floor;
// the rest isn't known, so it is open air, never a phantom wall. Vehicles
// whose hull isn't inside the copy wait, parked (index.js), and the driven one
// is always inside it (the window follows its driver, and a moved window
// asks for its copy at once: update(dt, soon)).
//
// A box's queries are the model's own functions (no shift, nothing past it but
// its walls), so a box's terrain sync costs what it did before; the view swaps
// them in whenever it sees a new capture (update, and the getters physics.js
// reads before it queries).
const BOX = { origin: [0, 0, 0], world: null };   // a model with no frame (a stand-in): a box's

export function worldCells(model) {
  let ox = 0, oz = 0, nx = 0, ny = 0, nz = 0, wx = 0, wz = 0, windowed = false, frame = null;
  const boxId = model.id, kind = model.kind;   // (ai/world.js's queries are plain functions: called unbound)
  // the copy's frame (and size), re-read only when a capture has landed: each brings its own
  function sync() {
    const at = model.at ?? BOX;
    if (at === frame) return;
    frame = at;
    [ox, , oz] = at.origin;
    [nx, ny, nz] = model.dims;
    windowed = !!at.world;
    if (windowed) [wx, , wz] = at.world;
    view.id = windowed ? worldId : boxId;
  }
  function worldId(x, y, z) {
    sync();
    if (!windowed) return model.id(x, y, z);
    x = Math.floor(x); z = Math.floor(z);
    const lx = x - ox, lz = z - oz;
    if (lx >= 0 && lz >= 0 && lx < nx && lz < nz) return model.id(lx, y, lz);
    if (y >= ny) return E.EMPTY;                                             // open above, as in the copy
    return y < 0 || x < 0 || z < 0 || x >= wx || z >= wz ? OUTSIDE : E.EMPTY;   // the floor and the world's edge; else unknown: air
  }
  const id = (x, y, z) => view.id(x, y, z);
  const blocks = (x, y, z) => { const i = view.id(x, y, z); return i !== E.EMPTY && (kind(i) === K.SOLID || kind(i) === K.POWDER); };
  const isLiquid = (x, y, z) => { const i = view.id(x, y, z); return i !== OUTSIDE && i !== E.EMPTY && kind(i) === K.LIQUID; };
  function T(x, y, z) {
    sync();
    return windowed ? model.T(x - ox, y, z - oz) : model.T(x, y, z);   // (20 °C past the copy, as past a box)
  }
  const STOPS_PICK = (i) => i !== E.EMPTY && kind(i) !== K.GAS;
  const raycast = (origin, dir, maxDist, stops = STOPS_PICK, out = {}) => { sync(); return voxelRay(id, ny, origin, dir, maxDist, stops, out); };
  // world-cell bounds, inclusive (ai/world.js hasIdChanges)
  function hasIdChanges(b, since) {
    if (!model.hasIdChanges) return true;
    sync();
    if (!windowed) return model.hasIdChanges(b, since);
    return model.hasIdChanges({ x0: b.x0 - ox, x1: b.x1 - ox, y0: b.y0, y1: b.y1, z0: b.z0 - oz, z1: b.z1 - oz }, since);
  }
  // Is everything in the world-cell box [x0, x1] × [z0, z1] known to the copy:
  // inside its window, or past the world's edge (solid)?
  function knows(x0, z0, x1, z1) {
    if (!model.ready) return false;
    sync();
    if (!windowed) return true;
    return (x0 >= ox || ox <= 0) && (z0 >= oz || oz <= 0) && (x1 < ox + nx || ox + nx >= wx) && (z1 < oz + nz || oz + nz >= wz);
  }
  const view = {
    update(dt, soon) { model.update(dt, soon); sync(); },
    get ready() { sync(); return model.ready; },
    get version() { sync(); return model.version; },
    get idVersion() { sync(); return model.idVersion; },
    get dims() { sync(); return model.dims; },
    // the world cell of the copy's cell (0, 0, 0): the mirror of the voxels follows it (physics.js)
    get origin() { sync(); return frame.origin; },
    id: boxId, kind, blocks, isLiquid, T, raycast, hasIdChanges, knows,
  };
  sync();
  return view;
}
