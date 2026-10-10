import { Graph, NavNode, NavEdge, AStar, Vector3 as YVector3 } from 'yuka';
import { E, K } from '../../elements.js';

// Where an NPC can walk: a height map of the box on a coarse grid, as a Yuka
// Graph searched with Yuka's AStar. Each node is a column NAV_CELL cells
// across, at the height a body would stand there (world.js standAt, the top of
// whatever is under the open sky, a liquid's surface included). Neighbours
// (8 ways) are joined when the step up is a jump or less; any drop is fine (no
// fall damage). Liquid columns cost more (swimming is slow), and a column
// whose top is hot (lava, fire) is left out.
//
// The graph is rebuilt from the world model when a path is asked for and the
// world has changed, at most every REBUILD_S.

export const NAV_CELL = 2;           // cells per node across
const JUMP_UP = 6;                   // cells: the highest step a jump clears (player.js: a 6.45-cell jump)
const SWIM_COST = 4;                 // × distance through a liquid column
const CLIMB_COST = 0.5;              // extra cost per cell climbed (jumping is slower than walking)
const HOT_T = 300;                   // °C: a column topped by this is impassable
const REBUILD_S = 2;                 // s: the graph is rebuilt no more often than this
const DIAG = Math.SQRT2;

export function createNav(world) {
  let graph = null, cols = 0, rows = 0, builtAt = -Infinity, builtVersion = -1;
  let heights = null, wet = null;

  const nodeAt = (x, z) => {
    const c = Math.floor(x / NAV_CELL), r = Math.floor(z / NAV_CELL);
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1;
  };

  function build() {
    const [nx, , nz] = world.dims;
    cols = Math.floor(nx / NAV_CELL); rows = Math.floor(nz / NAV_CELL);
    graph = new Graph();
    graph.digraph = true;
    heights = new Float32Array(cols * rows);
    wet = new Uint8Array(cols * rows);
    const blocked = new Uint8Array(cols * rows);
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
        heights[i] = h;
        wet[i] = liquid * 2 >= NAV_CELL * NAV_CELL ? 1 : 0;
        blocked[i] = hot ? 1 : 0;
        graph.addNode(new NavNode(i, new YVector3((c + 0.5) * NAV_CELL, h, (r + 0.5) * NAV_CELL)));
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (blocked[i]) continue;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const c2 = c + dc, r2 = r + dr;
            if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows) continue;
            const j = r2 * cols + c2;
            if (blocked[j]) continue;
            const up = heights[j] - heights[i];
            if (up > JUMP_UP) continue;
            // a diagonal needs both of its corners passable, or it cuts through a wall's corner
            if (dr && dc && (heights[r * cols + c2] - heights[i] > JUMP_UP || heights[r2 * cols + c] - heights[i] > JUMP_UP)) continue;
            const run = (dr && dc ? DIAG : 1) * NAV_CELL;
            const cost = run * (wet[j] ? SWIM_COST : 1) + Math.max(0, up) * CLIMB_COST;
            graph.addEdge(new NavEdge(i, j, cost));
          }
      }
    builtVersion = world.version;
  }

  return {
    NAV_CELL,
    // A path of waypoints ({ x, y, z } grid cells, feet) from a to b, or null if
    // there is none. now: s, for the rebuild throttle.
    path(a, b, now) {
      if (!world.ready) return null;
      if (!graph || (world.version !== builtVersion && now - builtAt >= REBUILD_S)) { build(); builtAt = now; }
      const s = nodeAt(a.x, a.z), t = nodeAt(b.x, b.z);
      if (s < 0 || t < 0) return null;
      if (s === t) return [{ x: b.x, y: b.y, z: b.z }];
      const search = new AStar(graph, s, t);
      search.search();
      if (!search.found) return null;
      return search.getPath().map((i) => { const p = graph.getNode(i).position; return { x: p.x, y: p.y, z: p.z }; });
    },
    // the stand height of the column under (x, z) as last built, or null
    heightAt(x, z) { const i = nodeAt(x, z); return i >= 0 && heights ? heights[i] : null; },
  };
}
