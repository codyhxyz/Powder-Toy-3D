import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { SEED_MAX } from '../../shaders/common.js';
import { HAND_REACH } from '../constants.js';
import { PX as NOITA_PX } from '../player.js';
import { gravityScale } from '../ballistics.js';
import { povEvents } from '../events.js';
import { ingest } from '../ingest.js';
import { attachModel, FLASK_BULB } from '../models.js';
import { viewmodelRig, heldMaterial, HIT } from '../viewmodel.js';
import { trigger, toolDt } from './action.js';
import { THROW_SPEED } from './bomb.tool.js';
import { inventory } from './inventory.js';
import {
  Load, persistentLoad, ownedKey, cellsNear, outsideBody, bodyExit, toStepVelocity, aimInReach, faceNormal, pinned,
  ballRadius, muzzleCell,
} from './transfer.js';
import { gear } from './catalog.js';

// Flask: Noita's potion flask. It holds FLASK_CAP cells of any liquid or
// powder, mixed, each cell kept as it was taken (temperature and all), and
// you start with one full of water, as Noita's runs do.
//
// Left-click scoops what you point at, or pours: a press on a liquid or powder
// within reach scoops it while the flask has room (and an empty flask always
// tries to scoop); otherwise it pours a stream where you aim, as the bucket
// does. Unlike the bucket the flask is finite: what it pours is spent.
// Right-click throws it on the shared projectiles (ballistics.js), at the
// bomb's overhand speed plus yours; where it strikes the glass shatters into
// FLASK_GLASS cells of SHARDS and what it held spills out as its own cells,
// so the contents are conserved exactly (a flask that flies out of the box
// is gone with them). H drinks: Noita's drink, the same share of every
// material in it, up to DRINK_CELLS a gulp, handed to ingest.js as one dose
// per element (water quenches, acid burns, lava kills, oil sickens, whiskey
// makes you drunk).
//
// One flask at a time. Once it's thrown the hand is empty until the palette
// (Q in first person) gives another: a new flask of water, like the first.
//
// Events: tool:action 'scoop', 'pour' (every stream that lands), 'throw',
// 'shatter' (id: what most of it held), 'drink' and 'refuse'; impact
// { source: 'flask', id: GLASS, broke: true } where it shatters (the glass's
// sound and chips), and another with what it held (its splash or dust);
// round:move / round:end with kind 'flask' while it flies.

// ---- capacity: Noita's flask holds 1000 units, a unit a pixel of material.
// Taken as voxels the size of Noita's pixel (player.js PX: Mina's 11 px are
// this body's 5.5 cells, so a pixel is 0.5 cells), that's 1000 × 0.5³ cells.
const NOITA_FLASK_UNITS = 1000;
export const FLASK_CAP = Math.round(NOITA_FLASK_UNITS * NOITA_PX ** 3);   // cells (125, a 5³ cube)
const DRINK_SHARE = 0.1;                         // Noita: a drink takes 10% of every material in it...
export const DRINK_CELLS = Math.round(DRINK_SHARE * FLASK_CAP);   // ...a full flask's 10%: cells a full drink takes (13)
export const FLASK_GLASS = 4;                    // cells of SHARDS a shattered flask leaves (its glass)
const TAKES = new Set([K.LIQUID, K.POWDER]);     // what it can hold

// ---- use
const DIP_CELLS = Math.round(FLASK_CAP / 4);     // cells one dip takes at most: a quarter flask
const SCOOP_RADIUS = 3.5;                        // cells: a dip takes the matter nearest the aim cell, this far at most
const DIP_SINK = 1.5;                            // cells: the flask dips this far under the surface it hits
const SCOOP_INTERVAL = 0.3;                      // s between dips while the button is held
const POUR_RATE = 30;                            // cells/s in a stream (the bucket's: a flask empties in ~4 s)
const POUR_BACKLOG = 4;                          // cells: a stream that couldn't land doesn't build up more than this
const POUR_SPEED = 10;                           // cells/s along the aim, on top of the body's velocity (Noita sprays it)
const POUR_REACH = 1.5;                          // cells from the eye to the spout
const SPOUT_RADIUS = 1.2;                        // cells: the stream fills empty cells this close to the spout
const BODY_CLEARANCE = 0.3;                      // cells kept clear around the body
const THROW_REFIRE = 0.6;                        // s after a throw before the next can go (a fresh flask in hand)
const DRINK_INTERVAL = 0.6;                      // s between gulps while H is held
const DRINK_KEY = 'KeyH';                        // drink (Grim Dawn's potion key; E, Q, Tab, C, V, F, T, M are taken)
const SHATTER_ENERGY = 20;                       // sim KE units the shatter's impact sounds and shakes like
const SPILL_SLACK = 2.5;                         // candidate cells per spilled cell (some are full)
const SPILL_RISE = 1;                            // cells: each retry looks this much higher (no room spills over the top)...
const SPILL_TRIES_MAX = 600;                     // ...for this many tries (~10 s); what still finds no room is lost, counted in `lost`
const KIND = 'flask';
const TUMBLE = 0.35;                             // rad the flying flask turns per frame it's drawn

// ---- held item, in cells (camera space; the rig scales by the cell size)
const HELD_POS = [0.6, -0.42, -1.4];             // right, down, ahead of the eye (the bulb in view above the hotbar)
const HELD_TILT = 0.2;                           // rad, the neck tips toward the eye
const DRINK_TIP = 1.1;                           // rad the flask tips toward the mouth on a gulp...
const DRINK_TIP_S = 0.35;                        // ...over this long
const FLASK_INNER = 0.8;                         // the contents' radius as a share of the bulb's (inside the glass's flat faces)

// the body's flasks: whether one is in hand, by owner (the player's: ''), kept across toolbelts like the loads
const flasks = new Map();
const flaskOf = (owner) => {
  const k = owner ?? '';
  if (!flasks.has(k)) flasks.set(k, { inHand: false, stocked: false });
  return flasks.get(k);
};

// a cell of element id at its spawn temperature, as a load carries it
const freshCell = (id) => [id, ELEMENTS[id].temp, ELEMENTS[id].life, Math.random() * SEED_MAX];
// a new flask: Noita's first, full of water
function stock(load) {
  load.cells.length = 0;
  for (let i = 0; i < FLASK_CAP; i++) load.cells.push(freshCell(E.WATER));
  load.version++;
}

// Height of the surface above the bottom of a sphere of radius r filled to share f of its
// volume: the cap volume πh²(3r − h)/3 solved for h (the cubic's root in [0, 2r]).
const capHeight = (f, r) => r * (1 + 2 * Math.cos((Math.acos(1 - 2 * THREE.MathUtils.clamp(f, 0, 1)) + 4 * Math.PI) / 3));

// Noita's drink: the same share of every material, want cells in all (largest remainder).
function sip(load, want) {
  const totals = load.totals(), total = load.cells.length;
  const quota = new Map(), rest = [];
  let given = 0;
  for (const [id, n] of Object.entries(totals)) {
    const exact = (n * want) / total;
    quota.set(+id, Math.floor(exact));
    given += Math.floor(exact);
    rest.push([+id, exact - Math.floor(exact)]);
  }
  rest.sort((a, b) => b[1] - a[1]);
  for (let i = 0; given < want && i < rest.length; i++, given++) quota.set(rest[i][0], quota.get(rest[i][0]) + 1);
  const doses = new Map();   // id → { id, n, Tsum }
  for (let i = load.cells.length - 1; i >= 0; i--) {
    const c = load.cells[i];
    if (!(quota.get(c[0]) > 0)) continue;
    quota.set(c[0], quota.get(c[0]) - 1);
    const d = doses.get(c[0]) ?? { id: c[0], n: 0, Tsum: 0 };
    d.n++; d.Tsum += c[1];
    doses.set(c[0], d);
    load.cells.splice(i, 1);
  }
  load.version++;
  return [...doses.values()].map(({ id, n, Tsum }) => ({ id, n, share: n / DRINK_CELLS, T: Tsum / n }));
}

export default {
  ...gear('FLASK'),
  create(env) {
    const load = persistentLoad(ownedKey('FLASK', env.owner), FLASK_CAP);
    const flask = flaskOf(env.owner);
    if (!flask.stocked) { flask.stocked = true; flask.inHand = true; stock(load); }
    const transfer = env.transfer;
    const dip = trigger(SCOOP_INTERVAL);
    const toss = trigger(THROW_REFIRE, { button: 'secondary', hold: false });
    const gulp = trigger(DRINK_INTERVAL, { button: 'drink' });
    const act = (action, extra) => povEvents.emit('tool:action', { tool: 'flask', action, ...extra });
    const refuse = (text, id) => env.feedback?.refuse(text, { id });
    let mode = null;          // this press of the left button: 'scoop' or 'pour'
    let pour = 0, selected = false, tipT = 0;
    let lastDrink = null, lastShatter = null, lost = 0;
    let spillEpoch = 0;       // bumped when the world is replaced: spills from the old one stop
    const spills = new Set(); // loads still spilling out where a flask broke

    // ---- held item: the flask on a hand of the viewmodel rig, its contents inside the bulb
    const rig = viewmodelRig(env);
    const hand = rig.hand(HELD_POS);
    const held = new THREE.Group();
    held.rotation.x = HELD_TILT;
    hand.add(held);
    const fillMat = heldMaterial('#ffffff');
    const fill = new THREE.Group();
    const cap = new THREE.Mesh(new THREE.BufferGeometry(), fillMat);
    const top = new THREE.Mesh(new THREE.BufferGeometry(), fillMat);
    fill.add(cap, top);
    const model = attachModel(held, 'flask', (obj) => { obj.getObjectByName('bulb')?.add(fill); });
    let fillVersion = -1;
    const mix = new THREE.Color(), part = new THREE.Color();
    function showContents() {
      if (load.version === fillVersion) return;
      fillVersion = load.version;
      const n = load.cells.length;
      fill.visible = n > 0;
      if (!n) return;
      // colour: the elements' colours mixed by how much of each it holds
      mix.setRGB(0, 0, 0);
      for (const [id, k] of Object.entries(load.totals())) mix.add(part.set(ELEMENTS[id].color).multiplyScalar(k / n));
      fillMat.color.copy(mix);
      // level: a sphere cap holding that share of the bulb, and its surface
      const r = FLASK_BULB.r * FLASK_INNER;
      const y = capHeight(n / FLASK_CAP, r) - r;
      const theta = Math.acos(THREE.MathUtils.clamp(y / r, -1, 1));
      cap.geometry.dispose();
      cap.geometry = new THREE.SphereGeometry(r, FLASK_BULB.sides, FLASK_BULB.rings, 0, Math.PI * 2, theta, Math.PI - theta);
      top.geometry.dispose();
      top.geometry = new THREE.CircleGeometry(r * Math.sin(theta), FLASK_BULB.sides).rotateX(-Math.PI / 2).translate(0, y, 0);
      globalThis.__app?.requestRender?.();
    }

    // ---- flasks in flight, drawn where the shared projectiles say they are
    const flying = new Map();   // round id → { model, load }
    const world = new THREE.Group();
    world.name = 'pov-flasks';
    env.scene.add(world);
    const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
    const offs = [
      povEvents.on('round:move', ({ id, kind, to }) => {
        const f = kind === KIND && flying.get(id);
        if (!f) return;
        f.model ??= attachModel(world, 'flask', null, { arm: false });
        f.model.obj.scale.setScalar(env.getScale());
        toWorld(to, f.model.obj.position);
        f.model.obj.rotation.x += TUMBLE;
        globalThis.__app?.requestRender?.();
      }),
      povEvents.on('round:end', ({ id, kind }) => {
        const f = kind === KIND && flying.get(id);
        if (!f) return;
        f.model?.dispose();
        flying.delete(id);
        lost += f.load.cells.length;   // it never struck: out of the box, with what it held
      }),
    ];
    // a given flask (the palette, Q): one in hand if the last was thrown
    const offGive = env.owner ? () => {} : inventory.on((key) => {
      if (key !== 'FLASK') return;
      if (flask.inHand) { env.feedback?.notice('You already carry a flask'); return; }
      flask.inHand = true;
      stock(load);
    });

    // ---- drinking on its key (the player's flask only; tests and NPCs pass ctx.drink)
    let keyHeld = false, keyPressed = false;
    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onDown = (e) => {
      if (e.code !== DRINK_KEY || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!selected || !env.isActive?.() || typing(e.target)) return;
      keyHeld = true;
      keyPressed = true;
    };
    const onUp = (e) => { if (e.code === DRINK_KEY) keyHeld = false; };
    if (!env.owner) { addEventListener('keydown', onDown); addEventListener('keyup', onUp); }

    // ---- scooping and pouring
    function isMatter(aim) { return !!aim && aim.id >= 0 && TAKES.has(ELEMENTS[aim.id].kind); }

    function scoop(ctx, aim) {
      if (!isMatter(aim)) { if (ctx.primaryPressed) refuse('Nothing to scoop up here'); return; }
      if (load.free <= 0) { if (!load.busy && ctx.primaryPressed) refuse('The flask is full', aim.id); return; }
      const center = aim.cell.clone().addScalar(0.5).addScaledVector(faceNormal(aim.face), -DIP_SINK);
      const p = transfer.take(load, {
        cells: cellsNear(center, SCOOP_RADIUS, ctx.sim.g), kinds: [...TAKES], want: aim.id, limit: DIP_CELLS,
      });
      if (!p) return;
      dip.fire();
      const id = aim.id, at = pinned(center, ctx.sim);
      p.then((got) => { if (got.length) act('scoop', { id, point: at(), amount: got.length }); });
    }

    function pourOut(ctx) {
      if (!load.cells.length) { if (ctx.primaryPressed && !load.busy) refuse('The flask is empty'); pour = 0; return; }
      pour = Math.min(pour + POUR_RATE * toolDt(ctx), POUR_BACKLOG);
      const n = Math.min(Math.floor(pour), load.cells.length);
      if (n < 1) return;
      const feet = ctx.player?.pos;
      const t = Math.max(POUR_REACH, feet ? bodyExit(ctx.eye, ctx.dir, feet, BODY_CLEARANCE) + SPOUT_RADIUS : 0);
      const spout = ctx.eye.clone().addScaledVector(ctx.dir, t);
      const cells = cellsNear(spout, SPOUT_RADIUS, ctx.sim.g, feet ? outsideBody(feet, BODY_CLEARANCE) : null);
      const v = ctx.dir.clone().multiplyScalar(POUR_SPEED);
      if (ctx.player?.vel) v.add(ctx.player.vel);
      const id = load.mainId;
      const p = transfer.put(load, { cells, max: n, vel: toStepVelocity(v, ctx) });
      if (!p) return;
      pour -= n;
      const at = pinned(spout, ctx.sim);
      p.then((landed) => { if (landed) act('pour', { id, point: at(), amount: landed }); });
    }

    // ---- throwing and shattering
    // Put a broken flask's cells into the empty cells around `at` (a pinned point), and
    // keep at it, a little higher each time, until every one has landed.
    function spill(heap, at, epoch = spillEpoch, tries = 0) {
      if (epoch !== spillEpoch || !heap.cells.length) { spills.delete(heap); return; }
      if (tries > SPILL_TRIES_MAX) { lost += heap.cells.length; heap.cells.length = 0; heap.version++; spills.delete(heap); return; }
      spills.add(heap);
      const sim = env.getSim();
      const center = at();
      center.y = Math.min(center.y + tries * SPILL_RISE, sim.g.ny - 1);
      const p = transfer.put(heap, { cells: cellsNear(center, ballRadius(heap.cells.length * SPILL_SLACK), sim.g), vel: new THREE.Vector3() });
      const again = () => spill(heap, at, epoch, tries + 1);
      if (!p) { requestAnimationFrame(again); return; }
      p.then(() => (heap.cells.length ? requestAnimationFrame(again) : spills.delete(heap)));
    }

    function shatter(roundId, { sim, hit, normal }) {
      const f = flying.get(roundId);
      if (!f) return;
      flying.delete(roundId);   // struck: round:end isn't a loss
      f.model?.dispose();
      const spilt = f.load;
      const mainId = spilt.mainId;
      const held = spilt.cells.length;
      for (let i = 0; i < FLASK_GLASS; i++) spilt.cells.push(freshCell(E.SHARDS));   // last in, so nearest the middle
      const center = hit.point.clone().addScaledVector(normal, ballRadius(spilt.cells.length));
      spill(spilt, pinned(center, sim));
      lastShatter = { point: hit.point.clone(), center: center.clone(), held, glass: FLASK_GLASS, id: mainId, body: hit.body?.id ?? null, load: spilt };
      povEvents.emit('impact', { source: 'flask', point: hit.point.clone(), normal: normal.clone(), id: E.GLASS, energy: SHATTER_ENERGY, broke: true });
      if (mainId >= 0) povEvents.emit('impact', { source: 'flask', point: hit.point.clone(), normal: normal.clone(), id: mainId, energy: SHATTER_ENERGY, broke: null });
      act('shatter', { id: mainId, point: hit.point.clone(), amount: held });
    }

    function throwFlask(ctx) {
      if (!flask.inHand) { refuse('No flask: Q gives another'); return false; }
      if (load.busy) return false;   // a pour or a dip still in flight: its cells come back first
      const sim = ctx.sim ?? env.getSim();
      const dir = ctx.dir.clone().normalize();
      const m = ctx.player?.pos ? muzzleCell(ctx.eye, dir, ctx.player.pos, sim.g) : { t: 0 };
      if (!m) { refuse('No room to throw'); return false; }
      const origin = ctx.eye.clone().addScaledVector(dir, m.t);
      const carried = new Load(FLASK_CAP + FLASK_GLASS);
      let id = 0;
      id = env.ballistics.fire(origin, dir, gravityScale(sim), {
        speed: THROW_SPEED, carry: ctx.player?.vel ?? null, kind: KIND, bodies: true,
        onStrike: (s) => shatter(id, s),
      });
      if (!id) return false;
      carried.cells = load.cells.splice(0);
      load.version++;
      flying.set(id, { model: null, load: carried });
      flask.inHand = false;
      rig.hit(HIT.THROW);
      act('throw', { id: carried.mainId, amount: carried.cells.length });
      return true;
    }

    // ---- drinking
    function drink(ctx) {
      if (!flask.inHand) { refuse('No flask: Q gives another'); return false; }
      if (!load.cells.length) { refuse('The flask is empty'); return false; }
      const id = load.mainId;
      const doses = sip(load, Math.min(DRINK_CELLS, load.cells.length));
      const body = ctx.player?.body ?? null;
      const drunk = body ? ingest(body, doses) : doses;
      lastDrink = { doses: drunk, body: !!body };
      tipT = DRINK_TIP_S;
      rig.hit(HIT.DRINK);
      act('drink', { id, amount: doses.reduce((s, d) => s + d.n, 0) });
      return true;
    }

    return {
      load,
      update(ctx) {
        selected = true;
        hand.visible = true;
        rig.update(ctx);
        model.obj.visible = flask.inHand;
        showContents();
        tipT = Math.max(0, tipT - ctx.dt);
        held.rotation.x = HELD_TILT + DRINK_TIP * Math.sin((Math.PI * tipT) / DRINK_TIP_S);

        // left: scoop or pour, chosen on the press (mirrors the bucket's two buttons)
        if (ctx.primaryPressed) {
          const aim = aimInReach(ctx, HAND_REACH);
          mode = (isMatter(aim) && load.free > 0) || !load.cells.length ? 'scoop' : 'pour';
        }
        const dipReady = dip.ready(ctx);
        if (!ctx.primary) { mode = null; pour = 0; }
        else if (!flask.inHand) { if (ctx.primaryPressed) refuse('No flask: Q gives another'); }
        else if (mode === 'scoop') { if (dipReady) scoop(ctx, aimInReach(ctx, HAND_REACH)); }
        else if (mode === 'pour') pourOut(ctx);

        if (toss.ready(ctx) && throwFlask(ctx)) toss.fire();

        const dctx = { dt: ctx.dt, toolRate: ctx.toolRate, drink: ctx.drink ?? keyHeld, drinkPressed: ctx.drinkPressed ?? keyPressed };
        keyPressed = false;
        if (gulp.ready(dctx) && drink(ctx)) gulp.fire();
      },
      deselect() {
        selected = false;
        hand.visible = false;
        pour = 0; mode = null; keyHeld = keyPressed = false;
        toss.reset(); gulp.reset();
      },
      status() {
        if (!flask.inHand) return 'none';
        const n = load.count;
        if (!n) return 'empty';
        const id = load.mainId;
        return `${id >= 0 ? ELEMENTS[id].abbr : ''}${load.mixed ? '+' : ''} ${Math.round((100 * n) / FLASK_CAP)}%`;
      },
      // the world was replaced: spills from the old world stop (their matter was the old world's)
      worldReplaced() { spillEpoch++; spills.clear(); },
      windowShifted() { /* spill points are pinned (transfer.js pinned); rounds move with the projectiles */ },
      // for checks
      get inHand() { return flask.inHand; },
      get lastDrink() { return lastDrink; },
      get lastShatter() { return lastShatter; },
      get spilling() { return spills.size; },
      get flying() { return flying.size; },
      get lost() { return lost; },
      dispose() {
        offs.forEach((off) => off());
        offGive();
        if (!env.owner) { removeEventListener('keydown', onDown); removeEventListener('keyup', onUp); }
        flying.forEach((f) => f.model?.dispose());
        world.removeFromParent();
        model.dispose();
        hand.removeFromParent();
        cap.geometry.dispose(); top.geometry.dispose(); fillMat.dispose();
      },
    };
  },
};
