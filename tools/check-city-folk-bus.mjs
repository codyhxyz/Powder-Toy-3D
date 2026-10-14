// CPU-only geometry, edited-live clearance and streaming lifecycle regressions.
import assert from 'node:assert/strict';
import { Vector3, Scene } from 'three';
import { registerHooks } from 'node:module';
import { E } from '../src/elements.js';
import { CITY_FOLK_CITY as C } from '../src/world/scenes/cityFolk/city.js';
import { compileShared, jsConstants, definesTypes } from '../src/world/scenes/themedShared.js';
import { toWgsl } from '../src/world/scenes/subsetWgsl.js';
import { willowCoveTwin } from '../src/world/scenes/willowCove.js';
import { createCityBus, CITY_BUS_STOPS, withCityBusFocus, cityBusArrivalClear } from '../src/pov/village/bus.js';

const shared = compileShared(C.src, 123, jsConstants('CITY', C));
const city = shared.cfCityCell, stop = shared.cfCityBusStopCell;
const twin = willowCoveTwin({ seed: 123, size: [3072, 128, 1024] });
const cell = (x, y, z) => twin.wcCell(x, y, z);
assert.match(toWgsl(C.src, { consts: definesTypes('CITY', C) }), /fn cfCityCell/);
const city2 = compileShared(C.src, 123, jsConstants('CITY', C)).cfCityCell;
for (let x = -164; x <= 164; x += 4) for (let z = -444; z <= -276; z += 4)
  for (let y = 44; y < 88; y += 3) assert.equal(city(x,y,z, E.WATER), city2(x,y,z,E.WATER));
for (const [x,z] of [[-96,60],[-40,60],[64,60],[112,60],[0,36],[920,-28],[-920,36]])
  for (let y=0;y<128;y++) assert.equal(city(x,y,z,E.WATER),E.WATER,'outside owned geometry must return input');
const solidFootprint = (x,z) => {
  for (let a=x-1;a<=x;a++) for(let b=z-1;b<=z;b++) {
    assert.equal(cell(1536+a,47,512+b),E.BRICK);
    for(let y=48;y<54;y++) assert.equal(cell(1536+a,y,512+b),E.EMPTY,'body clearance');
  }
};
for(const key of ['emporium','tailor','theatre']) {
  const m=C.landmarks[key];
  for(let z=m.entry[1]-6;z<=m.entry[1]+8;z++) solidFootprint(m.entry[0],z);
  assert.equal(city(m.at[0],47,m.at[1],E.EMPTY),E.BRICK,'real shop floor');
  assert.notEqual(city(m.at[0]+20,54,m.entry[1],E.EMPTY),E.EMPTY,'distinct real facade');
}
for(const p of [C.landmarks.townArrival,C.landmarks.cityArrival]) solidFootprint(p[0],p[2]);
assert.equal(stop(-236,59,-120,E.EMPTY),E.METAL,'real shelter roof');
assert.equal(stop(-236,49,-125,E.EMPTY),E.WOOD,'real shelter bench');
for(let y=0;y<128;y++) {
  assert.equal(city(-236,y,-116,E.WATER),E.WATER,'city is strictly district-only');
  assert.equal(stop(-260,y,-124,E.WOOD),E.WOOD,'gate center untouched');
  assert.equal(stop(0,y,-352,E.GLASS),E.GLASS,'stop is strictly town-stop-only');
  assert.equal(stop(-248,y,-124,E.WOOD),y<47?E.ROCK:y<48?E.BRICK:E.WOOD,'existing gate/adjacent matter preserved');
}
for(let x=-242;x<=-214;x++) for(let z=-116;z<=-108;z++) {
  assert.equal(stop(x,47,z,E.EMPTY),E.BRICK,'broad boarding apron');
  for(let y=48;y<54;y++) assert.equal(stop(x,y,z,E.EMPTY),E.EMPTY);
}
assert.notEqual(city(-88+12,62,-376,E.EMPTY),city(0+12,62,-384,E.EMPTY),'facade materials differ');

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture() {
  let focus=null, mode='animalCrossing', active=true, currentWorld;
  const edits=new Map(), moves=[], notifications=[];
  const sim={origin:new Vector3(1216,0,336),g:{nx:160,ny:128,nz:160},deco:{pending:null}};
  const start=CITY_BUS_STOPS.town.arrival;
  const player={pos:new Vector3(start[0]+1536,48,start[2]+512).sub(sim.origin),vel:new Vector3(),width:1.6,height:5.5,dead:false,
    cancelJump(){},teleports:0,teleport(feet){this.pos.copy(feet);this.teleports++;return true;}};
  const world={scene:{key:'willowCove'},loaded:true,epoch:1,P:{size:[3072,128,1024],seed:123},sim,pending:null,
    load(){throw Error('bus must not reload');},store:edits};
  currentWorld=world;
  const key=(x,y,z)=>`${x},${y},${z}`;
  sim.readCell=async (x,y,z)=>[new Float32Array([edits.get(key(x+sim.origin.x,y,z+sim.origin.z))??cell(x+sim.origin.x,y,z+sim.origin.z)]),null];
  const adapter={getWorld:()=>currentWorld,getSim:()=>sim,getMode:()=>mode,getPlayer:()=>player,active:()=>active,
    requestRender(){},notify:s=>notifications.push(s),
    withVillageFocus(at,valid,visit){return withCityBusFocus({world:currentWorld,at,valid,getFocus:()=>focus,setFocus:f=>focus=f,visit,
      move(){
        for (const [axis,idx,n] of [['x',0,sim.g.nx],['z',1,sim.g.nz]]) {
          const excess=at[idx]-(sim.origin[axis]+n/2);
          if(Math.abs(excess)>20){const d=Math.sign(excess)*16;sim.origin[axis]+=d;player.pos[axis]-=d;moves.push([axis,d]);return [axis,d];}
        }
        return null;
      }});}};
  const bus=createCityBus(adapter);
  return {bus,adapter,sim,player,world,edits,moves,notifications,key,
    get focus(){return focus;},set focus(f){focus=f;},set mode(m){mode=m;},set active(a){active=a;},set currentWorld(w){currentWorld=w;}};
}
const absolute = f=>f.player.pos.clone().add(f.sim.origin).toArray();
{
  const f=fixture(), store=f.world.store;
  f.edits.set(f.key(1310,49,400),E.WOOD); f.edits.set(f.key(1500,49,180),E.GLASS);
  const before=new Map(f.edits);
  assert.equal(f.bus.nearby(),'town');
  assert.equal((await f.bus.board()).ok,true);
  assert.deepEqual(absolute(f),[1536,48,208]);
  assert.equal(f.bus.nearby(),'city');
  assert.equal((await f.bus.board()).ok,true);
  assert.deepEqual(absolute(f),[1316,48,396]);
  assert.equal(f.world.store,store);assert.deepEqual(f.edits,before);assert(f.moves.length>10);
  assert.equal(f.focus,null);assert.equal(f.player.teleports,2);
}
for (const problem of ['blocked','unsupported','unknown','liquid','corner']) {
  const f=fixture(),source=absolute(f);
  f.edits.set(f.key(problem==='corner'?1535:1536,problem==='unsupported'?47:48,208),
    problem==='unsupported'?E.EMPTY:problem==='unknown'?-2:problem==='liquid'?E.WATER:E.WOOD);
  const result=await f.bus.board();
  assert.equal(result.ok,false,problem);assert.equal(result.reason,'blocked');
  assert.deepEqual(absolute(f),source);assert.equal(f.focus,null);assert.equal(f.player.teleports,0);
}
{
  const f=fixture(), gate=deferred();f.world.pending=gate.promise;
  const first=f.bus.board();assert(f.bus.busy);
  assert.equal((await f.bus.board('town')).ok,false,'repeated request isolated');
  const input={move:{x:1,z:1},jump:true,sprint:true};f.bus.freeze(input);
  assert.deepEqual(input.move,{x:0,z:0});assert.equal(input.jump,false);
  f.bus.cancel();gate.resolve();assert.equal((await first).ok,false);
  assert.equal(f.focus,null);assert.equal(f.bus.busy,false);assert.equal(f.player.teleports,0);
}
{
  const f=fixture(),started=deferred(),release=deferred(),source=absolute(f),read=f.sim.readCell;
  f.sim.readCell=async (...args)=>{const result=read(...args);started.resolve();await release.promise;return result;};
  const first=f.bus.board();await started.promise;
  assert(f.moves.length>0,'cancel while destination is streamed, not merely at boot');
  f.bus.cancel();release.resolve();assert.equal((await first).ok,false);
  assert.deepEqual(absolute(f),source);assert.equal(f.player.teleports,0);assert.equal(f.focus,null);
}
{
  const f=fixture(),started=deferred(),release=deferred(),read=f.sim.readCell;
  f.sim.readCell=async (...args)=>{const result=read(...args);started.resolve();await release.promise;return result;};
  const first=f.bus.board();await started.promise;
  const replacement=[42,42];f.focus=replacement;release.resolve();
  assert.equal((await first).ok,false);assert.equal(f.focus,replacement,'never clear successor focus');
  assert.equal(f.player.teleports,0);
}
for(const replacement of ['mode','world','epoch','disposed','hidden','dead']) {
  const f=fixture(),gate=deferred();f.world.pending=gate.promise;
  const first=f.bus.board();
  if(replacement==='mode')f.mode='sandbox';
  if(replacement==='world')f.currentWorld={scene:{key:'island'}};
  if(replacement==='epoch')f.world.epoch++;
  if(replacement==='disposed')f.bus.dispose();
  if(replacement==='hidden')f.active=false;
  if(replacement==='dead')f.player.dead=true;
  assert.equal(f.bus.holding,false,'other modes/replacements must never freeze their body');
  gate.resolve();assert.equal((await first).ok,false,replacement);
  assert.equal(f.player.teleports,0);assert.equal(f.focus,null);assert.equal(f.bus.busy,false);
}
{
  const f=fixture();f.player.pos.set(1300-f.sim.origin.x,48,396-f.sim.origin.z);
  assert.equal(f.bus.nearby(),'town','boarding is usable from the shelter as well as arrival apron');
}
for(const disabled of ['missing','unloaded','other-mode','legacy']) {
  const f=fixture();
  if(disabled==='missing')f.currentWorld=null;
  if(disabled==='unloaded')f.world.loaded=false;
  if(disabled==='other-mode')f.mode='sandbox';
  if(disabled==='legacy')f.world.P.size[0]=1024;
  assert.equal(f.bus.nearby(),null);assert.equal((await f.bus.board('town')).ok,false);assert.equal(f.moves.length,0);
}
{
  const f=fixture();f.focus=[42,42];assert.equal((await f.bus.board()).ok,false);
  assert.deepEqual(f.focus,[42,42],'never steal another focus');
}
{
  const f=fixture();f.sim.readCell=()=>Promise.reject(Error('read failed'));
  assert.equal((await f.bus.board()).reason,'failed');assert.equal(f.bus.busy,false);assert.equal(f.focus,null);
}
{
  const f=fixture();assert.equal(await cityBusArrivalClear(f.sim,new Vector3(0,48,0),f.player),false,'full-body bounds');
}
// Exercise the actual village action wiring (UI/audio are CPU adapters).
const hooks=registerHooks({resolve(specifier,context,next){
  const modules={
    './debtBadge.js':'export function createDebtBadge(){return {update(){},dispose(){}}}',
    './speech.js':'export function createSpeech(){return {stats:{},speak(){},stop(){},swing(){},bonk(){}}}',
    './ui.js':'export function createVillageUi(opts){return {opened:false,talking:false,update(){},handleKey(){return false},close(){},open(){opts.onOpen()},talk(){}}}',
  };
  if(context.parentURL?.endsWith('/village/index.js')&&modules[specifier])
    return {shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(modules[specifier])}`};
  return next(specifier,context);
}});
globalThis.addEventListener=()=>{};
globalThis.document={hidden:false,body:{classList:{toggle(){}}},querySelector:()=>null,addEventListener(){},
  createElement:()=>({getContext:()=>({beginPath(){},roundRect(){},moveTo(){},lineTo(){},fill(){},fillText(){}})})};
globalThis.localStorage={getItem:()=>null,setItem(){}};
const {createVillage}=await import('../src/pov/village/index.js');
{
  const f=fixture();Object.assign(f.player,{size:1,onGround:true,sprintRush:0});
  const app={...f.adapter,scene:new Scene(),settings:{},getScale:()=>1,getVolume:()=>({position:new Vector3()}),isTyping:()=>false};
  const village=createVillage({app,getPlayer:()=>f.player,live:()=>true,
    camera:{look:{yaw:0,pitch:0},third:true,forwardH:out=>out.set(0,0,-1)},
    freeMouse(){},releaseInput(){},releaseActions(){},onEnabled(){},onTool(){},useTool(){}});
  village.setEnabled(true,f.world.P);
  const furniture=village.state;
  village.act({type:'interact'});assert.equal(village.bus.busy,true,'E action boards actual controller bus');
  for(let i=0;village.bus.busy&&i<1000;i++)await Promise.resolve();
  assert.equal(village.bus.busy,false);assert.deepEqual(absolute(f),[1536,48,208]);
  village.act({type:'interact'});
  for(let i=0;village.bus.busy&&i<1000;i++)await Promise.resolve();
  assert.deepEqual(absolute(f),[1316,48,396]);assert.deepEqual(village.state,furniture,'furniture untouched on round trip');
  const gate=deferred();f.world.pending=gate.promise;village.act({type:'interact'});
  assert.equal(village.bus.busy,true);assert.deepEqual(village.act({type:'interact'}),{},'E action cancels too');
  gate.resolve();for(let i=0;village.bus.busy&&i<1000;i++)await Promise.resolve();
  assert.equal(village.bus.busy,false);assert.deepEqual(absolute(f),[1316,48,396]);
  village.setEnabled(false);
}
hooks.deregister();
console.log('city-folk bus CPU: geometry/shared-WGSL, deterministic matter, entrances, supported round trips, persistent edits, cancellation/repeats/disposal/replacement/isolation, actual village E wiring/furniture preservation: PASS');
