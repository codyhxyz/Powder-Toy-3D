// Independent texture transport; original importer ABI v1 and decoder unchanged.
import { appearanceRegion, uploadAppearance } from './sourceAppearance.js';
export function createWorldAppearance(gpu, { words, width = 128, depth = 128 }) {
  const device=gpu.device ?? gpu;
  const limit=device.limits?.maxTextureDimension3D ?? 2048;
  if (!(words instanceof Uint32Array) || ![width,depth].every(n=>Number.isSafeInteger(n)&&n>0&&n<=limit)) throw new RangeError('world appearance dimensions/words');
  const region=appearanceRegion([width,0,depth],words.length,limit);
  const size=[width,Math.max(1,region.planes),depth];
  const texture=device.createTexture({label:'world source appearance',size,dimension:'3d',format:'rgba16uint',usage:6});
  try { uploadAppearance({queue:device.queue},texture,words,region); } catch (e) { texture.destroy(); throw e; }
  return Object.freeze({texture,view:texture.createView(),sourceGrid:[width,0,depth],uniform:region.uniform,
    // Caller must retain until its last submitted use completes.
    dispose:()=>texture.destroy()});
}
