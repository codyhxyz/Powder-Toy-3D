// CPU check of the body perks (Slow Fall, Shrink, Rain Cloud) in node, no GPU and no server:
// the real body (src/pov/player.js) over a mock sim whose probe readback is filled from a
// voxel function, so collision, falling and the cloud's seeding run the shipped code.
// usage: node tools/perks-cpu-check.mjs
import * as THREE from 'three';
import { createPlayer } from '../src/pov/player.js';
import { createPerkSet } from '../src/pov/perks.js';
import { E } from '../src/elements.js';
import { PROBE } from '../src/shaders/povBody.js';

const STEPS = 4;            // sim steps per frame (240 steps/s at 60 fps)
const DT = 1 / 60;
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

// a world: cell(x, y, z) → element id; the floor and walls of the box are the probe's own
function makeSim(cell, n = [64, 160, 64]) {
  const paints = [];
  const sim = {
    g: { nx: n[0], ny: n[1], nz: n[2] }, frame: 0, gravity: 0.025, stateA: null, stateB: null,
    run(mat, target) { if (mat.uniforms.uBoxLo) target.box = mat.uniforms.uBoxLo.value.clone(); },
    touchCentres() {}, pass() {},
    paint(o) { paints.push({ ...o, center: o.center.clone() }); },
    paints,
  };
  const renderer = {
    readRenderTargetPixelsAsync(target, x, y, w, h, buf) {
      const b = target.box;
      for (let ly = 0; ly < PROBE.Y; ly++) for (let lz = 0; lz < PROBE.Z; lz++) for (let lx = 0; lx < PROBE.X; lx++) {
        const i = ((ly * PROBE.Z + lz) * PROBE.X + lx) * 4;
        const cx = b.x + lx, cy = b.y + ly, cz = b.z + lz;
        const out = cx < 0 || cz < 0 || cy < 0 || cx >= n[0] || cz >= n[2] || cy >= n[1];
        buf[i] = out ? -1 : cell(cx, cy, cz); buf[i + 1] = 20; buf[i + 2] = 0; buf[i + 3] = 0;
      }
      return Promise.resolve();
    },
  };
  return { sim, renderer };
}

async function run(body, sim, frames, input = {}, each = null) {
  for (let f = 0; f < frames; f++) {
    sim.frame += STEPS;
    body.update(DT, input);
    each?.(f);
    await new Promise((r) => setImmediate(r));
  }
}

function makeBody(cell, keys = [], n) {
  const { sim, renderer } = makeSim(cell, n);
  const perks = createPerkSet();
  keys.forEach((k) => perks.add(k));
  const body = createPlayer({ renderer, getSim: () => sim, quiet: true, perks });
  return { body, sim, perks };
}

// ---- Slow Fall: landing speed after a long drop
const open = () => E.EMPTY;
async function drop(keys) {
  const { body, sim } = makeBody(open, keys);
  body.spawn(new THREE.Vector3(32, 120, 32));
  let land = 0, maxDown = 0;
  body.on('land', (e) => { land = e.speed; });
  await run(body, sim, 600, {}, () => { maxDown = Math.max(maxDown, -body.vel.y); });
  return { land, maxDown, y: body.pos.y };
}
const plain = await drop([]);
const slow = await drop(['SLOW_FALL']);
const slow2 = await drop(['SLOW_FALL', 'SLOW_FALL']);
const tiny = await drop(['SLOW_FALL', 'SHRINK']);
check('Slow Fall: lands at a parachute\'s 5.8 m/s (19.3 cells/s)', Math.abs(slow.land - 5.8 / 0.3) < 0.5 && plain.land > 3 * slow.land,
  `landing ${plain.land.toFixed(1)} plain, ${slow.land.toFixed(1)} with one, ${slow2.land.toFixed(1)} with two, ${tiny.land.toFixed(1)} shrunk (cells/s)`);
check('Slow Fall: each stack ÷√2, Shrink ÷√2 more', Math.abs(slow2.land * Math.SQRT2 - slow.land) < 0.5 && Math.abs(tiny.land * Math.SQRT2 - slow.land) < 0.5);

// ---- Slow Fall: the jetpack still climbs
{
  const { body, sim } = makeBody(open, ['SLOW_FALL']);
  body.spawn(new THREE.Vector3(32, 0, 32));
  await run(body, sim, 30);
  const y0 = body.pos.y;
  await run(body, sim, 1, { jump: true });
  await run(body, sim, 60, { jump: true });
  check('Slow Fall: the jetpack still climbs', body.pos.y > y0 + 20, `rose ${(body.pos.y - y0).toFixed(1)} cells in 1 s of jet`);
}

// ---- Shrink: a crack 2 cells wide and 3 tall in a wall the full height of the box
const crack = (x, y, z) => (x === 40 && !(z >= 31 && z <= 32 && y <= 2) ? E.WALL : E.EMPTY);
async function walkAt(keys) {
  const { body, sim } = makeBody(crack, keys);
  body.spawn(new THREE.Vector3(34, 0, 32));
  await run(body, sim, 30);
  await run(body, sim, 240, { move: { x: 1, z: 0 }, sprint: false });
  return { x: body.pos.x, h: body.height, w: body.width, eye: body.eyeHeight, size: body.size };
}
const big = await walkAt([]);
const small = await walkAt(['SHRINK']);
check('Shrink: half the size', Math.abs(small.h - 2.75) < 1e-9 && Math.abs(small.w - 0.8) < 1e-9 && Math.abs(small.eye - 2.5) < 1e-9, JSON.stringify(small));
check('Shrink: the plain body stops at the crack, the shrunk one gets through', big.x < 40 && small.x > 41, `plain x ${big.x.toFixed(2)}, shrunk x ${small.x.toFixed(2)} (wall at 40)`);
{
  const p = createPerkSet(); for (let i = 0; i < 6; i++) p.add('SHRINK');
  check('Shrink: never under a cell tall', Math.abs(p.size * 5.5 - 1) < 1e-9, `${(p.size * 5.5).toFixed(3)} cells`);
}

// ---- Shrink: jump apex in body heights is kept (Froude), a blow throws it 8× as fast
async function jump(keys) {
  const { body, sim } = makeBody(open, keys);
  body.spawn(new THREE.Vector3(32, 0, 32));
  await run(body, sim, 30);
  let top = 0;
  await run(body, sim, 1, { jump: true });
  await run(body, sim, 90, {}, () => { top = Math.max(top, body.pos.y); });
  return top / body.height;
}
const jb = await jump([]), js = await jump(['SHRINK']);
check('Shrink: a jump clears the same body heights', Math.abs(jb - js) / jb < 0.08, `${jb.toFixed(2)} vs ${js.toFixed(2)} body heights`);
async function knock(keys) {
  const { body, sim } = makeBody(open, keys);
  body.spawn(new THREE.Vector3(32, 40, 32));
  await run(body, sim, 3);
  const v0 = body.vel.clone();
  body.applyImpulse(new THREE.Vector3(4, 0, 0));
  await run(body, sim, 1);
  return body.vel.x - v0.x;
}
const kb = await knock([]), ks = await knock(['SHRINK']);
check('Shrink: a blow throws it size⁻³ = 8× as fast', Math.abs(ks / kb - 8) < 0.2, `Δv ${kb.toFixed(2)} vs ${ks.toFixed(2)} cells/s`);

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
