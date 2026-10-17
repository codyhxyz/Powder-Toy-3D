import { Matrix4 } from 'three/webgpu';
import { frameUniformsOf } from '../uniforms.js';
import { fold } from '../../gpu/kernels.js';
import {
  HybridMotionParams, MOTION_LAYOUT, MOTION_CAPTURE_LAYOUT, motionWGSL, motionCaptureWGSL,
} from '../../shaders/hybrid/motion.js';

export function matchingParticleCell(cell, size, key, readKey) {
  let match = null, count = 0;
  for (let z=-1; z<=1; z++) for (let y=-1; y<=1; y++) for (let x=-1; x<=1; x++) {
    const q = [cell[0]+x,cell[1]+y,cell[2]+z];
    if (q.some((v,i) => v < 0 || v >= size[i])) continue;
    const prior = readKey(q);
    if (prior[0] === key[0] && prior[1] === key[1]) { match = q; count++; }
  }
  return count === 1 ? match : null;
}

// Static surfaces get exact camera/model motion. Cell-centred particles get
// identity-checked one-cell motion; other deformation/transparent mixtures reject.
export function createHybridMotion(gpu, sim, { gate: providedGate = null } = {}) {
  const fu = frameUniformsOf(gpu), label = s => `sim${sim.id} hybrid motion ${s}`;
  const sceneLayout = gpu.layout(label('scene'), MOTION_LAYOUT);
  const captureLayout = gpu.layout(label('keys'), MOTION_CAPTURE_LAYOUT);
  const keys = gpu.createBuffer({ label: label('previous identities'), size: sim.g.slots*8, usage: 0x80 });
  const gate=providedGate??gpu.createBuffer({label:label('accepted scene'),size:4,usage:0x80});
  const captureBind = gpu.bindGroup(captureLayout, [{ binding: 0, resource: { buffer: keys } }]);
  const capture = gpu.kernel({ optional: true, name: label('capture'), code: motionCaptureWGSL(sim.g),
    layouts: [sim.L.TABLES,sim.L.STATE_RO,captureLayout], workgroupSize: [64,1,1] });
  const pipe = gpu.renderPipeline({ optional: true, name: label('vectors'), code: motionWGSL(sim.g),
    layouts: [fu.layout,sim.L.STATE_RO,sceneLayout], params: HybridMotionParams,
    fragment: { targets: [{ format: 'rgba16float' },{ format: 'r8unorm' },{format:'r8unorm'}] } });
  let textures, previous = new Matrix4(), previousJittered = new Matrix4();
  let valid = false, lastRevision, lastFields, lastOrigin, lastOptical, disposed = false;
  const retired = [];
  const collect = () => {
    for (let i=retired.length-1; i>=0; i--) if (retired[i].encoder !== gpu.frame.encoder) {
      retired[i].textures.forEach(t => t.destroy()); retired.splice(i,1);
    }
  };
  const stats = { frames: 0, allocations: 0, captures: 0 };
  const api = {
    ready: Promise.all([capture.ready,pipe.ready]).then(() => api),
    get isReady() { return !disposed && capture.state === 'ready' && pipe.state === 'ready'; },
    get resources() { return !disposed&&textures?{motion:textures.motion,reactive:textures.reactive,opticalDepth:lastOptical}:null; },
    stats,
    invalidate() { valid = false; lastRevision = undefined; },
    record({ depth, opticalDepth, media, camera, post, model, revision, fieldRevision=revision, externalAnimated = false, world = false }) {
      if (!api.isReady) return null;
      if (!fu.last.written || depth.format !== 'depth32float' || !camera || !post || !model) throw new TypeError('motion requires written FU, scene depth, camera/post/model');
      collect();
      const w = depth.width, h = depth.height;
      if (opticalDepth.width !== w || opticalDepth.height !== h) throw new RangeError('motion optical extent mismatch');
      if (!textures || textures.depth.width !== w || textures.depth.height !== h) {
        if (textures) retired.push({ encoder: gpu.frame.encoder, textures: Object.values(textures) });
        textures = Object.fromEntries([['motion','rgba16float',20],['reactive','r8unorm',20],['coverage','r8unorm',21],['previousCoverage','r8unorm',6],['depth','depth32float',6]]
          .map(([key,format,usage]) => [key,gpu.createTexture({ label: label(key), size: [w,h], format, usage })]));
        valid = false; stats.allocations++;
      }
      const origin = `${sim.origin.x},${sim.origin.y},${sim.origin.z}`;
      if (origin !== lastOrigin) valid = false;
      const jittered = new Matrix4().multiplyMatrices(fu.last.viewProj,fu.last.model);
      const current = post.withoutJitter(() => new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(model));
      const bind = gpu.bindGroup(sceneLayout, [
        ...[depth,textures.depth,opticalDepth,media].map((t,binding) => ({ binding,resource:t.createView() })),
        { binding:4,resource:{ buffer:keys } },
        { binding:5,resource:{ buffer:gate } },
        { binding:6,resource:textures.previousCoverage.createView() },
      ]);
      const rp = gpu.frame.render({ colorAttachments: [textures.motion,textures.reactive,textures.coverage].map(t => ({
        view:t.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0],
      })) },'hybrid motion and reactive');
      try {
        pipe.draw(rp,{ bind:[fu.group,sim.bindRO,bind],header:sim.header(),params:{
          clipToGrid:jittered.clone().invert(),current,previous,previousJittered,size:[w,h],
          valid:valid?1:0,changed:fieldRevision!==lastFields||revision!==lastRevision?1:0,untracked:externalAnimated?1:0,world:world?1:0,
        },count:3 });
      } finally { rp.end(); }
      if (!valid || revision !== lastRevision) {
        capture.dispatch(gpu.frame,fold(sim.g.nbricks),{ bind:[sim.tables,sim.bindRO,captureBind],header:sim.header() });
        stats.captures++;
      }
      gpu.frame.direct().copyTextureToTexture({ texture:depth },{ texture:textures.depth },[w,h]);
      gpu.frame.direct().copyTextureToTexture({texture:textures.coverage},{texture:textures.previousCoverage},[w,h]);
      previous.copy(current); previousJittered.copy(jittered);
      valid = true; lastRevision = revision; lastFields=fieldRevision; lastOrigin = origin; lastOptical=opticalDepth; stats.frames++;
      return { motion:textures.motion,reactive:textures.reactive };
    },
    dispose() {
      if (disposed) return;
      disposed = true; gpu.flush('hybrid motion dispose');
      keys.destroy(); if(!providedGate)gate.destroy(); Object.values(textures??{}).forEach(t => t.destroy());
      retired.forEach(r => r.textures.forEach(t => t.destroy())); retired.length=0;
    },
  };
  return api;
}
