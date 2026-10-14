// External sources are not voxel charges. Their immutable world-space requests
// and GPU completion words survive saves/windows; acknowledgement is not execution.
import { AIR } from './pressure.js';
export const EXTERNAL_BLAST_CAP = 64;
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e12 && Number.isFinite(Math.fround(n));
export function validExternalBlast(r) {
  return r && Array.isArray(r.position) && r.position.length === 3 && r.position.every(finite) &&
    finite(r.energy) && r.energy > 0 && finite(r.radius) && r.radius > 0;
}
export function validateExternalBlasts(s) {
  if (Object.hasOwn(s, 'externalBlasts') !== Object.hasOwn(s, 'externalBlastDone')) throw new Error('Incomplete external blast queue');
  const requests = Object.hasOwn(s, 'externalBlasts') ? s.externalBlasts : [], done = Object.hasOwn(s, 'externalBlastDone') ? s.externalBlastDone : new Uint32Array(EXTERNAL_BLAST_CAP);
  if (!Array.isArray(requests) || !(done instanceof Uint32Array) || done.length !== EXTERNAL_BLAST_CAP) throw new Error('Invalid external blast queue');
  const slots = new Set(), ids = new Set();
  for (const r of requests) {
    if (!validExternalBlast(r) || !Number.isInteger(r.slot) || r.slot < 0 || r.slot >= EXTERNAL_BLAST_CAP || slots.has(r.slot) ||
      !Number.isInteger(r.requestId) || r.requestId < 1 || r.requestId > s.sequence || ids.has(r.requestId)) throw new Error('Invalid external blast request');
    slots.add(r.slot); ids.add(r.requestId);
  }
  for (let i = 0; i < done.length; i++) if (done[i] > 1 || (done[i] && !slots.has(i))) throw new Error('Unowned external blast completion');
  return { requests: new Map(requests.map(r => [r.slot, { ...r, position: [...r.position] }])), done };
}
// External sources have no chemical product: half J to bounded damage/KE and
// half J to acoustic compression. Unlike voxel charges there is no fabricated FIRE/TNT.
export const externalBlastPressure = (pressure, energy) => Math.sqrt(pressure ** 2 + AIR.rho * AIR.sound ** 2 * energy / AIR.edge ** 3);
export function externalBlastBudget(energy, received) {
  const sum = received.reduce((a, b) => a + b, 0), scale = Math.min(1, energy * 0.5 / Math.max(sum, 1e-6));
  return received.map(e => e * scale);
}
