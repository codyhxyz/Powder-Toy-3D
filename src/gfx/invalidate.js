// Full-target passes on a tile-based GPU (Apple's, through ANGLE Metal). With
// renderer.autoClear off, a render pass starts by loading its whole target
// from memory into tile memory, even when the pass then overwrites every texel.
// Invalidating the target first tells the driver its old contents are dead, so
// the pass can skip that load (docs/scaling.md D4).
//
// Only for a pass that writes every texel of its target: a full-screen draw
// that doesn't blend or discard. A pass that blends into its target or covers
// part of it would read undefined texels.

const attachmentLists = [];   // per colour-attachment count, built on first use

// Call right after renderer.setRenderTarget(target), before drawing.
// target: a render target (the canvas is left alone: the browser already
// drops its contents between frames).
export function invalidateTarget(renderer, target) {
  const gl = renderer.getContext();
  const n = target.textures.length;
  const list = (attachmentLists[n] ??= Array.from({ length: n }, (_, i) => gl.COLOR_ATTACHMENT0 + i));
  gl.invalidateFramebuffer(gl.DRAW_FRAMEBUFFER, list);
}
