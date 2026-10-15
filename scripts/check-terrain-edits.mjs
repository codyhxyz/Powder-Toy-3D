import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { BRICK } from '../src/shaders/common.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { WorldWindow } from '../src/world/window.js';
import { TerrainEditCache } from '../src/world/terrainEditCache.js';
import { createTerrainPersistence } from '../src/wire/descent.js';
const a={sourceTop:992,sourceHeight:320}, b={sourceTop:1248,sourceHeight:320};
const wb=[1024,320/BRICK,1024], store=()=>new BrickStore(wb);
const encoded=(id)=>encodeBrick(new Float32Array(BRICK_FLOATS).fill(id),0,new Float32Array(BRICK_FLOATS),0);
const damage=encoded(3), moreDamage=encoded(4), cache=new TerrainEditCache(), original=store();
original.put(original.key(20,16/BRICK,33),damage);
original.put(original.key(800,20/BRICK,800),damage); // off-resident XZ
original.put(original.key(40,200/BRICK,40),damage); // only in upper band
cache.capture(a,original);
let lower=cache.seed(b,wb);
assert.deepEqual(lower.map.get(lower.key(20,272/BRICK,33)),damage,'same global brick, different local Y');
assert.deepEqual(lower.map.get(lower.key(800,276/BRICK,800)),damage,'remote horizontal edits transfer');
lower.put(lower.key(20,272/BRICK,33),moreDamage);
lower.put(lower.key(10,40/BRICK,10),damage);
cache.capture(b,lower);
let upper=cache.seed(a,wb);
assert.deepEqual(upper.map.get(upper.key(20,16/BRICK,33)),moreDamage,'damage transfers back up');
assert.deepEqual(upper.map.get(upper.key(40,200/BRICK,40)),damage,'non-overlap edits retained');
upper.drop(upper.key(20,16/BRICK,33)); // resident diff now matches baseline
cache.capture(a,upper);
lower=cache.seed(b,wb);
assert(!lower.has(lower.key(20,272/BRICK,33)),'baseline deletion must not resurrect stale global damage');
assert.deepEqual(lower.map.get(lower.key(10,40/BRICK,10)),damage,'lower-only edits survive an upper-band snapshot');
assert.deepEqual(lower.map.get(lower.key(800,276/BRICK,800)),damage);
cache.reset(); assert.equal(cache.map.size,0);
for (const scale of [.5, 1.5, 2]) {
  const dims=[wb[0],320*scale/BRICK,wb[2]], scaled=new BrickStore(dims);
  const upY=16*scale/BRICK, downY=272*scale/BRICK;
  scaled.put(scaled.key(20,upY,33),damage);
  cache.capture(a,scaled,scale);
  const down=cache.seed(b,dims,scale);
  assert.deepEqual(down.map.get(down.key(20,downY,33)),damage,`scaled ${scale} overlap`);
  down.put(down.key(20,downY,33),moreDamage);
  cache.capture(b,down,scale);
  assert.deepEqual(cache.seed(a,dims,scale).map.get(scaled.key(20,upY,33)),moreDamage);
  cache.reset();
}
assert.throws(()=>cache.band(a,.51),/align/,'unaligned scale must fail before touching cached edits');

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const events=[], prior=deferred();
const win=Object.assign(Object.create(WorldWindow.prototype),{
  loaded:true,capturing:false,epoch:2,pending:prior.promise,readbackError:null,
  sim:{g:{nx:32,ny:320,nz:16},origin:new Vector3(64,0,128)},P:{},leave:{},gpu:{failure:null},store:original,
  gen:{diff(_P,lo,bricks){events.push(['diff',lo,bricks]);}},
  readBack(base,bricks){events.push(['read',base,bricks]);this.pending=Promise.resolve();},
});
const capture=win.captureEdits();
assert.equal(win.capturing,true); assert.equal(events.length,0,'await pending slab before reusing diff buffers');
assert.equal(win.update(10000,10000),null,'capture blocks window-follow');
assert.throws(()=>win.shift(16,0),/capture/);
prior.resolve(); assert.equal(await capture,original);
assert.equal(events.filter(e=>e[0]==='diff').length,2,'capture ALL resident slabs');
assert.deepEqual(events[0],['diff',[0,0,0],[16/BRICK,320/BRICK,16/BRICK]]);
assert.deepEqual(events[2][1],[16,0,0]);
assert.equal(win.capturing,false);
win.readbackError=new Error('readback failed');
await assert.rejects(win.captureEdits(),/readback failed/);
assert.equal(win.capturing,false);
const readFailure=Object.assign(Object.create(WorldWindow.prototype),{epoch:1,lastKept:0,leave:{head:{},cells:{}},gpu:{failure:Error('device failed'),readback:{buffer:()=>Promise.reject(Error('GPU read failed'))}}});
readFailure.readBack([0,0,0],[1,1,1]); await readFailure.pending;
assert.match(readFailure.readbackError.message,/GPU read failed/,'actual readback failure is latched for capture');

const restoreEvents=[], fence=deferred(), targetStore=store();
targetStore.put(targetStore.key(800,2,800),damage);
const restoreWin=Object.assign(Object.create(WorldWindow.prototype),{
  loaded:true,pending:null,epoch:1,wb,store:store(),sim:{g:{nx:32,ny:320,nz:16}},
  gpu:{fence(){restoreEvents.push('fence');return fence.promise;}},
  restore(lo,bricks){restoreEvents.push([lo,bricks]);},
});
let restored=false;
const restoring=restoreWin.restoreEdits(targetStore).then(()=>{restored=true;});
assert.equal(restored,false); assert.equal(restoreEvents.length,3);
fence.resolve(); await restoring;
assert.equal(restoreWin.store.size,1,'off-resident target edits remain in window store');

function fixture(region,label) {
  return {epoch:1,scene:{sourceRegion:region,fold:{config:{sourceWidth:9216}}},P:{seed:7},wb,
    async captureEdits(){order.push(`capture:${label}`);return snapshots.get(this)??store();},
    async restoreEdits(s){order.push(`restore:${label}`);snapshots.set(this,s);},
  };
}
const order=[], snapshots=new Map(), p=createTerrainPersistence(), old=fixture(a,'a'), next=fixture(b,'b');
snapshots.set(old,original);
const app={win:old}; p.sync(old);
await p.load(app,'b',[1,2,3],async()=>{order.push('destroy:a');app.win=next;order.push('load:b');});
assert.equal(p.pending,true,'gate remains closed through POV entry');
await p.enter(async()=>{assert.equal(p.pending,true);order.push('POV');});
assert.equal(p.pending,false);
assert.deepEqual(order,['capture:a','destroy:a','load:b','restore:b','POV']);
assert.deepEqual(snapshots.get(next).map.get(targetStore.key(20,272/BRICK,33)),damage);
const retained=p.cache.map.size; p.sync(next); assert.equal(p.cache.map.size,retained,'ordinary seam does not reset cache');
await p.load(app,'a',[],async()=>{app.win=old;}); await p.enter(async()=>{});
assert.equal(p.cache.map.size,retained,'upward return to band 00 does not reset cache');
const arena=fixture({sourceTop:1792,sourceHeight:320},'nonadjacent portal');
await p.load(app,'arena',[],async()=>{app.win=arena;}); await p.enter(async()=>{});
await p.load(app,'a',[],async()=>{app.win=old;}); await p.enter(async()=>{});
assert.deepEqual(snapshots.get(old).map.get(original.key(800,20/BRICK,800)),damage,'nonadjacent portal roundtrip preserves remote edits');
p.sync(fixture(a,'new run')); assert.equal(p.cache.map.size,0,'new map/window selection resets cache');
const fail=createTerrainPersistence(), bad=fixture(a,'bad'); bad.captureEdits=async()=>{throw Error('capture failed');};
await assert.rejects(fail.load({win:bad},'b',[],async()=>assert.fail('must not destroy after capture failure')),/capture failed/);
assert.equal(fail.pending,false);
const loadFail=createTerrainPersistence(), failingApp={win:old};
await assert.rejects(loadFail.load(failingApp,'b',[],async()=>{failingApp.win=next;throw Error('load failed');}),/load failed/);
assert.equal(loadFail.pending,false); const kept=loadFail.cache.map.size; assert(kept>0);
loadFail.sync(next); assert.equal(loadFail.cache.map.size,kept,'load failure retains captured data');
await assert.rejects(loadFail.load(failingApp,'a',[],async()=>{}),/not available/);

// Execute the actual app writer section against mocks, not a hand-written gate.
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const start=source.indexOf('  if (!renderOnly) {\n    const cam = camState();',source.indexOf('function tick('));
const end=source.indexOf('  updateSun();',start);
const after=source.slice(end,source.indexOf('  if (settings.time !== timeShown)',end));
const firstGate=source.match(/  renderOnly \|\|= !!ctx\.descent\?\.terrainPending;/)[0];
const runWriters=new Function('ctx','live','log',`
let renderOnly=false; ${firstGate}
const mp={replica:false,isGuest:false}, settings={paused:true,steps:1},dt=1/60;
let stepOnce=true,camShown='on',releasePending=false,painting=false,windFromValid=false,v2Running=false;
const camState=()=> 'on',toolbar={},pov={active:false},rig={update:()=>log.push('rig')},controls={update:()=>log.push('controls')};
const updatePresentation=()=>{},updateBrush=()=>log.push('brush'),prof={phase:()=>{}},selectedMode='noita';
const scripts={tick:()=>log.push('script'),endFrame:()=>log.push('scriptEnd')},sim={step:()=>log.push('step')};
const v2Box=()=>false,weatherWire={step:()=>log.push('weather')},DAY={running:false},updateSun=()=>{};
${source.slice(start,end)} ${after}
return {renderOnly,stepOnce};`);
const logs=[], state={descent:{terrainPending:false}};
const hooks=[{name:'descent',beforeStep(){logs.push('begin');state.descent.terrainPending=true;}},{name:'writer',beforeStep(){logs.push('late writer');},afterStep(){logs.push('after writer');},follow(){logs.push('follow');}}];
assert.equal(runWriters(state,hooks,logs).renderOnly,true);
assert.deepEqual(logs,['begin'],'same-tick gate stops all later writers, including paused stepOnce');
logs.length=0; runWriters(state,hooks,logs); assert.deepEqual(logs,[],'subsequent capture/load ticks have no writers');
assert(source.indexOf('gpu.endFrame();',end)>end,'GPU submissions remain outside the writer gate');
const undoStart=source.indexOf('function undo() {');
const undoBody=source.slice(undoStart,source.indexOf('\n}',undoStart)+2);
const runUndo=new Function('ctx','sim',`
const selectedMode='noita',mp={guard:()=>false},hud={toast:()=>{}},toolbar={setUndoEnabled:()=>{}};
${undoBody}
undo();`);
let undoWrites=0;
runUndo({descent:{terrainPending:true}},{undo:()=>{undoWrites++;return false;}});
assert.equal(undoWrites,0,'event-driven undo cannot race the frozen snapshot');
runUndo({descent:{terrainPending:false}},{undo:()=>{undoWrites++;return false;}});
assert.equal(undoWrites,1,'ordinary undo remains available');
console.log('Terrain edits: down/up overlap + remote XZ, baseline deletion, global-Y mapping, run reset, bounded capture/restore, failure retention, lifecycle and actual app writer gate passed');
