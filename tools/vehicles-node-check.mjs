// CPU-only check of the vehicles' physics (src/pov/vehicles/): Rapier in node
// against a stand-in for the cells' copy, no browser or GPU. The jeep climbs
// the grid's 0.3 m stairs at 1 in 2 (27°), the hoverbike at 1 in 3 (18°), and
// coasting from 10 m/s the jeep slows far faster on sand than on stone.
// usage: node tools/vehicles-node-check.mjs
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createPhysics } from '../src/pov/vehicles/physics.js';
import { buildJeep, JEEP } from '../src/pov/vehicles/jeep.js';
import { buildHoverbike, HOVERBIKE } from '../src/pov/vehicles/hoverbike.js';
import { E, K, ELEMENTS } from '../src/elements.js';
import { CELL_M } from '../src/scale.js';

await RAPIER.init();
const N = [128, 64, 128];
const STEP = 1 / 60;
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

// a box of cells, with the copy's interface (ai/world.js) as far as the vehicles use it
function yard(fill) {
  const ids = new Uint8Array(N[0] * N[1] * N[2]);
  const at = (x, y, z) => (y * N[2] + z) * N[0] + x;
  fill((x0, y0, z0, x1, y1, z1, id) => { for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) ids[at(x, y, z)] = id; });
  return {
    ready: true, version: 1, dims: N,
    id(x, y, z) { x = Math.floor(x); y = Math.floor(y); z = Math.floor(z); if (y >= N[1]) return E.EMPTY; if (x < 0 || y < 0 || z < 0 || x >= N[0] || z >= N[2]) return -1; return ids[at(x, y, z)]; },
    kind(i) { return i === -1 ? K.SOLID : ELEMENTS[i].kind; },
    T() { return 20; },
    isLiquid(x, y, z) { const i = this.id(x, y, z); return i >= 0 && ELEMENTS[i].kind === K.LIQUID; },
  };
}
const look = { part: (p, g) => { const m = new THREE.Mesh(g); p.add(m); return m; }, glow: (p, g) => { const m = new THREE.Mesh(g); p.add(m); return m; } };
// run one vehicle for `seconds` with input(t) → the drive input; sample(t, v) each step
function run(cells, build, spec, at, seconds, input, sample) {
  const phys = createPhysics(RAPIER, cells);
  const v = build(RAPIER, phys, look, { at: new THREE.Vector3(...at).multiplyScalar(CELL_M), yaw: 0, team: null, key: 'v' });
  for (let t = 0; t < seconds; t += STEP) {
    const p = v.body.translation();
    phys.syncTerrain([{ x: p.x / CELL_M, y: p.y / CELL_M, z: p.z / CELL_M, key: 'v', ...spec.GROUND }]);
    phys.step(STEP, (h) => v.step(h, input(t, v), cells));
    sample?.(t, v);
  }
  return v;
}
const drive = (o = {}) => ({ throttle: 0, steer: 0, brake: false, boost: false, parked: false, dead: false, ...o });
const ramp = (rise) => yard((box) => { for (let z = 64; z < 124; z++) box(40, 0, z, 88, Math.min(12, Math.floor((z - 64) / rise) + 1), z + 1, E.ROCK); });
const PLATEAU_M = 12 * CELL_M;

{
  const v = run(ramp(2), buildJeep, JEEP, [64, 0, 30], 8, (t) => drive({ throttle: t > 1 ? 1 : 0 }));
  const p = v.body.translation();
  check('jeep climbs 0.3 m stairs at 1 in 2 (27°)', p.y > PLATEAU_M + 0.6, `chassis at ${p.y.toFixed(2)} m, plateau ${PLATEAU_M.toFixed(1)} m`);
}
{
  const v = run(ramp(3), buildHoverbike, HOVERBIKE, [64, 0, 30], 7, (t) => drive({ throttle: t > 1 ? 1 : 0 }));
  const p = v.body.translation();
  check('hoverbike climbs stairs at 1 in 3 (18°)', p.y > PLATEAU_M + 0.4, `body at ${p.y.toFixed(2)} m`);
}
{
  const coast = (sand) => {
    const cells = yard((box) => { if (sand) box(4, 0, 4, 60, 3, 124, E.SAND); });
    let v0 = null, v1 = null;
    run(cells, buildJeep, JEEP, [30, sand ? 3 : 0, 14], 2.5, () => drive(), (t, v) => {
      if (Math.abs(t - 1) < STEP / 2) v.body.setLinvel({ x: 0, y: 0, z: 10 }, true);
      if (Math.abs(t - 1.2) < STEP / 2) v0 = v.speed;
      if (Math.abs(t - 2.2) < STEP / 2) v1 = v.speed;
    });
    return v0 - v1;
  };
  const stone = coast(false), sand = coast(true);
  check('coasting, sand slows the jeep at least 3× harder than stone', sand > 3 * stone && sand > 2, `${sand.toFixed(2)} vs ${stone.toFixed(2)} m/s² (rolling resistance 0.3 vs 0.015)`);
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
