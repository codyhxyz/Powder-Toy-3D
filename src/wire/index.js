// The subsystems' wiring into the app (docs/webgpu.md J3). app.js builds the
// grid, runs the frame and draws the box; everything else that hooks into it
// lives in a wire module here, moved out of app.js as it was, so the unit
// that ports a subsystem (J1) boots and tests it in the real app without
// editing app.js. A wire whose unit hasn't landed is `ready: false`: app.js
// never calls it, and greys out what it serves (its tools, buttons and maps)
// with a toast saying it isn't in this version yet. U16 removes the flags.
//
// A wire module's default export (every member but name and ready optional):
//   name          its subsystem: 'world', 'pov', …
//   ready         true once its unit has ported it to WebGPU
//   order         where its scene() draws relative to the volume: below 0
//                 before it (the far field, the world's detail meshes), from
//                 0 after it, before the box's edges and the brush
//   boot(app)     once, before the first grid (subsystems that outlive a grid:
//                 the multiplayer session, signs, spawners)
//   attach(app)   in build(), once the grid's sim, derived passes and volume
//                 exist and before its scene loads (a world's window sets
//                 sim.origin here)
//   detach(app)   in build(), before the grid goes
//   beforeStep(app, dt)   each tick, before the god camera moves and the steps
//                 (POV's body and edits, Descent's level switch)
//   follow(app, dt)   each tick, once the camera has moved (the body's or the
//                 god view's: app.js updates the god view after beforeStep, and
//                 only while the body isn't active), before the steps: the
//                 world's window following the focus
//   afterStep(app, dt)    each tick, after them (app.stepping: whether it stepped;
//                         lightning, multiplayer)
//   compute(app)  in a presented frame, after FrameUniforms is written: E1
//                 work that reads it (far-field upkeep, probes; post's compute hook).
//                 A mesh-only frame (gfx/meshFrames.js) keeps what the wires drew
//                 into the scene pass, and skips the compute of a wire with a scene hook
//   lighting(app) the frame's lights, after FrameUniforms' lighting is set (a
//                 world scene's ambient and torches; a big map's once a WORLD request)
//   beforeView(app, dt)   in a presented frame, before it is drawn (signs, the
//                 far field's view, figures' uniforms and external textures,
//                 the held tool's target: app.viewmodel, app.glow)
//   scene(app, rp)        draws into our scene pass (F1), in `order`
//   overlay(app, rp)      draws into E2's overlay pass (the rays' sprites; F1)
//   detail(app)   the detail switches changed (Whitewater's field)
//   busy(app)     true while it animates or waits on something the frame
//                 loop must keep ticking for (POV, a session, rays):
//                 otherwise a settled app stops its loop (deep idle, F7)
//   meshesOnly    true when what busy() animates is three's meshes alone,
//                 which it signals with app.requestMeshFrame(): the
//                 frames may then keep the volume's scene (gfx/meshFrames.js);
//                 any other busy wire makes every frame a full one
//   invalidate(app)   graphics stopped: reject its outstanding reads
// The per-frame hooks (lighting, beforeView, compute, scene, overlay) run through
// one dispatch, src/wire/frameWires.js, from both frames: a small map's (app.js)
// and a big map's (the WORLD renderer, worldRenderFrame.js). A wire that must act
// differently on a big map decides inside its hook (`app.win?.render`) with an
// `// Intentional (...)` comment; tools/check-frame-wires.mjs guards both.
// `app` is app.js's context (`ctx` there): J3's { gpu, three, sim, derived,
// scene, camera, settings, pacer, post } (three is three.js's renderer, also
// app.renderer), the grid's volume (app.vol), the UI (app.hud, app.dock, …),
// app.js's own entry points (app.build, app.setSize, app.loadPreset, …), and
// the subsystems' slots (app.pov, app.mp, app.signs, …), which a wire fills.
// A new kind of mesh is compiled with app.gpu.three.prepare(object) before it
// joins app.scene (B5, F8): app.js sets its camera, scene and target.
// The hooks named in J3 are boot's to scene's; follow, overlay, compute,
// detail, busy and invalidate are app.js's additions (the old tick's order,
// deep idle, the meshes-first frame of the Sync log's S1).
import world from './world.js';
import pov from './pov.js';
import descent from './descent.js';
import rays from './rays.js';
import lightning from './lightning.js';
import signs from './signs.js';
import mp from './mp.js';
import mesh from './mesh.js';
import deco from './deco.js';
import console_ from './console.js';
import saves from './saves.js';
import industry from './industry.js';
import weather from './weather.js';

/**
 * Every wire, in the order their hooks run. The world attaches first (its
 * window sets sim.origin before the body or Descent see the grid), and its
 * window follows the focus in `follow`, so a tick keeps the old one's order:
 * the body, Descent, the god camera, the window, the brush.
 */
export const WIRES = [world, pov, descent, rays, lightning, signs, mp, mesh, deco, console_, industry, saves, weather];

/** A wire by name, or null. */
export const wireNamed = (name) => WIRES.find((w) => w.name === name) ?? null;

/** Whether a subsystem's wire is ready (its unit has landed). */
export const wireReady = (name) => !!wireNamed(name)?.ready;
