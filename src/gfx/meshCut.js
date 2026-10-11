import { STAGE } from '../gpu/kernels.js';

// Meshes inside the volume (the player's body, NPCs, props) are opaque and
// draw before it; the volume then marches each ray from its first surface on.
// A body standing in water sat behind the water's surface, so the march went
// on through it and painted the whole water column over the body. The march
// now stops at the depth the opaque meshes left (meshCutT): the water in front
// tints the body, as water over a swimmer does, instead of hiding it.
//
// WebGPU order (docs/webgpu.md Sync log S1): three.js renders the opaque meshes
// into the scene target first (post.render's `opaque` hook); capture() then
// copies the depth they left into a texture of ours, and the scene pass loads
// the target and binds that copy (a texture_depth_2d at group 0 binding 2 of
// the volume, beside the tables and FrameUniforms). The copy is needed because
// the scene pass writes the target's depth (frag_depth, TAA's motion signal)
// while the volume reads the meshes': one texture can't be both in one pass.
// A frame whose meshes drew nothing (every box-mode frame) captures nothing,
// and the volume marches without the cut.
//
// The cut's values travel in the volume's params (shaders/render.js
// VolumeParams holds MESH_CUT_FIELDS): meshCut (0: no cut this frame), meshInv
// (clip → grid: inverse(viewProj · model) of the volume's own jittered
// matrices) and meshRes (the target's size in pixels).

// WGSL fields of the volume's params struct
export const MESH_CUT_FIELDS = { meshInv: 'mat4x4f', meshRes: 'vec2f', meshCut: 'u32' };

// The volume's group 0 binding 2: the meshes' depth (copied, read with textureLoad)
export const MESH_DEPTH_BINDING = 2;
export const MESH_DEPTH_ENTRY = { binding: MESH_DEPTH_BINDING, visibility: STAGE.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d' } };

// WGSL (after the render library, core.js's meshCutAt and MESH_CUT_NONE, and
// the volume's params P):
//   meshCutT(rd)     distance along the unit eye ray rd (grid cells, from
//                    FU.cam) to the nearest opaque mesh at this pixel
//                    (gFragCoord), MESH_CUT_NONE if none
//   meshCutDepth(d)  the nearer of clip depth d and the mesh's at this pixel:
//                    the volume's frag_depth, so a hit behind the cut (a bent
//                    ray's) never draws behind the mesh it stopped at
export const meshCutGLSL = /* wgsl */ `
@group(0) @binding(${MESH_DEPTH_BINDING}) var tMeshDepth: texture_depth_2d;
fn meshDepthHere() -> f32 {
  let hi = vec2i(textureDimensions(tMeshDepth)) - 1;
  return textureLoad(tMeshDepth, clamp(vec2i(floor(gFragCoord)), vec2i(0), hi), 0);
}
fn meshCutT(rd: vec3f) -> f32 {
  if (P.meshCut == 0u) { return MESH_CUT_NONE; }
  return meshCutAt(meshDepthHere(), P.meshInv, P.meshRes, rd);
}
fn meshCutDepth(d: f32) -> f32 {
  if (P.meshCut == 0u) { return d; }
  return min(d, meshDepthHere());
}
`;

const TEX = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 };   // (GPUTextureUsage's bits, importable in Node)

/**
 * The depth hand-off: capture(depth) after three's opaque meshes rendered
 * into the scene target, then take() in the volume's draw, once per frame:
 *
 *   const cut = createMeshCut(gpu);
 *   post.render({
 *     opaque(p) { …three renders the opaque meshes into p.sceneTarget.rt…; return cut.capture(p.sceneTarget.depth); },
 *     draw(rp, p) { volume.draw(rp, { meshDepth: cut.take(), … }); },
 *   }, camera);
 * @param {object} gpu
 */
export function createMeshCut(gpu) {
  let copy = null;      // our depth32float copy, sized as the target
  let armed = false;    // capture() ran since the last take()
  // bound while there is no cut: a 1×1 depth texture, never read (meshCut is 0)
  const none = gpu.createTexture({ label: 'mesh depth (none)', size: [1, 1], format: 'depth32float', usage: TEX.TEXTURE_BINDING });

  return {
    /**
     * Records the copy of `depth` (the scene target's, as three's meshes left
     * it) into the open frame. Returns true: the `opaque` hook's "drew".
     * @param {GPUTexture} depth a depth32float texture with COPY_SRC
     * @returns {true}
     */
    capture(depth) {
      if (!copy || copy.width !== depth.width || copy.height !== depth.height) {
        if (copy) gpu.flush('mesh depth resize');   // (commands recorded with the old copy go first)
        copy?.destroy();
        copy = gpu.createTexture({
          label: 'mesh depth', size: [depth.width, depth.height], format: 'depth32float',
          usage: TEX.COPY_DST | TEX.TEXTURE_BINDING,
        });
      }
      gpu.frame.direct().copyTextureToTexture({ texture: depth }, { texture: copy }, [depth.width, depth.height]);
      armed = true;
      return true;
    },
    /** The copy if capture() ran since the last take(), else null; clears it. */
    take() {
      const t = armed ? copy : null;
      armed = false;
      return t;
    },
    /** The texture the volume binds when there is no cut. */
    get none() { return none; },
    dispose() {
      gpu.flush('mesh depth dispose');
      copy?.destroy();
      none.destroy();
      copy = null;
    },
  };
}
