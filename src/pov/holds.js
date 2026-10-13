// How the body holds each tool in third person (held.js): Garry's Mod's hold
// types (SWEP.HoldType: pistol, smg, ar2, rpg, shotgun, physgun, melee, melee2,
// knife, grenade, slam, normal), which pick a pose by the kind of thing held,
// as Team Fortress 2's and Garry's Mod's player models do.
//
// A hold places the tool in the aim frame (the body's eye, turned to its yaw
// and some share of its pitch), then the arms reach for it (limbs.js): the
// right hand to the grip, the left to a support point on two-handed tools.
//
// HOLDS (per type), in cells for the plain-size body and radians:
//   at     the grip's rest point from the eye: [right, up, back] (−z is ahead, the viewmodels' convention)
//   turn   the tool's turn about its grip, Euler XYZ (pitch, yaw, roll); none is along the aim
//   pitch  share of the look's pitch the tool follows (1: a gun aims where you look; 0: a lantern hangs)
//   spine  share of the look's pitch the torso takes (Source's aim matrix leans the body into an aim)
//   feet   the tool stands on the ground under the body instead (the pogo stick)
//
// HELD (per models.js model): its hold, overrides of the hold's fields, its
// size against the viewmodel (`scale`: viewmodels are drawn about two-thirds
// life size to fit the screen; a long gun more so), and its hands. A hand is
// { at: [x, y, z] in the model's own units (models.js PARTS: the grip at the
// origin), fingers, palm: unit-ish vectors in the model's frame }; `right`
// defaults to a fist round the grip, `left` is only on two-handed tools.
// `pegs` (model units, right then left) are where the feet stand (the pogo's).

// a right fist round a grip that runs up through it (a pistol grip, a handle): knuckles ahead, palm in
const FIST = { at: [0, 0, 0], fingers: [0, -0.35, -1], palm: [-1, 0, 0] };
// the left hand round an upright foregrip or magazine
const FORE = (at) => ({ at, fingers: [0, -0.35, -1], palm: [1, 0, 0] });
// the left hand under a handguard, palm up, fingers round its right side
const UNDER = (at) => ({ at, fingers: [1, 0, -0.5], palm: [0, 1, 0] });
// a hand hanging at the side, round a bail that runs across it: fingers down, palm back
const HANG = { at: [0, 0, 0], fingers: [0, -1, 0], palm: [0, 0, 1] };
// hands on a handlebar from above (the pogo stick)
const BAR = (x) => ({ at: [x, 0, 0], fingers: [0, 0, -1], palm: [0, -1, 0.3] });
// a fist round a handle that runs ahead through it (a knife, a pipe): thumb along it
const SABRE = { at: [0, 0, 0], fingers: [0, -1, -0.35], palm: [-1, 0, 0] };

export const HOLDS = {
  pistol: { at: [0.4, -0.5, -1.45], pitch: 1, spine: 0.5 },          // one arm out at the shoulder
  smg: { at: [0.32, -0.95, -0.6], pitch: 1, spine: 0.5 },            // both hands, the stock in the shoulder
  ar2: { at: [0.3, -0.85, -0.5], pitch: 1, spine: 0.5 },             // a long gun shouldered
  rpg: { at: [0.55, -0.72, -0.5], pitch: 1, spine: 0.5 },            // the tube on the right shoulder
  shotgun: { at: [0.42, -1.4, -0.7], pitch: 1, spine: 0.3 },         // at the hip (TF2's Pyro holds the flamethrower so)
  physgun: { at: [0.42, -1.3, -0.8], pitch: 1, spine: 0.3 },         // both hands at the hip
  melee: { at: [0.6, -1.55, -0.8], turn: [-0.45, 0, 0], pitch: 0.3, spine: 0 },   // at the side, the head up and forward
  melee2: { at: [0.45, -1.75, -0.55], turn: [-0.35, 0, 0.75], pitch: 0.3, spine: 0 },   // two hands, across the body
  knife: { at: [0.5, -1.45, -0.9], turn: [0.35, 0, 0], pitch: 0.5, spine: 0 },   // low, the blade ahead
  grenade: { at: [0.55, -0.95, -0.7], pitch: 0.3, spine: 0 },        // at the chest, ready to throw
  slam: { at: [0.3, -1.1, -1.05], pitch: 0.6, spine: 0 },            // a device held out in front
  normal: { at: [0.8, -2.1, -0.25], pitch: 0, spine: 0 },            // hanging at the side, upright
  torch: { at: [0.55, -1.0, -0.95], pitch: 0.25, spine: 0 },          // raised ahead of the shoulder (Skyrim's torch)
  // Commander Keen's pogo: standing on its pegs, both hands on the bar, its foot on the ground
  // a little ahead of the body's centre. `at` is [right, ·, back] from the feet; the height comes
  // from the stick's length, so its foot touches the ground.
  pogo: { at: [0, 0, -0.3], pitch: 0, spine: 0, feet: true },
};

export const HELD = {
  pistol: { hold: 'pistol', scale: 1 },
  gun: { hold: 'smg', left: FORE([0, -0.05, -0.33]) },
  sniper: { hold: 'ar2', scale: 1.35, left: UNDER([0, 0.06, -0.62]) },
  laser: { hold: 'rpg', at: [0.5, -1.05, -0.35], scale: 1, left: FORE([0, -0.04, -0.95]) },
  rpg: { hold: 'rpg', left: FORE([0, 0.06, -0.55]) },
  burrower: { hold: 'rpg', left: FORE([0, 0.06, -0.45]) },
  flamer: { hold: 'shotgun', left: FORE([0, 0.03, -0.85]) },
  hook: { hold: 'shotgun', left: UNDER([0, 0.06, -0.45]) },
  physgun: { hold: 'physgun', left: UNDER([0, 0.09, -0.32]) },
  toolgun: { hold: 'pistol', scale: 1.1 },
  axe: { hold: 'melee' },
  pickaxe: { hold: 'melee2', scale: 1.5, left: { at: [0, 0.55, 0], fingers: [0, 0, -1], palm: [1, 0, 0] } },
  // the shovel's handle runs along its length (z), the blade ahead: held down and across, ready to dig
  shovel: {
    hold: 'melee2', at: [0.5, -1.4, -0.3], turn: [-0.6, 0.4, 0], scale: 1.5,
    right: { at: [0, 0, 0], fingers: [0, -1, 0], palm: [-1, 0, 0] },
    left: { at: [0, 0, -0.65], fingers: [0, -1, 0], palm: [1, 0, 0] },
  },
  trowel: { hold: 'knife', scale: 1, right: SABRE },
  knife: { hold: 'knife', scale: 1, right: SABRE },
  bomb: { hold: 'grenade', scale: 1, right: SABRE },
  flask: { hold: 'grenade', scale: 1 },
  bucket: { hold: 'normal', right: HANG },
  lantern: { hold: 'normal', right: HANG },
  torch: { hold: 'torch', flame: true },   // its head burns: lamp.js's live flame, not the icon's cone
  pogo: { hold: 'pogo', scale: 1.4, right: BAR(0.24), left: BAR(-0.24), pegs: [[0.14, -1.27, 0], [-0.14, -1.27, 0]] },
};

// A swing seen from outside (third person). The first-person swing is a flick of the wrist under
// the eye (melee.js); on the body it would be one too, and the arms would stay put. So a melee
// tool's swing plays its own gesture here, the way Garry's Mod's player models play
// ACT_HL2MP_GESTURE_RANGE_ATTACK_MELEE over the hold: the grip goes round the shoulder, the arms after it (limbs.js reach), the head over the top and
// down. Keys [s after the swing, raise, tip, drive]: raise (rad) turns the grip up about the
// shoulder (the aim's right axis), tip (rad) turns the tool about its grip, head back (+) or
// down (−), drive (cells) pushes it along the aim. Eased between keys; a tool that swings faster
// than its gesture plays it faster (melee.js refire).
export const SHOULDER_DROP = 0.85;       // cells the shoulder sits below the eye (the grip turns about it, at the hold's right)
export const GESTURES = {
  // overhead and down: up past the head, then through the aim to arm's length (Garry's Mod's melee2)
  chop: [[0, 0, 0, 0], [0.13, 2.2, 0.9, 0], [0.24, 0.55, -1.8, 0.4], [0.6, 0, 0, 0]],
  // a stab: drawn back, then driven in at the aim, as far as the arm reaches (TF2's knife)
  stab: [[0, 0, 0, 0], [0.07, 0.15, 0.2, -0.4], [0.15, 0.6, -0.15, 0.45], [0.45, 0, 0, 0]],
  // a shovel's dig: drawn back with the blade up, thrust ahead along the slanted shaft into the
  // ground (Lethal Company's shovel reaches contact at 0.13 s), the load lifted, and back to the
  // ready slant; played at the dig's 0.15 s
  dig: [[0, 0, 0, 0], [0.06, 0.3, 0.35, -0.3], [0.13, -0.15, 0.15, 1.2], [0.22, 0.35, 0.5, 0.4], [0.3, 0, 0, 0]],
  // a shovel's throw: the load flicked up and out ahead
  toss: [[0, 0, 0, 0], [0.06, -0.25, -0.25, 0.1], [0.16, 0.65, 0.75, 0.45], [0.36, 0, 0, 0]],
};
const GESTURE_BY_HOLD = { melee: 'chop', melee2: 'chop', knife: 'stab' };

// The gesture's pose [raise, tip, drive] `since` s after a swing, played over at most `span` s.
// name: a GESTURES key, or a hold type (its own gesture: GESTURE_BY_HOLD).
export function gesturePose(name, since, span, out) {
  out[0] = out[1] = out[2] = 0;
  const keys = GESTURES[name] ?? GESTURES[GESTURE_BY_HOLD[name]];
  if (!keys) return out;
  const t = since / Math.min(1, span / keys[keys.length - 1][0]);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t > b[0]) continue;
    const u = Math.max(0, (t - a[0]) / (b[0] - a[0]));
    const k = u * u * (3 - 2 * u);
    for (let j = 0; j < 3; j++) out[j] = a[j + 1] + (b[j + 1] - a[j + 1]) * k;
    return out;
  }
  return out;
}

export const HELD_SCALE = 1.2;           // × a viewmodel's size, unless HELD says otherwise

// the hold for model `key`: the type's fields with the model's own on top, or null (no model)
export function holdFor(key) {
  const m = key && HELD[key];
  if (!m) return null;
  return { ...HOLDS[m.hold], ...m, type: m.hold, right: m.right ?? FIST, left: m.left ?? null, scale: m.scale ?? HELD_SCALE };
}
