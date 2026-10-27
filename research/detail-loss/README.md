# Detail loss (2026-10-26)

The user: up close the picture is soft, far away big maps' ground is blobs; they play on Fast and want it
"faster AND nicer". Plan: sharper reconstruction (look/recon), distant ground at cell resolution
(look/far-ground), anisotropic material sampling and priced LOD numbers (look/aniso).

## Judges
- Look: NVIDIA FLIP against a reference shot, `tools/look-score.py TRUTH.png CANDIDATE.png`
  (pip install flip-evaluator numpy pillow). The reference: `tools/profile.mjs --truth --shot`
  (native, Detail Full, a big map's world march over the whole world: app.js ?truth=1).
- Speed: `tools/profile.mjs --upscale performance --size 1512x945 --dpr 2 --frozen`, A/B back to back,
  frame GPU busy and span medians (Metal's encoder times under-report the world march 2–3×).

## Baseline (origin/main 19118711, M5, 1512×945 @2×, frozen; GPU ~30% shared by something unregistered,
so every report is UNTRUSTED: read as indicative)
- Island default, Fast (page canvas 1512×945, scene ×1): GPU-bound, busy 16.8 ms of a 16.7 ms frame.
  Far view + its half-size pass: ~7 ms by timestamps, 0.6–1.2 ms by Metal.
- Lab default, Quality (Retina canvas 3024×1890, scene ×0.667): GPU span 25.1 ms.
- Post at the Retina canvas: ~2.5 ms (TAAU 1.6 ms Metal, canvas 0.2, bloom ~0.5); TAAU at the page
  canvas 0.4 ms. So TAAU straight to Retina would add ~2 ms: Fast keeps TAA at page size and the canvas
  pass upscales (FSR 1 EASU + RCAS).
- FLIP Fast vs Quality, Island default: 0.044 mean (p99 0.31).
