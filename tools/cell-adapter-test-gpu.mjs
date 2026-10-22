// Delayed CPU native-command fake, NOT WGSL execution or GPU parity.
import { FieldTestGPU, FIELD_HISTORY_KERNEL, fieldHistoryCopy } from './field-test-gpu.mjs';
import { gridDims, cellSlot, brickIdOf } from '../src/shaders/common.js';
import { worldSlotCell, auxTexel, pageTexel } from '../src/world/renderAtlas.js';
const bytes=b=>new Uint8Array(b.bytes);
const words=b=>new Uint32Array(b.bytes);
const dims=t=>Array.isArray(t.size)?t.size:[t.size.width,t.size.height,t.size.depthOrArrayLayers??1];
const bpp=t=>t.format==='rgba32uint'?16:t.format==='r32float'?4:8;
const at=(t,p)=>{const d=dims(t);return (p[0]+d[0]*(p[1]+d[1]*p[2]))*bpp(t);};
// WebGPU's dynamic offsets: in binding order, added to each dynamic entry's offset.
const dynamicGroup=(g,dynamic)=>{let k=0;const dyn=new Set(g.layout.entries.filter(e=>e.buffer?.hasDynamicOffset).map(e=>e.binding));
  if(dyn.size!==dynamic.length)throw new Error('dynamic offset count');
  return {...g,entries:[...g.entries].sort((a,b)=>a.binding-b.binding).map(e=>dyn.has(e.binding)?{...e,resource:{...e.resource,offset:(e.resource.offset??0)+dynamic[k++]}}:e)};};
export class CellTestGPU extends FieldTestGPU {
  constructor(){
    super({emulateEMA:true});this.commands=[];this.submitted=[];this.waiters=[];this.retireOnFlush=[];this.flushes=0;this.nativeSubmits=0;this.writes=0;
    // WebGPU's writeBuffer: a typed array's dataOffset and size count its elements (an ArrayBuffer's, bytes)
    this.queue={writeBuffer:(b,o,v,at=0,n)=>{const e=v.BYTES_PER_ELEMENT??1,all=new Uint8Array(v.buffer??v,v.byteOffset??0,v.byteLength),data=all.slice(at*e,n===undefined?undefined:(at+n)*e);this.submitted.push(()=>bytes(b).set(data,o));},
      writeTexture:(dst,data,layout,extent)=>{const copy=new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice();this.submitted.push(()=>this._bufferTexture(copy,layout?.offset??0,dst.texture,dst.origin??[0,0,0],extent,layout?.bytesPerRow,layout?.rowsPerImage));},
      submit:encoders=>{this.nativeSubmits++;for(const e of encoders)this.submitted.push(...e.ops);},
      onSubmittedWorkDone:()=>new Promise(resolve=>this.waiters.push(resolve))};
    this.device={queue:this.queue,limits:{},createBuffer:d=>this.createBuffer(d),createTexture:d=>this.createTexture(d),
      createBindGroupLayout:d=>d,createBindGroup:d=>d,createPipelineLayout:d=>d,createShaderModule:d=>d,
      createComputePipelineAsync:async d=>d,createCommandEncoder:d=>this.encoder(d?.label)};
    const self=this;
    this.frame={get open(){return self.commands.length>0;},copy:(s,so,d,to,n)=>this._push(()=>{if(s.destroyed||d.destroyed)throw new Error('retired copy');bytes(d).set(bytes(s).subarray(so,so+n),to);},{name:'copy',src:s,dst:d,so,to,size:n}),
      clear:(b,o=0,n=b.size-o)=>this._push(()=>bytes(b).fill(0,o,o+n),{name:'clear',buffer:b}),direct:()=>this.encoder('frame',true)};
  }
  _push(fn,trace={}){this.commands.push(fn);this.trace.push(trace);if(this.autoFlush&&this.commands.length>=this.autoFlush)this.flush();}
  createTexture(d){const t=super.createTexture(d);t.bytes=new ArrayBuffer(dims(t).reduce((a,b)=>a*b,1)*bpp(t));return t;}
  encoder(label,frame=false){
    const ops=frame?this.commands:[],push=(fn,trace)=>frame?this._push(fn,trace):(ops.push(fn),this.trace.push(trace));
    return {label,ops,copyTextureToBuffer:(s,d,e)=>push(()=>this._textureBuffer(s,d,e),{name:'capture',src:s.texture,dst:d.buffer}),
      copyBufferToTexture:(s,d,e)=>push(()=>this._bufferTexture(bytes(s.buffer),s.offset??0,d.texture,d.origin??[0,0,0],e,s.bytesPerRow,s.rowsPerImage),{name:'native half copy',src:s.buffer,dst:d.texture,offset:s.offset??0,bytesPerRow:s.bytesPerRow,rowsPerImage:s.rowsPerImage,extent:e}),
      copyTextureToTexture:(s,d,e)=>push(()=>{const [w,h,z]=e;for(let k=0;k<z;k++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=(s.origin??[0,0,0]).map((v,i)=>v+[x,y,k][i]),b=(d.origin??[0,0,0]).map((v,i)=>v+[x,y,k][i]);bytes(d.texture).set(bytes(s.texture).subarray(at(s.texture,a),at(s.texture,a)+bpp(s.texture)),at(d.texture,b));}},{name:'texture copy'}),
      copyBufferToBuffer:(s,so,d,to,n)=>push(()=>bytes(d).set(bytes(s).subarray(so,so+n),to),{name:'native buffer copy'}),
      beginComputePass:()=>{const groups=[];let pipeline;return {setPipeline:p=>pipeline=p,setBindGroup:(i,g,dynamic=[])=>groups[i]=dynamic.length?dynamicGroup(g,dynamic):g,dispatchWorkgroups:(count=1)=>{const frozen=[...groups],fields=pipeline.label==='world CELL field pack';push(()=>fields?this._packFields(frozen,count):this._pack(frozen),{name:fields?'field CELL dispatch':'raw CELL dispatch',pipeline,groups:frozen,count});},end(){}};},finish(){return {ops};}};
  }
  _bufferTexture(input,offset,t,origin,extent,row,image){
    const [w,h,z]=extent, stride=bpp(t);row??=w*stride;image??=h;
    for(let k=0;k<z;k++)for(let y=0;y<h;y++){const p=[origin[0],origin[1]+y,origin[2]+k],o=offset+(k*image+y)*row;bytes(t).set(input.subarray(o,o+w*stride),at(t,p));}
  }
  _textureBuffer(s,d,extent){const [w,h,z]=extent,origin=s.origin??[0,0,0],row=d.bytesPerRow??w*bpp(s.texture),image=d.rowsPerImage??h;for(let k=0;k<z;k++)for(let y=0;y<h;y++){const o=at(s.texture,[origin[0],origin[1]+y,origin[2]+k]);bytes(d.buffer).set(bytes(s.texture).subarray(o,o+w*bpp(s.texture)),(d.offset??0)+(k*image+y)*row);}}
  kernel(desc){
    const k={...desc,state:'ready',ready:Promise.resolve(),dispatch:(frame,size,opts={})=>{
      desc.params?.pack(opts.params);const frozen={...opts,params:opts.params?structuredClone(opts.params):undefined,header:opts.header?structuredClone(opts.header):undefined};
      this._push(()=>{this.onExecute?.(k,frozen);if(desc.name==='fieldEma')this._ema(desc,frozen);else if(desc.name==='fieldPeak')this._peak(frozen);else if(desc.name==='world owned classifier')this._classify(frozen);else if(desc.name.endsWith(' raw source'))this._generate(frozen);else if(desc.name===FIELD_HISTORY_KERNEL&&this.emulateCopies)fieldHistoryCopy(desc,frozen);},{name:desc.name,opts:frozen});
      this.onDispatch?.(k,frozen);
    }};this.kernels.push(k);return k;
  }
  _peak({bind,params}){
    // Distinct deterministic native half words; not the field math emulator.
    const fields=bind[2].entries.filter(e=>e.resource?.texture&&e.binding>=3).map(e=>e.resource.texture);
    for(const [j,t] of fields.entries()){const a=new Uint16Array(t.bytes);for(let i=0;i<a.length;i++)a[i]=(i*131+params.scratchOrigin[0]*17+j*911)&65535;}
  }
  _classify({bind,params}){
    const buf=i=>bind[2].entries.find(e=>e.binding===i).resource.buffer,jobs=words(buf(0)),out=words(buf(4));
    for(let i=0;i<params.count;i++)out.set([jobs[2*i]+1,0x7fc12345,0x80000000,0x01020304],jobs[2*i+1]*4);
  }
  _generate({bind,header}){const A=bind[1].entries.find(e=>e.binding===0).resource.buffer,B=bind[1].entries.find(e=>e.binding===1).resource.buffer;const a=new Float32Array(A.bytes),b=words(B);for(let i=0;i<a.length;i+=4){a[i]=2;a[i+1]=20;a[i+2]=.5;a[i+3]=.125;b.set([0x80000000,0x7fc12345,i,0x11223344],i);}}
  _packFields(groups,count){
    const buffers=groups[0].entries.map(e=>e.resource.buffer),jobs=words(buffers[3]),out=words(buffers[4]);
    for(let i=0;i<count;i++)for(let s=0;s<64;s++){
      const [x,y,z]=worldSlotCell(s),src=x+4*jobs[4*i]+32*(y+4*jobs[4*i+1]+32*(z+4*jobs[4*i+2])),dst=jobs[4*i+3]+(s>>3)*32+(s&7);
      for(let c=0;c<3;c++)out.set(words(buffers[c]).subarray(src*2,src*2+2),(dst+c*256)*2);
    }
  }
  _pack(groups){
    // A binding's window, as WebGPU binds it: offset and size, else the whole buffer.
    const input=i=>{const r=groups[0].entries.find(e=>e.binding===i).resource,w=words(r.buffer),o=(r.offset??0)/4;return r.size===undefined?w.subarray(o):w.subarray(o,o+r.size/4);};
    const src=[0,1,2,3,4,5,6,7].map(input),p=src[7],jobs=src[6],pid=p[0];
    const l={capacity:pid+1,cells:{x:p[1],y:p[2]},aux:{width:p[3],height:p[4],layers:100}};
    const outputs=groups[1].entries.map(e=>e.resource.texture??e.resource),put=(t,pos,v)=>new Uint32Array(t.bytes,at(t,pos),v.length).set(v);
    let lo=0,hi=0;for(let s=0;s<64;s++){const n=jobs[0]+s,a=src[0].subarray(n*4,n*4+4);put(outputs[0],pageTexel(pid,s,l),a);put(outputs[1],pageTexel(pid,s,l),src[1].subarray(n*4,n*4+4));const flags=jobs[4+s];put(outputs[2],auxTexel(pid,4+2*s,l),[flags&1?src[2][2*n]:0,flags&1?src[2][2*n+1]:0,flags&2?src[3][2*n]:0,flags&2?src[3][2*n+1]:0]);put(outputs[2],auxTexel(pid,5+2*s,l),[flags&4?src[4][n]:0,0,0,0]);if(Math.floor(new Float32Array(a.slice().buffer)[0]+.5)!==0){const [x,y,z]=worldSlotCell(s),k=x+4*y+16*z;if(k<32)lo|=1<<k;else hi|=1<<(k-32);}}
    put(outputs[2],auxTexel(pid,0,l),p.subarray(8,12));put(outputs[2],auxTexel(pid,1,l),src[5].subarray(jobs[1]*4,jobs[1]*4+4));put(outputs[2],auxTexel(pid,2,l),[lo>>>0,hi>>>0,0,0]);put(outputs[2],auxTexel(pid,3,l),[0,0,0,0]);
  }
  flush(){if(this.commands.length){this.submitted.push(...this.commands);this.commands=[];this.flushes++;for(const b of this.retireOnFlush.splice(0))this.queue.onSubmittedWorkDone().then(()=>b.destroy());}}
  retire(b){if(this.frame.open)this.retireOnFlush.push(b);else this.queue.onSubmittedWorkDone().then(()=>b.destroy());}
  finish(){this.flush();while(this.submitted.length)this.submitted.shift()();for(const resolve of this.waiters.splice(0))resolve();}
}
