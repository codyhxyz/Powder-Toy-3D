// World-owned packed histories. Birth is explicit initialization, not replay.
import { GI_BG_EVERY, GI_SRC_EVERY, GI_SETTLE } from '../shaders/gi.js';
import { GI_NEAR_DILATE, GI_RECENT } from '../shaders/fields.js';
import { uint, frozenArray, worldLightingIndex, worldLightingNear } from '../gfx/worldLightingBatch.js';
const same = (a,b) => a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
const copyLamp = l => ({pos:Array.from(l.pos,Math.fround),col:Array.from(l.col,Math.fround),shape:Array.from(l.shape,Math.fround)});
const lampEqual = (a,b) => !!a && !!b && ['pos','col','shape'].every(k=>same(a[k],b[k]));
import { validateWorldSourceCut } from './sourceCut.js';
import { _issueWorldLightingRestore, validateWorldLightingRestore } from './worldLightingRestore.js';
export { validateWorldLightingRestore } from './worldLightingRestore.js';
const manifests = new WeakMap();

// Only the real ledger can issue a seed declaration. Caller metadata alone is
// insufficient authority to turn a missing previous probe into initialized GI.
export function validateWorldGIInitialization(manifest,{epoch,lightingTick,sourceIndices=[],probeIndices=[],previousToken,cutToken,sourcePhaseToken}={}) {
  const m=manifests.get(manifest);
  if(!m || !m.valid() || epoch!==manifest.epoch || lightingTick!==manifest.birthTick || previousToken!==manifest.previousToken || cutToken!==manifest.cutToken) throw new Error('invalid/stale world GI birth manifest');
  if(sourceIndices.some(i=>!m.sources.has(i)) || probeIndices.some(i=>!m.probes.has(i))) throw new Error('GI jobs outside initialization transaction');
  if(m.sameClock && sourceIndices.some(i=>m.knownSources.has(i))) throw new Error('same-clock initialization cannot recompute retained sources');
  if(probeIndices.length && !same([...sourceIndices].sort((a,b)=>a-b),[...m.sources].sort((a,b)=>a-b)) && (!m.sourcesDone() || sourcePhaseToken!==manifest.sourcePhaseToken)) throw new Error('entire private SOURCE phase must complete before any gather slab');
  return manifest;
}

/** Original world-fixed selector. near is an actual lighting declaration, never physics distance. */
export function selectWorldGI({records,lightingTick,mode=0,settle=0,lampSpheres=[],allSources=false}) {
  if(!uint(lightingTick)||![0,1,2].includes(mode)||!uint(settle))throw new TypeError('world GI selection clock/mode');
  const sourceBricks=[],gatherBricks=[];
  for(const r of records){
    if(!Array.isArray(r.brick)||r.brick.length!==3||r.brick.some(n=>!uint(n))||!uint(r.age)||typeof r.matter!=='boolean'||typeof r.near!=='boolean')throw new TypeError('complete world GI age/matter/near record required');
    const [x,y,z]=r.brick,board=((x+y+z+lightingTick%2)&1)===1;
    const lampNear=lampSpheres.some(s=>{const d=s.pos.map((v,k)=>v-Math.max(r.brick[k]*4,Math.min(r.brick[k]*4+4,v)));return d.reduce((a,v)=>a+v*v,0)<=s.radius*s.radius;});
    const near=r.near||lampNear;let source,probe,background=false;
    if(mode===2){source=true;probe=true;}
    else if(mode!==0||settle!==0){source=true;probe=board;}
    else{source=r.age===0||r.matter&&(near||((x&1)|((z&1)<<1))===lightingTick%GI_SRC_EVERY);probe=near?board:((x&1)|((y&1)<<1)|((z&1)<<2))===lightingTick%GI_BG_EVERY;background=!near;}
    if(source||allSources)sourceBricks.push(frozenArray(r.brick));
    // Metadata and SOURCE dependencies are not necessarily probe recipients.
    // Omission preserves the original selector contract for existing callers.
    if(probe&&r.probeEligible!==false)gatherBricks.push(Object.freeze({brick:frozenArray(r.brick),background}));
  }
  return Object.freeze({sourceBricks:frozenArray(sourceBricks),gatherBricks:frozenArray(gatherBricks)});
}

export function createWorldLightingHistory({worldSize,epoch,sourceOwner=null,configuration=null}={}){
  if(!Array.isArray(worldSize)||worldSize.length!==3||worldSize.some(n=>!uint(n)||!n||n%4)||!uint(epoch)||!epoch)throw new TypeError('world history epoch/size');
  const size=frozenArray(worldSize),probes=new Map(),sources=new Map(),births=new Map(),changed=new Map();
  let previous=new Map(),previousToken=null,committedCut=null,tick=-1,revision=0,settle=0,key=[],lamps=[],pending=null,dead=false;
  let publicationToken=Object.freeze({epoch,lightingTick:tick,revision});
  const alive=()=>{if(dead)throw new Error('world lighting history disposed');};
  const index=b=>worldLightingIndex(size,Array.isArray(b)?b:b.brick);
  const brick=i=>[i%(size[0]/4),Math.floor(i/(size[0]/4))%(size[1]/4),Math.floor(i/(size[0]/4)/(size[1]/4))];
  const drop=map=>{map.forEach(p=>p.output.release());map.clear();};
  const clone=map=>{const next=new Map();try{for(const [i,p]of map)next.set(i,{...p,output:p.output.retain()});}catch(e){drop(next);throw e;}return next;};
  function captured(map,token,at,indices,zeros=new Set(),manifest=null){
    const held=new Map();
    try{for(const i of indices){if(!uint(i)||i>=size[0]/4*(size[1]/4)*(size[2]/4))throw new RangeError('world history index');if(held.has(i)||zeros.has(i))continue;const p=map.get(i);if(!p)throw new Error(`unknown world GI history ${i}: explicit initialization required`);held.set(i,{...p,output:p.output.retain()});}}catch(e){drop(held);throw e;}
    let released=false;
    return Object.freeze({complete:true,token,lightingTick:at,resetSeed:at===-1,initialization:manifest,
      bindingsFor(i){if(released||!held.has(i))throw new Error('uncaptured previous probe');const p=held.get(i);return Object.freeze({...p.output.bindings(),slot:p.slot,count:p.count});},
      recordHistory(frame,{indices:requested,destination,format}){
        if(released||format!=='band-major-4x-vec2u'||requested.some(i=>!held.has(i)&&!zeros.has(i)))throw new Error('uncaptured/released exact previous history');
        const encoder=frame.direct();requested.forEach((i,slot)=>{const p=held.get(i);for(let k=0;k<4;k++){const to=(k*requested.length+slot)*8;if(zeros.has(i))encoder.clearBuffer(destination,to,8);else encoder.copyBufferToBuffer(p.output.bindings().history,(k*p.count+p.slot)*8,destination,to,8);}});
      },release(){if(!released){released=true;drop(held);}}
    });
  }
  function issueRestore({cut,configVersion,sourceIndices=[],probeIndices=[]},sourceMap=sources,probeMap=probes,ownership=publicationToken,extraValid=()=>ownership===publicationToken,sourcePhaseToken=null){
    alive();
    const check=()=>{alive();if(!sourceOwner||!configuration||configVersion==null)throw new Error('restore requires ledger Source owner/configuration');validateWorldSourceCut(cut,{sourceOwner,epoch,configuration});if(!same(sourceOwner.win.size,size))throw new Error('restore Source world size mismatch');};
    check();
    const publication=Object.freeze({meaning:'current-cut-validation',epoch,sourceRevision:cut.contentToken.sourceRevision,cutIdentity:cut.identity,configuration,configVersion,sourcePhaseToken,sourceIndices:frozenArray(sourceIndices),probeIndices:frozenArray(probeIndices)});
    const leases=[];
    try{for(const [kind,ids,map]of [['source',sourceIndices,sourceMap],['gi',probeIndices,probeMap]])for(const i of new Set(ids)){
      const p=map.get(i);if(!p)throw new Error(`unknown retained ${kind} ${i}`);
      if(p.output.token.epoch!==epoch)throw new Error('restore output epoch mismatch');
      const make=()=>{
        check();const output=p.output.retain(),native=output.bindings(),token=output.token;let released=false;
        const buffer=kind==='source'?native.source:native.history;
        const ranges=frozenArray(kind==='source'?[Object.freeze({from:p.slot*16,to:0,size:16})]:Array.from({length:4},(_,k)=>Object.freeze({from:(k*p.count+p.slot)*8,to:k*8,size:8})));
        const provenance=Object.freeze({schema:'world-packed-source-gi-v1',kind,index:i,computeToken:token,previousHistoryToken:token.previousToken,historyOwnershipToken:ownership,publication,nativeBuffer:buffer,ranges});
        const lease=Object.freeze({kind,index:i,token,publication,provenance,bindings(){validateWorldLightingRestore(lease);return Object.freeze({buffer,ranges});},retain(){validateWorldLightingRestore(lease);return make();},release(){if(!released){released=true;output.release();}}});
        _issueWorldLightingRestore(lease,{size,check,valid:()=>!released&&!dead&&extraValid()});return lease;
      };leases.push(make());
    }}catch(e){leases.forEach(l=>l.release());throw e;}
    let released=false;
    return Object.freeze({publication,leases:frozenArray(leases),release(){if(!released){released=true;leases.forEach(l=>l.release());}}});
  }
  function transaction({lightingTick,selection,nextKey=key,nextLamps=lamps,nextSettle=settle,cutToken=null,sameClock=false,initialization=false,records=[]}){
    if(pending)throw new Error('world lighting tick already planned');
    const sourceIDs=new Set(selection.sourceBricks.map(index)),probeIDs=new Set(selection.gatherBricks.map(index)),background=new Map(selection.gatherBricks.map(r=>[index(r),r.background===true]));
    const born=new Set(),declarations=new Map(records.map(r=>[index(r),Object.freeze({...r,brick:frozenArray(r.brick)})]));
    const staged=[],stagedSources=new Set(),stagedProbes=new Set();let consumed=false,version=0,sealed=false,manifest=null;
    const prevMap=sameClock?previous:probes,prevToken=sameClock?previousToken:publicationToken;
    const valid=()=>!dead&&!consumed&&pending===plan;
    const sourcesDone=()=>same([...sourceIDs].sort((a,b)=>a-b),[...stagedSources].sort((a,b)=>a-b));
    function updateManifest(){
      if(!initialization)return;
      const v=++version;
      manifest=Object.freeze({epoch,birthTick:lightingTick,cutToken,previousToken:prevToken,identity:Object.freeze({epoch,revision,version:v}),sourcePhaseToken:Object.freeze({epoch,revision,version:v}),indices:frozenArray([...born].sort((a,b)=>a-b))});
      manifests.set(manifest,{valid:()=>valid()&&version===v,sources:sourceIDs,probes:probeIDs,knownSources:sources,sameClock,sourcesDone});
    }
    function expand({sourceBricks=[],probeBricks=[],records:moreRecords=[]}={}){
      alive();if(!valid()||sealed)throw new Error('closed initialization transaction');
      if(!initialization)throw new Error('explicit initialization transaction required');
      const addSources=sourceBricks.map(index),addProbes=probeBricks.map(index);
      if(new Set(addSources).size!==addSources.length||new Set(addProbes).size!==addProbes.length)throw new Error('duplicate initialization declaration');
      if(addProbes.some(i=>probes.has(i)||born.has(i)))throw new Error('cannot initialize an existing/duplicate world probe');
      if(sameClock&&addSources.some(i=>sources.has(i)))throw new Error('same-clock initialization cannot recompute retained sources');
      const preparedRecords=moreRecords.map(r=>{
        selectWorldGI({records:[r],lightingTick});
        return [index(r),Object.freeze({...r,brick:frozenArray(r.brick)})];
      });
      // Expansion invalidates private work, never committed authoritative history.
      staged.splice(0).forEach(o=>o.release());stagedSources.clear();stagedProbes.clear();
      addSources.forEach(i=>sourceIDs.add(i));addProbes.forEach(i=>{born.add(i);probeIDs.add(i);background.set(i,false);});
      for(const [i,r]of preparedRecords)declarations.set(i,r);
      updateManifest();return plan;
    }
    function stage(output){
      alive();if(!valid()||sealed||!output?.retain||output.token?.epoch!==epoch||output.token.lightingTick!==lightingTick)throw new Error('completed output for active world transaction required');
      if(initialization&&(output.token.initialization!==manifest||output.token.previousToken!==prevToken||output.token.sourceContentToken!==cutToken))throw new Error('output birth/cut/previous provenance mismatch');
      if(!initialization&&lightingTick>0&&output.token.previousToken!==prevToken)throw new Error('output must retain the exact previous world history declaration');
      const ids=Array.from(output.sources),ps=Array.from(output.probes);
      if(ids.some(i=>!sourceIDs.has(i)||stagedSources.has(i))||ps.some(i=>!probeIDs.has(i)||stagedProbes.has(i))||new Set(ids).size!==ids.length||new Set(ps).size!==ps.length)throw new Error('duplicate/outside world transaction output');
      if(ps.length&&!sourcesDone()&&!same([...ids].sort((a,b)=>a-b),[...sourceIDs].filter(i=>!stagedSources.has(i)).sort((a,b)=>a-b)))throw new Error('entire SOURCE phase must finish before gather');
      const ref=staged[0]?.token;
      if(ref&&['sourceRevision','sourceContentToken','fieldPublishedToken','logicalFieldTick','previousToken','configVersion','dependencySetID','dependencyVersion'].some(k=>output.token[k]!==ref[k]))throw new Error('incompatible world output slabs');
      const retained=output.retain();staged.push(retained);ids.forEach(i=>stagedSources.add(i));ps.forEach(i=>stagedProbes.add(i));return plan;
    }
    const plan=Object.freeze({epoch,lightingTick,sameClock,
      get sourceBricks(){return frozenArray([...sourceIDs].sort((a,b)=>a-b).map(i=>frozenArray(brick(i))));},
      get gatherBricks(){return frozenArray([...probeIDs].sort((a,b)=>a-b).map(i=>Object.freeze({brick:frozenArray(brick(i)),background:background.get(i)===true})));},
      get initialization(){return manifest;},get sourcesComplete(){return sourcesDone();},
      expand,
      expandFeedback(feedback){
        if(!initialization||!Array.isArray(feedback?.requirements))throw new TypeError('complete typed world feedback required');
        const sourceBricks=[],probeBricks=[],restore=[],requirements=[];
        for(const r of feedback.requirements){if(!uint(r.index)||!uint(r.channels)||r.channels<1||r.channels>63)throw new TypeError('typed world requirement');const b=brick(r.index);worldLightingIndex(size,b);if(r.channels&8){if(sameClock&&sources.has(r.index))restore.push(r);else sourceBricks.push(b);}if(r.channels&16){if(probes.has(r.index))restore.push(r);else if(!born.has(r.index))probeBricks.push(b);}if(r.channels&~24)requirements.push(r);}
        // Typed source misses must be reconstructed; they are never zero seeds.
        expand({sourceBricks:[...new Map(sourceBricks.map(b=>[b.join(','),b])).values()],probeBricks:[...new Map(probeBricks.map(b=>[b.join(','),b])).values()]});
        return Object.freeze({restore:frozenArray(restore),requirements:frozenArray(requirements),initialization:manifest});
      },
      capturePrevious({indices=[...probeIDs]}={}){alive();if(!valid())throw new Error('closed initialization transaction');return captured(prevMap,prevToken,lightingTick-1,indices,born,manifest);},
      stage,
      captureRestore({cut,configVersion,sourceIndices=[],probeIndices=[],sourcePhase=false}={}){
        alive();if(!valid())throw new Error('closed restore transaction');
        const v=version, merged=new Map(sources);
        if(sourcePhase){
          if(!sourcesDone())throw new Error('complete private SOURCE phase required');
          for(const o of staged)for(let slot=0;slot<o.sources.length;slot++)merged.set(o.sources[slot],{output:o,slot,count:o.sources.length});
          if([...sourceIDs].some(i=>!sourceIndices.includes(i)))throw new Error('private SOURCE publication must include ALL selected sources');
          for(const i of sourceIDs){const t=merged.get(i).output.token;if(t.sourceContentToken!==cut.contentToken||t.configVersion!==configVersion)throw new Error('staged SOURCE current cut/config mismatch');}
        }
        return issueRestore({cut,configVersion,sourceIndices,probeIndices},merged,prevMap,prevToken,()=>valid()&&version===v,sourcePhase?(manifest?.sourcePhaseToken??plan):null);
      },
      captureStagedSources(){
        alive();if(!valid()||!initialization||!sourcesDone())throw new Error('complete private SOURCE phase required');
        const outputs=[];try{for(const o of staged)if(o.sources.length)outputs.push(o.retain());}catch(e){outputs.forEach(o=>o.release());throw e;}
        let released=false;return Object.freeze({complete:true,token:manifest.sourcePhaseToken,outputs:frozenArray(outputs),release(){if(!released){released=true;outputs.forEach(o=>o.release());}}});
      },
      seal({cutToken:cut,feedback}={}){alive();if(!valid()||!initialization||cut!==cutToken||feedback?.incomplete!==false||!Array.isArray(feedback.requirements)||feedback.requirements.length||feedback.sun?.length||!sourcesDone()||!same([...probeIDs].sort((a,b)=>a-b),[...stagedProbes].sort((a,b)=>a-b)))throw new Error('complete source/gather and dependency closure required');if([...born].some(i=>!declarations.has(i)))throw new Error('actual age/matter/near declaration required for every birth');sealed=true;return plan;},
      commit(outputOrSlabs){
        alive();if(!valid())throw new Error('stale/duplicate world history commit');
        if(outputOrSlabs!==undefined){for(const o of Array.isArray(outputOrSlabs)?outputOrSlabs:[outputOrSlabs])stage(o);}
        if(initialization&&!sealed)throw new Error('initialization closure must be sealed before adoption');
        if(!sourcesDone()||!same([...probeIDs].sort((a,b)=>a-b),[...stagedProbes].sort((a,b)=>a-b)))throw new Error('completed outputs must cover the entire world selection exactly once');
        if([...probeIDs].some(i=>!probes.has(i)&&lightingTick!==0&&!born.has(i)))throw new Error('never-owned world probe requires explicit initialization');
        if([...born].some(i=>!declarations.has(i)))throw new Error('actual age/matter/near declaration required for every birth');
        const additions=[],sourceAdds=[];let prior=null;
        try{if(!sameClock)prior=clone(probes);for(const output of staged){for(let slot=0;slot<output.probes.length;slot++)additions.push([output.probes[slot],{output:output.retain(),slot,count:output.probes.length}]);for(let slot=0;slot<output.sources.length;slot++)sourceAdds.push([output.sources[slot],{output:output.retain(),slot,count:output.sources.length}]);}}
        catch(e){if(prior)drop(prior);for(const [,p]of [...additions,...sourceAdds])p.output.release();throw e;}
        if(prior){drop(previous);previous=prior;previousToken=publicationToken;}
        for(const [i,p]of additions){probes.get(i)?.output.release();probes.set(i,p);if(!births.has(i))births.set(i,Object.freeze({birthTick:lightingTick,record:declarations.get(i)??null}));}
        for(const [i,p]of sourceAdds){sources.get(i)?.output.release();sources.set(i,p);}
        if(!sameClock){tick=lightingTick;settle=Math.max(0,nextSettle-1);key=nextKey;lamps=nextLamps;}
        committedCut=cutToken??staged[0]?.token.sourceContentToken??committedCut;revision++;publicationToken=Object.freeze({epoch,lightingTick:tick,revision});consumed=true;pending=null;staged.splice(0).forEach(o=>o.release());
        for(const [i,c]of changed)if(lightingTick-c.tick>=GI_RECENT)changed.delete(i);
      },
      abort(){if(valid()){consumed=true;pending=null;staged.splice(0).forEach(o=>o.release());}}
    });
    pending=plan;updateManifest();return plan;
  }
  function begin({lightingTick,globalKey,records,mode=0,currentLamps=[],allSources=false,initialization=null}){
    alive();if(!uint(lightingTick)||lightingTick!==tick+1)throw new Error('logical lighting tick must advance exactly once; retry same uncommitted plan');
    if(mode===2&&lightingTick!==0)throw new Error('original reset only at scene epoch tick0, never on arrival');
    if(!Array.isArray(globalKey)&&!(globalKey instanceof Uint32Array))throw new TypeError('immutable global light key words required');
    const nextKey=Array.from(globalKey);if(!nextKey.every(uint))throw new TypeError('global light key bits');
    const provided=new Set(records.map(index));if(provided.size!==records.length)throw new Error('duplicate world GI record');if([...probes.keys()].some(i=>!provided.has(i)))throw new Error('ordinary selection must include every owned offscreen probe');
    const nextLamps=currentLamps.map(copyLamp),spheres=[];
    for(let i=0;i<Math.max(lamps.length,nextLamps.length);i++)if(!lampEqual(lamps[i],nextLamps[i]))for(const l of [lamps[i],nextLamps[i]])if(l)spheres.push({pos:l.pos.slice(0,3),radius:l.pos[3]+l.shape[0]+.5*l.shape[1]+2});
    const nextSettle=mode!==0||!same(key,nextKey)?GI_SETTLE:settle;
    const nearRecent=worldLightingNear(size,[...changed.values()].filter(c=>c.tick<=lightingTick&&lightingTick-c.tick<GI_RECENT).map(c=>c.brick),GI_NEAR_DILATE);
    const effective=records.map(r=>({...r,age:births.has(index(r))?Math.min(r.age,lightingTick-births.get(index(r)).birthTick):r.age,near:!!(r.near||nearRecent(r.brick))}));
    const selection=selectWorldGI({records:effective,lightingTick,mode,settle:nextSettle,lampSpheres:spheres,allSources});
    const plan=transaction({lightingTick,selection,nextKey,nextLamps,nextSettle,records,initialization:!!initialization,cutToken:initialization?.cutToken??null});
    if(initialization){try{plan.expand(initialization);}catch(e){plan.abort();throw e;}}
    return plan;
  }
  function beginBirth({lightingTick=tick,cutToken,sourceBricks=[],probeBricks=[],records=[]}={}){
    alive();if(tick<0||lightingTick!==tick||cutToken==null||cutToken!==committedCut)throw new Error('same-clock birth requires the committed cut');
    const plan=transaction({lightingTick,selection:{sourceBricks:[],gatherBricks:[]},sameClock:true,initialization:true,cutToken,records});
    try{plan.expand({sourceBricks,probeBricks,records});}catch(e){plan.abort();throw e;}return plan;
  }
  return Object.freeze({begin,beginBirth,captureRestore:options=>issueRestore(options),
    capture({lightingTick,indices}){alive();if(lightingTick!==tick)throw new Error('history capture must name the exact previous world clock');return captured(probes,publicationToken,tick,indices);},
    captureSources({indices}){alive();const held=new Map();try{for(const i of indices){const p=sources.get(i);if(!p)throw new Error('unknown retained GI source');if(!held.has(i))held.set(i,{...p,output:p.output.retain()});}}catch(e){drop(held);throw e;}let released=false;return Object.freeze({token:publicationToken,lightingTick:tick,bindingsFor(i){if(released||!held.has(i))throw new Error('uncaptured retained source');const p=held.get(i);return Object.freeze({buffer:p.output.bindings().source,byteOffset:p.slot*16,token:p.output.token});},release(){if(!released){released=true;drop(held);}}});},
    get lightingTick(){return tick;},get epoch(){return epoch;},get token(){return publicationToken;},
    birth(index){alive();return births.get(index)??null;},
    noteChanged(bricks,atTick){alive();if(!uint(atTick)||atTick<tick)throw new Error('world change tick regression');for(const b of bricks)changed.set(index(b),{brick:frozenArray(b),tick:atTick});},
    dispose(){if(dead)return;pending?.abort();dead=true;drop(probes);drop(previous);drop(sources);births.clear();}
  });
}
