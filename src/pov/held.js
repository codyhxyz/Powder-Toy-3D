import * as THREE from 'three/webgpu';
import { attachModel } from './models.js';
import { holdFor, gesturePose, SHOULDER_DROP } from './holds.js';
import { figureMaterial, figureUniforms } from './figure.js';
import { prepareMesh } from '../gfx/meshLight.js';
import { liveFlame, fanFlame } from './tools/lamp.js';

// The tool in hand on the body, whenever the body is drawn (third person): its
// model at world size, lit by the world's light as the body is, held the way
// its kind of tool is held (holds.js: Garry's Mod's hold types, Team Fortress
// 2's world models), with the arms reaching for it and the fists closed round
// its grips (the body's reach(), limbs.js).
//
// It moves as the first-person tool does, made big enough to see from behind.
// Every frame the viewmodel's model is read against its hand (the throw, a
// lamp gone from the hand) and played on the held model about its grip, with
// the hand's recoil spring on top, TP_KICK_POS and TP_KICK_ROT times the first
// person's (a shot shoves the arms back and flips the muzzle; the hand's sway,
// bob and breathing stay first person's). A melee swing plays its gesture
// (holds.js GESTURES: overhead and down, a stab) round the shoulder instead of
// the first person's flick of the wrist, and the arms follow the grip. And the
// viewmodel itself, never drawn in third person, is moved onto the held model:
// what a tool works out in the world from its viewmodel (the muzzle a flash and
// a tracer leave from, a beam's start, the hook's claw) is then where the body
// holds it. What a tool adds to its viewmodel (the shovel's heap, the bucket's
// and the flask's contents, the physgun's tip glow) is drawn in the world where
// the viewmodel now puts it, and parts a tool gives a glow of its own (the
// laser's charge strips, the tool gun's screen) show it on the body too.
//
//   const held = createHeld({ scene });
//   held.bind(volume, g);                       // a grid's world to light it in
//   const h = held.pick(modelKey | null, dt);   // before the body's update: { lift, ride, spine } for it
//   held.frame({ figure, yaw, pitch, scale, feet, camera, viewmodel });   // after it, before the tools run
//   held.place({ figure, dt });                 // after the tools: the model, then the hands

const REACH_RATE = 14;                  // 1/s: the arms go to a tool just drawn (and the body onto a pogo's pegs)
const RIDE_SHARE = 0.5;
// the recoil spring (viewmodel.js kick) on the body, × the first person's: a viewmodel's kick is a few
// cm under the eye, lost at third person's distance (Garry's Mod's player models play a fire gesture
// that throws the arms back about this far)
const TP_KICK_POS = 3;
const TP_KICK_ROT = 2;                 // stood on the pegs this far, the body takes its standing pose (holds.js feet)

const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
const euler = new THREE.Euler(), eulerAim = new THREE.Euler(0, 0, 0, 'YXZ');
const qA = new THREE.Quaternion();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vS = new THREE.Vector3();
const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mC = new THREE.Matrix4();
const kickEuler = new THREE.Euler();
const gesture = [0, 0, 0];

export function createHeld({ scene }) {
  const group = new THREE.Group();
  group.name = 'pov-held';
  group.visible = false;
  scene.add(group);
  const u = figureUniforms();   // no glow, no stain (its share, w, is 0)
  const models = new Map();             // model key → its held model, built the first time it's held
  const mats = new Map();
  let boundTo = null;
  let key = null, rec = null, weight = 0;
  let active = false, moved = false;
  let last = null;                      // the last reach: where the hands and feet went (checks)
  const frameM = new THREE.Matrix4();   // the grip's rest frame this frame (world), × the model's scale
  const restInv = new THREE.Matrix4();

  // a lit material (figure.js's light), with its own albedo
  const litMaterial = (albedo) => figureMaterial({ albedo, u });
  // one per albedo, shared by the models' parts
  function lit(albedo) {
    const k = albedo.join();
    if (!mats.has(k)) mats.set(k, litMaterial(albedo));
    return mats.get(k);
  }
  function light(r) {
    if (!boundTo) return;
    for (const m of r.lit) m.material = lit(m.userData.albedo);
  }

  function build(k) {
    const hold = holdFor(k);
    if (!hold) return null;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    const model = attachModel(holder, k, null, { arm: false });
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.obj);   // the model's own frame (the holder is at rest)
    const lit = [];
    model.obj.traverse((o) => {
      if (!o.isMesh || !o.material?.isMeshLambertMaterial) return;   // glows (unlit) keep theirs
      const c = o.material.color;
      o.userData.albedo = [c.r, c.g, c.b];
      lit.push(o);
    });
    const { grip, unit } = model.info;
    const point = (p) => new THREE.Vector3(...p).multiplyScalar(unit).add(grip);   // PARTS units → the model's frame
    const r = {
      key: k, hold, holder, model, lit, box,
      named: [],                         // its named parts (the hook's claw, the burrower's bit): shown and hidden as the viewmodel's are
      right: { ...hold.right, at: point(hold.right.at) },
      left: hold.left ? { ...hold.left, at: point(hold.left.at) } : null,
      pegs: hold.pegs?.map(point) ?? null,
      // standing on it (the pogo): its grip's height over its foot, and its pegs' (cells)
      gripHeight: (grip.y - box.min.y) * hold.scale,
      pegHeight: hold.pegs ? (point(hold.pegs[0]).y - box.min.y) * hold.scale : 0,
    };
    model.obj.traverse((o) => { if (o !== model.obj && o.name) r.named.push(o); });
    r.flame = hold.flame ? liveFlame(model.obj, 'world') : null;   // a burning head (the torch): the live flame, not the icon's cone
    holder.visible = false;
    group.add(holder);
    light(r);
    // its pipelines built before it is first shown (docs/webgpu.md B5)
    r.ready = false;
    prepareMesh(holder).then(() => { r.ready = true; });
    return r;
  }

  // the selected tool's first-person model and its hand, from the viewmodel rig, or null
  function firstPerson(viewmodel) {
    const root = viewmodel.userData.rig?.root;
    if (!root || !key) return null;
    for (const hand of root.children) {
      if (!hand.visible) continue;
      const obj = hand.getObjectByName(`viewmodel-${key}`);
      if (obj) return { root, hand, obj };
    }
    return null;
  }

  // What the tool has added to its viewmodel (not the model's own parts, not the first-person arm,
  // not the light it adds over the finished frame), each copied into the world where the viewmodel
  // puts it: the same geometry and, unlit, the same material; lit, the world's light in its colour.
  const extras = new Map();             // a viewmodel mesh or sprite → its copy
  const shownIn = (o, top) => { for (; o && o !== top; o = o.parent) if (!o.visible) return false; return true; };
  function copyOf(o) {
    let c = extras.get(o);
    if (!c) {
      c = o.isSprite ? new THREE.Sprite(o.material) : new THREE.Mesh(o.geometry, o.material);
      c.matrixAutoUpdate = false;
      group.add(c);
      extras.set(o, c);
    }
    return c;
  }
  function showExtras(fp) {
    for (const c of extras.values()) c.visible = false;
    if (!fp || !boundTo) return;
    fp.hand.traverse((o) => {
      if (!(o.isMesh || o.isSprite) || o.userData.part || o.userData.arm || o.userData.vmLayer != null) return;
      if (!shownIn(o, fp.hand)) return;
      const c = copyOf(o);
      c.visible = true;
      if (o.isMesh) c.geometry = o.geometry;   // (the flask's contents are rebuilt as its level changes)
      if (o.material.isMeshLambertMaterial) {
        c.userData.lit ??= litMaterial([0, 0, 0]);
        c.material = c.userData.lit;
        const col = o.material.color;
        c.material.uniforms.uAlbedo.value.set(col.r, col.g, col.b);
      } else c.material = o.material;
      o.updateWorldMatrix(true, false);
      c.matrix.copy(o.matrixWorld);
      c.matrixWorldNeedsUpdate = true;
    });
  }

  function resetViewmodel(viewmodel) {
    if (!moved) return;
    viewmodel.position.set(0, 0, 0);
    viewmodel.quaternion.identity();
    viewmodel.scale.set(1, 1, 1);
    moved = false;
  }

  // the model's world matrix: the grip's frame (with a swing's gesture), the hand's recoil made
  // bigger, then the model's own motion in its hand (a gestured swing's pivot left out: the gesture is it)
  function modelMatrix(fp, rig, out) {
    out.copy(frameM);
    if (!fp) return out;
    fp.obj.updateWorldMatrix(true, false);
    const sp = rig.state.spring;
    out.multiply(mA.makeTranslation(sp.x * TP_KICK_POS, sp.y * TP_KICK_POS, sp.z * TP_KICK_POS))
      .multiply(mC.makeRotationFromEuler(kickEuler.set(sp.pitch * TP_KICK_ROT, sp.yaw * TP_KICK_ROT, sp.roll * TP_KICK_ROT)));
    if (fp.hand.userData.gesture && fp.obj.parent !== fp.hand) return out.multiply(fp.obj.matrix);
    fp.hand.updateWorldMatrix(true, false);
    return out.multiply(mA.copy(fp.hand.matrixWorld).invert().multiply(fp.obj.matrixWorld));
  }

  return {
    group,
    // the world it is lit in (a grid's volume): the held model shows from then on
    bind(volume) {
      if (boundTo === volume) return;
      boundTo = volume;
      for (const r of models.values()) if (r) light(r);
    },
    // The tool held now (a models.js key; null: nothing, or the body isn't drawn). Returns
    // what the body's update needs: lift (cells it rides up: a pogo's pegs), ride (it stands
    // on them) and spine (share of the look's pitch the torso takes).
    pick(k, dt) {
      if (k !== key) {
        key = k;
        if (k && !models.has(k)) models.set(k, build(k));
        rec = k ? models.get(k) : null;
        weight = 0;
      }
      weight = rec ? weight + (1 - weight) * approach(REACH_RATE, dt) : 0;
      if (rec && !boundTo) weight = 0;
      const feet = !!rec?.hold.feet;
      return { lift: feet ? rec.pegHeight * weight : 0, ride: feet && weight > RIDE_SHARE, spine: (rec?.hold.spine ?? 0) * weight };
    },
    // After the body's update, before the tools run: the grip's frame, and the viewmodel moved onto it.
    // yaw, pitch: the look (rad); scale: world units per cell of this body; feet: world.
    frame({ figure, yaw, pitch, scale, feet, worldToGrid, camera, viewmodel }) {
      active = !!rec && weight > 0;
      for (const r of models.values()) if (r) r.holder.visible = active && r === rec && r.ready;
      group.visible = active;
      if (!active) { resetViewmodel(viewmodel); return; }
      u.worldToGrid.value.copy(worldToGrid);
      const h = rec.hold;
      const at = h.feet ? vA.copy(feet) : figure.anchor(vA);
      eulerAim.set(pitch * h.pitch, yaw, 0);
      frameM.compose(at, qA.setFromEuler(eulerAim), vS.setScalar(scale));
      // a melee swing's gesture: the grip round the shoulder and along the aim, the tool about its grip
      const fp = firstPerson(viewmodel);
      const gs = fp?.hand.userData.gesture;
      const [raise, tip, drive] = gs ? gesturePose(gs.name ?? h.type, gs.since, gs.span, gesture) : gesture.fill(0);   // (name: a tool's own gesture, the shovel's dig)
      if (raise || drive) {
        const axis = gs?.axis ?? [0, 0, -1];
        frameM.multiply(mA.makeTranslation(h.at[0] + axis[0] * drive, -SHOULDER_DROP + axis[1] * drive, axis[2] * drive))
          .multiply(mA.makeRotationX(raise))
          .multiply(mA.makeTranslation(-h.at[0], SHOULDER_DROP, 0));
      }
      if (h.feet) frameM.multiply(mA.makeTranslation(h.at[0], rec.gripHeight, h.at[2]));
      else frameM.multiply(mA.makeTranslation(...h.at));
      if (h.turn) frameM.multiply(mA.makeRotationFromEuler(euler.set(...h.turn)));
      frameM.multiply(mA.makeScale(h.scale, h.scale, h.scale));
      if (tip) frameM.multiply(mA.makeRotationX(tip));
      const g = rec.model.info.grip;
      frameM.multiply(mA.makeTranslation(-g.x, -g.y, -g.z));
      // the viewmodel onto the held model: camera · viewmodel · rig root · (its hand's rest) = the frame
      if (!fp) { resetViewmodel(viewmodel); return; }
      const rest = fp.hand.userData.rest;
      mB.copy(camera.matrixWorld).invert().multiply(frameM).multiply(restInv.makeTranslation(-rest.x, -rest.y, -rest.z))
        .multiply(mA.compose(fp.root.position, fp.root.quaternion, fp.root.scale).invert());
      mB.decompose(viewmodel.position, viewmodel.quaternion, viewmodel.scale);
      moved = true;
    },
    // After the tools: the held model where the viewmodel's motion puts it, then the hands on it.
    place({ figure, viewmodel, dt }) {
      if (!active) return;
      const fp = firstPerson(viewmodel);
      const m = modelMatrix(fp, viewmodel.userData.rig, rec.holder.matrix);
      rec.holder.matrixWorldNeedsUpdate = true;
      rec.holder.updateMatrixWorld(true);
      // what the first-person tool shows or hides (a thrown lamp, the hook's claw out)
      if (fp) {
        rec.model.obj.visible = fp.obj.visible;
        const named = [];
        fp.obj.traverse((o) => { if (o !== fp.obj && o.name) named.push(o); });
        rec.named.forEach((o, i) => {
          const v = named[i];
          if (v?.name !== o.name || (rec.flame && o.name === 'flame')) return;
          o.visible = v.visible;
          // a glow the tool gave this part (the laser's charge, the tool gun's screen): the same on the body
          if (v.material && !v.material.isMeshLambertMaterial && o.material !== v.material) o.material = v.material;
        });
      }
      showExtras(fp);
      if (rec.flame) {
        rec.flame.obj.visible = fp?.obj.userData.torchLit !== false;
        if (rec.flame.obj.visible) fanFlame(rec.flame, dt, 1);
        else rec.flame.fresh = true;
      }
      if (!rec.model.obj.visible) return;   // nothing in hand to hold
      const q = qA.setFromRotationMatrix(mB.extractRotation(m));
      const hand = (spec) => spec && {
        pos: spec.at.clone().applyMatrix4(m),
        fingers: new THREE.Vector3(...spec.fingers).applyQuaternion(q),
        palm: new THREE.Vector3(...spec.palm).applyQuaternion(q),
      };
      last = {
        right: hand(rec.right), left: hand(rec.left),
        feet: rec.pegs && rec.hold.feet ? rec.pegs.map((p) => p.clone().applyMatrix4(m)) : null,
        weight,
      };
      figure.reach(last);
    },
    // nothing in hand (left the body): the viewmodel back at the eye
    drop(viewmodel) {
      key = rec = last = null; weight = 0; active = false;
      group.visible = false;
      resetViewmodel(viewmodel);
    },
    get holding() { return active ? rec.key : null; },   // checks: the model held on the body,
    get reached() { return active ? last : null; },      // where its hands and feet were sent (world),
    get model() { return active ? rec.model.obj : null; },   // the model itself,
    get extras() { return [...extras.values()].filter((c) => c.visible); },   // and what the tool added, shown
    get weight() { return weight; },
    dispose() {
      for (const r of models.values()) { r?.flame?.dispose(); r?.model.dispose(); }
      for (const m of mats.values()) m.dispose();
      for (const c of extras.values()) c.userData.lit?.dispose();   // (geometry and the rest are the viewmodel's)
      group.removeFromParent();
    },
  };
}
