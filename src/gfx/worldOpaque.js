import { worldOpaqueWGSL, worldOpaqueLayout } from '../shaders/worldOpaque.js';

// Output belongs to the fenced Post scene-target lease, not this recorder.
export function createWorldOpaqueCapture(gpu) {
  const device=gpu.device??gpu, uses=new Set(), flags=[];
  let state='pending', error=null, pipeline, dead=false;
  const layout=device.createBindGroupLayout({entries:worldOpaqueLayout});
  try {
    for(const drew of [0,1]) {
      const buffer=device.createBuffer({label:'world opaque immutable flag',size:32,usage:64,mappedAtCreation:true});
      flags.push(buffer);
      new Uint32Array(buffer.getMappedRange())[0]=drew;buffer.unmap();
    }
  } catch(e) {flags.forEach(b=>b.destroy());throw e;}
  const ready=Promise.resolve().then(()=>device.createComputePipelineAsync({
    label:'world actual opaque capture',layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),
    compute:{module:device.createShaderModule({code:worldOpaqueWGSL}),entryPoint:'main'},
  })).then(p=>{pipeline=p;state='ready';},e=>{state='failed';error=e;throw e;});
  ready.catch(()=>{});
  const check=(ok,message)=>{if(!ok)throw new TypeError(message);};
  const size=t=>[t?.width,t?.height];
  function recordReady(frame,{color,depth,output,drew=true,submitted}={}) {
    if(dead)throw new Error('world opaque capture disposed');
    if(state!=='ready')return false;
    check(frame===gpu.frame&&frame._passKind!=='render','normal Frame outside render pass required');
    check(typeof drew==='boolean'&&submitted?.then,'opaque flag and final submission promise required');
    const [w,h]=size(output);
    check([w,h].every(n=>Number.isSafeInteger(n)&&n>0),'opaque capture extent');
    for(const [t,format,usage]of [[color,'rgba16float',4],[depth,'depth32float',4],[output,'rgba32uint',8|4]]) {
      check(t?.format===format&&t.width===w&&t.height===h&&
        (t.depthOrArrayLayers??1)===1&&(t.sampleCount??1)===1&&
        (t.dimension??'2d')==='2d'&&(t.usage&usage)===usage,'opaque native texture format/extent/usage');
    }
    // Attach before encoding: a thrown suffix may follow an automatic submit.
    // A still-recordable graphics failure must leave submitted unsettled.
    const completion=Promise.resolve(submitted).then(()=>{},()=>{}).then(()=>device.queue.onSubmittedWorkDone());
    uses.add(completion);completion.then(()=>uses.delete(completion),()=>uses.delete(completion));
    const group=device.createBindGroup({layout,entries:[
      ...[color,depth,output].map((t,binding)=>({binding,resource:t.createView()})),
      {binding:3,resource:{buffer:flags[Number(drew)]}},
    ]});
    frame._command?.();
    const pass=frame.direct().beginComputePass({label:'world actual opaque capture'});
    try {pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8),1);}
    finally {pass.end();}
    frame._commandDone?.('world actual opaque capture');
    return true;
  }
  return Object.freeze({
    ready,get state(){return state;},get error(){return error;},recordReady,
    async record(frame,options) {
      const captured={color:options?.color,depth:options?.depth,output:options?.output,drew:options?.drew===undefined?true:options.drew,submitted:options?.submitted};
      await ready;return recordReady(frame,captured);
    },
    dispose() {if(dead)return;dead=true;Promise.allSettled([...uses]).then(()=>flags.forEach(b=>b.destroy()));},
  });
}
