import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { hookCellFrag } from '../../shaders/povKick.js';
import { toolPass, disposeTree } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { ROPE_REEL_SPEED } from '../player.js';
import { rayTarget, PLAYER } from '../targets.js';
import { BODY_MASS_KG, cellKg, split } from '../tug.js';
import { gear } from './catalog.js';
import { faceNormal, cellsNear, outsideBody, persistentLoad, ownedKey, toStepVelocity, heldMesh, recolor } from './transfer.js';

// The hook: Cruelty Squad's grappling hook, one rope where mass decides which
// way things move (pov/tug.js). Left-click fires the claw along the crosshair;
// past HOOK_RANGE it comes back empty (Cruelty Squad's grapple fails out of
// range). What it catches:
// - a solid world cell (or the floor): anchored, so heavier than anything. The
//   rope hangs your body on it (player.js tether: Box2D's rope joint, the
//   max-distance constraint). Hold left-click to reel in (Titanfall 2's
//   grapple: the line retracts and draws you to the hook, here with the
//   body's Noita ease toward the reel speed); let go and the rope holds its
//   length, so you hang and swing like a pendulum (gravity and the constraint
//   do it; keys pump the swing). Reaching the claw ends it with your momentum
//   kept (Titanfall's). The anchor is read back every frame: if it stops being
//   solid (broken, melted, burned) the claw tears out.
// - loose matter (powder, liquid): it has no hold, so it tears out with the
//   claw: the claw takes what it bites (CLAW_CELLS, by the exact cell transfer
//   the shovel uses: the same cells come back) and the rope draws it and you
//   together by inverse mass, so a cell of sand (43 kg) comes most of the way
//   to you, a cell of metal dust (210 kg) drags you to it. Standing, the
//   ground holds you. At your hand the cells are set down in front of you,
//   moving as the claw was.
// - a body (an NPC): the rope reels you both toward each other, each by the
//   other's share of the mass (equal bodies meet in the middle).
// Right-click lets go of the rope (and drops a carried bite where the claw is).
// It works with the jetpack: the jet's lift and the rope add (a hanging body
// jets up toward the anchor; the rope only ever stops you moving away).
//
// Events: tool:action (tool 'hook') 'fire', 'catch' (id, point), 'miss',
// 'tear' (the anchor gave way), 'release'.

const HOOK_RANGE = 30 / CELL_M;       // cells (100): a long throw that still fails past it, as Cruelty Squad's does
const HOOK_SPEED = 100 / CELL_M;      // cells/s the claw flies out and back: a crossbow bolt's 100 m/s
const REEL_SPEED = ROPE_REEL_SPEED;   // cells/s the winch draws the rope in (player.js: the body's own top speed)
const ARRIVE = 2;                     // cells from the claw where reeling in ends (Titanfall's grapple ends at the hook)
const CLAW_CELLS = 1;                 // cells of loose matter the claw holds: one 30 cm cell
const CLAW_SEARCH = 1;                // cells around the struck cell the claw bites into if that cell has moved
const PUT_RADIUS = 2;                 // cells around the drop point a carried bite may land in
const PUT_AHEAD = 2;                  // cells in front of the hand the bite is set down
const REFIRE = 0.3;                   // s after a rope ends before the claw can fly again

// viewmodel, in cells (camera space: +x right, +y up, −z forward)
const GUN_POS = [0.6, -0.45, -1.4];
const TIP = [0, 0.1, -0.6];           // cells from the model's centre: where the rope leaves
// the rope and the claw in the world
const ROPE_RADIUS = 0.05;             // cells
const ROPE_COLOR = 0x6b5434;          // hemp
const CLAW_SIZE = 0.6;                // cells, the flying claw
const CLAW_COLOR = '#9aa0a6';
const BITE_SIZE = 1;                  // cells: a carried bite is drawn as the cell it is

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const isLoose = (id) => id >= 0 && (ELEMENTS[id].kind === K.POWDER || ELEMENTS[id].kind === K.LIQUID);
const isAnchor = (id) => id < 0 || ELEMENTS[id]?.kind === K.SOLID;   // id −1: the box's floor

function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(GUN_POS);
  const tip = new THREE.Object3D();
  tip.position.set(...TIP);
  hand.add(tip);
  const mesh = attachModel(hand, 'hook');
  const clawParts = [];
  mesh.obj.traverse((o) => { if (o.name === 'claw') clawParts.push(o); });
  // world: the rope (a cylinder stretched from the hand to the claw), the claw, and a carried bite
  const root = new THREE.Group();
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: ROPE_COLOR }));
  const claw = heldMesh(new THREE.ConeGeometry(CLAW_SIZE / 2, CLAW_SIZE, 3), CLAW_COLOR);
  const bite = heldMesh(new THREE.BoxGeometry(BITE_SIZE, BITE_SIZE, BITE_SIZE), '#ffffff');
  rope.frustumCulled = false;
  root.add(rope, claw, bite);
  root.visible = false;
  env.scene.add(root);
  return {
    rig, hand, tip, root, rope, claw, bite,
    showClaw(v) { clawParts.forEach((o) => { o.visible = v; }); },
    dispose() { mesh.dispose(); hand.removeFromParent(); disposeTree(root); root.removeFromParent(); },
  };
}

export default {
  ...gear('HOOK'),
  create(env) {
    const model = buildModel(env);
    const load = persistentLoad(ownedKey('HOOK', env.owner), CLAW_CELLS);
    const cellPass = toolPass(hookCellFrag, () => ({ uCell: { value: new THREE.Vector3() } }));
    const cellTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    const cellBuf = new Float32Array(4);
    let checking = false, generation = 0;

    // state: idle | out (flying) | bite (waiting for the take) | anchor | body | carry (a bite coming home) | back (empty, coming home)
    let state = 'idle', wait = 0;
    const origin = new THREE.Vector3(), dir = new THREE.Vector3(), claw = new THREE.Vector3(), clawVel = new THREE.Vector3();
    const anchorCell = new THREE.Vector3();
    let travelled = 0, travelEnd = 0, caught = null;   // caught: what the claw will meet ({ kind, point, cell, id, target })
    let rope = null, theirRope = null, theirBody = null, myBody = null;
    let carryShare = 0;   // share of the reel speed the carried bite moves at
    const hand = new THREE.Vector3(), tmp = new THREE.Vector3(), tmpB = new THREE.Vector3();

    const bodyOf = (ctx) => ctx.player?.body ?? ctx.player;
    const emit = (action, extra) => povEvents.emit('tool:action', { tool: 'hook', action, ...extra });

    function letGo(action = 'release') {
      myBody?.tether?.(null);
      theirBody?.tether?.(null);
      rope = theirRope = theirBody = null;
      generation++;
      if (state === 'anchor' || state === 'body') emit(action, { point: claw.clone() });
      state = load.count > 0 ? 'carry' : 'back';
      wait = REFIRE;
    }

    function fire(ctx) {
      const body = bodyOf(ctx);
      if (!body?.tether) return false;
      myBody = body;
      dir.copy(ctx.dir).normalize();
      origin.copy(ctx.eye);
      const aim = ctx.aim;
      const cellDist = aim?.valid ? aim.dist : Infinity;
      const who = rayTarget(ctx.eye, dir, Math.min(HOOK_RANGE, cellDist), povEvents.actor?.id ?? PLAYER);
      caught = null;
      if (who) caught = { kind: 'body', point: who.point.clone(), target: who.target, id: -1 };
      else if (aim?.valid && cellDist <= HOOK_RANGE) {
        const id = aim.cell.y < 0 ? -1 : aim.id;
        const point = aim.cell.clone().addScalar(0.5).add(faceNormal(aim.face, tmp).multiplyScalar(0.5));
        if (isAnchor(id)) caught = { kind: 'anchor', point, cell: aim.cell.clone(), id };
        else if (isLoose(id)) caught = { kind: 'loose', point, cell: aim.cell.clone(), id };
      }
      travelled = 0;
      travelEnd = caught ? origin.distanceTo(caught.point) : HOOK_RANGE;
      claw.copy(origin);
      state = 'out';
      model.rig.hit(HIT.HOOK);
      emit('fire', { point: origin.clone() });
      return true;
    }

    // the claw got where it was going
    function arrive(ctx) {
      const body = myBody;
      body.ropeHand(hand);
      if (!caught) { emit('miss', { point: claw.clone() }); state = 'back'; return; }
      if (caught.kind === 'anchor') {
        anchorCell.copy(caught.cell);
        rope = { anchor: claw.clone(), length: hand.distanceTo(claw), reel: 0, hard: true, brace: false };
        body.tether(rope);
        state = 'anchor';
        emit('catch', { id: caught.id, point: claw.clone() });
      } else if (caught.kind === 'body') {
        theirBody = caught.target.body ?? null;
        if (!theirBody?.tether || theirBody.dead) { state = 'back'; return; }
        const [mine, theirs] = split(BODY_MASS_KG, caught.target.mass ?? BODY_MASS_KG);
        rope = { anchor: new THREE.Vector3(), length: Infinity, reel: 0, hard: false, brace: false, share: mine };
        theirRope = { anchor: new THREE.Vector3(), length: Infinity, reel: 0, hard: false, brace: false, share: theirs };
        body.tether(rope);
        theirBody.tether(theirRope);
        state = 'body';
        emit('catch', { id: -1, point: claw.clone() });
      } else {
        // loose matter: the claw bites into it and it tears out with the claw
        const sim = ctx.sim ?? env.getSim();
        const near = cellsNear(caught.cell.clone().addScalar(0.5), CLAW_SEARCH, sim.g, outsideBody(body.pos));
        const p = env.transfer.take(load, { cells: near, kinds: [K.POWDER, K.LIQUID], limit: CLAW_CELLS });
        if (!p) { state = 'back'; return; }
        state = 'bite';
        const gen = generation;
        p.then((got) => {
          if (gen !== generation || state !== 'bite') return;
          if (!got.length) { state = 'back'; return; }
          const kg = load.cells.reduce((s, c) => s + cellKg(c[0]), 0);
          const [mine, its] = split(BODY_MASS_KG, kg);
          carryShare = its;
          rope = { anchor: claw, length: Infinity, reel: REEL_SPEED * mine, hard: false, brace: true };
          myBody.tether(rope);
          state = 'carry';
          recolor(model.bite, ELEMENTS[got[0][0]]?.color ?? '#ffffff');
          emit('catch', { id: got[0][0], point: claw.clone(), amount: got.length });
        });
      }
    }

    // a carried bite reached the hand (or was dropped): set it down, moving as the claw was
    function putDown(ctx, at) {
      const sim = ctx.sim ?? env.getSim();
      const p = env.transfer.put(load, {
        cells: cellsNear(at, PUT_RADIUS, sim.g, outsideBody(myBody?.pos ?? at)),
        vel: toStepVelocity(clawVel, ctx),
      });
      if (p) emit('dump', { point: at.clone(), id: load.cells[0]?.[0], amount: load.count });
      return !!p;
    }

    // Is the anchor still solid? One texel read back (shaders/povKick.js hookCellFrag).
    function checkAnchor(sim) {
      if (checking || anchorCell.y < 0) return;
      checking = true;
      const m = cellPass(sim);
      m.uniforms.tA.value = sim.stateA;
      m.uniforms.uCell.value.copy(anchorCell);
      sim.run(m, cellTarget);
      const gen = generation;
      env.renderer.readRenderTargetPixelsAsync(cellTarget, 0, 0, 1, 1, cellBuf).then(() => {
        checking = false;
        if (gen !== generation || state !== 'anchor') return;
        if (!isAnchor(Math.round(cellBuf[0]))) letGo('tear');
      }).catch(() => { checking = false; });
    }

    // the rope and claw in the world, from the hand (the viewmodel's tip in first person, else the body's hand)
    function draw() {
      const show = state !== 'idle' && !!myBody;
      model.root.visible = show;
      model.showClaw(!show);
      if (!show) return;
      const vol = env.getVolume(), scale = env.getScale();
      vol.updateMatrixWorld();
      const end = vol.localToWorld(tmp.copy(claw));
      let start;
      if (env.viewmodel.visible && model.hand.visible) { model.tip.updateWorldMatrix(true, false); start = model.tip.getWorldPosition(tmpB); }
      else start = vol.localToWorld(myBody.ropeHand(tmpB));
      const span = end.clone().sub(start);
      const len = span.length();
      model.rope.position.copy(start).addScaledVector(span, 0.5);
      model.rope.quaternion.setFromUnitVectors(Y_AXIS, span.divideScalar(len || 1));
      model.rope.scale.set(scale, len, scale);
      model.claw.position.copy(end);
      model.claw.quaternion.copy(model.rope.quaternion);
      model.claw.scale.setScalar(scale);
      model.bite.visible = state === 'carry' && load.cells.length > 0;
      model.bite.position.copy(end);
      model.bite.scale.setScalar(scale);
      globalThis.__app?.requestRender?.();
    }

    // everything that moves on its own, every frame, held or not
    function tick(ctx) {
      const dt = ctx.dt;
      wait = Math.max(0, wait - dt);
      const body = myBody;
      if (!body || state === 'idle') { draw(); return; }
      if (body.dead) { letGo(); }
      body.ropeHand(hand);
      const sim = ctx.sim ?? env.getSim();
      if (state === 'out') {
        travelled = Math.min(travelled + HOOK_SPEED * dt, travelEnd);
        claw.copy(origin).addScaledVector(dir, travelled);
        if (caught?.kind === 'body') claw.copy(caught.point);   // (it flies at the body: it lands where it was)
        if (travelled >= travelEnd) arrive(ctx);
      } else if (state === 'anchor') {
        if (rope.reel > 0 && hand.distanceTo(claw) < ARRIVE) letGo();
        else if (sim) checkAnchor(sim);
      } else if (state === 'body') {
        if (!theirBody || theirBody.dead) letGo();
        else {
          theirBody.ropeHand(claw);
          rope.anchor.copy(claw);
          theirRope.anchor.copy(hand);
          if (hand.distanceTo(claw) < ARRIVE) letGo();
        }
      } else if (state === 'carry') {
        // the bite comes in at its share of the reel speed; the body goes to meet it at its own (player.js tether)
        clawVel.subVectors(hand, claw);
        const d = clawVel.length();
        clawVel.multiplyScalar(d > 0 ? REEL_SPEED * carryShare / d : 0);
        claw.addScaledVector(clawVel, dt);
        if (d < ARRIVE || load.cells.length === 0) {
          body.tether(null); rope = null;
          if (load.cells.length === 0 || putDown(ctx, tmp.copy(ctx.eye ?? hand).addScaledVector(ctx.dir ?? dir, PUT_AHEAD))) {
            if (!load.busy) { state = 'idle'; wait = REFIRE; }
          }
        }
      } else if (state === 'back') {
        clawVel.subVectors(hand, claw);
        const d = clawVel.length();
        if (d < ARRIVE) state = 'idle';
        else claw.addScaledVector(clawVel, Math.min(1, HOOK_SPEED * dt / d));
      }
      draw();
    }

    return {
      update(ctx) {
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.secondaryPressed && state !== 'idle') {
          if (state === 'carry' && load.cells.length) { myBody?.tether(null); rope = null; putDown(ctx, claw.clone()); state = 'back'; }
          else if (state === 'anchor' || state === 'body') letGo();
          else if (state === 'out') { generation++; state = 'back'; }
        }
        if (ctx.primaryPressed && state === 'idle' && wait === 0) fire(ctx);
        // hold to reel in, let go to hang
        const reel = ctx.primary ? REEL_SPEED : 0;
        if (rope && state === 'anchor') rope.reel = reel;
        if (rope && state === 'body') { rope.reel = reel * rope.share; theirRope.reel = reel * theirRope.share; }
        // the NPC kit doesn't run tick(): drive it from here when nothing else does
        if (!env.isActive?.()) tick(ctx);
      },
      tick(ctx) { if (env.isActive?.()) tick(ctx); },
      deselect() {
        model.hand.visible = false;
        if (state === 'anchor' || state === 'body') letGo();
        else if (state === 'out') { generation++; state = 'back'; }   // (a bite being taken still comes home: tick)
      },
      status() {
        if (state === 'anchor') return rope?.reel > 0 ? 'reel' : 'hang';
        if (state === 'carry') return load.status();
        return null;
      },
      windowShifted(dx, dz) {
        for (const v of new Set([origin, claw, anchorCell, rope?.anchor, theirRope?.anchor, caught?.point, caught?.cell])) if (v) { v.x -= dx; v.z -= dz; }
        generation++;   // an anchor check in flight read the old cell
        checking = false;
      },
      worldReplaced() {
        if (state === 'anchor' || state === 'body') letGo();
        generation++;
        state = 'idle';
      },
      get state() { return state; },          // for checks
      get rope() { return rope; },            // for checks
      get claw() { return claw.clone(); },    // for checks
      dispose() {
        myBody?.tether?.(null); theirBody?.tether?.(null);
        cellPass.dispose(); cellTarget.dispose(); model.dispose();
      },
    };
  },
};
