// Perks: Noita's, carried over to a body in this world (docs/pov.md, "Perks").
//
// The god view places them as orbs from the palette's Perks group
// (src/perkOrbs.js); a body that walks into one gains it. Every perk stacks:
// picking the same one again adds a stack. Some grow with each stack (the
// multipliers, the fields, Extra Life's lives); for the immunities and the
// other on/off ones, more stacks change nothing, as stacking an immunity does
// in Noita. A body loses its perks when it dies (a run ends), unless Extra Life
// brings it back.
//
// The world always obeys the engine. A perk changes only what the body can take
// and do (its tolerances, its moves, its hands); a perk that reaches into the
// world does it through the engine (cooling cells, adding air pressure), never
// by bending its rules.
//
// Pure data and bookkeeping: no three.js, so elements.js (the palette) can import it.

// ---- tuning (each a named value; Noita's where it has one)
const TOOL_RATE_STACK = 2;          // × tool speed per Faster Tools stack
const TOOL_RATE_MAX = 16;           // × at most: by then every tool already acts every frame
const EXTRA_HEALTH_STACK = 0.5;     // + max health per Extra Health stack (Noita's Extra HP: 50% more)
export const SAVING_GRACE_HEALTH = 0.01;   // health a killing blow leaves (Noita: 1 HP of Mina's 100)
const FREEZE_RADIUS = 6;            // cells (1.8 m) the Freeze Field reaches with one stack...
const FREEZE_RADIUS_STACK = 3;      // ...and this much more per further stack...
const FREEZE_RADIUS_MAX = 15;       // ...up to this
const REVENGE_PRESSURE = 30;        // air pressure (sim units) a Revenge Explosion adds per stack (a bomb's blast reaches ~200)
const REVENGE_RADIUS = 6;           // cells its shell reaches with one stack...
const REVENGE_RADIUS_STACK = 2;     // ...and this much more per further stack...
const REVENGE_RADIUS_MAX = 14;      // ...up to this
const GAMBLE_PICKS = 2;             // perks Gamble hands out (Noita's)
// Energy Shield: Halo 3's (Halopedia, "Energy shielding"): 70 shield points over 45 health
// points. Health here is 1 (one base life), so a stack is 70/45 of it; another stack adds as much.
const SHIELD_STACK = 70 / 45;       // base lives of shield per Energy Shield stack
// The movement perks double their quantity per stack (Faster Tools' rule). Speeds are capped
// where the body's GPU probe (shaders/povBody.js PROBE, 16×32×16) still keeps up at low frame
// rates: player.js caps them at what it already allows (a blast's throw sideways, Noita's
// fastest fall upward), so a deep stack stops growing there.
const MOVE_PERK_STACK = 2;          // × sprint speed per Fleet Foot stack, × jet speed per Rocket Boots stack
const TANK_STACK = 2;               // × jetpack fuel (time aloft) per Big Tank stack

// key: the palette item's key too (elements.js PERK_ITEMS). icon: an emoji, on
// the orb, its palette tile and the HUD. noita: the Noita perk it comes from.
// desc: what it does here, and what another stack adds.
export const PERKS = [
  { key: 'BREATHLESS', name: 'Breathless', noita: 'Breathless', icon: '🫧', color: '#7fd3ff',
    desc: 'You never run out of breath: under water, or buried in sand.' },
  { key: 'FIRE_IMMUNITY', name: 'Fire Immunity', noita: 'Fire Immunity', icon: '🔥', color: '#ff7a2f',
    desc: 'Heat never burns your skin. You are lighter than lava, so you can float on it.' },
  { key: 'EXPLOSION_IMMUNITY', name: 'Explosion Immunity', noita: 'Explosion Immunity', icon: '💥', color: '#ffb02e',
    desc: 'Blasts, and the walls they throw you into, never hurt. They still throw you: bomb jumps.' },
  { key: 'FREEZE_FIELD', name: 'Freeze Field', noita: 'Freeze Field', icon: '❄️', color: '#9fe3ff',
    desc: 'Liquids around you freeze and fires go out: walk on water, set lava back into rock. Each stack reaches further.' },
  { key: 'LUKKI', name: 'Lukki Mutation', noita: 'Lukki Mutation', icon: '🕷️', color: '#b48cff',
    desc: 'Your jetpack never runs dry while you touch a wall or a ceiling: climb cliffs and caves.' },
  { key: 'SAND_SWIMMER', name: 'Sand Swimmer', noita: 'Dissolve Powders', icon: '🏜️', color: '#e2c27a',
    desc: 'Powders part around you like water: swim through sand. You still need air (take Breathless).' },
  { key: 'REVENGE_EXPLOSION', name: 'Revenge Explosion', noita: 'Revenge Explosion', icon: '💣', color: '#ff5470',
    desc: 'When you are hurt, a blast goes off around you, once a second at most. Each stack hits harder and wider.' },
  { key: 'SAVING_GRACE', name: 'Saving Grace', noita: 'Saving Grace', icon: '😇', color: '#fff2a8',
    desc: 'A blow that would kill you leaves you at the last sliver of health instead.' },
  { key: 'EXTRA_LIFE', name: 'Extra Life', noita: 'Extra Life', icon: '💖', color: '#ff7ab8',
    desc: 'When you die, you come back where you fell with full health and your perks. One life per stack.' },
  { key: 'EXTRA_HEALTH', name: 'Extra Health', noita: 'Extra HP', icon: '❤️', color: '#ff4d5e',
    desc: '50% more health. Stacks add up.' },
  { key: 'FASTER_TOOLS', name: 'Faster Tools', noita: 'Faster Wands', icon: '⚡', color: '#ffe14d',
    desc: 'Every tool works twice as fast: swings, shots, digging, pouring. Each stack doubles it again.' },
  // Big Team Battle (Halo, TF2): not Noita's, but kept to the same rules
  { key: 'ENERGY_SHIELD', name: 'Energy Shield', halo: 'Energy shielding', icon: '🛡️', color: '#5fd3ff',
    desc: 'A Halo shield over your health: it takes blows, blasts and slams first and refills 5 s after the last hit. Not heat, cold, acid or drowning. Each stack holds more.' },
  { key: 'FLEET_FOOT', name: 'Fleet Foot', icon: '👟', color: '#9cff6e',
    desc: 'You sprint twice as fast. Each stack doubles it again, up to the speed of a blast.' },
  { key: 'ROCKET_BOOTS', name: 'Rocket Boots', icon: '🚀', color: '#ff9f43',
    desc: 'Your jetpack climbs and flies twice as fast. Each stack doubles it again.' },
  { key: 'BIG_TANK', name: 'Big Tank', icon: '⛽', color: '#ffd166',
    desc: 'Your jetpack holds twice the fuel: twice the time aloft. Each stack doubles it again.' },
  { key: 'GAMBLE', name: 'Gamble', noita: 'Gamble', icon: '🎲', color: '#7dffa8', oneOff: true,
    desc: 'Two random perks at once.' },
];
export const PERK = Object.fromEntries(PERKS.map((p) => [p.key, p]));

// A shrine: Noita's Holy Mountain altar. It offers this many perks; taking one takes the rest away.
export const SHRINE_OFFERS = 3;

// One body's perks: stacks per key, and what they add up to.
export function createPerkSet() {
  const stacks = new Map();
  let version = 0;   // bumps on every change (the HUD redraws on it)
  const count = (key) => stacks.get(key) ?? 0;
  const grow = (n, base, step, max) => (n ? Math.min(max, base + step * (n - 1)) : 0);
  return {
    count,
    has: (key) => count(key) > 0,
    add(key) { stacks.set(key, count(key) + 1); version++; },
    // use up one stack (Extra Life); false if there was none
    take(key) {
      const n = count(key);
      if (!n) return false;
      if (n === 1) stacks.delete(key); else stacks.set(key, n - 1);
      version++;
      return true;
    },
    clear() { if (stacks.size) { stacks.clear(); version++; } },
    get version() { return version; },
    // [{ perk, n }] in PERKS order
    list() { return PERKS.filter((p) => stacks.has(p.key)).map((p) => ({ perk: p, n: stacks.get(p.key) })); },

    healthScale: 1,   // × max health, under the stacks: a class's (classes.js; the Runner is frail). clear() keeps it
    get toolRate() { return Math.min(TOOL_RATE_MAX, TOOL_RATE_STACK ** count('FASTER_TOOLS')); },
    get maxHealth() { return this.healthScale * (1 + EXTRA_HEALTH_STACK * count('EXTRA_HEALTH')); },
    get freezeRadius() { return grow(count('FREEZE_FIELD'), FREEZE_RADIUS, FREEZE_RADIUS_STACK, FREEZE_RADIUS_MAX); },
    get revengeRadius() { return grow(count('REVENGE_EXPLOSION'), REVENGE_RADIUS, REVENGE_RADIUS_STACK, REVENGE_RADIUS_MAX); },
    get revengePressure() { return REVENGE_PRESSURE * count('REVENGE_EXPLOSION'); },
    get shieldMax() { return SHIELD_STACK * count('ENERGY_SHIELD'); },   // base lives (vitals.js)
    get sprintRate() { return MOVE_PERK_STACK ** count('FLEET_FOOT'); },   // × sprint speed (player.js caps it)
    get jetRate() { return MOVE_PERK_STACK ** count('ROCKET_BOOTS'); },    // × jet climb and fly speed (player.js caps it)
    get fuelRate() { return TANK_STACK ** count('BIG_TANK'); },            // × jet fuel time
  };
}

// Give `key` to a perk set. Gamble isn't kept: it hands out GAMBLE_PICKS
// other random perks. Returns the keys gained.
export function grant(set, key, random = Math.random) {
  if (!PERK[key]?.oneOff) { set.add(key); return [key]; }
  const pool = PERKS.filter((p) => !p.oneOff).map((p) => p.key);
  const got = [];
  for (let i = 0; i < GAMBLE_PICKS && pool.length; i++) got.push(...pool.splice(Math.floor(random() * pool.length), 1));
  got.forEach((k) => set.add(k));
  return got;
}

// Random distinct perk keys for a shrine.
export function shrineOffer(n = SHRINE_OFFERS, random = Math.random) {
  const pool = PERKS.map((p) => p.key);
  const out = [];
  for (let i = 0; i < n && pool.length; i++) out.push(...pool.splice(Math.floor(random() * pool.length), 1));
  return out;
}
