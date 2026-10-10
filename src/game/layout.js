// Where a map's game objects are: team spawns, flag stands, hills, the siege
// core. A map (the arena agent's Dam Valley) exports exactly this shape, in
// grid cells, feet on the floor:
//
//   { name, size: [nx, ny, nz],
//     spawns: { red: [[x, y, z], ...], blue: [...] }, flags: { red: [x, y, z], blue: [x, y, z] },
//     hills: [[x, y, z, r], ...], siege: { attackers: 'red', core: [x, y, z, r] },
//     shrines: [...], vehicles: [...] }          (shrines and vehicles are other modules')
//
// labLayout is the lab preset's (presets.js 'lab', any box size): red holds the
// open north-east corner, blue the south-west one past the wooden tower. The
// glass tank, the lava pit and the sand pile are between them. Siege's core is
// blue's: they defend it first, then the sides swap.

// The lab at 128³; scaled to the box (presets.js scales the lab by nx / 128).
const LAB = {
  spawns: {
    red: [[118, 0, 8], [108, 0, 8], [118, 0, 18], [122, 0, 30], [110, 0, 16]],   // clear of the sand pile's heap (centre 85, 35)
    blue: [[8, 0, 118], [18, 0, 118], [8, 0, 108], [28, 0, 116], [16, 0, 108]],
  },
  flags: { red: [114, 0, 12], blue: [12, 0, 114] },
  // between the tank and the pit, between the tank and the tower, south of the pit's west wall
  hills: [[68, 0, 68, 7], [46, 0, 72, 6], [64, 0, 104, 6]],
  // the core: out in the open south of the tank, a run from blue's spawns (on top of them,
  // the defenders contest it forever: a capture needs the point cleared, TF2's rule)
  siege: { attackers: 'red', core: [58, 0, 84, 8] },
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
    siege: { attackers: LAB.siege.attackers, core: zone(LAB.siege.core) },
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
