// Every key the game listens for, once. The handlers ask this table (is, held,
// codes) and the Controls sheet (ui/hud.js) and the hints that name a key (label)
// read it, so a key changed here changes everywhere it is pressed or shown.
//
// A binding is a list of chords, any of which does it. A chord is a key with
// optional modifiers before it: 'Mod+z', 'Ctrl+b', 'Alt+KeyI'.
//   - one character ('v', '[', '?') is the character typed (KeyboardEvent.key,
//     letters either case): it follows the keyboard's layout, as TPT's letters do
//   - a longer name ('KeyW', 'Space', 'Escape', 'F5') is the physical key
//     (KeyboardEvent.code): movement stays under the fingers on any layout
//   - Mod is ⌘ on a Mac and Ctrl elsewhere (either is accepted, as before);
//     Ctrl is Ctrl alone; Shift is checked only when the chord names it
// Mouse buttons aren't here: the sheet names them in words.
// Gamemode-local menus (the class picker's digits, the village's choices, a
// text field's Enter) keep their own keys: they are the menu's, not the game's.
export const KEYS = {
  // moving: the god view flies (camera.js), the body walks (pov/index.js), a vehicle drives
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  fast: ['ShiftLeft', 'ShiftRight'],   // fly faster, sprint, a vehicle's boost
  // god view up and down: Space and C as in Rust's noclip and the body's own jump and
  // crouch, so the keys carry over; E and Q are Roblox Studio's. Not Ctrl: Ctrl+W
  // closes the browser tab and no page can stop it
  flyUp: ['Space', 'KeyE'],
  flyDown: ['KeyC', 'KeyQ'],
  jump: ['Space'],        // swims up in liquid; a vehicle's brake or hop; respawns early
  crouch: ['KeyC'],       // PUBG's and Apex's crouch (Source's duck in player.js); swims down in liquid

  // god view camera
  focus: ['f'],           // fly to what's under the cursor (Roblox Studio's and Unreal's focus)
  resetCamera: ['r'],
  firstPerson: ['v'],     // into the body and back out (Garry's Mod's noclip key)

  // painting (The Powder Toy's keys where it has one)
  brushSmaller: ['['],
  brushBigger: [']'],
  brushShape: ['b'],
  replaceMode: ['x', ';', 'Insert'],              // TPT's ; and Insert
  specificDelete: ['Delete', 'Backspace', 'Mod+;'],   // TPT's Delete and Ctrl+; (a Mac's delete key is Backspace)
  target: ['Alt+KeyI'],   // (⌥I types a dead key on a Mac: by its code)
  eyedropper: ['i'],
  property: ['Mod+p'],    // TPT's Ctrl+P
  deco: ['Ctrl+b'],       // TPT's
  undo: ['Mod+z'],
  find: ['/'],

  // the simulation and the interface
  escape: ['Escape'],     // closes menus; with none open, pauses (Sandbox) or the menu (a gamemode)
  step: ['.'],
  airMode: ['y'],         // TPT's Y and U
  ambientHeat: ['u'],
  spawnMenu: ['t'],       // TPT's element bar; chat instead when playing together
  chat: ['t'],            // Minecraft's chat key
  settings: [','],
  help: ['?'],
  screenshot: ['F2'],     // Minecraft Java's
  scoreboard: ['Tab'],    // Source's +showscores
  save: ['Mod+s'],        // every program's (TPT's Save button has no key)
  openSaves: ['Mod+o'],
  console: ['Backquote'], // TPT's Lua console

  // first person
  kick: ['KeyF'],         // free in the body; Halo's melee in a Halo match
  zoom: ['KeyZ'],
  toolMenu: ['KeyQ'],     // Garry's Mod's spawn-menu key; Factory's Build
  use: ['KeyE'],          // vehicles, pick-ups, shops (Halo's and most shooters' use key)
  drink: ['KeyH'],        // Grim Dawn's potion key
  view: ['F5'],           // first or third person, Minecraft's (its page reload held back)
  viewTap: ['ControlLeft', 'ControlRight'],   // a tap of Ctrl alone does it too (a laptop's F5 hides behind fn)
  hideHud: ['F1'],        // Minecraft's
  grenade: ['KeyG'],      // Halo: MCC's PC default
  classPicker: [','],     // Team Fortress 2's, in Siege (settings everywhere else)
  editWand: ['KeyB'],     // the Noita gamemode's wand editor
  switchTeam: ['.'],      // in a team match
};

// the number key of hotbar slot i (pov/tools/hotbar.js): 1–9, then 0
export const slotKey = (i) => String((i + 1) % 10);

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const parsed = new Map();
function parse(chord) {
  let p = parsed.get(chord);
  if (!p) {
    const parts = chord.length > 1 ? chord.split('+') : [chord];
    const key = parts.pop() || '+';
    p = { key, mods: new Set(parts), byChar: key.length === 1 };
    parsed.set(chord, p);
  }
  return p;
}

function chordIs(e, chord) {
  const { key, mods, byChar } = parse(chord);
  if (byChar ? e.key?.toLowerCase() !== key.toLowerCase() : e.code !== key) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (mods.has('Mod') ? !mod : mods.has('Ctrl') ? !(e.ctrlKey && !e.metaKey) : mod) return false;
  if (mods.has('Alt') !== !!e.altKey) return false;
  return !mods.has('Shift') || e.shiftKey;
}

// a key event does the binding
export const is = (e, binding) => binding.some((c) => chordIs(e, c));
// a set of held KeyboardEvent.codes holds one of the binding's keys
export const held = (keys, binding) => binding.some((c) => keys.has(c));
// the physical keys of some bindings, for a held-keys set
export const codes = (...bindings) => new Set(bindings.flat().filter((c) => !parse(c).byChar));

const NAMES = {
  Space: 'Space', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  Backquote: '`', Mod: MAC ? '⌘' : 'Ctrl', Ctrl: 'Ctrl', Alt: MAC ? '⌥' : 'Alt', Shift: 'Shift',
};
const keyName = (k) => NAMES[k] ?? (/^Key[A-Z]$/.test(k) ? k.slice(3) : /^Digit\d$/.test(k) ? k.slice(5) : k.length === 1 ? k.toUpperCase() : k);

// a binding's chords as the keycaps to draw, one list per chord (Shift's two keys are one)
export function keycaps(binding) {
  const out = new Map();
  for (const c of binding) {
    const { key, mods } = parse(c);
    const caps = [...mods, key].map(keyName);
    out.set(caps.join('+'), caps);
  }
  return [...out.values()];
}
// the modifier keys' names, for the mouse chords the Controls sheet spells out (⌘ + drag)
export const MOD = NAMES.Mod, ALT = NAMES.Alt;
// a binding's first chord, in words: 'Space', '⌘ Z'
export const label = (binding) => keycaps(binding)[0].join(' ');
