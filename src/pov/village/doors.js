// Runtime doors inspired by Minecraft's explicit open/closed passage. A moving
// door retains its doorway barrier until the hinge reaches its open stop.
export const DOOR_SECONDS = 0.45;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function inReach(p, target, forward, range = 7) {
  if (!p || Math.abs(p.y - target.y) > 2) return false;
  const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
  return d <= range && (d < 0.15 || dx * forward.x + dz * forward.z >= d * 0.35);
}
function local(d, p) {
  const x = p.x - d.x, z = p.z - d.z;
  return { x: Math.cos(d.yaw) * x - Math.sin(d.yaw) * z, z: Math.sin(d.yaw) * x + Math.cos(d.yaw) * z };
}
function worldBox(d, b) {
  const points = [[b.x, b.z], [b.x + b.w, b.z], [b.x, b.z + b.d], [b.x + b.w, b.z + b.d]].map(([x, z]) => ({ x: d.x + Math.cos(d.yaw) * x + Math.sin(d.yaw) * z, z: d.z - Math.sin(d.yaw) * x + Math.cos(d.yaw) * z }));
  const x = Math.min(...points.map(p => p.x)), z = Math.min(...points.map(p => p.z));
  return { x, z, w: Math.max(...points.map(p => p.x)) - x, d: Math.max(...points.map(p => p.z)) - z, floor: d.floor, top: d.floor + d.height };
}
function protectedSwing(d, p, radius) {
  if (!p || p.y >= d.floor + d.height || p.y + (p.height ?? 6) <= d.floor) return false;
  const q = local(d, p);
  q.z *= d.swing;
  return q.x > -d.width / 2 - radius - 0.4 && q.x < d.width / 2 + radius + 0.4
    && q.z > -d.width - radius - 0.4 && q.z < radius + 1.2;
}
function leafSweeps(d, p, radius, from, to) {
  if (!protectedSwing(d, p, radius)) return false;
  const q = local(d, p), x = q.x + d.width / 2;
  q.z *= d.swing;
  const angle = clamp(Math.atan2(-q.z, x), from * Math.PI / 2, to * Math.PI / 2);
  const reach = clamp(x * Math.cos(angle) - q.z * Math.sin(angle), 0, d.width);
  return Math.hypot(x - reach * Math.cos(angle), q.z + reach * Math.sin(angle)) < radius + 0.25;
}
export function createDoorController(specs) {
  const doors = specs.map(d => ({ ...d, progress: 0, target: 0, swing: 1 }));
  return {
    doors,
    nearby(p, forward) { return doors.filter(d => inReach(p, { x: d.x, y: d.floor, z: d.z }, forward))
      .sort((a, b) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(p.x - b.x, p.z - b.z))[0] ?? null; },
    toggle(d, p, radius) {
      if (!doors.includes(d)) return { error: 'That door is no longer here.' };
      if (d.target === 1 && protectedSwing(d, p, radius)) return { error: 'Step clear of the doorway before closing it.' };
      // Swing away from the opener, so entering and leaving are equally usable.
      if (d.progress === 0 && p) d.swing = local(d, p).z < 0 ? -1 : 1;
      d.target = 1 - d.target;
      return {};
    },
    tick(dt, p, radius = 0.8) {
      for (const d of doors) {
        if (d.target === 0 && d.progress > 0 && protectedSwing(d, p, radius)) d.target = 1;
        const next = clamp(d.progress + Math.sign(d.target - d.progress) * Math.max(0, dt) / DOOR_SECONDS, 0, 1);
        // Check the whole swept sector, not just the next rendered angle.
        if (next > d.progress && leafSweeps(d, p, radius, d.progress, next)) continue;
        d.progress = next;
      }
    },
    colliders() {
      return doors.flatMap(d => {
        const angle = d.progress * Math.PI / 2;
        const depth = Math.sin(angle) * d.width;
        const leaf = worldBox(d, { x: -d.width / 2 - 0.2, z: d.swing > 0 ? -depth - 0.2 : -0.2, w: Math.cos(angle) * d.width + 0.4, d: depth + 0.4 });
        return d.progress === 1 ? [leaf] : [leaf, worldBox(d, { x: -d.width / 2, z: -1, w: d.width, d: 2 })];
      });
    },
    dispose() { doors.length = 0; },
  };
}
// Continuous segment/slab collision, including streaming-relative high-speed
// movement. Returns the first contact and slides the remaining motion along it.
export function resolveBoxMotion(from, to, radius, boxes) {
  let p = { x: from.x, z: from.z }, delta = { x: to.x - from.x, z: to.z - from.z }, blocked = false;
  for (let pass = 0; pass < 3; pass++) {
    let contact = null;
    for (const b of boxes) {
      const min = { x: b.x - radius, z: b.z - radius }, max = { x: b.x + b.w + radius, z: b.z + b.d + radius };
      if (p.x > min.x && p.x < max.x && p.z > min.z && p.z < max.z) {
        const face = ['x', 'z'].flatMap(axis => [
          { axis, direction: -1, distance: p[axis] - min[axis] },
          { axis, direction: 1, distance: max[axis] - p[axis] },
        ]).sort((a, b) => a.distance - b.distance)[0];
        // A spawn/rebase overlap may escape, but cannot move farther through it.
        if (delta[face.axis] * face.direction < 0) contact = { t: 0, axis: face.axis };
        continue;
      }
      let enter = -Infinity, exit = Infinity, axis = null, valid = true;
      for (const key of ['x', 'z']) {
        if (Math.abs(delta[key]) < 1e-10) { if (p[key] <= min[key] || p[key] >= max[key]) valid = false; continue; }
        const a = (min[key] - p[key]) / delta[key], c = (max[key] - p[key]) / delta[key];
        if (Math.min(a, c) > enter) { enter = Math.min(a, c); axis = key; }
        exit = Math.min(exit, Math.max(a, c));
      }
      if (valid && axis && enter >= -1e-9 && enter <= exit && enter <= 1 && exit > 0 && (!contact || enter < contact.t)) contact = { t: Math.max(0, enter), axis };
    }
    if (!contact) { p.x += delta.x; p.z += delta.z; break; }
    blocked = true;
    const t = Math.max(0, contact.t - 1e-7);
    p.x += delta.x * t; p.z += delta.z * t;
    delta.x *= 1 - t; delta.z *= 1 - t; delta[contact.axis] = 0;
  }
  return { ...p, blocked };
}
