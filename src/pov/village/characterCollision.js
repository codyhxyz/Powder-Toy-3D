/**
 * Horizontal character personal space, with swept contacts and tangent sliding.
 * Minecraft-style solid bodies: block motion, never push another actor.
 *
 * Integration (index.js):
 * - Use simulation coordinates for BOTH actors (resident world position minus
 *   sim.origin), not rendered/scaled root positions. Filter by vertical overlap.
 * - In collide(), resolve previous -> p.pos BEFORE the existing furniture sweep,
 *   using about 1.4 * p.size for the avatar and 1.4 for each resident (the
 *   base-size silhouette is ~2.8 wide). Do not put this behind the >20 teleport
 *   guard: ordinary large-dt/sprint motion still needs a continuous sweep.
 * - Furniture/wall correction remains authoritative. If it changes the route,
 *   validate that final route against characters again; if incompatible, keep
 *   the known-safe previous position rather than pushing through furniture.
 * - In update(), resolve each resident's current -> desired position against
 *   the player and other residents before assigning r.x/r.z. Use the same
 *   coordinates/radii and resolve sequentially with already-updated positions.
 *   Keep wall/furniture constraints on NPC motion too.
 *
 * Initial overlaps are deliberately NOT forcibly depenetrated: that could shove
 * a player into a wall. They report blocked and allow only non-deepening motion.
 * At an exact shared center, any escape direction is valid; stationary actors
 * remain stationary. Repair bad spawn positions separately with world geometry.
 */

const EPS = 1e-9;
const MAX_CONTACTS = 32;
const point = p => Number.isFinite(p?.x) && Number.isFinite(p?.z);
const validRadius = r => Number.isFinite(r) && r >= 0;

/**
 * Pure, non-mutating circle sweep; radii are required, nonnegative world units.
 * Invalid mover input fails closed; malformed obstacles are ignored. A bounded
 * contact budget stops remaining motion conservatively in crowded corners.
 * @returns {{x: number, z: number, blocked: boolean}}
 */
export function resolveCharacterMotion(from, to, radius, obstacles = []) {
  const start = point(from) ? from : { x: 0, z: 0 };
  if (!point(from) || !point(to) || !validRadius(radius)) {
    return { x: start.x, z: start.z, blocked: true };
  }
  let x = from.x, z = from.z, dx = to.x - x, dz = to.z - z;
  if (!Number.isFinite(Math.hypot(dx, dz))) return { x, z, blocked: true };
  const circles = [];
  for (const o of Array.isArray(obstacles) ? obstacles : []) {
    if (!point(o) || !validRadius(o.radius)) continue;
    const r = radius + o.radius;
    if (!Number.isFinite(r) || !Number.isFinite(Math.hypot(x - o.x, z - o.z))) {
      return { x, z, blocked: true };
    }
    circles.push({ x: o.x, z: o.z, r });
  }
  let blocked = circles.some(o => Math.hypot(x - o.x, z - o.z) < o.r);
  for (let contact = 0; contact < MAX_CONTACTS; contact++) {
    const length = Math.hypot(dx, dz);
    if (length <= EPS) return { x, z, blocked };
    const ux = dx / length, uz = dz / length;
    let nearest = length, hit = null;
    for (const o of circles) {
      const rx = x - o.x, rz = z - o.z, distance = Math.hypot(rx, rz);
      // Never deepen an existing overlap; do not invent a depenetration shove.
      const r = Math.min(o.r, distance);
      if (r === 0) continue;
      const b = rx * ux + rz * uz;
      if (b >= -EPS) continue; // outward or tangent
      // Factorized c avoids cancellation at/near the contact surface.
      const c = (distance - r) * (distance + r);
      // Perpendicular distance avoids subtracting two huge nearly equal
      // squares for long sweeps and treats exact tangency as free motion.
      const perpendicular = rx * uz - rz * ux;
      const discriminant = (r - Math.abs(perpendicular)) * (r + Math.abs(perpendicular));
      if (!Number.isFinite(c) || !Number.isFinite(discriminant)) return { x, z, blocked: true };
      if (discriminant <= 0) continue; // true tangent has no inward crossing
      const entry = c / (-b + Math.sqrt(discriminant));
      if (entry >= 0 && entry <= nearest) {
        nearest = entry;
        hit = o;
      }
    }
    if (!hit) return { x: x + dx, z: z + dz, blocked };
    blocked = true;
    // A tiny clearance prevents rounding a contact into a penetration.
    const travel = Math.max(0, nearest - EPS);
    x += ux * travel;
    z += uz * travel;
    const remaining = length - travel;
    dx = ux * remaining;
    dz = uz * remaining;
    const nx = x - hit.x, nz = z - hit.z, n = Math.hypot(nx, nz);
    if (n === 0) return { x, z, blocked };
    const inward = (dx * nx + dz * nz) / n;
    if (inward < 0) {
      dx -= inward * nx / n;
      dz -= inward * nz / n;
    }
    // Sweep the projected remainder again: sliding must not tunnel into a
    // second resident or re-enter a previous contact in a tight corner.
  }
  return { x, z, blocked: true };
}
