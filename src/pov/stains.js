import * as THREE from 'three';
import { E } from '../elements.js';
import { torchFireFrag, toolPass, TORCH_FIRE } from '../shaders/povTools.js';
import { SEED_MAX } from '../shaders/common.js';
import { BODY_WIDTH, BODY_HEIGHT } from './constants.js';
import { VITALS } from './vitals.js';
import { registerStatus, registerStain } from './status.js';
import { Load, sharedTransfer, cellsNear, outsideBody } from './tools/transfer.js';

// The built-in statuses (status.js holds the machinery): Noita's stains on a
// first-person body, sourced from the cells it touches, and Bleeding. What a
// status does to the world goes through the engine: a burning body lights the
// air around it with a lying torch's flame (shaders/povTools.js TORCH_FIRE),
// and a wound spills real cells (tools/transfer.js put). Table: docs/pov.md,
// "Status effects".
//
// Element keys from other branches (SALTWATER, TOXIC, SLIME, BLOOD, liquid
// nitrogen) are looked up when the first stain is counted: absent, they're no
// source (status.js).

// ---- Wet: water on the skin (water, rain, a cloud's fog, melting snow)
const WET_S = 10;               // s a soaking lasts once out of the water (Noita's Wet is ~10 s)
const WET_RATE = 25;            // s of Wet per s, whole skin under water: a wade (share ~0.2) shows in 0.1 s, soaks in 2.5 s
const FOG_WET_RATE = 3;         // ...in a cloud: fog wets slowly
const SNOW_WET_RATE = 4;        // ...in snow: the snow on you melts
const WET_DRY_SPAN = 20;        // °C of skin above BODY_T that dries it one more time as fast (evaporation)
// ---- Oily
const OILY_S = 15;              // s
const OIL_RATE = 20;            // s of Oily per s, whole skin in oil
const OILY_IGNITE = 4;          // × how fast fire catches on an oily body...
const OILY_BURN = 2.5;          // ...× how long it burns (the oil is fuel)
const OILY_WASH = 2;            // × fade while Wet: oil and water barely mix
// ---- Burning: the body itself on fire. Its clothes and what's on them are the fuel: it burns
// out after BURN_S (OILY_BURN × that oily) unless water, snow, a Wet stain or Frozen puts it out.
const BURN_S = 4;               // s a fire on the body lasts
const BURN_SHOW_S = 0.25;       // s of contact dose that sets it alight
const FIRE_IGNITE_RATE = 100;   // s of ignition dose per s, whole skin in fire: 1% of the contact cells (2) is the least that
                                // lights it (status.js), a 2% brush lights it in 0.25 s
const LAVA_IGNITE_RATE = 200;   // ...in lava
const IGNITE_T = 255;           // °C of skin that sets it alight by itself: cotton fabric's ignition temperature
const OILY_IGNITE_T = 150;      // ...oil-soaked: a mineral oil's flash point
const BURN_DAMAGE = 0.06;       // health/s while burning (Fire Immunity: none). Game tuning: the burns a 30 cm cell can't resolve
const BURN_FIRE_INTERVAL = 0.15;  // s between the flame passes off a burning body (lamp.js's lying torch's)
// the flame starts beyond the cells vitals counts as touching (player.js CONTACT_REACH 0.5 + the
// flame's own radius + a cell), so the body's own fire lights the world, not itself again
const BURN_FIRE_OUT = BODY_WIDTH / 2 + 0.5 + TORCH_FIRE.RADIUS0 + 1;   // cells from the body's axis
// ---- Frozen: numb with cold
const FROZEN_S = 4;             // s
const FROZEN_SKIN_T = 10;       // °C: skin colder than this is numb (hands lose their dexterity below ~15 °C, numbness ~10 °C)
const THAW_SKIN_T = 40;         // °C: skin warmer than this (heated from outside, past the core's 37) thaws it...
const THAW_FADE = 6;            // ...this many times as fast
const ICE_RATE = 3;             // s of Frozen per s, whole skin against ice or snow: standing on it (~15%) never freezes you
const LN2_RATE = 40;            // ...in liquid nitrogen (−196 °C)
const FROZEN_MOVE = 0.3;        // × speed on foot
// ---- Toxic: TOXIC sludge
const TOXIC_S = 6;              // s
const TOXIC_RATE = 20;          // s of Toxic per s, whole skin in it
const TOXIC_DAMAGE = 0.05;      // health/s while stained (it gets past the shield, like acid)
const TOXIC_WASH = 3;
// ---- Slimy
const SLIMY_S = 8;              // s
const SLIME_RATE = 20;
const SLIMY_MOVE = 0.6;         // × speed on foot
const SLIMY_WASH = 3;
// ---- Bloody: cosmetic
const BLOODY_S = 8;             // s
const BLOOD_RATE = 15;
const BLOODY_WASH = 8;          // blood rinses off fast
// ---- Bleeding: a blow, fall, blast or bullet (what the Energy Shield would take) spills blood.
// One cell is 27 L, five times a body's blood: any spill is an exaggeration, Noita's own (its
// bodies spray far more than they hold). Game magic, in proportion to the damage.
export const BLEED_ELEMENT = 'BLOOD';    // element key spilled (branch nt-mat adds it; absent: no spill)
const BLEED_CELLS_PER_HEALTH = 12;       // cells per unit of health taken (a whole life)
const BLEED_MAX_CELLS = 16;              // cells at most from one wound
const BLEED_REACH = BODY_WIDTH / 2 + 2;  // cells from the chest the blood lands within
const BLEED_CHEST = 0.6;                 // share of the body's height the blood leaves from

const T = VITALS.BODY_T;
const hotter = (body) => Math.max(0, (body.skinT ?? T) - T);
const fireImmune = (body) => !!body.perks?.has('FIRE_IMMUNITY');

registerStatus({
  key: 'WET', name: 'Wet', icon: '💧', color: '#5aa9ff',
  cancels: ['BURNING'], blocks: ['BURNING'],
  fade: (body) => 1 + hotter(body) / WET_DRY_SPAN,
  tint: [0.18, 0.26, 0.38, 0.45], screen: 'rgba(80, 150, 255, 0.55)',
});
registerStatus({
  key: 'OILY', name: 'Oily', icon: '🛢️', color: '#a0712e', wash: OILY_WASH,
  tint: [0.22, 0.14, 0.05, 0.6], screen: 'rgba(150, 100, 30, 0.55)',
});
registerStatus({
  key: 'BURNING', name: 'Burning', icon: '🔥', color: '#ff7a2f',
  cancels: ['FROZEN'], show: BURN_SHOW_S, full: true, refresh: false,
  buildRate: (set) => (set.has('OILY') ? OILY_IGNITE : 1),
  duration: (set) => (set.has('OILY') ? OILY_BURN : 1),
  when: (body, env, set) => ((body.skinT ?? T) > (set.has('OILY') ? OILY_IGNITE_T : IGNITE_T) ? BURN_S * (set.has('OILY') ? OILY_BURN : 1) : 0),
  onTick(body, dt, ctx) {
    if (!fireImmune(body)) ctx.hurt?.(BURN_DAMAGE * dt, 'Burned alive');
    ctx.world?.burn(body, dt);
  },
  tint: [0.1, 0.06, 0.04, 0.45], screen: 'rgba(255, 110, 20, 0.6)',
});
registerStatus({
  key: 'FROZEN', name: 'Frozen', icon: '🧊', color: '#9fe3ff',
  cancels: ['BURNING'], move: FROZEN_MOVE,
  when: (body) => ((body.skinT ?? T) < FROZEN_SKIN_T ? FROZEN_S : 0),
  fade: (body) => ((body.skinT ?? T) > THAW_SKIN_T ? THAW_FADE : 1),
  tint: [0.62, 0.82, 1.0, 0.6], screen: 'rgba(170, 220, 255, 0.6)',
});
registerStatus({
  key: 'TOXIC', name: 'Toxic', icon: '☣️', color: '#8fe03a', wash: TOXIC_WASH,
  onTick(body, dt, ctx) { ctx.hurt?.(TOXIC_DAMAGE * dt, 'Poisoned'); },
  tint: [0.22, 0.55, 0.08, 0.5], screen: 'rgba(120, 230, 50, 0.55)',
});
registerStatus({
  key: 'SLIMY', name: 'Slimy', icon: '🫠', color: '#d977c8', move: SLIMY_MOVE, wash: SLIMY_WASH,
  tint: [0.62, 0.3, 0.55, 0.45], screen: 'rgba(220, 110, 200, 0.5)',
});
registerStatus({
  key: 'BLOODY', name: 'Bloody', icon: '🩸', color: '#d0212f', wash: BLOODY_WASH,
  tint: [0.4, 0.02, 0.03, 0.55], screen: 'rgba(200, 20, 30, 0.45)',
});

registerStain('WATER', 'WET', { rate: WET_RATE, seconds: WET_S });
registerStain('SALTWATER', 'WET', { rate: WET_RATE, seconds: WET_S });
registerStain('CLOUD', 'WET', { rate: FOG_WET_RATE, seconds: WET_S });
registerStain('SNOW', 'WET', { rate: SNOW_WET_RATE, seconds: WET_S });
registerStain('OIL', 'OILY', { rate: OIL_RATE, seconds: OILY_S });
registerStain('FIRE', 'BURNING', { rate: FIRE_IGNITE_RATE, seconds: BURN_S });
registerStain('LAVA', 'BURNING', { rate: LAVA_IGNITE_RATE, seconds: BURN_S });
registerStain('ICE', 'FROZEN', { rate: ICE_RATE, seconds: FROZEN_S });
registerStain('SNOW', 'FROZEN', { rate: ICE_RATE, seconds: FROZEN_S });
registerStain('LN2', 'FROZEN', { rate: LN2_RATE, seconds: FROZEN_S });
registerStain('LIQUID_NITROGEN', 'FROZEN', { rate: LN2_RATE, seconds: FROZEN_S });
registerStain('TOXIC', 'TOXIC', { rate: TOXIC_RATE, seconds: TOXIC_S });
registerStain('SLIME', 'SLIMY', { rate: SLIME_RATE, seconds: SLIMY_S });
registerStain('BLOOD', 'BLOODY', { rate: BLOOD_RATE, seconds: BLOODY_S });

// A wound of `amount` (health, before Extra Health divides it): Bloody, and blood
// spilled in proportion (fractions carry over to the next wound).
export function wound(body, amount, ctx) {
  if (!(amount > 0)) return;
  ctx.set?.add('BLOODY', BLOODY_S, 1, 'wound');
  ctx.bleedCarry = (ctx.bleedCarry ?? 0) + amount * BLEED_CELLS_PER_HEALTH;
  const n = Math.min(BLEED_MAX_CELLS, Math.floor(ctx.bleedCarry));
  if (n <= 0) return;
  ctx.bleedCarry -= n;
  const id = E[BLEED_ELEMENT] ?? -1;
  if (id >= 0) ctx.world?.spill(body, id, n, T);
}

// A body's reach into the grid for its statuses: fire off a burning body, cells
// spilled from a wound. One per body (player.js), sharing the GPU passes.
export function createBodyWorld({ renderer, getSim }) {
  let fire = null, fireWait = 0, frame = 0;
  const nozzle = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), mid = new THREE.Vector3();
  const env = { renderer, getSim };
  return {
    // a burning body: every BURN_FIRE_INTERVAL a lying torch's flame licks up beside it, at a
    // random side and height, as engine FIRE (it lights grass and wood the engine's way)
    burn(body, dt) {
      fireWait -= dt;
      if (fireWait > 0) return;
      fireWait = BURN_FIRE_INTERVAL;
      const sim = getSim();
      if (!sim) return;
      fire ??= toolPass(torchFireFrag, () => ({
        uNozzle: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() },
        uReach: { value: 0 }, uDt: { value: 0 }, uFrame: { value: 0 },
      }));
      const a = Math.random() * 2 * Math.PI;
      nozzle.set(body.pos.x + Math.cos(a) * BURN_FIRE_OUT, body.pos.y + Math.random() * BODY_HEIGHT, body.pos.z + Math.sin(a) * BURN_FIRE_OUT);
      const mat = fire(sim);
      const u = mat.uniforms;
      u.uNozzle.value.copy(nozzle);
      u.uDir.value.copy(up);
      u.uReach.value = TORCH_FIRE.LENGTH;
      u.uDt.value = BURN_FIRE_INTERVAL;
      u.uFrame.value = ++frame;
      sim.pass(mat);
    },
    // spill n cells of element id at temperature t from the body's chest into the air
    // around it (tools/transfer.js put: what finds no room isn't spilled)
    spill(body, id, n, t) {
      const sim = getSim();
      if (!sim) return null;
      mid.copy(body.pos).setY(body.pos.y + BODY_HEIGHT * BLEED_CHEST);
      const load = new Load(n);
      for (let i = 0; i < n; i++) load.cells.push([id, t, 0, Math.random() * SEED_MAX]);
      return sharedTransfer(env).put(load, { cells: cellsNear(mid, BLEED_REACH, sim.g, outsideBody(body.pos)), vel: new THREE.Vector3() });
    },
    dispose() { fire?.dispose(); fire = null; },
  };
}
