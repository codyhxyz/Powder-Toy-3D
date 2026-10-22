// A versioned envelope keeps old clients from treating a moving window as a box.
export const PROTOCOL = 1;
// The session's build version, sent by a guest when the relay welcomes it ({ t: 'hello', v }). Builds
// before it sent none and know only FRAME_KEY/FRAME_DELTA: a host whose stream they can't read (a V2
// host's native frames, net/codec.js) sends them codec.outdatedFrame, which ends their session with
// "this version cannot load" instead of a keyframe-request loop. A guest below MIN_GUEST_VERSION is
// told to update ({ t: 'version', peer, need }); a guest meeting a newer host's frame ends with UPDATE.
// 2: native frames (net/codec.js FRAME_NATIVE_KEY/DELTA).
export const NET_VERSION = 2;
export const MIN_GUEST_VERSION = 2;
export const UPDATE_GAME = 'The host is on a newer version of the game. Reload the page to update it, then join again';
export const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e7);
export function validMetadata(m) {
  return m && m.v === PROTOCOL && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 100
    && ['box', 'world'].includes(m.mode) && typeof m.scene === 'string' && m.scene.length <= 64
    && Number.isInteger(m.seed) && m.seed >= 0 && m.seed <= 0xffffffff
    && finite3(m.origin) && m.origin.every(Number.isInteger) && m.origin[1] === 0
    && finite3(m.focus) && finite3(m.size) && m.size.every((n) => Number.isInteger(n) && n > 0)
    && typeof m.away === 'boolean';
}
export const stamp = (m) => m ? `${m.id}:${m.origin.join(',')}` : null;
export function validPose(p, m) {
  return !!m && p?.map === m.id && Number.isSafeInteger(p.seq) && p.seq >= 0
    && typeof p.active === 'boolean' && finite3(p.p) && finite3(p.vel)
    && p.vel.every((n) => Math.abs(n) <= 256) && Number.isFinite(p.yaw) && Math.abs(p.yaw) <= 1e6
    && Number.isFinite(p.pitch) && Math.abs(p.pitch) <= Math.PI / 2
    && Number.isSafeInteger(p.warp) && p.warp >= 0;
}
// LEGO Star Wars' shared-screen rule: roam freely, stop at the soft boundary,
// catch up after a host jump. Keep a full streaming step plus a body probe
// inside the actual window, rather than assuming a fixed World size.
export function leash(m, dims, point) {
  const lo = [], hi = [], target = m.focus.slice();
  for (let i = 0; i < 3; i++) {
    const margin = i === 1 ? 1 : Math.min(24, dims[i] / 4);
    lo[i] = m.origin[i] + margin;
    hi[i] = m.origin[i] + dims[i] - (i === 1 ? 7 : margin);
    target[i] = Math.max(lo[i], Math.min(hi[i], target[i]));
  }
  const outside = [0, 2].some((i) => point[i] < lo[i] || point[i] > hi[i]) || point[1] < 0 || point[1] > hi[1];
  return { lo, hi, target, outside, hard: [0, 2].some((i) => point[i] < lo[i] - 16 || point[i] > hi[i] + 16) || point[1] < -1 || point[1] > hi[1] + 16 };
}
export function interpolatePose(a, b, t) {
  if (!a || a.map !== b.map || a.warp !== b.warp || !a.active || !b.active) return { ...b, p: b.p.slice() };
  return { ...b, p: b.p.map((n, i) => a.p[i] + (n - a.p[i]) * t),
    yaw: a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * t };
}
