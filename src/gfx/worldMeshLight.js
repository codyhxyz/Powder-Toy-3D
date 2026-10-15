// Compact native fragment context. Caller supplies ONE owned scene publication;
// this module does not schedule fields/lighting or admit a scene.
import { CodeNode, Matrix4, Vector4, DataArrayTexture, RGBAFormat, RGBAIntegerFormat, HalfFloatType, UnsignedIntType, RepeatWrapping, StorageBufferAttribute } from 'three/webgpu';
import { uniform, texture, storage, sampler, wgslFn } from 'three/tsl';
import { externalTexture, externalStorageAttribute } from '../gpu/three.js';
import { worldBookLayout, WORLD_ATLAS_ABI } from '../world/renderAtlas.js';
import { worldMeshLightWGSL, worldMeshSunWGSL, worldMeshAmbientWGSL } from '../shaders/worldMeshLight.js';
const array = v => Array.from(v?.elements ?? (v?.toArray ? v.toArray() : v));
const vector = (type='vec4') => uniform(new Vector4(), type);
const copy = v => v?.elements || v?.toArray ? Object.freeze(array(v)) : Array.isArray(v) || ArrayBuffer.isView(v) ? Object.freeze(Array.from(v,copy)) : v;
function stand(type) {
  const t=new DataArrayTexture(type===UnsignedIntType?new Uint32Array(4):new Uint16Array(4),1,1,1);
  t.format=type===UnsignedIntType?RGBAIntegerFormat:RGBAFormat;t.type=type;t.isArrayTexture=true;
  return texture(t);
}
const placeholder=()=>new StorageBufferAttribute(new Uint32Array(1),1);
/** One node family for all contexts. No BOX textures occur in its graph. */
export function createWorldMeshLightNodes(shared, L) {
  const W={aux:stand(UnsignedIntType),gi:[0,1,2,3].map(()=>stand(HalfFloatType)),glow:stand(HalfFloatType),sun:stand(HalfFloatType),
    book:storage(placeholder(),'uint').toReadOnly(),sunBook:storage(placeholder(),'uint').toReadOnly(),requests:storage(placeholder(),'uint').toAtomic(),
    world:vector('uvec4'),light:vector('uvec4'),geometry:vector('uvec4'),feedback:vector('uvec4'),
    projection:uniform(new Matrix4()),normalToGrid:uniform(new Matrix4()),depth:vector(),tiles:vector('ivec4'),physical:vector('uvec4'),version:vector('uvec4')};
  class NativeLightCode extends CodeNode {
    constructor(){super('',[],'wgsl');this.bookNode=W.book;this.sunBookNode=W.sunBook;this.requestsNode=W.requests;}
    generate(builder){
      const buffers=Object.fromEntries(['book','sunBook','requests'].map(name=>[name,this[name+'Node'].build(builder,'property')]));
      this.code=worldMeshLightWGSL(shared,buffers);return super.generate(builder);
    }
  }
  const leaf=new NativeLightCode();
  const sunFn=wgslFn(worldMeshSunWGSL,[leaf]),ambientFn=wgslFn(worldMeshAmbientWGSL,[leaf]);
  function terms({p,q,n,glowAt=p}) {
    const common={world:W.world,feedback:W.feedback};
    return {sun:sunFn({...common,p,sm:W.sun,sig:L.sigma,noise:L.noise,rep:sampler(L.noise),
      projection:W.projection,depth:W.depth,tiles:W.tiles,physical:W.physical,version:W.version,sun:L.sun,sunCol:L.sunCol,origin:L.origin,cave:L.cave,cloud:L.cloud}),
    ambient:ambientFn({...common,p:glowAt,q,n,gi0:W.gi[0],gi1:W.gi[1],gi2:W.gi[2],gi3:W.gi[3],glow:W.glow,
      aux:W.aux,light:W.light,geometry:W.geometry,wand:L.wand,wandCount:L.wandCount,sunCol:L.sunCol,cave:L.cave})};
  }
  const normalFn=wgslFn('fn wmlNormal(n: vec3f, normalToGrid: mat4x4f) -> vec3f { return normalize((normalToGrid*vec4f(n,0)).xyz); }');
  return {nodes:W,terms,normal:n=>normalFn({n,normalToGrid:W.normalToGrid})};
}
const check=(p,message)=>{if(!p)throw new TypeError(message);};
/** Takes ownership of publication even on validation failure. It must implement
 * release(), and own atlas + optical Sun resources (not merely their views).
 * worldSize and frozen frameValues are from the same admitted candidate.
 * A successful context is retired explicitly after its LAST Three submission.
 */
export function createWorldMeshLightContext(gpu,{publication,worldSize,frameValues,feedback,noise,isCompatible,install}={}) {
  let released=false,used=false,retiring=false;const wrappers=[];
  const release=()=>{if(!released){released=true;try{wrappers.forEach(t=>t.dispose());}finally{publication?.release?.();}}};
  try {
    const renderer=gpu?.three?.renderer,device=gpu?.device;
    check(publication?.release&&publication.atlas&&publication.sun,'owned atlas/Sun scene publication required');
    check(!publication.atlas.producerOnly,'private producer LIGHT cannot light scene meshes');
    check(renderer?.backend?.get&&device?.queue,'native Three renderer/device required');
    check(typeof install==='function'&&typeof isCompatible==='function','mesh-light installer and scene/config compatibility callback required');
    const A=publication.atlas,S=publication.sun.bindings?publication.sun.bindings():publication.sun;
    const book=worldBookLayout(array(worldSize),device.limits),layout=A.layout,sm=A.sunManifest;
    check(A.abi===WORLD_ATLAS_ABI&&A.epoch>0&&A.generation>0,'world atlas ABI/epoch/publication');
    check(sm&&sm.epoch===A.epoch&&sm.book===S.book&&sm.sun0===S.sun0&&sm.sun1===S.sun1,'Sun and atlas must be one publication');
    for(const [key,length]of [['worldToLight',16],['depth',4],['tiles',4],['physical',4],['version',4]]){
      const a=array(sm.params[key]),b=array(S.params[key]);
      check(a.length===length&&b.length===length&&a.every((v,i)=>Number.isFinite(v)&&v===b[i]),'Sun params differ from pinned manifest');
    }
    check(S.params.version[0]===A.epoch&&S.params.version[3]===book.sunWord,'Sun epoch/request offset mismatch');
    const count=book.count,sunCount=S.params.tiles[2]*S.params.tiles[3],limit=Math.min(128*1024**2,device.limits?.maxStorageBufferBindingSize??128*1024**2);
    check(A.lightBook.size>=count*4&&A.lightBook.size<=limit&&S.book.size>=sunCount*32&&S.book.size<=limit,'native LIGHT/Sun book extent');
    const feedbackWords=book.sunWord+Math.ceil(sunCount/32);
    check(feedback?.size>=feedbackWords*4&&feedback.size<=limit,'complete shared typed feedback extent');
    check(frameValues?.model&&frameValues.sun&&frameValues.sunCol&&frameValues.caveAmbient&&frameValues.cloudShift,'frozen world frame values required');
    const values=Object.freeze(Object.fromEntries(Object.entries(frameValues).map(([k,v])=>[k,copy(v)])));
    for(const key of ['sun','sunCol','caveAmbient','cloudShift'])check(values[key].every(Number.isFinite),'finite frozen lighting values');
    check(values.model.length===16&&values.model.every(Number.isFinite),'finite global world model');
    const model=new Matrix4().fromArray(values.model);check(model.determinant()!==0,'invertible global world model');
    const wrap=(view,dimension)=>{const native=view?.texture??view;check(native?.format,'native texture reference required');const t=externalTexture(native,{dimension});if(dimension==='3d')t.wrapS=t.wrapT=t.wrapR=RepeatWrapping;wrappers.push(t);return t;};
    // Callers supply texture references because GPUTextureView has no public
    // backlink. Atlas views in real bundles accompany their native textures.
    const textures=publication.textures,nativeSun=publication.sun.textures?.().sun0??textures?.sunOptical;
    check(textures?.aux&&textures.gi?.length===4&&textures.glow&&nativeSun&&noise,'native texture references required');
    check(!textures.sunOptical||textures.sunOptical===nativeSun,'Sun texture differs from pinned handle');
    const owned={aux:wrap(textures.aux,'2d-array'),gi:textures.gi.map(t=>wrap(t,'2d-array')),glow:wrap(textures.glow,'2d-array'),sun:wrap(nativeSun,'2d-array'),noise:wrap(noise,'3d'),
      book:externalStorageAttribute(renderer,A.lightBook,count),sunBook:externalStorageAttribute(renderer,S.book,sunCount*8),requests:externalStorageAttribute(renderer,feedback,feedbackWords),
      world:[...book.bricks,A.epoch],light:[layout.descriptorBase,layout.lightCapacity,layout.probeCapacity,A.generation],geometry:[layout.aux.width,layout.aux.height,layout.probes.width,layout.probes.height],
      feedback:[book.planeWords,book.statusWord,book.sunWord,WORLD_ATLAS_ABI],normalToGrid:model.clone().transpose(),projection:array(S.params.worldToLight),depth:array(S.params.depth),tiles:array(S.params.tiles),physical:array(S.params.physical),version:array(S.params.version),values,worldToGrid:model.invert()};
    const context=Object.freeze({identity:publication.identity??A,epoch:A.epoch,
      bind(){check(!released&&!retiring,'retired world mesh context');check(isCompatible(publication)===true,'incompatible world mesh scene/epoch/config');used=true;install(owned,context);},
      cancel(){check(!used,'used context requires final submission fence');release();},
      retireAfter(submitted){check(!retiring&&!released&&submitted?.then,'one final submission promise required');retiring=true;
        // Final rejection attests suffix discard, NOT rollback of prior submits.
        return Promise.resolve(submitted).then(()=>null,error=>({error})).then(async result=>{try{await device.queue.onSubmittedWorkDone();if(result)throw result.error;}finally{release();}});},
      get released(){return released;},
    });return context;
  }catch(error){release();throw error;}
}
