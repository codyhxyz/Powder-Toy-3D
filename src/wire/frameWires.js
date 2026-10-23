// The wires' per-frame hooks (src/wire/index.js), dispatched from one place for
// every map. Small maps draw through app.js's own frame (runView, frameHooks,
// drawScene); big maps draw through the WORLD renderer (wire/worldRenderFrame.js
// recordWorldFrame, app.js captureWorldRequest). Both call these dispatchers,
// with the same wires in the same order, so a feature hooked into a wire runs
// on big maps and small maps alike.
//
// A wire that must act differently on a big map decides inside its own hook
// (`app.win?.render` is the WORLD renderer owning the frame), with an
// `// Intentional (...)` comment saying why: never by one frame path leaving
// the hook out. Hand-picked calls like `wire('rays').beforeView(ctx)` were how
// the far field, the held tool's device check and every `before` scene hook
// silently skipped big maps (2026-10-23). tools/check-frame-wires.mjs fails
// when a path stops calling a dispatcher here, or a hook is called around them.

/** The per-frame wire hooks, in the order a frame runs them. */
export const FRAME_HOOKS = Object.freeze(['lighting', 'beforeView', 'compute', 'scene', 'overlay']);

/** What each frame path calls: one dispatcher a hook, the scene's two in `order`. */
export const FRAME_DISPATCH = Object.freeze(['lighting', 'beforeView', 'compute', 'sceneBelow', 'sceneAbove', 'overlay']);

/**
 * The dispatchers over `wires` (the ready ones, in WIRES order), each calling
 * its hook with appOf() first (app.js's ctx, assigned after the dispatchers are made).
 *   lighting()        the frame's lights, once FrameUniforms' lighting is set
 *                     (gfx/uniforms.js updateGfxUniforms): a world scene's
 *                     ambient floor, its wall torches. A big map captures them
 *                     once a WORLD request, a small map once a presented frame.
 *   beforeView(dt)    before the frame is drawn (index.js beforeView)
 *   compute(skip)     after FrameUniforms is written; skip(w) leaves a wire out
 *                     (a mesh-only frame's kept scene: app.js frameHooks)
 *   sceneBelow(rp, light)  the scene hooks drawn before the volume (order < 0)
 *   sceneAbove(rp, light)  the scene hooks drawn after it (order >= 0); light:
 *                     the WORLD frame's light for V2's packets (wire/rays.js)
 *   overlay(rp)       into the overlay pass
 *   hasOverlay        whether any wire draws an overlay (post skips the pass)
 */
export function createFrameWires(wires, appOf) {
  const scene = wires.filter((w) => w.scene).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const below = scene.filter((w) => (w.order ?? 0) < 0), above = scene.filter((w) => (w.order ?? 0) >= 0);
  const overlays = wires.filter((w) => w.overlay);
  return Object.freeze({
    lighting() { for (const w of wires) w.lighting?.(appOf()); },
    beforeView(dt = 0) { for (const w of wires) w.beforeView?.(appOf(), dt); },
    compute(skip = null) { for (const w of wires) if (!skip?.(w)) w.compute?.(appOf()); },
    sceneBelow(rp, light = null) { for (const w of below) w.scene(appOf(), rp, light); },
    sceneAbove(rp, light = null) { for (const w of above) w.scene(appOf(), rp, light); },
    overlay(rp) { for (const w of overlays) w.overlay(appOf(), rp); },
    hasOverlay: overlays.length > 0,
  });
}
