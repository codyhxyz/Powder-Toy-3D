# Native WORLD opaque hand-off

`createWorldOpaqueCapture(gpu)` packs the actual opaque scene target after
Three draws and before the world volume writes that target. Await `ready`.
Call `recordReady(gpu.frame,{color,depth,output,drew,submitted})` synchronously.
It returns false without encoding while the pipeline is unavailable.
The async `record` wrapper captures all arguments before awaiting compilation.

Use `post.sceneTarget.color`, `.depth` and lazy `.packedOpaque` inside the
staged scene's opaque/capture hooks. The output is RGBA32Uint:

* x: original linear HDR red/green packed as two binary16 values;
* y: original blue/alpha packed the same way;
* z: the exact depth32float bit word;
* w: bit zero is set when opaque depth is less than the cleared depth, one.

There is no tone mapping, RGB clipping, origin conversion or proxy geometry.
When no opaque meshes drew, pass `drew:false`. The pass writes empty coverage,
zero color and depth one without reading the uncleared scene inputs.

The recorder uses two sampled textures, one storage image and one group.
It records into the normal Frame and never submits or reads back. Pass the
scene's final-submission promise before recording. Both settlement paths fence
queue completion before recorder resources can retire. If a graphics suffix
remains recordable, its provider must keep that promise unsettled.

Post owns the output in its existing bounded scene-target pool. Allocation is
lazy: BOX allocates nothing. The staged target stays leased through every
scene/final consumer and queue completion, including discard. Resize or target
disposal then destroys the old packed output. Do not retain a scene candidate's
borrowed packed texture after its target lease completes. Independent later
queries need their own live bindings, not an expired scene target.

App routing is not implemented by this helper. The caller must draw actual
opaque geometry, capture it, then draw the volume and native transparent meshes.
The final scene admission must also validate all world feedback.

CPU tests cover native packing arithmetic, Naga layout, recording, async input
capture and rejected-prefix lifetime. The CPU interpreter preserves integer
vector components instead of converting packed words through floating point.
These checks are not GPU, visual or performance evidence.
