// Motion input contract and CPU reference for post's optional hybrid TAAU inputs.
// No GPU allocations, readbacks, simulation changes, or independent frame scheduling.
//
// Parent integration:
//  * Create createHybridTemporal(post, { invalidateCaches: () => meshFrames.drop() }).
//    Do not use legacy meshFrames capture/restore for hybrid frames: it caches only
//    colour/depth, not these per-pixel inputs. Supply fresh inputs on every full frame.
//  * In render.prepare/compute AFTER beginScene has chosen post.inSize, call
//    temporal.update({ revision, motion, reactive }). revision must change for ANY
//    visible simulation edits/steps/undo/load/window shift, not for camera jitter.
//  * Record producers in that frame's encoder before post.finish reads the textures.
//    Clear the complete motion/mask targets each frame, including uncovered pixels.
//  * reset() on grid replacement, window shifts, undo/load, teleports/device loss;
//    dispose() before post/device teardown. post already rejects camera cuts.
//  * With no exact correspondence, leave motion null. A revision change without
//    a complete reactive mask rejects untracked history conservatively. Never
//    interpret a simulation flow field as exact material displacement.
//
// motion: scene-sized, single-sample 2D rgba16float GPUTexture, TEXTURE_BINDING.
// xy = CURRENT minus PREVIOUS UNJITTERED NDC (not UV, pixels, cells, or units/s),
// x right / y up, including camera, model AND rolling-presentation transforms.
// z > 0 = reliable correspondence; z == 0 = static point (camera reprojection);
// z < 0 or nonfinite xyz = reject. w unused. Clear to zero for static background.
// Motion is sampled at the current JITTERED scene pixel but excludes both jitters.
// reactive: same size/usage, r8unorm/r16float/rgba8unorm/rgba16float. R > 0 or
// nonfinite rejects history, including when motion is reliable. R == 0 retains.
// It must cover ALL changed/uncorresponded matter, disocclusions, and translucent
// mixtures (including their old footprints); flow alone is not such a mask.
// Inputs are caller-owned and frame-local; post never destroys them. Invalid size
// or format throws rather than sampling unrelated pixels after dynamic resize.

const MASK_FORMATS = new Set(['r8unorm', 'r16float', 'rgba8unorm', 'rgba16float']);

/** Validate/snapshot a frame's optional GPUTextures; null preserves legacy motion. */
export function temporalInputs(inputs = {}, size) {
  const { motion = null, reactive = null, rejectUntracked = false } = inputs ?? {};
  for (const [name, t] of [['motion', motion], ['reactive', reactive]]) {
    if (!t) continue;
    if (typeof t.createView !== 'function' || t.width !== size[0] || t.height !== size[1]) {
      throw new Error(`temporal ${name}: expected scene-sized GPUTexture (${size.join('x')})`);
    }
    if ((t.dimension ?? '2d') !== '2d' || (t.depthOrArrayLayers ?? 1) !== 1 || (t.sampleCount ?? 1) !== 1
      || (t.usage !== undefined && !(t.usage & 4))) {
      throw new Error(`temporal ${name}: expected single-sample 2D TEXTURE_BINDING`);
    }
    if (name === 'motion' ? t.format !== 'rgba16float' : !MASK_FORMATS.has(t.format)) {
      throw new Error(`temporal ${name}: unsupported format ${t.format}`);
    }
  }
  return { motion, reactive, rejectUntracked: !!rejectUntracked };
}

/** CPU reference for optional-input selection (not camera reprojection or GPU proof).
 * Finite explicit motion outside [-2,2] cannot correspond to an on-screen previous
 * sample; reject it before storage to rg16float (also avoids half-float overflow).
 */
export function temporalMotionDecision({ historyValid = true, motion = null, reactive = 0, rejectUntracked = false } = {}) {
  if (!historyValid || !Number.isFinite(reactive) || reactive > 0) return 'reject';
  if (motion) {
    if (!motion.slice(0, 3).every(Number.isFinite) || motion[2] < 0) return 'reject';
    if (motion[2] > 0) return Math.abs(motion[0]) <= 2 && Math.abs(motion[1]) <= 2 ? 'explicit' : 'reject';
  }
  return rejectUntracked ? 'reject' : 'camera';
}

/** Small lifecycle adapter; update ONLY once per rendered scene, in prepare/compute.
 * `changed` supplements revision for external animated/uncorresponded matter.
 * `cameraCut` forces a reset even below post's automatic teleport thresholds.
 * invalidateCaches must drop external colour/depth caches; no scheduling is added.
 */
export function createHybridTemporal(post, { invalidateCaches = () => {} } = {}) {
  let revision, seen = false, disposed = false;
  const helper = {
    update({ revision: next, motion = null, reactive = null, changed = false, cameraCut = false } = {}) {
      if (disposed) throw new Error('hybrid temporal: disposed');
      if (cameraCut) helper.reset();
      const dirty = changed || !seen || !Object.is(revision, next);
      const inputs = temporalInputs({ motion, reactive, rejectUntracked: dirty && !reactive }, post.inSize);
      if (dirty) invalidateCaches();
      post.setTemporalInputs(inputs);
      revision = next; seen = true;
      return inputs;
    },
    reset() {
      if (disposed) return;
      revision = undefined; seen = false;
      post.reset(); invalidateCaches();
    },
    dispose() { if (!disposed) { helper.reset(); disposed = true; } },
  };
  return helper;
}
