import { E } from '../elements.js';
import { CELL_M } from '../scale.js';

// A slow Halo-style navigation landmark, not atmosphere: only actual matter
// scatters its light. The 16-second sweep uses the simulation clock.
export const LIGHTHOUSE = Object.freeze({
  period: 16, range: 300 / CELL_M, intensity: 1800, radius: 2,
  inner: Math.cos(7 * Math.PI / 180), outer: Math.cos(12 * Math.PI / 180),
  color: [1, 0.72, 0.38], captureInterval: 0.25,
});
export function lighthouseNight(phase) {
  if (!Number.isFinite(phase)) return 0;
  return Math.max(0, Math.min(1, -Math.sin((phase - 0.25) * Math.PI * 2) / 0.16));
}
export function lighthouseDirection(time) {
  const a = (Number.isFinite(time) ? time : 0) * Math.PI * 2 / LIGHTHOUSE.period;
  const norm = Math.hypot(1, 0.035);
  return [Math.cos(a) / norm, -0.035 / norm, Math.sin(a) / norm];
}
export const lighthouseInside = (cell, origin, g) =>
  cell.every((v, i) => v >= origin[i] && v < origin[i] + [g.nx, g.ny, g.nz][i]);

// Read the generated, baked, rotated CRYSTAL lamp, never scenery or duplicated
// tower dimensions. Its lower crystal is the physical switch: remove it and
// the beacon stays off for this world epoch, including after streaming out.
export function lighthouseLantern(structures) {
  const st = structures.find((s) => s.kind === 'lighthouse' || (s.key === 'TOWER' && s.variant === 'lighthouse'));
  if (!st) return null;
  const { s } = st, cells = [];
  for (let z = 0; z < s.d; z++) for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    if (Math.round(s.data[((z * s.h + y) * s.w + x) * 4]) - 1 === E.CRYSTAL) {
      cells.push([st.x0 + x, st.y - s.base.y + y, st.z0 + z]);
    }
  }
  if (!cells.length) return null;
  return { cell: cells[0], position: [0, 1, 2].map((i) => cells.reduce((n, c) => n + c[i] + 0.5, 0) / cells.length) };
}
