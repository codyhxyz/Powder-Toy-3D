import * as THREE from 'three';
import { povEvents } from '../pov/events.js';
import { PLAYER } from '../pov/targets.js';
import { gearByKey } from '../pov/tools/catalog.js';
import { attachModel } from '../pov/models.js';
import * as R from './rules.js';

// Halo's arsenal, for the team games played by Halo's rules (rules.js MODES
// style 'halo'; docs/modes.md "Halo rules", docs/halo-contract.md):
//
// - The equal start, on every game:spawn (the match's start, each respawn):
//   one Energy Shield stack, the same two guns (body.carry), the SMG in hand
//   and two frag grenades (body.grenades; the combat module throws them). What
//   a body earned before (a shrine's perks, a class's) doesn't carry over. The
//   infected carry their melee only, no grenades.
// - The carry: body.carry holds the guns a body has, two at most (Halo's
//   limit). The player's hands are restricted to it (toolbelt.restrict: 1 and
//   2 and the wheel swap them; no sandbox tools, no wands); a bot's brain fights
//   with it (agent.weapons). A flag carrier has melee only while carrying.
// - Power weapons on pads (layout.weapons: [{ key, at, respawnS }]): one
//   floats over each glowing pad; look at it and press E (interact.js) to take
//   it in place of the gun in hand, which drops. Each has a few shots (counted
//   from gun:fire); spent, it's gone and the other gun is back in hand. A body
//   that dies drops its power weapon where it fell, and a weapon left lying
//   goes after DROP_S. A pad's timer starts when its weapon is taken, and it
//   brings a new one only once the old one is out of play.
// - Halo's shots to kill: a hit's share in a Halo match (damageShare) makes each
//   gun kill a full-shielded body in Halo's number of shots.
//
//   const arsenal = createArsenal({ scene, getVolume, getScale, shell, entries, bodyOf, carrying })
//   arsenal.start(layout)      a Halo match begins on `layout` (its pads); null: not a Halo match
//   arsenal.stop()             the match is over: the player's hands back, the pads gone
//   arsenal.loadout(entry)     every frame per roster entry: its hands (the player's toolbelt, a bot's weapons)
//   arsenal.update(dt)         every frame: shots spent, deaths, pads, pickups, the pads drawn
//   arsenal.objective(e, plan) a bot's plan: a ready pad near it, when that beats `plan` (game/bots.js)
//   arsenal.failed(e, plan)    a bot found no way to a pad: it leaves that pad alone a while
//   arsenal.damageShare(by, t, cause)  × a hit from `by` on target `t` (game/index.js hit rules)
//
// Events on povEvents: game:weapon { id, key, action: 'take' | 'drop' | 'empty' | 'spawn', pad }.

// ---- the equal start
// Halo: Reach's and Combat Evolved's start, an assault rifle and a magnum: the SMG plays the
// assault rifle (in hand), the pistol the magnum.
export const START_CARRY = ['SMG', 'GUN'];
export const START_GRENADES = 2;     // Halo 3's two frag grenades
export const START_SHIELDS = 1;      // Energy Shield stacks: one is Halo 3's 70 shield over 45 health (perks.js)
export const CARRY_MAX = 2;          // Halo's two-weapon limit

// ---- the power weapons
// shots: what a fresh one holds, a magazine and one spare as Halo 3's map spawns give them (the
// rocket launcher's 2 + 2; Halopedia: the sniper rifle's magazine is 4 rounds, the Spartan Laser's
// battery five shots at 20% each). respawnS: Halo 3 matchmaking's power-weapon timers, 2 min,
// the laser in the power-up tier's 3 min (Bungie.net's community timer list for the MCC's Halo 3
// playlists: Overshield and Camo 3:00); a pad's timer starts when its weapon is picked up, as
// Halo 3's do. unit: what the readout counts.
export const POWER = {
  ROCKET: { shots: 2 + 2, unit: 'rockets', respawnS: 120 },
  SNIPER: { shots: 4 + 4, unit: 'rounds', respawnS: 120 },
  LASER: { shots: 5, unit: 'charges', respawnS: 180 },
};
const DROP_S = 30;                   // s a dropped weapon lies before it's gone (Halo clears dropped weapons; ours sooner: a small map)

// ---- Halo's shots to kill a full-shielded body (no headshots here); damageShare makes each gun so
// whatever its sandbox damage. Halo: Reach's magnum, five; Halo 3's assault rifle, about sixteen
// rounds; Halo 3's sniper rifle, two body shots; its Spartan Laser, one.
const SHOTS_TO_KILL = { GUN: 5, SMG: 16, SNIPER: 2, LASER: 1 };
// health a hit takes in the sandbox: gun.tool.js, smg.tool.js, sniper.tool.js round.damage; shaders/povBore.js LASER.DAMAGE
const RAW_DAMAGE = { GUN: 0.5, SMG: 0.2, SNIPER: 1, LASER: 2 };
const SHIELDED_LIVES = 1 + (70 / 45) * START_SHIELDS;   // health plus a full shield, in base lives (Halo 3's 115 over 45)
const TAKEN_PLAYER = 0.5;            // share of a blow the player takes (pov/index.js PLAYER_DAMAGE_TAKEN)
const TAKEN_BOT = 0.6;               // ...and a bot (npc.js DAMAGE_TAKEN)
const KILL_MARGIN = 1.02;            // the last shot kills with this to spare (no sliver left by rounding)
const SHOT_CAUSES = new Set(['Shot', 'Lasered']);   // the hits it scales: ballistics.js's rounds, laser.tool.js's beam

// ---- pads and pickups (grid cells)
const PAD_R = 2;                     // a pad's glowing disc
const PAD_LIFT = 0.05;               // its disc above the floor (no z-fighting)
const RING_W = 0.4;                  // its rim
const PAD_COLOR = '#ffcf4a';         // Halo's weapon-pad amber
const PAD_READY = 0.85, PAD_WAIT = 0.2;   // the rim's opacity with a weapon on it, and without
const DISC_OPACITY = 0.18;
const FLOAT_UP = 2.4;                // cells a weapon floats over its pad...
const BOB = 0.25;                    // ...bobbing this much...
const BOB_HZ = 0.5;                  // ...this often
const SPIN = 1.2;                    // rad/s it turns
const DROP_UP = 0.7;                 // cells a dropped weapon floats over where it fell
const MODEL_SCALE = 1.8;             // the held model grown to read in the world (npc.js HELD_SCALE)
const TAKE_R = 2.2;                  // cells: the look-at target's radius (interact.js)
const BOT_TOUCH_R = 3;               // cells (horizontal): a bot this near a weapon on the ground takes it...
const BOT_TOUCH_UP = 6;              // ...within this height
const SEEK_R = 48;                   // cells: a bot with nothing in sight goes for a ready pad this near...
const SEEK_WANT = 0.58;              // ...this much (game/bots.js WANT: under Attack's 0.6 and holding a zone, over going to one)
const SEEK_BAN_S = 60;               // s a bot leaves a pad alone after it found no way there
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const nameOf = (key) => gearByKey(key)?.name ?? key;

const basic = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

// shell: the game's shell (pov/index.js: player, toolbelt, interact). entries() → the roster's entries
// ({ id, team, bot }); bodyOf(e) → its body; carrying(e) → it carries a flag.
export function createArsenal({ scene, getVolume, getScale, shell, entries, bodyOf, carrying }) {
  const root = new THREE.Group();
  root.name = 'game-weapons';
  scene.add(root);
  let on = false, time = 0;
  let pads = [];                     // { i, key, at, respawnS, ready, takenAt, group, model, rim }
  const drops = [];                  // { n, key, at, shots, pad, until, group, model }
  let dropCount = 0;
  const holds = new Map();           // body id → Map(key → { shots, pad }): the power weapons it carries
  const spent = [];                  // { id, key }: emptied by a shot this frame (handled in update, not inside the tool)
  const fell = new Set();            // ids whose death was seen (their weapons dropped)
  const bans = new Map();            // bot id → Map(pad index → time it may try again)
  let playerHands = null, playerBelt = null, holdNext = null, lastGun = null;
  const noteShown = new Map();       // key → the note on the player's toolbelt

  const place = (obj, p, up = 0) => {
    const s = getScale(), v = getVolume();
    obj.position.set(p.x, p.y + up, p.z).multiplyScalar(s).add(v.position);
    obj.scale.setScalar(s);
  };
  const entryOf = (id) => entries().find((e) => e.id === id) ?? null;
  const myBody = () => shell.player;
  const infected = (e) => e.team === R.INFECTED;
  const live = (i) => drops.some((d) => d.pad === i) || [...holds.values()].some((m) => [...m.values()].some((w) => w.pad === i));

  function model(parent, key) {
    const m = attachModel(parent, gearByKey(key).model, null, { arm: false });
    m.obj.scale.multiplyScalar(MODEL_SCALE);
    return m;
  }
  function padGroup(key) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(PAD_R, 32).rotateX(-Math.PI / 2).translate(0, PAD_LIFT, 0), basic(PAD_COLOR, DISC_OPACITY));
    const rim = new THREE.Mesh(new THREE.RingGeometry(PAD_R - RING_W, PAD_R, 40).rotateX(-Math.PI / 2).translate(0, PAD_LIFT * 2, 0), basic(PAD_COLOR, PAD_READY));
    for (const m of [disc, rim]) { m.renderOrder = 1; m.userData.own = true; g.add(m); }
    const spin = new THREE.Group();
    g.add(spin);
    root.add(g);
    return { group: g, rim, spin, model: model(spin, key) };
  }
  // a pad's or drop's group, its model already disposed (the models' materials are shared: models.js)
  function disposeGroup(g) {
    g.removeFromParent();
    g.traverse((o) => { if (o.userData.own) { o.geometry.dispose(); o.material.dispose(); } });
  }

  // ---- the match
  function start(layout) {
    clear();
    on = !!layout;
    if (!on) return;
    time = 0;
    pads = (layout.weapons ?? []).filter((w) => POWER[w.key] && gearByKey(w.key)).map((w, i) => {
      const [x, y, z] = w.at;
      return { i, key: w.key, at: new THREE.Vector3(x, y, z), respawnS: w.respawnS ?? POWER[w.key].respawnS, ready: true, takenAt: -Infinity, ...padGroup(w.key) };
    });
  }
  function clear() {
    for (const p of pads) { p.model.dispose(); disposeGroup(p.group); }
    for (const d of drops) { d.model.dispose(); disposeGroup(d.group); }
    pads = []; drops.length = 0;
    holds.clear(); spent.length = 0; fell.clear(); bans.clear();
  }
  function stop() {
    if (!on) return;
    on = false;
    clear();
    // the player's hands back (the hotbar whole again), their notes gone, the match's fields off
    const tb = shell.toolbelt;
    if (tb) { for (const k of noteShown.keys()) tb.setNote?.(k, null); tb.restrict?.(null); }
    noteShown.clear();
    playerHands = playerBelt = holdNext = lastGun = null;
    const b = myBody();
    if (b) {
      b.carry = null; b.grenades = null;
      if (b.haloShield) { for (let i = 0; i < b.haloShield; i++) b.perks.take('ENERGY_SHIELD'); b.haloShield = 0; }
    }
  }

  // a body enters play: Halo's equal start (another style: no limits)
  povEvents.on('game:spawn', ({ id, team, bot, body, style }) => {
    if (style !== 'halo') { body.carry = null; body.grenades = null; return; }
    body.perks.clear();   // nothing earned before (a shrine's perks, a class's) carries into the match
    for (let i = 0; i < START_SHIELDS; i++) body.perks.add('ENERGY_SHIELD');
    body.haloShield = START_SHIELDS;   // (taken back from the player when the match stops)
    body.fillShield?.();
    const zombie = team === R.INFECTED;
    body.carry = zombie ? [...R.INFECTED_WEAPONS] : [...START_CARRY];
    body.grenades = zombie ? 0 : START_GRENADES;
    holds.delete(id);
    fell.delete(id);
    if (!bot) { holdNext = body.carry[0]; playerHands = null; lastGun = null; }
  });
  povEvents.on('game:stop', () => stop());

  // a power weapon's shot (its gun:fire, the player's or a bot's: by): one fewer
  povEvents.on('gun:fire', ({ gun, by }) => {
    if (!on || !POWER[gun]) return;
    const id = by ?? PLAYER, w = holds.get(id)?.get(gun);
    if (!w) return;
    w.shots--;
    if (w.shots <= 0) spent.push({ id, key: gun });
  });

  // ---- hands
  // what entry e may hold now: an infected's melee, a carrier's (Halo: the flag carrier melees), else its carry
  function handsOf(e, b) {
    if (infected(e)) return R.INFECTED_WEAPONS;
    if (carrying(e)) return R.CARRIER_WEAPONS;
    return b.carry ?? START_CARRY;
  }
  function loadout(e) {
    const b = bodyOf(e);
    if (!on || !b || !e.team) return;   // (someone watching keeps their hands)
    const want = handsOf(e, b), sig = want.join();
    if (e.bot) {
      // its frags too, beside the guns (brain.js FRAG spends body.grenades; the infected and a
      // flag carrier throw none, Halo's)
      const hands = infected(e) || carrying(e) ? want : [...want, 'FRAG'], hsig = hands.join();
      if (e.bot.agent.weapons?.sig !== hsig) { const s = new Set(hands); s.sig = hsig; e.bot.agent.weapons = s; }
      return;
    }
    const tb = shell.toolbelt;
    if (!tb?.restrict) return;
    if (want.includes(tb.selectedKey) && b.carry?.includes(tb.selectedKey)) lastGun = tb.selectedKey;
    if (playerHands === sig && playerBelt === tb) return;
    playerHands = sig; playerBelt = tb;
    tb.restrict(want, holdNext ?? lastGun);
    holdNext = null;
  }
  // the gun in a body's hand (the one a pickup replaces)
  function inHand(e, b) {
    const k = e.bot ? e.bot.agent.weapon : shell.toolbelt?.selectedKey;
    return b.carry.includes(k) ? k : b.carry[0];
  }

  // ---- pickups
  function addDrop(key, at, shots, pad) {
    const g = new THREE.Group();
    const spin = new THREE.Group();
    g.add(spin);
    root.add(g);
    drops.push({ n: dropCount++, key, at: new THREE.Vector3(at.x, at.y, at.z), shots, pad, until: time + DROP_S, group: g, spin, model: model(spin, key) });
    povEvents.emit('game:weapon', { id: null, key, action: 'drop', pad });
  }
  function removeDrop(d) {
    const i = drops.indexOf(d);
    if (i >= 0) drops.splice(i, 1);
    d.model.dispose();
    disposeGroup(d.group);
  }
  // what taking `item` (a pad or a drop) does for entry e: { key, shots, out } (out: the gun it drops), or null
  function offer(e, item) {
    const b = bodyOf(e);
    if (!on || !b || b.dead || !Array.isArray(b.carry) || infected(e) || carrying(e)) return null;
    const key = item.key, power = POWER[key];
    const shots = item.until === undefined ? power.shots : item.shots;
    if (b.carry.includes(key)) return power ? { key, shots, out: null, ammo: true } : null;   // carried: Halo takes its ammo
    return { key, shots, out: b.carry.length >= CARRY_MAX ? inHand(e, b) : null, ammo: false };
  }
  function take(e, item) {
    const o = offer(e, item);
    if (!o) return false;
    const b = bodyOf(e), mine = holds.get(e.id) ?? new Map();
    holds.set(e.id, mine);
    const pad = item.until === undefined ? item.i : item.pad;
    if (o.ammo) mine.get(o.key).shots += o.shots;
    else {
      if (o.out) {
        const w = mine.get(o.out);
        mine.delete(o.out);
        b.carry = b.carry.map((k) => (k === o.out ? o.key : k));   // in its place (Halo's two-weapon swap)
        addDrop(o.out, b.pos, w?.shots ?? null, w?.pad ?? null);
        if (!e.bot) { shell.toolbelt?.setNote?.(o.out, null); noteShown.delete(o.out); }
      } else b.carry = [...b.carry, o.key];
      if (POWER[o.key]) mine.set(o.key, { shots: o.shots, pad });
    }
    if (item.until === undefined) { item.ready = false; item.takenAt = time; } else removeDrop(item);
    if (!e.bot) { holdNext = o.key; playerHands = null; }
    povEvents.emit('game:weapon', { id: e.id, key: o.key, action: 'take', pad });
    return true;
  }
  // a power weapon spent (its last shot) or dropped on death: out of the body's hands
  function lose(id, key) {
    const e = entryOf(id), b = e && bodyOf(e);
    holds.get(id)?.delete(key);
    if (b?.carry) b.carry = b.carry.filter((k) => k !== key);
    if (id === PLAYER) { shell.toolbelt?.setNote?.(key, null); noteShown.delete(key); playerHands = null; }
  }

  // the player: look at a weapon and press E
  shell.interact?.provide(() => {
    const me = entryOf(PLAYER), b = myBody();
    if (!on || !me || !b || b.dead) return [];
    const out = [];
    for (const item of [...pads.filter((p) => p.ready), ...drops]) {
      const o = offer(me, item);
      if (!o) continue;
      const at = item.at.clone();
      at.y += item.until === undefined ? FLOAT_UP : DROP_UP;
      const left = POWER[o.key] ? `${o.shots} ${POWER[o.key].unit}` : null;
      out.push({
        id: `weapon:${item.until === undefined ? `pad${item.i}` : `drop${item.n}`}`, position: at, radius: TAKE_R,
        title: nameOf(o.key), lines: left ? [left] : [],
        verb: o.ammo ? 'Take its ammo' : o.out ? `Pick up (drops ${nameOf(o.out)})` : 'Pick up',
        use: () => take(me, item),
      });
    }
    return out;
  });

  // ---- every frame
  function update(dt) {
    if (!on) return;
    time += dt;
    for (const { id, key } of spent.splice(0)) {
      if (!holds.get(id)?.has(key)) continue;
      lose(id, key);
      povEvents.emit('game:weapon', { id, key, action: 'empty', pad: null });
    }
    // a body that died drops its power weapons where it fell (Halo)
    for (const e of entries()) {
      const b = bodyOf(e);
      if (!b) continue;
      if (!b.dead) { fell.delete(e.id); continue; }
      if (fell.has(e.id)) continue;
      fell.add(e.id);
      for (const [key, w] of [...(holds.get(e.id) ?? [])]) { lose(e.id, key); addDrop(key, b.pos, w.shots, w.pad); }
    }
    for (const d of [...drops]) if (time >= d.until) removeDrop(d);
    // a pad brings a new one when its timer is up and the last is out of play
    for (const p of pads) {
      if (p.ready || time - p.takenAt < p.respawnS || live(p.i)) continue;
      p.ready = true;
      povEvents.emit('game:weapon', { id: null, key: p.key, action: 'spawn', pad: p.i });
    }
    // bots take a power weapon they walk onto (the ammo of the one they hold; they keep their guns otherwise)
    for (const e of entries()) {
      if (!e.bot) continue;
      const b = bodyOf(e), mine = holds.get(e.id);
      if (!b || b.dead) continue;
      for (const item of [...pads.filter((p) => p.ready), ...drops.filter((d) => POWER[d.key])]) {
        if (mine?.size && !mine.has(item.key)) continue;
        if (hdist(b.pos, item.at) < BOT_TOUCH_R && Math.abs(b.pos.y - item.at.y) < BOT_TOUCH_UP && take(e, item)) break;
      }
    }
    // the player's shots left, after the weapon's name
    const tb = shell.toolbelt, mine = holds.get(PLAYER);
    if (tb?.setNote) {
      for (const [key, w] of mine ?? []) {
        const text = `${w.shots} ${POWER[key].unit}`;
        if (noteShown.get(key) !== text) { tb.setNote(key, text); noteShown.set(key, text); }
      }
    }
    // the pads and drops, drawn
    const bob = Math.sin(time * BOB_HZ * 2 * Math.PI) * BOB;
    for (const p of pads) {
      place(p.group, p.at);
      p.spin.visible = p.ready;
      p.spin.position.y = FLOAT_UP + bob;
      p.spin.rotation.y = time * SPIN;
      p.rim.material.opacity = p.ready ? PAD_READY : PAD_WAIT;
    }
    for (const d of drops) {
      place(d.group, d.at);
      d.spin.position.y = DROP_UP;
      d.spin.rotation.y = time * SPIN;
    }
  }

  // ---- bots
  // A bot with nothing in sight, no power weapon and free hands goes for a ready pad near it,
  // when that beats what the mode wants of it (plan): Halo's bots run the map's weapons.
  function objective(e, plan) {
    const a = e.bot?.agent, b = bodyOf(e);
    if (!on || !a || !b || a.sees || infected(e) || carrying(e) || holds.get(e.id)?.size) return plan;
    if (plan && plan.want >= SEEK_WANT) return plan;
    const ban = bans.get(e.id);
    let best = null, bd = SEEK_R;
    for (const p of pads) {
      if (!p.ready || (ban?.get(p.i) ?? -Infinity) > time) continue;
      const d = hdist(b.pos, p.at);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { kind: 'weapon', at: { x: best.at.x, y: best.at.y, z: best.at.z }, r: 0, want: SEEK_WANT, pad: best.i } : plan;
  }
  function failed(e, plan) {
    if (plan?.kind !== 'weapon') return;
    if (!bans.has(e.id)) bans.set(e.id, new Map());
    bans.get(e.id).set(plan.pad, time + SEEK_BAN_S);
  }

  // A hit's share in a Halo match: the shooter's gun kills a full-shielded target in Halo's shots
  // (a round's or the laser's hit only: a blow or a kick is as it was)
  function damageShare(by, t, cause) {
    if (!on || !SHOT_CAUSES.has(cause)) return 1;
    const e = entryOf(by);
    const key = !e ? null : e.bot ? e.bot.kit?.held : shell.toolbelt?.selectedKey;
    const n = SHOTS_TO_KILL[key];
    if (!n) return 1;
    const taken = t?.id === PLAYER ? TAKEN_PLAYER : TAKEN_BOT;
    return (SHIELDED_LIVES * KILL_MARGIN) / (n * RAW_DAMAGE[key] * taken);
  }

  return {
    start, stop, loadout, update, objective, failed, damageShare,
    setVisible(v) { root.visible = v; },
    // checks: the pads ({ key, ready, at }), what's lying about, and each body's power weapons
    get state() {
      return {
        on,
        pads: pads.map((p) => ({ key: p.key, ready: p.ready, at: p.at.toArray(), takenAt: p.takenAt })),
        drops: drops.map((d) => ({ key: d.key, shots: d.shots, at: d.at.toArray() })),
        holds: Object.fromEntries([...holds].map(([id, m]) => [id, Object.fromEntries([...m].map(([k, w]) => [k, w.shots]))])),
      };
    },
  };
}
