// node tools/world-detail-check.mjs
// Fixed-output A/B of the world's detail meshes (world/detail.js,
// docs/world-lod.md): cached geometry versus the same scene's coarse
// fallback, the cache's limits and its stale-job contract. The detail meshes
// aren't drawn on WebGPU yet (docs/webgpu.md G1, U10's hand-back: world/detail.js
// is a stand-in that holds no chunk), so there is nothing to compare: this
// says so and succeeds, and checks the stand-in keeps the window's hooks
// harmless. Restore the browser A/B when the meshes are drawn again (git
// history has the WebGL check).
import assert from 'node:assert/strict';
import { WorldDetail, DETAIL_CHUNK } from '../src/world/detail.js';

const far = { win: { size: [1024, 128, 1024] } };
const d = new WorldDetail(far);
const epoch = d.epoch;
d.reset();
d.invalidate([0, 0, 0], [64, 128, 64]);
d.stale([0, 0, 0], [16, 128, 64]);
d.tick();
d.view(null, true);
assert.equal(d.epoch, epoch + 1, 'reset bumps the epoch (readbacks of the old world are dropped)');
assert.equal(d.entries.size, 0, 'the stand-in holds no chunk');
assert.equal(d.mask.length, (1024 / DETAIL_CHUNK) ** 2, 'a mask entry per detail chunk, none set');
assert(d.mask.every((v) => v === 0));
d.dispose();
console.log('SKIP: the detail meshes are not drawn on WebGPU yet (world/detail.js); the stand-in is harmless');
