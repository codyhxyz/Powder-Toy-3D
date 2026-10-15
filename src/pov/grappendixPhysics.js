import { CELL_M } from '../scale.js';

// Flat-screen Cruelty Squad, July 2023 scripts, not XRTools' replacement grapple:
// CruS-Modding-Infrastructure/crus-project-setup-tool@199c95d, Scripts/Player.gd
// grapple(), ground_move(), air_move(), accelerate(), air_control(), apply_friction().
export const CRUELTY_GRAVITY = 22 / CELL_M;
export const CRUELTY_JUMP = 8 / CELL_M;
export const CRUELTY_SPEED = 9 / CELL_M;
// Long-range voxel adaptation, not source parity: flat-screen weapon.gd uses
// <20 m; VRPlayer.tscn uses 30 m. Keep source force/controls, extend traversal
// to 100 m and bound runaway/moving-anchor cables at 200 m (docs/grappendix.md).
export const GRAPPENDIX_RANGE = 100 / CELL_M;
export const GRAPPENDIX_MAX_CABLE = 200 / CELL_M;

export function grappendixFactor(distanceCells) {
  const meters = distanceCells * CELL_M;
  // Preserve the original strict comparisons, including the seams at exactly 10 and 20 m.
  if (meters > 3 && meters < 10) return 1;
  if (meters > 10 && meters < 20) return 0.7;
  if (meters > 20) return 2;
  return 0;
}

export function pullGrappendix(velocity, center, anchor, gravity, dt) {
  const x = anchor.x - center.x, y = anchor.y - center.y, z = anchor.z - center.z;
  const distance = Math.hypot(x, y, z);
  if (!distance) return;
  const push = gravity * 2.3 * grappendixFactor(distance) * dt / distance;
  velocity.x += x * push;
  velocity.y += y * push;
  velocity.z += z * push;
}

// The original grapple relies on Quake-style ground friction and unbraked air momentum.
// Use its baseline movement while attached, through the released flight, and in its mission mode.
export function crueltyMove(velocity, wish, { grounded, jumpPressed, yaw = 0, speedScale = 1, jumpScale = 1 }, dt) {
  const magnitude = wish.length();
  const x = magnitude ? wish.x / magnitude : 0, z = magnitude ? wish.y / magnitude : 0;
  const wishSpeed = CRUELTY_SPEED * speedScale * (grounded ? Math.min(1, magnitude > 0 ? 1 : 0) : magnitude);
  if (grounded) {
    const speed = Math.hypot(velocity.x, velocity.z);
    const remaining = Math.max(0, speed - Math.max(10 / CELL_M, speed) * 6 * dt);
    if (speed) { velocity.x *= remaining / speed; velocity.z *= remaining / speed; }
    velocity.y = jumpPressed ? CRUELTY_JUMP * jumpScale : 0;
  }
  const along = velocity.x * x + velocity.z * z;
  const acceleration = grounded ? 10 : along < 0 ? 20 : 2;
  const added = Math.min(Math.max(0, wishSpeed - along), acceleration * dt * wishSpeed);
  velocity.x += x * added; velocity.z += z * added;
  const forward = wish.x * -Math.sin(yaw) + wish.y * -Math.cos(yaw);
  if (!grounded && Math.abs(forward) > 1e-8 && wishSpeed) {
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed) {
      const dot = (velocity.x * x + velocity.z * z) / speed;
      if (dot > 0) {
        const steer = 64 / CELL_M * dot * dot * dt;
        const nx = velocity.x + x * steer, nz = velocity.z + z * steer;
        const n = Math.hypot(nx, nz);
        velocity.x = nx / n * speed; velocity.z = nz / n * speed;
      }
    }
  }
  return grounded && jumpPressed;
}
