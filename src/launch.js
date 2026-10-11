// The start menu's hand-off to the app and back (src/main.js loads app.js on
// the first Start; app.js reads what was picked when it boots).
//   map, mode    the menu's pick for the boot (maps.js keys), null: none (a direct link, ?size=…)
//   save         a save picked on the menu's Saves before the game loaded: a local save's id or a file's bytes (app.js openSave)
//   openMenu(o)  set by main.js: the menu over the running app (the toolbar's Maps, Esc, a match's Leave; o.saves: on its Saves, ⌘O)
//   menuOpen()   set by main.js: the menu is up (a match's next-match countdown stops for it)
//   status(text) set by main.js: the loading screen's line, while app.js starts a match behind it
//   progress(step)  set by main.js, called by app.js as the boot reaches a step
//                (the loading screen's status lines, ui/menu.js STEPS)
//   ready()      set by main.js, called by app.js once the first map is on screen (and a match
//                picked with it is running)
export const launch = { map: null, mode: 'sandbox', save: null, openMenu: null, menuOpen: null, status: null, progress: null, ready: null };

// Timing marks from a click on the start menu to having control in a match,
// for tools/join-check.mjs (performance.getEntriesByType('mark'), names
// 'join:<step>'): click, app, first-frame, entered, bots, match, ready, control.
export function mark(step) {
  try { performance.mark(`join:${step}`); } catch { /* no User Timing */ }
}
