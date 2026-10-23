import * as THREE from 'three';
import { ELEMENTS, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { povGpu } from './gpu.js';
import { rayTarget, targetById, PLAYER } from './targets.js';
import { povEvents } from './events.js';
import { GRAPPENDIX_RANGE, GRAPPENDIX_MAX_CABLE } from './grappendixPhysics.js';
import { traceGrappendix, grappleResident, grappleFarCells } from './grappendixTrace.js';
import { kindOfGrid } from '../mapKind.js';

// weapon.gd's toggle and Player.gd's force, with adapted range (docs/grappendix.md).
// The original visual is four pulsating flesh orbs per meter, not a hemp rope or a flying claw.
const ORBS_PER_M = 4, ORB_RADIUS = 0.173 / CELL_M;
const MAX_ORBS = Math.round(GRAPPENDIX_MAX_CABLE * CELL_M) * ORBS_PER_M;
const solid = id => id < 0 || ELEMENTS[id]?.kind === K.SOLID;

export function createGrappendix(env) {
  const geometry = new THREE.SphereGeometry(ORB_RADIUS, 6, 6);
  geometry.scale(1, 0.321 / (2 * 0.173), 1);
  const material = new THREE.MeshBasicMaterial({ color: '#e8aaad' });
  const orbs = new THREE.InstancedMesh(geometry, material, MAX_ORBS);
  orbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  orbs.frustumCulled = false; orbs.visible = false; orbs.count = 0;
  env.scene.add(orbs);
  const center = new THREE.Vector3(), start = new THREE.Vector3(), end = new THREE.Vector3();
  const cell = new THREE.Vector3(), offset = new THREE.Vector3(), temp = new THREE.Vector3();
  const pose = new THREE.Object3D();
  let body = null, target = null, targetId = null, targetEpoch = null, rope = null, checking = false, generation = 0, time = 1;
  let pending = null, attachedSim = null, attachedWorld = null, attachedEpoch = null;

  function release(action = 'release') {
    if (!rope && !pending) return;
    if (rope) {
      if (body?.rope === rope) body.tether(null);
      povEvents.emit('tool:action', { tool: 'hook', action, point: rope.anchor.clone() });
    }
    rope = target = targetId = body = pending = attachedSim = attachedWorld = attachedEpoch = null;
    generation++; checking = false; orbs.visible = false; orbs.count = 0;
    env.requestRender?.();
  }

  async function toggle(ctx) {
    if (rope || pending) { release(); return; }
    const mine = ctx.player?.body ?? ctx.player;
    if (!mine?.tether || mine.dead) return;
    const sim = ctx.sim ?? env.getSim(), world = env.getWorld?.() ?? null;
    const eye = ctx.eye.clone(), dir = ctx.dir.clone();
    const gen = ++generation, epoch = mine.positionEpoch, worldEpoch = world?.epoch, previousRope = mine.rope;
    pending = { sim, world, worldEpoch, mine, epoch };
    let trace;
    try { trace = await traceGrappendix(sim, world, eye, dir, GRAPPENDIX_RANGE); }
    catch { if (gen === generation) pending = null; return; }
    if (gen !== generation) return;
    pending = null;
    if (mine.dead || mine.positionEpoch !== epoch || mine.rope !== previousRope
      || env.getSim() !== sim || (env.getWorld?.() ?? null) !== world || world?.epoch !== worldEpoch) return;
    const aim = trace?.hit;
    const who = trace && rayTarget(eye, dir, trace.distance, PLAYER, null, true);
    let point = null;
    if (who?.target.body && eye.distanceTo(who.point) < GRAPPENDIX_RANGE) {
      target = who.target.body; targetId = who.target.id; targetEpoch = target.positionEpoch; point = who.point.clone();
      offset.subVectors(point, target.pos);
    } else if (aim && solid(aim.id) && aim.dist < GRAPPENDIX_RANGE) {
      point = aim.point.clone();
      cell.copy(aim.cell); target = targetId = null;
    }
    if (!point) {
      target = targetId = null;
      povEvents.emit('tool:action', { tool: 'hook', action: 'miss', point: eye });
      return;
    }
    body = mine; attachedSim = sim; attachedWorld = world; attachedEpoch = worldEpoch;
    rope = { anchor: point, grappendix: true, hard: false, reel: 0, length: Infinity };
    body.tether(rope);
    generation++;
    povEvents.emit('tool:action', { tool: 'hook', action: 'fire', point: eye });
    povEvents.emit('tool:action', { tool: 'hook', action: 'catch', id: who ? -1 : aim.id, point: point.clone() });
    env.requestRender?.();
  }

  function update(ctx) {
    time += ctx.dt;
    const sim = ctx.sim ?? env.getSim(), world = env.getWorld?.() ?? null;
    if (pending && (pending.sim !== sim || pending.world !== world || pending.worldEpoch !== world?.epoch
      || pending.mine.dead || pending.mine.positionEpoch !== pending.epoch)) release();
    if (!rope) return;
    if (sim !== attachedSim || world !== attachedWorld || world?.epoch !== attachedEpoch
      || body.dead || body.rope !== rope || target?.gibbed
      || (target && target.positionEpoch !== targetEpoch)
      || (targetId && targetById(targetId)?.body !== target)) { release(); return; }
    if (target) rope.anchor.copy(target.pos).add(offset);
    // A safety release, not a hard rope constraint: preserve all launch momentum.
    center.copy(body.pos).setY(body.pos.y + body.height / 2);
    if (center.distanceTo(rope.anchor) > GRAPPENDIX_MAX_CABLE) { release(); return; }
    if (target) {
      // EnemyHandler.gd: alive enemies are anchors; only corpses receive the reciprocal 22 m/s² pull.
      if (target.dead && target.vel) {
        temp.copy(body.pos).setY(body.pos.y + body.height / 2)
          .sub(end.copy(target.pos).setY(target.pos.y + (target.height ?? body.height) / 2));
        if (temp.length() * CELL_M > 3) target.vel.addScaledVector(temp.normalize(), 22 / CELL_M * ctx.dt);
      }
    }
    else if (!checking && cell.y >= 0) {
      const resident = grappleResident(sim.g, cell);
      if (!resident && kindOfGrid(sim.g).streamed) {
        const far = grappleFarCells(world);
        if (far && !solid(far(cell.x + sim.origin.x, cell.y, cell.z + sim.origin.z))) { release('tear'); return; }
      }
      const read = resident && povGpu(sim).probe('povCells', { cells: [[cell.x, cell.y, cell.z, 0]], count: 1 });
      if (read) {
        checking = true;
        const gen = generation;
        read.then(bytes => {
          if (gen !== generation) return;
          checking = false;
          if (!solid(Math.round(new Float32Array(bytes)[0]))) release('tear');
        }).catch(() => { if (gen === generation) checking = false; });
      }
    }
    if (!rope) return;
    // Cruelty Squad's Player origin is its body center; our position is its feet.
    center.copy(body.pos).setY(body.pos.y + body.height / 2);
    const meters = center.distanceTo(rope.anchor) * CELL_M;
    const desired = Math.min(MAX_ORBS, Math.floor(meters) * ORBS_PER_M);
    // Player.gd grows/shrinks one four-orb batch per process frame.
    const count = desired > orbs.count ? Math.min(desired, orbs.count + ORBS_PER_M)
      : Math.max(desired, orbs.count - ORBS_PER_M);
    const volume = env.getVolume(), scale = env.getScale();
    volume.updateMatrixWorld();
    volume.localToWorld(start.copy(center)); volume.localToWorld(end.copy(rope.anchor));
    orbs.count = count; orbs.visible = count > 0;
    for (let i = 0; i < count; i++) {
      pose.position.copy(start).lerp(end, meters ? i / ORBS_PER_M / meters : 0);
      pose.scale.setScalar(scale * (1 + Math.sin(time * 2 - i) * 0.25));
      pose.updateMatrix(); orbs.setMatrixAt(i, pose.matrix);
    }
    orbs.instanceMatrix.needsUpdate = true;
    env.requestRender?.();
  }
  return {
    toggle, update, release,
    get active() { return !!rope; },
    get rope() { return rope; },
    windowShifted(dx, dz) { for (const v of [cell, rope?.anchor]) if (v) { v.x -= dx; v.z -= dz; } generation++; checking = false; pending = null; },
    dispose() { release(); orbs.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
