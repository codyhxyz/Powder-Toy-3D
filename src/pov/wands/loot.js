import * as THREE from 'three';
import { SPELL_BY_ID } from './catalog.js';
import { generateWand, randomSpell } from './generate.js';
import { lookOf, wandLook } from './look.js';
import { descentWands } from './descentRun.js';
import { lootSites } from './descentSites.js';

export { descentWands } from './descentRun.js';

// Descent's wand and spell pickups (docs/descent-contract.md, B): a floating
// wand or a glowing spell card over each of a level's `loot` sites of kind
// 'wand' / 'spell' (gold is the Holy Mountain's, agent C's). Noita's rule: look
// at one and its name and stats show (interact.js), press E to take it.
// A wand with all four slots full takes the held wand's place, and the held one
// drops at your feet as a pickup. Each site's wand or spell is rolled from its
// tier and its place (generate.js; Noita seeds an item by its position).
//
// Drawn as three instanced meshes (shafts, gems, cards): one draw each, however many.

const MAX_PICKUPS = 64;              // a level's worth, plus what you drop
const LIFT = 2.5;                    // cells from the site (its floor) to the pickup's centre
const BOB = 0.3, BOB_HZ = 0.5;       // cells up and down, cycles a second
const SPIN_HZ = 0.25;                // turns a second
const WAND_LEN = 3.2;                // cells (about 1 m at 0.30 m a cell)
const WAND_R = 0.14;                 // cells, the shaft's radius
const GEM_R = 0.38;                  // cells
const CARD = [1.2, 1.6, 0.12];       // cells, a spell card's width, height, depth
const TARGET_R = 1.6;                // cells: how near the crosshair must pass to focus a pickup
const GLOW = 1.6;                    // the gem's and card's colour gain (HDR: they read as lit)
const SHAFT_COLOR = '#674426';       // the held wand's wood (tools/index.js)
const PHASE_STEP = 0.37;             // bob cycles between pickups, so neighbours don't bob in step
const DROP_AHEAD = 2;                // cells in front of the feet a swapped wand lands

const fmt = (s) => `${Number(s).toFixed(2)} s`;
// a wand's stat lines, as Noita's wand card lists them
export function wandLines(w) {
  const c = w.config;
  const counts = new Map();
  for (const id of w.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  const spells = [...counts].map(([id, n]) => `${SPELL_BY_ID[id]?.name ?? id}${n > 1 ? ` ×${n}` : ''}`).join(', ');
  return [
    `Shuffle ${c.shuffle ? 'Yes' : 'No'} · Spells/cast ${c.spellsPerCast ?? 1}`,
    `Cast delay ${fmt(c.castDelay)} · Recharge ${fmt(c.recharge)}`,
    `Mana ${c.manaMax} · Charge ${c.manaRegen}/s · Capacity ${c.capacity}`,
    spells,
  ];
}

export function createDescentLoot({ scene, getSim, getVolume, getScale, interact, getFeet, toast }) {
  const root = new THREE.Group();
  root.name = 'descent-loot';
  scene.add(root);
  const instanced = (geometry, material) => {
    const m = new THREE.InstancedMesh(geometry, material, MAX_PICKUPS);
    m.count = 0; m.frustumCulled = false; m.renderOrder = 1;
    root.add(m);
    return m;
  };
  const shafts = instanced(new THREE.CylinderGeometry(WAND_R, WAND_R * 1.4, WAND_LEN, 8), new THREE.MeshBasicMaterial({ color: SHAFT_COLOR }));
  const gems = instanced(new THREE.IcosahedronGeometry(GEM_R, 0), new THREE.MeshBasicMaterial({ toneMapped: false }));
  const cards = instanced(new THREE.BoxGeometry(...CARD), new THREE.MeshBasicMaterial({ toneMapped: false }));

  let list = [], nextId = 1;   // { id, kind, world (Vector3, world cells: the pickup's foot), wand?, spell?, site? }
  const add = (p) => { if (list.length < MAX_PICKUPS) list.push({ ...p, id: nextId++ }); };

  // the level's sites, but for those taken this run
  function setLevel(level) {
    list = list.filter((p) => !p.site);   // dropped wands stay (they're where you left them)
    if (!level) { list = []; return; }
    lootSites(level).forEach((s, i) => {
      const site = `${level.key}:${i}`;
      if (descentWands.taken(site) || (s.kind !== 'wand' && s.kind !== 'spell')) return;
      const world = new THREE.Vector3(s.x, s.y, s.z);
      if (s.kind === 'wand') add({ kind: 'wand', world, wand: generateWand(s.tier ?? level.tier, site), site });
      else add({ kind: 'spell', world, spell: randomSpell(s.tier ?? level.tier, site), site });
    });
  }

  // a wand left at grid feet `feet` (the swap's old wand)
  function drop(wand, feet, dir = null) {
    const world = feet.clone().add(getSim().origin);
    if (dir) world.addScaledVector(new THREE.Vector3(dir.x, 0, dir.z).normalize(), DROP_AHEAD);
    add({ kind: 'wand', world, wand });
  }
  const offDrop = descentWands.on('drop', (wand) => { const f = getFeet?.(); if (f) drop(wand, f.feet, f.dir); });

  function take(p) {
    if (p.kind === 'wand') {
      const got = descentWands.give(p.wand);
      if (!got) return false;
      toast?.(got.dropped ? `${p.wand.name} (dropped ${got.dropped.name})` : `${p.wand.name}: wand ${got.slot + 1}`);
    } else {
      if (!descentWands.giveSpell(p.spell)) { toast?.('Your spell bag is full'); return false; }
      toast?.(`${SPELL_BY_ID[p.spell].name}: in your bag (edit wands at a Holy Mountain)`);
    }
    if (p.site) descentWands.markTaken(p.site);
    list = list.filter((x) => x !== p);
    return true;
  }

  const grid = (p, out) => {
    const sim = getSim();
    out.copy(p.world).sub(sim.origin);
    const g = sim.g;
    return out.x >= 0 && out.z >= 0 && out.x < g.nx && out.z < g.nz ? out : null;
  };
  const offInteract = interact?.provide(() => list.map((p) => {
    const at = grid(p, new THREE.Vector3());
    if (!at) return null;
    at.y += LIFT;
    const spell = p.kind === 'spell' ? SPELL_BY_ID[p.spell] : null;
    return { id: `descent-loot${p.id}`, position: at, radius: TARGET_R, verb: 'Take',
      title: p.kind === 'wand' ? p.wand.name : spell.name,
      lines: p.kind === 'wand' ? wandLines(p.wand) : [spell.description, `${spell.category} · Mana ${spell.mana ?? spell.params?.mana ?? 0}`],
      use: () => take(p) };
  }).filter(Boolean));

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), at = new THREE.Vector3();
  const color = new THREE.Color();
  function update(time = performance.now() / 1000) {
    const sim = getSim(), vol = getVolume(), scale = getScale();
    let nw = 0, nc = 0;
    if (sim && vol) {
      s.setScalar(scale);
      for (const p of list) {
        if (!grid(p, at)) continue;
        at.y += LIFT + BOB * Math.sin((time * BOB_HZ + p.id * PHASE_STEP) * Math.PI * 2);
        at.multiplyScalar(scale).add(vol.position);
        const spin = (time * SPIN_HZ + p.id * PHASE_STEP) * Math.PI * 2;
        if (p.kind === 'wand') {
          q.setFromEuler(e.set(0, spin, Math.PI / 2 - 0.25));   // lying nearly flat, turning
          shafts.setMatrixAt(nw, m.compose(at, q, s));
          const tip = new THREE.Vector3(0, WAND_LEN / 2, 0).applyQuaternion(q).multiplyScalar(scale).add(at);
          gems.setMatrixAt(nw, m.compose(tip, q, s));
          gems.setColorAt(nw, color.copy(wandLook(p.wand.cards).color).multiplyScalar(GLOW));
          nw++;
        } else {
          q.setFromEuler(e.set(0, spin, 0));
          cards.setMatrixAt(nc, m.compose(at, q, s));
          const spell = SPELL_BY_ID[p.spell];
          cards.setColorAt(nc, color.copy(lookOf(spell.effect, spell.params?.material).color).multiplyScalar(GLOW));
          nc++;
        }
      }
    }
    shafts.count = gems.count = nw; cards.count = nc;
    for (const mesh of [shafts, gems, cards]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return nw + nc > 0;
  }

  return {
    setLevel, drop, update,
    get list() { return list; },
    dispose() {
      offDrop(); offInteract?.();
      root.removeFromParent();
      for (const mesh of [shafts, gems, cards]) { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }
    },
  };
}
