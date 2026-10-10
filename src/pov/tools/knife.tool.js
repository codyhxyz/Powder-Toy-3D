import * as THREE from 'three';
import { knifeFrag, KNIFE as KNIFE_BLOW } from '../../shaders/povTools.js';
import { HIT } from '../viewmodel.js';
import { BODY_HEIGHT } from '../constants.js';
import { meleeTool } from './melee.js';
import { gear } from './catalog.js';

// Knife: Team Fortress 2's Spy knife. A stab in reach (melee.js, the axe's
// swing, here a thrust) from behind a body kills it outright, through any
// shield; from anywhere else it is a weak stab. It is for bodies, not cells: its
// blow (shaders/povTools.js KNIFE) cuts a plant or chips ice and nothing harder.
//
// Behind is TF2's own test, CTFKnife::IsBehindAndFacingTarget (source-sdk-2013,
// tf_weapon_knife.cpp), on the ground plane: with toTarget the unit direction
// from my centre to its centre, and each of us looking along our forward,
//   dot(myForward, toTarget)    > 0.5    I'm facing it (within 60°),
//   dot(itsForward, toTarget)   > 0      it faces away from me (I'm behind it),
//   dot(myForward, itsForward)  > −0.3   we look roughly the same way (not face to face around a corner).
// While a backstab is lined up the knife comes up (TF2's "ready to backstab"
// viewmodel tell), and a backstab plunges it in with its own motion.

// TF2's numbers (tf_weapon_knife, tf_weaponbase_melee.cpp)
const TF2_KNIFE_DAMAGE = 40;          // the knife's stab
const TF2_FIREAXE_DAMAGE = 65;        // the Pyro's Fire Axe: the axe here
const TF2_SWING_RANGE = 48;           // HU: the melee trace (CTFWeaponBaseMelee::GetSwingRange)...
const TF2_SWING_HULL = 18;            // HU: ...swept with a hull this half-size (vecSwingMins/Maxs)
const TF2_PLAYER_HEIGHT = 82;         // HU: a TF2 player's hull (VEC_HULL_MAX.z), this body's BODY_HEIGHT
const TF2_KNIFE_REFIRE = 0.8;         // s between stabs (the knife's attack interval)
const BEHIND_AIM_DOT = 0.5;           // IsBehindAndFacingTarget's three tests (above)
const BEHIND_BACK_DOT = 0;
const BEHIND_VIEWS_DOT = -0.3;

const AXE_BODY_DAMAGE = 0.34;         // axe.tool.js body.damage: three blows kill
const AXE_BODY_ENERGY = 40;           // axe.tool.js body.energy
const STAB_SHARE = TF2_KNIFE_DAMAGE / TF2_FIREAXE_DAMAGE;   // a stab against an axe blow, as in TF2
const BACKSTAB_ENERGY = 60;           // the impact's energy for the shake and hitmarker: the pickaxe's hardest (a full blow)

// reach: TF2's trace and hull, scaled from its player to this body
const REACH = (TF2_SWING_RANGE + TF2_SWING_HULL) / TF2_PLAYER_HEIGHT * BODY_HEIGHT;   // ≈ 4.4 cells (1.3 m)

const mine = new THREE.Vector3(), its = new THREE.Vector3(), toTarget = new THREE.Vector3();
const lo = new THREE.Vector3(), hi = new THREE.Vector3();

// TF2's test, flattened onto the ground plane. ctx.player.pos is my feet, the target's box its body.
export function behind(ctx, target) {
  if (!target?.facing || !ctx.player?.pos) return false;
  target.box(lo, hi);
  toTarget.set((lo.x + hi.x) / 2 - ctx.player.pos.x, 0, (lo.z + hi.z) / 2 - ctx.player.pos.z);
  mine.set(ctx.dir.x, 0, ctx.dir.z);
  target.facing(its);
  its.y = 0;
  if (toTarget.lengthSq() < 1e-9 || mine.lengthSq() < 1e-9 || its.lengthSq() < 1e-9) return false;
  toTarget.normalize(); mine.normalize(); its.normalize();
  return mine.dot(toTarget) > BEHIND_AIM_DOT && its.dot(toTarget) > BEHIND_BACK_DOT && mine.dot(its) > BEHIND_VIEWS_DOT;
}

export default meleeTool({
  ...gear('KNIFE'),
  blow: KNIFE_BLOW, frag: knifeFrag, hit: HIT.KNIFE, refire: TF2_KNIFE_REFIRE, reach: REACH,
  body: {
    damage: AXE_BODY_DAMAGE * STAB_SHARE,   // ≈ 0.21: weaker than the axe's 0.34
    energy: AXE_BODY_ENERGY * STAB_SHARE,
    cause: 'Stabbed',
  },
  bodyBlow: (ctx, hit) => (behind(ctx, hit.target)
    ? { damage: 1, energy: BACKSTAB_ENERGY, cause: 'Backstabbed', hit: HIT.BACKSTAB, lethal: true }
    : null),
  tell: (ctx, hit) => !!hit && behind(ctx, hit.target),
  // the held knife, in cells (camera space: +x right, +y up, −z forward); the
  // model's origin is the handle, in the hand, the blade forward
  pose: {
    pos: [0.55, -0.7, -1.2],
    rest: 0.1,               // rad, the blade a little up
    hit: -0.15,              // rad, tipped down into what it stabbed
    miss: -0.3,              // rad, further on a miss
    roll: 0.6,               // rad, edge turned in, as a knife is held
    strike: 0.07,            // s for the stab to go in (the blow itself lands at once)
    thrust: [0.5, 0.8],      // cells it drives forward on a hit and on a miss
    ready: 0.9,              // rad: raised, point toward the back in front of you (TF2's backstab tell)...
    readyPos: [-0.1, 0.25, 0.15],   // ...lifted up, in and back, ready to come down
    lethal: { hit: -1.0, miss: -1.2, thrust: [0.9, 1.1] },   // the backstab: from up high, plunged down and in
  },
});
