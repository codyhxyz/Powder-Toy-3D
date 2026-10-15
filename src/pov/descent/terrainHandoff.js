// Source-space transitions only. No folded AABBs and no terrain modifications.
import { BODY_HEIGHT, BODY_WIDTH } from '../constants.js';
export function startsDescentRun(previous, next, levels) {
  return next.sourceRegion ? !previous : levels.indexOf(next) === 0;
}

export function bandHandoff(levels, current, source) {
  if (!source || !source.every(Number.isFinite)) return null;
  const [x, y, depth] = source, f = current.fold;
  if (x < f.sourceMinX || x >= f.sourceMinX + f.sourceWidth || Math.abs(depth) >= f.thickness / 2) return null;
  const target = levels.find((l) => y >= l.sourceRegion.core[0] && y < l.sourceRegion.core[1]);
  if (!target || target.key === current.key) return null;
  // Only real neighboring cores; never jump across an excluded source section.
  const a = current.sourceRegion.core, b = target.sourceRegion.core;
  if (a[0] !== b[1] && a[1] !== b[0]) return null;
  return { next: target, source: [...source], kind: 'band', preserveMomentum: true };
}

export function nativePortalHandoff(levels, current, source, feet = null) {
  const [x, y, depth] = source;
  let minX=x, maxX=x, minY=y, maxY=y;
  // Transform the real upright body corners back into the native chart,
  // rather than testing an oversized folded-world trigger box.
  if (feet && current.toSource) for (const dx of [-BODY_WIDTH/2,BODY_WIDTH/2]) for (const dz of [-BODY_WIDTH/2,BODY_WIDTH/2]) for (const dy of [0,BODY_HEIGHT]) {
    const p=current.toSource([feet.x+dx,feet.y+dy,feet.z+dz]);
    if (p) { minX=Math.min(minX,p[0]); maxX=Math.max(maxX,p[0]); minY=Math.min(minY,p[1]); maxY=Math.max(maxY,p[1]); }
  }
  for (const portal of current.nativePortals ?? []) {
    if (!portal.enabled || minX > portal.source[0]+portal.halfSize[0] || maxX < portal.source[0]-portal.halfSize[0] || minY > portal.source[1]+portal.halfSize[1] || maxY < portal.source[1]-portal.halfSize[1]) continue;
    const next = levels.find((l) => portal.target[1] >= l.sourceRegion.core[0] && portal.target[1] < l.sourceRegion.core[1]);
    if (next) return { next, source: [portal.target[0], portal.target[1], depth], kind: 'portal', portalId: portal.id, preserveMomentum: false };
  }
  return null;
}

// Motion is deliberately separate from inventory/health/status: the existing
// player and run objects survive scene loading and must never be respawned.
export function captureMotion(player, look) {
  return { velocity: [player.vel.x, player.vel.y, player.vel.z], yaw: look.yaw, pitch: look.pitch };
}
export function restoreMotion(player, setLook, motion, preserveMomentum = true) {
  player.vel.set(...(preserveMomentum ? motion.velocity : [0, 0, 0]));
  setLook(motion.yaw, motion.pitch);
}
