// PHASE3b-1 explicit assembly, deliberately NOT selected by the application.
// No Simulation, field producer, lighting scheduler, or presentation gate.
import { volumeFrag, pickFrag, VOLUME_LAYOUTS, PICK_LAYOUTS, VolumeParams, PickParams,
  volumePipeline, worldPlainPipelines, WORLD_PLAIN_PHASES, VOLUME_VERTICES, VOLUME_SCREEN_VERTICES } from '../shaders/render.js';
import { worldPointWGSL, worldPointLayouts, WorldPointParams, WORLD_POINT_BYTES } from '../shaders/worldPoint.js';
import { FRAME_UNIFORM_FIELDS } from '../shaders/bindings.js';
import { uniformStruct } from '../gpu/params.js';
import { Header } from '../shaders/common.js';
import { WorldSunParams, worldSunFeedbackWords } from '../world/worldSun.js';
import { requestedBricks, requestedChannels, READY, WORLD_ATLAS_ABI } from '../world/renderAtlas.js';
const BU={COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128};
const WorldFrameStruct = uniformStruct('FrameUniforms', FRAME_UNIFORM_FIELDS);
const vec = v => Array.from(v?.elements ?? (v?.toArray ? v.toArray() : v));
// Native local lamp/wand/dig positions converted ONCE from a frozen origin.
// Eye/model, beacon/cell, sun, cloud, source artwork and warp are already global.
export function worldFrameValues(values, physicsOrigin) {
  const origin=vec(physicsOrigin);
  if (origin.length!==3 || !origin.every(Number.isFinite)) throw new RangeError('frozen physics origin required');
  const out={...values};
  for (const key of ['lampPos','wandLightPosition']) if (values[key]) {
    const a=values[key];
    const rows=typeof a[0]==='number' ? Array.from({length:a.length/4},(_,i)=>Array.from(a.slice(i*4,i*4+4))) : Array.from(a,vec);
    out[key]=rows.map(p=>p.map((n,i)=>i<3 ? n+origin[i] : n));
  }
  for (const key of ['lampCol','lampShape','wandLightColor']) if (values[key] && typeof values[key][0]==='number') {
    const a=values[key]; out[key]=Array.from({length:a.length/4},(_,i)=>Array.from(a.slice(i*4,i*4+4)));
  }
  for (const key of ['digMin','digMax']) if (values[key]) out[key]=vec(values[key]).map((n,i)=>i<3 ? n+origin[i] : n);
  return out;
}
export function decodeWorldFeedback(words, book, sunTileCount) {
  const at=book.requestBytes/4, sunWords=Math.ceil(sunTileCount/32);
  if (!(words instanceof Uint32Array) || words.length<at+1+sunWords) throw new RangeError('complete feedback readback required');
  const requirements=requestedChannels(words,book);
  const geometry=requirements.filter(r=>r.channels & READY.CELL).map(r=>r.index);
  const sun=requestedBricks(words.subarray(at+1),sunTileCount);
  return Object.freeze({incomplete:words[at]!==0||requirements.length!==0||sun.length!==0,status:words[at],geometry,requirements,sun});
}
export function createWorldVolume(gpu, {g,atlas,tables,lighting,appearance} = {}) {
  const device=gpu.device ?? gpu, queue=device.queue;
  if (!g || !atlas || !tables) throw new Error('world volume requires metadata g, atlas and tables (not a Simulation)');
  if ([g.nx,g.ny,g.nz].some((n,i)=>n!==atlas.bookLayout.worldSize[i])) throw new Error('world metadata/atlas bounds differ');
  const grid=Object.freeze({...g,sourceAppearance:g.sourceAppearance===true,sourceGrid:appearance?.sourceGrid??g.sourceGrid});
  const descriptors=VOLUME_LAYOUTS({backend:'world'}), pickDescriptors=PICK_LAYOUTS({backend:'world'});
  const storageLimit=Math.min(128*1024**2,device.limits?.maxStorageBufferBindingSize??128*1024**2);
  if (tables.size<descriptors[0][0].buffer.minBindingSize || tables.size>storageLimit) throw new RangeError('world tables binding size');
  const layouts=descriptors.map((entries,i)=>device.createBindGroupLayout({label:`world view ${i}`,entries}));
  const pickLayouts=[...layouts.slice(0,3),device.createBindGroupLayout({label:'world pick 3',entries:pickDescriptors[3]})];
  const pointLayouts=[...layouts.slice(0,3),device.createBindGroupLayout({label:'world point 3',entries:worldPointLayouts()[3]})];
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:layouts});
  const pickLayout=device.createPipelineLayout({bindGroupLayouts:pickLayouts});
  const pointLayout=device.createPipelineLayout({bindGroupLayouts:pointLayouts});
  const linear=device.createSampler({minFilter:'linear',magFilter:'linear'});
  const repeat=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat'});
  const pipes=new Map(); let dead=false;
  const alive=()=>{if(dead)throw new Error('world volume disposed');};
  const module=(code,label)=>device.createShaderModule({code,label});
  function compiled(promise) {
    let state='pending', pipeline=null, error=null;
    const ready=Promise.resolve(promise).then(p=>{pipeline=p;state='ready';return p;},e=>{error=e;state='failed';throw e;});
    ready.catch(()=>{});
    return Object.freeze({get state(){return state;},get pipeline(){return pipeline;},get error(){return error;},ready});
  }
  const makePick=view=>compiled(device.createComputePipelineAsync({label:`world pick${view==='plain'?' plain':''}`,layout:pickLayout,
    compute:{module:module(pickFrag(grid,{backend:'world',view}),'world pick'),entryPoint:'main'}}));
  const pickState=makePick('realistic'), plainPickState=makePick('plain');
  const pickPipelineState=(view='realistic')=>{alive();return view==='plain'?plainPickState:pickState;};
  const pointState=compiled(device.createComputePipelineAsync({label:'world point',layout:pointLayout,
    compute:{module:module(worldPointWGSL(grid),'world point'),entryPoint:'main'}}));
  const pointReady=pointState.ready, pickReady=pickState.ready;
  function aggregate(states, pick) {
    const ready=Promise.all([...states.map(s=>s.ready),pick.ready]).then(p=>Object.freeze(p.slice(0,states.length)));
    ready.catch(()=>{});
    return Object.freeze({
      get state(){return [...states,pick].some(s=>s.state==='failed')?'failed':[...states,pick].every(s=>s.state==='ready')?'ready':'pending';},
      get pipelines(){return states.map(s=>s.pipeline);},
      get error(){return [...states,pick].find(s=>s.state==='failed')?.error??null;},ready,
    });
  }
  function pipelineState(view='realistic',detail={},curved=false) {
    alive(); const key=JSON.stringify([view,Object.keys(detail).filter(k=>detail[k]).sort(),curved]);
    if (!pipes.has(key)) {
      const shader=module(volumeFrag(grid,{backend:'world',view,detail,curved}),`world ${key}`);
      const compile=({vertex,fragment,...desc})=>compiled(device.createRenderPipelineAsync({label:`world ${key} ${fragment.entry}`,layout:pipelineLayout,...desc,
        vertex:{module:shader,entryPoint:vertex.entry},fragment:{module:shader,entryPoint:fragment.entry,targets:fragment.targets}}));
      if(view==='plain') {
        const phases=worldPlainPipelines({curved});
        pipes.set(key,aggregate(WORLD_PLAIN_PHASES.map(phase=>compile(phases[phase])),plainPickState));
      } else pipes.set(key,compile(volumePipeline()));
    }
    return pipes.get(key);
  }
  const viewReady=(view,detail,curved)=>pipelineState(view,detail,curved).ready;
  const pipeline=viewReady;
  // Parameters/resources are immutable per candidate, and caller pins the
  // external lighting/appearance/mesh/noise publication through final submission.
  // A supplied snapshot transfers ownership to this call, including failure.
  // Acquire the default only after checking disposal, inside the cleanup scope.
  function prepare({snapshot,frameUniforms,physicsOrigin,params,external,lighting:light=lighting}={}) {
    const owned=[]; let released=false;
    const buffer=(label,bytes,usage=BU.UNIFORM|BU.COPY_DST)=>{
      const b=device.createBuffer({label,size:bytes.byteLength,usage}); owned.push(b); queue.writeBuffer(b,0,bytes); return b;
    };
    try {
      alive();
      snapshot ??= atlas.snapshot();
      if (snapshot.abi!==WORLD_ATLAS_ABI || snapshot.epoch!==atlas.epoch) throw new Error('stale atlas ABI/epoch');
      if (!light?.params || !light.book || !light.sun0 || !light.sun1) throw new Error('explicit immutable lighting publication/bindings required; no fully-lit fallback');
      if (!frameUniforms?.cam || !frameUniforms.model || !frameUniforms.viewProj) throw new Error('world eye/model/viewProj required');
      const sun=snapshot.sunManifest?.params ?? light.params, tiles=sun.tiles;
      if (!tiles || tiles.length!==4 || !Array.from(tiles).every(Number.isInteger) || tiles[2]<=0 || tiles[3]<=0) throw new Error('full world caster projection required even for unpublished lighting');
      const tileCount=tiles[2]*tiles[3], extra=worldSunFeedbackWords(tiles), geomWords=atlas.bookLayout.requestBytes/4;
      if (atlas.feedbackExtraWords<extra || sun.version?.[3]!==geomWords+1) throw new Error('atlas feedbackExtraWords / sun requestWordOffset mismatch');
      const sm=snapshot.sunManifest;
      if (!sm || sm.epoch!==sun.version?.[0] || sm.basisRevision!==sun.version?.[1] || sm.publishRevision!==sun.version?.[2] || sm.book!==light.book || sm.sun0!==light.sun0 || sm.sun1!==light.sun1) throw new Error('lighting publication must match pinned atlas sun manifest');
      if (light.book.size<tileCount*32 || light.book.size>storageLimit) throw new Error('SunBook binding size');
      const sunBytes=new ArrayBuffer(128); WorldSunParams.write(new DataView(sunBytes),0,sun);
      const suppliedSun=new ArrayBuffer(128); WorldSunParams.write(new DataView(suppliedSun),0,light.params);
      if (new Uint8Array(sunBytes).some((v,i)=>v!==new Uint8Array(suppliedSun)[i])) throw new Error('lighting params differ from pinned sun manifest');
      const values=worldFrameValues(frameUniforms,physicsOrigin);
      if (appearance) values.sourceAppearance=appearance.uniform;
      const fuBytes=WorldFrameStruct.pack(values);
      const headerBytes=new ArrayBuffer(Header.size); Header.write(new DataView(headerBytes),0,{origin:[0,0,0]});
      const feedback=buffer('world candidate feedback',new Uint32Array(atlas.feedbackBytes/4),BU.STORAGE|BU.COPY_SRC|BU.COPY_DST);
      const fu=buffer('world candidate frame',fuBytes), header=buffer('world zero origin',headerBytes), sunParams=buffer('world sun publication',sunBytes);
      const p=buffer('world view params',VolumeParams.pack(params));
      const b=(binding,buffer)=>({binding,resource:{buffer}});
      const entries=snapshot.bindings({...external,sunDepth:light.sun1,sunOptical:light.sun0,sourceAppearance:appearance?.view??external?.sourceAppearance},feedback);
      entries[0]=[b(0,tables),b(1,header),b(2,fu),...entries[0].map((e,i)=>({...e,binding:i+3}))];
      const base=[...entries[3].map(e=>({...e,binding:1})),{binding:2,resource:linear},{binding:3,resource:repeat},b(4,sunParams),b(5,light.book)];
      const group=(layout,entries)=>device.createBindGroup({layout,entries});
      const first=entries.slice(0,3).map((e,i)=>group(layouts[i],e));
      const groups=[...first,group(layouts[3],[b(0,p),...base])];
      const valid=()=>{alive();if(released)throw new Error('world candidate released');if(snapshot.epoch!==atlas.epoch)throw new Error('stale world candidate epoch');};
      function recordDraw(pass,{view='realistic',detail={},curved=false}={}) {
        valid(); const state=pipelineState(view,detail,curved);
        if(state.state!=='ready')return false;
        for(const pipeline of view==='plain'?state.pipelines:[state.pipeline]) {
          pass.setPipeline(pipeline);groups.forEach((g,i)=>pass.setBindGroup(i,g));
          pass.draw(curved?VOLUME_SCREEN_VERTICES:VOLUME_VERTICES);
        }
        return true;
      }
      function capturePick({params:pickParams,output,view='realistic'}) {
        if(!output||output.size<32||output.size>storageLimit)throw new Error('pick output buffer required');
        const n=pickParams?.n,slots=pickParams?.slot?.map(vec);
        if(!Number.isInteger(n)||n<1||n>8)throw new RangeError('world pick batch must contain 1..8 rays');
        for(let i=0;i<n;i++) {
          const slot=slots?.[i>>2]?.[i&3];
          if(!Number.isInteger(slot)||slot<0||(slot+1)*32>output.size)throw new RangeError('world pick slot outside output');
        }
        return {bytes:PickParams.pack({...pickParams,n,slot:slots}),output,view};
      }
      function recordCapturedPick(frame,{bytes,output,view}) {
        valid();const state=pickPipelineState(view);if(state.state!=='ready')return false;
        const p=buffer('world pick params',bytes),pg=group(pickLayouts[3],[b(0,p),...base,b(6,output)]);
        const encoder=frame.direct?frame.direct():frame;
        const pass=encoder.beginComputePass({label:'world pick'});
        try {pass.setPipeline(state.pipeline);[...first,pg].forEach((g,i)=>pass.setBindGroup(i,g));pass.dispatchWorkgroups(1);}
        finally {pass.end();}
        return true;
      }
      function capturePoint({position,output}) {
        const p=vec(position??[]);
        if(p.length!==3||!p.every(n=>Number.isFinite(n)&&Number.isFinite(Math.fround(n))))throw new RangeError('finite global world point required');
        if(!output||!Number.isInteger(output.size)||output.size<WORLD_POINT_BYTES||output.size>storageLimit||output.size%4 ||
          (output.usage!==undefined&&!(output.usage&BU.STORAGE)))throw new RangeError('world point output requires storage buffer of at least 80 bytes');
        return {bytes:WorldPointParams.pack({position:[...p,0]}),output};
      }
      function recordCapturedPoint(frame,{bytes,output}) {
        valid();if(pointState.state!=='ready')return false;
        const p=buffer('world point params',bytes),pg=group(pointLayouts[3],[b(0,p),...base,{binding:6,resource:{buffer:output,offset:0,size:WORLD_POINT_BYTES}}]);
        const encoder=frame.direct?frame.direct():frame;
        const pass=encoder.beginComputePass({label:'world point'});
        try {pass.setPipeline(pointState.pipeline);[...first,pg].forEach((g,i)=>pass.setBindGroup(i,g));pass.dispatchWorkgroups(1);}
        finally {pass.end();}
        return true;
      }
      // Associate readback with this exact pinned publication, not live atlas state.
      const publication=Object.freeze({abi:snapshot.abi,epoch:snapshot.epoch,generation:snapshot.generation,
        dependencies:snapshot.dependencies,sunManifest:snapshot.sunManifest});
      return Object.freeze({snapshot,publication,feedback,groups,params,requiredProtocol:'submit -> read entire feedback -> withhold entire incomplete candidate; retain resources until final submitted use completes',
        recordDraw,
        async draw(pass,options={}) {
          valid();const captured={view:options.view??'realistic',detail:{...options.detail},curved:options.curved??false};
          await viewReady(captured.view,captured.detail,captured.curved);valid();
          if(!recordDraw(pass,captured))throw new Error('World draw pipeline unavailable after compilation');
          return {requiresFeedback:true};
        },
        recordPickReady(frame,options) {valid();if(pickPipelineState(options?.view).state!=='ready')return false;return recordCapturedPick(frame,capturePick(options));},
        async recordPick(frame,options) {
          valid();const captured=capturePick(options);await pickPipelineState(captured.view).ready;valid();return recordCapturedPick(frame,captured);
        },
        recordPointReady(frame,options) {valid();if(pointState.state!=='ready')return false;return recordCapturedPoint(frame,capturePoint(options));},
        async recordPoint(frame,options) {
          valid();const captured=capturePoint(options);await pointReady;valid();return recordCapturedPoint(frame,captured);
        },
        decodeFeedback:words=>{valid();return decodeWorldFeedback(words,atlas.bookLayout,tileCount);},
        // ONLY after submitting the last use AND GPU completion. No hidden
        // source/field submits, and no assumption that borrowed scratch survives.
        release(){if(!released){released=true;snapshot.release();owned.forEach(b=>b.destroy());}},
      });
    } catch(e) {snapshot?.release();owned.forEach(b=>b.destroy());throw e;}
  }
  return Object.freeze({g:grid,layouts,pickLayouts,pointLayouts,pipeline,pipelineState,viewReady,pickState,plainPickState,pickPipelineState,
    pointState,pointReady,prepare,ready:pickReady,
    dispose(){dead=true;/* candidates own their pinned lifetimes; no shared resource mutation */}});
}
