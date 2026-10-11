// The start menu's hand-off to the app and back (src/main.js loads app.js on
// the first Start; app.js reads what was picked when it boots).
//   map, mode    the menu's pick for the boot (maps.js keys), null: none (a direct link, ?size=…)
//   save         a save picked on the menu's Saves before the game loaded: a local save's id or a file's bytes (app.js openSave)
//   openMenu(o)  set by main.js: the menu over the running app (the toolbar's Maps, Esc; o.saves: on its Saves, ⌘O)
//   ready()      set by main.js, called by app.js once the first map is on screen
export const launch = { map: null, mode: 'sandbox', save: null, openMenu: null, ready: null };
