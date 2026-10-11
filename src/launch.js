// The start menu's hand-off to the app and back (src/main.js loads app.js on
// the first Start; app.js reads what was picked when it boots).
//   map, mode    the menu's pick for the boot (maps.js keys), null: none (a direct link, ?size=…)
//   openMenu()   set by main.js: the menu over the running app (the toolbar's Maps, Esc)
//   ready()      set by main.js, called by app.js once the first map is on screen
//   progress(step)  set by main.js, called by app.js as the boot reaches a step
//                (the loading screen's status lines, ui/menu.js STEPS)
export const launch = { map: null, mode: 'sandbox', openMenu: null, ready: null, progress: null };
