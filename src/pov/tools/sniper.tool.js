import { HIT } from '../viewmodel.js';
import { gear } from './catalog.js';
import { firearm } from './firearm.js';

// Sniper rifle: a bolt-action .50. Right-click scopes in (firearm.js, HL2's
// crossbow zoom). One heavy, fast round a shot whose strike walks a long way
// (povTrace.js strikeFrag): it bores through about fifteen cells of wood, ten
// of rock or five of metal (1.5 m) before it's spent, and kills a body outright.

const DEG = Math.PI / 180;

export default firearm({
  ...gear('SNIPER'),
  round: {
    speed: 850,              // m/s, a .50 BMG
    energy: 300,             // sim KE units: rock costs 30 a cell, metal 60
    depth: 48,               // cells its strike walks on past the face
    damage: 1,               // health a round takes from a body: one kills
    mass: 0.045,             // kg, a .50 BMG bullet (the recoil: you feel this one in the air)
  },
  refire: 1.2,               // s to work the bolt
  hold: false,               // a shot per click
  spread: { min: 0, max: 0.5 * DEG, penalty: 0.5, penaltyMax: 1 },
  hit: HIT.SNIPER,
  sound: { rate: 0.7, gain: 1.5, thump: 2 },
  scope: { zoom: 4 },        // the view narrows to a quarter
  // the held rifle, in cells (camera space)
  pose: { pos: [0.45, -0.5, -1.9], muzzle: [0, 0.1, -1.2] },
});
