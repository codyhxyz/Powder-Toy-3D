// The first-person tools as an inventory (docs/pov.md, "Inventory"). Plain
// data, so the palette (elements.js) can list them without loading the tools.
//
// Half-Life 2's weapon buckets, as Garry's Mod carries them: each number key
// is a slot that holds every tool of one kind, and pressing it again steps to
// the next tool in it (HL2's hud_fastswitch). The bar stays SLOTS.length wide
// however many tools there are.
//
// Every tool here is carried from the first drop-in, in its slot, as GMod
// gives you every weapon: a new tool needs only its entry. The palette's Tools
// group (or Q in first person) puts one straight in hand. Within a slot, tools
// are in GEAR order; the first entry is in hand first. Each *.tool.js takes its name, model
// and description from here: export default { ...gear('KEY'), create(env) {...} }.
//
// `touch` names the tool's two buttons on a phone (pov/touch.js): [left-click,
// right-click], an empty slot (or none) for a button the tool doesn't use.
// `pickLiquids` keeps liquids targetable for tools that handle them; other
// tools aim through them, like Minecraft's mining versus bucket targeting.

export const SLOTS = ['Dig', 'Build', 'Guns', 'Explosives', 'Gadgets', 'Light'];

export const GEAR = [
  { key: 'SHOVEL', slot: 0, name: 'Shovel', model: 'shovel', abbr: 'SHVL', color: '#8a7a5c', touch: ['Dig', 'Throw'],
    desc: 'Digs loose ground (sand, snow, gravel, grass, moss) into your pack, a bite at a time. Right-click throws a block of it.' },
  { key: 'PICKAXE', slot: 0, name: 'Pickaxe', model: 'pickaxe', abbr: 'PICK', color: '#8f969c', touch: ['Mine'],
    desc: 'Mines the outlined block, rock and all, into your pack in one blow. Leaves wood to the axe; too weak for metal.' },
  { key: 'AXE', slot: 0, name: 'Axe', model: 'axe', abbr: 'AXE', color: '#9a6a3c', touch: ['Chop'],
    desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.' },
  { key: 'KNIFE', slot: 0, name: 'Knife', model: 'knife', abbr: 'KNIF', color: '#c9ccd1', touch: ['Stab'],
    desc: 'Stab a body from behind to kill it in one blow, shield or not; from the front it is a weak stab. Useless on rock.' },
  { key: 'TROWEL', slot: 1, name: 'Trowel', model: 'trowel', abbr: 'TRWL', color: '#a4a8ad', touch: ['Build', 'Material'],
    desc: 'Builds blocks from your collected materials. Right-click opens your pack to choose what to build with.' },
  { key: 'BUCKET', pickLiquids: true, slot: 1, name: 'Bucket', model: 'bucket', abbr: 'BCKT', color: '#7f8b95', touch: ['Scoop', 'Pour'],
    desc: 'Left-click scoops up liquid, hold right-click to pour it out forever: it never runs dry. Lava is fine.' },
  { key: 'FLASK', pickLiquids: true, slot: 1, name: 'Flask', model: 'flask', abbr: 'FLSK', color: '#9fd6e8', touch: ['Scoop / pour', 'Throw'],
    desc: 'Noita\'s potion flask, full of water. Left-click scoops up the liquid or powder you point at, or pours. Right-click throws it to shatter; H drinks.' },
  { key: 'GUN', slot: 2, name: 'Pistol', model: 'pistol', abbr: 'PSTL', color: '#5d6168', touch: ['Fire'],
    desc: 'Fires as fast as you click; holding fires slower. Each round breaks what it hits and adds nothing to the world.' },
  { key: 'SMG', slot: 2, name: 'SMG', model: 'gun', abbr: 'SMG', color: '#d87a22', touch: ['Fire'],
    desc: 'Hold to spray: thirteen rounds a second, each weaker than the pistol\'s, and they spread as you hold it.' },
  { key: 'SNIPER', slot: 2, name: 'Sniper rifle', model: 'sniper', abbr: 'SNPR', color: '#4f5a3c', touch: ['Fire', 'Scope'],
    desc: 'Right-click to scope in. One heavy round a shot that punches through wood, rock and even metal.' },
  { key: 'LASER', slot: 2, name: 'Laser cannon', model: 'laser', abbr: 'LASR', color: '#d8302a', touch: ['Charge'],
    desc: 'Hold left-click to charge for three seconds; it fires itself when full, and letting go early cancels. A massive beam that melts a glowing tunnel through rock and metal.' },
  { key: 'BOMB', slot: 3, name: 'Bomb', model: 'bomb', abbr: 'BOMB', color: '#4a4f55', touch: ['Throw'],
    desc: 'Throws a pipe bomb that goes off where it lands: breaks wood and glass, shoves and burns.' },
  { key: 'ROCKET', slot: 3, name: 'Rocket launcher', model: 'rpg', abbr: 'RPG', color: '#6b7a3a', touch: ['Fire'],
    desc: 'Fires a rocket that flies straight and blows a crater where it hits, with a blast of air that throws anything near it, you included.' },
  { key: 'BURROWER', slot: 3, name: 'Burrower', model: 'burrower', abbr: 'BRRW', color: '#c98a2e', touch: ['Fire'],
    desc: 'Fires a drill straight where you aim, with no homing. It bores a real tunnel: quick through sand, slow through rock, slower still through metal.' },
  { key: 'PHYSGUN', pickLiquids: true, slot: 4, name: 'Physgun', model: 'physgun', abbr: 'PHYS', color: '#5ff0ff', touch: ['Grab', 'Fling'],
    desc: 'Hold to lift loose powder, liquid or gas; wheel for distance, right-click to fling. With nothing held, right-click to shove matter, bodies and vehicles away without recoil.' },
  { key: 'BLOWTORCH', slot: 4, name: 'Flamethrower', model: 'flamer', abbr: 'FLMR', color: '#b8322a', touch: ['Burn'],
    desc: 'Hold for a continuous jet of fire, 6 m long: lights wood, sets off gunpowder, melts ice and, slowly, metal.' },
  { key: 'POGO', slot: 4, name: 'Pogo stick', model: 'pogo', abbr: 'POGO', color: '#d0453a', touch: [],
    desc: 'Hold it to bounce. Press jump just as you land to bounce higher, three times in a row to the top. Hold jump to fly.' },
  { key: 'TORCH', slot: 5, name: 'Torch', model: 'torch', abbr: 'TRCH', color: '#e07b2a', touch: ['Touch', 'Throw'],
    desc: 'A warm, flickering light. Right-click throws it, and it burns where it lands for two minutes. Its flame sets nothing alight.' },
  { key: 'LANTERN', slot: 5, name: 'Lantern', model: 'lantern', abbr: 'LNTN', color: '#e8f0ff', touch: ['Switch', 'Throw'],
    desc: 'A steady, warm light. Left-click switches it off and on; right-click throws it, and it lands unbroken and keeps shining.' },
  { key: 'HOOK', pickLiquids: true, slot: 4, name: 'Hook', model: 'hook', abbr: 'HOOK', color: '#b0884a', touch: ['Fire / reel', 'Let go'],
    desc: 'Fires a grappling hook up to 30 m. Hold left-click to reel in: a wall pulls you to it, loose matter comes to you, an enemy and you meet in the middle. Let go to hang and swing; right-click lets go.' },
  // (appended, so the palette ids of the tools before it, elements.js GEAR_ITEMS, stay put)
  { key: 'TOOLGUN', pickLiquids: true, slot: 1, name: 'Tool gun', model: 'toolgun', abbr: 'TOOL', color: '#c9ced6', touch: ['Spawn', 'Erase'],
    desc: 'Garry\'s Mod\'s tool gun: it spawns whatever you last picked in the spawn menu (Q) where you aim. Hold left-click to pour an element; click to set a construction or a spawner. Hold right-click to erase; middle-click picks up what you aim at.' },
  { key: 'JACKHAMMER', slot: 0, name: 'Jackhammer', model: 'jackhammer', abbr: 'JACK', color: '#d87a22', touch: ['Drill'],
    desc: 'Hold to rapidly mine outlined rock blocks at short range into your pack as stone. A full pack leaves the rock intact; cannot break metal.' },
];

const BY_KEY = new Map(GEAR.map((g) => [g.key, g]));
// a tool's catalog entry (key, slot, name, model, abbr, color, desc), or undefined
export const gearByKey = (key) => BY_KEY.get(key);
// what a *.tool.js spreads into its definition
export function gear(key) {
  const g = BY_KEY.get(key);
  if (!g) throw new Error(`no catalog entry for tool ${key}`);
  return { key: g.key, name: g.name, model: g.model, desc: g.desc };
}
