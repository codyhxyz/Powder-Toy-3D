// The start menu's hand-off to the app and back (src/main.js loads app.js on
// the first Start; app.js reads what was picked when it boots).
//   map, mode    the menu's pick for the boot (maps.js keys), null: none (a direct link, ?size=…)
//   openMenu()   set by main.js: the menu over the running app (the toolbar's Maps, Esc)
//   ready()      set by main.js, called by app.js once the first map is on screen
export const launch = { map: null, mode: 'sandbox', openMenu: null, ready: null };
