# Resolution and TAA: Grimorium vs ours

Transcript: `text/Y8HRCXxI0BY.txt`. Code paths are in the worktree at base ff1d35e6. CPU reading only; nothing was run.

## 1. What Grimorium does (quoted)

- "The game renders at 1/3 of window resolution, which means tracing 1 ninth as many rays. This can be adjusted in the settings, but for my laptop RTX 4060 that I run this on, that's the highest resolution before it starts impacting performance." [00:07:37]
- "Each frame, the camera is jittered by a fraction of a pixel in a repeating pattern." [00:07:37]
- "its temporal anti-aliasing pass blends the new frame with an accumulated history buffer, allowing a sort of averaging across time. This helps to eliminate artifacts that would occur from having a repeating voxel pattern up against the screen pixel pattern." [00:08:13]
- "dithering to hide color branding [banding] along with the typical levers like contrast and brightness that can be adjusted in the settings." [00:08:13]
- Sun shadows: "Some jittering is applied to the shadow rays for directional lights ... and this gets blended over multiple frames to give the slightly softer shadows." [00:06:24]

So one fixed 1/3-per-axis scale (user-adjustable, no mention of automatic steering), a repeating jitter, one TAA history. They never say the pattern's length, the history clamp, the blend weight, or any sharpening.

## 2. What we do

- **Presets** (`src/gfx/post.js:200`): per axis, of the device's real pixels: native 1, quality 1/1.5, balanced 1/1.7, performance (menu "Fast") 1/2. The default setting is `upscale: 'quality'` (`src/app.js:161`).
- **Default in pixels**: Quality = 0.667 per axis = 44% of the screen's pixels. On a Retina Mac the canvas is the device's pixels (up to 2x, `src/app.js:376-377`), so that is 0.667 x 2 = 1.33 traced pixels per CSS pixel per axis.
- **Floor** (`src/gfx/post.js:213`): `UPSCALE_FLOOR = 1/3` per axis = **1/9 of the pixels**, the same as Grimorium's fixed scale. `AUTO_RES.MIN = 0.5` of the preset (`src/gfx/autoResolution.js:49`): Quality's 1/1.5 x 0.5 = 1/3. The floor applies at every upscaling preset (`src/app.js:2904`, `src/gfx/post.js:1409`). At Off (native) it never lowers.
  - Correction to KNOWLEDGE.md row 12, which says the floor is "1/3 of the pixels": it is 1/3 per axis, 1/9 of the pixels. Same number as theirs; but ours is measured against device pixels, theirs against "window resolution", which may be CSS pixels. Unknown.
- **Steering** (`src/gfx/autoResolution.js:21-60`): GPU busy time per frame, 12 ms target (28% headroom under 16.7), steps down at once when the median of 8 frames is over, steps up after 1 s of headroom, 8 fixed levels equal in pixels (about 16% fewer pixels per level). Falls back to wall-clock trials without timestamps. Output and history stay full size while the scene size changes (`src/gfx/post.js:1443-1444`).
- **Fast on Retina** (commit 3ef92d9a): post and TAAU work at the page's CSS size, scene at 1/2 of device pixels, and the canvas pass lifts the result to the Retina canvas with FSR 1 EASU + RCAS (`src/gfx/post.js:843-924`, `src/app.js:2902`). Reason given: TAAU at Retina size costs about 1.2 ms more (`src/app.js:366-368`).
- **Jitter**: three's TAAU Halton(2,3), 32 offsets, as a camera view offset (`src/gfx/post.js:1530`, `src/gpu/three.js:282`). Our motion pass writes velocity from the unjittered cameras (`src/gfx/post.js:398-444`).
- **History** (`src/gpu/three.js`, PingPongTAAUNode ~340-470): two history targets that take turns (no copy); FSR 2 Lanczos-2 kernel scaled by the upsample ratio (`:393-415`); history read with 5-tap Catmull-Rom, clamped to its taps; variance clip and thin-feature lock from three's node; shorter history while moving (`TAAU_MOTION`, `:411`); full drop on a jump or turn (`src/gfx/post.js:214-219`, `:2132`), velocity forced off-screen when history is invalid (`:274`). Highlights are compressed before the resolve so one bright sample can't blip (`:346-354`).
- **Sharpening**: RCAS, strength 0.5 at native, rising 0.3 per pixel of ratio, max 0.9 (`src/gfx/post.js:138`, `:205-207`, `:988-1001`).
- **Dither**: interleaved gradient noise, plus or minus half an 8-bit step, skipped on exact black (`src/gfx/post.js:933-936`, `:1028-1030`).
- **Settle**: blend weight 0.025 per frame would take 219 frames to converge; the app draws only 8 settle frames after the view stops (`src/gfx/pacing.js:71-80`).
- **Other things that lean on the TAA history**: the shading's random samples are built to average inside TAAU's 3x3 window (spatiotemporal blue noise, `src/shaders/gfx/lighting.js:708-710`; lamp soft shadows `:1068`); an earlier glow shadow ray was dropped because it flickered under TAA (`:902`). Sun shadows are shadow maps with PCSS, not jittered rays. The light probes keep their own history buffer (`src/gfx/worldLight.js:79`), separate from TAA and not in screen space.

## 3. Side by side

**Same**: jittered camera, one history buffer, dither before output, the voxel-grid-against-pixel-grid reason for TAA (we use it for the same shimmer), and the 1/9 pixel count at the extreme.

**Different**: they run 1/9 always (as far as the video says). We start at 44% of pixels and drop toward 1/9 only when the GPU needs it. Their jitter is "a repeating pattern" of unknown length; ours is 32. They jitter shadow rays and blend over frames; we use shadow maps, so no per-pixel shadow noise needs the history.

**Ahead (ours)**: automatic steering with a headroom target; velocity reprojection and history rejection; FSR 2 kernel and Catmull-Rom history; RCAS sharpening that grows as the ratio does; settle cap so the GPU rests; Retina EASU path. The video mentions none of these.

**Maybe ahead (theirs)**: tracing 1/9 as the default costs them nothing in decisions, and they say it is what a 4060 holds. If the 1/9 floor looks acceptable to players, it says our floor is not too low. We can't tell how their picture looks at that scale from audio alone.

## 4. Worth trying

Nothing recommended from this video. They are at our floor already; we do more with the same idea. The user cares about close-up detail, and the 2026-10-26 work went the opposite way (sharper, more pixels on Retina), so lowering the default scale is not supported.

One thing worth checking, low priority, CPU only: whether an Intel-style user whose steering rests at the floor looks acceptable. A test would need only the existing profiler's `renderScale` and a screenshot at 1/3 per axis, which is the already-existing floor; no new work follows from the video.

## 5. What the video can't tell us

- Whether "1/3 of window resolution" means CSS or device pixels, so whether their 1/9 equals our 1/9 on a Retina screen.
- The jitter pattern length, history blend weight, rejection or clamp, and whether they sharpen after upscaling.
- Whether the shadow-ray blend uses the same history or a separate one.
- Their frame time at that scale, or how their image looks in motion.
