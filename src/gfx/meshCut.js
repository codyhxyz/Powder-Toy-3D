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
    if (!r.properties.get(copy).__webglFramebuffer) r.initRenderTarget(copy);
    const src = r.properties.get(rt).__webglFramebuffer;
    const dst = r.properties.get(copy).__webglFramebuffer;
    if (!src || !dst) return;
    if (works === null) gl.getError();   // (clear anything earlier)
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);   // the blit obeys the scissor test
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    // (through three.js's state, so its cache of bindings stays true)
    r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    r.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    r.state.bindFramebuffer(gl.FRAMEBUFFER, src);   // back to the scene target, for the volume's draw
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    if (works === null && !(works = gl.getError() === gl.NO_ERROR)) { console.warn('meshCut: depth copy failed; bodies in water stay hidden'); return; }
    uniforms.uMeshInv.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld).invert();
    uniforms.uMeshRes.value.set(w, h);
    uniforms.uMeshCut.value = true;
    material.uniformsNeedUpdate = true;   // (they upload after this hook, in the same draw)
  }

  return { uniforms, hook, dispose() { copy.dispose(); depth.dispose(); } };
}
