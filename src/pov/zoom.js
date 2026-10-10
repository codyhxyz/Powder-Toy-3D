// The zoom key, Z: Minecraft's zoom mods (OptiFine, Ok Zoomer, Zoomify; they
// put it on C, which is the crouch here), with Zoomify's defaults (its ZoomifySettings.kt and ZoomHelper.kt). Hold to
// narrow the view to a quarter; scroll while holding to zoom further in or
// back out; let go and it eases back, forgetting the scrolling. The look
// slows with the view (camera.js turn), as Zoomify's relative sensitivity
// 100 % does, and a scope's zoom multiplies with it (Zoomify's spyglass
// "combine").

export const ZOOM_KEY = 'KeyZ';
const ZOOM_INITIAL = 4;          // the FOV's divisor on holding the key (Zoomify's initialZoom; OptiFine's fixed ÷4)
const ZOOM_IN_S = 1;             // s, easing in: exponential ease-out, so most of it is in the first fifth (zoomInTime)
const ZOOM_OUT_S = 0.5;          // s, easing back out: the mirror curve (zoomOutTime)
const ZOOM_STEP = 1.5;           // each wheel notch multiplies the divisor by this (zoomPerStep 150 %)
const ZOOM_STEPS_IN = 10;        // notches further in at most (scrollStepCount)
// notches back out at most: as far as the plain view (ZoomHelper's minScrollTiers)
const ZOOM_STEPS_OUT = Math.ceil(Math.log(ZOOM_INITIAL) / Math.log(ZOOM_STEP));
// 1/s: how fast a notch's zoom settles. Zoomify's scrollZoomSmoothness 70 closes
// 37 % of the gap each 20 Hz tick: −ln(1 − 0.37) × 20.
const ZOOM_SCROLL_RATE = 9.2;
const ZOOM_MAX = 500;            // the divisor's ceiling (ZoomHelper's safety limit)
const EXP_CURVE = 10;            // the exponential curves' steepness: 2^(−10 t)

// Zoomify's EASE_OUT_EXP going in and EASE_IN_EXP coming out, with their
// inverses: a change of direction picks the curve's time that keeps the zoom
// where it is (TransitionInterpolator).
const easeIn = (t) => (t >= 1 ? 1 : 1 - 2 ** (-EXP_CURVE * t));
const easeOut = (t) => (t <= 0 ? 0 : 2 ** (EXP_CURVE * (t - 1)));
const easeInTime = (e) => (e >= 1 ? 1 : -Math.log2(1 - e) / EXP_CURVE);
const easeOutTime = (e) => (e <= 0 ? 0 : 1 + Math.log2(e) / EXP_CURVE);

export function createZoom() {
  let held = false;
  let t = 0, e = 0;              // the curve's time, and how far in the zoom is (0 none … 1 the initial ÷4)
  let steps = 0, scroll = 0;     // wheel notches asked for, and the eased notches shown
  let scroll0 = 0, e0 = 0;       // at letting go: the scrolling unwinds with the zoom, both reaching none together
  let divisor = 1;

  return {
    get divisor() { return divisor; },
    get zooming() { return e > 0 || scroll !== 0; },
    // once a frame: is the key held, and wheel notches (+ toward the user, as
    // the hotbar's), only counted while held. Returns the FOV's divisor.
    update(dt, down, notches = 0) {
      if (down !== held) {
        held = down;
        t = held ? easeInTime(e) : easeOutTime(e);
        if (!held) { scroll0 = scroll; e0 = e; steps = 0; }
      }
      if (held) {
        // the wheel rolled away (up) zooms in, as in Minecraft
        steps = Math.min(Math.max(steps - notches, -ZOOM_STEPS_OUT), ZOOM_STEPS_IN);
        t = Math.min(1, t + dt / ZOOM_IN_S);
        e = easeIn(t);
        scroll += (steps - scroll) * (1 - Math.exp(-ZOOM_SCROLL_RATE * dt));
      } else {
        t = Math.max(0, t - dt / ZOOM_OUT_S);
        e = easeOut(t);
        scroll = e0 > 0 ? scroll0 * (e / e0) : 0;
      }
      // the view's share shrinks linearly from 1 to 1/4 as e goes in, then each notch is ×1.5
      const share = 1 + e * (1 / ZOOM_INITIAL - 1);
      divisor = Math.min(Math.max(ZOOM_STEP ** scroll / share, 1), ZOOM_MAX);
      return divisor;
    },
    // a fresh body, a death, popping out: no zoom at once
    reset() { held = false; t = e = steps = scroll = scroll0 = e0 = 0; divisor = 1; },
  };
}
