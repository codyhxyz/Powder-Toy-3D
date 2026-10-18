# Compact persistence and state ownership

CPU-checked implementation; GPU/app acceptance remains pending. This does not complete physics v2 or multiplayer.

## Save owner and APIs

`wire/saves.js` registers the strict optional `physicsV2` section. The existing container stays version 1 and still includes legacy `cells` for old readers. Old saves without the section intentionally replace the compact state from legacy cells.

`src/v2/state.js` owns the section format: a magic/version/metadata-length prefix, bounded UTF-8 JSON metadata, then little-endian raw u32 arrays in fixed brick4 slot order. Version 1 stores cells, activity and indirect args; optional `hasAux` appends one opaque u32 per cell. Missing aux decodes to zeros. Dimensions, versions, descriptors, array lengths, truncation and malformed metadata are rejected before app preparation. Unknown container sections remain skippable; an unrecognized type for this known strict section is rejected.

- `PhysicsV2.captureState(mode)` records all copies before its first await and returns the encoded section. It includes tick, accumulator, legacy frame/paint counters, idle state and requested mode.
- `PhysicsV2.restoreState(bytes, { legacyCurrent = false })` restores exact raw words and continuation state. The section loader selects/builds v2 first. `legacyCurrent: true` keeps the saved v1 A/B, including velocity, when restoring a suspended owner; otherwise legacy projection dirtiness is rebuilt lazily.
- `PhysicsV2.restore(compactBuffer, auxBuffer = null)` is the exact-word undo path. Missing aux snapshots clear current aux. Undo still rebuilds activity rather than restoring its previous clock/activity certificate.

Only the compact engine's continuation is covered; app actors, particle random streams and legacy physics continuation are not claimed deterministic. Legacy A/B save behavior is unchanged.

## Runtime ownership

`sim.compact` is the currently presented engine; `sim.compactOwner` retains compact state during temporary v1 execution. `setPhysics('v1')` suspends rather than destroys it. A no-op switch neither projects back nor counts as a whole replacement.

`marksLayout(g).owned` appends a sticky atomic bit per cell (0.125 bytes/cell). `header.capture` enables tracking when a compact owner exists. Common `writeState`/`writeStateS` claim coordinates whose A/B changes; `writeCell` also claims explicit no-op edit calls, so erasing projected air cannot resurrect hidden fractional liquid. Generic edit kernels may claim the whole edit box, including cells excluded by a brush's internal shape/filter. Outside that box, unchanged compact words are preserved. Changed cells intentionally take legacy whole-cell semantics on re-import; v1 cannot represent partial fill or compact flux.

The bitset is outside ping-pong flags and activity: a write followed by a reversal, or consumed activity marks, cannot erase ownership history. V2 import consumes those bits, not an equality comparison with the lossy projection. Whole-grid load/undo still takes full ownership. Import/bridge commands set `capture: 0` to avoid claiming their own compatibility writes. No physics rule algorithms or renderer shaders are changed.

## Parent integration hooks

The approved foundation owns `PhysicsV2.aux`: a zero-initialized GPUBuffer of exactly `g.slots * 4` bytes in the same slot order, with STORAGE, COPY_SRC and COPY_DST usages. Constructor, disposal, binding and rule packing remain foundation-owned. Capture, save/load and Simulation snapshot/copy/retirement already consume this property. Before foundation merge an absent aux buffer is supported for old/default-zero state; restoring nonzero aux without its owner throws rather than silently dropping data.

When integrating auxiliary rules, clear/reinitialize aux in the existing v2 import branch for **every** legacy-owned/full-replacement cell, even when its converted compact words compare equal. Preserve aux for unowned cells. That branch is the actual cell-ownership seam; do not put opaque aux in the legacy projection. Dispose the allocated aux with the foundation's other buffers.

The approved transient scratch is 16 bytes/cell and is **never saved or snapshotted**. With the foundation, authoritative core+aux is 20 bytes/cell; core+aux+scratch is 36 bytes/cell, plus 0.125 bytes/cell ownership and existing activity/legacy allocations.

## CPU evidence

- `node tools/v2/saves-check.mjs`: raw fractional/compressed fill, flux, seed, temperature, age, arbitrary nonzero aux, zero fallback, clocks, real section registration/container, suspended mode, old saves and corrupt inputs.
- `node tools/v2/compact-check.mjs`: dispatch boundaries, exact core/aux snapshot and restore, absent aux, no-op switches, sticky-ownership protocol and next-tick offset/parity after restore. GPU commands are spies, not emulated physics.
- `node tools/saves-check.mjs`: existing container/atlas compatibility.
- `node tools/v2/compact-wgsl-check.mjs`: CPU Naga validation, not WebGPU execution.

## App acceptance plan (parent-owned, not run here)

Use the revised launcher, manual/parked mode and the user's **10-second total setup/compile/cleanup budget**. Do not run if that cannot be enforced. Batch the following assertions in one already prepared numerical fixture and close in `finally`; no screenshots are required.

1. Prepare a box with known raw words: invisible fractional liquid, compressed liquid, nonzero face flux, age/seed/temperature and nonzero aux. Record all core/aux words, tick/accumulator and activity. Save through `saveGame`, retrieve its bytes from the normal local-save store, mutate, then `openSave`.
2. Verify exact words and clocks before stepping. Run a fixed number of ticks from the saved state twice and compare core/aux results and clock; compare physical activity excluding legacy projection-cache dirtiness.
3. Switch v2 → v1 → v2 without stepping: all compact/aux words must remain identical. Repeat save/load while switched to v1; verify requested mode remains v1 and saved legacy velocities survive.
4. During v1, edit a bounded region and step a fixture with isolated moving matter. Verify unchanged coordinates retain compact fractions/flux; actually written coordinates take current legacy matter, including cells changed away and back. Consume the legacy activity map before reactivation to exercise sticky ownership.
5. Erase a projected-air liquid cell, both while v2 is active and while suspended. Verify no hidden matter returns. Check outside the edit box bit-exactly. Repeat undo with arbitrary nonzero aux and an older aux-less snapshot (zero fallback).
6. Load an old save and verify no retained compact/aux matter survives. Attempt malformed compact sections and verify the scene is untouched.

## Network seam — explicitly incomplete

`src/net/codec.js:createPacker` still emits the existing quantized four-byte render stream. Compact `bindRO` decoding does not make that stream lossless. `createUnpacker` writes legacy A/B and calls `noteWrite()`, intentionally taking whole-grid ownership. No protocol change or multiplayer test is included. A follow-up must negotiate a new frame/version carrying native core/aux plus continuation metadata (or a separately specified render-only compact schema), teach unpacking to restore its actual owner, and test peers/deltas/reconnect compatibility. The local `physicsV2` section is not silently substituted for the existing wire protocol.
