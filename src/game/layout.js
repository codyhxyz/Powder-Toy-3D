// Where a map's game objects are: team spawns, flag stands, hills, the siege
// points. A map (the arena agent's Dam Valley) exports exactly this shape, in
// grid cells, feet on the floor:
//
//   { name, size: [nx, ny, nz],
//     spawns: { red: [[x, y, z], ...], blue: [...] }, flags: { red: [x, y, z], blue: [x, y, z] },
//     hills: [[x, y, z, r], ...],
//     siege: { attackers: 'red', points: [[x, y, z, r], ...], spawns: [{ attack, defend }, ...], core },
//     shrines: [...], vehicles: [...] }          (shrines and vehicles are other modules')
//
// siege: the control points in the order they're taken, and per stage (before A
// falls, after A, ...) where each side spawns (siege.js has the rules; a stage
// without spawns keeps the last, and the first falls back on the team spawns).
// core is the last point, for older readers.
//
// labLayout is the lab preset's (presets.js 'lab', any box size): red holds the
// open north-east corner, blue the south-west one past the wooden tower. The
// glass tank, the lava pit and the sand pile are between them. Siege's points
// are blue's: red attacks.

// The lab at 128³; scaled to the box (presets.js scales the lab by nx / 128).
const LAB = {
  spawns: {
    red: [[118, 0, 8], [108, 0, 8], [118, 0, 18], [122, 0, 30], [110, 0, 16]],   // clear of the sand pile's heap (centre 85, 35)
    blue: [[8, 0, 118], [18, 0, 118], [8, 0, 108], [28, 0, 116], [16, 0, 108]],
  },
  flags: { red: [114, 0, 12], blue: [12, 0, 114] },
  // between the tank and the pit, between the tank and the tower, south of the pit's west wall
  hills: [[68, 0, 68, 7], [46, 0, 72, 6], [64, 0, 104, 6]],
  // Siege (siege.js): red attacks two points in turn. A in the gap between the tank and the pit, B
  // out past the wooden tower toward blue's corner (a run from blue's spawns: on top of them, the
  // defenders would contest it forever). Each side first spawns at its base; once A falls, red's
  // spawn moves up north of the pit, clear of the sand pile's heap.
  siege: {
    attackers: 'red',
    points: [[68, 0, 68, 7], [44, 0, 100, 7]],
    spawns: [{}, { attack: [[100, 0, 64], [96, 0, 58], [104, 0, 70], [92, 0, 66]] }],
  },
};

export function labLayout(g) {
  const s = g.nx / 128;
  const at = (p) => p.map((v, i) => (i === 1 ? v : Math.round(v * s)));
  const zone = ([x, y, z, r]) => [...at([x, y, z]), Math.max(3, Math.round(r * s))];
  return {
    name: 'Lab',
    size: [g.nx, g.ny, g.nz],
    spawns: { red: LAB.spawns.red.map(at), blue: LAB.spawns.blue.map(at) },
    flags: { red: at(LAB.flags.red), blue: at(LAB.flags.blue) },
    hills: LAB.hills.map(zone),
    siege: {
      attackers: LAB.siege.attackers,
      points: LAB.siege.points.map(zone),
      spawns: LAB.siege.spawns.map((st) => Object.fromEntries(Object.entries(st).map(([role, pts]) => [role, pts.map(at)]))),
      core: zone(LAB.siege.points.at(-1)),   // the last point (older readers)
    },
    shrines: [],
    vehicles: [],
  };
}

// A layout checked against the box: one for this grid, else null (and why).
export function fitLayout(layout, g) {
  if (!layout) return null;
  const inside = (p) => p && p[0] >= 0 && p[2] >= 0 && p[0] < g.nx && p[2] < g.nz && p[1] >= 0 && p[1] < g.ny;
  const ok = layout.spawns?.red?.length && layout.spawns?.blue?.length
    && [...layout.spawns.red, ...layout.spawns.blue].every(inside);
  if (!ok) { console.warn(`game: layout '${layout.name}' doesn't fit this ${g.nx}×${g.ny}×${g.nz} box; using the lab's`); return null; }
  return layout;
}
