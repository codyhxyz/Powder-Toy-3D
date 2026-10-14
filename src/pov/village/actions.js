// Minecraft's short, directional melee reach, but toy knockback only: no health or damage.
export const PUNCH_REACH = 4.5, PUNCH_COOLDOWN = 0.45, PUNCH_DURATION = 0.3;
export const VILLAGE_TOOLS = [
  { key: null, name: 'Hands', hint: 'Click or F to punch · harmless bonks, never damage.' },
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
// Keep the neighbors in their clear cottage aisle, away from furniture and walls.
export function stepResident(r, dt, time, walking) {
  const step = Math.min(0.05, Math.max(0, dt));
  if (r.bonk > 0) {
    r.x = Math.max(-1, Math.min(1, r.x + r.vx * step));
    r.z = Math.max(-8, Math.min(8, r.z + r.vz * step));
    r.vx *= Math.exp(-7 * step); r.vz *= Math.exp(-7 * step);
    r.bonk = Math.max(0, r.bonk - dt);
  } else if (walking) {
    const follow = 1 - Math.exp(-3 * step);
    r.x += (Math.sin(time * 0.28 + r.spec.home) * 0.65 - r.x) * follow;
    r.z += (Math.sin(time * 0.42 + r.spec.home) * 4 - r.z) * follow;
  }
}
export function punchOccluded(hit, start, distance) {
  if (!hit?.valid) return false;
  const c = hit.cell;
  const nearest = Math.hypot(Math.max(c.x - start.x, 0, start.x - c.x - 1),
    Math.max(c.y - start.y, 0, start.y - c.y - 1), Math.max(c.z - start.z, 0, start.z - c.z - 1));
  return nearest < Math.max(0, distance - 1.2);
}
