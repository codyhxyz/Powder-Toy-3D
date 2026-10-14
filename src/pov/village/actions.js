// Minecraft's short, directional melee reach, but toy knockback only: no health or damage.
export const PUNCH_REACH = 4.5, PUNCH_COOLDOWN = 0.2, PUNCH_DURATION = 0.2;
export const PUNCH_CONTACT = PUNCH_DURATION * 0.4;
export const VILLAGE_TOOLS = [
  { key: null, name: 'Hands', hint: 'Left-click to punch · F to kick · harmless bonks, never damage.' },
  { key: 'SHOVEL', name: 'Shovel', primary: 'Dig', secondary: 'Dump', hint: 'Dig soil and sand. Right-click to dump your pack.' },
  { key: 'PICKAXE', name: 'Pickaxe', primary: 'Mine', hint: 'Mine stone. Keep digging to break harder blocks.' },
  { key: 'TROWEL', name: 'Trowel', primary: 'Build', secondary: 'Next material', hint: 'Build with dug material. Right-click changes material.' },
];
export function punchTarget(player, yaw, residents, home) {
  if (!player || home < 1 || Math.abs(player.y) > 3) return null;
  const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  return residents.filter(r => r.spec.home === home).map(r => {
    const dx = r.x - player.x, dz = r.z - player.z, distance = Math.hypot(dx, dz);
    return { resident: r, dx, dz, distance };
  }).filter(t => t.distance <= PUNCH_REACH && (t.distance < 0.01 || (t.dx * forward.x + t.dz * forward.z) / t.distance >= 0.55))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}
// Halo-like knockback with friction; keep the cottage's clear aisle and stop at walls.
export function stepResident(r, dt, time, walking) {
  const elapsed = Math.max(0, Math.min(0.25, dt)), steps = Math.max(1, Math.ceil(elapsed * 120)), step = elapsed / steps;
  for (let i = 0; i < steps; i++) {
    if (r.bonk > 0) {
      const decay = Math.exp(-3 * step), travel = (1 - decay) / 3;
      r.x += r.vx * travel; r.z += r.vz * travel;
      r.vx *= decay; r.vz *= decay;
    } else {
      // Wander from the landing spot, never lerp back to a pre-hit path.
      const follow = 1 - Math.exp(-3 * step);
      r.vx += ((walking ? Math.cos(time * 0.28 + r.spec.home) * 0.18 : 0) - r.vx) * follow;
      r.vz += ((walking ? Math.cos(time * 0.42 + r.spec.home) * 1.4 : 0) - r.vz) * follow;
      r.x += r.vx * step; r.z += r.vz * step;
    }
    if (r.x < -1 || r.x > 1) { r.x = Math.max(-1, Math.min(1, r.x)); r.vx = 0; }
    if (r.z < -8 || r.z > 8) { r.z = Math.max(-8, Math.min(8, r.z)); r.vz = 0; }
    r.y = Math.max(0, (r.y ?? 0) + (r.vy ?? 0) * step - 12 * step * step);
    r.vy = r.y > 0 ? (r.vy ?? 0) - 24 * step : 0;
    r.bonk = Math.max(0, r.bonk - step);
  }
}
export function punchOccluded(hit, start, distance) {
  if (!hit?.valid) return false;
  const c = hit.cell;
  const nearest = Math.hypot(Math.max(c.x - start.x, 0, start.x - c.x - 1),
    Math.max(c.y - start.y, 0, start.y - c.y - 1), Math.max(c.z - start.z, 0, start.z - c.z - 1));
  return nearest < Math.max(0, distance - 1.2);
}
