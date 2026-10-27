import { E } from '../elements.js';
import { finite3 } from './protocol.js';
import { HAND_REACH } from '../pov/constants.js';

// Independent capability handshake: these fields never enter terrain metadata.
export const CONTROL_VERSION = 1;
export const CONTROL_POSE_MAX_AGE_MS = 500;
export const validControlContext = c => c?.v === CONTROL_VERSION && typeof c.id === 'string'
  && c.id.length > 0 && c.id.length < 256 && finite3(c.origin) && c.origin.every(Number.isInteger)
  && finite3(c.size) && c.size.every(n => Number.isInteger(n) && n > 0);
export function validControlPose(p, c) {
  return validControlContext(c) && p?.v === CONTROL_VERSION && p.context === c.id
    && ['use', 'god'].includes(p.source) && Number.isSafeInteger(p.seq) && p.seq > 0
    && Number.isSafeInteger(p.warp) && p.warp >= 0 && typeof p.active === 'boolean'
    && finite3(p.p) && Number.isFinite(p.eyeHeight) && p.eyeHeight > 0 && p.eyeHeight <= 5
    && Number.isFinite(p.crouch) && p.crouch >= 0 && p.crouch <= 1
    && Number.isFinite(p.yaw) && Math.abs(p.yaw) <= 1e6
    && Number.isFinite(p.pitch) && Math.abs(p.pitch) <= Math.PI / 2
    && (p.source !== 'god' || (finite3(p.dir) && Math.abs(Math.hypot(...p.dir) - 1) < 1e-6))
    && (p.source === 'god' || p.p.every((n, i) => n >= c.origin[i] - 1 && n < c.origin[i] + c.size[i]));
}
export function controlIntentRay(m, { context: c, peer, pose, now }) {
  if (!validControlContext(c) || peer?.role !== 'guest' || m?.v !== CONTROL_VERSION
      || m.context !== c.id || m.source !== pose?.source || m.poseSeq !== pose?.seq
      || !Number.isSafeInteger(m.seq) || m.seq < 1
      || !Array.isArray(m.cell) || m.cell.length !== 3 || !m.cell.every(Number.isSafeInteger)
      || ![E.SWITCH, E.BUTTON].includes(m.material) || !validControlPose(pose, c) || !pose.active
      || !Number.isFinite(pose.at) || now < pose.at || now - pose.at > CONTROL_POSE_MAX_AGE_MS
      || m.cell.some((n, i) => n < c.origin[i] || n >= c.origin[i] + c.size[i])) return null;
  // eyeHeight includes interpolated crouch and Shrink. God p is the captured
  // pointer-ray origin, not a fabricated avatar position.
  const eye = pose.p.map((n, i) => n + (i === 1 && pose.source === 'use' ? pose.eyeHeight : 0));
  if (m.source === 'use' && Math.hypot(...m.cell.map((n, i) => n + .5 - eye[i])) > HAND_REACH) return null;
  const cp = Math.cos(pose.pitch);
  return { eye, dir: pose.source === 'god' ? pose.dir.slice()
    : [-Math.sin(pose.yaw) * cp, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cp],
    source: m.source, expected: { cell: m.cell.slice(), material: m.material } };
}
export function createControlIntentGuard() {
  const seen = new Map();
  return {
    take(m, context) {
      const ray = controlIntentRay(m, context); if (!ray) return null;
      const prev = seen.get(context.peer.id);
      if (prev && (m.seq <= prev.seq || context.now - prev.at < 150)) return null;
      seen.set(context.peer.id, { seq: m.seq, at: context.now }); return ray;
    },
    forget(peer) { seen.delete(peer); },
    reset() { seen.clear(); },
  };
}

// Heartbeats prove liveness only for this exact committed terrain envelope.
export function validControlBaseline(b, c) {
  return validControlContext(c) && b?.generation === c.id
    && Number.isSafeInteger(b.seq) && b.seq > 0
    && finite3(b.size) && b.size.every((n, i) => n === c.size[i])
    && finite3(b.origin) && b.origin.every((n, i) => n === c.origin[i])
    && (b.stamp === null || typeof b.stamp === 'string');
}
export function controlBaselineMatches(b, applied, c, sim) {
  return !!sim && validControlBaseline(b, c) && applied?.sim === sim && b.seq === applied.seq
    && b.stamp === applied.stamp && b.size.every((n, i) => n === applied.size[i])
    && b.origin.every((n, i) => n === applied.origin[i])
    && b.size.every((n, i) => n === [sim.g.nx, sim.g.ny, sim.g.nz][i])
    && b.origin.every((n, i) => n === sim.origin.toArray()[i]);
}
