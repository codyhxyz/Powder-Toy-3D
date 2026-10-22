import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { BRICK } from '../src/shaders/common.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from '../src/world/store.js';
import { WorldWindow } from '../src/world/window.js';
import { TerrainEditCache } from '../src/world/terrainEditCache.js';
import { createTerrainPersistence } from '../src/wire/descent.js';
import { NativeBrickStore, encodeNativeBrick } from '../src/world/nativeStore.js';
import { E } from '../src/elements.js';
import { DESCENT_LEVELS } from '../src/world/scenes/descent/levels.js';
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
  renderSource:{needsLiveCopy:()=>false,token:()=>({epoch:2,revision:5,contentRevision:0})},
  sim:{g:{nx:32,ny:320,nz:16},origin:new Vector3(64,0,128)},P:{},leave:{},gpu:{failure:null},store:original,
  gen:{diff(_P,lo,bricks){events.push(['diff',lo,bricks]);}},
  readBack(base,bricks,capture,out,nativeRead){events.push(['read',base,bricks,capture,nativeRead]);this.pending=Promise.resolve();},
});
const capture=win.captureEdits();
assert.equal(win.capturing,true); assert.equal(events.length,0,'await pending slab before reusing diff buffers');
assert.equal(win.update(10000,10000),null,'capture blocks window-follow');
assert.throws(()=>win.shift(16,0),/capture/);
prior.resolve(); assert.equal(await capture,original);
assert.equal(events.filter(e=>e[0]==='diff').length,2,'capture ALL resident slabs');
assert.deepEqual(events[0],['diff',[0,0,0],[16/BRICK,320/BRICK,16/BRICK]]);
assert.deepEqual(events[2][1],[16,0,0]);
assert.equal(events[1][3]?.revision,5,'the resident capture hands readBack a source revision token');
assert.equal(events[1][4],null,'a V1 window reads no native slab');
assert.equal(win.capturing,false);
win.readbackError=new Error('readback failed');
await assert.rejects(win.captureEdits(),/readback failed/);
assert.equal(win.capturing,false);
const readFailure=Object.assign(Object.create(WorldWindow.prototype),{epoch:1,lastKept:0,storeReads:new Set(),leave:{head:{},cells:{}},gpu:{failure:Error('device failed'),readback:{buffer:()=>Promise.reject(Error('GPU read failed'))}}});
readFailure.readBack([0,0,0],[1,1,1]); await readFailure.pending;
assert.match(readFailure.readbackError.message,/GPU read failed/,'actual readback failure is latched for capture');

// The actual capture through the actual readBack (a V1 window, a fake GPU):
// one slab differs from the generator in one brick. Without a capture token
// readBack threw on capture.revision, so every band handoff failed
// ("The way down didn't open") on V1 and V2 alike.
{
  const g={nx:16,ny:8,nz:8}, bricks=[g.nx/BRICK,g.ny/BRICK,g.nz/BRICK], n=bricks[0]*bricks[1]*bricks[2];
  const realStore=new BrickStore([64,g.ny/BRICK,64]), A=new Float32Array(BRICK_FLOATS).fill(7);
  const head=new Uint32Array(8), cells=new Float32Array(2*BRICK_FLOATS*n), commits=[];
  const real=Object.assign(Object.create(WorldWindow.prototype),{
    loaded:true,capturing:false,epoch:3,pending:null,readbackError:null,persistenceError:null,lastKept:0,last:null,
    storeReads:new Set(),storeRevisions:new Map(),store:realStore,nativeStore:{put(){assert.fail('no native bricks on V1');},drop(){}},
    renderSource:{token:()=>({epoch:3,revision:2,contentRevision:0}),commitStoreRevision:(keys,c)=>commits.push([keys.length,c.revision])},
    sim:{g,origin:new Vector3(16,0,32)},P:{},leave:{head:{data:head},cells:{data:cells}},
    gpu:{failure:null,readback:{buffer:(b,at,len)=>Promise.resolve(new Uint8Array(b.data.buffer).slice(at,at+len).buffer)}},
    gen:{diff(){ head[0]=1; head[1]=realStore.key(16/BRICK+1,0,32/BRICK); cells.set(A,0); }},
  });
  assert.equal(await real.captureEdits(),realStore);
  assert.equal(real.readbackError,null,'the readback lands');
  assert.equal(realStore.size,1,'the brick that differs is kept');
  assert(realStore.has(realStore.key(16/BRICK+1,0,32/BRICK)));
  assert.deepEqual(commits,[[n,2]],'the store revision commits at the capture token');
}

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

// Physics V2 bands hand over their exact native bricks too, by global brick,
// with the same band replacement (the band and lifecycle checks above, natively).
{
  const nativeBrick=(fill)=>{const core=new Uint32Array(256),bank=new Int32Array(64);
    for(let c=0;c<64;c++){core.set([E.WATER|(1173<<8),fill+(c===5?1:0),0,0],c*4);bank[c]=-c;} return encodeNativeBrick(core,bank);};
  const uniform=()=>{const core=new Uint32Array(256),bank=new Int32Array(64).fill(-7);
    for(let c=0;c<64;c++)core.set([1173<<8,0,0,0],c*4); return encodeNativeBrick(core,bank);};
  const nstore=()=>new NativeBrickStore(wb), exact=nativeBrick(1000), newer=nativeBrick(2000);
  const nc=new TerrainEditCache(), upperNative=nstore();
  upperNative.put(upperNative.key(20,16/BRICK,33),exact);          // the overlap
  upperNative.put(upperNative.key(40,200/BRICK,40),exact);         // upper band only
  nc.capture(a,store(),1,upperNative);
  let downNative=nc.seedNative(b,wb);
  assert.equal(downNative.map.get(downNative.key(20,272/BRICK,33)),exact,'exact native brick crosses the seam at its global Y');
  assert.equal(downNative.size,1,'only the destination band\'s bricks');
  downNative.put(downNative.key(20,272/BRICK,33),newer);
  nc.capture(b,store(),1,downNative);
  const upNative=nc.seedNative(a,wb);
  assert.equal(upNative.map.get(upNative.key(20,16/BRICK,33)),newer,'newer exact cells come back up');
  assert.equal(upNative.map.get(upNative.key(40,200/BRICK,40)),exact,'non-overlap exact bricks retained');
  nc.capture(a,store(),1,null);   // the band went through V1: its legacy diff is the newer truth
  assert.equal(nc.seedNative(a,wb).size,0,'a legacy-only snapshot clears the band\'s exact bricks');
  assert.equal(nc.seedNative(b,wb).size,0,'(the overlap belongs to both bands)');
  nc.reset(); assert.equal(nc.native.size,0);
  // Air and rock at rest share one payload; anything else keeps its own.
  const s=nstore(), u1=uniform(), u2=uniform();
  s.put(1,u1); s.put(2,u2); s.put(3,exact);
  assert.equal(s.map.get(1),s.map.get(2),'uniform bricks share one array');
  assert.notEqual(s.map.get(3),s.map.get(1));
  assert.equal(s.bytes,3*u1.length,'logical bytes stay per brick (saves and history count them)');
  const saved=nstore(); saved.fromBytes(s.toBytes());
  assert.deepEqual([...saved.map.get(2)],[...u2],'a shared payload saves and loads as its own brick');
  // The lifecycle hands the native store over only between V2 windows.
  const owned=(region)=>({epoch:1,scene:{sourceRegion:region,fold:{config:{sourceWidth:9216}}},P:{seed:7},wb,
    sim:{compactOwner:{}},store:store(),nativeStore:nstore(),
    async captureEdits(){return this.store;},
    async restoreEdits(legacy,native){this.restored=[legacy,native];},
  });
  const pn=createTerrainPersistence(), up=owned(a), down=owned(b), napp={win:up};
  up.nativeStore.put(up.nativeStore.key(20,16/BRICK,33),exact);
  pn.sync(up);
  await pn.load(napp,'b',[],async()=>{napp.win=down;}); await pn.enter(async()=>{});
  assert.equal(down.restored[1]?.map.get(down.nativeStore.key(20,272/BRICK,33)),exact,'actual persistence load restores exact native bricks');
}

// Execute the actual app writer section against mocks, not a hand-written gate.
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const start=source.indexOf('  if (!renderOnly) {\n    const cam = camState();',source.indexOf('function tick('));
const end=source.indexOf('  updateSun();',start);
const after=source.slice(end,source.indexOf('  if (settings.time !== timeShown)',end));
const firstGate=source.match(/  renderOnly \|\|= !!ctx\.descent\?\.terrainPending;/)[0];
const runWriters=new Function('ctx','live','log',`
let renderOnly=false; ${firstGate}
const mp={replica:false,isGuest:false}, settings={paused:true,steps:1},dt=1/60;
const DEFAULTS={steps:4},physicsV2=null;
let stepOnce=true,camShown='on',releasePending=false,painting=false,windFromValid=false,v2Running=false;
const camState=()=> 'on',toolbar={},pov={active:false},rig={update:()=>log.push('rig')},controls={update:()=>log.push('controls')};
const updatePresentation=()=>{},updateBrush=()=>log.push('brush'),prof={phase:()=>{}},selectedMode='noita';
const scripts={tick:()=>log.push('script'),endFrame:()=>log.push('scriptEnd')},sim={step:()=>log.push('step')};
const v2Box=()=>false,v2Replica=()=>false,weatherWire={step:()=>log.push('weather')},DAY={running:false},updateSun=()=>{};
${source.slice(start,end)} ${after}
return {renderOnly,stepOnce};`);
const logs=[], state={descent:{terrainPending:false}};
const hooks=[{name:'descent',beforeStep(){logs.push('begin');state.descent.terrainPending=true;}},{name:'writer',beforeStep(){logs.push('late writer');},afterStep(){logs.push('after writer');},follow(){logs.push('follow');}}];
assert.equal(runWriters(state,hooks,logs).renderOnly,true);
assert.deepEqual(logs,['begin'],'same-tick gate stops all later writers, including paused stepOnce');
logs.length=0; runWriters(state,hooks,logs); assert.deepEqual(logs,[],'subsequent capture/load ticks have no writers');
assert(source.indexOf('gpu.endFrame();',end)>end,'GPU submissions remain outside the writer gate');
const undoDeclaration=source.match(/^(?:async )?function undo\(\) \{/m);
assert(undoDeclaration,'actual undo declaration');
const undoStart=undoDeclaration.index;
const undoBody=source.slice(undoStart,source.indexOf('\n}',undoStart)+2);
const runUndo=new Function('ctx','sim',`
const selectedMode='noita',mp={guard:()=>false},hud={toast:()=>{}},toolbar={setUndoEnabled:()=>{}};
${undoBody}
return undo();`);
let undoWrites=0;
await runUndo({descent:{terrainPending:true}},{undo:()=>{undoWrites++;return false;}});
assert.equal(undoWrites,0,'event-driven undo cannot race the frozen snapshot');
await runUndo({descent:{terrainPending:false}},{undo:()=>{undoWrites++;return false;}});
assert.equal(undoWrites,1,'ordinary undo remains available');
// Edits replay onto the terrain they were made in: the persistence scope covers the
// inflation planes too, so a re-published depth/backdrop never meets stale edits.
assert.ok(DESCENT_LEVELS.length > 0 && DESCENT_LEVELS.every(l => /^[a-f0-9]{64}$/.test(l.sourceRegion.fieldsSha256)), 'every band carries its inflation hash');
assert.match(readFileSync(new URL('../src/wire/descent.js', import.meta.url), 'utf8'), /sourceRegion\.fieldsSha256/, 'edit scope keys on inflation hashes');
console.log('Terrain edits: down/up overlap + remote XZ, baseline deletion, V2 exact native bricks and shared uniform payloads, global-Y mapping, run reset, bounded capture/restore, failure retention, lifecycle and actual app writer gate passed');
