import * as THREE from 'three';
import { makeFlask, potionColor, rollPotion } from './flasks.js';
import { rollChest } from './chests.js';
import { E, ELEMENTS } from '../../elements.js';

// Descent's items (docs/descent-contract.md, "Items"): Noita's potion flasks
// lying about a level (levels.js `potions`) and its treasure chests (levels.js
// `chests`). Look at one and press E (interact.js, Noita's pick-up rule):
//
// - a flask goes into the run's item slots (descentRun.js descentWands.givePotion,
//   POTION_SLOTS = Noita's four); the toolbelt puts them in the Gadgets slot and
//   the flask tool pours, throws and drinks the one in hand;
// - a chest bursts open (its lid flies back) and spills what chests.js rollChest
//   rolled for it: gold nuggets (the Holy Mountain's walk-in nuggets), a wand or
//   spells (wand pickups, wands/loot.js, through descentWands.place) or a flask
//   (a pickup here). Opened chests stay open.
//
// Everything is seeded by its site, so a level holds the same things every run
// (as the wand loot), and what's taken stays taken for the run (descentWands.taken).
// Positions are world cells; the grid is world − sim.origin.

const CELL_CENTRE = 0.5;               // a site's integer cell → its centre on x and z
const FLASK_R = 0.55;                  // cells, the bulb's radius (a flask is about a third of a metre)
const FLASK_NECK = [0.18, 0.5];        // cells, the neck's radius and length
const FLASK_LIFT = FLASK_R + 0.05;     // cells from the floor to the bulb's centre: it stands on the floor
const FLASK_GLOW = 0.6;                // emissive share of the liquid's colour, so a flask reads in a dark tunnel
const FLASK_TARGET_R = 1.2;            // cells: how near the crosshair must pass to focus a flask
const CHEST = [3, 1.6, 2];             // cells, a chest's width, body height, depth (Noita's chest sprite, ~0.9 × 0.6 m)
const LID_H = 0.6;                     // cells, the lid's height
const BAND_W = 0.3;                    // cells, the gold band over the lid
const LID_OPEN = 1.9;                  // rad the lid swings back to on opening...
const LID_OPEN_S = 0.35;               // ...over this long
const CHEST_TARGET_R = 1.8;            // cells: look target radius
const CHEST_WOOD = '#6b4423', CHEST_TRIM = '#d8b04a';
const CHEST_GLOW = '#3a2408';          // a closed chest's faint emissive (it catches the eye in the dark, as Noita's glints)
const SPILL_R = 3;                     // cells from a chest's middle its spilled items land (a ring, golden angle apart)
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const mainName = (cells) => {
  const n = new Map();
  for (const c of cells) n.set(c[0], (n.get(c[0]) ?? 0) + 1);
  let best = -1, k = 0;
  for (const [id, m] of n) if (m > k) { best = id; k = m; }
  return best >= 0 ? ELEMENTS[best].name : 'nothing';
};
// the hotbar's / prompt's name for a carried flask: what it mostly holds now
export const flaskLabel = (f) => (f.cells.length ? `Flask of ${mainName(f.cells).toLowerCase()}` : 'Empty flask');

// app: the POV's app (getSim, getVolume, getScale, requestRender); root: the Group to draw in;
// spill(worldFeet, values, seed): the Holy Mountain's nugget spill; wands(): descentWands (deps.js); generator: deps.js's
export function createDescentItems({ app, root, interact, toast, events, spill, wands, generator }) {
  const group = new THREE.Group();
  group.name = 'descent-items';
  root.add(group);
  const bulbGeo = new THREE.SphereGeometry(FLASK_R, 14, 10);
  const neckGeo = new THREE.CylinderGeometry(FLASK_NECK[0], FLASK_NECK[0], FLASK_NECK[1], 8);
  const glassMat = new THREE.MeshStandardMaterial({ color: '#cfe8ef', roughness: 0.1, metalness: 0.2 });
  const woodMat = new THREE.MeshStandardMaterial({ color: CHEST_WOOD, emissive: CHEST_GLOW, roughness: 0.8 });
  const trimMat = new THREE.MeshStandardMaterial({ color: CHEST_TRIM, emissive: CHEST_GLOW, metalness: 0.8, roughness: 0.35 });
  const bodyGeo = new THREE.BoxGeometry(CHEST[0], CHEST[1], CHEST[2]);
  const lidGeo = new THREE.BoxGeometry(CHEST[0], LID_H, CHEST[2]).translate(0, LID_H / 2, CHEST[2] / 2);   // hinged at the back edge
  const bandGeo = new THREE.BoxGeometry(BAND_W, LID_H + 0.02, CHEST[2] + 0.02).translate(0, LID_H / 2, CHEST[2] / 2);
  const potionMats = new Map();
  const potionMat = (key) => {
    if (!potionMats.has(key)) {
      const c = new THREE.Color(potionColor(key));
      potionMats.set(key, new THREE.MeshStandardMaterial({ color: c, emissive: c.clone().multiplyScalar(FLASK_GLOW), roughness: 0.2 }));
    }
    return potionMats.get(key);
  };

  let level = null, potions = [], chests = [];   // { world (Vector3, feet), obj, ... }
  const toGrid = (world, out = new THREE.Vector3()) => out.copy(world).sub(app.getSim().origin);
  const siteWorld = (s) => new THREE.Vector3(s.x + CELL_CENTRE, s.y, s.z + CELL_CENTRE);

  function addPotion(world, material, site) {
    const obj = new THREE.Group();
    const bulb = new THREE.Mesh(bulbGeo, potionMat(material));
    bulb.position.y = FLASK_LIFT;
    const neck = new THREE.Mesh(neckGeo, glassMat);
    neck.position.y = FLASK_LIFT + FLASK_R + FLASK_NECK[1] / 2 - 0.1;
    obj.add(bulb, neck);
    group.add(obj);
    potions.push({ world, material, site, obj });
  }
  function addChest(world, site, tier, yaw) {
    const obj = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, woodMat);
    body.position.y = CHEST[1] / 2;
    const lid = new THREE.Group();
    lid.position.set(0, CHEST[1], -CHEST[2] / 2);
    lid.add(new THREE.Mesh(lidGeo, woodMat), new THREE.Mesh(bandGeo, trimMat));
    obj.add(body, lid);
    obj.rotation.y = yaw;
    group.add(obj);
    chests.push({ world, site, tier, obj, lid, open: false, openT: 0 });
  }
  const dropObj = (it) => { it.obj?.removeFromParent(); it.obj = null; };

  function leave() {
    potions.forEach(dropObj); chests.forEach(dropObj);
    potions = []; chests = []; level = null;
  }
  // a new run (descentRun.js reset) may land after this level's arrival: lay it out again, nothing taken
  // (subscribed on the first arrival: the toolbelt that may carry descentWands doesn't exist at construction)
  let offReset = null;
  function arrive(lv) {
    offReset ??= wands().on?.('reset', () => { if (level) arrive(level); }) ?? (() => {});
    leave();
    level = lv;
    (lv.potions ?? []).forEach((s, i) => {
      const site = `${lv.key}:potion:${i}`;
      if (!wands().taken?.(site)) addPotion(siteWorld(s), rollPotion(s.tier ?? lv.tier, site), site);
    });
    (lv.chests ?? []).forEach((s, i) => {
      const site = `${lv.key}:chest:${i}`;
      addChest(siteWorld(s), site, s.tier ?? lv.tier, (i * GOLDEN) % (Math.PI * 2));
      if (wands().taken?.(site)) { const c = chests.at(-1); c.open = true; c.openT = LID_OPEN_S; }
    });
    app.requestRender?.();
  }

  function takePotion(p) {
    const slot = wands().givePotion?.(makeFlask(p.material, p.site)) ?? -1;
    if (slot < 0) { toast(`Your item slots are full (${wands().potions?.length ?? 0} flasks): throw or drink one`); return false; }
    wands().markTaken?.(p.site);
    toast(`Flask of ${ELEMENTS[E[p.material]].name.toLowerCase()}: item ${slot + 1} (5, Gadgets)`);
    events.emit('descent:item', { kind: 'potion', material: p.material, slot });
    dropObj(p);
    potions = potions.filter((x) => x !== p);
    app.requestRender?.();
    return true;
  }

  function openChest(c) {
    if (c.open) return false;
    c.open = true;
    wands().markTaken?.(c.site);
    const got = rollChest(c.tier, c.site);
    const gold = got.filter((g) => g.kind === 'gold').map((g) => g.value);
    if (gold.length) spill(c.world.clone(), gold, gold.length * 7 + c.tier);
    let a = 0, n = 0;
    const ring = () => { a += GOLDEN; n++; return c.world.clone().add(new THREE.Vector3(Math.cos(a) * SPILL_R, 0, Math.sin(a) * SPILL_R)); };
    for (const g of got) {
      if (g.kind === 'potion') addPotion(ring(), g.material, `${c.site}:${g.seed}`);
      else if (g.kind === 'wand') { const w = ring(); wands().place?.({ kind: 'wand', wand: generator.generateWand(c.tier, g.seed), world: [w.x, w.y, w.z], site: `${c.site}:${g.seed}` }); }
      else if (g.kind === 'spell') { const w = ring(); wands().place?.({ kind: 'spell', spell: generator.randomSpell(c.tier, g.seed), world: [w.x, w.y, w.z], site: `${c.site}:${g.seed}` }); }
    }
    const sum = gold.reduce((s, v) => s + v, 0);
    toast(`The chest bursts open${sum ? `: $ ${sum} in gold` : ''}${n ? `, and ${n} thing${n > 1 ? 's' : ''} more` : ''}`);
    events.emit('descent:chest', { site: c.site, items: got });
    app.requestRender?.();
    return true;
  }


  const offInteract = interact.provide(() => {
    if (!level) return [];
    const out = [];
    for (const p of potions) {
      const at = toGrid(p.world); at.y += FLASK_LIFT;
      out.push({ id: `descent-potion-${p.site}`, position: at, radius: FLASK_TARGET_R, verb: 'Take',
        title: `Flask of ${ELEMENTS[E[p.material]].name.toLowerCase()}`,
        lines: [ELEMENTS[E[p.material]].desc ?? '', 'Click pours · right-click throws · H drinks'].filter(Boolean), use: () => takePotion(p) });
    }
    for (const c of chests) {
      if (c.open) continue;
      const at = toGrid(c.world); at.y += CHEST[1] / 2;
      out.push({ id: `descent-chest-${c.site}`, position: at, radius: CHEST_TARGET_R, verb: 'Open', title: 'Treasure chest',
        lines: ['Gold, and maybe a wand, spells or a potion'], use: () => openChest(c) });
    }
    return out;
  });

  const v = new THREE.Vector3();
  function update(f) {
    const sim = app.getSim?.(), vol = app.getVolume?.(), scale = app.getScale?.();
    if (!sim || !vol || !level) return;
    const g = sim.g;
    for (const it of [...potions, ...chests]) {
      if (!it.obj) continue;
      toGrid(it.world, v);
      const inside = v.x >= 0 && v.z >= 0 && v.x < g.nx && v.z < g.nz;
      it.obj.visible = inside;
      if (!inside) continue;
      it.obj.position.copy(v).multiplyScalar(scale).add(vol.position);
      it.obj.scale.setScalar(scale);
      if (it.lid && it.open && it.openT < LID_OPEN_S) { it.openT = Math.min(LID_OPEN_S, it.openT + f.dt); app.requestRender?.(); }
      if (it.lid) it.lid.rotation.x = -LID_OPEN * (it.open ? it.openT / LID_OPEN_S : 0);
    }
  }

  return {
    arrive, leave, update,
    get potions() { return potions; },
    get chests() { return chests; },
    openChest, takePotion,
    dispose() {
      leave(); offInteract(); offReset?.();
      group.removeFromParent();
      for (const x of [bulbGeo, neckGeo, glassMat, woodMat, trimMat, bodyGeo, lidGeo, bandGeo, ...potionMats.values()]) x.dispose();
    },
  };
}
