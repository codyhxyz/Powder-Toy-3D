# Finite native WORLD signs (not App activation)

BOX's probe, layout, poll interval, typography, placeholder formatting and DOM
styling remain the default. WORLD is an exclusive explicit owner, not a fallback.
No Simulation mirror, per-sign physical proxy, lighting summary, private submit,
readback ring, or admission callback service is created here.

## Native API

`volume.signsState` has synchronous `state` (`pending`/`ready`/`failed`),
`pipeline`, `error`, `ready`; `volume.signsReady` prewarms at facade creation.

`candidate.recordSignsReady(frameOrEncoder, options)` returns false without
opening a pass while pending/failed. Ready work validates and records one
compute pass and one workgroup synchronously, with `end()` in finally.
`candidate.recordSigns(...)` packs **all** caller arrays and captures output
identity before its first await. Both throw for released/stale/disposed candidates.
They never submit, flush, map, destroy caller output, or read it back.

Options:

```js
{
  camera: [globalX, globalY, globalZ], // displayed eye, matches pinned frame.cam
  anchors: [[x,y,z], ...],            // frozen GLOBAL face centers
  cells: [[x,y,z], ...],              // GLOBAL integer placeholder samples
  count: anchors.length,             // 0..64, exact matching arrays
  presentation: {k, anchor:[x,z], dir:[x,z]}, // same normalized production effect
  slot: 0,                           // nonnegative integer batch output slot
  output,                            // caller-owned STORAGE buffer
}
```

Anchor coordinates must be finite f32, within [-1, worldSize+1]; sample cells
are integer [-1, worldSize]. Camera coordinates must be finite f32 and match
candidate frame camera after f32 packing. Preparation retains its own camera
comparison values; later caller mutations cannot change this check.
Default effect is identity. The original
face endpoint cutoff (.02), grazing threshold (.03), raw opaque visibility,
mean-SIGMA glass/liquid attenuation, gas/fire transparency and placeholder math
are retained. Straight rays use the shared physical DDA; curved rays use the
production inverse quadratic trajectory, spans and cell-contained chords, not
straight physical sight lines. A bounded traversal failure is incomplete.
Brick reads require typed RAW/FIELD/AUX; missing data sets negative completeness
and whole-candidate feedback status. It cannot become accepted air/hidden UI.

Groups 0..2 are the candidate's pinned full reader. Group 3 retains the common
feedback/Sun/samplers and adds immutable uniform 0 plus output storage 6. Four
groups, 16 sampled textures, six storage buffers. Uniform size **2096 bytes**,
16-byte alignment, offsets: cam=0/count=12/slot=16/k=20/anchor=24/dir=32,
anchors=48, cells=1072. Both arrays have 64 vec4 records, stride 16. The bind
uses offset zero (no dynamic offset or shared mutable gpu.write buffer).

Output stride **32 bytes per sign**, **2048 bytes per slot** (64 records):
vec4(transmittance, element id, temperature °C, pressure), followed by
vec4(completeness,0,0,0). Completeness is +1 or -1, never valid at zero.
Storage output size must be integer/multiple of four, at least
`(slot+1)*2048`, within device/default binding limit, with STORAGE usage.
Binding is exactly `[0,(slot+1)*2048)`; minBindingSize=2048.

## Existing DOM consumer and parent App steps

1. Before creating a world cut, call `signs.setWorldOwner(true)`; this retires
   queued BOX results and never relocates/hides signs using physical membership.
2. `request = signs.worldRequest([nx,ny,nz])` returns a recursively frozen
   generation/token, ordered IDs/text/cells/normals/anchors/sample cells, bounds,
   `anchors`, `cells`, `count`. Floor/outside samples step once along the normal,
   exactly as BOX does. Physical origin is not read.
3. Capture camera matrices **after updating them**, and use the global model
   (`worldModelMatrix(localModel, capturedOrigin)`) used for these pixels:
   `frame = signs.captureWorldFrame({request,camera,model,publication:candidate.publication,identity,presentation})`.
   `identity` is the caller's stable exact scene-frame identity reference.
   The frame freezes a private camera/projection/model/viewport and exposes
   `frame.camera` (inverse-global-model displayed eye) and frozen presentation.
   Do not subtract the physics origin again. The native candidate's frame camera
   must be this same global eye. `worldFrameValues` does not translate camera.
4. Prewarm before encoding. Record with `{camera:frame.camera,
   anchors:request.anchors,cells:request.cells,count:request.count,
   presentation:frame.presentation,slot,output}` on the **same candidate** used
   for pixels. Parent owns readback/output/pins through the final submitted use
   and GPU completion, including rejected/failed candidates (as for native point).
5. Read all candidate feedback and signs after final submission. Slice the
   chosen output slot to exactly `request.count*8` floats. Require every
   completeness +1 **and** complete scene feedback **before Post admission**.
   A complete sign result does not override another scene reader's miss.
6. Only after Post's accepted pixels are confirmed, call:

```js
const signFrame = {
  frame, results, // Float32Array, exactly count*8; copied on acceptance
  publication: candidate.publication, identity: frame.identity,
  feedback: completeDecodedCandidateFeedback,
  completed: true, accepted: true,
};
signs.commitWorldFrame(signFrame); // false leaves prior accepted UI unchanged
```

The caller is the authority that these are native readback results and accepted
pixels; booleans are not a substitute for actual submission/feedback validation.
Matching publication and identity references are mandatory. Foreign frame,
wrong length/nonfinite/negative-completeness results, old generation, reordered,
added/deleted/moved/edited signs and nonmonotonic accepted frames are rejected.
Post-commit caller mutations do not change installed data. Ordinary camera or
physical-window movement does not invalidate a consistent older accepted cut.
Clear/rebuild/owner changes invalidate queued frames. DOM placement uses only
the accepted frozen camera, shared production warp and global model once.
Editing retains original text/placeholder behavior and is not window-hidden.
New signs remain hidden until their own accepted result, except while editing.
Closing the editor restores that requirement. Returning ownership to BOX forces
relocation, even if the physics origin has not moved.

The future wire contract is **only** `app.win.render.signsOwner === 'world'`
with `app.win.render.signFrame` containing that accepted envelope. Without an
accepted frame, it retains accepted UI or loading, and suppresses the BOX probe.
Otherwise the original BOX path runs. No code here activates a WORLD renderer
or supplies App's native recording/readback/Post driver.

`npm run check:world-signs`: actual native arithmetic/entry through the existing
WGSL CPU adapter (mocked reader leaves), actual typed page/request/brick helpers,
full emitted factory resource types and Naga, fake-native lifetime/packing gates,
actual Signs with in-memory DOM and Three matrices. CPU-only: not GPU execution,
font screenshots, driver validation, performance, or whole-App acceptance.
