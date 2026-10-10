import * as THREE from 'three';
import { Flock, BIRD, S } from './flock.js';
import { createBirdWorld } from './probe.js';
import { createBirdView } from './render.js';
import { povEvents } from '../pov/events.js';
import { addTarget } from '../pov/targets.js';
import { SPAWNER } from '../spawners.js';
import { CELL_M } from '../scale.js';

// Life in the world: flocks of magical birds (flock.js flies them, probe.js
// tells them where the ground, the perches and the fires are, render.js draws
// them). A World has a few ambient flocks roaming near wherever you are; the
// palette's Bird flock spawner (Entities) keeps a flock homed on its spot,
// in a world or a box. They take off from a body that comes near and from
// gunshots and blasts (the POV event bus), roost at night, glow at dusk and
// night, burn in fire and fall when shot or struck (pov/targets.js).
//
// Not synced in multiplayer: every client flies its own (a guest's birds
// aren't the host's). Everything here is in world cells and seconds.

const M = 1 / CELL_M;
export const BIRD_LIFE = {
  AMBIENT_FLOCKS: 3,              // flocks over a World at once
  FLOCK_MIN: 7, FLOCK_MAX: 12,    // birds in a flock
  AMBIENT_RANGE: 45 * M,          // cells: ambient flocks make their homes within this of the window's centre
  AMBIENT_ARRIVE: 60 * M,         // cells from it a replacement flock flies in from
  AMBIENT_FAR: 110 * M,           // cells: a flock farther than this from the window's centre has left (is dropped)
  HOME_SHIFT_MIN_S: 30, HOME_SHIFT_MAX_S: 75,   // s between an ambient flock's moves to a new home
  SPAWNER_HOME_R: 20 * M,         // cells a spawner's flock roams from it
  RESPAWN_S: 20,                  // s after a spawner's flock is all dead before a new one comes
  // what scares them: the radius of each sound (cells)
  LOUD_GUN: 60 * M,               // a shot
  LOUD_BLAST: 120 * M,            // a bomb or a rocket
  LOUD_STRIKE: 12 * M,            // a round or a blow striking near them
  BLAST_KILL: 9,                  // cells: a blast's pressure (the rocket's reach) kills birds this close
  // the day (sun elevation, degrees)
  ROOST_EL: -3,                   // below this they roost...
  WAKE_EL: 1,                     // ...above this they wake
  GLOW_FULL_EL: -6,               // full glow below this...
  GLOW_NONE_EL: 6,                // ...none above this (dusk and dawn between)
  // what weapons can hit: a box around the bird (cells)
  HIT_HALF_W: BIRD.SPAN * 0.4,
  HIT_HALF_H: 0.35,
  TUMBLE: 9,                      // rad/s a falling body spins
  DEAD_ROLL: Math.PI / 2,         // rad: a dead bird lies on its side
  DEAD_FOLD: 0.35,                // its wings half folded
  COST_EMA: 0.05,                 // share of a frame's cost in the running average
};
const L = BIRD_LIFE;
const deg = THREE.MathUtils.degToRad;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// env: { renderer, scene, camera, getSim, getVolume, getScale, getWin, getSpawners,
//        sun (Vector3 toward the key light), sunEl () → rad, player () → { x, y, z } world cells | null }
export function createBirdLife(env) {
  const { scene, camera, getSim, getVolume, getScale, getWin } = env;
  const probe = createBirdWorld({ renderer: env.renderer, getSim, getWin });
  const view = createBirdView({ scene, sun: env.sun, getScale });
  const flocks = new Map();   // key → { flock, kind: 'ambient' | 'spawner', shiftT, deadT }
  let night = false, glow = 0, cost = 0, nextAmbient = 1, clock = 0;
  const focus = new THREE.Vector3();

  const toScene = (p, out) => {
    const sim = getSim(), vol = getVolume(), s = getScale();
    return out.set(p.x - sim.origin.x, p.y, p.z - sim.origin.z).multiplyScalar(s).add(vol.position);
  };

  // ---- the birds as things weapons hit
  function register(b) {
    b.removeTarget = addTarget({
      id: `bird:${b.id}`,
      get alive() { return b.state <= S.BURN; },
      box(min, max) {
        const o = getSim().origin, p = b.v.position;
        min.set(p.x - o.x - L.HIT_HALF_W, p.y - L.HIT_HALF_H, p.z - o.z - L.HIT_HALF_W);
        max.set(p.x - o.x + L.HIT_HALF_W, p.y + 2 * L.HIT_HALF_H, p.z - o.z + L.HIT_HALF_W);
      },
      hurt(amount, cause, dir) {
        if (b.state > S.BURN) return;
        b.flock.kill(b, dir);
        view.feathers(b.v.position, toScene);
        b.flock.startle(b.v.position);   // the rest go
      },
    });
  }
  const unregister = (b) => { b.removeTarget?.(); b.removeTarget = null; };

  function addFlock(key, kind, home, opts = {}) {
    const n = Math.round(rand(L.FLOCK_MIN, L.FLOCK_MAX + 1) - 0.5);
    const flock = new Flock(probe.world, [home.x, home.y, home.z], n, opts);
    for (const b of flock.birds) register(b);
    flocks.set(key, { flock, kind, shiftT: rand(L.HOME_SHIFT_MIN_S, L.HOME_SHIFT_MAX_S), deadT: 0 });
    return flock;
  }
  function dropFlock(key) {
    const e = flocks.get(key);
    if (!e) return;
    for (const b of e.flock.birds) unregister(b);
    flocks.delete(key);
  }
  const cruiseOver = (x, z) => probe.world.ground(x, z) + (BIRD.CRUISE_LO + BIRD.CRUISE_HI) / 2;

  // ---- ambient flocks: a World's, near the window
  function ambient(dt) {
    const win = getWin();
    const own = [...flocks.entries()].filter(([, e]) => e.kind === 'ambient');
    if (!win?.loaded || !probe.ready) return;
    for (const [key, e] of own) {
      const c = e.flock.centre;
      if (Math.hypot(c.x - focus.x, c.z - focus.z) > L.AMBIENT_FAR || e.flock.gone) { dropFlock(key); continue; }
      e.shiftT -= dt;
      if (e.shiftT <= 0) {   // roam: a new home near where you are
        e.shiftT = rand(L.HOME_SHIFT_MIN_S, L.HOME_SHIFT_MAX_S);
        const a = Math.random() * 2 * Math.PI, r = Math.random() * L.AMBIENT_RANGE;
        e.flock.home.set(focus.x + Math.cos(a) * r, 0, focus.z + Math.sin(a) * r);
      }
    }
    const have = [...flocks.values()].filter((e) => e.kind === 'ambient').length;
    for (let i = have; i < L.AMBIENT_FLOCKS; i++) {
      // the first ones are already about; later ones fly in from outside
      const first = nextAmbient <= L.AMBIENT_FLOCKS;
      const a = Math.random() * 2 * Math.PI, r = first ? Math.random() * L.AMBIENT_RANGE : L.AMBIENT_ARRIVE;
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      const f = addFlock(`ambient:${nextAmbient++}`, 'ambient', { x, y: cruiseOver(x, z), z });
      if (!first) { const h = Math.random() * L.AMBIENT_RANGE; f.home.set(focus.x + Math.cos(a + Math.PI) * h, 0, focus.z + Math.sin(a + Math.PI) * h); }
    }
  }

  // ---- spawner flocks: one homed on each Bird flock spawner
  function spawned(dt) {
    const sp = env.getSpawners?.();
    const list = sp ? sp.of(SPAWNER.BIRDS) : [];
    const keys = new Set(list.map((s) => `spawner:${s.id}`));
    for (const [key, e] of flocks) if (e.kind === 'spawner' && !keys.has(key)) dropFlock(key);
    const sim = getSim(), bounds = probe.world.bounds;
    const homeR = bounds ? Math.min(L.SPAWNER_HOME_R, Math.min(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) / 2 - BIRD.EDGE) : L.SPAWNER_HOME_R;
    for (const s of list) {
      const key = `spawner:${s.id}`, e = flocks.get(key);
      if (e) {
        if (e.flock.alive) { e.deadT = 0; continue; }
        e.deadT += dt;
        if (e.deadT < L.RESPAWN_S) continue;
        dropFlock(key);
      }
      if (!sim) continue;
      // they burst up off the pad
      addFlock(key, 'spawner', { x: s.world.x, y: s.world.y + BIRD.SPAN, z: s.world.z }, { homeR: Math.max(homeR, BIRD.EDGE) })
        .home.set(s.world.x, 0, s.world.z);
    }
  }

  // a loud noise at world point p, heard r cells off: every flock with a bird in earshot goes
  function noise(p, r) {
    for (const { flock } of flocks.values())
      if (flock.birds.some((b) => b.state <= S.PERCH && b.v.position.distanceTo(p) < r)) flock.startle(p);
  }
  const atWorld = (g) => { const o = getSim().origin; return new THREE.Vector3(g.x + o.x, g.y, g.z + o.z); };
  const offs = [
    povEvents.on('gun:fire', (e) => { if (e.origin) noise(atWorld(e.origin), L.LOUD_GUN); }),
    povEvents.on('impact', (e) => { if (e.point) noise(atWorld(e.point), L.LOUD_STRIKE); }),
    povEvents.on('blast', (e) => {
      if (!e.point) return;
      const p = atWorld(e.point);
      for (const { flock } of flocks.values()) for (const b of flock.birds) {
        if (b.state > S.BURN || b.v.position.distanceTo(p) > L.BLAST_KILL) continue;
        const dir = new THREE.Vector3().subVectors(b.v.position, p).normalize();
        flock.kill(b, dir);
        view.feathers(b.v.position, toScene);
      }
      noise(p, L.LOUD_BLAST);
    }),
  ];

  const rows = [];
  const ROW_POOL = [];
  function gatherRows() {
    rows.length = 0;
    for (const { flock } of flocks.values()) for (const b of flock.birds) {
      if (b.state === S.GONE) continue;
      const r = ROW_POOL[rows.length] ?? (ROW_POOL[rows.length] = { q: [0, 0, 0, 1] });
      const v = b.v, flying = b.state === S.FLY || b.state === S.LAND;
      r.id = b.id; r.p = v.position; r.vel = v.velocity; r.flying = flying;
      r.hue = b.hue; r.phase = b.phase; r.effort = b.effort;
      r.heading = b.heading;
      r.burn = b.state === S.BURN ? 1 : 0;
      r.glow = b.state <= S.BURN ? 1 : 0;
      if (flying || b.state === S.BURN) {
        const q = v.rotation;
        r.q[0] = q.x; r.q[1] = q.y; r.q[2] = q.z; r.q[3] = q.w;
        r.useQ = true; r.roll = -b.bank; r.fold = 0;
      } else {
        r.useQ = false; r.effort = 0;
        r.roll = b.state === S.FALL ? clock * L.TUMBLE + b.hue * 2 * Math.PI : b.state === S.DEAD ? L.DEAD_ROLL : 0;
        r.fold = b.state === S.PERCH ? 1 : L.DEAD_FOLD;
      }
      rows.push(r);
    }
    return rows;
  }

  return {
    // every frame; dt 0 while the world is paused (they hold still with it)
    update(dt) {
      const t0 = performance.now();
      const sim = getSim();
      if (!sim || !getVolume()) return;
      const win = getWin();
      focus.set(sim.origin.x + sim.g.nx / 2, 0, sim.origin.z + sim.g.nz / 2);
      const el = env.sunEl();
      if (night && el > deg(L.WAKE_EL)) night = false;
      else if (!night && el < deg(L.ROOST_EL)) night = true;
      glow = 1 - smooth(deg(L.GLOW_FULL_EL), deg(L.GLOW_NONE_EL), el);
      if (dt > 0) {
        probe.update(dt);
        if (win) ambient(dt);
        spawned(dt);
        const player = env.player();
        const ctx = { night, threats: player ? [player] : [] };
        if (probe.ready || !win) for (const { flock } of flocks.values()) {
          flock.update(dt, ctx);
          for (const b of flock.birds) if (b.state === S.GONE) unregister(b);
          flock.prune();
        }
      }
      clock += dt;
      view.update(dt, gatherRows(), toScene, { glow, camera, span: BIRD.SPAN });
      cost += (performance.now() - t0 - cost) * L.COST_EMA;
    },
    // a new grid, scene or preset: every flock goes (the spawners' come back with them)
    worldReplaced() {
      for (const key of [...flocks.keys()]) dropFlock(key);
      nextAmbient = 1;   // the new world's first flocks are already about
      probe.reset();
      view.clear();
    },
    get flocks() { return [...flocks.values()].map((e) => e.flock); },
    get count() { return rows.length; },
    get night() { return night; },
    get glow() { return glow; },
    get costMs() { return cost; },   // CPU per frame, running average (ms)
    get motes() { return view.motes; },
    probe, view,
    dispose() {
      offs.forEach((f) => f());
      for (const key of [...flocks.keys()]) dropFlock(key);
      probe.dispose();
      view.dispose();
    },
  };
}
