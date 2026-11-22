import { ELEMENTS, E, K } from '../elements.js';

// Listen for a broad geological roof using only player.cellAt (the last async
// body probe). Air, trees, buildings, box walls and unloaded cells don't
// provide evidence of a cave. A high roof outside the probe is undetectable.
const ROOF_REACH = 16;   // cells above the eye; the body probe is 32 cells tall
const ROOF_OFFSETS = [[-2, 0], [2, 0], [0, -2], [0, 2]];
const STRATUM = new Set([E.ROCK, E.LIMESTONE, E.SANDSTONE, E.COAL, E.BASALT,
  E.NOITA_SNOWROCK, E.NOITA_VAULT, E.NOITA_TEMPLE, E.NOITA_LUSH,
  E.IRON_ORE, E.COPPER_ORE, E.LITHIUM_ORE, E.URANIUM_ORE, E.TUNGSTEN_ORE, E.ROCK_SALT, E.SULFUR, E.CINNABAR]);
// Moss grows on damp rock; the body probe has no moisture/ctype channel, so
// moss and mud are local signs of dampness, not direct moisture measurements.
const DAMP = new Set([E.WATER, E.SALTWATER, E.MUD, E.MOSS]);
const RADIOACTIVE = new Set([E.URANIUM_ORE, E.URANIUM, E.PLUTONIUM]);
const SCAN_PERIOD = 0.2;   // seconds; recheck the roof every tick, local cues less often
const SCAN_RADIUS = 5;     // cells around the eye
const NEARBY = [];
for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
  for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
    for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= SCAN_RADIUS ** 2) NEARBY.push([dx, dy, dz, 1 - d2 / (SCAN_RADIUS + 1) ** 2]);
    }
  }
}

function roofInColumn(cellAt, x, y, z) {
  for (let rise = 1; rise <= ROOF_REACH; rise++) {
    const id = cellAt(x, y + rise, z);
    if (id < 0) return false;
    if (STRATUM.has(id)) return true;
  }
  return false;
}

export function hasCaveRoof(cellAt, x, y, z) {
  const eye = ELEMENTS[cellAt(x, y, z)];
  if (!eye || eye.kind === K.SOLID || eye.kind === K.POWDER) return false;
  if (!roofInColumn(cellAt, x, y, z)) return false;   // open overhead, e.g. a shaft
  let covered = 0;
  for (const [dx, dz] of ROOF_OFFSETS) {
    if (roofInColumn(cellAt, x + dx, y, z + dz)) covered++;
  }
  return covered >= 3;   // a pillar/isolated overhang isn't a cavern
}

// Like Minecraft's sparse cave moods (rather than a loop); alongside drips and
// a TPT-style Geiger cue for radioactive matter. The click rate saturates as a
// vein grows: even with its interval jitter the gap is never under 1.7 s.
export function createCaveAmbience({ play, random = Math.random }) {
  let sx, sy, sz, damp, radiation;
  let scanLeft, dripLeft, geigerLeft, settleLeft;
  const between = (lo, hi) => lo + (hi - lo) * random();
  function reset() {
    scanLeft = 0;
    dripLeft = geigerLeft = settleLeft = null;
  }
  reset();

  function update(dt, { active, paused, muted, player }) {
    if (!active || paused || muted || !player || player.dead) { reset(); return false; }
    const { pos, eyeHeight, cellAt } = player;
    const x = Math.floor(pos.x), y = Math.floor(pos.y + eyeHeight), z = Math.floor(pos.z);
    if (!hasCaveRoof(cellAt, x, y, z)) { reset(); return false; }

    dt = Math.min(0.1, Math.max(0, dt));   // a stalled tab doesn't owe us a backlog
    scanLeft -= dt;
    if (scanLeft <= 0 || x !== sx || y !== sy || z !== sz) {
      sx = x; sy = y; sz = z; scanLeft = SCAN_PERIOD;
      damp = false; radiation = 0;
      for (const [dx, dy, dz, weight] of NEARBY) {
        const id = cellAt(x + dx, y + dy, z + dz);
        if (DAMP.has(id)) damp = true;
        if (RADIOACTIVE.has(id)) radiation += weight;
      }
    }

    if (damp) {
      dripLeft ??= between(4, 11);
      dripLeft -= dt;
      if (dripLeft <= 0) {
        play('caveDrip', { gain: 0.28, rate: between(0.83, 1.17) });
        dripLeft = between(4, 11);
      }
    } else dripLeft = null;

    if (radiation > 0) {
      // Advance a jittered tick budget at the current rate, so walking toward
      // a vein speeds up the very next click without restarting its timer.
      geigerLeft ??= between(0.85, 1.15);
      const intensity = radiation / (radiation + 4);
      geigerLeft -= dt * (0.07 + 0.43 * intensity);
      if (geigerLeft <= 0) {
        play('caveGeiger', { gain: 0.13 + 0.08 * intensity, rate: between(0.9, 1.1) });
        geigerLeft = between(0.85, 1.15);
      }
    } else geigerLeft = null;

    settleLeft ??= between(32, 70);
    settleLeft -= dt;
    if (settleLeft <= 0) {
      play('caveSettle', { gain: 0.22, rate: between(0.84, 1.16) });
      settleLeft = between(32, 70);
    }
    return true;
  }

  return { update, reset };
}
