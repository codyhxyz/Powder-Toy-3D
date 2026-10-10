import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { GRAVITY } from './physics.js';

// How a vehicle's hull meets the sim's matter, from the CPU copy of the cells
// (ai/world.js, ≤ 0.5 s old): sample points spread through the hull, each
// standing for an equal share of its displaced volume.
//
// - Liquids lift it by Archimedes (ρ_liquid · V · g at each wet point, so a
//   half-sunk jeep rolls level) and drag it (½ ρ C_d A |v| v at each, so a jeep
//   driven into a lake slows hard). Lava is 2.5× water: a jeep floats on it.
// - Hot cells (lava, fire, a torch's mark) burn it: damage per second while any
//   sample touches one.
// - What's under each wheel (solid, powder) is surface(): the jeep reads it for
//   rolling resistance and grip, so sand bogs it down.

const DENS_KG = 100;                     // kg/m³ per unit of elements.js dens (water's 10 → 1000 kg/m³)
const DRAG_CD = 1.05;                    // drag coefficient of a bluff box: a cube's (Hoerner, Fluid-Dynamic Drag, 1965)
export const HOT_T = 300;                // °C: hotter than this burns a vehicle (ai/world.js burns a body above the same)
const KIND = ELEMENTS.map((e) => e.kind);
const DENS = ELEMENTS.map((e) => e.dens);

const wp = new THREE.Vector3(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), r = new THREE.Vector3();
const lin = new THREE.Vector3(), ang = new THREE.Vector3();

// Points in a box of half-extents (hx, hy, hz) metres, n per axis, at cell centres of the subdivision.
export function hullSamples(hx, hy, hz, [nx, ny, nz]) {
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++)
    out.push(new THREE.Vector3(((i + 0.5) / nx * 2 - 1) * hx, ((j + 0.5) / ny * 2 - 1) * hy, ((k + 0.5) / nz * 2 - 1) * hz));
  return out;
}

// Apply this step's buoyancy and drag to `body` (a Rapier rigid body) from its
// hull `samples` (local metres) displacing `volume` m³ in all. Returns
// { wet: share of samples in liquid, hot: any sample in a hot cell, liquidId }.
export function hullMatter(body, samples, volume, cells, h) {
  const t = body.translation(), rot = body.rotation();
  q.set(rot.x, rot.y, rot.z, rot.w);
  const lv = body.linvel(), av = body.angvel();
  lin.set(lv.x, lv.y, lv.z); ang.set(av.x, av.y, av.z);
  const vs = volume / samples.length;                   // m³ per sample
  const area = Math.cbrt(vs) ** 2;                       // m², its frontal area
  let wet = 0, hot = false, liquidId = -1;
  for (const s of samples) {
    r.copy(s).applyQuaternion(q);
    wp.set(t.x, t.y, t.z).add(r);
    const x = wp.x / CELL_M, y = wp.y / CELL_M, z = wp.z / CELL_M;
    const id = cells.id(x, y, z);
    if (id >= 0 && cells.T(x, y, z) > HOT_T) hot = true;
    if (id < 0 || KIND[id] !== K.LIQUID) continue;
    wet++; liquidId = id;
    const rho = DENS[id] * DENS_KG;
    // Archimedes at the point
    body.applyImpulseAtPoint({ x: 0, y: rho * vs * GRAVITY * h, z: 0 }, wp, true);
    // quadratic drag on the point's velocity (v + ω × r)
    pv.crossVectors(ang, r).add(lin);
    const sp = pv.length();
    if (sp > 1e-3) {
      const f = 0.5 * rho * DRAG_CD * area * sp * h;   // N·s per (m/s)
      // never more than stops the point's share of the body this step
      const k = Math.min(f, body.mass() / samples.length);
      body.applyImpulseAtPoint({ x: -pv.x * k, y: -pv.y * k, z: -pv.z * k }, wp, true);
    }
  }
  return { wet: wet / samples.length, hot, liquidId };
}

// What a wheel stands on at its contact point (metres) on a surface with
// normal n: the cell just under the contact's surface, as an element id (or
// the copy's OUTSIDE for the box's floor and walls).
// The wheels ride a smoothed ground (physics.js), so the contact may be over
// air in front of a step: look down a few cells for what's there.
const SURFACE_SEARCH = 3;                // cells
export function surfaceId(cells, point, normal) {
  const x = point.x / CELL_M - normal.x * 0.5, y = point.y / CELL_M - normal.y * 0.5, z = point.z / CELL_M - normal.z * 0.5;
  for (let d = 0; d < SURFACE_SEARCH; d++) {
    const id = cells.id(x, y - d, z);
    if (id !== E.EMPTY && (id < 0 || KIND[id] !== K.GAS)) return id;
  }
  return E.EMPTY;
}
export const isPowder = (id) => id >= 0 && KIND[id] === K.POWDER;
export const AIR = E.EMPTY;
