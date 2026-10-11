import * as THREE from 'three';
import { attachModel } from './models.js';
import { holdFor } from './holds.js';
import { figureVert, figureFrag } from './figure.js';
import { liveFlame, fanFlame } from './tools/lamp.js';

// The tool in hand on the body, whenever the body is drawn (third person): its
// model at world size, lit by the world's light as the body is, held the way
// its kind of tool is held (holds.js: Garry's Mod's hold types, Team Fortress
// 2's world models), with the arms reaching for it and the fists closed round
// its grips (the body's reach(), limbs.js).
//
// It moves as the first-person tool does. Every frame the viewmodel's model is
// read against its hand's rest pose (the swing, the kick, the throw, a lamp
// gone from the hand) and played on the held model about its grip. And the
// viewmodel itself, never drawn in third person, is moved onto the held model:
// what a tool works out in the world from its viewmodel (the muzzle a flash and
// a tracer leave from, a beam's start, the hook's claw) is then where the body
// holds it.
//
//   const held = createHeld({ scene });
//   held.bind(volume, g);                       // the world's light (once per grid)
//   const h = held.pick(modelKey | null, dt);   // before the body's update: { lift, ride, spine } for it
//   held.frame({ figure, yaw, pitch, scale, feet, camera, viewmodel });   // after it, before the tools run
//   held.place({ figure, dt });                 // after the tools: the model, then the hands

const REACH_RATE = 14;                  // 1/s: the arms go to a tool just drawn (and the body onto a pogo's pegs)
const RIDE_SHARE = 0.5;                 // stood on the pegs this far, the body takes its standing pose (holds.js feet)

const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
const euler = new THREE.Euler(), eulerAim = new THREE.Euler(0, 0, 0, 'YXZ');
const qA = new THREE.Quaternion();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vS = new THREE.Vector3();
const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();

export function createHeld({ scene }) {
  const group = new THREE.Group();
  group.name = 'pov-held';
  group.visible = false;
  scene.add(group);
  const uniforms = {
    uEmit: { value: new THREE.Vector3() },
    uTint: { value: new THREE.Vector4(0, 0, 0, 0) },   // no stain (its share, w, is 0)
    uWorldToGrid: { value: new THREE.Matrix4() },
  };
  const models = new Map();             // model key → its held model, built the first time it's held
  let mats = new Map(), boundTo = null, grid = null;
  let key = null, rec = null, weight = 0;
  let active = false, moved = false;
  let last = null;                      // the last reach: where the hands and feet went (checks)
  const frameM = new THREE.Matrix4();   // the grip's rest frame this frame (world), × the model's scale
  const restInv = new THREE.Matrix4();

  // a lit material per albedo (figure.js's light), for this grid
  function lit(albedo) {
    const k = albedo.join();
    if (!mats.has(k)) {
      mats.set(k, new THREE.ShaderMaterial({
        vertexShader: figureVert, fragmentShader: figureFrag(grid), side: THREE.DoubleSide,
        uniforms: { ...boundTo.material.uniforms, ...uniforms, uAlbedo: { value: new THREE.Vector3(...albedo) } },
      }));
    }
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

  function resetViewmodel(viewmodel) {
    if (!moved) return;
    viewmodel.position.set(0, 0, 0);
    viewmodel.quaternion.identity();
    viewmodel.scale.set(1, 1, 1);
    moved = false;
  }

  // the model's world matrix: the grip's rest frame, then the viewmodel's motion
  function modelMatrix(fp, out) {
    out.copy(frameM);
    if (!fp) return out;
    fp.obj.updateWorldMatrix(true, false);
    mA.copy(fp.root.matrixWorld).invert().multiply(fp.obj.matrixWorld);   // the model in the rig (cells, camera axes)
    restInv.makeTranslation(-fp.hand.userData.rest.x, -fp.hand.userData.rest.y, -fp.hand.userData.rest.z);
    return out.multiply(restInv).multiply(mA);
  }

  return {
    group,
    bind(volume, g) {
      if (boundTo === volume) return;
      boundTo = volume;
      grid = g;
      for (const m of mats.values()) m.dispose();
      mats = new Map();
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
      for (const r of models.values()) if (r) r.holder.visible = active && r === rec;
      group.visible = active;
      if (!active) { resetViewmodel(viewmodel); return; }
      uniforms.uWorldToGrid.value.copy(worldToGrid);
      const h = rec.hold;
      const at = h.feet ? vA.copy(feet) : figure.anchor(vA);
      eulerAim.set(pitch * h.pitch, yaw, 0);
      frameM.compose(at, qA.setFromEuler(eulerAim), vS.setScalar(scale));
      if (h.feet) frameM.multiply(mA.makeTranslation(h.at[0], rec.gripHeight, h.at[2]));
      else frameM.multiply(mA.makeTranslation(...h.at));
      if (h.turn) frameM.multiply(mA.makeRotationFromEuler(euler.set(...h.turn)));
      frameM.multiply(mA.makeScale(h.scale, h.scale, h.scale));
      const g = rec.model.info.grip;
      frameM.multiply(mA.makeTranslation(-g.x, -g.y, -g.z));
      // the viewmodel onto the held model: camera · viewmodel · rig root · (its hand's rest) = the frame
      const fp = firstPerson(viewmodel);
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
      const m = modelMatrix(fp, rec.holder.matrix);
      rec.holder.matrixWorldNeedsUpdate = true;
      rec.holder.updateMatrixWorld(true);
      // what the first-person tool shows or hides (a thrown lamp, the hook's claw out)
      if (fp) {
        rec.model.obj.visible = fp.obj.visible;
        const named = [];
        fp.obj.traverse((o) => { if (o !== fp.obj && o.name) named.push(o); });
        rec.named.forEach((o, i) => { if (named[i]?.name === o.name && !(rec.flame && o.name === 'flame')) o.visible = named[i].visible; });
      }
      if (rec.flame) fanFlame(rec.flame, dt, 1);
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
    get model() { return active ? rec.model.obj : null; },   // and the model itself
    get weight() { return weight; },
    dispose() {
      for (const r of models.values()) { r?.flame?.dispose(); r?.model.dispose(); }
      for (const m of mats.values()) m.dispose();
      group.removeFromParent();
    },
  };
}
