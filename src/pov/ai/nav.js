import { E, K } from '../../elements.js';

// Where an NPC can walk: a height map of the box on a coarse grid, searched
// with A*. Each node is a column NAV_CELL cells across, at the height a body
// would stand there (world.js standAt, the top of whatever is under the open
// sky, a liquid's surface included). Neighbours (8 ways) are joined when the
// step up is a jump or less; any drop is fine (no fall damage). Liquid columns
// cost more (swimming is slow), and a column whose top is hot (lava, fire) is
// left out.
//
// The map is flat typed arrays kept for the life of the box: the graph is the
// grid itself (a node's edges are a bit mask over its 8 neighbours, their
// costs worked out as the search walks them), and the search keeps its own
// arrays and a binary heap on typed arrays, so neither a rebuild nor a search
// makes garbage. (It was a Yuka Graph of NavNode/NavEdge objects, ~8k nodes and
// up to ~65k edges on Dam Valley, rebuilt every 2 s, and a Yuka AStar with its
// Maps per search: GC spikes with 7 bots.)
//
// The search is Yuka's AStar step for step (its frontier rules, its binary
// heap's sift order, the Euclidean distance between node positions as the
// heuristic), so it finds the paths Yuka's did. That heuristic counts the
// height difference while a drop costs only its step, so it can overestimate:
// paths are good rather than always the cheapest, as before.
//
// The height map is derived again from the world model when a path is asked
// for and the model has read back since, at most every REBUILD_S; the links
// are redone only if a height, a liquid or a hot top actually changed.

export const NAV_CELL = 2;           // cells per node across
const JUMP_UP = 6;                   // cells: the highest step a jump clears (player.js: a 6.45-cell jump)
const SWIM_COST = 4;                 // × distance through a liquid column
const CLIMB_COST = 0.5;              // extra cost per cell climbed (jumping is slower than walking)
const HOT_T = 300;                   // °C: a column topped by this is impassable
const REBUILD_S = 2;                 // s: the map is derived again no more often than this
const DIAG = Math.SQRT2;

// The 8 neighbours in the order a node's edges are tried: rows, then columns,
// −1..1 (the order Yuka's graph held them in, which the search's ties follow).
const NDC = [-1, 0, 1, -1, 1, -1, 0, 1];
const NDR = [-1, -1, -1, 0, 0, 1, 1, 1];
const RUN = NDC.map((dc, k) => (dc && NDR[k] ? DIAG : 1) * NAV_CELL);   // cells walked along each

export function createNav(world) {
  let cols = 0, rows = 0, n = 0, built = false, builtAt = -Infinity, builtVersion = -1;
  // the map: per node
  let heights = null, wet = null, blocked = null, links = null;
  // the search's: per node (mark: < open: unseen; open: on the frontier; open + 1: done), and the heap
  let cost = null, via = null, parent = null, mark = null, open = 0;
  let heapF = new Float64Array(1024), heapI = new Int32Array(1024), heapN = 0;
  const off = new Int32Array(8);      // index step to each neighbour
  const stats = { derived: 0, relinked: 0, searches: 0 };

  const nodeAt = (x, z) => {
    const c = Math.floor(x / NAV_CELL), r = Math.floor(z / NAV_CELL);
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1;
  };

  function alloc() {
    n = cols * rows;
    heights = new Float32Array(n); wet = new Uint8Array(n); blocked = new Uint8Array(n); links = new Uint8Array(n);
    cost = new Float64Array(n); via = new Int32Array(n); parent = new Int32Array(n); mark = new Uint32Array(n); open = 0;
    for (let k = 0; k < 8; k++) off[k] = NDR[k] * cols + NDC[k];
  }

  // Derive the height map from the world model, in place; relink if it changed.
  function derive() {
    const [nx, , nz] = world.dims;
    const c1 = Math.floor(nx / NAV_CELL), r1 = Math.floor(nz / NAV_CELL);
    let changed = c1 !== cols || r1 !== rows;
    if (changed) { cols = c1; rows = r1; alloc(); }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        // the column's stand height: the highest of its cells' (the body spans them)
        let h = 0, liquid = 0, hot = false;
        for (let dz = 0; dz < NAV_CELL; dz++)
          for (let dx = 0; dx < NAV_CELL; dx++) {
            const x = c * NAV_CELL + dx, z = r * NAV_CELL + dz;
            const y = world.standAt(x, z);
            if (y > h) h = y;
            const top = world.id(x, y - 1, z);
            if (top !== E.EMPTY && world.kind(top) === K.LIQUID) liquid++;
            if (world.T(x, y - 1, z) > HOT_T) hot = true;
          }
        const w = liquid * 2 >= NAV_CELL * NAV_CELL ? 1 : 0, b = hot ? 1 : 0;
        if (heights[i] !== h || wet[i] !== w || blocked[i] !== b) { heights[i] = h; wet[i] = w; blocked[i] = b; changed = true; }
      }
    builtVersion = world.version;
    stats.derived++;
    if (changed) { relink(); stats.relinked++; }
  }

  // Each node's edges, as a bit per neighbour (k: NDC/NDR).
  function relink() {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let m = 0;
        if (!blocked[i]) {
          for (let k = 0; k < 8; k++) {
            const dc = NDC[k], dr = NDR[k], c2 = c + dc, r2 = r + dr;
            if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows) continue;
            const j = r2 * cols + c2;
            if (blocked[j]) continue;
            if (heights[j] - heights[i] > JUMP_UP) continue;
            // a diagonal needs both of its corners passable, or it cuts through a wall's corner
            if (dr && dc && (heights[r * cols + c2] - heights[i] > JUMP_UP || heights[r2 * cols + c] - heights[i] > JUMP_UP)) continue;
            m |= 1 << k;
          }
        }
        links[i] = m;
      }
  }

  // The binary heap of (F, node), Yuka's PriorityQueue: same sift order, so
  // equal Fs come out in the same order. A node can be in it more than once.
  function push(f, i) {
    if (heapN === heapF.length) {
      const f2 = new Float64Array(heapN * 2), i2 = new Int32Array(heapN * 2);
      f2.set(heapF); i2.set(heapI); heapF = f2; heapI = i2;
    }
    let k = heapN++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!(f < heapF[p])) break;
      heapF[k] = heapF[p]; heapI[k] = heapI[p]; k = p;
    }
    heapF[k] = f; heapI[k] = i;
  }
  function pop() {
    const top = heapI[0];
    if (--heapN > 0) {
      const f = heapF[heapN], i = heapI[heapN], half = heapN >> 1;
      let k = 0;
      while (k < half) {
        let l = 2 * k + 1;
        if (l + 1 < heapN && heapF[l + 1] < heapF[l]) l++;
        if (!(heapF[l] < f)) break;
        heapF[k] = heapF[l]; heapI[k] = heapI[l]; k = l;
      }
      heapF[k] = f; heapI[k] = i;
    }
    return top;
  }

  // A* from node s to node t (Yuka's AStar.search): is there a path? parent[] holds it.
  function search(s, t) {
    if (open >= 0xfffffffc) { mark.fill(0); open = 0; }
    open += 2;
    const OPEN = open, DONE = open + 1;
    const ct = t % cols, rt = (t / cols) | 0, ht = heights[t];
    stats.searches++;
    heapN = 0;
    push(0, s);
    while (heapN > 0) {
      const i = pop(), mi = mark[i];
      if (mi === DONE) continue;
      // the source comes off unseen (cost 0) and isn't done: it's done if it comes back via a neighbour
      if (mi === OPEN) { mark[i] = DONE; parent[i] = via[i]; }
      if (i === t) return true;
      const m = links[i];
      if (!m) continue;
      const g = mi === OPEN ? cost[i] : 0, h = heights[i];
      const dc0 = i % cols - ct, dr0 = ((i / cols) | 0) - rt;
      for (let k = 0; k < 8; k++) {
        if (!(m & (1 << k))) continue;
        const j = i + off[k];
        const up = heights[j] - h;
        const G = g + (RUN[k] * (wet[j] ? SWIM_COST : 1) + Math.max(0, up) * CLIMB_COST);
        const mj = mark[j];
        if (mj >= OPEN && !(G < cost[j])) continue;   // on the frontier (or done) already, as cheap
        cost[j] = G; via[j] = i;
        if (mj < OPEN) mark[j] = OPEN;
        const dx = (dc0 + NDC[k]) * NAV_CELL, dy = heights[j] - ht, dz = (dr0 + NDR[k]) * NAV_CELL;
        push(G + Math.sqrt(dx * dx + dy * dy + dz * dz), j);
      }
    }
    return false;
  }

  const point = (i) => ({ x: (i % cols + 0.5) * NAV_CELL, y: heights[i], z: (((i / cols) | 0) + 0.5) * NAV_CELL });

  return {
    NAV_CELL,
    // A path of waypoints ({ x, y, z } grid cells, feet) from a to b, or null if
    // there is none. now: s, for the rebuild throttle.
    path(a, b, now) {
      if (!world.ready) return null;
      if (!built || (world.version !== builtVersion && now - builtAt >= REBUILD_S)) { derive(); built = true; builtAt = now; }
      const s = nodeAt(a.x, a.z), t = nodeAt(b.x, b.z);
      if (s < 0 || t < 0) return null;
      if (s === t) return [{ x: b.x, y: b.y, z: b.z }];
      if (!search(s, t)) return null;
      let len = 1;
      for (let i = t; i !== s; i = parent[i]) if (++len > n) return null;   // (can't happen: parents were done first)
      const out = new Array(len);
      for (let i = t, k = len - 1; k >= 0; i = parent[i], k--) out[k] = point(i);
      return out;
    },
    // the stand height of the column under (x, z) as last built, or null
    heightAt(x, z) { const i = nodeAt(x, z); return i >= 0 && heights ? heights[i] : null; },
    stats,   // { derived, relinked, searches }: map derivations, those that changed it, A* runs
  };
}
