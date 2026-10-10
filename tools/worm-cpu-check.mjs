// The worm's movement on the CPU (no GPU, no browser): pov/worm.js against a
// fake world model (rock up to GROUND, open air above) and a still player on
// the rock. It must tunnel toward the player, breach out of the ground and
// bite; with a WALL slab in between (`wall`), it must not get through. `giant`
// runs the giant worm (worm_big.xml) instead of the small one.
// usage: node tools/worm-cpu-check.mjs [wall] [giant]
import * as THREE from 'three';
import { createWorm } from '../src/pov/worm.js';
import { addTarget, PLAYER } from '../src/pov/targets.js';
import { E, ELEMENTS, K } from '../src/elements.js';
import { OUTSIDE } from '../src/pov/ai/world.js';

const NX = 128, NY = 96, NZ = 128, GROUND = 40, WALL_X = 70, WALL_W = 3, FPS = 60, SECONDS = 20;
const wall = process.argv.includes('wall'), size = process.argv.includes('giant') ? 'giant' : 'small';
const id = (x, y, z) => {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (y >= NY) return E.EMPTY;
  if (x < 0 || z < 0 || y < 0 || x >= NX || z >= NZ) return OUTSIDE;
  if (wall && x >= WALL_X && x < WALL_X + WALL_W) return E.WALL;
  return y < GROUND ? E.ROCK : E.EMPTY;
};
const world = { ready: true, dims: [NX, NY, NZ], id, T: () => 20, kind: (i) => (i === OUTSIDE ? K.SOLID : ELEMENTS[i].kind), standAt: () => GROUND };
let passes = 0;
const sim = { id: 1, g: { nx: NX, ny: NY, nz: NZ }, gravity: 0.025, touchCentres() {}, pass() { passes++; } };
const player = { pos: new THREE.Vector3(100, GROUND, 64), vel: new THREE.Vector3(), hurt: 0, cause: null };
addTarget({
  id: PLAYER, alive: true,
  box(min, max) { min.set(player.pos.x - 0.8, player.pos.y, player.pos.z - 0.8); max.set(player.pos.x + 0.8, player.pos.y + 5.5, player.pos.z + 0.8); },
  hurt(a, c) { player.hurt += a; player.cause = c; },
});
const worm = createWorm({ env: { getSim: () => sim }, ai: { world }, home: () => ({ x: 30, y: GROUND, z: 64 }), size });
console.log(`${size} worm${wall ? ', a WALL slab in the way' : ''}`);
const w = { player, toWorld: (g, o) => o.copy(g), worldToGrid: new THREE.Matrix4(), scale: 1 };
let maxY = -Infinity, maxX = -Infinity;
for (let f = 0; f < FPS * SECONDS; f++) {
  worm.update(1 / FPS, w);
  maxY = Math.max(maxY, worm.debug.head.y); maxX = Math.max(maxX, worm.debug.head.x);
}
const d = worm.debug;
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${info}`); };
if (wall) {
  check('WALL stops it', maxX < WALL_X && d.blocked > 0, `head x at most ${maxX.toFixed(1)} (WALL at ${WALL_X}), ${d.blocked} blocked moves`);
  check('no bites through it', d.bites === 0, `${d.bites} bites`);
} else {
  check('it digs', passes > 20, `${passes} bites of rock`);
  check('it breaches', d.breaches > 0 && maxY > GROUND + 5.5, `${d.breaches} breaches, up to ${(maxY - GROUND).toFixed(1)} cells over the ground`);
  check('it bites', d.bites > 0 && player.cause === 'Eaten by a worm', `${d.bites} bites, ${player.hurt.toFixed(2)} health, ${player.cause}`);
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
