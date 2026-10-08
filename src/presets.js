import { E, ELEMENTS } from './elements.js';
import { SEED_MAX } from './shaders/common.js';

// CPU-side scene builders. They produce the atlas-layout state arrays that
// Simulation.load() uploads.
export function buildPreset(name, sim) {
  const g = sim.g;
  const [A, B] = sim.blankState();
  const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
  const set = (x, y, z, id, extra = {}) => {
    if (!inside(x, y, z)) return;
    const i = idx(x, y, z);
    const e = ELEMENTS[id];
    A[i] = id;
    A[i + 1] = extra.temp ?? e.temp;
    A[i + 2] = e.life;
    A[i + 3] = (extra.ctype ?? 0) + Math.random() * SEED_MAX;
  };
  const box = (x0, y0, z0, x1, y1, z1, id, extra) => {
    for (let y = y0; y < y1; y++)
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) set(x, y, z, id, extra);
  };
  const { nx, ny, nz } = g;
  const cx = nx / 2, cz = nz / 2;
  const s = nx / 128;

  if (name === 'lab') {
    // Glass tank of water with an oil slick, a sand pile and a metal plate over a lava pit.
    const t0 = Math.round(10 * s), t1 = Math.round(62 * s), th = Math.round(40 * s);
    box(t0, 0, t0, t1, th, t1, E.GLASS);
    box(t0 + 1, 1, t0 + 1, t1 - 1, th, t1 - 1, E.EMPTY);
    box(t0 + 1, 1, t0 + 1, t1 - 1, Math.round(24 * s), t1 - 1, E.WATER);
    box(t0 + 1, Math.round(24 * s), t0 + 1, t1 - 1, Math.round(28 * s), t1 - 1, E.OIL);
    // ice cube floating-ish
    box(t0 + 8, Math.round(21 * s), t0 + 8, t0 + 18, Math.round(31 * s), t0 + 18, E.ICE);

    // lava pit under a metal plate with a block of ice on top
    const l0 = Math.round(76 * s), l1 = Math.round(116 * s);
    box(l0, 0, l0, l1, Math.round(10 * s), l1, E.WALL);
    box(l0 + 2, 1, l0 + 2, l1 - 2, Math.round(10 * s), l1 - 2, E.LAVA, { ctype: E.STONE });
    box(l0, Math.round(10 * s), l0, l1, Math.round(12 * s), l1, E.METAL);
    box(l0 + 12, Math.round(12 * s), l0 + 12, l1 - 12, Math.round(16 * s), l1 - 12, E.SNOW);

    // wooden tower with gunpowder core
    const w0 = Math.round(20 * s), w1 = Math.round(34 * s);
    const zz0 = Math.round(80 * s), zz1 = Math.round(94 * s);
    box(w0, 0, zz0, w1, Math.round(50 * s), zz1, E.WOOD);
    box(w0 + 3, Math.round(4 * s), zz0 + 3, w1 - 3, Math.round(46 * s), zz1 - 3, E.GUNPOWDER);
    box(w0 + 5, 0, zz0 - 6, w1 - 5, Math.round(3 * s), zz0, E.OIL);

    // sand pile hanging in the air, about to fall
    box(Math.round(70 * s), Math.round(70 * s), Math.round(20 * s), Math.round(100 * s), Math.round(90 * s),
      Math.round(50 * s), E.SAND);
  } else if (name === 'volcano') {
    const R = Math.round(54 * s);
    const H = Math.round(48 * s);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const d = Math.hypot(x - cx + 0.5, z - cz + 0.5);
        const h = Math.max(0, Math.round(H * (1 - d / R)));
        for (let y = 0; y < h; y++) set(x, y, z, E.ROCK);
        // sea around it
        for (let y = h; y < Math.round(8 * s); y++) set(x, y, z, E.WATER);
      }
    // conduit + magma chamber
    for (let y = 0; y < H + 2; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const d = Math.hypot(x - cx + 0.5, z - cz + 0.5);
          const r = y < 14 * s ? 12 * s * (1 - y / (16 * s)) + 4 * s : 3.5 * s;
          if (d < r) set(x, y, z, E.LAVA, { temp: 1900, ctype: E.STONE });
        }
    // An endless lava source on the summit. (A buried source would just seal
    // itself in: the cellular automaton has no magma pressure to push lava up.)
    box(Math.round(cx - 2 * s), H - 1, Math.round(cz - 2 * s), Math.round(cx + 2 * s), H + 1,
      Math.round(cz + 2 * s), E.CLONE, { ctype: E.LAVA });
    // trees on the flanks
    for (let k = 0; k < 14; k++) {
      const ang = (k / 14) * Math.PI * 2 + 0.3;
      const d = R * (0.55 + 0.25 * ((k * 7) % 3) / 2);
      const x = Math.round(cx + Math.cos(ang) * d), z = Math.round(cz + Math.sin(ang) * d);
      const base = Math.max(0, Math.round(H * (1 - d / R)));
      const th = Math.round(8 * s);
      box(x, base, z, x + 1, base + th, z + 1, E.WOOD);
      for (let y = 0; y < 5 * s; y++)
        for (let dz = -3; dz <= 3; dz++)
          for (let dx = -3; dx <= 3; dx++)
            if (dx * dx + dz * dz + (y - 2) * (y - 2) < 9 * s * s)
              set(x + dx, base + th + y - 1, z + dz, E.PLANT);
    }
    // snow cap
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const d = Math.hypot(x - cx + 0.5, z - cz + 0.5);
        if (d > 6 * s && d < 20 * s) {
          const h = Math.round(H * (1 - d / R));
          box(x, h, z, x + 1, h + 2, z + 1, E.SNOW);
        }
      }
  }
  sim.load(A, B);
}
