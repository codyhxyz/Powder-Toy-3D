import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { PHYS as ENGINE } from '../../physics.js';
import { BODY_WIDTH, BODY_HEIGHT, BODY_DENS } from '../constants.js';
import { gunFrag, toolPass, glowTexture } from '../../shaders/povTools.js';
import { povEvents } from '../events.js';
import { attachModel } from '../models.js';
import { viewmodelRig } from '../viewmodel.js';

// Gun: fires one SCRAP slug, a real cell, from just in front of the eye at
// V_MAX along the aim. From then on it is the engine's: gravity drops it, a
// pool slows it, and what it hits is decided by the impact rules.
//
// The muzzle cell is the first cell along the aim ray outside the body box.
// The pass only writes the slug there if that cell holds air or a gas; a
// one-texel readback of the cell (taken before the pass, so it sees what the
// pass saw) tells the tool whether it fired, for the recoil and the flash.
//
// Recoil conserves momentum: Δv_body = m_slug·v_slug / m_body, masses on the
// element table's density scale (DENS × cells), v in cells/s at the real step
// rate. A one-cell slug is a 30 cm block of metal, so that kick is huge. Standing,
// the ground takes it the way it takes any impact (solids are immovable in the
// sim): friction the sideways part, the floor the downward part. Only an upward
// kick (shooting at your feet) or a shot fired in the air or water moves you.

const FIRE_INTERVAL = 0.35;        // s between shots
const SPAWN_SEARCH = 16;           // cells walked along the ray looking for the muzzle cell
const SLUG = E.SCRAP;
const SLUG_CELLS = 1;              // a slug is one cell
const SLUG_MASS = ELEMENTS[SLUG].dens * SLUG_CELLS;
const BODY_MASS = BODY_DENS * BODY_WIDTH * BODY_WIDTH * BODY_HEIGHT;
const READ_TEXELS = 1;             // the muzzle cell's state A
const RGBA = 4;

// viewmodel, in cells (camera space: +x right, +y up, −z forward). The recoil
// is the viewmodel rig's spring (viewmodel.js), thrown by gun:fire and gun:dry.
const GUN_POS = [0.5, -0.45, -1.5];
const MUZZLE = [0, 0.1, -0.66];    // cells from the model's centre to the end of the bore
const FLASH_TIME = 0.06;           // s the muzzle flash shows
const FLASH_SIZE = 0.7;            // cells
const FLASH_COLOR = 0xffc870;
const FLASH_SPIN = 22;            // rad/s the flash sprite turns, so no two flashes look alike
const DRY_TOAST_INTERVAL = 1.5;    // s between "blocked" toasts

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M3 8h15l1-2h2v5h-6l-1 2h-3l-1 5H5l1-5H3z"/></svg>`;

// The held gun: the Kenney model (models.js, async) on a hand of the
// viewmodel rig, a muzzle point at the end of its bore and the flash there.
function buildModel(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(GUN_POS);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...MUZZLE);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: FLASH_COLOR, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  flash.scale.setScalar(FLASH_SIZE);
  flash.visible = false;
  muzzle.add(flash);
  hand.add(muzzle);
  const mesh = attachModel(hand, 'gun');
  return {
    rig, hand, muzzle, flash,
    // the muzzle in world space (for gun:fire's muzzleWorld); valid before the mesh arrives
    muzzleWorld: (out = new THREE.Vector3()) => { muzzle.updateWorldMatrix(true, false); return muzzle.getWorldPosition(out); },
    dispose() { mesh.dispose(); flash.material.map.dispose(); flash.material.dispose(); hand.removeFromParent(); },
  };
}

// First cell along eye + t·dir that doesn't overlap the body box (feet at
// pos, BODY_WIDTH square, BODY_HEIGHT tall), by grid DDA. null if none within
// SPAWN_SEARCH cells or it is outside the grid.
export function muzzleCell(eye, dir, pos, g) {
  const half = BODY_WIDTH / 2;
  const lo = [pos.x - half, pos.y, pos.z - half], hi = [pos.x + half, pos.y + BODY_HEIGHT, pos.z + half];
  const o = [eye.x, eye.y, eye.z], d = [dir.x, dir.y, dir.z];
  const c = o.map(Math.floor);
  const step = d.map(Math.sign);
  const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
  const tMax = d.map((v, k) => (v === 0 ? Infinity : ((v > 0 ? c[k] + 1 : c[k]) - o[k]) / v));
  const overlaps = () => c.every((v, k) => v < hi[k] && v + 1 > lo[k]);
  for (let i = 0; i < SPAWN_SEARCH; i++) {
    if (!overlaps()) {
      const inGrid = c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < g.nx && c[1] < g.ny && c[2] < g.nz;
      return inGrid ? new THREE.Vector3(...c) : null;
    }
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    c[k] += step[k];
    tMax[k] += tDelta[k];
  }
  return null;
}

// Atlas texel of a cell (shaders/common.js atlas()).
const atlasOf = (c, g) => [(c.y % g.tx) * g.nx + c.x, Math.floor(c.y / g.tx) * g.nz + c.z];

export default {
  key: 'GUN', name: 'Gun', slot: 4, icon: ICON,
  desc: 'Fires a metal slug that flies, drops and smashes what it hits. Kicks back hard.',
  create(env) {
    const model = buildModel(env);
    const pass = toolPass(gunFrag, () => ({ uCell: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() } }));
    let time = 0, nextFire = 0, flashUntil = -1, nextDryToast = 0;
    const readBuf = new Float32Array(READ_TEXELS * RGBA);
    let reading = false;
    let lastShot = null;

    const dry = () => {
      povEvents.emit('gun:dry', {});
      if (time >= nextDryToast) { env.hud?.toast?.('Click. The muzzle is blocked.'); nextDryToast = time + DRY_TOAST_INTERVAL; }
    };

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      if (reading) return;   // the last shot's readback is still out (far shorter than FIRE_INTERVAL)
      const cell = muzzleCell(ctx.eye, ctx.dir, ctx.player.pos, sim.g);
      if (!cell) { dry(); return; }
      const vel = ctx.dir.clone().normalize().multiplyScalar(ENGINE.V_MAX);
      // momentum: slug speed in cells/s at the real step rate
      const stepsPerSecond = ctx.dt > 0 ? ctx.stepsPerFrame / ctx.dt : 0;
      const dv = vel.clone().multiplyScalar(-SLUG_MASS * stepsPerSecond / BODY_MASS);
      const player = ctx.player;
      // what the pass will see in the muzzle cell
      const [tx, ty] = atlasOf(cell, sim.g);
      reading = true;
      env.renderer.readRenderTargetPixelsAsync(sim.targets[sim.cur], tx, ty, 1, 1, readBuf, undefined, 0)
        .then(() => {
          reading = false;
          const id = Math.round(readBuf[0]);
          if (id === E.EMPTY || ELEMENTS[id]?.kind === K.GAS) {
            if (player.onGround) dv.set(0, Math.max(dv.y, 0), 0);
            player.applyImpulse(dv);
            flashUntil = time + FLASH_TIME;
            povEvents.emit('gun:fire', { origin: cell.clone().addScalar(0.5), dir: vel.clone().normalize(), muzzleWorld: model.muzzleWorld() });
            lastShot = { cell: cell.clone(), vel: vel.clone(), dv: dv.clone() };
          } else dry();
        })
        .catch(() => { reading = false; });
      const mat = pass(sim);
      mat.uniforms.uCell.value.copy(cell);
      mat.uniforms.uVel.value.copy(vel);
      sim.pass(mat);
    }

    return {
      update(ctx) {
        time += ctx.dt;
        model.hand.visible = true;
        model.rig.update(ctx);
        if (ctx.primaryPressed && time >= nextFire) {
          nextFire = time + FIRE_INTERVAL;
          fire(ctx);
        }
        model.flash.visible = time < flashUntil;
        model.flash.material.rotation = time * FLASH_SPIN;
      },
      deselect() { model.hand.visible = false; model.flash.visible = false; },
      status: () => null,
      get lastShot() { return lastShot; },   // for checks: the muzzle cell, slug velocity and recoil of the last shot
      get muzzle() { return model.muzzle; }, // the viewmodel's muzzle point (Object3D)
      muzzleWorld: model.muzzleWorld,        // (out?) → its world position now
      dispose() { pass.dispose(); model.dispose(); },
    };
  },
};
