import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { PHYS as ENGINE } from '../../physics.js';
import { BODY_WIDTH, BODY_HEIGHT, BODY_DENS } from '../constants.js';
import { gunFrag, toolPass, shadedBox, glowTexture, disposeTree } from '../../shaders/povTools.js';

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
// rate.

const FIRE_INTERVAL = 0.35;        // s between shots
const SPAWN_SEARCH = 16;           // cells walked along the ray looking for the muzzle cell
const SLUG = E.SCRAP;
const SLUG_CELLS = 1;              // a slug is one cell
const SLUG_MASS = ELEMENTS[SLUG].dens * SLUG_CELLS;
const BODY_MASS = BODY_DENS * BODY_WIDTH * BODY_WIDTH * BODY_HEIGHT;
const READ_TEXELS = 1;             // the muzzle cell's state A
const RGBA = 4;

// viewmodel, in cells (camera space: +x right, +y up, −z forward)
const GUN_POS = [0.55, -0.38, -1.45];
const MUZZLE_Z = -0.62;            // cells ahead of the gun's origin
const FLASH_TIME = 0.06;           // s the muzzle flash shows
const FLASH_SIZE = 0.7;            // cells
const FLASH_COLOR = 0xffc870;
const FLASH_SPIN = 22;            // rad/s the flash sprite turns, so no two flashes look alike
const KICK_TIME = 0.16;            // s the gun takes to settle after a shot
const KICK_BACK = 0.25;            // cells it jumps back
const KICK_PITCH = 0.35;           // rad it tips up
const DRY_KICK = 0.25;             // share of the kick a dry click shows
const DRY_TOAST_INTERVAL = 1.5;    // s between "blocked" toasts

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M3 8h15l1-2h2v5h-6l-1 2h-3l-1 5H5l1-5H3z"/></svg>`;

function buildModel() {
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const barrel = shadedBox(0.2, 0.24, 1.1, 0x4a4f58);
  barrel.position.set(0, 0, -0.1);
  const slide = shadedBox(0.24, 0.12, 0.8, 0x2f3238);
  slide.position.set(0, 0.17, -0.05);
  const grip = shadedBox(0.18, 0.45, 0.24, 0x5b3d26);
  grip.position.set(0, -0.3, 0.28);
  grip.rotation.x = -0.25;
  const sight = shadedBox(0.05, 0.06, 0.06, 0xd8dde4);
  sight.position.set(0, 0.26, -0.4);
  gun.add(barrel, slide, grip, sight);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: FLASH_COLOR, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  flash.scale.setScalar(FLASH_SIZE);
  flash.position.set(0, 0.02, MUZZLE_Z);
  flash.visible = false;
  gun.add(flash);
  root.visible = false;
  return { root, gun, flash };
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
    const model = buildModel();
    env.viewmodel.add(model.root);
    const pass = toolPass(gunFrag, () => ({ uCell: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() } }));
    let time = 0, nextFire = 0, flashUntil = -1, kickAt = -Infinity, kickScale = 1, nextDryToast = 0;
    const readBuf = new Float32Array(READ_TEXELS * RGBA);
    let reading = false;
    let lastShot = null;

    const dry = () => {
      kickAt = time; kickScale = DRY_KICK;
      if (time >= nextDryToast) { env.hud?.toast?.('Click. The muzzle is blocked.'); nextDryToast = time + DRY_TOAST_INTERVAL; }
    };

    function fire(ctx) {
      const sim = ctx.sim ?? env.getSim();
      const cell = muzzleCell(ctx.eye, ctx.dir, ctx.player.pos, sim.g);
      if (!cell || reading) { dry(); return; }
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
            player.applyImpulse(dv);
            flashUntil = time + FLASH_TIME;
            kickAt = time; kickScale = 1;
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
        model.root.visible = true;
        model.root.scale.setScalar(env.getScale());
        if (ctx.primaryPressed && time >= nextFire) {
          nextFire = time + FIRE_INTERVAL;
          fire(ctx);
        }
        // viewmodel: rest pose, kick after a shot, flash
        const k = Math.max(0, 1 - (time - kickAt) / KICK_TIME) * kickScale;
        model.gun.position.set(GUN_POS[0], GUN_POS[1], GUN_POS[2] + k * KICK_BACK);
        model.gun.rotation.x = k * KICK_PITCH;
        model.flash.visible = time < flashUntil;
        model.flash.material.rotation = time * FLASH_SPIN;
      },
      deselect() { model.root.visible = false; model.flash.visible = false; },
      status: () => null,
      get lastShot() { return lastShot; },   // for checks: the muzzle cell, slug velocity and recoil of the last shot
      dispose() { pass.dispose(); disposeTree(model.root); },
    };
  },
};
