// The first-person tools as an inventory (docs/pov.md, "Inventory"). Plain
// data, so the palette (elements.js) can list them without loading the tools.
//
// Half-Life 2's weapon buckets, as Garry's Mod carries them: each number key
// is a slot that holds every tool of one kind, and pressing it again steps to
// the next tool in it (HL2's hud_fastswitch). The bar stays SLOTS.length wide
// however many tools there are.
//
// A tool with `start` is in hand from the first drop-in. The rest are given
// from the palette's Tools group (or Q in first person): GMod's spawn menu.
// Within a slot, tools are in GEAR order. Each *.tool.js takes its name, model
// and description from here: export default { ...gear('KEY'), create(env) {...} }.

export const SLOTS = ['Dig', 'Build', 'Guns', 'Explosives', 'Gadgets'];

export const GEAR = [
  { key: 'SHOVEL', slot: 0, start: true, name: 'Shovel', model: 'shovel', abbr: 'SHVL', color: '#8a7a5c',
    desc: 'Hold left-click to dig powder or break solids into debris. Right-click throws the load.' },
  { key: 'PICKAXE', slot: 0, start: true, name: 'Pickaxe', model: 'pickaxe', abbr: 'PICK', color: '#8f969c',
    desc: 'Mines rock into stone and breaks anything the axe can. Too weak for metal.' },
  { key: 'AXE', slot: 0, start: true, name: 'Axe', model: 'axe', abbr: 'AXE', color: '#9a6a3c',
    desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.' },
  { key: 'KNIFE', slot: 0, name: 'Knife', model: 'knife', abbr: 'KNIF', color: '#c9ccd1',
    desc: 'Stab a body from behind to kill it in one blow, shield or not; from the front it is a weak stab. Useless on rock.' },
  { key: 'TROWEL', slot: 1, start: true, name: 'Trowel', model: 'trowel', abbr: 'TRWL', color: '#a4a8ad',
    desc: 'Builds 1 m blocks out of what the shovel dug up. Right-click picks the material.' },
  { key: 'BUCKET', slot: 1, start: true, name: 'Bucket', model: 'bucket', abbr: 'BCKT', color: '#7f8b95',
    desc: 'Left-click scoops up liquid, hold right-click to pour it out forever: it never runs dry. Lava is fine.' },
  { key: 'GUN', slot: 2, start: true, name: 'Pistol', model: 'pistol', abbr: 'PSTL', color: '#5d6168',
    desc: 'Fires as fast as you click; holding fires slower. Each round breaks what it hits and adds nothing to the world.' },
  { key: 'SMG', slot: 2, name: 'SMG', model: 'gun', abbr: 'SMG', color: '#d87a22',
    desc: 'Hold to spray: thirteen rounds a second, each weaker than the pistol\'s, and they spread as you hold it.' },
  { key: 'SNIPER', slot: 2, name: 'Sniper rifle', model: 'sniper', abbr: 'SNPR', color: '#4f5a3c',
    desc: 'Right-click to scope in. One heavy round a shot that punches through wood, rock and even metal.' },
  { key: 'BOMB', slot: 3, start: true, name: 'Bomb', model: 'bomb', abbr: 'BOMB', color: '#4a4f55',
    desc: 'Throws a pipe bomb that goes off where it lands: breaks wood and glass, shoves and burns.' },
  { key: 'ROCKET', slot: 3, name: 'Rocket launcher', model: 'rpg', abbr: 'RPG', color: '#6b7a3a',
    desc: 'Fires a rocket that flies straight and blows a crater where it hits, with a blast of air that throws anything near it, you included.' },
  { key: 'PHYSGUN', slot: 4, start: true, name: 'Physgun', model: 'physgun', abbr: 'PHYS', color: '#5ff0ff',
    desc: 'Hold to lift loose powder, liquid or gas; wheel for distance, right-click to fling. Right-click empty-handed to blast.' },
  { key: 'BLOWTORCH', slot: 4, start: true, name: 'Blowtorch', model: 'torch', abbr: 'TRCH', color: '#b8322a',
    desc: 'Hold to burn: lights wood, sets off gunpowder, melts ice and, slowly, metal.' },
  { key: 'SCANNER', slot: 4, start: true, name: 'Scanner', model: 'scanner', abbr: 'SCAN', color: '#7dff9a',
    desc: 'Reads the material, temperature and pressure of whatever you point it at.' },
  { key: 'POGO', slot: 4, name: 'Pogo stick', model: 'pogo', abbr: 'POGO', color: '#d0453a',
    desc: 'Hold it to bounce. Press jump just as you land to bounce higher, three times in a row to the top. Hold jump to fly.' },
];

const BY_KEY = new Map(GEAR.map((g) => [g.key, g]));
// a tool's catalog entry (key, slot, start, name, model, abbr, color, desc), or undefined
export const gearByKey = (key) => BY_KEY.get(key);
// what a *.tool.js spreads into its definition
export function gear(key) {
  const g = BY_KEY.get(key);
  if (!g) throw new Error(`no catalog entry for tool ${key}`);
  return { key: g.key, name: g.name, model: g.model, desc: g.desc };
}
