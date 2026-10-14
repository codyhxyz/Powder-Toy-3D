// Original flat-screen Grappendix formulas + real body/controller over CPU probes; no GPU.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CELL_M } from '../src/scale.js';
import { createPlayer } from '../src/pov/player.js';
import { createGrappendix } from '../src/pov/grappendix.js';
import { CRUELTY_GRAVITY, CRUELTY_JUMP, GRAPPENDIX_RANGE, GRAPPENDIX_MAX_CABLE, grappendixFactor, pullGrappendix, crueltyMove } from '../src/pov/grappendixPhysics.js';
import { setPovGpu } from '../src/pov/gpu.js';
import { PROBE, PROBE_CELLS } from '../src/shaders/povBody.js';
import { E } from '../src/elements.js';
import { addTarget } from '../src/pov/targets.js';
import hookDef from '../src/pov/tools/hook.tool.js';
import { voxelRay } from '../src/pov/ai/world.js';
import { TRACE, TRACE_BYTES, TRACE_MISS } from '../src/shaders/povTrace.js';
import { K, ELEMENTS } from '../src/elements.js';
import { grappleFarCells } from '../src/pov/grappendixTrace.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { BRICK } from '../src/shaders/common.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

{
  const store = new BrickStore([16, 16, 16]);
  const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
  // Non-symmetric Y/Z catches a mistaken transpose that a uniform brick hides.
  A[(0 + BRICK * (1 + BRICK * 2)) * 4] = E.ROCK;
  store.put(store.key(1, 1, 1), encodeBrick(A, 0, B, 0));
  const cell = grappleFarCells({ store, size: [64, 64, 64], scene: { importManifest: {}, cell: () => E.EMPTY } });
  assert.equal(cell(4, 5, 6), E.ROCK, 'saved edit reads actual slab XYZ order');
  assert.equal(cell(4, 6, 5), E.EMPTY, 'saved edits are not transposed into ghost obstacles');
}

for (const [meters, factor] of [[0, 0], [3, 0], [3.01, 1], [9.99, 1], [10, 0], [10.01, 0.7], [19.99, 0.7], [20, 0], [20.01, 2], [80, 2]]) {
  near(grappendixFactor(meters / CELL_M), factor);
}
for (const fps of [30, 60, 120]) {
  const velocity = new THREE.Vector3(0, 0, 30);
  for (let i = 0; i < fps; i++) pullGrappendix(velocity, new THREE.Vector3(), new THREE.Vector3(15 / CELL_M, 0, 0), CRUELTY_GRAVITY, 1 / fps);
  near(velocity.x * CELL_M, 22 * 2.3 * 0.7);
  near(velocity.z, 30, 1e-8);
}
const velocity = new THREE.Vector3(60, 0, 0);
crueltyMove(velocity, new THREE.Vector2(), { grounded: false }, 1 / 60);
near(velocity.x, 60);
crueltyMove(velocity, new THREE.Vector2(), { grounded: true, jumpPressed: true }, 1 / 60);
near(velocity.x, 54);
near(velocity.y, CRUELTY_JUMP);
const diagonal = new THREE.Vector3();
crueltyMove(diagonal, new THREE.Vector2(1, -1), { grounded: false }, 1 / 60);
near(diagonal.length() * CELL_M, Math.SQRT2 * 9 * 2 / 60);
console.log('ok source distance bands/seams, gravity-scaled acceleration, tangent momentum, ground friction, jump, FPS');

async function fixture(fps = 60) {
  const sim = { origin: new THREE.Vector3(), g: { nx: 512, ny: 256, nz: 512 }, frame: 0, gravity: 0.025, touchCentres: () => [], paint() {} };
  let anchorId = E.ROCK, resolveRead;
  let world = null, liveSource = () => E.EMPTY, holdTrace = false, completeTrace;
  const liveCells = new Map();
  const idAt = (x, y, z) => y < 0 ? -1 : (x < 0 || x >= sim.g.nx || y >= sim.g.ny || z < 0 || z >= sim.g.nz) ? E.EMPTY
    : liveCells.get(`${x},${y},${z}`) ?? liveSource(x, y, z);
  let holdRead = false;
  setPovGpu(sim, {
    ready: true, edit: () => true, transfer: () => null,
    probe(name, params) {
      const { boxLo: lo } = params;
      if (name === 'povTrace') {
        const origin = new THREE.Vector3(...params.starts[0]), end = new THREE.Vector3(...params.ends[0]);
        const length = origin.distanceTo(end), dir = end.sub(origin).normalize();
        const hit = voxelRay(idAt, sim.g.ny, origin, dir, length, id => id < 0 || (id !== E.EMPTY && ELEMENTS[id]?.kind !== K.GAS));
        const b = new Float32Array(TRACE_BYTES / 4); b[3] = TRACE_MISS;
        if (hit.valid) {
          b.set([hit.cell.x, hit.cell.y, hit.cell.z, hit.face]); b[TRACE.ROUNDS * 4 + 3] = hit.id;
          b.set([hit.point.x, hit.point.y, hit.point.z, hit.dist / length], 2 * TRACE.ROUNDS * 4);
        }
        return holdTrace ? new Promise(resolve => { completeTrace = () => resolve(b.buffer); }) : Promise.resolve(b.buffer);
      }
      if (name === 'povCells') return holdRead ? new Promise(resolve => { resolveRead = resolve; })
        : Promise.resolve(new Float32Array([anchorId, 20, 0, 0]).buffer);
      const buf = new Float32Array(PROBE_CELLS * 4);
      for (let y = 0; y < PROBE.Y; y++) for (let z = 0; z < PROBE.Z; z++) for (let x = 0; x < PROBE.X; x++) {
        const i = ((y * PROBE.Z + z) * PROBE.X + x) * 4;
        buf[i] = lo[1] + y < 1 ? E.WALL : E.EMPTY; buf[i + 1] = 20;
      }
      return Promise.resolve(buf.buffer);
    },
  });
  const body = createPlayer({ renderer: {}, getSim: () => sim, quiet: true });
  const scene = new THREE.Scene(), volume = new THREE.Group(); scene.add(volume);
  const grapple = createGrappendix({ scene, getSim: () => sim, getWorld: () => world, getVolume: () => volume, getScale: () => 1 });
  const ctx = {
    dt: 1 / fps, sim, player: { body }, eye: new THREE.Vector3(), dir: new THREE.Vector3(),
    aim: { valid: true, cell: new THREE.Vector3(), id: E.ROCK, face: 1, dist: 0 },
  };
  const frame = async (input = {}) => {
    sim.frame += 4; body.update(ctx.dt, input);
    ctx.eye.copy(body.pos).setY(body.pos.y + body.eyeHeight);
    grapple.update(ctx); await flush();
  };
  const frames = async (n, input = {}) => { for (let i = 0; i < n; i++) await frame(input); };
  body.spawn(new THREE.Vector3(200, 1, 200)); await frames(5);
  const attach = async cell => {
    liveCells.clear();
    if (ctx.aim.valid) liveCells.set(cell.toArray().join(','), ctx.aim.id);
    ctx.aim.cell.copy(cell);
    const point = cell.clone().addScalar(0.5).add(new THREE.Vector3(-0.5, 0, 0));
    ctx.dir.subVectors(point, ctx.eye).normalize(); ctx.aim.dist = point.distanceTo(ctx.eye);
    if (!ctx.aim.valid) ctx.dir.set(0, 1, 0);
    await grapple.toggle(ctx);
  };
  return { sim, scene, body, grapple, ctx, frame, frames, attach, liveCells,
    world(v) { world = v; },
    liveSource(v) { liveSource = v; },
    holdTrace(v) { holdTrace = v; },
    completeTrace() { completeTrace(); },
    anchorId(id) { anchorId = id; },
    holdRead(v) { holdRead = v; },
    completeRead(id) { resolveRead(new Float32Array([id, 20, 0, 0]).buffer); },
    dispose() { grapple.dispose(); body.dispose(); } };
}

for (const fps of [30, 60, 120]) {
  const f = await fixture(fps), { body, grapple, attach, frames, ctx } = f;
  try {
    await attach(new THREE.Vector3(250, 6, 200));
    assert.ok(grapple.active && body.rope.grappendix, 'instant attachment without projectile flight');
    assert.equal(body.rope.hard, false, 'no fixed-length rope constraint');
    await frames(Math.round(fps / 5));
    const groundedSpeed = body.vel.x;
    assert.ok(body.onGround && groundedSpeed < 2, 'source ground friction holds you back until jumping');
    await frames(Math.round(fps / 3), { jump: true });
    assert.ok(!body.onGround && body.vel.x > groundedSpeed + 10, 'jump escapes ground friction and launches forward');
    assert.equal(body.jetting, false, 'holding jump does not substitute Noita jet thrust for source physics');
    const velocity = body.vel.clone();
    await grapple.toggle(ctx);
    assert.equal(body.rope, null);
    assert.deepEqual(body.vel.toArray(), velocity.toArray(), 'release keeps full momentum');
    await frames(1);
    near(body.vel.x, velocity.x);
    console.log(`ok ${fps} fps instantaneous attach, ground pull, jump launch, no jet, release momentum`);
  } finally { f.dispose(); }
}

{
  const f = await fixture(), { body, grapple, attach, frame, frames, ctx, scene } = f;
  try {
    await attach(new THREE.Vector3(210, 50, 200));
    const length = body.pos.distanceTo(grapple.rope.anchor);
    await frame({ jump: true });
    assert.equal(scene.children.find(o => o.isInstancedMesh).count, 4, 'source grows one flesh-orb batch per frame');
    await frames(24);
    assert.ok(body.pos.distanceTo(grapple.rope.anchor) < length - 5, 'overhead continuously draws you inward, never fixed length');
    const mesh = scene.children.find(o => o.isInstancedMesh);
    assert.ok(mesh.visible && mesh.count > 0, 'original pulsating flesh-orb line is drawn');
    const anchor = grapple.rope.anchor.clone();
    body.windowShifted(16, -8); grapple.windowShifted(16, -8);
    near(grapple.rope.anchor.x, anchor.x - 16); near(grapple.rope.anchor.z, anchor.z + 8);
    // Near the anchor original acceleration turns off but attachment remains.
    body.teleport(new THREE.Vector3(180, 30, 180)); await frame();
    assert.equal(grapple.active, false, 'teleport severed the tether');
    await attach(new THREE.Vector3(182, 32, 180));
    await frames(2);
    assert.equal(grapple.active, true, 'no auto-release within the original 3 m dead zone');
    const held = body.rope;
    grapple.release(); await attach(new THREE.Vector3(184, 32, 180));
    assert.ok(grapple.active && body.rope !== held, 'immediate refire, no added cooldown/retraction');
    ctx.aim.valid = false; await grapple.toggle(ctx);
    assert.equal(grapple.active, false, 'E releases even while aimed at sky');
  } finally { f.dispose(); }
}

for (const why of ['sky', 'powder', 'range']) {
  const f = await fixture(), { grapple, attach, ctx } = f;
  try {
    ctx.aim.valid = why !== 'sky'; ctx.aim.id = why === 'powder' ? E.SAND : E.ROCK;
    await attach(new THREE.Vector3(why === 'range' ? 535 : 230, 6, 200));
    assert.equal(grapple.active, false, why);
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { sim, body, grapple, ctx, attach } = f;
  try {
    sim.g.windowed = true;
    await attach(new THREE.Vector3(220, 6, 200));
    body.windowShifted(256, 0); grapple.windowShifted(256, 0);
    f.anchorId(E.EMPTY); grapple.update(ctx); await flush();
    assert.ok(grapple.active, 'streaming eviction does not masquerade as anchor destruction');
    body.windowShifted(-256, 0); grapple.windowShifted(-256, 0);
    grapple.update(ctx); await flush();
    assert.equal(grapple.active, false, 'resident destruction is checked again after the window returns');
  } finally { f.dispose(); }
}
for (const within of [true, false]) {
  const f = await fixture(), { grapple, ctx } = f;
  try {
    ctx.aim.cell.set(460, 20, 200);
    f.liveCells.set('460,20,200', E.ROCK);
    const point = new THREE.Vector3(460, within ? 20.01 : 20.99, 200.99);
    const distance = GRAPPENDIX_RANGE + (within ? -0.001 : 0.001);
    ctx.eye.set(460 - Math.sqrt(distance ** 2 - (point.y - 1) ** 2), 1, point.z);
    ctx.dir.subVectors(point, ctx.eye).normalize();
    ctx.aim.dist = distance;
    await grapple.toggle(ctx);
    assert.equal(grapple.active, within, '100 m gate uses the actual crosshair ray hit, not the cell face center');
    if (within) assert.ok(grapple.rope.anchor.distanceTo(point) < 1e-4);
  } finally { f.dispose(); }
}
for (const why of ['tear', 'release', 'death', 'replacement']) {
  const f = await fixture(), { body, grapple, attach, frame } = f;
  try {
    await attach(new THREE.Vector3(230, 10, 200));
    if (why === 'tear') { f.anchorId(E.EMPTY); await frame(); }
    if (why === 'release') grapple.release();
    if (why === 'death') { body.hurt(2, 'test', { shielded: false }); await frame(); }
    if (why === 'replacement') { body.tether({ anchor: new THREE.Vector3(), hard: true }); await frame(); }
    assert.equal(grapple.active, false, why);
    if (why === 'replacement') assert.ok(body.rope, 'cannot sever another tool/vehicle tether');
    else assert.equal(body.rope, null);
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { grapple, attach, frame } = f;
  try {
    await attach(new THREE.Vector3(230, 10, 200)); f.holdRead(true); await frame();
    grapple.release(); await attach(new THREE.Vector3(232, 10, 200));
    f.completeRead(E.EMPTY); await flush();
    assert.equal(grapple.active, true, 'stale anchor reads cannot tear out a new grapple');
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { body, grapple, ctx, frame } = f;
  const target = { pos: new THREE.Vector3(220, 1, 200), vel: new THREE.Vector3(), dead: false, positionEpoch: 0 };
  const off = addTarget({ id: 'grappendix-test', get alive() { return !target.dead; }, body: target, hurt() {},
    box(lo, hi) { lo.copy(target.pos).add(new THREE.Vector3(-1, 0, -1)); hi.copy(target.pos).add(new THREE.Vector3(1, 6, 1)); } });
  try {
    ctx.aim.valid = false; ctx.dir.set(1, 0, 0); await grapple.toggle(ctx);
    assert.ok(grapple.active, 'original can attach to an NPC');
    const anchor = grapple.rope.anchor.clone(); target.pos.x += 5; await frame();
    near(grapple.rope.anchor.x, anchor.x + 5);
    target.dead = true; await frame();
    assert.ok(grapple.active && target.vel.x < 0, 'original pulls corpses back, not living enemies');
    grapple.release(); await grapple.toggle(ctx);
    assert.ok(grapple.active, 'a dead body remains a grapple target, not a gun target');
    target.positionEpoch++; await frame();
    assert.equal(grapple.active, false, 'same-body respawn/teleport invalidates the previous anchor offset');
    await grapple.toggle(ctx);
    off(); await frame();
    assert.equal(body.rope, null);
  } finally { off(); f.dispose(); }
}
near(GRAPPENDIX_RANGE * CELL_M, 100);
near(GRAPPENDIX_MAX_CABLE * CELL_M, 200);
{
  const f = await fixture(), { body, grapple, attach, ctx, sim, scene } = f;
  const viewmodel = new THREE.Group(), volume = scene.children.find(o => o.isGroup);
  scene.add(viewmodel);
  const hook = hookDef.create({ scene, viewmodel, getSim: () => sim, getVolume: () => volume, getScale: () => 1, isActive: () => true });
  try {
    ctx.aim.cell.set(225, 8, 200); ctx.aim.dist = 25; ctx.dir.set(1, 0, 0);
    ctx.primaryPressed = true; hook.update(ctx); ctx.primaryPressed = false;
    for (let i = 0; i < 15 && hook.state !== 'anchor'; i++) { hook.tick(ctx); await flush(); }
    assert.equal(hook.state, 'anchor');
    await attach(new THREE.Vector3(230, 10, 200));
    const mine = body.rope;
    hook.deselect();
    assert.equal(body.rope, mine, 'old Hook weapon cleanup cannot clear the current E tether');
    hook.dispose();
    assert.equal(body.rope, mine, 'disposing the old Hook cannot clear another tool tether');
    assert.ok(grapple.active);
  } finally { hook.dispose(); f.dispose(); }
}
console.log('ok source overhead pull/dead zone/refire, flesh-orb rendering, range, misses, shifts, lifecycle, stale reads, moving NPC');

// A real voxel walk, not an injected hover hit: ordinary Sandbox reaches 75 m.
{
  const f = await fixture(), { body, grapple, ctx, scene } = f;
  try {
    ctx.aim.valid = false; ctx.dir.set(1, 0, 0);
    f.liveCells.set(`450,${Math.floor(ctx.eye.y)},200`, E.ROCK);
    await grapple.toggle(ctx);
    assert.ok(grapple.active && ctx.eye.distanceTo(grapple.rope.anchor) * CELL_M > 74);
    await f.frame({ jump: true });
    assert.ok(body.vel.x > 0, 'long attachment actually pulls the real body');
    const anchor = grapple.rope.anchor.clone(), mesh = scene.children.find(o => o.isInstancedMesh);
    body.pos.copy(anchor).add(new THREE.Vector3(-GRAPPENDIX_MAX_CABLE, -body.height / 2, 0));
    body.vel.set(12, 3, -5);
    for (let i = 0; i < 205; i++) grapple.update(ctx);
    assert.ok(grapple.active, 'exactly 200 m is retained');
    assert.equal(mesh.count, 800, 'four orbs/m cover the full 200 m cable, not the old 128 m cap');
    body.pos.x -= 0.01;
    grapple.update(ctx);
    assert.equal(grapple.active, false, 'beyond 200 m releases');
    assert.equal(body.rope, null); assert.equal(mesh.visible, false); assert.equal(mesh.count, 0);
    assert.deepEqual(body.vel.toArray(), [12, 3, -5], 'safety release preserves momentum');
    body.pos.set(200, 1, 200); ctx.eye.copy(body.pos).setY(1 + body.eyeHeight);
    await grapple.toggle(ctx);
    assert.ok(grapple.active, 'cutoff resets cleanly for immediate reacquisition');
  } finally { f.dispose(); }
}

for (const why of ['toggle', 'release', 'shift', 'teleport', 'death', 'replacement', 'map']) {
  const f = await fixture(), { body, grapple, ctx } = f;
  try {
    ctx.dir.set(1, 0, 0); f.liveCells.set(`450,${Math.floor(ctx.eye.y)},200`, E.ROCK);
    f.holdTrace(true);
    const attaching = grapple.toggle(ctx);
    if (why === 'toggle') await grapple.toggle(ctx);
    if (why === 'release') grapple.release(); // toolbelt.worldReplaced/setVisible/dispose cancellation
    if (why === 'shift') grapple.windowShifted(16, 0);
    if (why === 'teleport') body.teleport(new THREE.Vector3(200, 1, 200));
    if (why === 'death') body.hurt(2, 'test', { shielded: false });
    if (why === 'replacement') body.tether({ anchor: new THREE.Vector3(), hard: true });
    if (why === 'map') f.world({ epoch: 1 });
    f.completeTrace(); await attaching;
    assert.equal(grapple.active, false, `pending acquisition cancelled by ${why}`);
    if (why === 'replacement') assert.ok(body.rope, 'cancel never clears another owner');
  } finally { f.dispose(); }
}

// The exact terrain acquisition ceiling is exclusive; actor cables share the safety cutoff.
for (const delta of [-0.001, 0, 0.001]) {
  const f = await fixture(), { grapple, ctx } = f;
  try {
    ctx.eye.set(450 - GRAPPENDIX_RANGE - delta, 6.5, 200.5); ctx.dir.set(1, 0, 0);
    f.liveCells.set('450,6,200', E.ROCK);
    await grapple.toggle(ctx);
    assert.equal(grapple.active, delta < 0, 'terrain acquisition is strictly less than 100 m');
  } finally { f.dispose(); }
}
{
  const f = await fixture(), { grapple, body, ctx } = f;
  const actor = { pos: new THREE.Vector3(450, 1, 200), positionEpoch: 0 };
  const off = addTarget({ id: 'long-moving-anchor', alive: true, body: actor,
    box(lo, hi) { lo.copy(actor.pos).add(new THREE.Vector3(-1, 0, -1)); hi.copy(actor.pos).add(new THREE.Vector3(1, 6, 1)); } });
  try {
    ctx.dir.set(1, 0, 0); ctx.aim.valid = false;
    await grapple.toggle(ctx);
    assert.ok(grapple.active, 'moving actor attaches beyond old range');
    actor.pos.x += 500; grapple.update(ctx);
    assert.equal(body.rope, null, 'moving anchor beyond 200 m also releases');
  } finally { off(); f.dispose(); }
}

// Published Paradise data: no resized world, fabricated distant target cell or GPU.
// This authored street ray first meets a solid at 92.25 m, well outside 128-cell residency.
{
  const { readFileSync } = await import('node:fs');
  const { gunzipSync } = await import('node:zlib');
  const { createImportedMapScene } = await import('../src/world/scenes/importedMap.js');
  const { BrickStore, encodeBrick, BRICK_FLOATS } = await import('../src/world/store.js');
  const { BRICK } = await import('../src/shaders/common.js');
  const map = JSON.parse(readFileSync(new URL('../public/local-maps/paradise.json', import.meta.url)));
  const bytes = gunzipSync(readFileSync(new URL(`../public/local-maps/${map.dataFile}`, import.meta.url)));
  const source = createImportedMapScene(map, new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  const world = { scene: source, size: map.size, epoch: 0, store: new BrickStore(map.size.map(n => n / BRICK)) };
  const f = await fixture(), { sim, body, grapple, ctx } = f;
  try {
    sim.g = { windowed: true, nx: 128, ny: map.size[1], nz: 128 };
    sim.origin.set(304, 0, 544); f.world(world);
    f.liveSource((x, y, z) => source.cell(x + sim.origin.x, y, z + sim.origin.z));
    const aim = () => {
      body.pos.set(64.5, 21.5 - body.eyeHeight, 64.5);
      ctx.eye.set(64.5, 21.5, 64.5); ctx.dir.set(1, 0, 0); ctx.aim.valid = false;
    };
    aim(); await grapple.toggle(ctx);
    assert.ok(grapple.active, 'actual source solid attaches beyond resident window and old range');
    near(ctx.eye.distanceTo(grapple.rope.anchor) * CELL_M, 92.25);
    assert.equal(grapple.rope.anchor.x + sim.origin.x, 676);
    grapple.update(ctx); assert.ok(grapple.active, 'far source anchor survives validation');
    const anchor = grapple.rope.anchor.clone();
    body.windowShifted(320, 0); sim.origin.x += 320; grapple.windowShifted(320, 0);
    near(grapple.rope.anchor.x + sim.origin.x, anchor.x + 304);
    f.anchorId(E.EMPTY); grapple.update(ctx); await flush();
    assert.equal(grapple.active, false, 'fresh destroyed resident anchor overrides its pristine source');
    sim.origin.x = 304; aim(); f.anchorId(E.ROCK);

    // Fresh foreground matter must occlude both far terrain and a farther actor.
    f.liveCells.set('90,21,64', E.ROCK);
    const actor = { pos: new THREE.Vector3(200, 18, 64), positionEpoch: 0 };
    const off = addTarget({ id: 'far-occluded', alive: true, body: actor,
      box(lo, hi) { lo.copy(actor.pos); hi.copy(actor.pos).addScalar(4); } });
    await grapple.toggle(ctx);
    near(grapple.rope.anchor.x, 90, 1e-4);
    grapple.release(); f.liveCells.set('90,21,64', E.WATER);
    await grapple.toggle(ctx);
    assert.equal(grapple.active, false, 'unanchorable foreground liquid blocks terrain and actor');
    off(); f.liveCells.clear();

    // Stored edits outside the window take precedence over untouched source.
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    for (let i = 0; i < A.length; i += 4) A[i] = E.ROCK;
    world.store.put(world.store.key(520 / BRICK, 20 / BRICK, 608 / BRICK), encodeBrick(A, 0, B, 0));
    await grapple.toggle(ctx);
    near(grapple.rope.anchor.x + sim.origin.x, 520);
    A.fill(0);
    world.store.put(world.store.key(520 / BRICK, 20 / BRICK, 608 / BRICK), encodeBrick(A, 0, B, 0));
    grapple.update(ctx);
    assert.equal(grapple.active, false, 'stored destruction tears out a nonresident anchor');
    world.store.clear();
    world.pending = Promise.resolve();
    await grapple.toggle(ctx);
    assert.equal(grapple.active, false, 'pending leaving-slab edits cannot be bypassed using stale source');
    world.pending = null;

    // Put the original wall IN the live window, then destroy all resident
    // matter. It must not reappear from the CPU source when firing through it.
    sim.origin.x = 624;
    ctx.eye.set(26.5, 21.5, 64.5); body.pos.copy(ctx.eye).setY(21.5 - body.eyeHeight);
    await grapple.toggle(ctx);
    assert.equal(grapple.rope.anchor.x + sim.origin.x, 676);
    grapple.release(); f.liveSource(() => E.EMPTY);
    await grapple.toggle(ctx);
    assert.equal(grapple.active, false, 'resident destructive edits are never replaced by pristine source geometry');

    // Unknown procedural far terrain fails closed rather than hitting a ghost actor.
    f.world({ ...world, scene: {} });
    const offUnknown = addTarget({ id: 'unknown-far', alive: true, body: actor,
      box(lo, hi) { lo.copy(actor.pos); hi.copy(actor.pos).addScalar(4); } });
    await grapple.toggle(ctx); offUnknown();
    assert.equal(grapple.active, false, 'no actor attachment through unknown non-imported terrain');

    f.world(world); sim.origin.x = 304; f.liveSource(() => E.EMPTY); aim();
    await grapple.toggle(ctx); assert.ok(grapple.active);
    world.epoch++; grapple.update(ctx);
    assert.equal(body.rope, null, 'same-window map reload resets attached cable');
  } finally { f.dispose(); }
}
console.log('ok 75 m live-voxel pull, 92.25 m Paradise far attachment, occlusion, destructive edits, saved edits, 200 m cutoff/visual/reset, pending cancellation');
