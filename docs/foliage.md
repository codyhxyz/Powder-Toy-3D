# Clustered tree leaves

Status: implemented on `feat/clustered-foliage`, pending GPU approval and runtime checks.
No performance improvement is claimed. No game or GPU test ran during implementation.

The user later approved a comparison with a ten-second maximum.
The attempt stopped at the shared GPU lock because another process held it.
No browser launched, no GPU work ran, and no timing samples were collected.
The result is `/tmp/tpt-foliage-10s-result.json`. Runtime validation and deployment remain pending.

## Geometry and ownership

Each tree-leaf voxel owns a three-blade cluster.
The blades share a root and leave visible gaps.
Both sides are visible. The cluster stays inside its voxel.
World coordinates determine its rotation, so window shifts do not reseed it.

`src/foliage.js` defines the shared geometry.
The near renderer intersects this compiled template during its existing voxel traversal.
It does not create a mesh per tree or read the simulation back each frame.
It still spends GPU time on ray intersections. Caching does not remove that cost.

The distant chunk worker caches terrain separately from two leaf meshes.
The coarse mesh replaces three blades with one broader blade.
The depth and color passes use the same level.
The existing 96 MiB geometry limit includes both leaf levels.
Larger leaf meshes can exhaust this limit earlier than the old shells.

## State and changes

Tree generators mark crown cells with `ctype = E.PLANT`.
The element remains PLANT. Its fuel, temperature, and physics rules remain unchanged.
State `A.w` stores `ctype + seed`. State `A.z` remains life.
Ground plants, trunks, and rock do not receive the tag.

The smooth field excludes tagged leaves before convolution and thin-feature boosting.
Material gathering also excludes them. This prevents a hidden shell beneath the leaves.
Primary rays, shadows, reflections, and near-light rays use the same cluster triangles.

The near renderer reads current state, so removed or burned leaf cells stop contributing geometry.
Distant chunks use existing edit invalidation, revision checks, and complete buffer uploads before ownership changes.
CPU tests cover these paths. Live cutting and burning still need runtime checks.

## Limits

- Old saved trees without tags retain their previous shells. There is no automatic save migration.
- Unmeshed, very distant terrain retains the coarse field, including its crown approximation.
- The change does not add species-specific leaves, branches, or wind animation.
- Physics and picking still use occupied voxels, not individual blades.
- Visual quality, GPU compilation, frame times, and runtime memory remain unmeasured.

## CPU checks

```sh
node tools/foliage-node-check.mjs
node tools/foliage-far-node-check.mjs
node tools/foliage-scenes-node-check.mjs
node tools/foliage-render-node-check.mjs --wgsl
node tools/detail-worker-check.mjs
node tools/surface-mesh-check.mjs
npm run build
```

`--wgsl` requires the Naga CLI. It validates shader source on the CPU, not GPU pipelines.
The checks include baseline tree fingerprints, source precedence, removal, seams, cache accounting, and leaf/grain event ordering.
An independent review found no remaining verified blocker after the event-ordering correction.

## Approval boundary

Ask the user before the in-game GPU before/after comparison.
Use the same scene, camera, resolution, and quality on both builds.
Include leaf gaps, near/far transitions, cutting, burning, shadows, and water.
Measure frame times and memory rather than assuming a speed improvement.
Do not deploy this renderer change before runtime validation.
