// Canonical sparse terrain changes. A door owns ONLY cells proved exclusive by
// the importer, never its bounding box. No new sparse bricks are allocated.
export function decodeImportedIndex(map, index) {
  return [index % map.size[0], Math.floor(index / map.size[0]) % map.size[1], Math.floor(index / (map.size[0] * map.size[1]))];
}
export function createImportedInteractionState(map, words, changed = () => {}) {
  const originals = new Map(), states = new Map();
  let epoch = 0;
  function write(cells, ids) {
    const touched = new Set();
    for (let i = 0; i < cells.length; i += 2) {
      const [x, y, z] = decodeImportedIndex(map, cells[i]), d = map.brickDims;
      const brick = words[Math.floor(x / 8) + d[0] * (Math.floor(y / 8) + d[1] * Math.floor(z / 8))];
      if (!brick) throw new Error('Door ownership references an empty brick');
      const local = x % 8 + 8 * (y % 8 + 8 * (z % 8)), at = brick + (local >> 2), shift = (local & 3) * 8;
      const id = ids[i / 2];
      if (!originals.has(at)) originals.set(at, words[at]);
      words[at] = ((words[at] & ~(255 << shift)) | (id << shift)) >>> 0;
      touched.add(at);
    }
    // Small sorted contiguous runs; SceneGpu uploads only these packed words.
    const sorted = [...touched].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      const from = sorted[i++]; let end = from + 1;
      while (sorted[i] === end) { end++; i++; }
      changed(from, words.subarray(from, end));
    }
  }
  return {
    get epoch() { return epoch; },
    states,
    open(door, alive) {
      if (!door.supported) return false;
      states.set(door.sourcePath, { open: true, alive: Uint8Array.from(alive), elapsed: 0 });
      write(door.cells, alive.map(() => 0));
      return true;
    },
    close(door, restored) {
      const state = states.get(door.sourcePath);
      if (!state?.open) return false;
      // A destroyed/replaced cell cannot be resurrected by a subsequent cycle.
      const alive = Uint8Array.from(restored, (v, i) => v && state.alive[i] ? 1 : 0);
      write(door.cells, Array.from(alive, (v, i) => v ? door.cells[i * 2 + 1] : 0));
      states.set(door.sourcePath, { open: false, alive, elapsed: 0 });
      return true;
    },
    reset() {
      epoch++;
      for (const [at, word] of originals) { words[at] = word; changed(at, words.subarray(at, at + 1)); }
      originals.clear(); states.clear();
    },
  };
}
