# Resident water momentum: energy-head advection on the existing face fluxes

CPU design note, 2026-10-16. Production physics, packed state and native velocity capability are unchanged.
Witness: `node tools/v2/water-momentum-check.mjs` (CPU prototype only, ~36 s).

## What is actually missing

The pipe model already stores a velocity. Each face flux `q` is a staggered (MAC) velocity, `q/FULL` cells a
substep through a full face, which is Mei, Decaudin and Hu 2007's `u = flux / (depth · width)`. What the
model lacks is the **advection term** of the momentum equation. Without it, nothing limits an outlet face
except damping and the K limiter. On the CPU prototype's original hole, the 1-cell hole discharges
**3.3–4.5×** Torricelli's ideal `A·√(2gh)`. The tank drains about four times too fast and the stream is
several cells thick. That over-drain depresses the pressure behind the hole, so R14's static-head launch
reads 0.81–0.91 √(2gh) at birth from 1.5 s. That is the 12.78 % (CPU) and 13.66 % (GPU) shortfall. Launching at the
face velocity without advection overshoots instead: 51 %.

## The model

Stelling and Duinmeijer 2003 (Int. J. Numer. Meth. Fluids 43:1329) use a Bernoulli (energy-head) form of
advection in flow contractions and a momentum form in expansions. Zijlema 2019 (Computers & Fluids
192:104274, the scheme in SWASH) notes that the momentum form "can not be applied in regions of
contraction with flow acceleration". An orifice is exactly that case. Per axis `a`, the model uses:

- **Cell velocity.** `û_a` is the upwind face: the −face's flux when the cell's mean flux on `a` is positive, the
  +face's when it is negative (Zijlema 2019 eq. 24). It is computed from the substep's frozen fluxes.
- **Face drive.** The drive gains the velocity-head difference, `(û_a(i)² − û_a(j)²) / (2·ACC·FULL)` cells of head,
  so `q += (q_up² − q²)/(2·FULL)` before the existing dead band and damping. No coefficient is added. A
  resting state has all faces at zero, so its term is zero and it is a bit-exact fixed point.
- **Per axis only.** This follows their 1-D form. Using `½|u|²` across axes drops the vortex force: a fast floor
  film then throws itself upward, and the run diverges in 83 ticks.
- **Momentum and kinetic energy.** Momentum is the existing face flux. Kinetic energy is `½ m |û|²`, the same
  kinetic head the update uses: not an RMS or mean vector. This gives SPLASH a defined observable.
- **Launch.** A jet packet takes its outlet face's own velocity, which is the existing `jetDischargeSpeed`.
  Grid-to-particle momentum is therefore exact, and the R14 neighbour head scan (`jetStaticHead`) is deleted.

## CPU evidence (prototype, unchanged thresholds)

| | pipe model | + energy head |
|---|---|---|
| hole discharge / A√(2gh), from 2 s | 3.7–4.5 | 0.89–0.92 (≤ 1, Torricelli's bound) |
| launch at birth / √(2gh), from 2 s | 0.84–0.89 (R14) | 0.89–0.92 (face) |
| hole worst reach (limit 5 %) | 12.78 % | 11.86 % face launch; 8.25 % total-head launch |
| U-tube arms (≤ 1 cm) | 0.99 cm | 0.54 cm, rests 4.8 s |
| still tank / partial pool / puddle / pipe / census | pass | pass; bit-exact at rest |

## Still open (why the 5 % gate still fails)

1. **Linear drag.** Water's `damp = 0.01`/substep (today's drag row, as in lean-sim) costs `q·damp/ACC` ≈ 1
   cell of head per fast face, so the face launch reaches 0.90 √(2gh). A diagnostic at the row floor 0.005
   (`DAMP=0.005 … --hole`) gives 0.89–0.98 and 6.1–8.2 %. This is a material calibration for the user to
   decide, not a tolerance change.
2. **Start-up ringing.** The fixture starts uncompressed, and the weakly compressible column (COMP) then rings
   at ±10–15 % in jet speed, with a period of about 0.65 s, through the 1.5 s window. A launch from the upwind
   *total* head (R14 plus `½|û|²/g`) reaches 0.99–1.03 √(2gh) from 2 s (1.44 % and 0.21 %) but 8.25 % at
   1.5 s, and its packets are faster than the resident water.
3. **SPLASH.** It is now expressible, but on the CPU its contact fires after 2 ticks in both models. Explicit
   transport carries a 0.2 % sliver down one cell each substep, so the measured incoming energy is wrong.
4. **Expansions.** This model uses the energy-head form everywhere. Stelling and Duinmeijer switch to the
   momentum form in expansions, so that jumps and impacts take the Borda–Carnot loss. SPLASH impacts are
   expansions, so that switch is needed before SPLASH acceptance.
5. **Partial cells.** Partial cells use the superficial velocity; the wetted-area velocity `q/f` is unresolved.

## Native cost and what the port needs

- **Bytes.** Persistent: 0. The 48 face bits already carry the momentum. Transient: three f16 `Δ_a` per cell,
  one for each owned +face, padded as `vec2u` to 8 B/cell (16 MiB at 128³), against the proposed 64 MiB.
  jetMask has only 12 spare bits.
- **Passes.** No new pass. Limit already loads the −neighbours' faces. It adds one +neighbour face load per
  axis, computes `Δ_a` from the frozen faces and stores it. Flux reads only its own `Δ` and adds it to
  `drive`. Flux cannot compute `Δ` itself, because it would read neighbour faces that are being rewritten.
- **Freshness.** `Δ` must come from the faces that Flux updates. The substep order should therefore become
  Limit → jets → Gather → Flux (the `_tick` owner's call), so that edits between ticks never leave `Δ` stale.
- **Jets.** `jetLaunchSpeed` → `jetDischargeSpeed`, and `jetStaticHead` / `jetHeadOf` go.
