// CPU-only controller/view/save/scene-undo regressions; no browser or GPU.
// node scripts/check-industry-controller.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { E } from '../src/elements.js';

// The actual UI runs against a tiny DOM; only CSS loading is omitted.
const hooks = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? {format:'module',source:'',shortCircuit:true} : next(url,context);
} });
const { createIndustry, validateIndustrySave } = await import('../src/industry/index.js');
const { createIndustryView } = await import('../src/industry/view.js');
const { createProgression } = await import('../src/industry/progression.js');
hooks.deregister();
class Element {
  children = []; attributes = {}; style = {setProperty() {}};
  getAttribute(key) { return this.attributes[key] ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  focus() { document.activeElement = this; }
  append(...children) { this.children.push(...children); }
  setAttribute(key,value) { this.attributes[key] = value; }
  addEventListener() {}
  remove() {}
}
globalThis.document = {body:new Element(), createElement:() => new Element(), createTextNode:text => ({textContent:text})};
globalThis.GPUBufferUsage = { STORAGE:1, COPY_SRC:2, INDIRECT:4 };
const listeners = new Map();
globalThis.addEventListener = (key,fn) => listeners.set(key,fn);
globalThis.removeEventListener = (key,fn) => { if (listeners.get(key) === fn) listeners.delete(key); };
const settle = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const search = (node, predicate) => predicate(node) ? node : node.children?.map(child => search(child,predicate)).find(Boolean);
const key = (code,shiftKey=false,target) => {
  const e = {code,shiftKey,target,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
  listeners.get('keydown')?.(e); return e;
};
function fixture() {
  const calls=[], edits=[], reads=[], toasts=[];
  const gpu = {three:{prepare:async()=>{}},layout:()=>({}),createBuffer:()=>({}),bindGroup:()=>({}),flush(){},
    kernel:spec=>({name:spec.name,state:'ready',ready:Promise.resolve()}),
    readback:{ring:name=>({buffer:{},next:()=>0,read:()=>name === 'industry construction'
      ? Promise.resolve(new Float32Array([1,0,0,0]).buffer)
      : new Promise(resolve=>reads.push(resolve))})}};
  const sim = {gpu,g:{nx:128,ny:128,nz:128},L:{},tables:{},bindRW:{},version:0,
    header:()=>({}),wake(){},editKernel:()=>({ready:Promise.resolve()}),edit:(...args)=>edits.push(args),
    _dispatch:(kernel,size,{params})=>calls.push({name:kernel.name,params}),history:[],terrain:'original',
    snapshot(label){this.history.push({label,terrain:this.terrain,note:null});},
    clear(){this.terrain='empty';},undo(){const old=this.history.pop();if(!old)return false;this.terrain=old.terrain;return true;},
    get canUndo(){return !!this.history.length;}};
  const app = {sim,gpu,gamemode:'sandbox',settings:{preset:'quarry'},win:null,scale:1,
    scene:new THREE.Group(),volume:{position:new THREE.Vector3()},hud:{toast:text=>toasts.push(text)},
    requestRender(){},leaveBuild(){},dock:{setCollapsed(){}},toolbar:{setUndoEnabled(){}},isTyping:()=>false,
    pov:{active:false,player:{pos:{x:10,y:8,z:10}},worldReplaced(){}},hover:{valid:false}};
  const industry = app.industry = createIndustry(app);
  const panel = document.body.children.at(-1);
  const answer = (cells=[]) => {
    const buf=new Float32Array(256*4); for(let i=0;i<256;i++)buf[i*4]=-1;
    cells.forEach((c,i)=>buf.set(c,i*4)); assert(reads.length); reads.shift()(buf.buffer);
  };
  return {app,industry,panel,calls,edits,reads,toasts,answer};
}
const spec = (type='belt',extra={})=>({type,x:8,y:8,z:8,rotation:0,...extra});
const empty = ()=>({version:1,devices:[],progression:null,paid:[],factoryRun:false,assisted:false,physics:{version:1,pumps:[]}});
const cargoSave = ()=>{
  const data=empty(),device={id:'machine-1',...spec('pump',{x:24})};
  data.devices=[{id:'retained-belt',...spec()}];
  data.physics.pumps=[{id:device.id,device,cells:[[E.WATER,25,0,.25]]}];
  return data;
};
let passed=0;
async function test(name,fn) { await fn();passed++;console.log(`PASS ${name}`); }

await test('Sandbox B falls through; Shift+B opens, B closes; Factory B and native drive',async()=>{
  const f=fixture(),{app,industry,panel}=f; await settle();
  assert(!key('KeyB').prevented);assert(!industry.building);
  assert(key('KeyB',true).prevented);assert(industry.building);
  assert(key('KeyB').prevented);assert(!industry.building);
  industry.update(0,false);
  const toggle=search(panel,e=>e.attributes?.['data-action']==='toggle');assert(toggle);assert.equal(toggle.textContent,'Build · Shift+B');
  toggle.onclick();assert(industry.building);toggle.onclick();assert(!industry.building);
  const power=search(panel,e=>e.type==='checkbox');power.checked=true;power.onchange();
  assert(industry.state.powered);
  assert((await industry.place(spec('belt',{powered:true}))).ok,'Sandbox spark placement remains available');
  app.gamemode='factory';industry.modeChanged();industry.reset({starters:true});industry.update(0,false);
  assert(!industry.state.powered);assert(power.disabled);
  assert(search(panel,e=>e.title?.startsWith('Spark a conductor')).hidden);
  assert(key('KeyB').prevented);assert(industry.building);
  assert(!key('KeyB',false,{tagName:'SELECT'}).prevented);assert(industry.building);
  assert(key('Escape',false,{tagName:'SELECT'}).prevented);assert(!industry.building);
  key('KeyB');assert(industry.building);
  const rejected=await industry.place(spec('belt',{powered:true}));
  assert(!rejected.ok);assert.match(rejected.reason,/built-in drive/);
  assert((await industry.place(spec('foundation'))).ok);assert.equal(industry.state.progression.credits,23);
  app.gamemode='survival';industry.modeChanged();assert(!key('KeyB',true).prevented);
  industry.dispose();
});

await test('driving suspends construction input/ghost without losing build selection',async()=>{
  const {app,industry}=fixture(); await settle();
  key('KeyB',true); assert(industry.building);
  app.pov.vehicles={seated:{kind:'boat'}};
  assert(!industry.building); assert(!industry.state.building);
  assert(!key('KeyB',true).prevented, 'driving does not intercept build shortcuts');
  const event={target:app.canvas,button:0,type:'pointerdown',preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};
  listeners.get('pointerdown')(event); assert(!event.prevented);
  industry.update(0,false); assert(!industry.state.building);
  app.pov.vehicles.seated=null;
  assert(industry.building, 'exit restores previous build state');
  industry.update(0,false); assert(industry.state.building);
  industry.dispose();
});

await test('body blocks ghost and placement only in POV; foundation clearance and static geometry',async()=>{
  const f=fixture(),{app,industry}=f;await settle();
  key('KeyB',true);app.hover={valid:true,cell:{x:8,y:7,z:8},face:2,id:E.ROCK};
  app.pov.active=true;industry.update(0,false);
  assert.match(search(f.panel,e=>e.className==='industry-status').textContent,/Move clear/);
  assert(!(await industry.place(spec())).ok);assert.equal(f.calls.length,0);
  app.pov.active=false;industry.update(0,false);await settle();industry.update(0,false);
  assert.match(search(f.panel,e=>e.className==='industry-status').textContent,/Clear deck/);
  assert((await industry.place(spec('foundation'))).ok);
  assert.equal(f.calls.at(-1).params.height,1);assert.equal(f.calls.at(-1).params.material,E.TUNGSTEN);
  assert((await industry.place(spec('foundation',{y:9}))).ok,'stacking is legal');
  industry.update(0,false);await settle();industry.update(0,false);
  const root=app.scene.getObjectByName('Industry');
  const block=root.children.slice(1).find(m=>m.position.y===8 && m.position.x===10);
  assert(block);assert.equal(block.children.length,4);assert(block.children.every(m=>m.geometry.type==='BoxGeometry'));
  search(f.panel,e=>e.attributes?.['data-machine']==='foundation').onclick();industry.update(0,false);
  const ghost=root.children[0];assert.equal(ghost.children[0].scale.y,.25);
  assert(ghost.children.slice(1).every(m=>!m.visible),'structural ghost has no arrows or ports');
  // Body enters while construction.ready yields: recheck must reject before dispatch.
  const before=f.calls.length;const placing=industry.place(spec('belt',{x:16}));
  app.pov.active=true;app.pov.player.pos.x=18;await placing.then(r=>assert(!r.ok));assert.equal(f.calls.length,before);
  industry.dispose();
});

await test('header preflight rejects malformed orphan footprints and duplicate IDs without reset',async()=>{
  const {app,industry}=fixture();await settle();const good=cargoSave();industry.fromJSON(good);
  const baseline=industry.toJSON();
  for(const change of [d=>d.physics.pumps[0].device.x=128,d=>d.physics.pumps[0].device.y=122,
    d=>d.physics.pumps.push({...structuredClone(d.physics.pumps[0]),device:{...d.physics.pumps[0].device,x:40}})]) {
    const malformed=structuredClone(good);change(malformed);
    assert.throws(()=>validateIndustrySave(malformed,[128,128,128],'quarry'));
    assert.throws(()=>industry.fromJSON(malformed));assert.deepEqual(industry.toJSON(),baseline);
  }
  const placed=await industry.place(spec('pump',{x:40}));assert(placed.ok);
  assert.match(placed.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(placed.id,'machine-1');
  const saved=JSON.parse(JSON.stringify(industry.toJSON()));validateIndustrySave(saved,[128,128,128],'quarry');
  industry.fromJSON(saved);assert.deepEqual(industry.toJSON(),saved);
  assert.equal(industry.toJSON().physics.pumps[0].id,'machine-1');
  industry.dispose();
});

await test('scene Clear → Undo restores real registrations and retained cargo; painting undo stays terrain-only',async()=>{
  const f=fixture(),{app,industry}=f;await settle();industry.fromJSON(cargoSave());
  const before=industry.toJSON(),source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  const loadSource=source.slice(source.indexOf('function loadPreset('),source.indexOf('// A new scene clears'));
  const undoSource=source.slice(source.indexOf('function undo()'),source.indexOf('// ---------------------------------------------------------------- saves ('));
  const context=vm.createContext({ctx:app,sim:app.sim,settings:app.settings,hud:app.hud,pov:app.pov,toolbar:app.toolbar,
    graphicsFailure:null,mp:{guard:()=>false},win:null,presetWire:()=>null,wire:()=>null,
    sceneLabel:name=>name==='empty'?'Clear':name,resolveMode:()=>({key:'sandbox'}),mapOf:()=>({}),selectedMode:'sandbox',
    startMode(){},whenSimReady:fn=>fn(),buildPreset(){},arenaLayout:null,ARENA_GRID:{},resetSimModes(){},
    post:{reset(){}},signs:null,resetSpawners(){},save(){},perkOrbs:null});
  vm.runInContext(`${loadSource}\n${undoSource}`,context);
  const originalSnapshot=app.sim.snapshot;
  assert(context.loadPreset('empty'));assert.equal(app.sim.terrain,'empty');assert.equal(industry.state.devices.length,0);
  assert.equal(app.sim.history.at(-1).note.industry.data.physics.pumps.length,1);
  context.undo();assert.equal(app.sim.terrain,'original');assert.equal(app.settings.preset,'quarry');
  assert.deepEqual(industry.toJSON(),before);assert.equal(app.sim.snapshot,originalSnapshot,'snapshot method is not patched');
  app.sim.snapshot('Sand');context.undo();assert.deepEqual(industry.toJSON(),before);
  assert(f.toasts.includes('Terrain restored; machine placements are unchanged.'));
  // A pending construction prevents both an undoable scene load and undo.
  const placing=industry.place(spec('foundation',{x:40}));assert(industry.pending);
  const depth=app.sim.history.length;assert.equal(context.loadPreset('empty'),false);context.undo();
  assert.equal(app.sim.history.length,depth);assert.equal(app.settings.preset,'quarry');await placing;
  // A pending pump spill also refuses scene replacement and fromJSON.
  industry.update(.05,true);industry.update(.05,true);industry.update(.05,true);assert(industry.pending);
  assert.equal(context.loadPreset('empty'),false);assert.throws(()=>industry.fromJSON(before),/transfer/);
  while(f.reads.length)f.answer();await settle();industry.dispose();
});

await test('confirmed grain deliveries toast once per new milestone and keep next step visible while building',async()=>{
  const f=fixture(),{app,industry}=f;await settle();app.gamemode='factory';industry.modeChanged();industry.reset({starters:true});
  industry.update(.05,true);await settle(); // bind pipelines after the explicit world reset
  const shipBatch=async count=>{
    for(let i=0;i<3;i++)industry.update(.05,true);
    assert.equal(f.reads.length,1);f.answer(Array.from({length:count},()=>[E.NUGGETS,20,0,.25]));await settle();
  };
  await shipBatch(12);assert.equal(industry.state.progression.stage,1);
  assert.equal(f.toasts.filter(t=>t.startsWith('Unlocked:')).length,1);
  assert.match(f.toasts.at(-1),/Mining agent \+ Grain lift/);
  await shipBatch(1);assert.equal(f.toasts.filter(t=>t.startsWith('Unlocked:')).length,1);
  key('KeyB');industry.update(0,false);
  const next=search(f.panel,e=>e.className==='industry-help' && e.textContent?.startsWith('Next:'));assert(next && !next.hidden);assert.match(next.textContent,/mining agent/);
  const saved=industry.toJSON();industry.fromJSON(saved);industry.update(0,false);
  assert.equal(f.toasts.filter(t=>t.startsWith('Unlocked:')).length,1,'reload does not repeat milestone');
  industry.dispose();
});
await test('construction UI exposes true costs, unlocks, progress, material flows and stable keyboard controls',async()=>{
  const app={scene:new THREE.Group(),gpu:{three:{prepare:async()=>{}}},requestRender(){},hud:{toast(){}},
    scale:1,volume:{position:new THREE.Vector3()},pov:{active:false}};
  const economy=createProgression(),calls=[];
  const state={active:true,factory:true,building:true,devices:[],selected:'belt',rotation:0,filter:E.NUGGETS,powered:false,pending:false};
  const actions={canBuild:type=>state.factory?economy.canBuild(type):{ok:true},
    select:type=>{state.selected=type;calls.push(type);},toggle:()=>calls.push('toggle'),cancel:()=>calls.push('cancel'),
    place:()=>calls.push('place'),remove:()=>calls.push('remove'),rotate:()=>calls.push('rotate'),
    filter:value=>state.filter=value,power:value=>state.powered=value};
  const view=createIndustryView(app,actions),panel=document.body.children.at(-1);
  const update=(candidate=null,result=null)=>{state.progression=state.factory?economy.snapshot():null;view.update(state,candidate,result,0);};
  const cls=name=>search(panel,e=>e.className===name);
  const machine=type=>search(panel,e=>e.attributes?.['data-machine']===type);
  await settle();update();
  const belt=machine('belt'),miner=machine('miner'),pump=machine('pump'),heater=machine('heater');
  assert.equal(cls('industry-balance').textContent,'24');
  assert.equal(cls('industry-progress').max,12);assert.equal(cls('industry-progress').value,0);
  assert.match(belt.attributes['aria-label'],/2 credits/);assert.equal(belt.attributes['aria-pressed'],'true');
  for(const [b,threshold] of [[miner,12],[pump,48],[heater,96]]) {
    assert.equal(b.attributes['aria-disabled'],'true');assert.match(b.attributes['aria-label'],new RegExp(`Unlock: ${threshold}`));
    assert(!b.disabled,'locked card remains keyboard-discoverable');b.onclick();
  }
  assert.deepEqual(calls,[],'locked cards cannot trigger construction');
  const before=panel.children.slice();update();assert.deepEqual(panel.children,before);assert.equal(machine('belt'),belt);
  assert(!search(panel,e=>e.attributes?.role==='status'),'continuous placement feedback must not be a live region');
  assert(cls('industry-guide').open,'next-step instructions start expanded');
  machine('separator').onclick();update();
  const filter=search(panel,e=>e.attributes?.['aria-label']==='Separator output material');
  filter.value=E.SAND;filter.onchange();update();assert.equal(state.filter,E.SAND);
  assert(search(panel,e=>e.textContent==='Sand → / others right'));
  assert(!cls('industry-filter').hidden);assert(cls('industry-power').hidden);
  assert(economy.build('ship').ok);assert(economy.build('separator').ok);assert(economy.build('belt').ok);update();
  assert.equal(cls('industry-balance').textContent,'0');assert.equal(belt.attributes['data-availability'],'unavailable');
  assert.match(belt.attributes['aria-label'],/Need 2 more credits/);
  economy.ship({id:E.NUGGETS,count:12,temperature:20});update();
  assert.equal(cls('industry-progress').max,48);assert.equal(cls('industry-progress').value,12);
  assert.equal(miner.attributes['data-availability'],'unavailable');assert.match(miner.attributes['aria-label'],/Need 6 more/);
  economy.ship({id:E.NUGGETS,count:84,temperature:20});update();
  assert.equal(heater.attributes['aria-disabled'],'false');assert.equal(cls('industry-progress').max,32);
  assert.equal(cls('industry-progress').value,0);
  economy.ship({id:E.METAL,count:32,temperature:400});update();
  assert.equal(cls('industry-progress').value,32);assert.match(cls('industry-objective').textContent,/Quarry complete/);
  state.factory=false;state.selected='pump';update();
  assert.equal(cls('industry-balance').textContent,'Free');assert(cls('industry-progress').hidden);
  assert.equal(heater.attributes['aria-disabled'],'false');assert.match(heater.attributes['aria-label'],/Free/);
  const power=search(panel,e=>e.type==='checkbox');assert(!power.disabled);assert(!cls('industry-power').hidden);
  power.checked=true;power.onchange();update();assert.match(cls('industry-power-help').textContent,/Blue port.*battery/);
  state.selected='ship';update();assert(search(panel,e=>e.textContent==='Removed · no credits'),'Sandbox deliveries do not claim to pay credits');
  state.selected='foundation';update();assert(cls('industry-power').hidden);
  for(const label of ['Rotate · R','Dismantle','Esc close'])search(panel,e=>e.textContent===label).onclick();
  assert.deepEqual(calls.slice(-3),['rotate','remove','cancel']);
  const toggle=search(panel,e=>e.attributes?.['data-action']==='toggle');
  belt.focus();state.building=false;update();
  assert.equal(document.activeElement,toggle);assert.equal(toggle.attributes['aria-expanded'],'false');
  assert.equal(toggle.textContent,'Build · Shift+B');assert(cls('industry-builder').hidden);
  assert(!cls('industry-hud').hidden,'closed builder retains compact HUD');
  view.dispose();
});

await test('placement UI distinguishes aiming, checking, invalid, valid and transfer-pending without stale clearance',async()=>{
  const f=fixture(),{app,industry,panel}=f;await settle();key('KeyB',true);industry.update(0,false);
  const feedback=search(panel,e=>e.className==='industry-placement');
  const place=search(panel,e=>e.attributes?.['data-action']==='place');
  assert.equal(feedback.attributes['data-state'],'aim');assert(place.disabled);
  app.hover={valid:true,cell:{x:24,y:7,z:24},face:2,id:E.ROCK};industry.update(0,false);
  assert.equal(feedback.attributes['data-state'],'checking');assert(place.disabled);
  const ghost=app.scene.getObjectByName('Industry').children[0];assert.equal(ghost.children[0].material.color.getHexString(),'dcbc74');
  await settle();industry.update(0,false);
  assert.equal(feedback.attributes['data-state'],'valid');assert(!place.disabled);
  assert.equal(ghost.children[0].material.color.getHexString(),'b7d077');
  app.pov.active=true;app.pov.player.pos={x:26,y:8,z:26};industry.update(0,false);
  assert.equal(feedback.attributes['data-state'],'invalid');assert(place.disabled);
  assert.equal(ghost.children[0].material.color.getHexString(),'e5536a');
  app.pov.active=false;const placing=industry.place(spec('foundation',{x:40}));industry.update(0,false);
  assert.equal(feedback.attributes['data-state'],'checking');assert(place.disabled);await placing;
  app.hover.valid=false;industry.update(0,false);
  assert.equal(feedback.attributes['data-state'],'aim');assert(place.disabled);
  assert.match(search(panel,e=>e.className==='industry-status').textContent,/Point into the world/);
  industry.dispose();
});
console.log(`${passed} Industry controller CPU checks passed (DOM and GPU transport mocked; actual controller, view, physics and app scene functions).`);
