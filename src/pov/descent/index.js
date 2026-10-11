import * as THREE from 'three';
import { BODY_HEIGHT, BODY_WIDTH, HAND_REACH } from '../constants.js';
import { SPELL_BY_ID } from '../wands/catalog.js';
import { DESCENT_LEVELS, levelByScene, generator, descentWands, interact, interactIsStub, fallbackPick } from './deps.js';
import { createPurse, siteNuggets, splitGold, enemyGold, DROP_LIFETIME_S, DROP_BLINK_S, NUGGET } from './gold.js';
import { rollShop, buy } from './shop.js';
import { hashString, mixSeed } from './rng.js';

// The Holy Mountain (docs/descent-contract.md, C): Noita's temple between biomes,
// and the gold that pays for it. On a Descent level (A's levels.js) it keeps:
//
// - Gold: the run's purse (gold.js). Nuggets lie at the level's 'gold' loot sites
//   and spill from killed enemies; walk over one to take it (Noita's nuggets are
//   walk-in). Noita ends a run on death, gold and all; for now a death respawns
//   you at the drop point with your gold kept (pov/index.js owns the respawn).
// - The shop: one item over each of the temple's pedestals (shop.js rollShop),
//   B's wands and spells at Noita's prices. Look at one to read its name, price
//   and text, press E to buy it (Noita's rule), if the gold is there.
// - The perk altar: the existing shrine offers (perkOrbs.js shrineAt over the
//   temple's altars): taking one takes the others away (Noita's).
// - The healing pool: Noita's temple heals you to full, once a visit: on
//   entering the temple or touching its pool.
// - The spell refresher: look at it, press E: B's descentWands.refresh(), and
//   it is used up (Noita's is a one-off pickup).
//
// Positions in levels.js are world cells; the grid (the window) is world minus
// sim.origin, as perkOrbs.js does it.

const CELL_CENTRE = 0.5;                 // a site's integer cell → its centre on x and z
const ITEM_LIFT = BODY_HEIGHT * 0.5;     // cells over a pedestal top to an item's centre: chest height, as a perk orb
const ITEM_SIZE = 2.2;                   // cells across an item's icon (perkOrbs.js ORB_SIZE)
const PRICE_LIFT = 1.8;                  // cells over the icon's centre to its price tag
const PRICE_W = 3.2, PRICE_H = 1.0;      // cells, the price tag's sprite
const USE_RADIUS = HAND_REACH;           // cells: look + E reaches as far as the hands (Minecraft's reach)
const BOB = 0.2, BOB_HZ = 0.5;           // cells and Hz an item floats up and down (perkOrbs.js)
const NUGGET_REACH = 1.2;                // cells beyond the body's box that still pick up a nugget (walk-in)
const NUGGET_LIFT = 0.35;                // cells a nugget's centre sits over its cell
const NUGGET_SIZE = { [NUGGET.SMALL]: 0.35, [NUGGET.BIG]: 0.55, [NUGGET.HUGE]: 0.8 };   // cells across, by value
const NUGGET_SPREAD = 1.5;               // cells a site's clump (and an enemy's spill) spreads over
const NUGGET_SPIN = 1.5;                 // rad/s
const BLINK_HZ = 6;                      // blinks per second of an expiring drop
const SHOP_SALT = 0x5a0b, NUGGET_SALT = 0x6017;   // seed streams per temple: the shop's, the nuggets'
const TEX_PX = 256;                      // label texture width
const GOLD_COLOR = '#ffd34d';
const REFRESH_ICON = '♻️';               // the refresher: a vial in Noita; here its symbol
const WAND_ICON = '🪄', SPELL_ICON = '✨';
const HEAL_TEXT = 'The Holy Mountain heals you';

function labelTexture(lines, { color = '#fff', back = 'rgba(20,16,32,0.8)', aspect = 1, font = 0.5 } = {}) {
  const c = document.createElement('canvas');
  c.width = TEX_PX; c.height = Math.round(TEX_PX / aspect);
  const g = c.getContext('2d');
  if (back) {
    g.fillStyle = back;
    g.beginPath(); g.roundRect?.(0, 0, c.width, c.height, c.height * 0.25); g.fill();
  }
  const fs = Math.round(c.height * font / lines.length);
  g.font = `bold ${fs}px system-ui,"Apple Color Emoji","Segoe UI Emoji",sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color;
  lines.forEach((t, i) => g.fillText(t, c.width / 2, (c.height * (i + 0.5)) / lines.length, c.width * 0.92));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function sprite(tex, w, h) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(w, h, 1);
  s.renderOrder = 1;
  return s;
}
const disposeObj = (o) => o.traverse((m) => { m.geometry?.dispose?.(); m.material?.map?.dispose(); m.material?.dispose?.(); });

const spellName = (id) => SPELL_BY_ID[id]?.name ?? id;
const spellDesc = (id) => SPELL_BY_ID[id]?.description ?? '';

// app: the POV's app (getSim, getVolume, getScale, getPerkOrbs, settings, inWorld, requestRender);
// hud: the god view's (toast); events: povEvents
export function createDescent({ app, scene, hud, events, getToolbelt = () => null }) {
  const purse = createPurse();
  const root = new THREE.Group();
  root.name = 'descent';
  scene.add(root);
  const nuggetGeo = new THREE.OctahedronGeometry(0.5, 0);
  const nuggetMat = new THREE.MeshStandardMaterial({ color: GOLD_COLOR, emissive: '#7a5200', metalness: 0.9, roughness: 0.3 });

  let runSeed = (Math.random() * 2 ** 32) >>> 0;
  let level = null, levelSeed = 0, pendingArrive = null;
  let shop = [], refresher = null, nuggets = [], shrine = 0, healed = false;
  const unregs = [];
  const npcDead = new Map();   // NPC id → was dead last frame
  let ePressed = false, lastPick = null;

  const offs = [events.on('descent:level', ({ key }) => { pendingArrive = key; })];
  const onKey = (e) => { if (e.code === 'KeyE' && !e.repeat) ePressed = true; };
  if (interactIsStub) addEventListener('keydown', onKey);

  const toGrid = (world, out = new THREE.Vector3()) => out.copy(world).sub(app.getSim().origin);
  const toWorld = (grid, out = new THREE.Vector3()) => out.copy(grid).add(app.getSim().origin);
  const site = ([x, y, z]) => new THREE.Vector3(x + CELL_CENTRE, y, z + CELL_CENTRE);
  const inBox = (p, [x0, y0, z0, x1, y1, z1]) => p.x + BODY_WIDTH / 2 >= x0 && p.x - BODY_WIDTH / 2 <= x1
    && p.y + BODY_HEIGHT >= y0 && p.y <= y1 && p.z + BODY_WIDTH / 2 >= z0 && p.z - BODY_WIDTH / 2 <= z1;

  function addItem(world, iconTex, priceText) {
    const g = new THREE.Group();
    const icon = sprite(iconTex, ITEM_SIZE, ITEM_SIZE);
    icon.position.y = ITEM_LIFT;
    g.add(icon);
    if (priceText) {
      const tag = sprite(labelTexture([priceText], { color: GOLD_COLOR, aspect: PRICE_W / PRICE_H, font: 0.7 }), PRICE_W, PRICE_H);
      tag.position.y = ITEM_LIFT + PRICE_LIFT;
      g.add(tag);
    }
    g.userData.icon = icon;
    root.add(g);
    return { world, obj: g };
  }
  function dropItem(it) { if (!it?.obj) return; it.obj.removeFromParent(); disposeObj(it.obj); it.obj = null; it.unreg?.(); }

  function addNugget(world, value, life = Infinity) {
    const m = new THREE.Mesh(nuggetGeo, nuggetMat);
    m.scale.setScalar(NUGGET_SIZE[value] ?? NUGGET_SIZE[NUGGET.SMALL]);
    root.add(m);
    nuggets.push({ world, value, life, obj: m, phase: Math.random() * Math.PI * 2 });
  }
  function spill(worldFeet, values, seed, life) {
    let a = (seed % 1000) / 1000 * Math.PI * 2;
    values.forEach((v, i) => {
      const r = i ? NUGGET_SPREAD : 0;
      a += Math.PI * (3 - Math.sqrt(5));   // golden angle: a clump without overlaps
      addNugget(worldFeet.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)), v, life);
    });
  }

  function leave() {
    for (const u of unregs.splice(0)) u();
    shop.forEach(dropItem); shop = [];
    dropItem(refresher); refresher = null;
    for (const n of nuggets) n.obj.removeFromParent();
    nuggets = [];
    npcDead.clear();
    level = null; shrine = 0; healed = false; lastPick = null;
  }

  function arrive(lv) {
    leave();
    level = lv;
    if (DESCENT_LEVELS.indexOf(lv) === 0) { purse.reset(0); runSeed = (Math.random() * 2 ** 32) >>> 0; }   // a new run (Noita's starts with 0 gold)
    levelSeed = mixSeed(runSeed, hashString(lv.key));
    const t = lv.temple, tier = lv.tier;
    // the shop
    if (t?.shop?.length) {
      shop = rollShop(tier, mixSeed(levelSeed, SHOP_SALT), t.shop.length, generator).map((s) => {
        const at = site(t.shop[s.slot]);
        const icon = labelTexture(s.kind === 'wand' ? [WAND_ICON] : [SPELL_ICON], { back: null, font: 0.6 });
        const it = Object.assign(s, addItem(at, icon, `$ ${s.price}`));
        it.unreg = interact.register({
          id: `descent-shop-${s.slot}`,
          position: () => toGrid(at).setY(at.y + ITEM_LIFT),
          radius: USE_RADIUS,
          label: () => itemLabel(it),
          onUse: () => buyItem(it),
        });
        unregs.push(it.unreg);
        return it;
      });
    }
    // the refresher
    if (t?.refresher) {
      const at = site(t.refresher);
      refresher = addItem(at, labelTexture([REFRESH_ICON], { back: null, font: 0.6 }), null);
      refresher.unreg = interact.register({
        id: 'descent-refresher',
        position: () => toGrid(at).setY(at.y + ITEM_LIFT),
        radius: USE_RADIUS,
        label: () => ({ title: 'Spell refresher', lines: ['Refills your wands\' limited spells, mana and storage', 'E to use'] }),
        onUse: useRefresher,
      });
      unregs.push(refresher.unreg);
    }
    // the perk altar: the shrine's offers, one perk over each altar
    const orbs = app.getPerkOrbs?.();
    if (orbs && t?.altars?.length) {
      const got = orbs.shrineAt(t.altars.map((a) => toGrid(site(a))));
      shrine = got?.[0]?.shrine ?? 0;
    }
    // gold at the 'gold' loot sites
    (lv.loot ?? []).forEach((l, i) => {
      if (l.kind !== 'gold') return;
      spill(site([l.x, l.y, l.z]), siteNuggets(l.tier ?? tier, mixSeed(levelSeed, NUGGET_SALT, i)), mixSeed(levelSeed, i));
    });
    app.requestRender?.();
  }

  function itemLabel(it) {
    const can = purse.canAfford(it.price) ? 'E to buy' : `Not enough gold (you have $ ${purse.gold})`;
    if (it.kind === 'wand') {
      const c = it.wand.config ?? {};
      const spells = (it.wand.cards ?? []).map(spellName).join(', ');
      return { title: `${WAND_ICON} ${it.wand.name ?? 'Wand'}  $ ${it.price}`,
        lines: [`Mana ${c.manaMax ?? '?'} · regen ${c.manaRegen ?? '?'}/s · cast delay ${c.castDelay ?? '?'} s · recharge ${c.recharge ?? '?'} s`, spells && `Spells: ${spells}`, can].filter(Boolean) };
    }
    return { title: `${SPELL_ICON} ${spellName(it.spell)}  $ ${it.price}`, lines: [spellDesc(it.spell), can].filter(Boolean) };
  }

  function buyItem(it) {
    const r = buy(it, purse);
    if (r === 'poor') {
      hud.toast(`Not enough gold: $ ${it.price}, you have $ ${purse.gold}`);
      events.emit('descent:refuse', { price: it.price, gold: purse.gold });
      return false;
    }
    if (r !== 'bought') return false;
    const w = descentWands(getToolbelt());
    if (it.kind === 'wand') w.give(it.wand); else w.giveSpell(it.spell);
    const name = it.kind === 'wand' ? it.wand.name ?? 'Wand' : spellName(it.spell);
    hud.toast(`Bought ${name} for $ ${it.price}${it.kind === 'spell' && w.stub ? ' (the spell bag is not in yet)' : ''}`);
    events.emit('descent:buy', { kind: it.kind, id: it.kind === 'wand' ? it.wand.id : it.spell, price: it.price, gold: purse.gold });
    dropItem(it);
    app.requestRender?.();
    return true;
  }

  function useRefresher() {
    if (!refresher?.obj) return false;
    const w = descentWands(getToolbelt());
    w.refresh();
    hud.toast(w.stub ? 'Spells refreshed (the refill lands with the wand bag)' : 'Spells refreshed');
    events.emit('descent:refresh', {});
    dropItem(refresher);
    app.requestRender?.();
    return true;
  }

  // the frame's work. f = { dt, time, player, live (in the body, alive), npcs: [{ id, body, kind }] }
  function update(f) {
    const sim = app.getSim?.(), vol = app.getVolume?.(), scale = app.getScale?.();
    if (!sim || !vol) return;
    const key = app.inWorld?.() ? app.settings.scene : null;
    const lv = key ? levelByScene(key) : null;
    if (!lv) { if (level) leave(); pendingArrive = null; ePressed = false; return; }
    // arrive on A's descent:level, or (before it lands) the first live frame on a new level
    if (pendingArrive === lv.key && lv === level) pendingArrive = null;   // already set up (the live frame came first): keep what was bought
    if (pendingArrive === lv.key || (lv !== level && f.live)) { pendingArrive = null; arrive(lv); }
    if (!level) { ePressed = false; return; }
    const p = f.player, g = sim.g, v = new THREE.Vector3();

    // the healing pool: full health once a visit (Noita's)
    if (f.live && !healed && level.temple) {
      const feetW = toWorld(p.pos, v);
      if ((level.temple.box && inBox(feetW, level.temple.box)) || (level.temple.pool && inBox(feetW, level.temple.pool))) {
        healed = true;
        p.heal(1);
        hud.toast(HEAL_TEXT);
        events.emit('descent:heal', {});
      }
    }

    // gold off the enemies that died this frame
    for (const n of f.npcs ?? []) {
      const was = npcDead.get(n.id) ?? false, dead = !!n.body?.dead;
      npcDead.set(n.id, dead);
      if (dead && !was) spill(toWorld(n.body.pos, new THREE.Vector3()), splitGold(enemyGold(n.kind)), n.id * 7919, DROP_LIFETIME_S);
    }

    // nuggets: walk-in pickup, expiry, drawing
    const hw = BODY_WIDTH / 2 + NUGGET_REACH;
    for (let i = nuggets.length - 1; i >= 0; i--) {
      const n = nuggets[i];
      n.life -= f.dt;
      toGrid(n.world, v);
      const taken = f.live && Math.abs(v.x - p.pos.x) <= hw && Math.abs(v.z - p.pos.z) <= hw
        && v.y >= p.pos.y - NUGGET_REACH && v.y <= p.pos.y + BODY_HEIGHT + NUGGET_REACH;
      if (taken) { purse.add(n.value); events.emit('descent:gold', { amount: n.value, gold: purse.gold, point: v.clone() }); }
      if (taken || n.life <= 0) { n.obj.removeFromParent(); nuggets.splice(i, 1); app.requestRender?.(); continue; }
      const inside = v.x >= 0 && v.z >= 0 && v.x < g.nx && v.z < g.nz;
      n.obj.visible = inside && !(n.life < DROP_BLINK_S && Math.sin(f.time * BLINK_HZ * Math.PI * 2) < 0);
      if (!inside) continue;
      n.obj.position.copy(v).setY(v.y + NUGGET_LIFT).multiplyScalar(scale).add(vol.position);
      n.obj.rotation.y = n.phase + f.time * NUGGET_SPIN;
      n.obj.scale.setScalar(scale * (NUGGET_SIZE[n.value] ?? NUGGET_SIZE[NUGGET.SMALL]));
    }

    // shop items and the refresher follow the window and bob
    for (const it of [...shop, refresher]) {
      if (!it?.obj) continue;
      toGrid(it.world, v);
      const inside = v.x >= 0 && v.z >= 0 && v.x < g.nx && v.z < g.nz;
      it.obj.visible = inside;
      if (!inside) continue;
      it.obj.position.copy(v).multiplyScalar(scale).add(vol.position);
      it.obj.scale.setScalar(scale);
      it.obj.userData.icon.position.y = ITEM_LIFT + BOB * Math.sin(f.time * BOB_HZ * Math.PI * 2 + it.world.x);
    }

    // look + E, until src/pov/interact.js lands: the nearest item in reach, its label as a toast
    if (interactIsStub) {
      const pick = f.live ? fallbackPick(v.copy(p.pos).setY(p.pos.y + ITEM_LIFT)) : null;
      if (pick && pick !== lastPick) { const l = pick.label(); hud.toast([l.title, ...l.lines].join(' · ')); }
      lastPick = pick;
      if (ePressed && pick) pick.onUse();
    }
    ePressed = false;
  }

  return {
    update,
    purse,
    get gold() { return purse.gold; },
    // the HUD's counter: shown on a Descent level, or once there is gold
    get goldShown() { return level || purse.gold > 0 ? purse.gold : null; },
    get level() { return level; },
    get shop() { return shop; },
    get shrine() { return shrine; },
    get nuggets() { return nuggets; },
    get refresher() { return refresher; },
    arrive: (key) => { const lv = levelByScene(key); if (lv) arrive(lv); },   // checks: set up a level by hand
    dispose() {
      leave();
      offs.forEach((o) => o());
      removeEventListener('keydown', onKey);
      root.removeFromParent();
      nuggetGeo.dispose(); nuggetMat.dispose();
    },
  };
}
