// Owned native input cut. No renderer, physics pause, private submission or GI policy.
import { SOURCE_RANK, SOURCE_GRID } from './renderSource.js';
import { RawWorldSourceProducer } from './renderSourceProducer.js';
import { treesIn } from './generator.js';
import { sceneLayout } from './scenes/sceneGpu.js';
import { fold } from '../gpu/kernels.js';
import { cellSlot } from '../shaders/common.js';
import { BUILTINS } from '../constructions/builtins.js';
import { SceneGpu } from './gpu.js';

const versions = new WeakMap(), handles = new WeakMap();
const buffersOf = c => [c.A,c.B,c.flow,c.aeration,c.deco?.buffer].filter(Boolean);
const metadata = ['rank','revisions','pending','aux','wakeTrusted'];
const sameToken = (a,b) => a?.epoch===b?.epoch && a?.sourceRevision===b?.sourceRevision;
const primitive = v => v!==undefined && v!==null && !['object','function'].includes(typeof v) && (typeof v!=='number'||Number.isFinite(v));
const freezeData = value => {
  if (value===null || typeof value!=='object') {
    if (typeof value==='function') throw new Error('Unsupported mutable generator parameter');
    return value;
  }
  if (Array.isArray(value)||ArrayBuffer.isView(value)) return Object.freeze(Array.from(value,freezeData));
  if (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) throw new Error('Unsupported generator parameter owner');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,freezeData(v)])));
};
const copyStore = entries => new Map(Array.from(entries??[],([k,v])=>{
  if(!ArrayBuffer.isView(v)||v.BYTES_PER_ELEMENT!==1)throw new Error('Unsupported encoded Source backing');
  return [k,new Uint8Array(v.buffer,v.byteOffset,v.byteLength).slice()];
}));

// A prefix auto-submit is NOT a final fence. With no remaining cut owners,
// no new cut reference can be recorded; wait until the normal Frame is closed,
// then fence every already-submitted use. A failed flush deliberately retains.
function retire(gpu, buffer) {
  const wait = () => {
    // Graphics failure may leave an encoder whose disposition is unknown.
    // Keep it owned rather than throw from the live-device getter or recycle.
    if (gpu.failure||gpu.pipelines?.failure) return;
    if (gpu.frame.open) { setTimeout(wait,0); return; }
    Promise.resolve((gpu.queue??gpu.device.queue).onSubmittedWorkDone()).then(()=>buffer.destroy(),()=>buffer.destroy());
  };
  queueMicrotask(wait);
}
function adopt(c) { versions.set(c,{refs:1}); return c; }
function hold(c) { const v=versions.get(c); if(!v)throw new Error('Unowned cut core');v.refs++;return c; }
function drop(gpu,c) { const v=versions.get(c);if(!v||--v.refs) return;for(const b of buffersOf(c))retire(gpu,b); }
function cloneCore(source, c, frame) {
  const allocated=[];
  try {
    const out={key:c.key,origin:[...c.origin],g:SOURCE_GRID,copy:0,highestRevision:c.highestRevision};
    for(const key of metadata)out[key]=c[key].slice();
    for(const name of ['A','B','flow','aeration']) {
      out[name]=null;if(!c[name])continue;
      const size=name==='A'||name==='B'?SOURCE_GRID.slots*16:SOURCE_GRID.slots*8;
      const b=source._buffer(`cut ${c.key} ${name}`,size);allocated.push(b);
      frame.copy(c[name],(name==='A'||name==='B'?(c.copy??0)*size:0),b,0,size);out[name]=b;
    }
    out.deco=null;
    if(c.deco){const b=source._buffer(`cut ${c.key} deco`,SOURCE_GRID.slots*4);allocated.push(b);frame.copy(c.deco.buffer,c.deco.offset??0,b,0,b.size);out.deco={buffer:b,offset:0};}
    return adopt(out);
  } catch(error) {for(const b of allocated)retire(source.gpu,b);throw error;}
}
function completeCore(c,size) {
  // In-world slots only; partial outer cores do not require exterior authority.
  for(let z=0;z<32;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    if(c.origin.some((v,i)=>v+[x,y,z][i]>=size[i]))continue;
    const s=cellSlot(c.g,x,y,z);
    if(!c.rank[s])return false;
  }
  return true;
}
function sceneResources(source, frame, previous, delta) {
  const gpu=source.gpu, original=source.win.gen.res;
  // SceneGpu's packed uniform mirror is configuration, not dynamic cell readback.
  // Copy the *uploaded bytes*, never re-evaluate mutable scene.uniforms(P).
  if(!(original instanceof SceneGpu) || !original.uniforms?.data || !original.layout || !source.win.sourceProducer?.sceneGroup) throw new Error('Scene resources are not ready for an owned Source cut');
  const uniformBytes=new Uint8Array(original.uniforms.data).slice();
  const actual=original.entries();
  if(actual.length!==original.layout.length||actual.some(e=>e.resource?.buffer!==(e.binding===0?original.uniforms.buffer:e.binding===1?original.data:null)))throw new Error('Unsupported scene generation resource owner');
  if(previous && !delta.global) {
    if(previous.original!==original||previous.originalData!==original.data||uniformBytes.length!==previous.uniformBytes.length||!uniformBytes.every((v,i)=>v===previous.uniformBytes[i]))throw new Error('Scene generation configuration changed without Source/configuration invalidation');
    previous.refs++;return previous;
  }
  const owned=[];
  try {
    const uniform=gpu.createBuffer({label:'cut scene uniforms',size:original.uniforms.data.byteLength,usage:64,mappedAtCreation:true});owned.push(uniform);
    new Uint8Array(uniform.getMappedRange()).set(uniformBytes);uniform.unmap();
    let data=null;
    if(original.data) {
      if(!(original.data.usage&4))throw new Error('Scene data cannot be snapshotted natively');
      data=gpu.createBuffer({label:'cut scene data',size:original.data.size,usage:128|8|4});owned.push(data);
      frame.copy(original.data,0,data,0,data.size);
    }
    const layout=original.layout.map(e=>({...e,buffer:e.buffer&&{...e.buffer}}));
    if(layout.some(e=>!e.buffer||e.binding>1)||layout.length!==(data?2:1))throw new Error('Unsupported scene generation binding owner');
    const entries=()=>[{binding:0,resource:{buffer:uniform}},...(data?[{binding:1,resource:{buffer:data}}]:[])];
    const preKernel=original.preKernel, margin=[...(original.preMargin??[0,0,0])], capacity=original.preCells;
    const writeGroup=preKernel?gpu.bindGroup(gpu.layout('scene write',sceneLayout({data:true,write:true})),entries(),'cut scene prepass'):null;
    if(preKernel&&!data)throw new Error('Scene prepass has no owned data');
    const resources={layout,entries,prepassFor(lo,hi){
      if(!preKernel)return;
      const dims=hi.map((v,i)=>v-lo[i]+2*margin[i]),min=lo.map((v,i)=>v-margin[i]),n=dims.reduce((a,b)=>a*b,1);
      if(n>capacity)throw new Error('Owned scene prepass capacity exceeded');
      preKernel.dispatch(gpu.frame,fold(Math.ceil(n/64)),{bind:[source.sim.tables,gpu.emptyGroup,writeGroup],params:{lo:min,dims}});
    }};
    return {refs:1,original,originalData:original.data,uniformBytes,owned,resources};
  }catch(error){for(const b of owned)retire(gpu,b);throw error;}
}
function releaseScene(gpu,s){if(s&&!--s.refs)for(const b of s.owned)retire(gpu,b);}
function valid(state){return state.refs>0&&!state.closed&&!state.parent.disposed&&state.parent.epoch===state.epoch&&state.parent.cutConfiguration===state.configuration;}
function close(state){
  state.closed=true;state.producer?.dispose();
  for(const c of state.source?.chunks.values()??[])drop(state.parent.gpu,c);
  state.source?.chunks.clear();releaseScene(state.parent.gpu,state.scene);
}
function handle(state){
  state.refs++;let released=false;
  const alive=()=>{if(released||!valid(state))throw new Error('Invalid owned Source cut');};
  const h=Object.freeze({identity:state.identity,configuration:state.configuration,
    source:state.source,producer:state.producer,contentToken:state.token,
    belongsTo:source=>source===state.parent,
    isValid:()=>!released&&valid(state),isLatest:()=>!released&&valid(state)&&sameToken(state.parent.contentToken(),state.token),
    snapshotForFields(options){alive();return state.source.snapshotForFields(options);},
    retain(){alive();return handle(state);},
    // Reserve BEFORE queued consumers, settle only after their FINAL submission.
    retainUntilSubmitted(submitted){
      alive();if(!submitted?.then)throw new TypeError('Final submission promise required');const pin=handle(state);
      return Promise.resolve(submitted).then(()=>null,error=>({error})).then(async failure=>{
        await (state.parent.gpu.queue??state.parent.gpu.device.queue).onSubmittedWorkDone();
        if(failure)throw failure.error;
      }).finally(()=>pin.release());
    },
    release(){if(!released){released=true;if(!--state.refs)close(state);}}
  });handles.set(h,state);return h;
}

// Brand check: duck-typed/cloned handles cannot authorize retained publication.
export function validateWorldSourceCut(cut,{sourceOwner,epoch,configuration}={}) {
  const state=handles.get(cut);
  if(!state || !cut.isValid() || state.parent!==sourceOwner || state.epoch!==epoch || state.configuration!==configuration) throw new Error('invalid owned Source cut proof');
  return cut;
}

export function recordWorldSourceCut(parent,frame,{previousCut=null,sceneVersion,configVersion}={}) {
  if(parent.disposed||frame!==parent.gpu.frame)throw new Error('Source cut requires the live normal Frame');
  if(!parent.win.loaded)throw new Error('Load the authoritative world before capturing a Source cut');
  if(!primitive(sceneVersion)||!primitive(configVersion))throw new TypeError('Explicit immutable scene/configuration versions required');
  const producer=parent.win.sourceProducer;
  if(!producer?.sceneGroup||producer.disposed||producer.source!==parent)throw new Error('Await live Source producer readiness before capture');
  const old=previousCut&&handles.get(previousCut);
  if(previousCut&&(!old||old.parent!==parent||!previousCut.isValid()))throw new Error('Invalid previous Source cut');
  if(!parent.cutConfiguration||parent.cutConfiguration.epoch!==parent.epoch||!Object.is(parent.cutConfiguration.sceneVersion,sceneVersion)||!Object.is(parent.cutConfiguration.configVersion,configVersion))parent.cutConfiguration=Object.freeze({epoch:parent.epoch,sceneVersion,configVersion});
  const configuration=parent.cutConfiguration, compatible=old&&old.configuration===configuration;
  if(parent.needsLiveCopy())parent.recordLiveCopy(frame);
  const token=parent.contentToken(), authority=parent.token(), delta=parent.changesSince(compatible?old.token:null);
  const state={parent,epoch:parent.epoch,configuration,token,identity:Object.freeze({epoch:parent.epoch,sourceRevision:token.sourceRevision,sceneVersion,configVersion}),refs:1,closed:false,source:null,producer:null,scene:null};
  try {
    const w=parent.win;
    if(w.scene.trees&&w.scene.trees.treesIn!==treesIn)throw new Error('Unsupported mutable CPU tree generator');
    const scene=Object.freeze({key:w.scene.key,trees:w.scene.trees?Object.freeze({treesIn}):null,
      importManifest:w.scene.importManifest?freezeData(w.scene.importManifest):null,appearanceWords:w.scene.appearanceWords?.slice()??null});
    state.scene=sceneResources(parent,frame,compatible?old.scene:null,delta);
    const context={size:Object.freeze([...w.size]),wb:Object.freeze([...w.wb]),P:freezeData(w.P),scene,
      planted:w.planted.slice(),candidates:new Map(),treeGenerator:BUILTINS.TREE,store:{map:copyStore(w.store.map)},decoStore:copyStore(parent.sim.deco?.store),resources:state.scene.resources,
      isValid:()=>valid(state),retire:b=>retire(parent.gpu,b),adoptChunk:adopt,
      writableChunk:c=>{if(!valid(state))throw new Error('Invalid cut write');if(versions.get(c)?.refs>1){const next=cloneCore(state.source,c,frame);drop(parent.gpu,c);return next;}return c;}};
    const source=state.source=new parent.constructor(w,{context});
    source.epoch=state.epoch;source.revision=authority.revision;source.contentRevision=token.sourceRevision;source.minimumStaticRevision=parent.minimumStaticRevision;
    source.changeJournal=(parent.changeJournal??[]).map(e=>({revision:e.revision,global:e.global,bounds:e.bounds&&{lo:[...e.bounds.lo],hi:[...e.bounds.hi]}}));
    const changedCores=new Set(delta.changedBricks.map(b=>b.map(v=>Math.floor(v/8)*32).join(',')));
    if(compatible&&!delta.global)for(const [key,c] of old.source.chunks)if(!changedCores.has(key))source.chunks.set(key,hold(c));
    for(const [key,c] of parent.chunks) {
      if(!c.rank.some(v=>v>=SOURCE_RANK.saved)&&!c.aux.some(Boolean))continue; // regenerate static discovery, do not snapshot a dense cache
      const existing=source.chunks.get(key);
      if(existing&&completeCore(existing,context.size))continue;
      const next=cloneCore(source,c,frame);if(existing)drop(parent.gpu,existing);source.chunks.set(key,next);
    }
    state.producer=new RawWorldSourceProducer(w,source,{context,kernels:producer});
    if(parent.disposed||parent.epoch!==state.epoch||!sameToken(parent.contentToken(),token)||parent.revision!==authority.revision)throw new Error('Source changed during native cut capture');
    const result=handle(state);state.refs--;return result;
  } catch(error){state.refs=0;close(state);throw error;}
}
