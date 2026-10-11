import * as THREE from 'three';
import { povEvents } from './events.js';
import { rayTarget, PLAYER } from './targets.js';
import { viewmodelRig, heldMaterial, HIT } from './viewmodel.js';
import { swing } from './tools/action.js';
import { createFrags } from './frag.js';
import { MELEE_LUNGE } from './kick.js';
import { haloMatch, wu } from './halo.js';

// Halo's golden triangle for the player in a Halo match (docs/modes.md, "Halo
// combat"): guns (the toolbelt's), grenades and melee. This is the shell's
// part of it:
// - G throws a frag grenade (frag.js) from the eye along the aim, without
//   putting the gun away: a quick lob of the left hand in the viewmodel. It
//   spends body.grenades (the arsenal gives two at every spawn). The bots
//   throw theirs through the same engine (ai/brain.js FRAG, npc.js).
// - The reticle turns red while it's on an enemy within the held gun's
//   effective range (Halo's red reticle: the weapon's auto-aim range).
// - The hitmarker shows for any blow of yours that landed (body:hit: a shot, a
//   melee, a grenade's shrapnel).
// - The grenade count shows beside the held tool's readout.
// F is Halo's melee in a match: kick.js. The shield's flare and sounds on every
// body: vfx.js, audio.js and hud.js listen to body:shield (player.js).

export const GRENADE_KEY = 'KeyG';   // G: Halo: The Master Chief Collection's PC default, and most PC shooters' grenade key
const THROW_REFIRE = 0.6;            // s before the next throw: Halo 3's throw (by eye)
const HITMARK_S = 0.2;               // s the hitmarker shows for a landed blow (feel.js HIT_TIME's, a touch longer)
// Halo 3's red reticle reaches as far as the weapon's auto-aim (Halopedia: "H3:Assault Rifle" 15 wu,
// "H3:Battle Rifle" 17 wu, "H3:SMG" 12 wu); tools without a figure take the Assault Rifle's, the
// precision ones (no figure on Halopedia) reach across any map here, the melee tools the melee's lunge
const RETICLE_WU = { AR: 15, BR: 17, SMG: 12, GUN: 15, MAGNUM: 15, SHOTGUN: 5 };
const RETICLE_DEFAULT_WU = 15;
const RETICLE_FAR = new Set(['SNIPER', 'LASER']);
const RETICLE_FAR_WU = 100;
const MELEE_TOOLS = new Set(['AXE', 'PICKAXE', 'KNIFE', 'SHOVEL']);
const reticleRange = (tool) => (MELEE_TOOLS.has(tool) ? MELEE_LUNGE
  : wu(RETICLE_FAR.has(tool) ? RETICLE_FAR_WU : RETICLE_WU[tool] ?? RETICLE_DEFAULT_WU));

// The lob: the left hand comes up from below the view with the grenade and
// throws it overhand, out of view again in THROW_REFIRE. Camera space, cells
// (+x right, +y up, −z forward), as kick.js's leg.
const LOB_SHOULDER = [-0.5, -1.1, -0.2];  // cells: the pivot, below and left of the eye
const LOB_ARM = 1.5;                       // cells, shoulder to hand
const LOB_ARM_WIDTH = 0.3;                 // cells
const LOB_NADE = 0.42;                     // cells across, the grenade in the hand (frag.js DRAWN_SIZE's, closer)
const LOB_SKIN = '#ae8058';                // his bare skin (kick.js LEG_COLOR)
const LOB_NADE_COLOR = '#4d5a2e';          // frag.js BODY_COLOR
const LOB_REST = 2.8;                      // rad about +x (the arm's +y toward +z): hanging down and back, out of view...
const LOB_TOP = -0.5;                      // rad: ...swung back, up and over to the release, up ahead on the left
const LOB_STRIKE = 0.15;                   // s up to the release

function createLobArm(env) {
  const rig = viewmodelRig(env);
  const hand = rig.hand(LOB_SHOULDER);
  hand.visible = false;
  const pivot = new THREE.Group();
  hand.add(pivot);
  const armMat = heldMaterial(LOB_SKIN), nadeMat = heldMaterial(LOB_NADE_COLOR);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(LOB_ARM_WIDTH, LOB_ARM, LOB_ARM_WIDTH), armMat);
  arm.position.y = LOB_ARM / 2;
  const nade = new THREE.Mesh(new THREE.IcosahedronGeometry(LOB_NADE / 2, 0), nadeMat);
  nade.position.y = LOB_ARM;
  pivot.add(arm, nade);
  pivot.rotation.x = LOB_REST;
  const pose = swing({ rest: LOB_REST, hit: LOB_TOP, miss: LOB_TOP, strike: LOB_STRIKE, settle: THROW_REFIRE });
  let t = Infinity;
  return {
    start() { pose.start(true); t = 0; hand.visible = true; nade.visible = true; },
    update(dt) {
      if (t === Infinity) return;
      t += dt;
      pivot.rotation.x = pose.angle(dt);
      if (t >= LOB_STRIKE) nade.visible = false;   // it left the hand
      if (t >= THROW_REFIRE) { hand.visible = false; t = Infinity; pose.stop(); }
      globalThis.__app?.requestRender?.();
    },
    dispose() { arm.geometry.dispose(); nade.geometry.dispose(); armMat.dispose(); nadeMat.dispose(); hand.removeFromParent(); },
  };
}

// shell: { scene, viewmodel, getSim, getVolume, getScale, ballistics: () => engine (the toolbelt's),
//   world: () => the bots' world model or null, hud: the POV HUD (hud.js combat()), active: () => bool, isTyping: () => bool }
export function createCombat(shell) {
  const frags = createFrags({
    scene: shell.scene, getSim: shell.getSim, getVolume: shell.getVolume, getScale: shell.getScale,
    ballistics: shell.ballistics, world: shell.world,
  });
  const env = { viewmodel: shell.viewmodel, getScale: shell.getScale };
  let lob = null, queued = false, wait = 0, hitT = 0, red = false;

  addEventListener('keydown', (e) => {
    if (e.code !== GRENADE_KEY || e.repeat || !shell.active() || shell.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    queued = true;
  });
  const offs = [
    // a blow of the player's landed on a body (targets.js: only blows the hit rules let through)
    povEvents.on('body:hit', (e) => { if (!e.by && e.id !== PLAYER && e.amount > 0 && haloMatch()) hitT = HITMARK_S; }),
  ];

  // G: a frag from the eye, if one's carried; false if none left the hand
  function throwOne(player, eye, dir) {
    if (!(player.grenades > 0) || wait > 0) return false;
    if (!frags.throw(player, eye, dir)) return false;
    player.grenades--;
    wait = THROW_REFIRE;
    lob ??= createLobArm(env);
    lob.start();
    viewmodelRig(env).hit(HIT.THROW);
    return true;
  }

  return {
    frags,
    // every POV frame. s: { dt, player, eye, dir (grid, unit), tool (the held key), live (alive, in the eyes, input on), stepsPerFrame }
    update(s) {
      const { dt, player } = s;
      wait = Math.max(0, wait - dt);
      hitT = Math.max(0, hitT - dt);
      frags.update(dt, s.stepsPerFrame);
      const halo = haloMatch() && !!player;
      if (queued) {
        queued = false;
        if (halo && s.live) throwOne(player, s.eye, s.dir);
      }
      lob?.update(dt);
      // the red reticle: a body the hit rules don't pass (teammates are passed) on another team, in range
      red = false;
      if (halo && s.live && player.team) {
        const who = rayTarget(s.eye, s.dir, reticleRange(s.tool), PLAYER);
        const team = who?.target.body?.team;
        red = !!team && team !== player.team;
      }
      shell.hud.combat({ red, hit: Math.min(1, hitT / HITMARK_S), grenades: halo && !player.dead && player.grenades != null ? player.grenades : null });
    },
    throw: throwOne,   // (checks) throw as the player now
    get red() { return red; },   // (checks) the reticle is red
    windowShifted(dx, dz) { frags.windowShifted(dx, dz); },
    dispose() { offs.forEach((off) => off()); frags.dispose(); lob?.dispose(); },
  };
}
