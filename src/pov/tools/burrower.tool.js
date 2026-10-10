import * as THREE from 'three';
import { quadVert, stateUniforms } from '../../shaders/common.js';
import { burrowProbeFrag, burrowFrag, BURROW } from '../../shaders/povBore.js';
import { toolPass } from '../../shaders/povTools.js';
import { CELL_METERS } from '../vitals.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig, HIT } from '../viewmodel.js';
import { nearestTarget, PLAYER } from '../targets.js';
import { trigger } from './action.js';
import { gear } from './catalog.js';
import { muzzleCell } from './transfer.js';

// Burrower: Cruelty Squad's Cerebral Bore, without the health cost. It fires a
// drill that homes on the nearest live body (targets.js: an NPC, another
// player) and bores a real tunnel through whatever is between, then drills
// into the body it reaches. With no body about it flies along the crosshair.
//
// Guidance is proportional navigation, the textbook homing-missile law
// (Zarchan, "Tactical and Strategic Missile Guidance", ch. 2: n_c = N'·V_c·λ̇):
// the heading turns NAV_RATIO times as fast as the line of sight to the target
// does, Ω = (r × v_rel) / |r|², so it leads a moving target and closes on a
// still one along a curve. PN is derived for small heading errors; while the
// target is behind the drill (more than 90° off) it turns straight at it at
// the full rate instead (pure pursuit). The turn rate is clamped to TURN_MAX.
//
// The drill is power-limited (shaders/povBore.js BURROW): its speed through
// matter is its power over the work a cell of advance takes, Teale's rule, so
// it races through sand, slows in rock and crawls through metal. What it
// reads of the matter ahead comes back from a small GPU pass a frame or two
// late (burrowProbeFrag, PROBE_AHEAD slices along its heading), as the
// player's probe does. The bore pass (burrowFrag) turns every breakable solid
// in the bore into its own debris and conveys the cuttings back out of the
// mouth, so the tunnel stays open to walk through. A solid it can't break
// (WALL) on its axis stops it; stuck STALL_S it gives up.
//
// It drills into the body it reaches (DAMAGE: one kills) and stops; the
// conveyor runs on CONVEY_AFTER more seconds to clear the last cuttings. It
// lives LIFETIME seconds at most.
//
// Events: gun:fire (the launch, vfx.js's flash, audio.js's swoosh);
// drill { point, dir, id, dt } every frame it cuts (vfx.js's spray at the face);
// tool:action 'burrower' 'grind' { point, id } every GRIND_S while it cuts;
// impact { source: 'burrower', body: true } when it reaches a body.

const FLIGHT_SPEED = 12 / CELL_METERS;   // cells/s in the open (12 m/s: slow enough to watch it hunt)
const NAV_RATIO = 4;                     // PN's effective navigation ratio N' (Zarchan: 3 to 5)
const TURN_MAX = 3;                      // rad/s, the fastest the drill can turn
const LIFETIME = 12;                     // s a drill runs at most
const STALL_S = 1.5;                     // s stuck on something it can't cut before it gives up
const CONVEY_AFTER = 2.5;                // s the spoil conveyor runs on after the drill stops
const LOCK_RANGE = 256;                  // cells: bodies farther than this aren't homed on
const HIT_REACH = 1;                     // cells from a body's box at which the nose is in it
const DAMAGE = 1;                        // health it takes from the body it drills into (one kills)
const HIT_ENERGY = 60;                   // the impact's energy, for the shake and the hitmarker (sim KE units)
const REFIRE = 1.5;                      // s between drills
const PATH_STEP = 2;                     // cells between points of the bore's centre line
const GRIND_S = 0.12;                    // s between grinding sounds while it cuts
const SPIN = 30;                         // rad/s the drill's bit turns
const MAX_DRILLS = 4;                    // drills in flight at once (one launcher)
const PROBE_INFLIGHT = 6;                // probe readbacks in flight at once (all drills)
const WORK_EPS = 1e-3;                   // work below this is open air
const TARGET_V_EASE = 0.3;               // share of each frame's measured target velocity in its running estimate
const RGBA = 4;

// viewmodel, in cells (camera space): on the shoulder, like the rocket launcher
const HELD_POS = [0.55, -0.55, -1.5];
const MUZZLE = [0, 0.15, -0.6];          // cells from the model's centre to the tube's mouth

const vT = new THREE.Vector3(), vR = new THREE.Vector3(), vW = new THREE.Vector3(), vQ = new THREE.Quaternion();

export default {
  ...gear('BURROWER'),
  create(env) {
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(...MUZZLE);
    hand.add(muzzle);
    const held = attachModel(hand, 'burrower');
    const heldBit = held.obj.getObjectByName('bit');
    const button = trigger(REFIRE);
    const bore = toolPass(burrowFrag, () => ({
      uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
      uCut: { value: 0 }, uPath: { value: [...Array(BURROW.PATH_MAX)].map(() => new THREE.Vector4()) }, uPathN: { value: 0 },
      uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
    }));

    // the probe: its material per sim, and readback slots shared by every drill
    let probeMat = null, probeSim = -1;
    function probeFor(sim) {
      if (sim.id !== probeSim) {
        probeMat?.dispose();
        probeMat = new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: burrowProbeFrag(sim.g),
          uniforms: { ...stateUniforms(), uHead: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } },
          depthTest: false, depthWrite: false,
        });
        probeSim = sim.id;
      }
      return probeMat;
    }
    const slots = [...Array(PROBE_INFLIGHT)].map(() => ({
      target: new THREE.WebGLRenderTarget(BURROW.PROBE_AHEAD, 1, {
        type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      }),
      buf: new Float32Array(BURROW.PROBE_AHEAD * RGBA), busy: false,
    }));

    const drills = [];   // in flight (and conveying), oldest first
    let lastHit = null, lastLaunch = null, nextId = 1;
    const world = new THREE.Group();
    world.name = 'pov-drills';
    env.scene.add(world);
    const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);

    // ask the GPU what lies ahead of drill d (an answer lands a frame or two later)
    function probe(sim, d) {
      const slot = slots.find((s) => !s.busy);
      if (!slot) return;
      const mat = probeFor(sim);
      const u = mat.uniforms;
      u.tA.value = sim.stateA; u.tB.value = sim.stateB; u.tF.value = sim.stateF;
      u.uHead.value.copy(d.pos);
      u.uDir.value.copy(d.dir);
      sim.run(mat, slot.target);
      slot.busy = true;
      const asked = { origin: d.pos.clone(), dir: d.dir.clone(), simId: sim.id, shift: d.shift.clone() };
      env.renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, BURROW.PROBE_AHEAD, 1, slot.buf).then(() => {
        slot.busy = false;
        if (!d.alive || asked.simId !== sim.id) return;
        // a window shift since it was asked moves its origin with the world (docs/scaling.md D11)
        asked.origin.sub(d.shift).add(asked.shift);
        d.probe = { origin: asked.origin, dir: asked.dir, data: slot.buf.slice() };
      }).catch(() => { slot.busy = false; });
    }

    // what the last probe says of the slice the nose is entering: { work, blocked, id }
    function ahead(d) {
      const p = d.probe;
      if (!p) return { work: 0, blocked: 0, id: -1, known: false };
      const k = Math.floor(vT.subVectors(d.pos, p.origin).dot(p.dir));
      if (k < 0 || k >= BURROW.PROBE_AHEAD) return { work: 0, blocked: 0, id: -1, known: false };
      const i = k * RGBA;
      return { work: p.data[i], blocked: p.data[i + 1], id: Math.round(p.data[i + 2]), known: true };
    }

    // proportional navigation toward the target (see the top), clamped to TURN_MAX
    function steer(d, dt) {
      const near = nearestTarget(d.pos, LOCK_RANGE, d.exclude);
      if (!near) { d.target = null; return; }
      if (d.target !== near.target) { d.target = near.target; d.tPrev = near.center.clone(); d.tVel.set(0, 0, 0); }
      vT.subVectors(near.center, d.tPrev).divideScalar(Math.max(dt, 1e-6));
      d.tVel.lerp(vT, TARGET_V_EASE);
      d.tPrev.copy(near.center);
      const r = vR.subVectors(near.center, d.pos);
      const dist2 = r.lengthSq();
      if (dist2 < 1e-6) return;
      let rate;
      if (r.dot(d.dir) < 0) {
        // behind: pure pursuit, turning straight at it
        vW.crossVectors(d.dir, r);
        if (vW.lengthSq() < 1e-9) vW.set(0, 1, 0).cross(d.dir);
        rate = TURN_MAX;
      } else {
        // Ω = r × v_rel / |r|², heading rate N'·Ω
        const vRel = vT.copy(d.tVel).addScaledVector(d.dir, -d.speed);
        vW.crossVectors(r, vRel).divideScalar(dist2).multiplyScalar(NAV_RATIO);
        rate = Math.min(vW.length(), TURN_MAX);
      }
      if (rate <= 0 || vW.lengthSq() < 1e-12) return;
      d.dir.applyQuaternion(vQ.setFromAxisAngle(vW.normalize(), rate * dt)).normalize();
    }

    // the bore pass for this frame: cut from → to (cut), convey along the path
    function runBore(sim, d, from, to, cut) {
      const mat = bore(sim);
      const u = mat.uniforms;
      u.uFrom.value.copy(from); u.uTo.value.copy(to); u.uDir.value.copy(d.dir);
      u.uCut.value = cut ? 1 : 0;
      const n = Math.min(d.path.length, BURROW.PATH_MAX);
      const lo = from.clone().min(to), hi = from.clone().max(to);
      for (let i = 0; i < n; i++) {
        const q = d.path[d.path.length - n + i];
        u.uPath.value[i].set(q.x, q.y, q.z, 1);
        lo.min(q); hi.max(q);
      }
      // the nose's own point closes the centre line
      u.uPathN.value = n;
      const pad = BURROW.RADIUS + BURROW.CONVEY_PAD + BURROW.APRON + 1;   // the conveyor reaches APRON past the mouth
      lo.subScalar(pad).floor(); hi.addScalar(pad).floor();
      u.uLo.value.copy(lo); u.uHi.value.copy(hi);
      sim.touchCentres(lo.toArray(), hi.toArray());
      sim.pass(mat);
    }

    function stop(d, why) {
      if (d.state !== 'flying') return;
      d.state = 'conveying';
      d.convey = CONVEY_AFTER;
      d.why = why;
      d.model.obj.visible = false;
    }

    function end(d) {
      d.alive = false;
      d.model.dispose();
      drills.splice(drills.indexOf(d), 1);
    }

    function flyDrill(sim, d, dt) {
      d.age += dt;
      if (d.state === 'conveying') {
        if (d.path.length > 1) runBore(sim, d, d.pos, d.pos, false);
        d.convey -= dt;
        if (d.convey <= 0) end(d);
        return;
      }
      steer(d, dt);
      const a = ahead(d);
      const cutting = a.work > WORK_EPS || a.blocked > 0;
      d.speed = a.blocked > 0 ? 0 : a.work > WORK_EPS ? Math.min(FLIGHT_SPEED, BURROW.POWER / a.work) : FLIGHT_SPEED;
      d.stall = d.speed > 0 ? 0 : d.stall + dt;
      const from = d.pos.clone();
      d.pos.addScaledVector(d.dir, d.speed * dt);
      // the bore's centre line, from where it first met matter
      if (cutting && !d.path.length) d.path.push(from.clone());
      if (d.path.length && d.pos.distanceTo(d.path[d.path.length - 1]) >= PATH_STEP) {
        d.path.push(d.pos.clone());
        if (d.path.length > BURROW.PATH_MAX) d.path.shift();
      }
      runBore(sim, d, from, d.pos, true);
      if (cutting) {
        povEvents.emit('drill', { point: d.pos.clone(), dir: d.dir.clone(), id: a.id, dt });
        d.grind -= dt;
        if (d.grind <= 0) { d.grind = GRIND_S; povEvents.emit('tool:action', { tool: 'burrower', action: 'grind', point: d.pos.clone(), id: a.id }); }
      }
      // the body it reaches
      const near = nearestTarget(d.pos, HIT_REACH, d.exclude);
      if (near) {
        near.target.hurt(DAMAGE, 'Bored', d.dir.clone());
        povEvents.emit('impact', { source: 'burrower', point: d.pos.clone(), normal: d.dir.clone().negate(), id: -1, energy: HIT_ENERGY, broke: null, body: true });
        lastHit = { id: d.id, target: near.target.id, point: d.pos.clone(), age: d.age, path: d.path.map((q) => q.clone()) };
        stop(d, 'hit');
        return;
      }
      const g = sim.g;
      const outside = d.pos.x < -BURROW.RADIUS || d.pos.z < -BURROW.RADIUS || d.pos.y < -BURROW.RADIUS
        || d.pos.x > g.nx + BURROW.RADIUS || d.pos.y > g.ny + BURROW.RADIUS || d.pos.z > g.nz + BURROW.RADIUS;
      if (d.age >= LIFETIME) stop(d, 'spent');
      else if (d.stall >= STALL_S) stop(d, 'stuck');
      else if (outside) stop(d, 'gone');
      else probe(sim, d);
    }

    function draw(d, dt) {
      if (d.state !== 'flying') return;
      const m = d.model.obj;
      m.scale.setScalar(env.getScale() * 2 * BURROW.RADIUS);
      // the nose is d.pos: the model's middle sits half its length behind it
      toWorld(vT.copy(d.pos).addScaledVector(d.dir, -d.nose), m.position);
      d.spin += SPIN * dt;
      m.quaternion.setFromUnitVectors(FWD, d.dir).multiply(vQ.setFromAxisAngle(FWD, d.spin));
    }

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      if (drills.filter((d) => d.state === 'flying').length >= MAX_DRILLS) return false;
      const dir = ctx.dir.clone().normalize();
      const m = muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g);
      if (!m) { env.feedback?.refuse('No room to fire'); return false; }
      const origin = ctx.eye.clone().addScaledVector(dir, m.t);
      const d = {
        id: nextId++, alive: true, state: 'flying', pos: origin.clone(), dir: dir.clone(), speed: FLIGHT_SPEED,
        age: 0, stall: 0, grind: 0, spin: 0, convey: 0, why: null, path: [], probe: null,
        exclude: povEvents.actor?.id ?? PLAYER, target: null, tPrev: new THREE.Vector3(), tVel: new THREE.Vector3(),
        shift: new THREE.Vector3(),   // the window's total shift since launch (docs/scaling.md D11)
        model: null, nose: 0,
      };
      // the model is a cell across; drawn the bore's width, its nose is half its length ahead of its middle
      d.model = attachModel(world, 'drill', (obj, info) => { d.nose = info.size.z / 2 * 2 * BURROW.RADIUS; }, { arm: false });
      drills.push(d);
      draw(d, 0);
      lastLaunch = { id: d.id, origin: origin.clone(), dir: dir.clone() };
      rig.hit(HIT.BURROWER);
      muzzle.updateWorldMatrix(true, false);
      povEvents.emit('tool:action', { tool: 'burrower', action: 'fire' });
      povEvents.emit('gun:fire', { origin: origin.clone(), dir: dir.clone(), muzzleWorld: muzzle.getWorldPosition(new THREE.Vector3()), gun: 'BURROWER', sound: { voice: 'swoosh', rate: 0.8, gain: 1.4, thump: 1.2 } });
      return true;
    }

    return {
      update(ctx) {
        hand.visible = true;
        rig.update(ctx);
        if (heldBit) heldBit.rotation.y += SPIN * ctx.dt * (button.waiting > 0 ? 1 : 0);
        if (button.ready(ctx) && fire(ctx)) button.fire();
      },
      // the drills keep boring whichever tool is in hand
      tick(ctx) {
        if (!drills.length) return;
        const sim = ctx.sim ?? env.getSim();
        const dt = ctx.stepsPerFrame === 0 ? 0 : ctx.dt;
        if (!(dt > 0) || !sim) return;
        for (const d of [...drills]) { flyDrill(sim, d, dt); if (d.alive) draw(d, dt); }
        env.requestRender?.();
      },
      deselect() { hand.visible = false; button.reset(); },
      status: () => null,
      windowShifted(dx, dz) {
        for (const d of drills) {
          for (const v of [d.pos, d.tPrev, ...d.path]) { v.x -= dx; v.z -= dz; }
          d.shift.x += dx; d.shift.z += dz;
        }
        if (lastHit) { lastHit.point.x -= dx; lastHit.point.z -= dz; }
      },
      worldReplaced() { while (drills.length) end(drills[0]); },
      // for checks
      get drills() { return drills; },
      get lastHit() { return lastHit; },
      get lastLaunch() { return lastLaunch; },
      dispose() {
        while (drills.length) end(drills[0]);
        world.removeFromParent();
        slots.forEach((s) => s.target.dispose());
        probeMat?.dispose();
        bore.dispose();
        held.dispose();
        hand.removeFromParent();
      },
    };
  },
};

const FWD = new THREE.Vector3(0, 0, -1);   // the models' forward
