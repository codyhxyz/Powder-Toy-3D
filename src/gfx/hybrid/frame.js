import { hybridGateWGSL,hybridCompositeWGSL } from '../../shaders/hybrid/frame.js';

/** Owns one depth snapshot and the same-frame GPU fallback/compose arguments. */
export function createHybridFrame(gpu,sim) {
  const gate=gpu.createBuffer({label:'hybrid scene gate',size:48,usage:0x80|0x100});
  const gateLayout=gpu.layout('HYBRID_SCENE_GATE',[
    {binding:0,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:2,visibility:4,buffer:{type:'storage'}},
  ]);
  const layout=gpu.layout('HYBRID_COMPOSE',[
    {binding:0,visibility:2,texture:{sampleType:'unfilterable-float'}},
    {binding:1,visibility:2,texture:{sampleType:'depth'}},
    {binding:2,visibility:2,texture:{sampleType:'unfilterable-float'}},
  ]);
  const kernel=gpu.kernel({name:'hybrid scene acceptance',code:hybridGateWGSL,
    layouts:[undefined,undefined,gateLayout],entry:'gate',workgroupSize:[1,1,1]});
  const pipe=gpu.renderPipeline({name:'hybrid scene composite',code:hybridCompositeWGSL,
    layouts:[undefined,undefined,layout],fragment:{targets:[{format:'rgba16float'}]},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
  let depth=null,encoder=null,disposed=false;
  const retired=[];
  const collect=()=>{for(let i=retired.length-1;i>=0;i--)if(retired[i].encoder!==gpu.frame.encoder){retired[i].texture.destroy();retired.splice(i,1);}};
  return {
    gate,ready:Promise.all([kernel.ready,pipe.ready]),
    get isReady(){return !disposed&&kernel.state==='ready'&&pipe.state==='ready';},
    legacyIndirect:{buffer:gate,offset:32},
    evaluate(geometry,smooth){
      const group=gpu.bindGroup(gateLayout,[
        {binding:0,resource:{buffer:geometry.resources.status}},
        {binding:1,resource:{buffer:smooth.resources.status}},
        {binding:2,resource:{buffer:gate}},
      ]);
      kernel.dispatch(gpu.frame,[1,1,1],{bind:[undefined,undefined,group]});
    },
    snapshot(source){
      collect();
      if(!depth||depth.width!==source.width||depth.height!==source.height){
        if(depth)retired.push({texture:depth,encoder});
        depth=gpu.createTexture({label:'hybrid immutable scene depth',format:'depth32float',
          size:[source.width,source.height],usage:0x02|0x04});
      }
      gpu.frame.direct().copyTextureToTexture({texture:source},{texture:depth},[source.width,source.height,1]);
      encoder=gpu.frame.encoder;
      return depth;
    },
    compose(post,color,metadata){
      const group=gpu.bindGroup(layout,[
        {binding:0,resource:color.createView()},
        {binding:1,resource:depth.createView()},
        {binding:2,resource:metadata.createView()},
      ]);
      const rp=gpu.frame.render(post.sceneDescriptor({load:true}),'hybrid final color and depth');
      try{pipe.draw(rp,{bind:[undefined,undefined,group],indirect:{buffer:gate,offset:16}});}finally{rp.end();}
    },
    dispose(){if(disposed)return;disposed=true;gpu.flush('hybrid frame dispose');
      gate.destroy();depth?.destroy();for(const r of retired)r.texture.destroy();retired.length=0;},
  };
}
