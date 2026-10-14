import { E } from '../elements.js';
import { QUARRY_STARTERS, baseMaterial } from './catalog.js';

// Minecraft's exposed strata and walkable block grades, with Sandustry's
// gravity-fed paydirt. All resources are ordinary, finite TPT matter.
export function buildQuarry({ g, set, box }) {
  if (g.nx !== 128 || g.ny !== 128 || g.nz !== 128) {
    throw new RangeError('Quarry requires a 128³ grid');
  }
  for (let z = 0; z < 128; z++) {
    for (let x = 0; x < 128; x++) {
      const edge = Math.min(x, z, 127 - x, 127 - z);
      let height = edge < 12 ? 32 : edge < 24 ? 24 : edge < 36 ? 16 : 8;
      // Eight-wide haul ramp: central floor to the southern rim, <=1 cell rise.
      if (x >= 72 && x < 80 && z >= 88) height = Math.min(32, 8 + Math.floor((z - 88) * 0.75));
      for (let y = 0; y < height; y++) {
        set(x, y, z, y < 2 ? E.WALL : y < 12 ? E.ROCK : y < 24 ? E.LIMESTONE : E.SANDSTONE);
      }
    }
  }

  // Exposed lower faces, reachable from the eight-high factory floor. A miner
  // placed against these faces drills real solids: GOLD -> NUGGETS, METAL -> SCRAP.
  box(44, 8, 32, 64, 14, 36, E.GOLD);
  box(92, 8, 44, 96, 14, 72, E.METAL);
  box(40, 8, 92, 60, 14, 96, E.COAL);
  // Additional deposits at deeper bench backs, not remote/infinite generators.
  box(24, 12, 44, 28, 20, 64, E.GOLD);
  box(100, 16, 48, 104, 22, 72, E.METAL);
  box(44, 16, 100, 64, 22, 104, E.COAL);

  // Shallow bench paydirt: 168 accessible nuggets plus sand, above the gold
  // wall. Excavate its lip to spill it toward catches on the factory floor.
  for (let y = 16; y < 19; y++) {
    for (let z = 28; z < 36; z++) {
      for (let x = 40; x < 68; x++) {
        set(x, y, z, (x + z * 3 + y * 5) % 4 === 0 ? E.NUGGETS : E.SAND);
      }
    }
  }
  // A second low, approachable pocket means losing the demonstration batch is
  // not a restart. Stone curb keeps this mixed stockpile off the starter line.
  box(36, 8, 38, 44, 9, 46, E.BRICK);
  for (let y = 9; y < 12; y++) {
    for (let z = 39; z < 45; z++) {
      for (let x = 37; x < 43; x++) set(x, y, z, (x + y + z) % 3 === 0 ? E.NUGGETS : E.SAND);
    }
  }

  // Finite, open reservoir. Glass retaining wall makes the water level visible;
  // a dry service shelf beside it offers several pump construction elevations.
  box(76, 3, 56, 90, 8, 78, E.GLASS);
  box(77, 4, 57, 89, 8, 77, E.WATER);
  box(70, 4, 56, 76, 8, 78, E.EMPTY);
  // Walk down from the south to the y4 shelf; four broad steps.
  for (let z = 78; z < 86; z++) {
    const height = 4 + Math.floor((z - 78) / 2);
    box(70, height, z, 76, 8, z + 1, E.EMPTY);
  }

  // Fire-safe processing yard beside the metal face. No active heat source:
  // the player's furnace must actually melt mined scrap. Raised tungsten lips
  // catch melt, with an open western mouth for a shipping/cooling line.
  box(80, 7, 36, 92, 8, 48, E.TUNGSTEN);
  box(80, 8, 36, 92, 10, 37, E.TUNGSTEN);
  box(80, 8, 47, 92, 10, 48, E.TUNGSTEN);
  box(91, 8, 37, 92, 10, 47, E.TUNGSTEN);

  // The preset owns initial decks: the runtime registers these existing bases
  // without charging or stamping them. This prevents a batch falling through
  // while asynchronous runtime setup finishes (approved integration revision).
  for (const d of QUARRY_STARTERS) box(d.x, d.y, d.z, d.x + 4, d.y + 1, d.z + 4, baseMaterial(d.type));
  // Exactly 16 gold + 8 sand, only over the upstream belt. No rewards are
  // granted here: grains have to traverse the separator and shipping mouth.
  for (let y = 9; y < 12; y++) {
    for (let z = 48; z < 52; z++) {
      for (let x = 49; x < 51; x++) set(x, y, z, (x + y + z) % 3 === 0 ? E.SAND : E.NUGGETS);
    }
  }
}
