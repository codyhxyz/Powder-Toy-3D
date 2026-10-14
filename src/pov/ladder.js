import { CELL_M } from '../scale.js';
import { convexOverlapsBox } from '../world/import/convexVolume.js';

// Cruelty Squad Player.gd: on a ladder, forward/back follows the view at
// move_speed / 2 (9 / 2 m/s), without gravity. Ladder.gd uses body overlap.
export const LADDER_SPEED = 4.5 / CELL_M;

export function overlapsLadder(ladders, feet, width, height) {
  const low = [feet.x - width / 2, feet.y, feet.z - width / 2];
  const high = [feet.x + width / 2, feet.y + height, feet.z + width / 2];
  return (ladders ?? []).some(({ bounds, axes }) => bounds &&
    low.every((n, k) => n < bounds.max[k] && high[k] > bounds.min[k]) &&
    (!axes || convexOverlapsBox(axes, [feet.x, feet.y + height / 2, feet.z], [width / 2, height / 2, width / 2])));
}

export function ladderVelocity(out, direction) {
  if (!direction || ![direction.x, direction.y, direction.z].every(Number.isFinite)) return out.set(0, 0, 0);
  return out.copy(direction).clampLength(0, 1).multiplyScalar(LADDER_SPEED);
}
