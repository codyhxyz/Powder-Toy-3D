// CPU-only: later blast batches select only through the previous batch's args,
// and that batch's finish resets the selection. Replays the production driver
// and the a700d765 reference loop (reset + full select every batch) over one
// abstract event world; the selection/argument code that decides what runs is
// the generated WGSL itself. Both must do identical work and end identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, V2_DYNAMICS_LAYOUT } from '../../src/shaders/v2.js';
import { blastsWGSL, externalBlastBase, RESET_SELECTION } from '../../src/shaders/v2/blasts.js';
const NONE=0xffffffff, BATCH_DEFAULT=8;
// eventList and its listArgs (v2lists_events) build the first select's brick list.
const SELECTION=['reset','select','workArgs','eventList','v2lists_events'];
// Straight-line integer WGSL → JS, as allocation-check executes workArgs.
const js=code=>code.replace(/\b(\d+)u\b/g,'$1')
  .replace(/atomicLoad\(&control\[([^\]]+)\]\)/g,'control[$1]')
  .replace(/atomicStore\(&control\[([^\]]+)\],([^;]+)\);/g,'control[$1]=$2;');
const body=code=>code.slice(code.lastIndexOf('fn main() {')+'fn main() {'.length,-1);
const run=(code,control,P)=>Function('control','P','D_NONE','select',js(code))(control,P,NONE,(no,yes,c)=>c?yes:no);

function recorder() {
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,INDIRECT:8};
  const commands=[];
  const copy=(b,offset,src)=>new Uint8Array(b.bytes).set(new Uint8Array(src.buffer??src,src.byteOffset??0,src.byteLength),offset);
  const gpu={
    createBuffer(d){return {...d,bytes:new ArrayBuffer(d.size),destroy(){}};},
    queue:{writeBuffer:copy},write:copy,layout:(name,entries)=>({name,entries}),
    bindGroup:(layout,entries)=>({layout,entries}),
    kernel(d){return {...d,ready:Promise.resolve(),dispatch(frame,size,data){
      d.params.pack(data.params); // strict uniform packing of every recorded field
      commands.push({stage:d.name.replace('v2blasts_',''),code:d.code,size,params:data.params});
    }};},
    frame:{clear(){},copy(src,so,dst,dof,n){commands.push({copy:[src,so,dst,dof,n]});}},
    readback:{buffer:(b,o,n)=>Promise.resolve(b.bytes.slice(o,o+n))},
  };
  const g=gridLayout(16,8,8),owner={gpu,g,tick:3,epoch:0,sim:{origin:[0,0,0],header:()=>({})},
    nativeDynamics:{head:nativeDynamicsHead,layout:{entries:V2_DYNAMICS_LAYOUT},group:{}},wake(){},_params:()=>({busyIn:1,busyOut:2})};
  owner.events=gpu.createBuffer({size:g.slots*4});
  return {g,owner,commands};
}
// The a700d765 consumeMaterialEvents loop, verbatim order and sizes.
function reference(d,tick) {
  for(const [slot,r] of d.externalBlasts) d._recordExternalBlast(slot,r,tick);
  for (let n=0;n<d.blastBatch;n++) {
    d._record('blasts','reset',1,tick);
    d._record('blasts','select',Math.ceil(d.g.slots/64),tick);
    d._record('blasts','workArgs',1,tick);
    d.gpu.frame.copy(d.control,20*4,d.dispatchArgs,0,48);
    d.gpu.frame.copy(d.control,28*4,d.dispatchArgs,48,4);
    const size=offset=>({indirect:d.dispatchArgs,offset});
    d._record('blasts','plan',size(0),tick);
    d._record('blasts','sum',size(16),tick);
    d._record('blasts','normalize',size(32),tick);
    d._record('blasts','damagePlan',size(0),tick);
    d._allocate(tick,{},true);
    d._record('blasts','finish',size(32),tick);
  }
}
// Abstract world: event cells {bits, fits, stuck}, a free particle pool, wakes.
// Plan-only stages change nothing outside their batch; their inputs are logged.
function replay(commands,buffers,state,g) {
  const control=state.control, args=state.args, work=[];
  const hash=()=>JSON.stringify([Array.from(control.subarray(0,32)),Array.from(args),[...state.cells],state.free]);
  for(const c of commands) {
    if(c.copy) {
      const [src,so,dst,dof,n]=c.copy;
      new Uint8Array(buffers.get(dst).buffer,dof,n).set(new Uint8Array(buffers.get(src).buffer,so,n));continue;
    }
    const P={...c.params,mode:c.params.mode??0,substep:c.params.substep??0};
    // The first select (substep 1) covers the event list: every brick noted as holding a
    // request, here every brick with an event cell (air-cache-check proves the notes).
    const listed=c.stage==='select' && P.substep===1;
    const groups=c.size.indirect?args.subarray(c.size.offset/4,c.size.offset/4+3).reduce((a,b)=>a*b,1):c.size.reduce((a,b)=>a*b,1);
    if(!groups && !listed) continue; // zero-size dispatches are no-ops (WebGPU)
    if(c.stage==='select') state.selects++;
    if(!SELECTION.includes(c.stage)) work.push([c.stage,P.mode,hash()]);
    if(c.stage==='reset' || c.stage==='workArgs') run(body(c.code),control,P);
    else if(c.stage==='select') for(const [slot,cell] of state.cells) {
      if(!cell.bits || (!listed && slot>=groups*64)) continue; // dThread covers groups*64 slots
      control[2]++;state.wakes.add(slot);if(cell.bits&4) control[17]++;
      if((cell.bits&1) && cell.fits) control[3]=Math.min(control[3],slot);
    } else if(c.stage==='externalBegin') control[3]=control[externalBlastBase(g)+P.substep]===0?g.slots:NONE;
    else if(c.stage==='apply' && P.mode!==14) for(const [,cell] of state.cells) {
      if(!(cell.bits&4)) continue;
      if(state.free) { state.free--;cell.bits&=~4; } else control[7]++; // backpressure: request stays
    } else if(c.stage==='children') { const served=Math.min(control[18],state.free);control[18]-=served;state.free-=served; }
    else if(c.stage==='finish') {
      const finish=body(c.code),at=finish.indexOf('if (s==D_NONE)');
      assert.ok(at>0,'finish reads its selection once, before any exit');
      const s=run(finish.slice(0,at)+'return s;',control,P); // production prefix, incl. its reset
      if(s===NONE) continue;
      if(P.mode===14) control[externalBlastBase(g)+P.substep]=1;
      else if(!state.cells.get(s).stuck) state.cells.get(s).bits&=~1;
    }
  }
  return work;
}
function world(seed,{charges,unfit,gas,neutrons,stuck,free,children,external}) {
  const cells=new Map();let x=seed;
  const random=()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x;};
  const add=cell=>{let s;do s=random()%g.slots;while(cells.has(s));cells.set(s,cell);};
  for(let i=0;i<charges;i++) add({bits:1|(i%3===0 && neutrons?4:0),fits:true});
  for(let i=0;i<unfit;i++) add({bits:1,fits:false});
  for(let i=0;i<gas;i++) add({bits:2,fits:false});
  for(let i=0;i<neutrons;i++) add({bits:4,fits:false});
  for(let i=0;i<stuck;i++) add({bits:1,fits:true,stuck:true});
  return {cells,free,children,external};
}
// One driver; every schedule restarts from its freshly constructed buffers.
const {g,owner,commands}=recorder();
const d=owner.dynamics=new NativeDynamics(owner);await d.ready;
const initial=[d.control,d.dispatchArgs].map(b=>b.bytes.slice(0));
async function schedule(record,blastBatch,w,ticks) {
  d.blastBatch=blastBatch;d.externalBlasts=new Map();d.sequence=0;
  [d.control,d.dispatchArgs].forEach((b,i)=>new Uint8Array(b.bytes).set(new Uint8Array(initial[i])));
  if(w.external) assert.equal(d.applyExternalBlast({position:[2,2,2],energy:100,radius:2}).status,'queued');
  const control=new Uint32Array(d.control.bytes),args=new Uint32Array(d.dispatchArgs.bytes);
  control[3]=NONE;control[18]=w.children;
  if(w.external==='done') control[externalBlastBase(g)]=1;
  const state={control,args,cells:structuredClone(w.cells),free:w.free,wakes:new Set(),selects:0};
  const buffers=new Map([[d.control,control],[d.dispatchArgs,args]]);
  commands.length=0;
  let recorded=0;const work=[];
  for(let tick=4;tick<4+ticks;tick++) {
    const before=commands.length;record(d,tick);recorded+=commands.filter((c,i)=>i>=before && !c.copy).length;
  }
  work.push(...replay(commands,buffers,state,g));
  return {work,state:{control:Array.from(control),args:Array.from(args),cells:[...state.cells],free:state.free,wakes:[...state.wakes].sort((a,b)=>a-b)},
    selects:state.selects,recorded};
}
const current=(d,tick)=>d.consumeMaterialEvents(tick);

test('production reset and finish share the selection reset; finish resets only between material batches',()=>{
  const reset=blastsWGSL(g,nativeDynamicsHead,'reset'),finish=blastsWGSL(g,nativeDynamicsHead,'finish');
  assert.equal(body(reset).trim(),RESET_SELECTION);
  assert.ok(finish.includes(`if (P.mode!=14u && P.substep>0u) { ${RESET_SELECTION} }`));
  // Resetting before the rest of finish equals the old reset after it.
  assert.doesNotMatch(body(finish).split('if (s==D_NONE)')[1],/control\[(2|3|17)\]/,'finish never reads or writes the selection words after its first read');
});

const fixtures={
  idle:{charges:0,unfit:0,gas:0,neutrons:0,stuck:0,free:100,children:0},
  dormant:{charges:0,unfit:3,gas:4,neutrons:0,stuck:0,free:100,children:0},
  oneCharge:{charges:1,unfit:2,gas:2,neutrons:0,stuck:0,free:100,children:0},
  chain:{charges:5,unfit:1,gas:0,neutrons:0,stuck:0,free:100,children:0},
  saturated:{charges:20,unfit:0,gas:3,neutrons:0,stuck:0,free:100,children:0},
  neutrons:{charges:2,unfit:0,gas:0,neutrons:2,stuck:0,free:1,children:0},
  backpressure:{charges:0,unfit:0,gas:0,neutrons:3,stuck:0,free:0,children:2},
  children:{charges:1,unfit:0,gas:1,neutrons:0,stuck:0,free:2,children:3},
  retry:{charges:2,unfit:0,gas:0,neutrons:0,stuck:1,free:100,children:0},
};
for(const blastBatch of [1,2,3,BATCH_DEFAULT]) for(const [name,fixture] of Object.entries(fixtures)) for(const external of [null,'pending','done']) {
  test(`${blastBatch} batches, ${name}, external ${external??'none'}: identical work, retries and final state over 3 ticks`,async()=>{
    for(const seed of [1,7,99]) {
      const w=world(seed,{...fixture,external});
      const old=await schedule(reference,blastBatch,w,3),now=await schedule(current,blastBatch,w,3);
      assert.deepEqual(now.work,old.work,'same non-empty work dispatches, each on the same state');
      assert.deepEqual(now.state,old.state,'same control words, args, events, pool and wakes');
      assert.equal(old.selects,blastBatch*3);
      assert.equal(old.recorded-now.recorded,(blastBatch-1-2)*3,'one reset dispatch per tick, not per batch, plus the event list and its args');
    }
  });
}

test('an idle default tick runs one listed select instead of eight full ones and records 115 dispatches instead of 120',async()=>{
  const w=world(1,fixtures.idle);
  const old=await schedule(reference,BATCH_DEFAULT,w,1),now=await schedule(current,BATCH_DEFAULT,w,1);
  assert.equal(old.selects,BATCH_DEFAULT);assert.equal(now.selects,1);
  assert.equal(old.recorded,120);assert.equal(now.recorded,115);
  // k batches with work select k+1 times; full chains keep all eight.
  for(const [charges,selects] of [[1,2],[3,4],[7,8],[20,8]]) {
    const r=await schedule(current,BATCH_DEFAULT,world(5,{...fixtures.idle,charges}),1);assert.equal(r.selects,selects);
  }
  const big=gridLayout(128,128,128);
  console.log(`idle 128³ tick: ${(BATCH_DEFAULT-1)*big.slots*4} fewer event bytes read, ${(BATCH_DEFAULT-1)*Math.ceil(big.slots/64)} fewer workgroups, ${old.recorded-now.recorded} fewer recorded dispatches`);
});
test.after(()=>d.dispose());
