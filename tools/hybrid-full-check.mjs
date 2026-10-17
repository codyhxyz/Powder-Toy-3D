// One guarded native slot. No performance conclusion from this correctness test.
import assert from 'node:assert/strict';
import { launchBrowser,newTestPage,ready,gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { watchFailures,validateFixture,FIXTURE_COMPONENTS } from './harness/hybrid-full.js';
import { rewriteOpticsDiagnostic } from './harness/hybrid-optics-diagnostic.js';
validateFixture(); // pure preconditions must fail before taking a GPU slot
const args=process.argv.slice(2);
const flags=new Set(args);
const componentModes=FIXTURE_COMPONENTS.map(c=>`--control=${c}`);
const modes=['--readback-only','--readback-controls','--mixed-readback-controls','--motion-only','--opaque-control','--component-controls',...componentModes];
const diagnostics=['--no-taa','--split-render','--skip-optics-draw','--optics-unlit-hit','--optics-sky-reflection','--optics-point-probe','--optics-full-probe','--optics-sweep'];
const areaArg=args.find(a=>a.startsWith('--sweep-area=')),tileArg=args.find(a=>a.startsWith('--sweep-tile='));
const limitArg=args.find(a=>a.startsWith('--optics-step-limit=')),stepLimit=limitArg?Number(limitArg.slice(20)):null;
const traceExit=flags.has('--optics-sweep')&&stepLimit!==null;
const sweepArea=areaArg?areaArg.slice(13).split(',').map(Number):[0,0,800,600],sweepTile=tileArg?Number(tileArg.slice(13)):32;
assert(sweepArea.length===4&&sweepArea.every(Number.isInteger)&&sweepArea[0]>=0&&sweepArea[1]>=0&&sweepArea[2]>0&&sweepArea[3]>0
  &&sweepArea[0]+sweepArea[2]<=800&&sweepArea[1]+sweepArea[3]<=600&&Number.isInteger(sweepTile)&&sweepTile>=1&&sweepTile<=128
  &&(!(areaArg||tileArg||limitArg)||flags.has('--optics-sweep'))
  &&(!flags.has('--sweep-native')||(flags.has('--optics-sweep')&&!limitArg))
  &&(!flags.has('--metal-validation')||(flags.has('--optics-sweep')&&flags.has('--sweep-native')))
  &&(!flags.has('--sweep-runtime-gi')||(flags.has('--optics-sweep')&&!flags.has('--sweep-native')&&!limitArg))
  &&(!flags.has('--sweep-unlit-surfaces')||(flags.has('--optics-sweep')&&!flags.has('--sweep-native')&&!flags.has('--sweep-runtime-gi')&&!limitArg))
  &&(stepLimit===null||(Number.isInteger(stepLimit)&&stepLimit>=0&&stepLimit<=24832)),'Invalid optical sweep region/tile/limit');
assert(flags.size===args.length&&args.every(arg=>[...modes,'--gpudebug','--chrome','--test-view','--sweep-native','--metal-validation','--sweep-runtime-gi','--sweep-unlit-surfaces',...diagnostics,areaArg,tileArg,limitArg].includes(arg))
  &&modes.filter(mode=>flags.has(mode)).length<=1
  &&diagnostics.filter(mode=>flags.has(mode)).length<=1
  &&!(diagnostics.some(mode=>flags.has(mode))&&modes.some(mode=>flags.has(mode)&&!componentModes.includes(mode))),
  `Usage: node tools/hybrid-full-check.mjs [--control=opaque|smooth|media|optics|particles] [--chrome] [--test-view] [${diagnostics.join(' | ')}]`);
const readbackOnly=flags.has('--readback-only'),motionOnly=flags.has('--motion-only'),mixed=flags.has('--mixed-readback-controls');
const controls=mixed||flags.has('--readback-controls'),debug=flags.has('--gpudebug');
const entry=renderer=>renderer==='hybrid'&&flags.has('--test-view')?'view=test':`renderer=${renderer}&view=realistic`;
const vite=await startVite({port:58476,harness:true});
let browser,started,diagnosticPage;
let errors=[],offlineRelay=[];
const phase=message=>console.log(`[hybrid correctness] ${message}`);
try{
  phase('browser startup');
  started=Date.now();browser=await launchBrowser({lifetimeMs:25000,
    ...(flags.has('--chrome')?{channel:'chrome'}:{}),
    ...(flags.has('--metal-validation')?{args:['--enable-dawn-features=use_user_defined_labels_in_backend'],env:{...process.env,
      MTL_SHADER_VALIDATION:'1',MTL_SHADER_VALIDATION_DEFAULT_STATE:'none',
      MTL_SHADER_VALIDATION_ENABLE_PIPELINES:['hybrid optics',...Array.from({length:8},(_,i)=>`sim${i} hybrid optics`)]
        .map(name=>`Dawn_RenderPipeline_${name}`).join(','),MTL_SHADER_VALIDATION_DUMP_PIPELINES:'1',
      MTL_SHADER_VALIDATION_ENABLE_ERROR_REPORTING:'1',
      MTL_SHADER_VALIDATION_REPORT_TO_STDERR:'1',MTL_SHADER_VALIDATION_ABORT_ON_FAULT:'1'}}:{}),
    browserLog:line=>console.error(`[native browser] ${line}`)});
  if(controls){
    const results=[];
    for(const renderer of ['legacy','hybrid']){
      phase(`${mixed?'mixed-scene':'empty-frame'} readback control: ${renderer}`);
      const page=await newTestPage(browser,{mode:'manual',viewport:{width:800,height:600}});
      const failures=watchFailures(page);({errors,offlineRelay}=failures);
      try{
        await page.routeWebSocket(/.*/,()=>{});
        await failures.check(page.goto(vite.url(`/?${entry(renderer)}&test=manual&size=128&preset=empty&paused=1${debug?'&gpudebug=1':''}`)));
        await failures.check(ready(page));
        const result=await failures.check(page.evaluate(async mixed=>{
          const h=await import('/tools/harness/hybrid-full.js');return h.sceneReadbackControl(window.__app,mixed);
        },mixed));
        assert.equal(result.hybrid,renderer==='hybrid');
        assert.equal(errors.length,0,errors.join('\n'));
        results.push({renderer,...result});
      }finally{await page.close();}
    }
    console.log(JSON.stringify({passed:true,debug,validation:`${mixed?'mixed-scene':'empty-render'} readback controls only`,results},null,2));
  }else{
  const page=await newTestPage(browser,{mode:'manual',viewport:{width:800,height:600}});
  diagnosticPage=page;
  const failures=watchFailures(page);
  ({errors,offlineRelay}=failures);
  page.on('console',m=>{
    if(m.text().startsWith('[hybrid correctness]'))console.log(m.text());
  });
  const hookDiagnostic=flags.has('--sweep-unlit-surfaces')?'unlit-surfaces':flags.has('--sweep-runtime-gi')?'runtime-gi':flags.has('--sweep-native')?null:flags.has('--optics-point-probe')||flags.has('--optics-full-probe')||flags.has('--optics-sweep')?'steps':flags.has('--optics-unlit-hit')?'hit':flags.has('--optics-sky-reflection')?'reflection':null;
  if(hookDiagnostic)await page.addInitScript({content:`{
    const rewrite=${rewriteOpticsDiagnostic.toString()},variant=${JSON.stringify(hookDiagnostic)};
    const create=GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule=function(desc){
      const code=rewrite(desc.code,variant,${JSON.stringify(stepLimit)},${JSON.stringify(traceExit)});
      if(code!==desc.code)console.info('[hybrid correctness] diagnostic shader instrumentation; not full-quality acceptance');
      return create.call(this,{...desc,code});
    };
  }`});
  await page.routeWebSocket(/.*/,()=>{});
  phase('page navigation');
  await failures.check(page.goto(vite.url(`/?${entry('hybrid')}&test=manual&size=128&preset=empty&paused=1${debug?'&gpudebug=1':''}`)));
  phase('app initialization');
  await failures.check(ready(page));
  const result=await failures.check(page.evaluate(async ({only,motion,noTaa,splitRender,skipOptics,pointProbe,fullProbe,sweep,sweepNative,sweepRuntimeGI,sweepUnlit,sweepArea,sweepTile,traceExit,component,series})=>{
    const h=await import('/tools/harness/hybrid-full.js'),a=window.__app;
    if(sweep){
      a.test.park();a.settings.paused=true;a.settings.upscale='native';a.autoRes.enabled=false;a.autoRes.scale=1;
      a.day.fixed={az:215,el:38};await h.resetFixture(a);h.paintFixture(a,{component});
      await a.test.ready();await a.gpu.fence();
      const gpu=a.gpu,optics=a.hybrid.optics,record=optics.record,render=gpu.frame.render;
      let input,clone,preparing=true,rect,completed=0;const records=[];
      const sentinel=gpu.createBuffer({label:'optics sweep sentinel',size:16,usage:128|4|8});
      const results=gpu.createBuffer({label:'optics sweep metadata',size:32,usage:128|4});
      const layout=gpu.layout('OPTICS_SWEEP_PROBE',[
        {binding:0,visibility:4,texture:{sampleType:'unfilterable-float'}},
        {binding:1,visibility:4,buffer:{type:'read-only-storage'}},{binding:2,visibility:4,buffer:{type:'storage'}},
      ]);
      const code=`@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read> args:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(1) fn main(){
  let m=bitcast<vec4u>(textureLoad(source,vec2i(i32(args[0]),i32(args[1])),0));
  for(var i=0u;i<4u;i++){output[i]=m[i];output[i+4u]=args[i];}
}`;
      const probe=gpu.kernel({name:'optics sweep probe',code,layouts:[layout],workgroupSize:[1,1,1]});await probe.ready;
      gpu.frame.render=function(...args){
        const rp=render.apply(this,args);
        if(args[1]==='hybrid optics'){
          if(preparing)rp.draw=()=>{};else rp.setScissorRect(...rect);
        }
        return rp;
      };
      optics.record=function(frame){
        if(!input){
          if(sweepRuntimeGI&&frame.color.width!==800)throw new Error('Runtime GI diagnostic requires exactly 800 pixels / 100 = 8 corners');
          if(!(frame.color.usage&1))throw new Error('Sweep needs a copyable opaque color');
          clone=gpu.createTexture({label:'optics sweep immutable opaque color',size:[frame.color.width,frame.color.height],format:frame.color.format,usage:6});
          gpu.frame.direct().copyTextureToTexture({texture:frame.color},{texture:clone},[frame.color.width,frame.color.height,1]);
          input={...frame,color:clone};
        }
        return record.call(this,frame);
      };
      try{
        for(let attempt=0;attempt<6&&!input;attempt++){await a.test.renderOnce();await a.test.ready();await gpu.fence();}
        if(!input)throw new Error('Sweep could not capture the optical input');
        optics.record=record;preparing=false;
        const group=gpu.bindGroup(layout,[{binding:0,resource:optics.output.metadata.createView()},
          {binding:1,resource:{buffer:sentinel}},{binding:2,resource:{buffer:results}}]);
        for(let y=sweepArea[1];y<sweepArea[1]+sweepArea[3];y+=sweepTile)for(let x=sweepArea[0];x<sweepArea[0]+sweepArea[2];x+=sweepTile){
          rect=[x,y,Math.min(sweepTile,sweepArea[0]+sweepArea[2]-x),Math.min(sweepTile,sweepArea[1]+sweepArea[3]-y)];
          console.info(`[hybrid correctness] sweep rectangle ${JSON.stringify(rect)}`);
          record.call(optics,input);
          const expected=new Uint32Array([x,y,completed+1,0x51ec8a34]);
          const data=await h.checkedRead(gpu,'optics sweep hardware fence',()=>{
            gpu.write(sentinel,0,expected);probe.dispatch(gpu.frame,[1,1,1],{bind:[group]});
            return gpu.readback.buffer(results,0,32);
          });
          if(new Uint32Array(data,16,4).some((v,i)=>v!==expected[i]))throw new Error('Sweep sentinel mismatch');
          const m=new Float32Array(data,0,4);records.push(sweepNative||sweepRuntimeGI||sweepUnlit?{rect:[...rect],metadata:[...m]}:
            {rect:[...rect],...(traceExit?{exitReason:m[0]}:{depth:m[0]}),stalls:m[1],invalid:m[2],iterations:m[3]});
          completed++;
        }
        if(sweepNative||sweepRuntimeGI||sweepUnlit)return{steps:a.sim.frame,completedRectangles:completed,shaderRewritten:!sweepNative,records};
        return{steps:a.sim.frame,completedRectangles:completed,
          ...(traceExit?{exitReasons:{0:'budget/pre-loop',1:'path-budget',2:'interfaces',3:'outside-grid',4:'unsupported-surface',5:'opaque-hit',6:'molten',7:'opaque-cut',8:'bounds-exit'}}:{}),
          longest:records.sort((a,b)=>b.iterations-a.iterations).slice(0,12),
          stalled:records.filter(r=>r.stalls>0),invalid:records.filter(r=>r.invalid>0)};
      }finally{optics.record=record;gpu.frame.render=render;clone?.destroy();sentinel.destroy();results.destroy();}
    }
    let points=[];
    if(pointProbe){
      const frame=a.gpu.frame,render=frame.render;
      frame.render=function(...args){
        const rp=render.apply(this,args);
        if(args[1]==='hybrid optics'){
          points=[[67,20,84],[45,20,84],[80,12,75],[64,37,70]].map(p=>{
            const q=new a.THREE.Vector3(...p).applyMatrix4(a.volume.matrixWorld).project(a.camera);
            return[Math.max(0,Math.min(799,Math.floor((q.x*.5+.5)*800))),Math.max(0,Math.min(599,Math.floor((.5-q.y*.5)*600)))];
          });
          for(let y=0;y<24;y++)for(let x=0;x<32;x++)points.push([Math.floor((x+.5)*800/32),Math.floor((y+.5)*600/24)]);
          const draw=rp.draw.bind(rp);
          rp.draw=(...drawArgs)=>{for(const [x,y]of points){rp.setScissorRect(x,y,2,2);draw(...drawArgs);}};
        }
        return rp;
      };
    }
    if(noTaa)a.post.settings.taa=false;
    if(skipOptics){
      const frame=a.gpu.frame,render=frame.render;
      frame.render=function(...args){
        const rp=render.apply(this,args);
        if(args[1]==='hybrid optics'){
          rp.draw=()=>{};
          console.info('[hybrid correctness] diagnostic: omitted bulk optics draw; coverage assertions must fail');
        }
        return rp;
      };
    }
    if(splitRender){
      const frame=a.gpu.frame,render=frame.render;
      frame.render=function(...args){
        const rp=render.apply(this,args),end=rp.end;
        rp.end=()=>{end();a.gpu.flush('diagnostic render boundary');};
        return rp;
      };
    }
    if(motion)return h.probeMotionWrites(a);
    if(only){a.test.park();await a.test.ready();return{readback:await h.verifyReadback(a.gpu)};}
    if(series){
      const results=[];
      for(const component of h.FIXTURE_COMPONENTS.filter(c=>c!=='opaque')){
        try{
          results.push(await h.run(a,{component}));
          console.info(`[hybrid correctness] ${component} control passed`);
        }catch(error){throw new Error(`${component} control failed: ${error.message}`);}
      }
      return{steps:a.sim.frame,componentControls:results};
    }
    if(!pointProbe&&!fullProbe)return h.run(a,{component});
    let expectedAssertion;
    try{await h.run(a,{component});}catch(error){
      if(!error.message.includes('control needs reusable motion'))throw error;
      expectedAssertion=error.message;
    }
    const gpu=a.gpu;
    if(fullProbe){
      const layout=gpu.layout('OPTICS_FULL_PROBE',[
        {binding:0,visibility:4,texture:{sampleType:'unfilterable-float'}},{binding:1,visibility:4,buffer:{type:'storage'}},
      ]);
      const code=`@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> result:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(source))){return;}
  let m=textureLoad(source,vec2i(id.xy),0);
  atomicAdd(&result[0],1u);atomicMax(&result[3],u32(m.w));
  if(m.y>0.0){atomicAdd(&result[1],1u);}if(m.z>0.0){atomicAdd(&result[2],1u);}
  if(m.w>=24832.0){atomicAdd(&result[4],1u);}if(m.x<1.0){atomicAdd(&result[5],1u);}
  if(m.w>1000.0){atomicAdd(&result[6],1u);}if(m.w>10000.0){atomicAdd(&result[7],1u);}
}`;
      const kernel=gpu.kernel({name:'optics full probe',code,layouts:[layout],workgroupSize:[8,8,1]});await kernel.ready;
      const buffer=gpu.createBuffer({label:'optics full probe',size:32,usage:128|4|8});
      try{
        gpu.write(buffer,0,new Uint32Array(8));
        const group=gpu.bindGroup(layout,[{binding:0,resource:a.hybrid.optics.output.metadata.createView()},
          {binding:1,resource:{buffer}}]);
        const counts=[...new Uint32Array(await h.checkedRead(gpu,'optics full probe',()=>{
          kernel.dispatch(gpu.frame,[100,75,1],{bind:[group]});return gpu.readback.buffer(buffer,0,32);
        }))];
        return{steps:a.sim.frame,counts,expectedAssertion};
      }finally{buffer.destroy();}
    }
    const layout=gpu.layout('OPTICS_POINT_PROBE',[
      {binding:0,visibility:4,texture:{sampleType:'unfilterable-float'}},{binding:1,visibility:4,buffer:{type:'storage'}},
      {binding:2,visibility:4,buffer:{type:'read-only-storage'}},
    ]);
    const code=`@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
@group(0) @binding(2) var<storage,read> points:array<vec2i>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){result[id.x]=textureLoad(source,points[id.x],0);}`;
    const kernel=gpu.kernel({name:'optics point probe',code,layouts:[layout],workgroupSize:[1,1,1]});await kernel.ready;
    const buffer=gpu.createBuffer({label:'optics point probe',size:points.length*16,usage:128|4|8});
    const pixels=gpu.createBuffer({label:'optics point coordinates',size:points.length*8,usage:128|8});
    gpu.write(pixels,0,new Int32Array(points.flat()));
    try{
      const group=gpu.bindGroup(layout,[{binding:0,resource:a.hybrid.optics.output.metadata.createView()},
        {binding:1,resource:{buffer}},{binding:2,resource:{buffer:pixels}}]);
      const samples=[...new Float32Array(await h.checkedRead(gpu,'optics point probe',()=>{
        kernel.dispatch(gpu.frame,[points.length,1,1],{bind:[group]});return gpu.readback.buffer(buffer,0,points.length*16);
      }))];
      const records=points.map((pixel,i)=>({pixel,depth:samples[i*4],stalls:samples[i*4+1],invalid:samples[i*4+2],iterations:samples[i*4+3]}));
      return{steps:a.sim.frame,probeExtent:[2,2],sampleCount:records.length,named:records.slice(0,4),
        longest:records.toSorted((a,b)=>b.iterations-a.iterations).slice(0,12),
        stalled:records.filter(r=>r.stalls>0).length,invalid:records.filter(r=>r.invalid>0).length,expectedAssertion};
    }finally{buffer.destroy();pixels.destroy();}
  },{only:readbackOnly,motion:motionOnly,noTaa:flags.has('--no-taa'),splitRender:flags.has('--split-render'),
    skipOptics:flags.has('--skip-optics-draw'),pointProbe:flags.has('--optics-point-probe'),fullProbe:flags.has('--optics-full-probe'),sweep:flags.has('--optics-sweep'),sweepNative:flags.has('--sweep-native'),sweepRuntimeGI:flags.has('--sweep-runtime-gi'),sweepUnlit:flags.has('--sweep-unlit-surfaces'),sweepArea,sweepTile,traceExit,
    component:componentModes.find(c=>flags.has(c))?.split('=')[1]??(flags.has('--opaque-control')?'opaque':'all'),series:flags.has('--component-controls')}));
  let snapshot,fallback;
  if(!readbackOnly&&!motionOnly){
    snapshot=`/tmp/tpt-hybrid-full-${process.pid}.png`;
    phase('diagnostic screenshot (not converged visual acceptance) and data-view regression');
    await failures.check(page.screenshot({path:snapshot}));
    fallback=await failures.check(page.evaluate(async()=>{
      const a=window.__app;a.setView(1);await a.test.ready();await a.test.renderOnce();
      return{enabled:a.hybrid?.enabled??false,split:a.sim.derived.particleSplit,
        reason:a.hybrid?.stats.reason??'Test disposed outside Test view',steps:a.sim.frame};
    }));
    assert(!fallback.enabled&&!fallback.split&&fallback.steps===result.steps,JSON.stringify(fallback));
  }
  assert.equal(errors.length,0,errors.join('\n'));
  const diagnostic=diagnostics.find(mode=>flags.has(mode));
  console.log(JSON.stringify({passed:!diagnostic,debug,validation:diagnostic?`${diagnostic} diagnostic only`:motionOnly?'motion writes only':readbackOnly?'readback only':flags.has('--component-controls')||componentModes.some(c=>flags.has(c))||flags.has('--opaque-control')?'component controls only':'numerical scene (not converged visual acceptance)',
    result,fallback,snapshot,offlineRelay,adapter:await gpuInfo(page)},null,2));
  }
}catch(error){
  if(errors.length)console.error(errors.join('\n'));
  if(diagnosticPage&&!diagnosticPage.isClosed()&&!readbackOnly&&!motionOnly){
    const snapshot=`/tmp/tpt-hybrid-failed-${process.pid}.png`;
    try{
      await diagnosticPage.screenshot({path:snapshot,timeout:1000});
      console.error(`Failure diagnostic screenshot (not converged acceptance): ${snapshot}`);
    }catch(snapshotError){console.error(`Failure screenshot unavailable: ${snapshotError.message}`);}
  }
  throw error;
}finally{
  await browser?.close();await vite.close();
  if(started)console.log(`Total player-check/startup/compilation/assertions/cleanup occupancy: ${Date.now()-started} ms`);
}
