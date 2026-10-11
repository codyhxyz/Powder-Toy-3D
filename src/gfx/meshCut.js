import * as THREE from 'three';

// Meshes inside the volume (the player's body, NPCs, props) are opaque and
// draw before it; the volume then marches each ray from its first surface on.
// A body standing in water sat behind the water's surface, so the march went
// on through it and painted the whole water column over the body. Right before
// the volume draws, its hook copies the depth the opaque pass left, and the
// march stops there (meshCutT): the water in front tints the body, as water
// over a swimmer does, instead of hiding it.
//
// Only a float depth texture copies (the scene target of gfx/post.js); any
// other target (stills, a renderbuffer depth) draws without the cut.
//
// tMeshDepth takes the texture unit the view freed by reading its bricks'
// empty-space distance from tLight (gfx/core.js BRICK_DIST_IN_LIGHT): with
// whitewater on the view uses all 16 a GPU is sure to have, and one more
// fails to link and blacks the screen (tools/check-sampler-budget.mjs).

// GLSL: meshCutT(rd) = distance along the eye ray (grid cells, from uCam)
// to the nearest opaque mesh at this pixel, MESH_CUT_NONE if none.
export const meshCutGLSL = /* glsl */ `
uniform bool uMeshCut;
uniform sampler2D tMeshDepth;
uniform mat4 uMeshInv;    // clip → grid: inverse(projection · view · model)
uniform vec2 uMeshRes;
#define MESH_CUT_NONE 1e30
float meshCutT(vec3 rd) {
  if (!uMeshCut) return MESH_CUT_NONE;
  float d = texelFetch(tMeshDepth, ivec2(gl_FragCoord.xy), 0).r;
  if (d >= 1.0) return MESH_CUT_NONE;
  vec4 p = uMeshInv * vec4(gl_FragCoord.xy / uMeshRes * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return dot(p.xyz / p.w - uCam, rd);
}
`;

export function createMeshCut(renderer) {
  const depth = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const copy = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, depthTexture: depth, type: THREE.UnsignedByteType });
  const uniforms = {
    uMeshCut: { value: false },
    tMeshDepth: { value: depth },
    uMeshInv: { value: new THREE.Matrix4() },
    uMeshRes: { value: new THREE.Vector2(1, 1) },
  };
  const gl = renderer.getContext();
  let works = null;   // the first blit is checked: a failed one would leave depth 0, cutting every ray at the eye

  /** Hook for the volume mesh: `volume.onBeforeRender = cut.hook`. */
  function hook(r, scene, camera, geometry, material) {
    const rt = r.getRenderTarget();
    uniforms.uMeshCut.value = false;
    if (works === false || !rt?.depthTexture || rt.depthTexture.type !== THREE.FloatType || rt.samples > 0 || rt.isWebGL3DRenderTarget || rt.isWebGLCubeRenderTarget) return;
    const w = rt.width, h = rt.height;
    if (copy.width !== w || copy.height !== h) copy.setSize(w, h);
    r.initRenderTarget(copy);   // (once)
    if (works === null) gl.getError();   // (clear anything earlier)
    // three.js copies a depth texture with a blit, which obeys the scissor
    // test and leaves no framebuffer bound: the volume draws into rt after it
    const scissor = r.getScissorTest();
    if (scissor) r.setScissorTest(false);
    r.copyTextureToTexture(rt.depthTexture, depth);
    r.setRenderTarget(rt, r.getActiveCubeFace(), r.getActiveMipmapLevel());
    if (scissor) r.setScissorTest(true);
    if (works === null && !(works = gl.getError() === gl.NO_ERROR)) { console.warn('meshCut: depth copy failed; bodies in water stay hidden'); return; }
    uniforms.uMeshInv.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld).invert();
    uniforms.uMeshRes.value.set(w, h);
    uniforms.uMeshCut.value = true;
    material.uniformsNeedUpdate = true;   // (they upload after this hook, in the same draw)
  }

  return { uniforms, hook, dispose() { copy.dispose(); depth.dispose(); } };
}
