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
// WebGPU (docs/webgpu.md B2, B5, G5):
//   adapter      set by main.js: the adapter its probe found (probeWebGPU), for createGpu
//   gpu          set by preload.js: a promise of the device it made while the menu was up
//                (createGpu), which app.js then uses (unless it was lost meanwhile: app.js
//                then makes and sets its own); null when the page booted from a link
//   deviceError  set by app.js: the rejection of its device request (createGpu), which it
//                rethrows, so main.js can tell a refused device (the WebGPU error page)
//                from an ordinary bug in app.js (the stack-trace page)
//   warm         set by preload.js: the menu's pipeline warm-up, for tools
//                ({ grids, built, pending, settled: Promise })
export const launch = {
  map: null, mode: 'sandbox', save: null, openMenu: null, menuOpen: null, status: null, progress: null, ready: null,
  adapter: null, gpu: null, deviceError: null, warm: null,
};

// Timing marks from a click on the start menu to having control in a match,
// for tools/join-check.mjs (performance.getEntriesByType('mark'), names
// 'join:<step>'): click, app, first-frame, entered, bots, match, ready, control.
export function mark(step) {
  try { performance.mark(`join:${step}`); } catch { /* no User Timing */ }
}
