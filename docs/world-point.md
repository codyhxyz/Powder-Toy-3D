# Native WORLD point reader

This finite endpoint is **not** hands/App integration or renderer completion.
`shaders/worldPoint.js` assembles the existing full WORLD common reader plus
production `shadowOpticsWGSL`. There is no Simulation, texture mirror, local
hemisphere/proxy, generic callback service, readback or queue submission.

## Recording

- `volume.pointState`: synchronous `pending` / `failed` / `ready`, `error`,
  `pipeline`, and `ready` promise. Compilation starts when the facade is created.
- Await `volume.pointReady` before recording native work.
- `candidate.recordPointReady(frame, {position, output})` records one native
  compute pass/one workgroup synchronously. `frame` can be a native encoder or
  the existing frame object with `direct()`. Pending/failed returns `false`
  without touching the encoder. Stale/released/disposed candidates throw.
- Optional `candidate.recordPoint(...)` clones and packs position and captures
  output identity **before** awaiting readiness. It does not submit work.
- Position is exactly three finite f32-representable **global cell coordinates**,
  independent of `physicsOrigin`. It uses common `probeAt` trilinear GI sampling
  (edge-center clamping is the common reader's behavior, not an outside-world
  lighting substitute). It does not add a surface-normal offset.
- Output is a caller-owned STORAGE buffer, at least 80 bytes, four-byte-sized,
  within the storage binding limit. The endpoint binds exactly bytes `[0,80)`
  with aligned offset zero. It creates immutable candidate-owned params only;
  it never destroys, maps or reads the caller's output.

Groups 0..2 are the same pinned common groups used by this candidate's draw and
pick. Dedicated group 3 uses position params at binding 0, the **same typed
feedback** at 1, existing samplers at 2..3, pinned Sun params/Book at 4..5 and
output at 6. The layout remains four groups, 16 sampled textures and six storage
buffers. No new lighting publication or producer is introduced.

## Output and acceptance

Five consecutive vec4f (80 bytes):

| Byte offset | Contents |
| --- | --- |
| 0 | GI c0 rgba |
| 16 | GI cx rgba |
| 32 | GI cy rgba |
| 48 | GI cz rgba |
| 64 | colored optical Sun transmission rgb, completeness w |

All **16** SH floats are returned unchanged, including the alpha sky-visibility
coefficients. This is not a normal-evaluated irradiance, sky replacement, or
premultiplied color. `sunShadowAt(position)` evaluates the production colored
optical Sun with cloud shadow **once**; the consumer must not multiply cloud
shadow again. As elsewhere, any configured common-reader caustic behavior stays
in that shared Sun reader. Sun is visibility/transmission, not multiplied by
`FU.sunCol` or a normal's cosine.

Completeness w is exactly `+1` on a complete query, `-1` on any missing/invalid
GI or optical dependency. The shared `worldBeginQuery` / `worldSunValidate` /
`worldEndQuery` protocol emits typed channel requests and whole-candidate
status. Partial/zero placeholder coefficients are **never accepted** merely
because the compute pass recorded or the buffer contains numbers. Untouched
zero output (no dispatch) has w=0 and is not valid either.

Associate output with `candidate.publication`: the frozen atlas ABI, epoch,
generation, dependency set and exact pinned Sun manifest (including its epoch,
basis revision, publication revision and dependency identity). This identity is
CPU-side metadata, not squeezed into the 80-byte lighting payload; it must travel
with the eventual readback/consumer result, never be reconstructed from the live
atlas. `candidate.snapshot` remains available for resource identity inspection.
Use separate outputs for overlapping consumers or otherwise serialize their uses;
this endpoint does not manage an output ring.

The future App/scene owner owns **all** of:

1. Prewarm before encoding; record native point work with the intended candidate.
2. Submit final work and read back point output and **entire** candidate feedback.
3. Accept only the intended publication, w=+1 and a complete candidate feedback
   result. A miss anywhere in the shared scene candidate withholds the whole
   candidate even if this point alone reports complete.
4. Keep candidate resources, output, lighting/appearance/mesh/noise publications
   and queue pins alive through the **last submitted use and GPU completion**,
   including rejected/failed admissions. Only then call `candidate.release()`
   and recycle caller-owned output. Do not use an earlier submit's completion
   fence as evidence for a later use.

`npm run check:world-volume-consumers` is CPU/fake-native + Naga evidence only:
actual full-reader emitted factory variants/resource layouts; actual production
entry output/feedback execution with mocked lighting leaves; pre-await mutation,
pass/resource identity and lifetime checks. It is not GPU execution, a visual or
performance check, whole-App acceptance or a readback implementation.
