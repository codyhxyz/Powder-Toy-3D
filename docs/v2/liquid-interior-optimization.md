# Conservative liquid-interior traversal

Base: `a596d13d76ea60c601a59b6c26971e387ec75a7d` (fetched main included,
7 ahead / 0 behind). This is renderer work, not completion of physics v2.

## Implemented

The realistic view previously sampled the smooth fields at every submerged
cell's exit and closest approach, then tested all four surface channels, even
deep inside a solid body of water. The supplied water profile puts about 100 ms
in scene rendering versus about 0.9 ms in native liquid flux; bridge removal did
not measurably improve the frame. This change targets the submerged traversal,
not the bridge or physics.

`brickFrag` now certifies that every final surface-field texel in a brick has
liquid > 0.501 and every opaque channel < 0.499. It reuses the already-loaded
texel and an unused component of the existing max reduction. Bit 16 of the
existing render-only `BrickInfo.info` stores the certificate. No allocation,
binding, dispatch, compact payload, persistence format or physics change.

A flat realistic ray already inside liquid checks the certificate in the current
brick and its 26 neighbours, once on entering the brick. This covers the full
support of trilinear and cubic B-spline sampling at every point in the brick,
including its faces. Edge neighbours clamp as texture samples do. Both filters
and their thin/close blend are convex combinations, so no surface crossing is
possible. The 0.001 margin is conservative protection against filter rounding,
not an approximation of the surface. Neighbours are read live rather than
storing a dilated certificate that could go stale after a local field edit.

Only then does the ray omit surface sampling/crossing tests. It still visits
every cell with identical DDA arithmetic and loop budget, and retains all
absorption, spatial lighting, temperature, mixed-liquid ID selection, decoration,
thin-body colouring, grain events, mesh cuts, interfaces, normals, reflections,
refraction, foam and shadows. Skipped field values become stale; the next
uncertified segment resamples its real entry value. Curved presentation remains
on the original path. TAA, graphics settings, resolution and physics assertions
are unchanged.

This deliberately does **not** replace `compactA`'s stochastic fill projection
with a new continuous fill surface: that would change the rendered field and
require separate appearance/volume acceptance. The optimization bounds the
actual final fields, regardless of whether v1 or compact v2 produced them.

## CPU evidence

- `node tools/v2/liquid-interior-check.mjs --naga`: passes. 3,200 numerical
  trilinear/cubic/blend probes; 48 exact event-distance/channel ray replays with
  288 segments bypassing field sampling; field/brick boundary, grid clamp,
  dirty neighbour and threshold tests. Center-only certification is an explicit
  negative control: it would miss real liquid exits and opaque entries.
- The same command validates seven generated 128³ modules with Naga: brick,
  realistic off/balanced/full, flat and curved.
- `node tools/v2/compact-check.mjs`: passes.
- `node tools/v2/frame-bench.mjs --self-check`: passes.
- `npm run build`: passes (existing large-chunk warning).
- `node tools/check-browser-launch.mjs` and `git diff --check`: pass.
- `node tools/check-sampler-budget.mjs`: all 1,048 variants within budgets.
- `npm run check:imports` and `npm run check:async`: pass (existing pending
  async-read migrations in four unrelated tools remain reported).

An ideal unblurred 88×88×32 slab has 2,400 bricks passing the whole-neighbour
interior test (before erosion by blurred boundaries). This is eligibility, **not
GPU timing evidence**. Each eligible brick trades up to 26 scalar info reads
for its submerged cells' endpoint/midpoint field filtering and crossing loops.
Performance magnitude, compiler behavior and break-even remain unmeasured.

## Parent-owned GPU validation plan — not run

Do not use this checkout's `TPT_TEST_TIMEOUT_MS` alone to claim compliance: its
launcher starts that timer after launch and permits additional shutdown time.
No launcher was changed. Parent must first supply the independently enforced
<=10 s **total** setup/compile/test/cleanup budget, with the ordinary player/slot
guards intact. No silent retries. Stop on a budget failure; it is not a passing
sample. A cold full-app compile may not fit. GPU occupancy for this change so
far: zero.

Candidate short full-frame command (run baseline and candidate separately,
only when parent authorizes each bounded run):

```sh
node tools/v2/frame-bench.mjs --engine v2 --v2-path direct \
  --scene water --view realistic --warmup 2 --frames 4 \
  --port 19583 --out /tmp/v2-liquid-interior-candidate.json
```

Use the identical command on base `a596d13`, with a different output path and
private port. Expected sampled work is about 0.7 s at the historical ~110 ms
frame latency; setup/compilation/cleanup must fit the remaining budget or fail.
Do not compare these four samples directly to the old eight-warmup report.
Do not combine scenes, compatibility variants or split diagnostics into this
run. Keep the 128³ fixture, seed, camera, 1280×720 viewport, Quality upscale,
autoRes OFF, TAA, shadows, refraction and foam. Report raw full-frame samples and
scene interval separately, never sum overlapping GPU intervals. Four samples
are a smoke comparison, not statistically persuasive p95 evidence; repeat only
with explicit parent authorization, never automatically.

Separate bounded follow-ups (one checkpoint per launch, only after compilation
fits the budget):

1. Compare identical frozen frame/depth captures against the base with the same
   TAA jitter/history and clocks. Above-water and immersed views of the slab;
   then a boundary checkpoint with a one-cell air gap/opaque obstacle. No
   changed hit/depth is allowed; floating-point colour differences must be
   reported, not silently tolerated.
2. Check dirty incremental vs full fields/brick info after a paused edit in a
   neighbouring brick and after a window shift. Read field texels and assert
   every set certificate is justified; reject intentionally stale or
   center-only halo controls. Existing `tools/derived-check.mjs` is the extended
   regression suite, **not** a command claimed to fit this short budget.
3. Thin droplets/pours, mixed liquids, painted/hot liquid, foam, glass tank,
   near opaque mesh, and curved view: no appearance/depth change; most should
   stay on the ordinary path. They are quality controls, not cheaper substitute
   performance fixtures.

No measured full-frame speedup or GPU visual equivalence is claimed until those
parent-owned checks run. No push/deployment is part of this change.
